import { Hono } from 'hono'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { allSites, categoryReference, folderColor, folderDimensions, NavigationInputError, referenceId, type FolderRow } from '../lib/folders.js'
import { str } from '../lib/parse.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export const folderRoutes = new Hono<AppEnv>()

folderRoutes.onError((err, c) => {
  if (err instanceof NavigationInputError) return c.json({ error: 'bad_request', message: err.message }, 400)
  throw err
})

function folderInput(body: Record<string, unknown>, existing?: FolderRow) {
  const name = str(body.name === undefined ? existing?.name : body.name, 60)
  if (!name) throw new NavigationInputError('文件夹名称不能为空')
  const categoryId = categoryReference(body.category_id === undefined ? existing?.category_id : body.category_id)
  const dimensions = folderDimensions(body.columns === undefined ? existing?.columns ?? 2 : body.columns,
    body.rows === undefined ? existing?.rows ?? 2 : body.rows)
  const color = folderColor(body.color === undefined ? existing?.color : body.color)
  let siteIds: number[] | undefined
  if (body.site_ids !== undefined) {
    if (!Array.isArray(body.site_ids)) throw new NavigationInputError('文件夹内容必须为站点 ID 列表')
    siteIds = body.site_ids.map(value => {
      const id = referenceId(value, '站点 ID')
      if (id === null || !sql.get('SELECT id FROM sites WHERE id = ?', id)) throw new NavigationInputError('文件夹中的站点不存在，请刷新后重试')
      return id
    })
    if (new Set(siteIds).size !== siteIds.length) throw new NavigationInputError('文件夹中的站点不能重复')
  }
  return { name, categoryId, ...dimensions, color, siteIds }
}

function updateMembers(id: number, categoryId: number | null, siteIds?: number[]) {
  const now = Date.now()
  // Move existing members first, including members that will be unwrapped below.
  sql.run('UPDATE sites SET category_id = ?, updated_at = ? WHERE folder_id = ?', categoryId, now, id)
  if (siteIds === undefined) return
  sql.run('UPDATE sites SET folder_id = NULL, updated_at = ? WHERE folder_id = ?', now, id)
  siteIds.forEach((siteId, order) => {
    sql.run('UPDATE sites SET folder_id = ?, category_id = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      id, categoryId, order, now, siteId)
  })
}

folderRoutes.post('/folders', requireAuth, async c => {
  const input = folderInput(await readJson(c))
  const id = sql.tx(() => {
    const order = sql.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM folders')?.m ?? -1
    const now = Date.now()
    const inserted = sql.run(`INSERT INTO folders (name, category_id, columns, rows, color, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, input.name, input.categoryId, input.columns, input.rows, input.color, order + 1, now, now).lastInsertRowid
    updateMembers(inserted, input.categoryId, input.siteIds)
    return inserted
  })
  return c.json({ folder: sql.get('SELECT * FROM folders WHERE id = ?', id), sites: allSites() }, 201)
})

folderRoutes.put('/folders/:id', requireAuth, async c => {
  const id = referenceId(c.req.param('id'), '文件夹 ID')
  const existing = id === null ? undefined : sql.get<FolderRow>('SELECT * FROM folders WHERE id = ?', id)
  if (!existing) return c.json({ error: 'not_found', message: '文件夹不存在' }, 404)
  const input = folderInput(await readJson(c), existing)
  sql.tx(() => {
    sql.run('UPDATE folders SET name = ?, category_id = ?, columns = ?, rows = ?, color = ?, updated_at = ? WHERE id = ?',
      input.name, input.categoryId, input.columns, input.rows, input.color, Date.now(), existing.id)
    updateMembers(existing.id, input.categoryId, input.siteIds)
  })
  return c.json({ folder: sql.get('SELECT * FROM folders WHERE id = ?', existing.id), sites: allSites() })
})

folderRoutes.delete('/folders/:id', requireAuth, c => {
  const id = referenceId(c.req.param('id'), '文件夹 ID')
  if (id === null || !sql.get('SELECT id FROM folders WHERE id = ?', id)) {
    return c.json({ error: 'not_found', message: '文件夹不存在' }, 404)
  }
  sql.tx(() => {
    sql.run('UPDATE sites SET folder_id = NULL, updated_at = ? WHERE folder_id = ?', Date.now(), id)
    sql.run('DELETE FROM folders WHERE id = ?', id)
  })
  return c.json({ ok: true, sites: allSites() })
})
