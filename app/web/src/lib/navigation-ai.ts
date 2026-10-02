import { api } from './api.ts'
import type { Category, Folder, Site } from './types.ts'

export const NAVIGATION_AI_MAX_SITES = 300
export const NAVIGATION_AI_EXAMPLES = [
  { label: '按用途分类', prompt: '按工作、开发、学习、娱乐等用途分类，常用服务放前面，同类较多的图标整理到文件夹。' },
  { label: '精简桌面', prompt: '减少首页分组数量，将相关服务整理到名称清晰的文件夹，重要入口放在每组前面。' },
  { label: '保留习惯', prompt: '尽量保留现有分组和文件夹，只调整明显错放的图标，并按用途排列相关入口。' },
] as const
export type NavigationAiFolder = { folder_id: number | null; name: string; site_ids: number[] }
export type NavigationAiGroup = { category_id: number | null; name: string; site_ids: number[]; folders: NavigationAiFolder[] }
export type NavigationAiPreview = { preview_token: string; expires_at: number; summary: string; model: string; groups: NavigationAiGroup[]; sites: Site[] }
export type NavigationAiSnapshot = { sites: Site[]; categories: Category[]; folders: Folder[] }
export type NavigationAiApplied = NavigationAiSnapshot & { ok: true; undo_token: string; undo_expires_at: number }

const ROOT = '/api/navigation/ai'
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
export const navigationAi = {
  preview: (prompt = '', signal?: AbortSignal): Promise<NavigationAiPreview> =>
    requestWithDeadline(`${ROOT}/preview`, prompt.trim() ? { prompt: prompt.trim() } : {}, 65_000, 'AI 整理超时，请稍后重试', signal),
  apply: (previewToken: string, signal?: AbortSignal) => requestWithDeadline<NavigationAiApplied>(`${ROOT}/apply`, { preview_token: previewToken }, 25_000, '应用请求超时，结果尚未确认；请重试应用以确认结果', signal),
  undo: (undoToken: string, signal?: AbortSignal) => requestWithDeadline<NavigationAiSnapshot & { ok: true }>(`${ROOT}/undo`, { undo_token: undoToken }, 25_000, '撤销请求超时，结果尚未确认；请重试撤销以确认结果', signal),
}

async function requestWithDeadline<T>(path: string, body: unknown, timeoutMs: number, timeoutMessage: string, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs)
    try { return await api<T>(path, post(body), { signal: controller.signal }) }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

/** Click counters do not alter the layout and must not invalidate a reviewed plan. */
export function navigationLayoutFingerprint(snapshot: NavigationAiSnapshot): string {
  return JSON.stringify({
    sites: snapshot.sites.map(({ clicks: _clicks, ...site }) => ({ ...site, folder_id: site.folder_id ?? null })).sort((a, b) => a.id - b.id),
    categories: [...snapshot.categories].sort((a, b) => a.id - b.id),
    folders: [...snapshot.folders].sort((a, b) => a.id - b.id),
  }, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value)
}

export function navigationPreviewCounts(preview: NavigationAiPreview) {
  return {
    groups: preview.groups.length,
    newGroups: preview.groups.filter((group) => group.category_id === null).length,
    folders: preview.groups.reduce((count, group) => count + group.folders.length, 0),
    newFolders: preview.groups.reduce((count, group) => count + group.folders.filter((folder) => folder.folder_id === null).length, 0),
    sites: preview.groups.reduce((count, group) => count + group.site_ids.length + group.folders.reduce((total, folder) => total + folder.site_ids.length, 0), 0),
  }
}

export function navigationPreviewIncludesEverySite(preview: NavigationAiPreview, sites: Site[]): boolean {
  const ids = preview.groups.flatMap((group) => [...group.site_ids, ...group.folders.flatMap((folder) => folder.site_ids)])
  const uniqueIds = new Set(ids)
  return ids.length === sites.length && uniqueIds.size === ids.length && sites.every((site) => uniqueIds.has(site.id))
}

export function navigationTokenRemaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
