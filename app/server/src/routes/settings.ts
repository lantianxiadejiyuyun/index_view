import crypto from 'node:crypto'
import { Hono } from 'hono'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { getSetting, putSetting } from '../db/schema.js'
import { requireAuth } from '../middleware/auth.js'
import { readAllSettings, SECRET_SETTING_KEYS } from './bootstrap.js'
import type { AppEnv } from '../types.js'

export const settingsRoutes = new Hono<AppEnv>()

/** 允许通过接口写入的键白名单，避免前端塞进任意键污染配置 */
const WRITABLE_KEYS = new Set([
  'site_title',
  'site_subtitle',
  'search_engine',
  'custom_engines',
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
  const sites = sql.all(
    `SELECT id, category_id, title, description, url_public, url_lan, lan_port, link_mode,
            icon_url, icon_text, color, source, sort_order, clicks
     FROM sites ORDER BY sort_order, id`,
  )
  const settings = readAllSettings(false)
  // 深浅色已迁移为每台设备的本地偏好，不再随备份导出或导入。
  delete settings.theme
  return c.json(
    {
      exported_at: new Date().toISOString(),
      version: 1,
      settings,
      categories,
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
    sites?: Array<Record<string, unknown>>
  }>(c)

  const mode = body.mode === 'merge' ? 'merge' : 'replace'
  const categories = Array.isArray(body.categories) ? body.categories : []
  const sites = Array.isArray(body.sites) ? body.sites : []
  if (categories.length === 0 && sites.length === 0) {
    return c.json({ error: 'bad_request', message: '文件里没有可导入的内容' }, 400)
  }

  const t = Date.now()
  let categoryCount = 0
  let siteCount = 0

  sql.tx(() => {
    if (mode === 'replace') {
      sql.run('DELETE FROM sites')
      sql.run('DELETE FROM categories')
    }

    // 旧 id → 新 id 映射，保证 sites 能正确挂到对应分组
    const idMap = new Map<number, number>()
    categories.forEach((cat, index) => {
      const name = typeof cat.name === 'string' ? cat.name.trim().slice(0, 60) : ''
      if (!name) return
      const { lastInsertRowid } = sql.run(
        'INSERT INTO categories (name, icon, sort_order, created_at) VALUES (?, ?, ?, ?)',
        name,
        typeof cat.icon === 'string' ? cat.icon.slice(0, 40) : null,
        Number.isFinite(Number(cat.sort_order)) ? Number(cat.sort_order) : index,
        t,
      )
      const oldId = Number(cat.id)
      if (Number.isFinite(oldId)) idMap.set(oldId, Number(lastInsertRowid))
      categoryCount += 1
    })

    sites.forEach((site, index) => {
      const title = typeof site.title === 'string' ? site.title.trim().slice(0, 80) : ''
      if (!title) return
      const rawUrl =
        (typeof site.url_public === 'string' && site.url_public) ||
        (typeof site.url === 'string' && site.url) ||
        (typeof site.url_lan === 'string' && site.url_lan) ||
        ''
      let url: string | null = null
      try {
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
        const u = new URL(withScheme)
        if (u.protocol === 'http:' || u.protocol === 'https:') url = u.toString()
      } catch {
        url = null
      }
      if (!url) return

      const oldCat = Number(site.category_id)
      sql.run(
        `INSERT INTO sites (category_id, title, description, url_public, url_lan, lan_port,
                            link_mode, icon_url, icon_text, color, source, sort_order,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        idMap.get(oldCat) ?? null,
        title,
        typeof site.description === 'string' ? site.description.slice(0, 200) : null,
        url,
        null,
        null,
        'auto',
        typeof site.icon_url === 'string' ? site.icon_url.slice(0, 1000) : null,
        typeof site.icon_text === 'string' ? site.icon_text.slice(0, 4) : null,
        typeof site.color === 'string' ? site.color.slice(0, 20) : null,
        typeof site.source === 'string' ? site.source.slice(0, 20) : 'import',
        Number.isFinite(Number(site.sort_order)) ? Number(site.sort_order) : index,
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

  return c.json({ ok: true, mode, categories: categoryCount, sites: siteCount })
})
