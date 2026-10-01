import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Database, Layers, Loader2, Pause, Pencil, Play, Plus, RefreshCw, Rss, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react'
import { PageShell } from '../components/PageShell.tsx'
import { btnGhost, btnPrimary } from '../components/Modal.tsx'
import { ProfileEditor, SourceEditor } from '../components/subscriptions/Editors.tsx'
import { copySubscriptionText, OutputWarnings, SubscriptionPreview } from '../components/subscriptions/Preview.tsx'
import { errorMessage } from '../lib/api.ts'
import {
  OUTPUT_FORMATS, formatExpiry, formatNextRefresh, formatTimestamp, profileInput, relayTransportLabel, sourceInput, sourceFetchMethod, sourceFetchProgress, sourceRefreshFeedback,
  subscriptionFeedUrl, subscriptions, usageSummary,
  type ProfileInput, type SourceInput, type SubscriptionFormat, type SubscriptionProfile, type SubscriptionRelayNode, type SubscriptionSource,
} from '../lib/subscriptions.ts'
import { toast } from '../store/toast.ts'

const smallButton = `${btnGhost} inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs`
const iconButton = 'rounded-lg p-2 text-fg/55 transition hover:bg-line/10 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40'
const isAbort = (err: unknown) => err instanceof Error && err.name === 'AbortError'
function upsert<T extends { id: number }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id) ? items.map((item) => item.id === next.id ? next : item) : [...items, next]
}

function SourceCard({ source, relayNode, now, busy, refreshing, onEdit, onRefresh, onToggle, onRemove }: {
  source: SubscriptionSource
  relayNode?: SubscriptionRelayNode
  now: number
  busy: boolean
  refreshing: boolean
  onEdit: () => void
  onRefresh: () => void
  onToggle: () => void
  onRemove: () => void
}) {
  const usage = usageSummary(source.usage)
  const expiry = formatExpiry(source.usage?.expires_at, now)
  const progress = sourceFetchProgress(source)
  let host = source.url
  try { host = new URL(source.url).host } catch { /* 兼容尚未修复的旧记录。 */ }
  return (
    <article className="glass min-w-0 rounded-3xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><h3 className="break-words text-base font-semibold text-fg">{source.name}</h3><p className="mt-1 truncate text-xs text-fg/45">{host}</p></div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${source.enabled ? 'bg-success/10 text-success' : 'bg-line/10 text-fg/45'}`}>{source.enabled ? '定时拉取中' : '定时已暂停'}</span>
      </div>
      {source.note && <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg/60">{source.note}</p>}
      <p className="mt-3 break-words text-xs text-fg/55">拉取方式：{sourceFetchMethod(source)}</p>
      {relayNode && <p className="mt-1 break-words text-[11px] text-fg/50">订阅任务通道：{relayNode.capable ? relayTransportLabel(relayNode) : '需要升级探针'}</p>}
      {progress && <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-brand-500"><Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />{progress}</p>}
      <div className="mt-4 grid grid-cols-2 gap-3 rounded-2xl bg-line/5 p-3">
        <div><p className="text-[10px] text-fg/45">缓存节点</p><p className="mt-1 text-lg font-semibold tabular-nums text-fg">{source.last_success_at === null ? <span className="text-sm font-normal text-fg/50">尚无缓存</span> : <>{source.proxy_count}<span className="ml-1 text-xs font-normal text-fg/45">个</span></>}</p></div>
        <div><p className="text-[10px] text-fg/45">订阅到期</p><p className={`mt-1 break-words text-xs font-medium tabular-nums ${expiry.state === 'expired' ? 'text-danger' : expiry.state === 'missing' ? 'text-fg/45' : 'text-fg/85'}`}>{expiry.text}</p>{source.usage?.expires_at != null && source.usage.expires_at > 0 && <p className="mt-1 text-[10px] text-fg/45">{formatTimestamp(source.usage.expires_at)}</p>}</div>
      </div>
      <div className="mt-4">
        <div className="flex flex-wrap justify-between gap-1 text-xs"><span className="text-fg/60">已用 {usage.used}</span><span className={usage.exhausted ? 'text-danger' : 'text-fg/60'}>剩余 {usage.remaining}</span></div>
        {usage.ratio !== null && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line/10" role="progressbar" aria-label="流量使用比例" aria-valuenow={Math.round(usage.ratio * 100)} aria-valuemin={0} aria-valuemax={100}><div className={`h-full rounded-full ${usage.exhausted ? 'bg-danger' : 'bg-brand-500/75'}`} style={{ width: `${usage.ratio * 100}%` }} /></div>}
        <p className="mt-1.5 text-[10px] text-fg/45">总流量：{usage.total}{source.usage === null ? ' · 上游未提供用量信息' : ''}</p>
      </div>
      <dl className="mt-4 space-y-1.5 text-[11px]"><div className="flex justify-between gap-3"><dt className="shrink-0 text-fg/45">最近成功</dt><dd className="text-right text-fg/65">{formatTimestamp(source.last_success_at, '尚未成功拉取')}</dd></div><div className="flex justify-between gap-3"><dt className="shrink-0 text-fg/45">下次拉取</dt><dd className="text-right tabular-nums text-fg/65">{formatNextRefresh(source, now)}</dd></div><div className="flex justify-between gap-3"><dt className="shrink-0 text-fg/45">刷新间隔</dt><dd className="text-fg/65">每 {source.refresh_interval_minutes} 分钟</dd></div></dl>
      {source.last_error && <div className="mt-3 rounded-xl bg-danger/10 p-3 text-xs text-danger"><p className="font-medium">{progress ? '上次拉取失败，正在等待本次结果' : source.last_success_at === null ? '拉取失败，暂无可用缓存' : '拉取失败，继续使用上次成功的缓存'}</p><p className="mt-1 break-words leading-relaxed">{source.last_error}</p><p className="mt-1 opacity-70">最近尝试：{formatTimestamp(source.last_attempt_at)}</p></div>}
      {source.warnings.length > 0 && <div className="mt-3"><OutputWarnings warnings={source.warnings} /></div>}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line/10 pt-3">
        <button type="button" className={smallButton} disabled={busy || Boolean(progress)} onClick={onRefresh}>{refreshing || progress ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}{progress || (refreshing ? '正在提交…' : '立即拉取')}</button>
        <button type="button" className={smallButton} disabled={busy} onClick={onToggle}>{source.enabled ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}{source.enabled ? '暂停定时' : '开启定时'}</button>
        <div className="ml-auto flex"><button type="button" className={iconButton} disabled={busy} onClick={onEdit} aria-label={`编辑订阅源 ${source.name}`} title="编辑订阅源"><Pencil className="size-4" aria-hidden /></button><button type="button" className={`${iconButton} hover:text-danger`} disabled={busy} onClick={onRemove} aria-label={`删除订阅源 ${source.name}`} title="删除订阅源"><Trash2 className="size-4" aria-hidden /></button></div>
      </div>
    </article>
  )
}

function ProfileCard({ profile, sources, busy, onEdit, onPreview, onToggle, onRotate, onRemove, onCopy }: {
  profile: SubscriptionProfile
  sources: SubscriptionSource[]
  busy: boolean
  onEdit: () => void
  onPreview: () => void
  onToggle: () => void
  onRotate: () => void
  onRemove: () => void
  onCopy: (format: SubscriptionFormat) => void
}) {
  return (
    <article className="glass min-w-0 rounded-3xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words text-base font-semibold text-fg">{profile.name}</h3><p className="mt-1 text-xs text-fg/45">{profile.source_ids.length} 个订阅源 · {profile.rules.protocols.length ? `${profile.rules.protocols.length} 种协议` : '全部协议'}</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${profile.enabled ? 'bg-success/10 text-success' : 'bg-line/10 text-fg/45'}`}>{profile.enabled ? '分享已启用' : '分享已停用'}</span></div>
      {profile.note && <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg/60">{profile.note}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">{profile.source_ids.map((id) => <span key={id} className="max-w-full break-words rounded-lg bg-line/10 px-2 py-1 text-[11px] text-fg/65">{sources.find((source) => source.id === id)?.name ?? `已删除的源 #${id}`}</span>)}{profile.source_ids.length === 0 && <span className="text-xs text-warn">尚未选择订阅源，请编辑配置。</span>}</div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-fg/45"><span>包含 {profile.rules.include.length} 项</span><span>排除 {profile.rules.exclude.length} 项</span><span>{profile.rules.deduplicate ? '自动去重' : '保留重复节点'}</span>{profile.rules.prepend_source && <span>名称前置来源</span>}{profile.rules.append_source && <span>名称追加来源</span>}</div>
      <div className="mt-4 rounded-2xl bg-line/5 p-3"><p className="mb-2 text-xs font-medium text-fg/70">复制订阅链接</p><div className="flex flex-wrap gap-2">{OUTPUT_FORMATS.map((format) => <button key={format.value} type="button" className={smallButton} onClick={() => onCopy(format.value)} aria-label={`复制 ${profile.name} 的 ${format.label} 链接`}><Copy className="size-3" aria-hidden />{format.value === 'clash' ? 'Clash' : format.value === 'links' ? '通用链接' : 'Base64'}</button>)}</div><p className="mt-2 text-[10px] text-fg/45">重置分享链接后，旧链接立即失效。</p></div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line/10 pt-3"><button type="button" className={smallButton} disabled={busy} onClick={onPreview}>预览与下载</button><button type="button" className={smallButton} disabled={busy} onClick={onToggle}>{profile.enabled ? '停用分享' : '启用分享'}</button><button type="button" className={smallButton} disabled={busy} onClick={onRotate}><ShieldCheck className="size-3.5" aria-hidden />重置链接</button><div className="ml-auto flex"><button type="button" className={iconButton} disabled={busy} onClick={onEdit} aria-label={`编辑封装配置 ${profile.name}`} title="编辑配置"><Pencil className="size-4" aria-hidden /></button><button type="button" className={`${iconButton} hover:text-danger`} disabled={busy} onClick={onRemove} aria-label={`删除封装配置 ${profile.name}`} title="删除配置"><Trash2 className="size-4" aria-hidden /></button></div></div>
    </article>
  )
}

export function SubscriptionsPage() {
  const [sources, setSources] = useState<SubscriptionSource[]>([])
  const [profiles, setProfiles] = useState<SubscriptionProfile[]>([])
  const [relayNodes, setRelayNodes] = useState<SubscriptionRelayNode[]>([])
  const [tab, setTab] = useState<'sources' | 'profiles'>('sources')
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [sourceEditor, setSourceEditor] = useState<SubscriptionSource | null | undefined>(undefined)
  const [profileEditor, setProfileEditor] = useState<SubscriptionProfile | null | undefined>(undefined)
  const [previewId, setPreviewId] = useState<number | null>(null)
  const alive = useRef(true)
  const busyRef = useRef<string | null>(null)
  const snapshotRequest = useRef<AbortController | null>(null)
  const mutationRequest = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const clockOffset = useRef(0)

  const load = useCallback(async () => {
    if (!alive.current || busyRef.current || snapshotRequest.current) return
    const controller = new AbortController()
    snapshotRequest.current = controller
    const started = Date.now()
    const version = generation.current
    setChecking(true)
    try {
      const result = await subscriptions.list(controller.signal)
      if (!alive.current || controller.signal.aborted || version !== generation.current) return
      setSources(result.sources)
      setProfiles(result.profiles)
      setRelayNodes(result.relay_nodes ?? [])
      // 用请求往返的中点校正本机时钟，倒计时每秒只在前端计算。
      clockOffset.current = result.server_time - (started + Date.now()) / 2
      setNow(Date.now() + clockOffset.current)
      setError(null)
    } catch (err) {
      if (alive.current && !controller.signal.aborted && version === generation.current) setError(errorMessage(err, '读取订阅中心失败'))
    } finally {
      if (snapshotRequest.current === controller) {
        snapshotRequest.current = null
        if (alive.current) { setChecking(false); setLoading(false) }
      }
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const clockTimer = window.setInterval(() => { if (!document.hidden) setNow(Date.now() + clockOffset.current) }, 1000)
    const visible = () => { if (!document.hidden) { setNow(Date.now() + clockOffset.current); void load() } }
    document.addEventListener('visibilitychange', visible)
    return () => {
      alive.current = false
      snapshotRequest.current?.abort()
      snapshotRequest.current = null
      mutationRequest.current?.abort()
      window.clearInterval(clockTimer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [load])

  const hasPendingFetch = sources.some((source) => sourceFetchProgress(source) !== null)
  useEffect(() => {
    const statusTimer = window.setInterval(() => { if (!document.hidden) void load() }, hasPendingFetch ? 5000 : 30_000)
    return () => window.clearInterval(statusTimer)
  }, [load, hasPendingFetch])

  async function mutate<T>(key: string, task: (signal: AbortSignal) => Promise<T>, commit: (result: T) => void, success?: string): Promise<void> {
    if (busyRef.current) throw new Error('请等待当前操作完成')
    busyRef.current = key
    setBusy(key)
    generation.current += 1
    snapshotRequest.current?.abort()
    snapshotRequest.current = null
    setChecking(false)
    const controller = new AbortController()
    mutationRequest.current = controller
    try {
      const result = await task(controller.signal)
      if (controller.signal.aborted || !alive.current) return
      commit(result)
      if (success) toast.success(success)
    } finally {
      busyRef.current = null
      mutationRequest.current = null
      if (alive.current) { setBusy(null); void load() }
    }
  }

  function act(action: () => Promise<void>) {
    void action().catch((err) => { if (alive.current && !isAbort(err)) toast.error(errorMessage(err, '操作失败')) })
  }

  async function saveSource(input: SourceInput) {
    await mutate('source-save', (signal) => subscriptions.saveSource(sourceEditor?.id ?? null, input, signal), ({ source }) => setSources((items) => upsert(items, source)), '订阅源已保存')
    if (alive.current) setSourceEditor(undefined)
  }
  async function saveProfile(input: ProfileInput) {
    await mutate('profile-save', (signal) => subscriptions.saveProfile(profileEditor?.id ?? null, input, signal), ({ profile }) => setProfiles((items) => upsert(items, profile)), '封装配置已保存')
    if (alive.current) setProfileEditor(undefined)
  }
  async function refreshSource(source: SubscriptionSource) {
    await mutate(`refresh-${source.id}`, (signal) => subscriptions.refreshSource(source.id, signal), ({ source: result }) => {
      setSources((items) => upsert(items, result))
      const feedback = sourceRefreshFeedback(result)
      toast[feedback.kind](feedback.message)
    })
  }
  async function refreshAll() {
    await mutate('refresh-all', (signal) => subscriptions.refreshAll(signal), ({ sources: result }) => {
      setSources((items) => result.reduce((list, source) => upsert(list, source), items))
      const pending = result.filter((source) => source.enabled && sourceFetchProgress(source)).length
      const failed = result.filter((source) => source.enabled && !sourceFetchProgress(source) && source.last_error).length
      if (pending) {
        const message = `${pending} 个订阅源正在拉取或等待探针回传${failed ? `；${failed} 个订阅源拉取失败，请查看提示` : '，结果将自动更新'}`
        if (failed) toast.error(message)
        else toast.info(message)
      } else if (failed) toast.error(`拉取完成，${failed} 个订阅源仍有错误，请查看提示`)
      else toast.success('已拉取全部启用的订阅源')
    })
  }
  function removeSource(source: SubscriptionSource) {
    if (!window.confirm(`删除订阅源「${source.name}」及其缓存？引用该源的封装输出也会受影响。`)) return
    act(() => mutate('source-delete', (signal) => subscriptions.removeSource(source.id, signal), () => setSources((items) => items.filter((item) => item.id !== source.id)), '订阅源已删除'))
  }
  function removeProfile(profile: SubscriptionProfile) {
    if (!window.confirm(`删除封装配置「${profile.name}」？它的分享链接将失效，原始订阅源会保留。`)) return
    act(() => mutate('profile-delete', (signal) => subscriptions.removeProfile(profile.id, signal), () => setProfiles((items) => items.filter((item) => item.id !== profile.id)), '封装配置已删除'))
  }
  function rotate(profile: SubscriptionProfile) {
    if (!window.confirm(`重置「${profile.name}」的分享链接？旧链接将立即失效，需要在订阅客户端更新地址。`)) return
    act(() => mutate('profile-rotate', (signal) => subscriptions.rotateToken(profile.id, signal), ({ profile: next }) => setProfiles((items) => upsert(items, next)), '分享链接已重置，请复制新链接'))
  }
  async function copyFeed(profile: SubscriptionProfile, format: SubscriptionFormat) {
    try { await copySubscriptionText(subscriptionFeedUrl(profile.token, format)); toast.success('订阅链接已复制') }
    catch (err) { toast.error(errorMessage(err, '复制失败')) }
  }

  const preview = profiles.find((profile) => profile.id === previewId)
  const enabledSources = sources.filter((source) => source.enabled).length
  return (
    <PageShell wide title="订阅中心" description="订阅源管理 · 定时拉取 · Clash / Mihomo 封装" actions={<button type="button" className="glass rounded-xl p-2.5 text-fg/70 transition hover:text-fg disabled:opacity-40" disabled={checking || Boolean(busy)} onClick={() => void load()} aria-label="刷新订阅中心状态" title="刷新状态"><RefreshCw className={`size-4 ${checking ? 'animate-spin' : ''}`} aria-hidden /></button>}>
      <div className="space-y-5">
        <div className="glass rounded-3xl p-4 sm:p-5">
          <div className="grid grid-cols-3 gap-3"><div><p className="text-[11px] text-fg/45">订阅源</p><p className="mt-1 text-xl font-semibold tabular-nums text-fg">{sources.length}<span className="ml-1 text-[10px] font-normal text-fg/45">/ {enabledSources} 个定时</span></p></div><div><p className="text-[11px] text-fg/45">缓存节点</p><p className="mt-1 text-xl font-semibold tabular-nums text-fg">{sources.reduce((count, source) => count + source.proxy_count, 0)}</p></div><div><p className="text-[11px] text-fg/45">封装配置</p><p className="mt-1 text-xl font-semibold tabular-nums text-fg">{profiles.length}</p></div></div>
          <p className="mt-3 border-t border-line/10 pt-3 text-[11px] leading-relaxed text-fg/50">服务器按每个源的间隔调度，可直接拉取或交给指定探针，关闭页面后继续运行。状态每 30 秒更新，拉取期间每 5 秒更新；到期与流量信息来自上游。</p>
        </div>
        {error && <div role="alert" className="glass flex items-start gap-2 rounded-2xl border border-danger/20 p-4 text-sm text-danger"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /><div className="min-w-0"><p className="break-words">{error}</p><p className="mt-1 text-xs opacity-70">已显示的数据和正在编辑的表单会保留。</p><button type="button" className="mt-2 underline underline-offset-4" onClick={() => void load()} disabled={checking || Boolean(busy)}>重新读取</button></div></div>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="glass flex gap-1 rounded-2xl p-1" role="tablist" aria-label="订阅中心视图"><button id="subscriptions-sources-tab" type="button" role="tab" aria-selected={tab === 'sources'} aria-controls="subscriptions-sources-panel" onClick={() => setTab('sources')} className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs transition ${tab === 'sources' ? 'bg-line/15 font-medium text-fg' : 'text-fg/55 hover:text-fg'}`}><Rss className="size-3.5" aria-hidden />订阅源</button><button id="subscriptions-profiles-tab" type="button" role="tab" aria-selected={tab === 'profiles'} aria-controls="subscriptions-profiles-panel" onClick={() => setTab('profiles')} className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs transition ${tab === 'profiles' ? 'bg-line/15 font-medium text-fg' : 'text-fg/55 hover:text-fg'}`}><Layers className="size-3.5" aria-hidden />封装配置</button></div>
          <div className="flex flex-wrap gap-2">{tab === 'sources' ? <><button type="button" className={`${btnGhost} glass px-3 py-2 text-xs`} disabled={Boolean(busy) || enabledSources === 0 || sources.some((source) => source.fetching)} onClick={() => act(refreshAll)}>{busy === 'refresh-all' ? <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 inline size-3.5" aria-hidden />}拉取全部启用源</button><button type="button" className={`${btnPrimary} px-3 py-2 text-xs`} disabled={Boolean(busy)} onClick={() => setSourceEditor(null)}><Plus className="mr-1 inline size-3.5" aria-hidden />添加订阅源</button></> : <button type="button" className={`${btnPrimary} px-3 py-2 text-xs`} disabled={Boolean(busy) || sources.length === 0} onClick={() => setProfileEditor(null)}><Plus className="mr-1 inline size-3.5" aria-hidden />新建封装配置</button>}</div>
        </div>
        {loading ? <div role="status" className="glass flex min-h-48 items-center justify-center gap-2 rounded-3xl text-sm text-fg/55"><Loader2 className="size-5 animate-spin" aria-hidden />正在读取订阅中心…</div> : tab === 'sources' ? <section id="subscriptions-sources-panel" role="tabpanel" aria-labelledby="subscriptions-sources-tab">
          {sources.length === 0 ? <div className="glass rounded-3xl px-5 py-12 text-center"><Database className="mx-auto mb-3 size-9 text-fg/25" aria-hidden /><h2 className="text-base font-medium text-fg/80">添加你的第一个订阅源</h2><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-fg/50">保存订阅地址和刷新间隔，再将多个源组合为自己的 Clash / Mihomo 配置。</p><button type="button" className={`${btnPrimary} mt-5`} disabled={Boolean(busy)} onClick={() => setSourceEditor(null)}>添加订阅源</button></div> : <div className="grid gap-4 md:grid-cols-2">{sources.map((source) => <SourceCard key={source.id} source={source} relayNode={relayNodes.find((node) => node.id === source.fetch_agent_id)} now={now} busy={Boolean(busy)} refreshing={busy === `refresh-${source.id}` || busy === 'refresh-all' && source.enabled} onEdit={() => setSourceEditor(source)} onRefresh={() => act(() => refreshSource(source))} onToggle={() => act(() => mutate('source-toggle', (signal) => subscriptions.saveSource(source.id, { ...sourceInput(source), enabled: !source.enabled }, signal), ({ source: next }) => setSources((items) => upsert(items, next)), source.enabled ? '已暂停定时拉取，缓存继续可用' : '已启用定时拉取'))} onRemove={() => removeSource(source)} />)}</div>}
        </section> : <section id="subscriptions-profiles-panel" role="tabpanel" aria-labelledby="subscriptions-profiles-tab">
          {profiles.length === 0 ? <div className="glass rounded-3xl px-5 py-12 text-center"><Layers className="mx-auto mb-3 size-9 text-fg/25" aria-hidden /><h2 className="text-base font-medium text-fg/80">组合一份自己的订阅</h2><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-fg/50">选择多个源，筛选节点、调整名称和路由规则，生成三种格式的分享链接。</p>{sources.length === 0 ? <button type="button" className={`${btnPrimary} mt-5`} onClick={() => { setTab('sources'); setSourceEditor(null) }}>先添加订阅源</button> : <button type="button" className={`${btnPrimary} mt-5`} disabled={Boolean(busy)} onClick={() => setProfileEditor(null)}>新建封装配置</button>}</div> : <div className="grid gap-4 md:grid-cols-2">{profiles.map((profile) => <ProfileCard key={profile.id} profile={profile} sources={sources} busy={Boolean(busy)} onEdit={() => setProfileEditor(profile)} onPreview={() => setPreviewId(profile.id)} onToggle={() => act(() => mutate('profile-toggle', (signal) => subscriptions.saveProfile(profile.id, { ...profileInput(profile), enabled: !profile.enabled }, signal), ({ profile: next }) => setProfiles((items) => upsert(items, next)), profile.enabled ? '分享链接已停用' : '分享链接已启用'))} onRotate={() => rotate(profile)} onRemove={() => removeProfile(profile)} onCopy={(format) => void copyFeed(profile, format)} />)}</div>}
        </section>}
      </div>
      {sourceEditor !== undefined && <SourceEditor source={sourceEditor} relayNodes={relayNodes} onSave={saveSource} onClose={() => setSourceEditor(undefined)} />}
      {profileEditor !== undefined && <ProfileEditor profile={profileEditor} sources={sources} onSave={saveProfile} onClose={() => setProfileEditor(undefined)} />}
      {preview && <SubscriptionPreview profile={preview} onClose={() => setPreviewId(null)} />}
    </PageShell>
  )
}
