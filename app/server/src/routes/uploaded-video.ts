import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { UPLOAD_DIR } from '../config.js'
import type { AppEnv } from '../types.js'

export const uploadedVideoRoutes = new Hono<AppEnv>()

// Handle video ranges explicitly, including suffix and unsatisfiable ranges.
uploadedVideoRoutes.on(['GET', 'HEAD'], '/uploads/:name', async (c, next) => {
  const name = c.req.param('name')
  if (!/\.(mp4|webm)$/i.test(name)) return next()
  if (!/^[a-zA-Z0-9_-]+\.(mp4|webm)$/.test(name)) return c.json({ error: 'bad_request' }, 400)
  const file = path.join(UPLOAD_DIR, name)
  const stat = await fs.promises.stat(file).catch(() => null)
  if (!stat?.isFile()) return c.json({ error: 'not_found' }, 404)
  c.header('Content-Type', name.endsWith('.webm') ? 'video/webm' : 'video/mp4')
  c.header('Accept-Ranges', 'bytes')
  c.header('Cache-Control', 'public, max-age=604800')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Last-Modified', stat.mtime.toUTCString())
  if (c.req.method === 'HEAD') {
    c.header('Content-Length', String(stat.size))
    return c.body(null)
  }
  let start = 0
  let end = stat.size - 1
  const range = c.req.header('Range')
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, stat.size - Number(match[2]))
      else {
        start = Number(match[1])
        if (match[2]) end = Math.min(end, Number(match[2]))
      }
    } else start = Number.NaN
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
      c.header('Content-Range', `bytes */${stat.size}`)
      return c.body(null, 416)
    }
    c.header('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  }
  c.header('Content-Length', String(end - start + 1))
  return c.body(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, range ? 206 : 200)
})
