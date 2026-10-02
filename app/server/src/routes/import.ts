/**
 * 浏览器书签 HTML 导入。
 *
 * 契约（前端依赖，勿改）：
 *
 *   POST /api/import/bookmarks/preview   multipart 字段 file=<bookmarks.html>
 *     → { categories: [{ name, count, sites: [{ title, url, icon_url? }] }], total }
 *   POST /api/import/bookmarks/commit    body { categories, mode: 'merge'|'replace' }
 *     → { ok, categories: number, sites: number }
 *
 * 职责划分：解析全部交给 lib/bookmark-parser.ts（纯函数），这里只管
 * 「读文件 → 校验 → 落库」，preview 绝不写数据库。
 */
import { Hono } from 'hono'
import {
  MAX_GROUP_NAME_LENGTH,
  MAX_ICON_URL_LENGTH,
  MAX_TITLE_LENGTH,
  cleanBookmarkText,
  clipText,
  decodeBookmarkHtml,
  normalizeBookmarkUrl,
  parseBookmarks,
} from '../lib/bookmark-parser.js'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { initialOf } from '../lib/parse.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export const importRoutes = new Hono<AppEnv>()

const MAX_FILE_BYTES = 10 * 1024 * 1024
/** multipart 有边界和头部的固定开销，比文件限制放宽一点，避免把正常文件误判成超限 */
const CONTENT_LENGTH_SLACK = 64 * 1024

// ── 工具 ──────────────────────────────────────────────────────

/**
 * 从表单里挑出上传的文件。
 * 字段名按契约是 file；顺手兼容多文件上传与别的字段名，
 * 免得前端换个 input name 就报「没有收到文件」。
 */
function pickFile(input: unknown): File | null {
  if (input instanceof File) return input
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item instanceof File) return item
    }
  }
  return null
}

/** 标题为空时用域名兜底，保证 sites.title 永远不为空 */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url
  } catch {
    return url
  }
}

type PreparedSite = { title: string; url: string; iconUrl: string | null }
type PreparedGroup = { name: string; sites: PreparedSite[] }

/**
 * 规整 commit 的入参。
 *
 * commit 是前端把 preview 的结果（用户可能已经改过）回传回来的，
 * 所以这里必须当成不可信数据重新校验一遍 URL / 标题 / 分组名。
 */
function prepareGroups(rawCategories: unknown[]): PreparedGroup[] {
  const out: PreparedGroup[] = []

  for (const rawCategory of rawCategories) {
    if (!rawCategory || typeof rawCategory !== 'object') continue
    const category = rawCategory as Record<string, unknown>

    const rawName = typeof category.name === 'string' ? cleanBookmarkText(category.name) : ''
    const name = clipText(rawName, MAX_GROUP_NAME_LENGTH)
    if (!name) continue

    const rawSites = Array.isArray(category.sites) ? category.sites : []
    const sites: PreparedSite[] = []

    for (const rawSite of rawSites) {
      if (!rawSite || typeof rawSite !== 'object') continue
      const site = rawSite as Record<string, unknown>

      const url = normalizeBookmarkUrl(site.url)
      if (!url) continue

      let title = typeof site.title === 'string' ? cleanBookmarkText(site.title) : ''
      title = clipText(title, MAX_TITLE_LENGTH)
      if (!title) title = domainOf(url)

      const iconUrl = normalizeBookmarkUrl(site.icon_url)
      sites.push({
        title,
        url,
        iconUrl: iconUrl !== null && iconUrl.length <= MAX_ICON_URL_LENGTH ? iconUrl : null,
      })
    }

    // 一个条目都没剩的分组不落库，与 preview 的口径保持一致
    if (sites.length > 0) out.push({ name, sites })
  }

  return out
}

// ── 预览 ──────────────────────────────────────────────────────

importRoutes.post('/import/bookmarks/preview', requireAuth, async (c) => {
  // 先看 Content-Length：能在几十 MB 的文件被读进内存之前就拒掉
  const declared = Number(c.req.header('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES + CONTENT_LENGTH_SLACK) {
    return c.json(
      { error: 'too_large', message: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 限制` },
      413,
    )
  }

  let form: Record<string, unknown>
  try {
    form = (await c.req.parseBody()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'bad_request', message: '表单解析失败' }, 400)
  }

  const file = pickFile(form.file)
  if (!file) {
    return c.json({ error: 'bad_request', message: '没有收到文件（字段名应为 file）' }, 400)
  }
  if (file.size === 0) {
    return c.json({ error: 'bad_request', message: '文件是空的' }, 400)
  }
  if (file.size > MAX_FILE_BYTES) {
    return c.json(
      { error: 'too_large', message: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 限制` },
      413,
    )
  }

  // decodeBookmarkHtml 负责 charset 嗅探，parseBookmarks 是纯函数，整个 preview 不碰数据库
  const html = decodeBookmarkHtml(Buffer.from(await file.arrayBuffer()))
  const groups = parseBookmarks(html)
  let total = 0
  for (const group of groups) total += group.sites.length

  if (total === 0) {
    return c.json(
      {
        error: 'no_bookmarks',
        message: '没有从这个文件里解析出任何书签，请确认是浏览器导出的 bookmarks.html（Netscape 书签格式）',
      },
      400,
    )
  }

  return c.json({
    categories: groups.map((group) => ({
      name: group.name,
      count: group.sites.length,
      sites: group.sites,
    })),
    total,
  })
})

// ── 提交入库 ──────────────────────────────────────────────────

const INSERT_SITE_SQL = `
  INSERT INTO sites (category_id, title, description, url_public, url_lan, lan_port,
                     link_mode, icon_url, icon_text, color, source, sort_order,
                     created_at, updated_at)
  VALUES (?, ?, NULL, ?, NULL, NULL, 'auto', ?, ?, NULL, 'bookmark', ?, ?, ?)`

importRoutes.post('/import/bookmarks/commit', requireAuth, async (c) => {
  const body = await readJson(c)

  const mode = body.mode === undefined ? 'merge' : body.mode
  if (mode !== 'merge' && mode !== 'replace') {
    return c.json({ error: 'bad_request', message: 'mode 只能是 merge 或 replace' }, 400)
  }
  if (!Array.isArray(body.categories)) {
    return c.json({ error: 'bad_request', message: 'categories 必须是数组' }, 400)
  }

  const groups = prepareGroups(body.categories)
  let siteTotal = 0
  for (const group of groups) siteTotal += group.sites.length

  // 空数据直接拒绝：否则 replace 模式下一次误操作就能清空整个书签库
  if (siteTotal === 0) {
    return c.json({ error: 'no_bookmarks', message: '没有可导入的条目' }, 400)
  }

  const t = Date.now()
  let categoryCount = 0
  let siteCount = 0

  sql.tx(() => {
    if (mode === 'replace') {
      // 先删 sites：外键是 ON DELETE SET NULL，反过来删会白跑一遍级联更新
      sql.run('DELETE FROM sites')
      sql.run('DELETE FROM folders')
      sql.run('DELETE FROM categories')
    }

    // 分组名 → id 的缓存：merge 模式下上万条书签也只查一次库，新分组只建一次
    const idByName = new Map<string, number>()
    if (mode === 'merge') {
      for (const row of sql.all<{ id: number; name: string }>(
        'SELECT id, name FROM categories',
      )) {
        idByName.set(row.name, row.id)
      }
    }

    let nextCategoryOrder =
      (sql.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM categories')?.m ?? -1) + 1

    // 各分组已有的最大 sort_order：merge 时新条目要接在旧条目后面，否则排序会互相踩
    const nextSiteOrder = new Map<number, number>()
    for (const row of sql.all<{ category_id: number | null; m: number | null }>(
      'SELECT category_id, MAX(sort_order) AS m FROM sites GROUP BY category_id',
    )) {
      if (row.category_id !== null) nextSiteOrder.set(row.category_id, (row.m ?? -1) + 1)
    }

    for (const group of groups) {
      let categoryId = idByName.get(group.name)
      if (categoryId === undefined) {
        categoryId = sql.run(
          'INSERT INTO categories (name, icon, sort_order, created_at) VALUES (?, ?, ?, ?)',
          group.name,
          null,
          nextCategoryOrder,
          t,
        ).lastInsertRowid
        nextCategoryOrder += 1
        idByName.set(group.name, categoryId)
      }

      let order = nextSiteOrder.get(categoryId) ?? 0
      for (const site of group.sites) {
        sql.run(
          INSERT_SITE_SQL,
          categoryId,
          site.title,
          site.url,
          site.iconUrl,
          initialOf(site.title),
          order,
          t,
          t,
        )
        order += 1
        siteCount += 1
      }
      nextSiteOrder.set(categoryId, order)
      categoryCount += 1
    }
  })

  // categories 返回「本次导入涉及的分组数」而不是「新建的分组数」：
  // merge 复用时显示 0 会让用户以为导入失败，前端也拿它和 preview 的条数对照
  return c.json({ ok: true, categories: categoryCount, sites: siteCount })
})
