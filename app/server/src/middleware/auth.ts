import type { MiddlewareHandler } from 'hono'
import { verifyAccessToken } from '../lib/tokens.js'
import type { AppEnv } from '../types.js'

export function bearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m?.[1] ?? null
}

/**
 * 必须登录，否则 401。前端收到 401 会先尝试静默刷新再重放请求。
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c.req.header('Authorization'))
  const session = token ? await verifyAccessToken(token) : null
  if (!session) {
    return c.json({ error: 'unauthorized', message: '登录已过期，请重新登录' }, 401)
  }
  c.set('user', session.user)
  c.set('sessionId', session.sessionId)
  await next()
}

/**
 * 可选登录：登录了就把用户挂上，没登录也放行。
 * 用于 bootstrap 这类「游客可看、登录后多返回一点」的接口。
 */
export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c.req.header('Authorization'))
  const session = token ? await verifyAccessToken(token) : null
  if (session) {
    c.set('user', session.user)
    c.set('sessionId', session.sessionId)
  }
  await next()
}
