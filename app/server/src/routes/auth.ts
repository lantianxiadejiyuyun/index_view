import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { hashPassword, verifyPassword } from '../lib/password.js'
import {
  ACCESS_TTL_SEC,
  REFRESH_COOKIE,
  clearCookieOptions,
  createRefreshToken,
  issueAccessToken,
  pruneRefreshTokens,
  refreshCookieOptions,
  updatePasswordAndRevokeSessions,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyAccessToken,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  createAccessOnlySession,
  sessionUsesCookie,
} from '../lib/tokens.js'
import { bearer, requireAuth } from '../middleware/auth.js'
import type { AppEnv, SessionUser } from '../types.js'

export const authRoutes = new Hono<AppEnv>()
authRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  await next()
})

type UserRow = {
  id: number
  username: string
  password_hash: string
}

/**
 * 单管理员场景不需要验证码，用内存里的失败计数做指数退避就够了。
 * 重启即清空，属于可接受的取舍。
 */
const failures = new Map<string, { count: number; until: number }>()

function clientKey(ip: string): string {
  return ip || 'unknown'
}

function checkBackoff(key: string): number {
  const rec = failures.get(key)
  if (!rec) return 0
  const remain = rec.until - Date.now()
  return remain > 0 ? Math.ceil(remain / 1000) : 0
}

function noteFailure(key: string): void {
  const rec = failures.get(key) ?? { count: 0, until: 0 }
  rec.count += 1
  // 前两次不惩罚，从第 3 次开始 2^n 秒退避，上限 5 分钟
  if (rec.count >= 3) {
    const delay = Math.min(2 ** (rec.count - 2) * 1000, 5 * 60 * 1000)
    rec.until = Date.now() + delay
  }
  failures.set(key, rec)
}

function clearFailures(key: string): void {
  failures.delete(key)
}

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    ''
  )
}

authRoutes.post('/login', async (c) => {
  const body = await readJson<{ username?: string; password?: string; client?: string }>(c)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!username || !password) {
    return c.json({ error: 'bad_request', message: '请输入用户名和密码' }, 400)
  }

  const key = clientKey(clientIp(c))
  const wait = checkBackoff(key)
  if (wait > 0) {
    return c.json({ error: 'rate_limited', message: `尝试过于频繁，请 ${wait} 秒后再试` }, 429)
  }

  // Resolve an optional previous token before checking the password: a password
  // change during async JWT verification must not let stale credentials sign in.
  const previousToken = bearer(c.req.header('Authorization'))
  const previousSession = previousToken ? await verifyAccessToken(previousToken) : null
  const user = sql.get<UserRow>('SELECT * FROM users WHERE username = ?', username)
  // 用户不存在时也走一次哈希校验，避免用响应时间探测账号是否存在
  const ok = user
    ? verifyPassword(password, user.password_hash)
    : (verifyPassword(password, hashPassword('dummy')), false)

  if (!user || !ok) {
    noteFailure(key)
    return c.json({ error: 'invalid_credentials', message: '用户名或密码不正确' }, 401)
  }

  clearFailures(key)
  pruneRefreshTokens()

  const session: SessionUser = { id: user.id, username: user.username }
  const previousSessionId = previousSession?.user.id === user.id ? previousSession.sessionId : undefined
  let sessionId: string
  if (body.client === 'extension') {
    sessionId = createAccessOnlySession(user.id, c.req.header('user-agent') ?? null, clientIp(c), previousSessionId)
  } else {
    const refresh = createRefreshToken(user.id, c.req.header('user-agent') ?? null, clientIp(c), {
      raw: getCookie(c, REFRESH_COOKIE), sessionId: previousSessionId,
    })
    sessionId = refresh.sessionId
    setCookie(c, REFRESH_COOKIE, refresh.raw, refreshCookieOptions(refresh.expiresAt))
  }
  const accessToken = await issueAccessToken(session, sessionId)

  return c.json({
    access_token: accessToken,
    expires_in: ACCESS_TTL_SEC,
    user: session,
  })
})

authRoutes.post('/refresh', async (c) => {
  const raw = getCookie(c, REFRESH_COOKIE)
  const result = rotateRefreshToken(raw)

  if (!result.ok) {
    deleteCookie(c, REFRESH_COOKIE, clearCookieOptions())
    const message =
      result.reason === 'replay'
        ? '检测到异常的会话使用，当前设备已下线，其他设备不受影响'
        : '登录已过期，请重新登录'
    return c.json({ error: 'unauthorized', message, reason: result.reason }, 401)
  }

  const accessToken = await issueAccessToken(result.user, result.sessionId)
  setCookie(c, REFRESH_COOKIE, result.raw, refreshCookieOptions(result.expiresAt))
  return c.json({
    access_token: accessToken,
    expires_in: ACCESS_TTL_SEC,
    user: result.user,
  })
})

authRoutes.post('/logout', async (c) => {
  const access = bearer(c.req.header('Authorization'))
  const session = access ? await verifyAccessToken(access) : null
  const raw = getCookie(c, REFRESH_COOKIE)
  if (session) revokeSession(session.user.id, session.sessionId)
  else if (raw) revokeRefreshToken(raw)
  if (session?.client !== 'extension') deleteCookie(c, REFRESH_COOKIE, clearCookieOptions())
  return c.json({ ok: true })
})

authRoutes.get('/me', requireAuth, (c) => {
  return c.json({ user: c.get('user') })
})

authRoutes.get('/sessions', requireAuth, (c) => {
  return c.json({ sessions: listSessions(c.get('user').id, c.get('sessionId')) })
})

authRoutes.post('/sessions/revoke-others', requireAuth, (c) => {
  const revoked = revokeOtherSessions(c.get('user').id, c.get('sessionId'))
  return c.json({ ok: true, revoked })
})

authRoutes.delete('/sessions/:id', requireAuth, (c) => {
  const id = c.req.param('id')
  if (!/^[a-f0-9]{32}$/.test(id) || !revokeSession(c.get('user').id, id)) {
    return c.json({ error: 'not_found', message: '登录设备不存在' }, 404)
  }
  const current = id === c.get('sessionId')
  if (current && sessionUsesCookie(c.get('user').id, id)) deleteCookie(c, REFRESH_COOKIE, clearCookieOptions())
  return c.json({ ok: true, current })
})

authRoutes.post('/password', requireAuth, async (c) => {
  const body = await readJson<{ current_password?: string; new_password?: string }>(c)
  const current = typeof body.current_password === 'string' ? body.current_password : ''
  const next = typeof body.new_password === 'string' ? body.new_password : ''

  if (next.length < 6) {
    return c.json({ error: 'bad_request', message: '新密码至少 6 位' }, 400)
  }

  const me = c.get('user')
  const user = sql.get<UserRow>('SELECT * FROM users WHERE id = ?', me.id)
  if (!user || !verifyPassword(current, user.password_hash)) {
    return c.json({ error: 'invalid_credentials', message: '当前密码不正确' }, 401)
  }

  updatePasswordAndRevokeSessions(user.id, hashPassword(next))
  deleteCookie(c, REFRESH_COOKIE, clearCookieOptions())

  return c.json({ ok: true, message: '密码已更新，请重新登录' })
})
