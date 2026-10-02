/**
 * 全局应用状态。
 *
 * 刻意保持「服务端是唯一真相」：所有写操作都先打接口，成功后再用返回值更新本地，
 * 主题偏好只保存在当前浏览器；拖拽排序使用乐观更新以保证操作手感。
 */
import { create } from 'zustand'
import { ApiError, api, errorMessage, jsonBody, refreshSession, setAccessToken } from '../lib/api.ts'
import { clearLinkCache, prewarmLinks } from '../lib/link.ts'
import { currentNetMode, type NetMode } from '../lib/net.ts'
import { normalizeSettings, type AppSettings, type ThemePref } from '../lib/settings.ts'
import { deviceTheme, isThemePref } from '../lib/device-theme.ts'
import type { Bootstrap, Category, Folder, SessionUser, Site } from '../lib/types.ts'

type Status = 'loading' | 'ready' | 'error'

/**
 * 「刷新页面后用 refresh cookie 把登录态捞回来」这个动作只做一次。
 * 反复做的话，匿名访客每次 bootstrap 都会多打两个请求，
 * 而且 refresh 失败时还可能形成循环。
 */
let silentRestoreTried = false

export type SiteInput = {
  title: string
  category_id: number | null
  folder_id?: number | null
  description?: string | null
  url_public?: string | null
  url_lan?: string | null
  lan_port?: number | null
  link_mode?: string
  icon_url?: string | null
  icon_text?: string | null
  color?: string | null
}

export type FolderInput = {
  name: string
  category_id: number | null
  columns?: number
  rows?: number
  color?: string | null
  site_ids?: number[]
}

export type ReorderItem = {
  id: number
  category_id: number | null
  sort_order: number
}

type AppState = {
  status: Status
  errorMessage: string | null
  /** 未登录且站点不允许匿名浏览 —— 需要展示登录页 */
  needsLogin: boolean

  user: SessionUser | null
  canEdit: boolean
  settings: AppSettings
  rawSettings: Record<string, string>
  categories: Category[]
  folders: Folder[]
  sites: Site[]

  editMode: boolean
  netMode: NetMode

  bootstrap: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  setEditMode: (value: boolean) => void
  setTheme: (value: ThemePref, persist?: boolean) => void
  saveSettings: (patch: Record<string, string | number | boolean>) => Promise<void>

  createCategory: (name: string, icon?: string | null) => Promise<Category>
  updateCategory: (id: number, patch: { name?: string; icon?: string | null }) => Promise<void>
  deleteCategory: (id: number, mode: 'detach' | 'delete') => Promise<void>
  reorderCategories: (ids: number[]) => Promise<void>

  createFolder: (input: FolderInput) => Promise<void>
  updateFolder: (id: number, patch: Partial<FolderInput>) => Promise<void>
  deleteFolder: (id: number) => Promise<void>

  createSite: (input: SiteInput) => Promise<Site>
  updateSite: (id: number, patch: Partial<SiteInput>) => Promise<void>
  deleteSite: (id: number) => Promise<void>
  reorderSites: (items: ReorderItem[]) => Promise<void>
  registerClick: (id: number) => void

  /** 探针同步后需要整体刷新一次 */
  reload: () => Promise<void>
}

export const useApp = create<AppState>()((set, get) => ({
  status: 'loading',
  errorMessage: null,
  needsLogin: false,

  user: null,
  canEdit: false,
  settings: { ...normalizeSettings(undefined), theme: deviceTheme.current() ?? 'auto' },
  rawSettings: {},
  categories: [],
  folders: [],
  sites: [],

  editMode: false,
  netMode: currentNetMode(),

  async bootstrap() {
    set({ status: 'loading', errorMessage: null })
    try {
      let data = await api<Bootstrap>('/api/bootstrap')

      // access token 只存在内存里，刷新页面就没了；而 /api/bootstrap 允许匿名访问，
      // 所以它不会返回 401，也就不会触发客户端的静默刷新。
      // 不主动试一次的话，已登录用户刷新后会看到「登录」按钮，误以为掉线了。
      if (!data.user && !silentRestoreTried) {
        silentRestoreTried = true
        if (await refreshSession()) {
          data = await api<Bootstrap>('/api/bootstrap', {}, { retry: false })
        }
      }
      if (data.user) silentRestoreTried = true

      const settings = normalizeSettings(data.settings)
      settings.theme = deviceTheme.initialize(data.settings.theme)
      set({
        status: 'ready',
        needsLogin: false,
        user: data.user,
        canEdit: data.can_edit,
        rawSettings: data.settings,
        settings,
        categories: data.categories,
        folders: data.folders ?? [],
        sites: data.sites,
        editMode: false,
        netMode: currentNetMode(),
      })
      clearLinkCache()
      prewarmLinks(data.sites, currentNetMode())
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // 不允许匿名浏览，或者会话彻底过期
        set({ status: 'ready', needsLogin: true, user: null, canEdit: false, categories: [], folders: [], sites: [], editMode: false })
        return
      }
      set({
        status: 'error',
        errorMessage: errorMessage(err, '加载失败'),
      })
    }
  },

  async reload() {
    await get().bootstrap()
  },

  async login(username, password) {
    const res = await api<{ access_token: string; user: SessionUser }>(
      '/api/auth/login',
      jsonBody({ username, password }),
      { retry: false },
    )
    setAccessToken(res.access_token)
    await get().bootstrap()
  },

  async logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' }, { retry: false })
    } catch {
      /* 登出失败也要把本地状态清干净 */
    }
    setAccessToken(null)
    set({
      user: null,
      canEdit: false,
      editMode: false,
      categories: [],
      folders: [],
      sites: [],
    })
    await get().bootstrap()
  },

  setEditMode(value) {
    set({ editMode: value })
  },

  setTheme(value, persist = true) {
    if (!isThemePref(value)) return
    deviceTheme.set(value, persist)
    set((s) => ({ settings: { ...s.settings, theme: value } }))
  },

  async saveSettings(patch) {
    // 即便旧组件把主题和其它设置一起提交，也只能把其它设置同步到服务器。
    const { theme, ...sharedPatch } = patch
    if (isThemePref(theme)) get().setTheme(theme)
    if (Object.keys(sharedPatch).length === 0) return
    const res = await api<{ settings: Record<string, string> }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(sharedPatch),
    })
    set({
      rawSettings: res.settings,
      settings: { ...normalizeSettings(res.settings), theme: deviceTheme.initialize(res.settings.theme) },
    })
    prewarmLinks(get().sites, get().netMode)
  },

  // ── 分组 ────────────────────────────────────────────────────

  async createCategory(name, icon) {
    const res = await api<{ category: Category }>(
      '/api/categories',
      jsonBody({ name, icon: icon ?? null }),
    )
    set((s) => ({ categories: [...s.categories, res.category] }))
    return res.category
  },

  async updateCategory(id, patch) {
    const res = await api<{ category: Category }>(`/api/categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    set((s) => ({
      categories: s.categories.map((c) => (c.id === id ? res.category : c)),
    }))
  },

  async deleteCategory(id, mode) {
    await api(`/api/categories/${id}?mode=${mode}`, { method: 'DELETE' })
    set((s) => ({
      categories: s.categories.filter((c) => c.id !== id),
      folders:
        mode === 'delete'
          ? s.folders.filter((folder) => folder.category_id !== id)
          : s.folders.map((folder) => (folder.category_id === id ? { ...folder, category_id: null } : folder)),
      // detach 模式下后端把图标置为「未分组」，本地也要跟着改
      sites:
        mode === 'delete'
          ? s.sites.filter((x) => x.category_id !== id)
          : s.sites.map((x) => (x.category_id === id ? { ...x, category_id: null } : x)),
    }))
  },

  async reorderCategories(ids) {
    const snapshot = get().categories
    // 乐观更新：拖拽必须跟手
    set({
      categories: ids
        .map((id, index) => {
          const found = snapshot.find((c) => c.id === id)
          return found ? { ...found, sort_order: index } : null
        })
        .filter((c): c is Category => c !== null),
    })

    try {
      await api('/api/categories/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ ids }),
      })
    } catch (err) {
      set({ categories: snapshot })
      throw err
    }
  },

  // ── 文件夹 ──────────────────────────────────────────────────

  async createFolder(input) {
    const res = await api<{ folder: Folder; sites: Site[] }>('/api/folders', jsonBody(input))
    set((s) => ({ folders: [...s.folders, res.folder], sites: res.sites }))
    prewarmLinks(res.sites, get().netMode)
  },

  async updateFolder(id, patch) {
    const res = await api<{ folder: Folder; sites: Site[] }>(`/api/folders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    set((s) => ({
      folders: s.folders.map((folder) => (folder.id === id ? res.folder : folder)),
      sites: res.sites,
    }))
    prewarmLinks(res.sites, get().netMode)
  },

  async deleteFolder(id) {
    const res = await api<{ sites: Site[] }>(`/api/folders/${id}`, { method: 'DELETE' })
    set((s) => ({ folders: s.folders.filter((folder) => folder.id !== id), sites: res.sites }))
    prewarmLinks(res.sites, get().netMode)
  },

  // ── 图标 ────────────────────────────────────────────────────

  async createSite(input) {
    const res = await api<{ site: Site }>('/api/sites', jsonBody(input))
    set((s) => ({ sites: [...s.sites, res.site] }))
    prewarmLinks([res.site], get().netMode)
    return res.site
  },

  async updateSite(id, patch) {
    const res = await api<{ site: Site }>(`/api/sites/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    set((s) => ({ sites: s.sites.map((x) => (x.id === id ? res.site : x)) }))
    prewarmLinks([res.site], get().netMode)
  },

  async deleteSite(id) {
    await api(`/api/sites/${id}`, { method: 'DELETE' })
    set((s) => ({ sites: s.sites.filter((x) => x.id !== id) }))
  },

  async reorderSites(items) {
    const snapshot = get().sites
    const byId = new Map(items.map((i) => [i.id, i]))

    set({
      sites: snapshot.map((site) => {
        const item = byId.get(site.id)
        if (!item) return site
        return { ...site, category_id: item.category_id, sort_order: item.sort_order }
      }),
    })

    try {
      await api('/api/sites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ items }),
      })
    } catch (err) {
      set({ sites: snapshot })
      throw err
    }
  },

  registerClick(id) {
    // 点击统计是纯锦上添花，失败不该打扰用户，所以不 await 也不报错
    void api(`/api/sites/${id}/click`, { method: 'POST' }, { retry: false }).catch(() => undefined)
    set((s) => ({
      sites: s.sites.map((x) => (x.id === id ? { ...x, clicks: x.clicks + 1 } : x)),
    }))
  },
}))
