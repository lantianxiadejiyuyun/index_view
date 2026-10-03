import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { getSetting, putSetting } from '../db/schema.js'
import { allFolders, allSites, categoryReference, NavigationInputError, referenceId } from '../lib/folders.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

type Position = { col: number; row: number; width?: number; height?: number }
type Layout = { version: 1; wide: Record<string, Position>; compact: Record<string, Position> }
type LayoutScope = 'desktop' | 'home'
const widgets = new Set(['clock', 'search', 'weather', 'quote', 'workbench', 'calendar', 'lingxi-calendar', 'lingxi-schedule', 'lingxi-deadline', 'lingxi-chat'])
const layoutKey = (scope: LayoutScope) => scope === 'home' ? 'home_layout' : 'desktop_layout'
export const desktopRoutes = new Hono<AppEnv>()
desktopRoutes.use('/desktop/*', requireAuth)
desktopRoutes.use('/desktop/*', bodyLimit({ maxSize: 64 * 1024 }))
desktopRoutes.use('/desktop/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
desktopRoutes.onError((err, c) => {
  if (err instanceof NavigationInputError) return c.json({ error: 'bad_request', message: err.message }, 400)
  throw err
})

function itemExists(id: unknown): id is string {
  if (typeof id !== 'string') return false
  const [kind, value, extra] = id.split(':')
  if (extra !== undefined) return false
  if (kind === 'widget') return widgets.has(value!)
  if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) return false
  if (kind === 'folder') return !!sql.get('SELECT id FROM folders WHERE id = ?', Number(value))
  if (kind === 'site') return !!sql.get('SELECT id FROM sites WHERE id = ?', Number(value))
  return false
}
function viewport(value: unknown): 'wide' | 'compact' {
  if (value !== 'wide' && value !== 'compact') throw new NavigationInputError('桌面尺寸无效')
  return value
}
function layoutScope(value: unknown): LayoutScope {
  if (value === undefined) return 'desktop'
  if (value !== 'desktop' && value !== 'home') throw new NavigationInputError('布局范围无效，请选择普通首页或桌面')
  return value
}
function position(value: unknown, view: 'wide' | 'compact', id: string, recoverSize = false): Position {
  const p = value as Position | null
  if (!p || !Number.isInteger(p.col) || p.col < 0 || p.col >= (view === 'wide' ? 12 : 4) || !Number.isInteger(p.row) || p.row < 0 || p.row > 10000) throw new NavigationInputError('桌面位置无效')
  const output: Position = { col: p.col, row: p.row }
  if (!Object.hasOwn(p, 'width') && !Object.hasOwn(p, 'height')) return output
  if (!id.startsWith('widget:') || typeof p.width !== 'number' || !Number.isInteger(p.width) || p.width < 1 || p.width > (view === 'wide' ? 12 : 4)
    || typeof p.height !== 'number' || !Number.isInteger(p.height) || p.height < 1 || p.height > 6) {
    // A damaged backup must not discard a still-valid position or relocate another widget.
    if (recoverSize) return output
    throw new NavigationInputError('仅小组件支持自定义尺寸，宽度与高度必须成对填写且在当前屏幕允许范围内')
  }
  return { ...output, width: p.width, height: p.height }
}
export function readDesktopLayout(scope: LayoutScope = 'desktop'): Layout {
  const clean: Layout = { version: 1, wide: {}, compact: {} }
  try {
    const stored = JSON.parse(getSetting(layoutKey(scope)) ?? '{}')
    for (const view of ['wide', 'compact'] as const) {
      for (const [id, p] of Object.entries(stored[view] ?? {})) {
        if (!itemExists(id)) continue
        try { clean[view][id] = position(p, view, id, true) } catch { /* Ignore obsolete coordinates from backups. */ }
      }
    }
  } catch { /* An empty layout is automatically arranged by the client. */ }
  return clean
}

export function importDesktopLayout(raw: string | undefined, folders: Map<number, { id: number }>, sites: Map<number, number>, replace: boolean, scope: LayoutScope = 'desktop') {
  const output = replace ? { version: 1 as const, wide: {}, compact: {} } as Layout : readDesktopLayout(scope)
  if (raw) {
    const value = JSON.parse(raw)
    for (const view of ['wide', 'compact'] as const) for (const [oldId, p] of Object.entries(value[view] ?? {})) {
      const [kind, id] = oldId.split(':')
      const mapped = kind === 'folder' ? folders.get(Number(id))?.id : kind === 'site' ? sites.get(Number(id)) : undefined
      const newId = mapped ? `${kind}:${mapped}` : kind === 'widget' && widgets.has(id!) ? oldId : null
      if (!newId || !itemExists(newId) || (!replace && kind === 'widget' && output[view][newId])) continue
      try { output[view][newId] = position(p, view, newId, true) } catch { /* Invalid old coordinates use automatic placement. */ }
    }
  }
  putSetting(layoutKey(scope), JSON.stringify(output))
}

desktopRoutes.get('/desktop/layout', c => c.json({ layout: readDesktopLayout(layoutScope(c.req.query('scope'))) }))
desktopRoutes.patch('/desktop/layout', async c => {
  const body = await readJson(c)
  const scope = layoutScope(body.scope)
  const view = viewport(body.viewport)
  if (body.reset !== true && (!Array.isArray(body.placements) || body.placements.length < 1 || body.placements.length > 1000)) throw new NavigationInputError('桌面位置列表无效')
  const changes = body.reset === true ? [] : (body.placements as Array<Record<string, unknown>>).map(item => {
    if (!item || !itemExists(item.id)) throw new NavigationInputError('桌面项目已变更，请刷新后重试')
    return { id: item.id, position: position(item, view, item.id) }
  })
  if (new Set(changes.map(p => p.id)).size !== changes.length) throw new NavigationInputError('桌面项目不能重复')
  const layout = sql.tx(() => {
    const current = readDesktopLayout(scope)
    if (body.reset === true) current[view] = {}
    // Older clients and drag operations only send coordinates; keep explicit widget sizes.
    for (const p of changes) current[view][p.id] = { ...current[view][p.id], ...p.position }
    putSetting(layoutKey(scope), JSON.stringify(current))
    return current
  })
  return c.json({ layout })
})

// Membership and the desktop position change together; a failed drop cannot detach an icon.
desktopRoutes.post('/desktop/move', async c => {
  const body = await readJson(c)
  const scope = layoutScope(body.scope)
  const id = referenceId(body.site_id, '站点 ID')
  const site = id === null ? undefined : sql.get<{ id: number; category_id: number | null }>('SELECT id, category_id FROM sites WHERE id = ?', id)
  if (!site) throw new NavigationInputError('图标不存在，请刷新后重试')
  if (body.folder_id === undefined) throw new NavigationInputError('请指定文件夹或桌面')
  const folderId = referenceId(body.folder_id, '文件夹 ID')
  const folder = folderId === null ? null : sql.get<{ id: number; category_id: number | null }>('SELECT id, category_id FROM folders WHERE id = ?', folderId)
  if (folderId !== null && !folder) throw new NavigationInputError('文件夹不存在，请刷新后重试')
  const view = viewport(body.viewport)
  const target = folderId === null ? position(body.position, view, `site:${id}`) : null
  const layout = sql.tx(() => {
    const current = readDesktopLayout(scope)
    const order = sql.get<{ n: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM sites WHERE folder_id IS ?', folderId)!.n
    sql.run('UPDATE sites SET folder_id = ?, category_id = ?, sort_order = ?, updated_at = ? WHERE id = ?', folderId, folder ? folder.category_id : site.category_id, order, Date.now(), site.id)
    if (target) current[view][`site:${site.id}`] = target
    putSetting(layoutKey(scope), JSON.stringify(current))
    return current
  })
  return c.json({ layout, sites: allSites() })
})

// Keep legacy categories for the navigation view; only collect loose icons, once.
desktopRoutes.post('/desktop/collect-groups', c => {
  let created = 0
  sql.tx(() => {
    const now = Date.now()
    const categories = sql.all<{ id: number; name: string }>('SELECT id, name FROM categories ORDER BY sort_order, id')
    let order = sql.get<{ n: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM folders')!.n
    for (const category of categories) {
      if (!sql.get('SELECT id FROM sites WHERE category_id = ? AND folder_id IS NULL LIMIT 1', category.id)) continue
      const folder = sql.run('INSERT INTO folders (name, category_id, columns, rows, sort_order, created_at, updated_at) VALUES (?, ?, 2, 2, ?, ?, ?)', category.name, category.id, order++, now, now).lastInsertRowid
      sql.run('UPDATE sites SET folder_id = ?, updated_at = ? WHERE category_id = ? AND folder_id IS NULL', folder, now, category.id)
      created++
    }
  })
  return c.json({ created, sites: allSites(), folders: allFolders() })
})

desktopRoutes.patch('/folders/reorder', requireAuth, bodyLimit({ maxSize: 64 * 1024 }), async c => {
  const body = await readJson(c)
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 1000) throw new NavigationInputError('文件夹排序无效')
  const changes = body.items.map((item: Record<string, unknown>, index: number) => {
    if (!item || typeof item !== 'object') throw new NavigationInputError('文件夹排序无效')
    const id = referenceId(item.id, '文件夹 ID')
    if (id === null || !sql.get('SELECT id FROM folders WHERE id = ?', id)) throw new NavigationInputError('文件夹不存在')
    return { id, category: categoryReference(item.category_id), order: index }
  })
  if (new Set(changes.map(p => p.id)).size !== changes.length) throw new NavigationInputError('文件夹不能重复')
  sql.tx(() => {
    for (const p of changes) {
      sql.run('UPDATE folders SET category_id = ?, sort_order = ?, updated_at = ? WHERE id = ?', p.category, p.order, Date.now(), p.id)
      sql.run('UPDATE sites SET category_id = ?, updated_at = ? WHERE folder_id = ?', p.category, Date.now(), p.id)
    }
  })
  return c.json({ sites: allSites(), folders: allFolders() })
})
