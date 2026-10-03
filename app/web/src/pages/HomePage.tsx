import { lazy, Suspense } from 'react'
import { Navigate } from 'react-router-dom'
import { Minimize2 } from 'lucide-react'
import { SearchBar } from '../components/SearchBar.tsx'
import { useApp } from '../store/app.ts'
import { useMinimal } from '../store/minimal.ts'

const HomeCanvas = lazy(() => import('./DesktopPage.tsx').then(m => ({ default: m.DesktopPage })))

export function HomePage({ navigationOnly = false }: { navigationOnly?: boolean }) {
  const needsLogin = useApp(s => s.needsLogin)
  const homeMode = useApp(s => s.settings.home_mode)
  const minimal = useMinimal(s => s.minimal)
  const setMinimal = useMinimal(s => s.setMinimal)
  if (needsLogin) return <Navigate to="/login" replace />
  if (!navigationOnly && homeMode === 'desktop') return <Navigate to="/desktop" replace />
  // Minimal mode does not mount the canvas or any widgets that fetch data.
  if (minimal) return <div className="flex min-h-dvh flex-col items-center justify-center px-4">
    <div className="w-full max-w-xl animate-rise"><SearchBar /></div>
    <button type="button" onClick={() => setMinimal(false)} className="glass glass-pop fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl px-4 py-2.5 text-xs font-medium text-fg/75 transition hover:text-fg"><Minimize2 className="size-3.5" aria-hidden />退出极简模式</button>
  </div>
  return <Suspense fallback={<div role="status" className="p-8 text-center text-sm text-fg/60">正在加载首页…</div>}><HomeCanvas mode="home" /></Suspense>
}
