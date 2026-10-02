import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, LogOut, MonitorSmartphone, RefreshCw, ShieldCheck } from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import { toast } from '../../store/toast.ts'
import { btnDanger, btnGhost } from '../Modal.tsx'
import { Note } from './controls.tsx'

type LoginSession = {
  id: string
  device: string
  ua: string | null
  ip: string | null
  created_at: number
  last_seen_at: number
  expires_at: number
  current: boolean
}

function SessionTime({ value }: { value: number }) {
  const date = new Date(value)
  if (!Number.isFinite(value) || value <= 0 || Number.isNaN(date.getTime())) return <>未知</>
  return <time dateTime={date.toISOString()}>{date.toLocaleString('zh-CN', { hour12: false })}</time>
}

/** A request owns both its mutation and the following refresh, so a stale list cannot restore a revoked device. */
export function LoginSessions() {
  const [sessions, setSessions] = useState<LoginSession[]>([])
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState<string | null>('load')
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const revision = useRef(0)
  const busy = useRef(false)
  const controller = useRef<AbortController | null>(null)

  const request = useCallback(async (target?: LoginSession | 'others') => {
    if (busy.current || !mounted.current) return
    busy.current = true
    const token = ++revision.current
    const abort = new AbortController()
    controller.current = abort
    const active = () => mounted.current && revision.current === token && !abort.signal.aborted
    setPending(target === 'others' ? 'others' : target ? `revoke:${target.id}` : 'load')
    setError(null)
    let revoked = false
    try {
      if (target === 'others') {
        const result = await api<{ ok: boolean; revoked: number }>(
          '/api/auth/sessions/revoke-others', { method: 'POST' }, { signal: abort.signal },
        )
        if (!active()) return
        revoked = true
        setSessions((items) => items.filter((item) => item.current))
        toast.success(result.revoked ? `已退出 ${result.revoked} 个其他登录设备` : '其他设备均已退出')
      } else if (target) {
        await api<{ ok: boolean; current: boolean }>(
          `/api/auth/sessions/${encodeURIComponent(target.id)}`, { method: 'DELETE' }, { signal: abort.signal },
        )
        if (!active()) return
        revoked = true
        setSessions((items) => items.filter((item) => item.id !== target.id))
        toast.success('该设备已退出登录')
      }
      const result = await api<{ sessions: LoginSession[] }>(
        '/api/auth/sessions', { cache: 'no-store' }, { signal: abort.signal },
      )
      if (!active()) return
      setSessions([...result.sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at - a.last_seen_at))
      setLoaded(true)
    } catch (err) {
      if (!active()) return
      const detail = errorMessage(err, target ? '退出设备失败' : '读取登录设备失败')
      setError(revoked ? `退出操作已完成，但列表刷新失败：${detail}` : detail)
    } finally {
      if (active()) {
        busy.current = false
        controller.current = null
        setPending(null)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void request()
    return () => {
      mounted.current = false
      revision.current += 1
      controller.current?.abort()
      controller.current = null
      busy.current = false
    }
  }, [request])

  function revoke(target: LoginSession | 'others') {
    if (busy.current || (target !== 'others' && target.current)) return
    const message = target === 'others'
      ? '确定退出所有其他设备吗？这些设备需要重新登录，当前设备会保持登录。'
      : `确定退出「${target.device || '未知设备'}」吗？该设备需要重新登录。`
    if (window.confirm(message)) void request(target)
  }

  const otherCount = sessions.filter((session) => !session.current).length
  return (
    <section className="space-y-3 rounded-xl border border-line/10 bg-line/5 p-3" aria-labelledby="login-sessions-heading" aria-busy={pending !== null}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 id="login-sessions-heading" className="flex items-center gap-1.5 text-xs font-medium text-fg/80">
            <MonitorSmartphone className="size-3.5" aria-hidden />
            登录设备{loaded && <span className="text-fg/45">（{sessions.length}）</span>}
          </h3>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg/50">同一账号支持多端同时登录。退出某台设备不会影响其他设备。</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" className={`${btnGhost} flex min-h-11 items-center justify-center gap-1.5`} disabled={pending !== null} onClick={() => void request()}>
            {pending === 'load' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
            刷新设备
          </button>
          <button type="button" className={`${btnDanger} flex min-h-11 items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50`} disabled={pending !== null || !otherCount} onClick={() => revoke('others')}>
            {pending === 'others' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <LogOut className="size-3.5" aria-hidden />}
            退出其他设备
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="space-y-2">
          <Note tone="danger">{error}</Note>
          <button type="button" className={`${btnGhost} min-h-11`} disabled={pending !== null} onClick={() => void request()}>重新读取设备</button>
        </div>
      )}
      {!loaded && pending === 'load' && <p role="status" className="flex items-center gap-2 text-xs text-fg/50"><Loader2 className="size-3.5 animate-spin" aria-hidden />正在读取登录设备…</p>}
      {loaded && !sessions.length && <p className="rounded-lg bg-line/5 p-3 text-xs text-fg/55">暂无有效登录设备，请刷新列表。</p>}
      {!!sessions.length && (
        <ul className="space-y-2">
          {sessions.map((session) => (
            <li key={session.id} className="rounded-xl border border-line/10 bg-line/5 p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-sm font-medium text-fg/85">{session.device || '未知设备'}</span>
                    {session.current && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-500/15 px-2 py-0.5 text-[11px] text-fg/80"><ShieldCheck className="size-3" aria-hidden />当前设备</span>}
                  </div>
                  <dl className="grid gap-x-5 gap-y-1.5 text-[11px] leading-relaxed sm:grid-cols-2">
                    <div className="min-w-0"><dt className="inline text-fg/45">登录时间：</dt><dd className="inline text-fg/70"><SessionTime value={session.created_at} /></dd></div>
                    <div className="min-w-0"><dt className="inline text-fg/45">最近活动：</dt><dd className="inline text-fg/70"><SessionTime value={session.last_seen_at} /></dd></div>
                    <div className="min-w-0"><dt className="inline text-fg/45">登录 IP：</dt><dd className="inline break-all font-mono text-fg/70">{session.ip || '未知'}</dd></div>
                    <div className="min-w-0"><dt className="inline text-fg/45">会话到期：</dt><dd className="inline text-fg/70"><SessionTime value={session.expires_at} /></dd></div>
                  </dl>
                  {session.ua && <details className="text-[11px] text-fg/45"><summary className="cursor-pointer py-1">浏览器详情</summary><p className="mt-1 break-all leading-relaxed">{session.ua}</p></details>}
                </div>
                {!session.current && (
                  <button type="button" className={`${btnGhost} flex min-h-11 shrink-0 items-center justify-center gap-1.5 text-danger`} disabled={pending !== null} onClick={() => revoke(session)} aria-label={`退出设备 ${session.device || '未知设备'}`}>
                    {pending === `revoke:${session.id}` ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <LogOut className="size-3.5" aria-hidden />}
                    退出设备
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] leading-relaxed text-fg/45">设备名称根据浏览器信息识别；同一台设备使用不同浏览器时会分别显示。最近活动时间可能稍有延迟。</p>
    </section>
  )
}
