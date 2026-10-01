/**
 * 笔记路径的小工具。
 *
 * 笔记路径一律是「相对 NOTES_DIR 的 POSIX 风格路径」：`/` 分隔、无前导斜杠
 * （见 app/server/src/lib/notes-fs.ts resolveSafePath）。这里只做前端侧的规范化，
 * 真正的安全校验在后端，前端这些函数是为了让用户少看到 400。
 */

/** 取文件名（路径最后一段） */
export function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/**
 * 取父目录路径。
 *
 * 笔记里的「根目录」就是空串（路径都是相对 NOTES_DIR 的），
 * 所以 `a.md` 的父目录是 `''`，`a/b.md` 的父目录是 `a`。
 */
export function parentOf(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

/** 列出从根到该条目父目录的所有祖先，用来展开目录树 */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  parts.pop()
  const result: string[] = []
  let current = ''
  for (const part of parts) {
    if (!part) continue
    current = current === '' ? part : `${current}/${part}`
    result.push(current)
  }
  return result
}

/** 判断是不是笔记允许的扩展名（后端只收 .md / .markdown） */
export function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

/** 用户输入 `周会` 时补成 `周会.md`；已经是 md 就不动 */
export function ensureMarkdownExt(name: string): string {
  return isMarkdownName(name) ? name : `${name}.md`
}

export type NormalizeResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * 规范化用户手输的相对路径。
 *
 * 允许：中英文、空格、`a/b/c.md`、Windows 风格反斜杠（从资源管理器粘过来）。
 * 拒绝：空、`..`、绝对路径、盘符、`:`、控制字符 —— 这些后端也会拒，
 * 但先拦下来能给出「路径里不能有 ..」这种能看懂的提示。
 */
export function normalizeRelPath(input: string): NormalizeResult {
  const raw = input.trim().replace(/\\/g, '/')
  if (raw === '') return { ok: false, error: '路径不能为空' }
  // NUL / 换行等控制字符会让 fs 调用直接报错，先拦下来
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: '路径里有非法字符' }
  if (raw.includes(':')) return { ok: false, error: '路径里不能有冒号' }

  const segments: string[] = []
  for (const segment of raw.split('/')) {
    const part = segment.trim()
    if (part === '' || part === '.') continue
    if (part === '..') return { ok: false, error: '路径里不能出现 ..' }
    segments.push(part)
  }
  if (segments.length === 0) return { ok: false, error: '路径不能为空' }
  return { ok: true, path: segments.join('/') }
}

/** 把毫秒时间戳格式化成列表里用的短格式 */
export function formatTime(ms: number | undefined): string {
  if (!ms || ms <= 0) return ''
  const date = new Date(ms)
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return sameYear ? `${md} ${hm}` : `${date.getFullYear()}-${md}`
}
