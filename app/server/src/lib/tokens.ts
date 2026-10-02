/** Access JWTs and refresh tokens are both bound to a revocable device session. */
import { createHmac, randomBytes } from 'node:crypto'
import { sign, verify } from 'hono/jwt'
import type { JWTPayload } from 'hono/utils/jwt/types'
import { REFRESH_DAYS } from '../config.js'
import { getSecrets } from '../db/schema.js'
import { sql } from './db.js'
import { newRefreshToken, sha256 } from './password.js'
import type { SessionUser } from '../types.js'

export const ACCESS_TTL_SEC = 2 * 60 * 60
export const REFRESH_COOKIE = 'hd_rt'
export const REFRESH_ROTATE_INTERVAL_MS = 60_000
export const REFRESH_RETRY_GRACE_MS = 30_000
const REFRESH_TTL_MS = REFRESH_DAYS * 24 * 60 * 60 * 1000
const SESSION_ID = /^[a-f0-9]{32}$/

type RefreshRow = {
  id: number
  user_id: number
  token_hash: string
  session_id: string | null
  replacement_hash: string | null
  expires_at: number
  revoked_at: number | null
  created_at: number
}
type SessionRow = {
  id: string
  user_id: number
  client: 'web' | 'extension'
  ua: string | null
  ip: string | null
  created_at: number
  last_seen_at: number
  expires_at: number
  revoked_at: number | null
}
export type AuthenticatedSession = { user: SessionUser; sessionId: string; client: 'web' | 'extension' }

function metadata(value: string | null, max: number): string | null {
  return value?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || null
}

function activeSession(id: string, userId: number, now = Date.now()): SessionRow | undefined {
  return sql.get<SessionRow>(
    'SELECT * FROM auth_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?',
    id, userId, now,
  )
}

export async function issueAccessToken(user: SessionUser, sessionId: string): Promise<string> {
  if (!activeSession(sessionId, user.id)) throw new Error('Cannot issue access token for an inactive session')
  const iat = Math.floor(Date.now() / 1000)
  const payload: JWTPayload = { sub: user.id, username: user.username, sid: sessionId, iat, exp: iat + ACCESS_TTL_SEC }
  return sign(payload, getSecrets().jwtSecret, 'HS256')
}

export async function verifyAccessToken(token: string): Promise<AuthenticatedSession | null> {
  try {
    const payload = await verify(token, getSecrets().jwtSecret, 'HS256')
    const id = Number(payload.sub)
    const sid = payload.sid
    if (!Number.isSafeInteger(id) || id <= 0 || typeof sid !== 'string' || !SESSION_ID.test(sid)) return null
    const now = Date.now()
    const session = activeSession(sid, id, now)
    if (!session) return null
    const user = sql.get<SessionUser>('SELECT id, username FROM users WHERE id = ?', id)
    if (!user) return null
    // Access-only clients (including the extension) also keep an accurate activity time.
    sql.run('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?', now, sid, now - 60_000)
    return { user, sessionId: sid, client: session.client }
  } catch {
    return null
  }
}

/** Must be called within the caller's transaction. */
function revokeRows(sessionId: string, userId: number, now: number): void {
  sql.run('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now, sessionId, userId)
  sql.run('UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL', now, sessionId, userId)
}

export function createRefreshToken(
  userId: number,
  ua: string | null,
  ip: string | null,
  previous: { raw?: string; sessionId?: string } = {},
): { raw: string; expiresAt: number; sessionId: string } {
  return sql.tx(() => {
    const now = Date.now()
    // A repeat login in the same browser replaces its old session. It never
    // touches a different user's session or another device without its token.
    if (previous.raw && previous.raw.length <= 512) {
      const old = sql.get<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ? AND user_id = ?', sha256(previous.raw), userId)
      if (old?.session_id) revokeRows(old.session_id, userId, now)
    }
    if (previous.sessionId && activeSession(previous.sessionId, userId)?.client === 'web') revokeRows(previous.sessionId, userId, now)
    const sessionId = randomBytes(16).toString('hex')
    const { raw, hash } = newRefreshToken()
    const expiresAt = now + REFRESH_TTL_MS
    const userAgent = metadata(ua, 512)
    const address = metadata(ip, 128)
    sql.run(`INSERT INTO auth_sessions (id, user_id, ua, ip, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, sessionId, userId, userAgent, address, now, now, expiresAt)
    sql.run(`INSERT INTO refresh_tokens (user_id, token_hash, ua, ip, expires_at, created_at, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, userId, hash, userAgent, address, expiresAt, now, sessionId)
    return { raw, expiresAt, sessionId }
  })
}

/** The extension omits cookies; its session lives exactly as long as its access token. */
export function createAccessOnlySession(userId: number, ua: string | null, ip: string | null, previousSessionId?: string): string {
  return sql.tx(() => {
    const now = Date.now()
    if (previousSessionId && activeSession(previousSessionId, userId)?.client === 'extension') revokeRows(previousSessionId, userId, now)
    const sessionId = randomBytes(16).toString('hex')
    sql.run(`INSERT INTO auth_sessions (id, user_id, client, ua, ip, created_at, last_seen_at, expires_at)
      VALUES (?, ?, 'extension', ?, ?, ?, ?, ?)`, sessionId, userId, metadata(ua, 512), metadata(ip, 128), now, now, now + ACCESS_TTL_SEC * 1000)
    return sessionId
  })
}

export function sessionUsesCookie(userId: number, sessionId: string): boolean {
  return sql.get<{ client: string }>('SELECT client FROM auth_sessions WHERE user_id = ? AND id = ?', userId, sessionId)?.client === 'web'
}

export function revokeSession(userId: number, sessionId: string): boolean {
  return sql.tx(() => {
    if (!sql.get('SELECT 1 FROM auth_sessions WHERE id = ? AND user_id = ?', sessionId, userId)) return false
    revokeRows(sessionId, userId, Date.now())
    return true
  })
}

export function revokeRefreshToken(raw: string): void {
  if (raw.length > 512) return
  const row = sql.get<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ?', sha256(raw))
  if (row?.session_id) revokeSession(row.user_id, row.session_id)
}

function revokeUserRows(userId: number, now: number): void {
  sql.run('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, userId)
  sql.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, userId)
}

export function revokeAllSessions(userId: number): void {
  sql.tx(() => revokeUserRows(userId, Date.now()))
}

export function updatePasswordAndRevokeSessions(userId: number, passwordHash: string): void {
  sql.tx(() => {
    const now = Date.now()
    sql.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, now, userId)
    revokeUserRows(userId, now)
  })
}

export function revokeOtherSessions(userId: number, currentId: string): number {
  return sql.tx(() => {
    const now = Date.now()
    const others = sql.all<{ id: string }>('SELECT id FROM auth_sessions WHERE user_id = ? AND id != ? AND revoked_at IS NULL AND expires_at > ?', userId, currentId, now)
    for (const { id } of others) revokeRows(id, userId, now)
    return others.length
  })
}

function deviceName(ua: string | null): string {
  if (!ua) return '未知设备'
  const browser = /Edg\//i.test(ua) ? 'Edge' : /Firefox\//i.test(ua) ? 'Firefox' : /(?:Chrome|CriOS)\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : '其他客户端'
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : ''
  return os ? `${browser} · ${os}` : browser
}

export function listSessions(userId: number, currentId: string) {
  return sql.all<SessionRow>('SELECT * FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC, created_at DESC', userId, Date.now())
    .map(({ id, client, ua, ip, created_at, last_seen_at, expires_at }) => ({ id, device: client === 'extension' ? 'Chrome 扩展' : deviceName(ua), ua, ip, created_at, last_seen_at, expires_at, current: id === currentId }))
}

/** Keep used token hashes until the session ends, so a late replay still has a family. */
export function pruneRefreshTokens(): void {
  sql.tx(() => {
    const now = Date.now()
    const cutoff = now - 7 * 24 * 60 * 60 * 1000
    sql.run('DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at < ?', now, cutoff)
    sql.run('DELETE FROM refresh_tokens WHERE session_id IS NULL AND (expires_at <= ? OR revoked_at < ?)', now, cutoff)
  })
}

export type RotateResult =
  | { ok: true; user: SessionUser; sessionId: string; raw: string; expiresAt: number }
  | { ok: false; reason: 'missing' | 'expired' | 'replay' }

// Reconstruct a successor during the bounded retry window without retaining any
// plaintext refresh credentials. Domain separation avoids reuse as a JWT key.
function nextRefresh(raw: string, sessionId: string): string {
  return createHmac('sha256', getSecrets().jwtSecret).update(`home-dashboard:refresh:v1:${sessionId}:${raw}`).digest('base64url')
}

export function rotateRefreshToken(raw: string | undefined): RotateResult {
  if (!raw || raw.length > 512) return { ok: false, reason: 'missing' }
  return sql.tx((): RotateResult => {
    const now = Date.now()
    const row = sql.get<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ?', sha256(raw))
    if (!row?.session_id) return { ok: false, reason: 'missing' }
    const session = activeSession(row.session_id, row.user_id, now)
    if (!session) return { ok: false, reason: 'expired' }
    const user = sql.get<SessionUser>('SELECT id, username FROM users WHERE id = ?', row.user_id)
    if (!user) return { ok: false, reason: 'missing' }
    if (row.revoked_at !== null) {
      if (row.replacement_hash && now - row.revoked_at <= REFRESH_RETRY_GRACE_MS) {
        const next = nextRefresh(raw, row.session_id)
        const successor = sql.get<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ? AND session_id = ? AND revoked_at IS NULL AND expires_at > ?', sha256(next), row.session_id, now)
        if (sha256(next) === row.replacement_hash && successor) {
          return { ok: true, user, sessionId: session.id, raw: next, expiresAt: successor.expires_at }
        }
      }
      revokeRows(session.id, user.id, now)
      return { ok: false, reason: 'replay' }
    }
    if (row.expires_at <= now) return { ok: false, reason: 'expired' }
    sql.run('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?', now, session.id)
    if (now - row.created_at < REFRESH_ROTATE_INTERVAL_MS) {
      return { ok: true, user, sessionId: session.id, raw, expiresAt: row.expires_at }
    }
    const next = nextRefresh(raw, session.id)
    const hash = sha256(next)
    const expiresAt = now + REFRESH_TTL_MS
    sql.run('UPDATE refresh_tokens SET revoked_at = ?, replacement_hash = ? WHERE id = ?', now, hash, row.id)
    sql.run(`INSERT INTO refresh_tokens (user_id, token_hash, ua, ip, expires_at, created_at, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, user.id, hash, session.ua, session.ip, expiresAt, now, session.id)
    sql.run('UPDATE auth_sessions SET expires_at = ? WHERE id = ?', expiresAt, session.id)
    return { ok: true, user, sessionId: session.id, raw: next, expiresAt }
  })
}

export function refreshCookieOptions(expiresAt: number) {
  return { httpOnly: true, sameSite: 'Lax' as const, secure: process.env.COOKIE_SECURE === 'true', path: '/api/auth', expires: new Date(expiresAt) }
}

export function clearCookieOptions() {
  return { httpOnly: true, sameSite: 'Lax' as const, secure: process.env.COOKIE_SECURE === 'true', path: '/api/auth', maxAge: 0 }
}
