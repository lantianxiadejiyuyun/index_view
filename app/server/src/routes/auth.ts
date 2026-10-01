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
  revokeAllSessions,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../lib/tokens.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv, SessionUser } from '../types.js'

export const authRoutes = new Hono<AppEnv>()

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
  const body = await readJson<{ username?: string; password?: string }>(c)
  const username = (body.username ?? '').trim()
  const password = body.password ?? ''

  if (!username || !password) {
    return c.json({ error: 'bad_request', message: '请输入用户名和密码' }, 400)
  }

  const key = clientKey(clientIp(c))
  const wait = checkBackoff(key)
  if (wait > 0) {
    return c.json({ error: 'rate_limited', message: `尝试过于频繁，请 ${wait} 秒后再试` }, 429)
  }

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
  const accessToken = await issueAccessToken(session)
  const refresh = createRefreshToken(user.id, c.req.header('user-agent') ?? null, clientIp(c))
  setCookie(c, REFRESH_COOKIE, refresh.raw, refreshCookieOptions(refresh.expiresAt))

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
        ? '检测到异常的会话使用，已出于安全考虑下线全部设备'
        : '登录已过期，请重新登录'
    return c.json({ error: 'unauthorized', message, reason: result.reason }, 401)
  }

  const accessToken = await issueAccessToken(result.user)
  setCookie(c, REFRESH_COOKIE, result.raw, refreshCookieOptions(result.expiresAt))
  return c.json({
    access_token: accessToken,
    expires_in: ACCESS_TTL_SEC,
    user: result.user,
  })
})

authRoutes.post('/logout', async (c) => {
  const raw = getCookie(c, REFRESH_COOKIE)
  if (raw) revokeRefreshToken(raw)
  deleteCookie(c, REFRESH_COOKIE, clearCookieOptions())
  return c.json({ ok: true })
})

authRoutes.get('/me', requireAuth, (c) => {
  return c.json({ user: c.get('user') })
})

authRoutes.post('/password', requireAuth, async (c) => {
  const body = await readJson<{ current_password?: string; new_password?: string }>(c)
  const current = body.current_password ?? ''
  const next = body.new_password ?? ''

  if (next.length < 6) {
    return c.json({ error: 'bad_request', message: '新密码至少 6 位' }, 400)
  }

  const me = c.get('user')
  const user = sql.get<UserRow>('SELECT * FROM users WHERE id = ?', me.id)
  if (!user || !verifyPassword(current, user.password_hash)) {
    return c.json({ error: 'invalid_credentials', message: '当前密码不正确' }, 401)
  }

  sql.run(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    hashPassword(next),
    Date.now(),
    user.id,
  )
  // 改完密码把所有设备踢下线，这是最省心的安全默认
  revokeAllSessions(user.id)
  deleteCookie(c, REFRESH_COOKIE, clearCookieOptions())

  return c.json({ ok: true, message: '密码已更新，请重新登录' })
})
