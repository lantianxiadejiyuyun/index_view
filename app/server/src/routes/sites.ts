import { Hono } from 'hono'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { initialOf, num, str } from '../lib/parse.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'
import { NavigationInputError, siteLocation } from '../lib/folders.js'

export const siteRoutes = new Hono<AppEnv>()

siteRoutes.onError((err, c) => {
  if (err instanceof NavigationInputError) return c.json({ error: 'bad_request', message: err.message }, 400)
  throw err
})

// ── 工具 ──────────────────────────────────────────────────────

/**
 * 没写协议时猜一个。
 *
 * 内网地址（私有 IP / localhost / *.lan 等）绝大多数跑的是 http，
 * 一律补 https 会让用户填完地址点开发现打不开，还很难看出原因。
 */
function guessScheme(raw: string): string {
  const host = raw.split('/')[0]?.split('?')[0] ?? raw
  const hostname = host.split(':')[0]?.toLowerCase() ?? ''

  const isPrivateIp =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) &&
    (/^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^127\./.test(hostname))

  const isPrivate =
    hostname === 'localhost' ||
    isPrivateIp ||
    /\.(lan|local|home|internal|intranet|corp)$/.test(hostname)

  return isPrivate ? 'http://' : 'https://'
}

/** 补全协议头，顺手挡掉 javascript: / data: 这类危险 scheme */
function normalizeUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : guessScheme(raw) + raw
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

const LINK_MODES = new Set(['auto', 'public', 'lan'])

function normalizeLinkMode(input: unknown): string {
  const v = typeof input === 'string' ? input : ''
  return LINK_MODES.has(v) ? v : 'auto'
}

// ── 分组 ──────────────────────────────────────────────────────

siteRoutes.post('/categories', requireAuth, async (c) => {
  const body = await readJson(c)
  const name = str(body.name, 60)
  if (!name) return c.json({ error: 'bad_request', message: '分组名称不能为空' }, 400)

  const maxOrder =
    sql.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM categories')?.m ?? -1

  const { lastInsertRowid } = sql.run(
    'INSERT INTO categories (name, icon, sort_order, created_at) VALUES (?, ?, ?, ?)',
    name,
    str(body.icon, 40),
    maxOrder + 1,
    Date.now(),
  )
  const row = sql.get('SELECT * FROM categories WHERE id = ?', lastInsertRowid)
  return c.json({ category: row }, 201)
})

siteRoutes.put('/categories/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'bad_request' }, 400)

  const body = await readJson(c)
  const existing = sql.get<{ id: number; name: string; icon: string | null }>(
    'SELECT * FROM categories WHERE id = ?',
    id,
  )
  if (!existing) return c.json({ error: 'not_found', message: '分组不存在' }, 404)

  const name = body.name === undefined ? existing.name : str(body.name, 60)
  if (!name) return c.json({ error: 'bad_request', message: '分组名称不能为空' }, 400)

  sql.run(
    'UPDATE categories SET name = ?, icon = ? WHERE id = ?',
    name,
    body.icon === undefined ? existing.icon : str(body.icon, 40),
    id,
  )
  return c.json({ category: sql.get('SELECT * FROM categories WHERE id = ?', id) })
})

siteRoutes.delete('/categories/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'bad_request' }, 400)

  const mode = c.req.query('mode') ?? 'detach'
  sql.tx(() => {
    if (mode === 'delete') {
      // 连同分组下的图标一起删掉
      sql.run('DELETE FROM sites WHERE category_id = ?', id)
      sql.run('DELETE FROM folders WHERE category_id = ?', id)
    }
    // 默认只解绑：外键是 ON DELETE SET NULL，图标会落到「未分组」
    sql.run('DELETE FROM categories WHERE id = ?', id)
  })
  return c.json({ ok: true })
})

/** 拖拽后一次性提交全量顺序，比增量 diff 简单可靠得多 */
siteRoutes.patch('/categories/reorder', requireAuth, async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({ ids: [] }))
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : []
  if (ids.length === 0) return c.json({ ok: true, updated: 0 })

  sql.tx(() => {
    ids.forEach((id, index) => {
      sql.run('UPDATE categories SET sort_order = ? WHERE id = ?', index, id)
    })
  })
  return c.json({ ok: true, updated: ids.length })
})

// ── 图标（站点）───────────────────────────────────────────────

siteRoutes.post('/sites', requireAuth, async (c) => {
  const body = await readJson(c)

  const title = str(body.title, 80)
  if (!title) return c.json({ error: 'bad_request', message: '名称不能为空' }, 400)

  const urlPublic = normalizeUrl(body.url_public ?? body.url)
  const urlLan = normalizeUrl(body.url_lan)
  if (!urlPublic && !urlLan) {
    return c.json({ error: 'bad_request', message: '至少填写一个有效地址（http/https）' }, 400)
  }

  const { categoryId, folderId } = siteLocation(body)
  const maxOrder =
    sql.get<{ m: number | null }>(
      'SELECT MAX(sort_order) AS m FROM sites WHERE category_id IS ? AND folder_id IS ?',
      categoryId,
      folderId,
    )?.m ?? -1

  const t = Date.now()
  const { lastInsertRowid } = sql.run(
    `INSERT INTO sites (category_id, folder_id, title, description, url_public, url_lan, lan_port,
                        link_mode, icon_url, icon_text, color, source, sort_order,
                        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
    categoryId,
    folderId,
    title,
    str(body.description, 200),
    urlPublic,
    urlLan,
    num(body.lan_port),
    normalizeLinkMode(body.link_mode),
    str(body.icon_url, 1000),
    str(body.icon_text, 4) ?? initialOf(title),
    str(body.color, 20),
    maxOrder + 1,
    t,
    t,
  )

  const row = sql.get('SELECT * FROM sites WHERE id = ?', lastInsertRowid)
  return c.json({ site: row }, 201)
})

siteRoutes.put('/sites/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'bad_request' }, 400)

  const existing = sql.get<Record<string, unknown>>('SELECT * FROM sites WHERE id = ?', id)
  if (!existing) return c.json({ error: 'not_found', message: '图标不存在' }, 404)

  const body = await readJson(c)

  const title = body.title === undefined ? String(existing.title) : str(body.title, 80)
  if (!title) return c.json({ error: 'bad_request', message: '名称不能为空' }, 400)

  const pickUrl = (key: string): string | null => {
    if (body[key] === undefined) return (existing[key] as string | null) ?? null
    return normalizeUrl(body[key])
  }

  const urlPublic = pickUrl('url_public')
  const urlLan = pickUrl('url_lan')
  if (!urlPublic && !urlLan) {
    return c.json({ error: 'bad_request', message: '至少填写一个有效地址（http/https）' }, 400)
  }

  const { categoryId, folderId } = siteLocation(body, { category_id: existing.category_id, folder_id: existing.folder_id })

  sql.run(
    `UPDATE sites SET category_id = ?, folder_id = ?, title = ?, description = ?, url_public = ?, url_lan = ?,
                      lan_port = ?, link_mode = ?, icon_url = ?, icon_text = ?, color = ?,
                      updated_at = ?
     WHERE id = ?`,
    categoryId,
    folderId,
    title,
    body.description === undefined ? (existing.description as string | null) : str(body.description, 200),
    urlPublic,
    urlLan,
    body.lan_port === undefined ? num(existing.lan_port) : num(body.lan_port),
    body.link_mode === undefined ? String(existing.link_mode) : normalizeLinkMode(body.link_mode),
    body.icon_url === undefined ? (existing.icon_url as string | null) : str(body.icon_url, 1000),
    body.icon_text === undefined ? (existing.icon_text as string | null) : str(body.icon_text, 4),
    body.color === undefined ? (existing.color as string | null) : str(body.color, 20),
    Date.now(),
    id,
  )

  return c.json({ site: sql.get('SELECT * FROM sites WHERE id = ?', id) })
})

siteRoutes.delete('/sites/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'bad_request' }, 400)
  sql.run('DELETE FROM sites WHERE id = ?', id)
  return c.json({ ok: true })
})

siteRoutes.patch('/sites/reorder', requireAuth, async (c) => {
  const body = await c.req
    .json<{ items?: Array<{ id?: unknown; category_id?: unknown; folder_id?: unknown; sort_order?: unknown }> }>()
    .catch(() => ({ items: [] }))
  const items = Array.isArray(body.items) ? body.items : []
  if (items.length === 0) return c.json({ ok: true, updated: 0 })

  // Resolve every target before updating any row so a stale folder/group is atomic.
  const changes = items.flatMap((item, index) => {
    if (!item || typeof item !== 'object') throw new NavigationInputError('排序内容无效')
    const id = Number(item.id)
    if (!Number.isSafeInteger(id)) throw new NavigationInputError('站点 ID 无效')
    const existing = sql.get<{ category_id: number | null; folder_id: number | null }>('SELECT category_id, folder_id FROM sites WHERE id = ?', id)
    if (!existing) throw new NavigationInputError('站点不存在，请刷新后重试')
    return [{ id, ...siteLocation(item, existing), order: num(item.sort_order) ?? index }]
  })
  let updated = 0
  sql.tx(() => {
    changes.forEach(({ id, categoryId, folderId, order }) => {
      const res = sql.run(
        'UPDATE sites SET category_id = ?, folder_id = ?, sort_order = ?, updated_at = ? WHERE id = ?',
        categoryId,
        folderId,
        order,
        Date.now(),
        id,
      )
      updated += res.changes
    })
  })
  return c.json({ ok: true, updated })
})

/** 记录一次点击，用于「最近/常用」排序 */
siteRoutes.post('/sites/:id/click', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'bad_request' }, 400)
  sql.run('UPDATE sites SET clicks = clicks + 1 WHERE id = ?', id)
  return c.json({ ok: true })
})
