/**
 * 笔记接口的薄封装。
 *
 * 这一层只做三件事：拼 URL、把 409 翻译成带类型的冲突对象、把错误统一成
 * 可以直接丢进 toast 的文案。所有请求都走 lib/api.ts 的 `api()`，
 * 这样 401 静默刷新、token 注入这些逻辑不会被绕过。
 *
 * 契约见 app/server/src/routes/notes.ts 文件头注释，字段名不许改。
 */
import { ApiError, api } from '../../lib/api.ts'
import type { NoteNode } from '../../lib/types.ts'

export type NoteTreeResponse = { tree: NoteNode[]; root: string }

export type NoteFileResponse = {
  path: string
  content: string
  mtime: number
  size: number
}

export type SearchHit = {
  path: string
  title: string
  /** 命中词被 `**` 包裹的纯文本片段 */
  snippet: string
  mtime: number
}

/** PUT 冲突时后端回传的全部信息 */
export type NoteConflict = {
  message: string
  path: string
  /** 磁盘上文件当前的 mtime；后端在「文件已被外部删除」时给 0 */
  mtime: number
  /** 磁盘上文件当前的内容 */
  diskContent: string
  /** 文件已不在磁盘上（被外部删除或重命名），此时 diskContent 一定是空串 */
  missing: boolean
}

export class NoteConflictError extends Error {
  info: NoteConflict

  constructor(info: NoteConflict) {
    super(info.message)
    this.name = 'NoteConflictError'
    this.info = info
  }
}

/**
 * 逐段编码，但保留 `/` 分隔符。
 *
 * 笔记名里出现空格、`#`、`&` 都很正常（「工作/周会 #3.md」），不编码会被
 * 查询串截断；而整体 encodeURIComponent 会把 `/` 变成 `%2F`，
 * 后端 notes-fs 的 ENCODED_TRICK 检查见到 `%2f` 就直接拒绝。
 */
function encodePath(relPath: string): string {
  return relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** 把任意异常翻成能直接展示的一句话 */
export function describeError(err: unknown, fallback = '操作失败'): string {
  if (err instanceof ApiError) return err.message || fallback
  if (err instanceof Error) return err.message || fallback
  return fallback
}

// ── 读 ────────────────────────────────────────────────────────

export async function fetchTree(signal?: AbortSignal): Promise<NoteTreeResponse> {
  return api<NoteTreeResponse>('/api/notes/tree', {}, { signal })
}

export async function readNoteFile(path: string, signal?: AbortSignal): Promise<NoteFileResponse> {
  return api<NoteFileResponse>(`/api/notes/file?path=${encodePath(path)}`, {}, { signal })
}

export async function searchNotes(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await api<{ results: SearchHit[] }>(
    `/api/notes/search?q=${encodeURIComponent(query)}`,
    {},
    { signal },
  )
  return res.results ?? []
}

// ── 写 ────────────────────────────────────────────────────────

/**
 * 保存文件。
 *
 * `baseMtime` 是「我读到的那一版」的毫秒时间戳，必须原样回传：
 * 后端拿它和磁盘比，不一致就返回 409 冲突（笔记目录可能在网盘同步盘里，
 * 也可能同时开着 Typora，静默覆盖等于吃掉别人的改动）。
 * 传 null 表示「我知道会覆盖，就是要强写」—— 只在用户确认过之后用。
 */
export async function saveNoteFile(
  path: string,
  content: string,
  baseMtime: number | null,
): Promise<{ mtime: number }> {
  const body: { content: string; base_mtime?: number } = { content }
  // 后端 baseMtimeOf 只认正数，0 / null 都当作「强制覆盖」
  if (typeof baseMtime === 'number' && baseMtime > 0) body.base_mtime = Math.trunc(baseMtime)

  try {
    const res = await api<{ ok: true; mtime: number; path: string }>(
      `/api/notes/file?path=${encodePath(path)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    )
    return { mtime: res.mtime }
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // ApiErrorBody 在 lib/types.ts 里只有 error/message，冲突字段是后端额外加的，
      // 所以这里按 unknown 逐字段挑，避免把类型放宽到 any
      const raw = err.body as unknown as Record<string, unknown>
      if (raw.conflict === true) {
        const mtime = typeof raw.mtime === 'number' ? raw.mtime : 0
        throw new NoteConflictError({
          message: typeof raw.message === 'string' ? raw.message : '文件已被外部修改',
          path: typeof raw.path === 'string' ? raw.path : path,
          mtime,
          diskContent: typeof raw.disk_content === 'string' ? raw.disk_content : '',
          // 后端在磁盘上已经没有这个文件时把 mtime 置 0（notes.ts: diskMtime ?? 0）
          missing: mtime <= 0,
        })
      }
    }
    throw err
  }
}

export async function createNoteFile(path: string, content: string): Promise<void> {
  await api('/api/notes/file', { method: 'POST', body: JSON.stringify({ path, content }) })
}

export async function createNoteDir(path: string): Promise<void> {
  await api('/api/notes/dir', { method: 'POST', body: JSON.stringify({ path }) })
}

export async function moveNote(from: string, to: string): Promise<void> {
  await api('/api/notes/move', { method: 'POST', body: JSON.stringify({ from, to }) })
}

/** 同一个接口同时删文件和目录（目录递归删除） */
export async function deleteNote(path: string): Promise<void> {
  await api(`/api/notes/file?path=${encodePath(path)}`, { method: 'DELETE' })
}
