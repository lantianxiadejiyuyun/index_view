/**
 * 笔记模块路由（Markdown 文件存储，不进数据库）。
 *
 * 契约（前端依赖，勿改）：
 *
 *   GET    /api/notes/tree                  → { tree: TreeNode[], root: string }
 *   GET    /api/notes/file?path=a/b.md      → { path, content, mtime, size }
 *   PUT    /api/notes/file?path=a/b.md      body { content, base_mtime? }
 *                                           → { ok, mtime, conflict?, disk_content? }
 *   POST   /api/notes/file                  body { path, content? } → { ok, path }
 *   POST   /api/notes/dir                   body { path } → { ok, path }
 *   POST   /api/notes/move                  body { from, to } → { ok, path }
 *   DELETE /api/notes/file?path=a/b.md      → { ok }
 *   GET    /api/notes/search?q=xxx          → { results: [{path,title,snippet,mtime}] }
 *
 *   TreeNode = { name: string; path: string; type: 'file'|'dir'; mtime?: number;
 *                size?: number; children?: TreeNode[] }
 *
 * 这一层只做三件事：把请求参数翻译成合法入参、调用 lib/notes-fs 的落地实现、
 * 把结果翻译成契约里的响应体。所有路径校验都在 resolveSafePath 里，
 * 路由里绝不允许出现「自己拼路径再交给 fs」的写法。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { NOTES_DIR } from '../config.js'
import { readJson } from '../lib/body.js'
import {
  isMarkdown,
  listTree,
  mtimeMs,
  readDiskContent,
  readNoteFile,
  resolveSafePath,
  searchNotes,
  statOrNull,
  toRelPath,
} from '../lib/notes-fs.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export const noteRoutes = new Hono<AppEnv>()

type PutBody = { content?: unknown; base_mtime?: unknown }
type CreateBody = { path?: unknown; content?: unknown }
type MoveBody = { from?: unknown; to?: unknown }

const NOT_MD: { error: string; message: string } = {
  error: 'bad_request',
  message: '只支持 .md / .markdown 文件',
}

/**
 * 路径校验的唯一出口：不合法（穿越、绝对路径、符号链接逃逸……）返回 null，
 * 由调用方统一翻成契约要求的 400 文案。
 */
function safePath(raw: unknown): string | null {
  try {
    return resolveSafePath(raw)
  } catch {
    return null
  }
}

function badPath(c: Context<AppEnv>) {
  return c.json({ error: 'bad_request', message: '路径不合法' }, 400)
}

/**
 * 可预期的文件系统冲突（把目录当文件写之类）翻成 400；
 * 其余（磁盘满、权限、磁盘掉线）交给 app.onError 报 500，别把真实故障藏起来。
 */
function fsFailure(c: Context<AppEnv>, err: unknown, message: string) {
  const code = (err as NodeJS.ErrnoException).code ?? ''
  if (['ENOTDIR', 'EISDIR', 'EINVAL', 'EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(code)) {
    return c.json({ error: 'bad_request', message }, 400)
  }
  throw err
}

/** base_mtime 只认正数：0 / null / 字符串都当成「没带」，即强制覆盖 */
function baseMtimeOf(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return null
  return Math.trunc(input)
}

// ── 目录树 ────────────────────────────────────────────────────

noteRoutes.get('/notes/tree', requireAuth, (c) => {
  // NOTES_DIR 不存在时 listTree 返回空数组，不报 500（笔记目录可能还没建/网盘没挂载）
  return c.json({ tree: listTree(), root: NOTES_DIR })
})

// ── 读 / 写单个文件 ───────────────────────────────────────────

noteRoutes.get('/notes/file', requireAuth, (c) => {
  const abs = safePath(c.req.query('path'))
  if (!abs) return badPath(c)
  // 只读 md：万一有人往笔记目录里丢了 .env / id_rsa，也不能通过这个接口读出去
  if (!isMarkdown(path.basename(abs))) return c.json(NOT_MD, 400)

  const file = readNoteFile(abs)
  if (!file) return c.json({ error: 'not_found', message: '笔记不存在' }, 404)

  return c.json({ path: file.path, content: file.content, mtime: file.mtime, size: file.size })
})

noteRoutes.put('/notes/file', requireAuth, async (c) => {
  const body = await readJson<PutBody>(c)
  const abs = safePath(c.req.query('path'))
  if (!abs) return badPath(c)
  if (!isMarkdown(path.basename(abs))) return c.json(NOT_MD, 400)
  if (typeof body.content !== 'string') {
    return c.json({ error: 'bad_request', message: 'content 必须是字符串' }, 400)
  }
  const content = body.content

  const before = statOrNull(abs)
  if (before && !before.isFile()) {
    return c.json({ error: 'bad_request', message: '目标是一个目录，不能写入' }, 400)
  }

  const baseMtime = baseMtimeOf(body.base_mtime)
  if (baseMtime !== null) {
    const diskMtime = before ? mtimeMs(before) : null
    // 笔记目录可能放在网盘同步盘里，也可能同时开着 Typora / Obsidian，
    // 静默覆盖会直接吃掉别人的改动，所以这里退化成 409 让前端去问用户
    if (diskMtime === null || diskMtime !== baseMtime) {
      return c.json(
        {
          ok: false,
          conflict: true,
          error: 'conflict',
          message: diskMtime === null ? '文件已被外部删除' : '文件已被外部修改',
          path: toRelPath(abs),
          mtime: diskMtime ?? 0,
          disk_content: before ? readDiskContent(abs) : '',
        },
        409,
      )
    }
  }

  try {
    // 新建时前端可能只传 a/b/c.md，父目录顺手补上
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  } catch (err) {
    return fsFailure(c, err, '写入失败：路径不可用')
  }

  const after = statOrNull(abs)
  return c.json({ ok: true, path: toRelPath(abs), mtime: after ? mtimeMs(after) : Date.now() })
})

// ── 新建 ──────────────────────────────────────────────────────

noteRoutes.post('/notes/file', requireAuth, async (c) => {
  const body = await readJson<CreateBody>(c)
  const abs = safePath(body.path)
  if (!abs) return badPath(c)
  if (!isMarkdown(path.basename(abs))) return c.json(NOT_MD, 400)

  // 先查一次给出友好提示，再用 wx 独占创建兜住并发（网盘同步/双击重名）
  if (fs.existsSync(abs)) {
    return c.json({ error: 'conflict', message: '同名文件已存在' }, 409)
  }

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, typeof body.content === 'string' ? body.content : '', {
      encoding: 'utf8',
      flag: 'wx',
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return c.json({ error: 'conflict', message: '同名文件已存在' }, 409)
    }
    return fsFailure(c, err, '新建失败：路径不可用')
  }

  return c.json({ ok: true, path: toRelPath(abs) })
})

noteRoutes.post('/notes/dir', requireAuth, async (c) => {
  const body = await readJson<CreateBody>(c)
  const abs = safePath(body.path)
  if (!abs) return badPath(c)

  const existing = statOrNull(abs)
  if (existing && !existing.isDirectory()) {
    return c.json({ error: 'conflict', message: '同名文件已存在' }, 409)
  }
  // 目录已存在视为成功：前端「新建文件夹」重名时不该弹错误
  try {
    fs.mkdirSync(abs, { recursive: true })
  } catch (err) {
    return fsFailure(c, err, '新建目录失败：路径不可用')
  }
  return c.json({ ok: true, path: toRelPath(abs) })
})

// ── 移动 / 重命名 ─────────────────────────────────────────────

noteRoutes.post('/notes/move', requireAuth, async (c) => {
  const body = await readJson<MoveBody>(c)
  const from = safePath(body.from)
  const to = safePath(body.to)
  if (!from || !to) return badPath(c)

  const source = statOrNull(from)
  if (!source) return c.json({ error: 'not_found', message: '源路径不存在' }, 404)

  // Windows 上 path.relative 不区分大小写，所以「只改大小写」的重命名也会算同一路径；
  // 这种要比对原字符串，否则会被下面的 existsSync 误判成「目标已存在」而拒绝
  const samePath = path.relative(from, to) === ''
  if (samePath && from === to) return c.json({ ok: true, path: toRelPath(to) })

  if (!samePath) {
    if (fs.existsSync(to)) return c.json({ error: 'conflict', message: '目标已存在' }, 409)
    // 目录搬进自己的子树会让 rename 直接把目录弄丢，必须拦住
    const down = path.relative(from, to)
    const intoSelf = down !== '' && !path.isAbsolute(down) && down !== '..' && !down.startsWith(`..${path.sep}`)
    if (source.isDirectory() && intoSelf) {
      return c.json({ error: 'bad_request', message: '不能把目录移动到自身内部' }, 400)
    }
  }
  // 文件名只允许 md（目录名前端可以随便起，带不带扩展名都行）
  if (source.isFile() && !isMarkdown(path.basename(to))) return c.json(NOT_MD, 400)

  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  } catch (err) {
    return fsFailure(c, err, '移动失败：目标路径不可用')
  }

  return c.json({ ok: true, path: toRelPath(to) })
})

// ── 删除 ──────────────────────────────────────────────────────

noteRoutes.delete('/notes/file', requireAuth, (c) => {
  const abs = safePath(c.req.query('path'))
  if (!abs) return badPath(c)

  const st = statOrNull(abs)
  // 已经不在了也算删除成功，前端可以放心重试
  if (!st) return c.json({ ok: true })

  try {
    if (st.isDirectory()) {
      // 递归删除代价大，但路径已经在 resolveSafePath 里确认过落在 NOTES_DIR 内
      fs.rmSync(abs, { recursive: true, force: true })
    } else {
      if (!isMarkdown(path.basename(abs))) return c.json(NOT_MD, 400)
      fs.rmSync(abs, { force: true })
    }
  } catch (err) {
    return fsFailure(c, err, '删除失败：路径不可用')
  }
  return c.json({ ok: true })
})

// ── 全文搜索 ──────────────────────────────────────────────────

noteRoutes.get('/notes/search', requireAuth, (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 200)
  // 空查询返回空结果而不是 400：前端输入框清空时会走到这里，弹错很烦
  if (q === '') return c.json({ results: [] })
  return c.json({ results: searchNotes(q) })
})
