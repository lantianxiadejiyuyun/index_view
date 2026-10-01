/**
 * 双 token 认证核心。
 *
 * access  ：JWT，2 小时，前端只存内存（防 XSS 窃取）
 * refresh ：256 位随机串，默认 30 天，HttpOnly Cookie，每次刷新即轮换
 *
 * 轮换带重放检测：一个已经用过的 refresh token 再次出现，说明它泄露过，
 * 此时直接撤销该用户全部会话，逼所有设备重新登录。
 */
import { sign, verify } from 'hono/jwt'
import type { JWTPayload } from 'hono/utils/jwt/types'
import { REFRESH_DAYS } from '../config.js'
import { getSecrets } from '../db/schema.js'
import { sql } from './db.js'
import { newRefreshToken, sha256 } from './password.js'
import type { SessionUser } from '../types.js'

export const ACCESS_TTL_SEC = 2 * 60 * 60 // 2 小时
export const REFRESH_COOKIE = 'hd_rt'
const REFRESH_TTL_MS = REFRESH_DAYS * 24 * 60 * 60 * 1000

type RefreshRow = {
  id: number
  user_id: number
  token_hash: string
  ua: string | null
  ip: string | null
  expires_at: number
  revoked_at: number | null
  created_at: number
}

export async function issueAccessToken(user: SessionUser): Promise<string> {
  const iat = Math.floor(Date.now() / 1000)
  const payload: JWTPayload = {
    sub: user.id,
    username: user.username,
    iat,
    exp: iat + ACCESS_TTL_SEC,
  }
  return sign(payload, getSecrets().jwtSecret, 'HS256')
}

export async function verifyAccessToken(token: string): Promise<SessionUser | null> {
  try {
    const payload = await verify(token, getSecrets().jwtSecret, 'HS256')
    const id = Number(payload.sub)
    if (!Number.isFinite(id) || id <= 0) return null
    return { id, username: String(payload.username ?? '') }
  } catch {
    // 过期或签名不合法都走这里，调用方统一按未登录处理
    return null
  }
}

export function createRefreshToken(
  userId: number,
  ua: string | null,
  ip: string | null,
): { raw: string; expiresAt: number } {
  const { raw, hash } = newRefreshToken()
  const expiresAt = Date.now() + REFRESH_TTL_MS
  sql.run(
    `INSERT INTO refresh_tokens (user_id, token_hash, ua, ip, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    hash,
    ua,
    ip,
    expiresAt,
    Date.now(),
  )
  return { raw, expiresAt }
}

export function revokeRefreshToken(raw: string): void {
  sql.run(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    Date.now(),
    sha256(raw),
  )
}

export function revokeAllSessions(userId: number): void {
  sql.run(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    Date.now(),
    userId,
  )
}

/** 顺手清理过期/撤销很久的记录，避免表无限增长 */
export function pruneRefreshTokens(): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  sql.run('DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked_at < ?', Date.now(), cutoff)
}

export type RotateResult =
  | { ok: true; user: SessionUser; raw: string; expiresAt: number }
  | { ok: false; reason: 'missing' | 'expired' | 'replay' }

/**
 * 轮换：校验旧 token → 作废 → 签发新的。
 * 返回新的 raw token，由调用方写入 Cookie。
 */
export function rotateRefreshToken(raw: string | undefined): RotateResult {
  if (!raw) return { ok: false, reason: 'missing' }

  const row = sql.get<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ?', sha256(raw))
  if (!row) return { ok: false, reason: 'missing' }

  if (row.revoked_at) {
    // 已作废的 token 被再次使用 = 泄露信号，全部会话下线
    revokeAllSessions(row.user_id)
    console.warn(`[auth] 检测到 refresh token 重放，已撤销用户 ${row.user_id} 的全部会话`)
    return { ok: false, reason: 'replay' }
  }

  if (row.expires_at < Date.now()) return { ok: false, reason: 'expired' }

  const user = sql.get<{ id: number; username: string }>(
    'SELECT id, username FROM users WHERE id = ?',
    row.user_id,
  )
  if (!user) return { ok: false, reason: 'missing' }

  sql.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', Date.now(), row.id)
  const next = createRefreshToken(user.id, row.ua, row.ip)
  return { ok: true, user, raw: next.raw, expiresAt: next.expiresAt }
}

export function refreshCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    // 本地 http 调试时必须允许非 Secure，否则 Cookie 根本不会下发
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/api/auth',
    expires: new Date(expiresAt),
  }
}

export function clearCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/api/auth',
    maxAge: 0,
  }
}
