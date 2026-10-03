import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Loader2, RefreshCw } from 'lucide-react'
import { useApp } from '../../store/app.ts'
import { errorMessage } from '../../lib/api.ts'
import { lingxi } from '../../lib/lingxi.ts'
import './lingxi.css'

export type LingxiWidgetProps = { className?: string; compact?: boolean }
export const LINGXI_CHANGED = 'navigation:lingxi-changed'
const TimezoneContext = createContext('UTC')
export const useLingxiTimezone = () => useContext(TimezoneContext)
export function notifyLingxiChanged() { window.dispatchEvent(new Event(LINGXI_CHANGED)) }

export function useLingxiResource<T>(loader: (signal: AbortSignal) => Promise<T>, dependencies: readonly unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const ref = useRef(loader)
  ref.current = loader
  const reload = useCallback(() => setVersion(value => value + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    ref.current(controller.signal).then(value => {
      if (!controller.signal.aborted) setData(value)
    }).catch(err => {
      if (!controller.signal.aborted) setError(errorMessage(err))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
    // The caller supplies stable primitive request inputs, and loader always uses the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...dependencies])
  useEffect(() => {
    window.addEventListener(LINGXI_CHANGED, reload)
    const visible = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', visible)
    return () => { window.removeEventListener(LINGXI_CHANGED, reload); document.removeEventListener('visibilitychange', visible) }
  }, [reload])
  return { data, setData, error, loading, reload }
}

function Connected({ children }: { children: ReactNode }) {
  const settings = useLingxiResource(signal => lingxi.settings(signal))
  if (settings.loading && !settings.data) return <WidgetLoading />
  if (settings.error) return <WidgetError message={settings.error} onRetry={settings.reload} />
  if (!settings.data?.configured) return <div className="lingxi-empty"><p>连接灵犀，让日程和对话留在首页。</p><Link className="lingxi-link" to="/settings/lingxi">连接灵犀 <ArrowUpRight size={13} /></Link></div>
  let timezone = settings.data.user?.timezone || 'UTC'
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { timezone = 'UTC' }
  return <TimezoneContext.Provider value={timezone}><Fragment key={`${settings.data.base_url}:${settings.data.user?.id}:${settings.data.updated_at}`}>{children}</Fragment></TimezoneContext.Provider>
}

export function LingxiAccess({ children }: { children: ReactNode }) {
  const user = useApp(state => state.user)
  if (!user) return <div className="lingxi-empty"><p>登录后查看你的私人日程与对话。</p><Link className="lingxi-link" to="/login">登录导航站 <ArrowUpRight size={13} /></Link></div>
  return <Connected key={user.id}>{children}</Connected>
}

export function WidgetLoading() { return <div className="lingxi-empty" role="status"><Loader2 className="animate-spin" size={18} /><span>正在读取灵犀…</span></div> }
export function WidgetError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="lingxi-error" role="alert"><p>{message}</p><button className="lingxi-link" type="button" onClick={onRetry}><RefreshCw size={13} />重新读取</button></div> }
export function WidgetFrame({ title, icon, actions, children, className = '', compact }: LingxiWidgetProps & { title: string; icon: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <section className={`lingxi-widget glass ${compact ? 'lingxi-compact' : ''} ${className}`} aria-label={title} onPointerDown={event => event.stopPropagation()}>
    <header className="lingxi-widget-header"><span className="lingxi-widget-heading">{icon}<span>{title}</span></span><div className="lingxi-widget-actions">{actions}</div></header>
    <div className="lingxi-widget-body">{children}</div>
  </section>
}

export function formatLingxiDate(value: string | null, options?: Intl.DateTimeFormatOptions, timezone?: string) {
  if (!value) return '未设置日期'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '日期无效'
  return date.toLocaleString('zh-CN', { ...(options ?? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), ...(timezone ? { timeZone: timezone } : {}) })
}
