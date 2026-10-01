/**
 * favicon 代理 + 磁盘缓存。
 *
 * 自部署导航页最常见的翻车点就是一片裂图，所以这里做三级降级：
 *   1. 直接取 <origin>/favicon.ico
 *   2. 抓首页 HTML，解析 <link rel="icon|shortcut icon|apple-touch-icon">
 *   3. 都没有 → 返回 404，前端用首字母彩色图标兜底
 * 失败结果也会短期缓存，避免每次打开首页都对同一个站发一串请求。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { DATA_DIR, ensureDirs } from '../config.js'

export const faviconRoutes = new Hono()

const CACHE_DIR = path.join(DATA_DIR, 'favicon-cache')
ensureDirs()
fs.mkdirSync(CACHE_DIR, { recursive: true })

const MIME_EXT: Record<string, string> = {
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
}

const OK_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 成功缓存 14 天
const MISS_TTL_MS = 6 * 60 * 60 * 1000 // 失败只记 6 小时，给站点留翻身机会
const MAX_ICON_BYTES = 600 * 1024

function cachePaths(key: string) {
  const hash = crypto.createHash('sha1').update(key).digest('hex')
  return {
    meta: path.join(CACHE_DIR, `${hash}.json`),
    bin: path.join(CACHE_DIR, `${hash}.bin`),
  }
}

type CacheMeta = { mime: string; at: number; miss?: boolean }

function readCache(key: string): { meta: CacheMeta; buf: Buffer } | null {
  const { meta: metaPath, bin } = cachePaths(key)
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as CacheMeta
    const ttl = meta.miss ? MISS_TTL_MS : OK_TTL_MS
    if (Date.now() - meta.at > ttl) return null
    if (meta.miss) return { meta, buf: Buffer.alloc(0) }
    const buf = fs.readFileSync(bin)
    if (buf.length === 0) return null
    return { meta, buf }
  } catch {
    return null
  }
}

function writeCache(key: string, mime: string, buf: Buffer, miss = false): void {
  const { meta: metaPath, bin } = cachePaths(key)
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ mime, at: Date.now(), miss } satisfies CacheMeta))
    if (!miss) fs.writeFileSync(bin, buf)
  } catch {
    /* 缓存写失败不影响本次响应 */
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'

async function get(url: string, accept: string, timeoutMs = 6000): Promise<Response | null> {
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, accept },
    })
  } catch {
    return null
  }
}

/** 只接受真正是图片的响应，防止把 HTML 错误页当图标缓存下来 */
async function asImage(res: Response | null): Promise<{ mime: string; buf: Buffer } | null> {
  if (!res || !res.ok) return null
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!MIME_EXT[mime]) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null
  return { mime, buf }
}

function resolveIconHref(raw: string, pageUrl: string): string | null {
  try {
    return new URL(raw, pageUrl).toString()
  } catch {
    return null
  }
}

/** 从 HTML 里按优先级挑一个图标地址 */
function pickIconFromHtml(html: string, pageUrl: string): string | null {
  const head = html.slice(0, 200_000)
  const linkTags = head.match(/<link\b[^>]*>/gi) ?? []

  type Candidate = { href: string; score: number }
  const candidates: Candidate[] = []

  for (const tag of linkTags) {
    const rel = /rel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    if (!rel.includes('icon')) continue
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (!href) continue
    const resolved = resolveIconHref(href, pageUrl)
    if (!resolved) continue

    let score = 10
    if (rel.includes('apple-touch-icon')) score = 30
    if (/\.svg(\?|$)/i.test(resolved)) score = 50 // svg 最清晰
    if (/\.png(\?|$)/i.test(resolved)) score = 40
    if (/\.ico(\?|$)/i.test(resolved)) score = 20
    const sizes = /sizes\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    const px = Number(/(\d+)x\d+/.exec(sizes)?.[1] ?? 0)
    if (px >= 32) score += 5

    candidates.push({ href: resolved, score })
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.href ?? null
}

function toOrigin(input: string): URL | null {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u
  } catch {
    return null
  }
}

async function resolveIcon(target: URL): Promise<{ mime: string; buf: Buffer } | null> {
  const origin = target.origin

  // 1) 约定俗成的 /favicon.ico
  const direct = await asImage(await get(`${origin}/favicon.ico`, 'image/*'))
  if (direct) return direct

  // 2) 抓当前页 HTML 找 <link rel="icon">。首页通常比 origin 根更准
  const pageUrl = target.pathname === '/' ? `${origin}/` : target.toString()
  const pageRes = await get(pageUrl, 'text/html,application/xhtml+xml')
  if (pageRes?.ok) {
    const ctype = pageRes.headers.get('content-type') ?? ''
    if (ctype.includes('html') || ctype === '') {
      const html = (await pageRes.text()).slice(0, 300_000)
      const href = pickIconFromHtml(html, pageRes.url || pageUrl)
      if (href) {
        const found = await asImage(await get(href, 'image/*'))
        if (found) return found
      }
    }
  }

  // 3) 苹果触摸图标，尺寸大，当兜底很合适
  const apple = await asImage(await get(`${origin}/apple-touch-icon.png`, 'image/*'))
  if (apple) return apple

  return null
}

faviconRoutes.get('/favicon', async (c) => {
  const raw = c.req.query('url') ?? c.req.query('domain') ?? ''
  if (!raw) return c.json({ error: 'bad_request', message: '缺少 url 参数' }, 400)

  const target = toOrigin(raw)
  if (!target) return c.json({ error: 'bad_request', message: 'url 不合法' }, 400)

  // 缓存键用 origin，同一站点的不同页面共用一份图标
  const key = target.origin
  const cached = readCache(key)
  if (cached) {
    if (cached.meta.miss) {
      return c.body(null, 404, { 'Cache-Control': 'public, max-age=3600' })
    }
    return c.body(cached.buf as unknown as ArrayBuffer, 200, {
      'Content-Type': cached.meta.mime,
      'Cache-Control': 'public, max-age=1209600, immutable',
    })
  }

  const icon = await resolveIcon(target)
  if (!icon) {
    writeCache(key, '', Buffer.alloc(0), true)
    return c.body(null, 404, { 'Cache-Control': 'public, max-age=3600' })
  }

  writeCache(key, icon.mime, icon.buf)
  return c.body(icon.buf as unknown as ArrayBuffer, 200, {
    'Content-Type': icon.mime,
    'Cache-Control': 'public, max-age=1209600, immutable',
  })
})
