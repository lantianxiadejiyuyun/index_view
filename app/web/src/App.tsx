import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'
import { onSessionExpired } from './lib/api.ts'
import { GLASS_PRESETS, GAP_PRESETS, activeWallpaper } from './lib/settings.ts'
import { derivedUrl } from './lib/wallpapers.ts'
import { computeScrims } from './lib/visual.ts'
import { DEVICE_THEME_KEY, isThemePref } from './lib/device-theme.ts'
import { useTheme } from './lib/useTheme.ts'
import { useWallpaperTone } from './lib/useWallpaperTone.ts'
import { useApp } from './store/app.ts'
import { useLoading } from './store/loading.ts'
import { LoadingOverlay } from './components/LoadingOverlay.tsx'
import { PageErrorBoundary } from './components/PageErrorBoundary.tsx'
import { RequireAuth } from './components/RequireAuth.tsx'
import { Toaster } from './components/Toaster.tsx'
import { Wallpaper } from './components/Wallpaper.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'

// 首屏只加载导航和登录页；笔记编辑器等较大的功能在进入对应页面时再下载。
const NodesPage = lazy(() => import('./pages/NodesPage.tsx').then((m) => ({ default: m.NodesPage })))
const NotesPage = lazy(() => import('./pages/NotesPage.tsx').then((m) => ({ default: m.NotesPage })))
const PhotosPage = lazy(() => import('./pages/PhotosPage.tsx').then((m) => ({ default: m.PhotosPage })))
const ServersPage = lazy(() => import('./pages/ServersPage.tsx').then((m) => ({ default: m.ServersPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage })))
const SubscriptionsPage = lazy(() => import('./pages/SubscriptionsPage.tsx').then((m) => ({ default: m.SubscriptionsPage })))
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage.tsx').then((m) => ({ default: m.WorkbenchPage })))

/**
 * 把设置里的视觉参数写进 CSS 变量。
 *
 * 注意这里是**内联样式**，优先级高于 index.css 里 `.dark` 的声明，
 * 所以深浅色两套数值必须由这里按 isDark 显式算出来 ——
 * 指望 CSS 的 `.dark` 覆盖内联变量是不会生效的（曾经踩过这个坑）。
 * index.css 里保留同名的 `.dark` 块只是为了首帧（React 挂载前）不闪。
 */
function applyVisualVars(
  settings: ReturnType<typeof useApp.getState>['settings'],
  isDark: boolean,
): void {
  const glass = GLASS_PRESETS[settings.glass]
  const root = document.documentElement

  if (settings.glass === 'none') {
    // 关掉模糊时卡片必须接近不透明，否则文字压在壁纸上根本读不清
    root.style.setProperty('--glass-blur', '0px')
    root.style.setProperty('--glass-alpha', isDark ? '0.82' : '0.92')
    root.style.setProperty('--glass-border', isDark ? '0.14' : '0.08')
  } else {
    root.style.setProperty('--glass-blur', `${glass.blur}px`)
    // 深色下壁纸更抢眼，玻璃要更透一点才好看；
    // 浅色下反过来要更实 —— 半透明白压在浅灰背景上只会糊掉，
    // 卡片得接近纯白才能和背景拉开层次。
    root.style.setProperty('--glass-alpha', String(isDark ? glass.alpha - 0.14 : glass.alpha + 0.25))
    // 边框跟随 line-rgb：深色下是要亮色描边，浅色下是要暗色描边
    root.style.setProperty('--glass-border', isDark ? '0.14' : '0.08')
  }

  root.style.setProperty('--grid-gap', GAP_PRESETS[settings.grid_gap])
}

function applyThemeClass(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark)
}

/** 把算好的压暗强度写进 CSS 变量，由 Wallpaper 的压暗层消费 */
function applyScrims(scrims: { scrim: number }): void {
  document.documentElement.style.setProperty('--scrim', String(scrims.scrim))
}

/**
 * 壁纸之上文字的黑白由「压完色罩之后的实际背景明暗」决定，
 * 不能只看壁纸本身 —— 浅色壁纸在深色主题下会被压暗，那时就得用白字。
 */
function applyWallpaperTone(tone: 'light' | 'dark'): void {
  document.documentElement.dataset.wpTone = tone
}

/**
 * 只挑出算色罩需要的那几个字段，逻辑本体在 lib/visual.ts。
 * 壁纸是按主题分两套的，所以要先按当前明暗取对应那套。
 */
function wallpaperSpec(
  settings: ReturnType<typeof useApp.getState>['settings'],
  isDark: boolean,
) {
  const active = activeWallpaper(settings, isDark)
  // 判断壁纸明暗要真的读像素，而原图可能有七八 MB。
  // 采样走缩略图（几十 KB），结论几乎一样但快得多；读不到时 useWallpaperTone
  // 会自己退回原图。
  const sampleSrc =
    active.type === 'image' || active.type === 'url'
      ? (derivedUrl(active.value, 'thumb') ?? undefined)
      : undefined

  return {
    type: active.type,
    value: active.value,
    dim: settings.wallpaper_dim,
    sampleSrc,
  }
}

export default function App() {
  const status = useApp((s) => s.status)
  const errorMessage = useApp((s) => s.errorMessage)
  const settings = useApp((s) => s.settings)
  const bootstrap = useApp((s) => s.bootstrap)
  const user = useApp((s) => s.user)
  const loadingCount = useLoading((s) => s.count)
  const loadingText = useLoading((s) => s.text)

  const [booted, setBooted] = useState(false)
  // 主题解析成「实际是不是深色」后作为单一真相，CSS 变量与 class 都从它派生
  const isDark = useTheme(settings.theme)
  // 图片壁纸的真实明暗：采样得到，拿不到则为 null（退回跟随主题）
  const imgTone = useWallpaperTone(wallpaperSpec(settings, isDark))

  /**
   * 登录成功后回哪去：优先回「被守卫拦下来时想去的那个页面」。
   * 排除 /login 本身，否则登录完会原地打转。
   */
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  const loginRedirect = from && !from.startsWith('/login') ? from : '/'

  useEffect(() => {
    void bootstrap().finally(() => setBooted(true))
  }, [bootstrap])

  useEffect(() => {
    // 同一浏览器的标签页共享本地偏好，不向服务器写入。
    const sync = (event: StorageEvent) => {
      if (event.key !== DEVICE_THEME_KEY && event.key !== null) return
      if (event.storageArea !== window.localStorage) return
      const value = event.key === null ? null : event.newValue
      useApp.getState().setTheme(isThemePref(value) ? value : 'auto', false)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    applyThemeClass(isDark)
  }, [isDark])

  useEffect(() => {
    applyVisualVars(settings, isDark)
    // 色罩强度与壁纸文字的黑白都取决于「主题 vs 壁纸明暗」，两者变化都要重算。
    // 图片壁纸的明暗是采样出来的（异步），imgTone 到货后这个 effect 会再跑一次。
    const scrims = computeScrims(wallpaperSpec(settings, isDark), isDark, imgTone)
    applyScrims(scrims)
    applyWallpaperTone(scrims.effectiveTone)
  }, [settings, isDark, imgTone])

  // 会话彻底失效时（refresh 也过期了）同步一下状态
  useEffect(() => {
    return onSessionExpired(() => {
      const state = useApp.getState()
      if (state.user) {
        void state.bootstrap()
      }
    })
  }, [])

  return (
    <>
      <Wallpaper />

      {!booted && status === 'loading' ? (
        <LoadingOverlay open text="正在加载…" hint="第一次打开会慢一点" />
      ) : status === 'error' ? (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center text-wp">
          <TriangleAlert className="size-8 text-warn" aria-hidden />
          <h1 className="text-lg font-semibold">加载失败</h1>
          <p className="max-w-md text-sm text-wp/70">{errorMessage}</p>
          <button
            type="button"
            onClick={() => void bootstrap()}
            className="rounded-xl bg-line/15 px-4 py-2 text-sm transition hover:bg-line/25"
          >
            重试
          </button>
        </div>
      ) : (
        <PageErrorBoundary key={location.pathname}>
          <Suspense fallback={<LoadingOverlay open text="正在加载页面…" />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              {/* 已登录就别停在登录页了。带 state 来的一律先回原目标 */}
              <Route
                path="/login"
                element={user ? <Navigate to={loginRedirect} replace /> : <LoginPage />}
              />
              {/* 受保护页面统一由 RequireAuth 挡：没登录连页面组件都不挂载，
                  所以它们的取数 effect 也不会跑，不会出现「先空转再跳走」 */}
              <Route
                path="/workbench"
                element={
                  <RequireAuth>
                    <WorkbenchPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/notes"
                element={
                  <RequireAuth>
                    <NotesPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/photos"
                element={
                  <RequireAuth>
                    <PhotosPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/services"
                element={
                  <RequireAuth>
                    <NodesPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/servers"
                element={
                  <RequireAuth>
                    <ServersPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/settings"
                element={
                  <RequireAuth>
                    <SettingsPage />
                  </RequireAuth>
                }
              />
              <Route path="/subscriptions" element={<RequireAuth><SubscriptionsPage /></RequireAuth>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </PageErrorBoundary>
      )}

      {/* 全局遮罩：任何地方调 beginLoading()/withLoading() 都能唤起，
          计数归零才消失，所以并发操作不会互相把遮罩提前关掉 */}
      <LoadingOverlay open={loadingCount > 0} text={loadingText} />

      <Toaster />
    </>
  )
}
