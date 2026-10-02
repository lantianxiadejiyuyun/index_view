import { Hono } from 'hono'
import { sql } from '../lib/db.js'
import { getSetting } from '../db/schema.js'
import { PUBLIC_VIEW } from '../config.js'
import { optionalAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'
import { allFolders, allSites } from '../lib/folders.js'

export const bootstrapRoutes = new Hono<AppEnv>()

/** 这些键含密钥，绝不能出现在未登录也能拿到的响应里 */
export const SECRET_SETTING_KEYS = new Set(['jwt_secret', 'agent_token'])

export function readAllSettings(includeSecrets = false): Record<string, string> {
  const rows = sql.all<{ key: string; value: string | null }>('SELECT key, value FROM settings')
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (!includeSecrets && SECRET_SETTING_KEYS.has(r.key)) continue
    out[r.key] = r.value ?? ''
  }
  return out
}

/**
 * 首屏单请求入口：一次把设置、分组、图标全部带回去。
 * 这样首页只需要一个请求就能渲染完，本地缓存命中时接近静态页。
 */
bootstrapRoutes.get('/bootstrap', optionalAuth, (c) => {
  const user = c.get('user') ?? null
  const publicView = getSetting('public_view') !== 'false' && PUBLIC_VIEW

  if (!user && !publicView) {
    return c.json({ error: 'unauthorized', message: '需要登录后访问' }, 401)
  }

  const categories = sql.all(
    `SELECT id, name, icon, sort_order
     FROM categories ORDER BY sort_order ASC, id ASC`,
  )

  const sites = allSites()

  return c.json({
    user,
    can_edit: Boolean(user),
    settings: readAllSettings(false),
    categories,
    folders: allFolders(),
    sites,
  })
})
