import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ensureDirs, UPLOAD_DIR } from '../config.js'
import { sql } from '../lib/db.js'
import { detectVideoFormat } from '../lib/video-wallpaper.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export const uploadRoutes = new Hono<AppEnv>()

ensureDirs()

/**
 * 派生图（缩略图 / 中等图）单独放一个子目录，免得把 uploads 根目录塞满 ——
 * 用户可能会自己去翻这个目录。
 *
 * ⚠️ 这些图是**浏览器端**缩好的：服务端不做图片处理，那需要 sharp 这种原生依赖，
 * 会把「零依赖单文件、镜像里不带 node_modules」的设计破坏掉。
 * 用 API 直传过来的图没有派生图，前端会回退到原图。
 */
const DERIVED_DIR = path.join(UPLOAD_DIR, 'derived')
fs.mkdirSync(DERIVED_DIR, { recursive: true })

/** 派生图允许的格式：只收浏览器编得出来、且确实比原图小的两种 */
const DERIVED_EXT: Record<string, string> = {
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
}

/**
 * 单文件大小上限。手机拍的照片常见 3–8MB，所以默认给到 20MB；
 * 想要更紧可以用环境变量收紧。
 */
const MAX_MB = (() => {
  const n = Number(process.env.MAX_UPLOAD_MB)
  return Number.isFinite(n) && n > 0 ? n : 20
})()
const MAX_BYTES = MAX_MB * 1024 * 1024
const MAX_VIDEO_MB = (() => {
  const n = Number(process.env.MAX_VIDEO_UPLOAD_MB)
  return Number.isFinite(n) && n > 0 ? n : 100
})()
const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024

/** 一次最多收多少个文件，防止一次拖进来几百张把内存打满 */
const MAX_FILES = 40

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/avif': '.avif',
  // 苹果设备的默认拍照格式。**原样存下来**（无损保留），
  // 能不能显示交给派生图：Safari 能直接解 HEIC，Chrome 不能，
  // 前端会相应地把「原图」也换成派生图，所以两边都不会看到破图。
  'image/heic': '.heic',
  'image/heif': '.heif',
  // 有些浏览器/系统给的是这两个别名
  'image/heic-sequence': '.heic',
  'image/heif-sequence': '.heif',
}

function safeName(ext: string): string {
  const stamp = Date.now().toString(36)
  const rand = crypto.randomBytes(6).toString('hex')
  return `${stamp}-${rand}${ext}`
}

type Stored = {
  id: number
  url: string
  filename: string
  original_name: string | null
  size: number
  mime: string
  /** 缩略图地址；没生成时为 null，前端回退到原图 */
  thumb_url: string | null
  /** 中等图地址 */
  large_url: string | null
}

/**
 * 落一张派生图。返回它的文件名；格式不认识或写入失败都返回 null ——
 * 派生图是优化，不是必需品，绝不能因为它失败就让整次上传失败。
 */
async function writeDerived(
  prefix: string,
  kind: 'thumb' | 'large',
  file: File | undefined,
): Promise<string | null> {
  if (!file || file.size === 0) return null
  const ext = DERIVED_EXT[(file.type || '').toLowerCase()]
  if (!ext) return null

  const name = `${prefix}.${kind}${ext}`
  try {
    fs.writeFileSync(path.join(DERIVED_DIR, name), Buffer.from(await file.arrayBuffer()))
    return name
  } catch {
    return null
  }
}

/**
 * 上传图片。支持一次传多个：字段名都叫 file，重复出现即可
 * （照片墙一次拖一堆就是这个用法）。单文件时响应里仍然平铺
 * url / filename 等字段，老调用方不用改。
 */
uploadRoutes.post('/upload', requireAuth, async (c) => {
  // 注意：这里必须用 c.req.formData() 而不是 c.req.parseBody()。
  // parseBody 把表单转成普通对象，**重复的同名键只会保留最后一个**（实测过），
  // 一次拖多张图时前面的会被静默丢掉；而 FormData.getAll 能拿到全部。
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'bad_request', message: '表单解析失败' }, 400)
  }

  const raw = [...form.getAll('file'), ...form.getAll('files')]
  const incoming = raw.filter((f): f is File => f instanceof File)

  // 派生图和原图按**顺序配对**：客户端第 N 张原图对应第 N 张缩略图。
  // 之所以按序号而不是文件名配对，是因为原图在落盘前还没有名字。
  // 客户端要么两张都传、要么都不传，所以不会错位。
  const thumbs = form.getAll('thumb').filter((f): f is File => f instanceof File)
  const larges = form.getAll('large').filter((f): f is File => f instanceof File)

  if (incoming.length === 0) {
    return c.json({ error: 'bad_request', message: '没有收到文件（字段名应为 file）' }, 400)
  }
  if (incoming.length > MAX_FILES) {
    return c.json(
      { error: 'too_many', message: `一次最多上传 ${MAX_FILES} 个文件，请分批` },
      413,
    )
  }

  const stored: Stored[] = []
  const failed: Array<{ name: string; message: string }> = []

  for (const [index, file] of incoming.entries()) {
    const label = file.name || '未命名'

    if (file.size === 0) {
      failed.push({ name: label, message: '文件是空的' })
      continue
    }
    if (file.size > MAX_BYTES) {
      failed.push({ name: label, message: `超过 ${MAX_MB}MB 限制` })
      continue
    }

    const mime = (file.type || '').toLowerCase()
    const ext = EXT_BY_MIME[mime]
    if (!ext) {
      failed.push({ name: label, message: `不支持的格式：${mime || '未知'}` })
      continue
    }

    const filename = safeName(ext)
    const buf = Buffer.from(await file.arrayBuffer())
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf)

    // 派生图用原图的随机名前缀，方便删除时按前缀一起清掉
    const prefix = filename.replace(/\.[^.]+$/, '')
    const thumbName = await writeDerived(prefix, 'thumb', thumbs[index])
    const largeName = await writeDerived(prefix, 'large', larges[index])

    // 磁盘上用生成的随机名（避免重名和路径问题），
    // 但把用户原来的文件名留着，照片墙上要显示它而不是一串哈希
    const originalName = (file.name || '').slice(0, 200) || null

    const { lastInsertRowid } = sql.run(
      `INSERT INTO uploads (filename, original_name, mime, size, created_at, thumb, large)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      filename,
      originalName,
      mime,
      buf.length,
      Date.now(),
      thumbName,
      largeName,
    )

    stored.push({
      id: Number(lastInsertRowid),
      url: `/uploads/${filename}`,
      filename,
      original_name: originalName,
      size: buf.length,
      mime,
      thumb_url: thumbName ? `/uploads/derived/${thumbName}` : null,
      large_url: largeName ? `/uploads/derived/${largeName}` : null,
    })
  }

  if (stored.length === 0) {
    return c.json(
      {
        error: 'unsupported_type',
        message: failed[0]?.message ?? '没有可用的文件',
        failed,
      },
      415,
    )
  }

  const first = stored[0]!
  // 平铺字段是给「只传一个文件」的老调用方（图标、壁纸）用的
  return c.json({ ...first, uploaded: stored, failed }, 201)
})

/** Separate from image uploads so their limits and browser-generated derivatives stay unchanged. */
uploadRoutes.post('/upload/video', requireAuth, bodyLimit({
  maxSize: MAX_VIDEO_BYTES + 64 * 1024,
  onError: (c) => c.json({ error: 'too_large', message: `视频超过 ${MAX_VIDEO_MB}MB 限制` }, 413),
}), async (c) => {
  let form: FormData
  try { form = await c.req.formData() } catch {
    return c.json({ error: 'bad_request', message: '表单解析失败' }, 400)
  }
  const incoming = [...form.values()].filter((value): value is File => value instanceof File)
  const file = form.get('file')
  if (!(file instanceof File) || incoming.length !== 1) {
    return c.json({ error: 'bad_request', message: '请一次上传一个视频（字段名应为 file）' }, 400)
  }
  if (!file.size) return c.json({ error: 'bad_request', message: '文件是空的' }, 400)
  if (file.size > MAX_VIDEO_BYTES) return c.json({ error: 'too_large', message: `视频超过 ${MAX_VIDEO_MB}MB 限制` }, 413)
  const buf = Buffer.from(await file.arrayBuffer())
  const format = detectVideoFormat(buf)
  if (!format || path.extname(file.name).toLowerCase() !== format.ext) {
    return c.json({ error: 'unsupported_type', message: '请上传有效的 MP4 或 WebM 视频，文件后缀需与实际格式一致' }, 415)
  }
  const filename = safeName(format.ext)
  const target = path.join(UPLOAD_DIR, filename)
  const originalName = file.name.slice(0, 200) || null
  let id: number
  let created = false
  try {
    const handle = await fs.promises.open(target, 'wx')
    created = true
    try { await handle.writeFile(buf) } finally { await handle.close() }
    id = Number(sql.run(
      'INSERT INTO uploads (filename, original_name, mime, size, created_at, thumb, large) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
      filename, originalName, format.mime, buf.length, Date.now(),
    ).lastInsertRowid)
  } catch (error) {
    if (created) await fs.promises.rm(target, { force: true }).catch(() => {})
    throw error
  }
  const stored: Stored = { id, url: `/uploads/${filename}`, filename, original_name: originalName, size: buf.length, mime: format.mime, thumb_url: null, large_url: null }
  return c.json({ ...stored, uploaded: [stored], failed: [] }, 201)
})

/**
 * 给**已经传上去的**图补派生图。
 *
 * 派生图是浏览器端生成的，所以老数据（这个功能上线前传的，或用 API 直传的）
 * 没有缩略图，会一直拿原图 —— 恰恰是最该优化的那几张。
 * 这个接口收浏览器现算出来的派生图，补到已有记录上。
 */
uploadRoutes.post('/uploads/:filename/derived', requireAuth, async (c) => {
  const filename = path.basename(c.req.param('filename'))
  const row = sql.get<{ id: number }>('SELECT id FROM uploads WHERE filename = ?', filename)
  if (!row) return c.json({ error: 'not_found', message: '没有这张图' }, 404)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'bad_request', message: '表单解析失败' }, 400)
  }

  const prefix = filename.replace(/\.[^.]+$/, '')
  const thumbName = await writeDerived(prefix, 'thumb', firstFile(form.get('thumb')))
  const largeName = await writeDerived(prefix, 'large', firstFile(form.get('large')))

  // 只覆盖传上来的那一项，另一项保持原样
  if (thumbName) sql.run('UPDATE uploads SET thumb = ? WHERE id = ?', thumbName, row.id)
  if (largeName) sql.run('UPDATE uploads SET large = ? WHERE id = ?', largeName, row.id)

  const updated = sql.get<{ thumb: string | null; large: string | null }>(
    'SELECT thumb, large FROM uploads WHERE id = ?',
    row.id,
  )

  return c.json({
    filename,
    thumb_url: updated?.thumb ? `/uploads/derived/${updated.thumb}` : null,
    large_url: updated?.large ? `/uploads/derived/${updated.large}` : null,
  })
})

function firstFile(v: unknown): File | undefined {
  return v instanceof File && v.size > 0 ? v : undefined
}

/** 照片墙用：分页列出已上传的图片 */
uploadRoutes.get('/uploads', requireAuth, (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 120))
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)

  const type = c.req.query('type')
  const filter = type === 'all' ? '' : type === 'video' ? " WHERE mime LIKE 'video/%'" : " WHERE mime LIKE 'image/%'"
  const total = sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM uploads' + filter)?.n ?? 0
  const rows = sql.all<{
    id: number
    filename: string
    original_name: string | null
    mime: string
    size: number
    created_at: number
    thumb: string | null
    large: string | null
  }>(
    `SELECT id, filename, original_name, mime, size, created_at, thumb, large
     FROM uploads${filter} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    limit,
    offset,
  )

  // 派生图地址由服务端拼好再给前端 —— 前端不该知道磁盘布局长什么样
  const uploads = rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    original_name: r.original_name,
    mime: r.mime,
    size: r.size,
    created_at: r.created_at,
    thumb_url: r.thumb ? `/uploads/derived/${r.thumb}` : null,
    large_url: r.large ? `/uploads/derived/${r.large}` : null,
  }))

  return c.json({ uploads, total, limit, offset })
})

/**
 * 删掉一张图的原图 + 它的派生图。
 * 派生图用同一个随机名前缀，扫一遍前缀匹配即可 —— 不必再查一次库。
 */
function removeFiles(filename: string): void {
  const target = path.join(UPLOAD_DIR, filename)
  try {
    fs.rmSync(target, { force: true })
  } catch {
    /* 文件不存在也算删除成功 */
  }

  const prefix = filename.replace(/\.[^.]+$/, '') + '.'
  try {
    for (const entry of fs.readdirSync(DERIVED_DIR)) {
      if (entry.startsWith(prefix)) fs.rmSync(path.join(DERIVED_DIR, entry), { force: true })
    }
  } catch {
    /* 派生图目录读不到就算了，不该因此让删除失败 */
  }
}

uploadRoutes.delete('/uploads/:filename', requireAuth, (c) => {
  const filename = path.basename(c.req.param('filename'))
  const target = path.join(UPLOAD_DIR, filename)

  // 双保险：basename 之后仍确认最终路径没跑出上传目录
  if (!target.startsWith(UPLOAD_DIR + path.sep)) {
    return c.json({ error: 'bad_request' }, 400)
  }

  removeFiles(filename)
  sql.run('DELETE FROM uploads WHERE filename = ?', filename)
  return c.json({ ok: true })
})

/** 批量删除，照片墙上一次清理多张时用 */
uploadRoutes.post('/uploads/delete', requireAuth, async (c) => {
  const body = await c.req.json<{ filenames?: unknown }>().catch(() => ({ filenames: [] }))
  const names = Array.isArray(body.filenames)
    ? body.filenames.filter((n): n is string => typeof n === 'string')
    : []
  if (names.length === 0) return c.json({ ok: true, deleted: 0 })

  let deleted = 0
  for (const raw of names.slice(0, 200)) {
    const filename = path.basename(raw)
    const target = path.join(UPLOAD_DIR, filename)
    if (!target.startsWith(UPLOAD_DIR + path.sep)) continue
    removeFiles(filename)
    const res = sql.run('DELETE FROM uploads WHERE filename = ?', filename)
    deleted += res.changes
  }

  return c.json({ ok: true, deleted })
})
