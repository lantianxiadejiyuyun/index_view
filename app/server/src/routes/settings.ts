import crypto from 'node:crypto'
import { Hono } from 'hono'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { getSetting, putSetting } from '../db/schema.js'
import { requireAuth } from '../middleware/auth.js'
import { readAllSettings, SECRET_SETTING_KEYS } from './bootstrap.js'
import type { AppEnv } from '../types.js'
import { allFolders, allSites, folderColor, folderDimensions, NavigationInputError, referenceId } from '../lib/folders.js'

export const settingsRoutes = new Hono<AppEnv>()

settingsRoutes.onError((err, c) => {
  if (err instanceof NavigationInputError) return c.json({ error: 'bad_request', message: err.message }, 400)
  throw err
})

/** 允许通过接口写入的键白名单，避免前端塞进任意键污染配置 */
const WRITABLE_KEYS = new Set([
  'site_title',
  'site_subtitle',
  'search_engine',
  'custom_engines',
  'appearance_preset',
  'wallpaper_light_type',
  'wallpaper_light_value',
  'wallpaper_dark_type',
  'wallpaper_dark_value',
  'wallpaper_blur',
  'wallpaper_dim',
  'card_size',
  'grid_gap',
  'glass',
  'show_clock',
  'show_greeting',
  'show_weather',
  'show_hitokoto',
  'show_workbench',
  'tone_clock',
  'tone_heading',
  'tone_page_title',
  'weather_city',
  'weather_provider',
  'open_in_new_tab',
  'agent_ports',
  'public_view',
])

/**
 * 取值是固定集合的设置项：写入时校验，免得存进去一个谁都不认识的值。
 *
 * 前端读的时候会归一化兜住，但「存垃圾、读时再猜」本身就是隐患 ——
 * 数据库里躺着非法值，排查问题时会被误导。这里直接拒掉，返回 400。
 */
const ENUM_VALUES: Record<string, readonly string[]> = {
  appearance_preset: ['classic', 'desktop', 'minimal', 'paper', 'terminal'],
  card_size: ['sm', 'md', 'lg'],
  grid_gap: ['sm', 'md', 'lg'],
  glass: ['none', 'sm', 'md', 'lg'],
  wallpaper_light_type: ['gradient', 'color', 'image', 'url', 'video'],
  wallpaper_dark_type: ['gradient', 'color', 'image', 'url', 'video'],
  tone_clock: ['auto', 'black', 'white'],
  tone_heading: ['auto', 'black', 'white'],
  tone_page_title: ['auto', 'black', 'white'],
  // 国内源与中国天气网，前者快得多（19ms vs 877ms）且不受墙影响
  weather_provider: ['china', 'open-meteo'],
}

settingsRoutes.get('/settings', requireAuth, (c) => {
  return c.json({ settings: readAllSettings(true) })
})

settingsRoutes.put('/settings', requireAuth, async (c) => {
  const body = await readJson(c)
  const applied: string[] = []
  const ignored: string[] = []

  // 先整体校验再落库，避免「改了一半才发现有个非法值」
  const invalid = Object.entries(body).filter(([key, value]) => {
    const allowed = ENUM_VALUES[key]
    if (key === 'appearance_preset' && typeof value !== 'string') return true
    return allowed !== undefined && !allowed.includes(String(value))
  })
  if (invalid.length > 0) {
    const [key, value] = invalid[0]!
    return c.json(
      {
        error: 'invalid_value',
        message: `「${key}」不接受这个值：${String(value)}（可选：${ENUM_VALUES[key]!.join(' / ')}）`,
      },
      400,
    )
  }

  sql.tx(() => {
    for (const [key, value] of Object.entries(body)) {
      if (!WRITABLE_KEYS.has(key)) {
        ignored.push(key)
        continue
      }
      const v =
        typeof value === 'string'
          ? value
          : value === null || value === undefined
            ? ''
            : JSON.stringify(value)
      putSetting(key, v)
      applied.push(key)
    }
  })

  return c.json({ ok: true, applied, ignored, settings: readAllSettings(true) })
})

/**
 * 探针令牌：只在管理端暴露，用来配置 agent。
 * 轮换后所有未更新令牌的探针会失联，这是刻意设计。
 */
settingsRoutes.get('/agent-token', requireAuth, (c) => {
  return c.json({ token: getSetting('agent_token') ?? '' })
})

settingsRoutes.post('/agent-token/rotate', requireAuth, (c) => {
  const token = crypto.randomBytes(32).toString('base64url')
  putSetting('agent_token', token)
  return c.json({ token })
})

/** 备份用：导出全部内容数据（不含密码哈希与令牌） */
settingsRoutes.get('/export', requireAuth, (c) => {
  const categories = sql.all('SELECT * FROM categories ORDER BY sort_order, id')
  const sites = allSites()
  const settings = readAllSettings(false)
  // 深浅色已迁移为每台设备的本地偏好，不再随备份导出或导入。
  delete settings.theme
  return c.json(
    {
      exported_at: new Date().toISOString(),
      version: 2,
      settings,
      categories,
      folders: allFolders(),
      sites,
    },
    200,
    {
      'Content-Disposition': `attachment; filename="home-dashboard-${Date.now()}.json"`,
    },
  )
})

/** 导入：整表替换或合并 */
settingsRoutes.post('/import', requireAuth, async (c) => {
  const body = await readJson<{
    mode?: string
    settings?: Record<string, string>
    categories?: Array<Record<string, unknown>>
    folders?: Array<Record<string, unknown>>
    sites?: Array<Record<string, unknown>>
  }>(c)

  // 导入绕过 PUT /settings；在替换内容前校验新外观键，避免非法备份先清空分组。
  if (body.settings && typeof body.settings === 'object' && 'appearance_preset' in body.settings) {
    const value = body.settings.appearance_preset
    if (typeof value !== 'string' || !ENUM_VALUES.appearance_preset!.includes(value)) {
      return c.json({ error: 'invalid_value', message: '备份中的外观主题无效，请选择内置主题。' }, 400)
    }
  }

  const mode = body.mode === 'merge' ? 'merge' : 'replace'
  const categories = Array.isArray(body.categories) ? body.categories : []
  if (body.folders !== undefined && !Array.isArray(body.folders)) throw new NavigationInputError('备份中的文件夹列表无效')
  const folders = body.folders ?? []
  const sites = Array.isArray(body.sites) ? body.sites : []
  if (categories.length === 0 && folders.length === 0 && sites.length === 0) {
    return c.json({ error: 'bad_request', message: '文件里没有可导入的内容' }, 400)
  }

  // Validate the whole backup before replace deletes anything. Import IDs refer
  // only to entries in this backup, never to coincidentally matching live IDs.
  const categoryIds = new Set<number>()
  const folderIds = new Set<number>()
  const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
  const order = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  const preparedCategories = categories.flatMap((cat, index) => {
    if (!cat || typeof cat !== 'object') throw new NavigationInputError('备份中的分组无效')
    const name = text(cat.name, 60)
    if (!name) return []
    const oldId = referenceId(cat.id, '备份中的分组 ID')
    if (oldId !== null) {
      if (categoryIds.has(oldId)) throw new NavigationInputError('备份中的分组 ID 重复')
      categoryIds.add(oldId)
    }
    return [{ oldId, name, icon: text(cat.icon, 40) || null, sortOrder: order(cat.sort_order, index) }]
  })
  const importedCategory = (value: unknown) => {
    const id = referenceId(value, '备份中的分组 ID')
    if (id !== null && !categoryIds.has(id)) throw new NavigationInputError('备份引用了不存在的分组')
    return id
  }
  const preparedFolders = folders.map((folder, index) => {
    if (!folder || typeof folder !== 'object') throw new NavigationInputError('备份中的文件夹无效')
    const name = text(folder.name, 60)
    if (!name) throw new NavigationInputError('备份中的文件夹名称不能为空')
    const oldId = referenceId(folder.id, '备份中的文件夹 ID')
    if (oldId !== null) {
      if (folderIds.has(oldId)) throw new NavigationInputError('备份中的文件夹 ID 重复')
      folderIds.add(oldId)
    }
    return { oldId, name, oldCategoryId: importedCategory(folder.category_id),
      ...folderDimensions(folder.columns === undefined ? 2 : folder.columns, folder.rows === undefined ? 2 : folder.rows),
      color: folderColor(folder.color), sortOrder: order(folder.sort_order, index) }
  })
  const importedUrl = (value: unknown) => {
    const raw = text(value, 10000)
    if (!raw) return null
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
    } catch { return null }
  }
  const preparedSites = sites.flatMap((site, index) => {
    if (!site || typeof site !== 'object') throw new NavigationInputError('备份中的站点无效')
    const title = text(site.title, 80)
    const urlPublic = importedUrl(site.url_public ?? site.url)
    const urlLan = importedUrl(site.url_lan)
    if (!title || (!urlPublic && !urlLan)) return []
    const oldFolderId = referenceId(site.folder_id, '备份中的文件夹 ID')
    if (oldFolderId !== null && !folderIds.has(oldFolderId)) throw new NavigationInputError('备份中的站点引用了不存在的文件夹')
    const oldCategoryId = importedCategory(site.category_id)
    return [{ site, title, urlPublic, urlLan, oldCategoryId, oldFolderId, sortOrder: order(site.sort_order, index) }]
  })
  if (!preparedCategories.length && !preparedFolders.length && !preparedSites.length) {
    throw new NavigationInputError('文件里没有可导入的有效内容，现有内容已保留')
  }

  const t = Date.now()
  let categoryCount = 0
  let folderCount = 0
  let siteCount = 0

  sql.tx(() => {
    if (mode === 'replace') {
      sql.run('DELETE FROM sites')
      sql.run('DELETE FROM folders')
      sql.run('DELETE FROM categories')
    }

    // 旧 id → 新 id 映射，保证 sites 能正确挂到对应分组
    const idMap = new Map<number, number>()
    preparedCategories.forEach(cat => {
      const { lastInsertRowid } = sql.run(
        'INSERT INTO categories (name, icon, sort_order, created_at) VALUES (?, ?, ?, ?)',
        cat.name,
        cat.icon,
        cat.sortOrder,
        t,
      )
      if (cat.oldId !== null) idMap.set(cat.oldId, Number(lastInsertRowid))
      categoryCount += 1
    })

    const folderMap = new Map<number, { id: number; categoryId: number | null }>()
    preparedFolders.forEach(folder => {
      const categoryId = folder.oldCategoryId === null ? null : idMap.get(folder.oldCategoryId) ?? null
      const { lastInsertRowid } = sql.run(`INSERT INTO folders (name, category_id, columns, rows, color, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, folder.name, categoryId, folder.columns, folder.rows, folder.color, folder.sortOrder, t, t)
      if (folder.oldId !== null) folderMap.set(folder.oldId, { id: lastInsertRowid, categoryId })
      folderCount++
    })

    preparedSites.forEach(({ site, title, urlPublic, urlLan, oldCategoryId, oldFolderId, sortOrder }) => {
      const folder = oldFolderId === null ? undefined : folderMap.get(oldFolderId)
      const categoryId = folder ? folder.categoryId : oldCategoryId === null ? null : idMap.get(oldCategoryId) ?? null
      sql.run(
        `INSERT INTO sites (category_id, folder_id, title, description, url_public, url_lan, lan_port,
                            link_mode, icon_url, icon_text, color, source, sort_order,
                            clicks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        categoryId,
        folder?.id ?? null,
        title,
        typeof site.description === 'string' ? site.description.slice(0, 200) : null,
        urlPublic,
        urlLan,
        typeof site.lan_port === 'number' && Number.isInteger(site.lan_port) && site.lan_port > 0 && site.lan_port <= 65535 ? site.lan_port : null,
        ['auto', 'public', 'lan'].includes(String(site.link_mode)) ? String(site.link_mode) : 'auto',
        typeof site.icon_url === 'string' ? site.icon_url.slice(0, 1000) : null,
        typeof site.icon_text === 'string' ? site.icon_text.slice(0, 4) : null,
        typeof site.color === 'string' ? site.color.slice(0, 20) : null,
        typeof site.source === 'string' ? site.source.slice(0, 20) : 'import',
        sortOrder,
        Math.max(0, order(site.clicks, 0)),
        t,
        t,
      )
      siteCount += 1
    })

    if (body.settings && typeof body.settings === 'object') {
      for (const [key, value] of Object.entries(body.settings)) {
        if (!WRITABLE_KEYS.has(key) || SECRET_SETTING_KEYS.has(key)) continue
        putSetting(key, String(value ?? ''))
      }
    }
  })

  return c.json({ ok: true, mode, categories: categoryCount, folders: folderCount, sites: siteCount })
})
