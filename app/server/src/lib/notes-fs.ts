/**
 * 笔记模块的文件系统层。
 *
 * 笔记刻意不进数据库：目录里的 .md 文件就是唯一真相，所以这个文件要承担
 * 两件比 CRUD 更要紧的事：
 *
 *   1. **路径约束**。所有来自前端的路径必须先过 `resolveSafePath`，
 *      它是唯一的入口，绝不允许调用方自己拼绝对路径再交给 fs。
 *   2. **遍历定量**。笔记目录可能被指向网盘同步盘（PLAN §5），里面塞一个
 *      几百 MB 的日志或几万个文件都能把单线程的 Node 拖死，所以
 *      tree / search 都有明确的规模上限。
 *
 * 为什么不用「realpath 之后比前缀」这一招做唯一判据：新建、移动的目标文件
 * 还不存在，realpath 会直接失败。所以这里用双保险——
 *   a) 拼接出的绝对路径必须在 NOTES_DIR 内（拦 ../ 与绝对路径）；
 *   b) 该路径「最近已存在的祖先」realpath 之后仍必须在根内（拦符号链接/junction 逃逸）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { NOTES_DIR, ensureDirs } from '../config.js'

// 目录可能被手动删掉，启动时补一次；NOTES_DIR 本身不可建就让服务起不来，属于配置错误
ensureDirs()

/** 笔记根目录的绝对路径，对外暴露的 `root` 就是它 */
export const NOTES_ROOT: string = path.resolve(NOTES_DIR)

/** 只有这两种扩展名算笔记；其余文件在树里静默忽略 */
const MARKDOWN_EXT = new Set(['.md', '.markdown'])

/** 搜索时最多读多少个 md 文件，超出部分不再遍历，避免超大目录把服务卡死 */
const MAX_SEARCH_FILES = 2000
/** 单个文件超过这个大小就不读进内存（按 UTF-8 估），避免巨型文件拖垮进程 */
const MAX_SEARCH_BYTES = 2 * 1024 * 1024
/** 片段命中位置前后各留多少字符 */
const SNIPPET_PAD = 40

// ── 路径安全 ──────────────────────────────────────────────────

/** 路径不合法统一用它表示，路由层翻译成 400 */
export class BadPathError extends Error {
  constructor(message = '路径不合法') {
    super(message)
    this.name = 'BadPathError'
  }
}

/**
 * 已经百分号编码的分隔符 / 父目录引用一律拒绝。
 *
 * 正常前端只会传普通相对路径，出现 `%2f` 要么是 URL 编码没解开，
 * 要么是故意双重编码想绕过 normalize，两种都不该放行。
 * 注意不要在这里做 decodeURIComponent：名字里带裸 `%` 的笔记会被误判。
 */
const ENCODED_TRICK = /%(2f|5c|2e|00)/i
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/**
 * `:` 既用来拼盘符（C:），也能拼 NTFS 数据流（note.md:secret），
 * 还会让 `file:///C:/...` 这类伪协议看起来像相对路径，一律拒绝。
 */
const COLON = /:/

/** NOTES_DIR 可能是网盘里的 junction/符号链接，比较时要用它的真实路径 */
function realRoot(): string {
  try {
    return fs.realpathSync.native(NOTES_ROOT)
  } catch {
    return NOTES_ROOT
  }
}

/** 判断 child 是否落在 root 之内（不依赖大小写敏感的字符串前缀） */
function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * 把「相对 NOTES_DIR 的 POSIX 路径」解析成绝对路径，并保证它真的在 NOTES_DIR 内。
 *
 * 拦截：`../` 穿越、前导 `/` 的绝对路径、Windows 盘符与 UNC、NTFS 数据流、
 * NUL/控制字符、编码过的分隔符、以及符号链接/junction 逃逸。任何一条不满足都抛 BadPathError。
 */
export function resolveSafePath(relPath: unknown): string {
  if (typeof relPath !== 'string') throw new BadPathError()

  // Windows 上从资源管理器复制出来的路径是反斜杠，统一成正斜杠再判断，
  // 否则 `..\..\x` 会被当成一个普通文件名而漏掉
  const raw = relPath.trim().replace(/\\/g, '/')
  if (raw === '') throw new BadPathError()
  if (CONTROL_CHARS.test(raw)) throw new BadPathError()
  if (ENCODED_TRICK.test(raw)) throw new BadPathError()

  // 绝对路径、盘符、UNC、家目录缩写、NTFS 数据流：本模块只接受普通相对路径
  if (raw.startsWith('/')) throw new BadPathError()
  if (/^[a-zA-Z]:/.test(raw)) throw new BadPathError()
  if (raw.startsWith('~')) throw new BadPathError()
  if (COLON.test(raw)) throw new BadPathError()

  const normalized = path.posix.normalize(raw)
  // normalize 之后仍带 .. 的说明它想往上走；纯 . 或 .. 则指向根目录本身，也不允许
  if (normalized === '.' || normalized === '..') throw new BadPathError()
  if (normalized.startsWith('../') || normalized.includes('/../')) throw new BadPathError()
  if (path.posix.isAbsolute(normalized)) throw new BadPathError()

  const abs = path.resolve(NOTES_ROOT, normalized)
  if (!isInside(NOTES_ROOT, abs)) throw new BadPathError()
  // 第二道闸：解析出根目录本身（例如 path=.）也拒绝，避免误删/覆盖整个笔记库
  if (path.relative(NOTES_ROOT, abs) === '') throw new BadPathError()

  assertNoSymlinkEscape(abs)
  return abs
}

/**
 * 符号链接逃逸检查。
 *
 * 目标可能还不存在（新建 / 移动），所以从目标往上找到第一个存在的祖先，
 * 把它 realpath 之后再和根的真实路径比一次。中间任何一层是通往根外的
 * 符号链接/junction，都会在这里被拦下。
 */
function assertNoSymlinkEscape(abs: string): void {
  let probe = abs
  for (;;) {
    if (fs.existsSync(probe)) break
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }

  let real: string
  try {
    real = fs.realpathSync.native(probe)
  } catch {
    // 连 realpath 都读不到，说明这个位置本来就访问不了，让后续 fs 调用去报错
    return
  }
  if (!isInside(realRoot(), real)) throw new BadPathError()
}

/** 绝对路径 → 前端用的 POSIX 相对路径 */
export function toRelPath(abs: string): string {
  return path.relative(NOTES_ROOT, abs).split(path.sep).join('/')
}

// ── 通用工具 ──────────────────────────────────────────────────

export type TreeNode = {
  name: string
  path: string
  type: 'file' | 'dir'
  mtime?: number
  size?: number
  children?: TreeNode[]
}

export type NoteFile = { path: string; content: string; mtime: number; size: number }

export type SearchHit = { path: string; title: string; snippet: string; mtime: number }

/** 只认 .md / .markdown（大小写不敏感，Windows 上 .MD 也很常见） */
export function isMarkdown(name: string): boolean {
  return MARKDOWN_EXT.has(path.extname(name).toLowerCase())
}

/** 统一成毫秒整数：客户端会把这个值原样回传，小数误差会变成莫名其妙的假冲突 */
export function mtimeMs(st: fs.Stats): number {
  return Math.trunc(st.mtimeMs)
}

/** stat 失败（不存在 / 权限 / 同步盘占位文件读不到）一律当「没有」，由调用方决定语义 */
export function statOrNull(abs: string): fs.Stats | null {
  try {
    return fs.statSync(abs)
  } catch {
    return null
  }
}

/** 读文件失败不抛错，交给调用方降级（冲突响应里的 disk_content 就靠它兜底） */
function readTextOrNull(abs: string): string | null {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * 标题规则（tree 与 search 共用）：首个一级标题优先，没有就用文件名去掉扩展名。
 * 先剥 BOM，否则开头的 `#` 会因为前面多了个不可见字符而匹配不上。
 */
export function noteTitle(content: string, fileName: string): string {
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(content.replace(/^\uFEFF/, ''))?.[1]?.trim()
  if (heading) return heading
  return path.basename(fileName, path.extname(fileName))
}

/**
 * 读一个笔记文件。
 *
 * 先 stat 再 read：万一在两次系统调用之间被外部编辑器改了，我们返回的是
 * **较旧的 mtime**，用户拿它保存时必然触发冲突提示——宁可多报一次冲突，
 * 也不能少报一次（少报就等于静默吃掉别人的改动）。
 */
export function readNoteFile(abs: string): NoteFile | null {
  const st = statOrNull(abs)
  if (!st || !st.isFile()) return null
  const content = readTextOrNull(abs)
  if (content === null) return null
  return { path: toRelPath(abs), content, mtime: mtimeMs(st), size: st.size }
}

/** 冲突响应里要回传磁盘上的当前内容，读不到就给空串 */
export function readDiskContent(abs: string): string {
  return readTextOrNull(abs) ?? ''
}

// ── 目录树 ────────────────────────────────────────────────────

/**
 * 列出整棵笔记树。
 *
 * 以 `.` 开头的条目一律不列：`.git` / `.obsidian` / `.trash` 既不是笔记，
 * 又可能有几万条，列出来只会让前端渲染变卡。
 * 符号链接也不列，理由同 resolveSafePath：它既可能是逃逸通道也会造成遍历环。
 */
export function listTree(): TreeNode[] {
  return readDir(NOTES_ROOT, '')
}

function readDir(absDir: string, relDir: string): TreeNode[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    // 目录不存在 / 同步盘没挂载 / 权限不足：退化成空目录，绝不因此返回 500
    return []
  }

  const dirs: TreeNode[] = []
  const files: TreeNode[] = []

  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.') || entry.isSymbolicLink()) continue

    const rel = relDir === '' ? name : `${relDir}/${name}`
    const abs = path.join(absDir, name)

    if (entry.isDirectory()) {
      const st = statOrNull(abs)
      const node: TreeNode = { name, path: rel, type: 'dir', children: readDir(abs, rel) }
      if (st) node.mtime = mtimeMs(st)
      dirs.push(node)
    } else if (entry.isFile() && isMarkdown(name)) {
      const st = statOrNull(abs)
      const node: TreeNode = { name, path: rel, type: 'file' }
      if (st) {
        node.mtime = mtimeMs(st)
        node.size = st.size
      }
      files.push(node)
    }
    // 其余（png、txt、子模块……）静默忽略，不报错也不占位
  }

  // 目录在前、文件在后；数字感知排序让 `2.md` 排在 `10.md` 前面
  const byName = (a: TreeNode, b: TreeNode): number =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })

  dirs.sort(byName)
  files.sort(byName)
  return [...dirs, ...files]
}

// ── 全文搜索 ──────────────────────────────────────────────────

/**
 * 大小写不敏感的子串全文搜索，每个文件最多一条结果，按 mtime 倒序。
 * 命中片段最多前后各 40 字符，命中词用 ** 包起来（前端用 marked 渲染就是加粗）。
 */
export function searchNotes(query: string): SearchHit[] {
  // 用正则而不是 toLowerCase().indexOf()：大小写折叠会让个别字符（如 İ）长度变化，
  // 那样算出来的下标和原文对不上，截出来的片段就会错位
  const pattern = new RegExp(escapeRegExp(query), 'i')
  const hits: SearchHit[] = []
  let scanned = 0

  // 用显式栈做深度优先：递归在超深目录下会爆栈，而且中途 break 更麻烦
  const stack: Array<{ abs: string; rel: string }> = [{ abs: NOTES_ROOT, rel: '' }]

  while (stack.length > 0 && scanned < MAX_SEARCH_FILES) {
    const current = stack.pop()
    if (!current) break

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (scanned >= MAX_SEARCH_FILES) break

      const name = entry.name
      if (name.startsWith('.') || entry.isSymbolicLink()) continue

      const rel = current.rel === '' ? name : `${current.rel}/${name}`
      const abs = path.join(current.abs, name)

      if (entry.isDirectory()) {
        stack.push({ abs, rel })
        continue
      }
      if (!entry.isFile() || !isMarkdown(name)) continue

      scanned += 1
      const st = statOrNull(abs)
      if (!st || st.size > MAX_SEARCH_BYTES) continue

      const content = readTextOrNull(abs)
      if (content === null) continue

      const found = pattern.exec(content)
      if (!found) continue

      hits.push({
        path: rel,
        title: noteTitle(content, name),
        snippet: makeSnippet(content, found.index, found[0].length),
        mtime: mtimeMs(st),
      })
    }
  }

  hits.sort((a, b) => b.mtime - a.mtime)
  return hits
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 截一小段上下文；顺手把换行压成空格，前端一行就能显示完 */
function makeSnippet(content: string, index: number, length: number): string {
  // 别把代理对（emoji 等）从中间切开：JSON 序列化一个孤立代理项虽然合法，
  // 但前端会显示成乱码方块。start 不能落在低位代理上，end 前一位不能是高位代理
  let start = Math.max(0, index - SNIPPET_PAD)
  if (isLowSurrogate(content.charCodeAt(start))) start += 1
  let end = Math.min(content.length, index + length + SNIPPET_PAD)
  if (isHighSurrogate(content.charCodeAt(end - 1))) end -= 1

  const clean = (s: string): string => s.replace(/\s+/g, ' ')
  const before = clean(content.slice(start, index))
  const hit = clean(content.slice(index, index + length))
  const after = clean(content.slice(index + length, end))

  return `${start > 0 ? '…' : ''}${before}**${hit}**${after}${end < content.length ? '…' : ''}`
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
