import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ExternalLink, FolderClosed, LayoutGrid, Loader2, Sparkles, Undo2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ApiError, errorMessage, faviconUrl } from '../lib/api.ts'
import { emojiOf, initialOf } from '../lib/icon.ts'
import {
  NAVIGATION_AI_EXAMPLES, NAVIGATION_AI_MAX_SITES, navigationAi, navigationLayoutFingerprint,
  navigationPreviewCounts, navigationPreviewIncludesEverySite, navigationTokenRemaining,
  type NavigationAiPreview, type NavigationAiSnapshot,
} from '../lib/navigation-ai.ts'
import { subscriptions, type SubscriptionAISettings } from '../lib/subscriptions.ts'
import type { Site } from '../lib/types.ts'
import { useApp } from '../store/app.ts'
import { Modal, btnGhost, btnPrimary, fieldClass, labelClass } from './Modal.tsx'

type Candidate = { fingerprint: string; output: NavigationAiPreview }
type UndoState = { token: string; expiresAt: number; fingerprint: string }

/** Remains mounted on the home page so reopening retains the latest undo action. */
export function NavigationAiOrganizer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sites = useApp((state) => state.sites)
  const categories = useApp((state) => state.categories)
  const folders = useApp((state) => state.folders)
  const canEdit = useApp((state) => state.canEdit)
  const user = useApp((state) => state.user)
  const [settings, setSettings] = useState<SubscriptionAISettings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [undo, setUndo] = useState<UndoState | null>(null)
  const [generating, setGenerating] = useState(false)
  const [mutating, setMutating] = useState<'apply' | 'undo' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const generation = useRef<AbortController | null>(null)
  const mutation = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const stateUserId = useRef(user?.id)
  const previewSection = useRef<HTMLElement | null>(null)
  const undoSection = useRef<HTMLDivElement | null>(null)
  const noticeSection = useRef<HTMLParagraphElement | null>(null)
  const layout = useMemo(() => navigationLayoutFingerprint({ sites, categories, folders }), [sites, categories, folders])
  const fingerprint = JSON.stringify({ layout, prompt, settings, userId: user?.id })
  const latestFingerprint = useRef(fingerprint)
  latestFingerprint.current = fingerprint
  const previewSites = candidate?.output.sites
  const siteMap = useMemo(() => new Map((previewSites ?? []).map((site) => [site.id, site])), [previewSites])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; generation.current?.abort(); mutation.current?.abort() }
  }, [])

  useEffect(() => {
    if (stateUserId.current === user?.id) return
    stateUserId.current = user?.id
    generation.current?.abort()
    generation.current = null
    mutation.current?.abort()
    mutation.current = null
    setGenerating(false)
    setMutating(null)
    setCandidate(null)
    setUndo(null)
    setSettings(null)
    setSettingsError(null)
    setPrompt('')
    setNotice(null)
    setError(null)
  }, [user?.id])

  useEffect(() => {
    if (!open || !canEdit || !user) return
    const ownerId = user.id
    let controller: AbortController | null = null
    function load() {
      controller?.abort()
      const current = new AbortController()
      controller = current
      setSettingsLoading(true)
      setSettingsError(null)
      subscriptions.aiSettings(current.signal).then((result) => {
        if (!current.signal.aborted && useApp.getState().user?.id === ownerId) setSettings(result.settings)
      }).catch((err) => {
        if (!current.signal.aborted) setSettingsError(errorMessage(err, '读取 AI 配置失败'))
      }).finally(() => { if (!current.signal.aborted) setSettingsLoading(false) })
    }
    load()
    const visible = () => { if (!document.hidden) load() }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', visible)
    return () => { controller?.abort(); window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', visible) }
  }, [open, canEdit, user, reload])

  useEffect(() => {
    generation.current?.abort()
    generation.current = null
    setGenerating(false)
  }, [fingerprint])

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  const stale = candidate !== null && candidate.fingerprint !== fingerprint
  const preview = candidate && !stale ? candidate.output : null
  const expired = Boolean(preview && preview.expires_at <= now)
  const complete = Boolean(preview && Array.isArray(preview.sites) && navigationPreviewIncludesEverySite(preview, preview.sites))
  const counts = preview ? navigationPreviewCounts(preview) : null
  const undoExpired = Boolean(undo && undo.expiresAt <= now)
  const undoStale = Boolean(undo && undo.fingerprint !== layout)
  const overLimit = sites.length > NAVIGATION_AI_MAX_SITES
  const ownsState = stateUserId.current === user?.id
  const canGenerate = Boolean(ownsState && canEdit && user && sites.length && !overLimit && settings?.configured && !settingsLoading && !settingsError && !generating && !mutating)
  const canApply = Boolean(ownsState && canEdit && user && preview && complete && !expired && !mutating && !generating)

  useEffect(() => {
    if (open && preview?.preview_token) previewSection.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [open, preview?.preview_token])

  useEffect(() => {
    if (open && notice) (undo ? undoSection.current : noticeSection.current)?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [open, notice, undo])

  function stopGeneration() {
    generation.current?.abort()
    generation.current = null
    setGenerating(false)
  }

  function close() {
    if (mutation.current) return
    stopGeneration()
    onClose()
  }

  async function generate() {
    if (!canGenerate || generation.current || mutation.current) return
    const controller = new AbortController()
    const snapshot = fingerprint
    const ownerId = user?.id
    generation.current = controller
    setGenerating(true)
    setCandidate(null)
    setError(null)
    setNotice(null)
    try {
      const output = await navigationAi.preview(prompt, controller.signal)
      if (alive.current && !controller.signal.aborted && latestFingerprint.current === snapshot && useApp.getState().user?.id === ownerId) {
        setCandidate({ fingerprint: snapshot, output })
        setNow(Date.now())
      }
    } catch (err) {
      if (alive.current && !controller.signal.aborted && latestFingerprint.current === snapshot) setError(errorMessage(err, '生成整理方案失败'))
    } finally {
      if (generation.current === controller) { generation.current = null; if (alive.current) setGenerating(false) }
    }
  }

  function commitSnapshot(snapshot: NavigationAiSnapshot) {
    useApp.setState({ sites: snapshot.sites, categories: snapshot.categories, folders: snapshot.folders })
  }

  async function apply() {
    if (!canApply || !candidate || candidate.fingerprint !== latestFingerprint.current || candidate.output.expires_at <= Date.now() || mutation.current) return
    const controller = new AbortController()
    const ownerId = user?.id
    mutation.current = controller
    setMutating('apply')
    setError(null)
    setNotice(null)
    try {
      const result = await navigationAi.apply(candidate.output.preview_token, controller.signal)
      if (!alive.current || controller.signal.aborted || useApp.getState().user?.id !== ownerId) return
      commitSnapshot(result)
      setUndo({ token: result.undo_token, expiresAt: result.undo_expires_at, fingerprint: navigationLayoutFingerprint(result) })
      setCandidate(null)
      setNotice(`已整理 ${result.sites.length} 个图标。可关闭查看首页，重新打开“AI 整理”仍可在有效期内撤销。`)
      setNow(Date.now())
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return
      if (err instanceof ApiError && [409, 410].includes(err.status)) setCandidate(null)
      setError(errorMessage(err, '未能确认整理结果，请重试应用'))
    } finally {
      if (mutation.current === controller) { mutation.current = null; if (alive.current) setMutating(null) }
    }
  }

  async function undoApply() {
    if (!ownsState || !undo || undoExpired || undoStale || mutation.current || generating || !canEdit || !user || undo.expiresAt <= Date.now()) return
    const controller = new AbortController()
    const ownerId = user.id
    mutation.current = controller
    setMutating('undo')
    setError(null)
    setNotice(null)
    try {
      const result = await navigationAi.undo(undo.token, controller.signal)
      if (!alive.current || controller.signal.aborted || useApp.getState().user?.id !== ownerId) return
      commitSnapshot(result)
      setUndo(null)
      setCandidate(null)
      setNotice('已撤销本次 AI 整理，恢复整理前的图标布局。')
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return
      if (err instanceof ApiError && [409, 410].includes(err.status)) setUndo(null)
      setError(errorMessage(err, '撤销结果尚未确认，请重试'))
    } finally {
      if (mutation.current === controller) { mutation.current = null; if (alive.current) setMutating(null) }
    }
  }

  return <Modal open={open} title="AI 整理首页" size="wide" onClose={close} footer={<>
    <button type="button" className={btnGhost} disabled={Boolean(mutating)} onClick={close}>{notice && undo ? '查看首页' : '关闭'}</button>
    {preview && <button type="button" className={`${btnPrimary} flex items-center gap-1.5`} disabled={!canApply} onClick={() => void apply()}>{mutating === 'apply' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}{mutating === 'apply' ? '正在应用…' : '应用整理方案'}</button>}
  </>}>
    <div className="min-w-0 space-y-4">
      <div className="rounded-2xl border border-brand-500/20 bg-brand-500/5 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-fg"><Sparkles className="size-4 text-brand-500" aria-hidden />让首页井然有序</div>
        <p className="mt-2 text-xs leading-relaxed text-fg/65">AI 会按用途分类、排序，并将相关图标整理到文件夹。先检查方案，再决定应用。</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-fg/65"><span className="rounded-lg bg-line/5 px-2.5 py-1.5">{sites.length} 个图标</span><span className="rounded-lg bg-line/5 px-2.5 py-1.5">{categories.length} 个分组</span><span className="rounded-lg bg-line/5 px-2.5 py-1.5">{folders.length} 个文件夹</span></div>
      </div>

      {undo && <div ref={undoSection} className="scroll-mt-2 space-y-2 rounded-2xl border border-success/25 bg-success/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium text-fg">最近一次整理</p><p className={`mt-1 text-xs ${undoExpired || undoStale ? 'text-warn' : 'text-fg/55'}`}>{undoExpired ? '撤销期限已过，可重新生成整理方案。' : undoStale ? '首页已有后续修改，无法撤销本次整理。' : `还可撤销 ${navigationTokenRemaining(undo.expiresAt, now)}`}</p></div><button type="button" className={`${btnGhost} flex items-center gap-1.5 text-xs`} disabled={undoExpired || undoStale || Boolean(mutating) || generating} onClick={() => void undoApply()}>{mutating === 'undo' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Undo2 className="size-4" aria-hidden />}{mutating === 'undo' ? '正在撤销…' : '撤销这次整理'}</button></div>
        {!undoExpired && !undoStale && <p className="text-xs leading-relaxed text-fg/50">撤销入口会保留在当前首页；刷新页面或离开首页后不再显示。</p>}
      </div>}
      {notice && <p ref={noticeSection} role="status" className="scroll-mt-2 break-words rounded-xl bg-success/10 px-3 py-2 text-sm text-success">{notice}</p>}
      {error && <p role="alert" className="break-words rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      <div className={`rounded-xl border p-3 ${!settings?.configured && !settingsLoading ? 'border-brand-500/30 bg-brand-500/5' : 'border-line/15'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-words text-xs text-fg/65">{settingsLoading ? '正在读取 AI 配置…' : settingsError || (settings?.configured ? `已连接配置：${settings.provider === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容接口'} · ${settings.model}` : '先添加 API Key，即可使用已预置的 DeepSeek。')}</p><Link to="/settings/ai" target="_blank" rel="noopener noreferrer" aria-label="打开 AI 配置（新标签页）" className={`${btnGhost} inline-flex items-center gap-1.5 text-xs`} onClick={() => { stopGeneration(); setCandidate(null) }}>AI 配置<ExternalLink className="size-3.5" aria-hidden /></Link></div>
        {settingsError && <button type="button" className="mt-2 min-h-10 text-xs text-brand-500 underline" onClick={() => setReload((value) => value + 1)}>重新读取配置</button>}
      </div>

      <fieldset disabled={Boolean(mutating)} className="min-w-0 space-y-3 disabled:opacity-60">
        <div><label className={labelClass} htmlFor="navigation-ai-prompt">整理偏好 <span className="font-normal text-fg/45">（可选）</span></label><textarea id="navigation-ai-prompt" className={fieldClass} rows={3} maxLength={2000} value={prompt} onChange={(event) => { setPrompt(event.target.value); setError(null) }} placeholder="留空自动分类；也可填写：保留工作分组，把开发工具整理进文件夹，常用入口放前面" /></div>
        <div className="flex flex-wrap gap-2" aria-label="整理偏好示例">{NAVIGATION_AI_EXAMPLES.map((example) => <button type="button" key={example.label} className="min-h-10 rounded-lg border border-line/15 px-3 py-2 text-xs text-fg/70 transition hover:bg-line/10" onClick={() => { setPrompt(example.prompt); setError(null) }}>{example.label}</button>)}</div>
        <p className="text-xs leading-relaxed text-fg/50">仅将图标名称、分组和文件夹名称、当前归属与顺序，以及你填写的整理偏好发送到已配置的 AI；不发送网址、密钥或图标图片。整理不删除图标、不改变链接，原有空分组会保留。</p>
        {overLimit && <p role="alert" className="text-xs text-warn">当前有 {sites.length} 个图标，超过单次整理的 {NAVIGATION_AI_MAX_SITES} 个上限。</p>}
        {sites.length === 0 && <p className="text-xs text-fg/55">先添加一些图标，再让 AI 帮你整理。</p>}
        <div className="flex flex-wrap gap-2"><button type="button" className={`${btnPrimary} flex items-center gap-1.5`} disabled={!canGenerate} onClick={() => void generate()}>{generating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}{generating ? '正在生成整理方案…' : candidate ? '重新生成方案' : '生成整理方案'}</button>{generating && <button type="button" className={btnGhost} onClick={() => { stopGeneration(); setNotice('已取消等待，首页布局保持不变。') }}>取消等待</button>}</div>
      </fieldset>

      {stale && <p role="status" className="rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">整理偏好、AI 配置或首页内容已变化，请重新生成方案。</p>}
      {preview && counts && <section ref={previewSection} className="min-w-0 scroll-mt-2 space-y-3" aria-label="整理方案预览">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold text-fg">整理方案预览</h3><p className="mt-1 text-xs text-fg/55">{counts.sites} 个图标 · {counts.groups} 个分组 · {counts.folders} 个文件夹{counts.newGroups + counts.newFolders > 0 ? `（新建 ${counts.newGroups} 个分组、${counts.newFolders} 个文件夹）` : ''}</p></div><span className={`text-xs tabular-nums ${expired ? 'text-warn' : 'text-fg/50'}`}>{expired ? '方案已过期，请重新生成' : `${navigationTokenRemaining(preview.expires_at, now)} 内可应用`}</span></div>
        {preview.summary && <p className="whitespace-pre-wrap break-words rounded-xl bg-line/5 p-3 text-xs leading-relaxed text-fg/70">{preview.summary}</p>}
        {!complete && <p role="alert" className="text-xs text-danger">方案未完整覆盖当前图标，无法应用，请重新生成。</p>}
        <div className="space-y-3">{preview.groups.map((group, index) => <article key={`${group.category_id ?? 'new'}-${index}`} className="min-w-0 rounded-2xl border border-line/15 p-3">
          <div className="mb-3 flex items-center gap-2"><LayoutGrid className="size-4 shrink-0 text-brand-500" aria-hidden /><h4 className="min-w-0 break-words text-sm font-semibold text-fg">{group.name}</h4>{group.category_id === null && <NewBadge />}<span className="ml-auto shrink-0 text-[11px] text-fg/45">{group.site_ids.length + group.folders.reduce((sum, folder) => sum + folder.site_ids.length, 0)} 个</span></div>
          {group.folders.map((folder, folderIndex) => <div key={`${folder.folder_id ?? 'new'}-${folderIndex}`} className="mt-3 min-w-0 rounded-xl border border-line/10 bg-line/5 p-2.5"><div className="mb-2 flex items-center gap-2"><FolderClosed className="size-4 shrink-0 text-brand-500" aria-hidden /><h5 className="min-w-0 break-words text-xs font-medium text-fg/80">{folder.name}</h5>{folder.folder_id === null && <NewBadge />}<span className="ml-auto shrink-0 text-[11px] text-fg/45">{folder.site_ids.length} 个</span></div><PreviewSites ids={folder.site_ids} sites={siteMap} /></div>)}
          {group.site_ids.length > 0 && <div className={group.folders.length ? 'mt-3' : ''}>{group.folders.length > 0 && <p className="mb-2 text-[11px] text-fg/45">独立图标</p>}<PreviewSites ids={group.site_ids} sites={siteMap} /></div>}
          {!group.site_ids.length && !group.folders.length && <p className="text-xs text-fg/40">保留空分组</p>}
        </article>)}</div>
        <p className="text-xs leading-relaxed text-fg/50">应用时会再次检查首页是否被修改；其他设备的新修改不会被此方案覆盖。现有空分组仍会保留。</p>
      </section>}
    </div>
  </Modal>
}

function NewBadge() { return <span className="shrink-0 rounded-md bg-brand-500/10 px-1.5 py-0.5 text-[10px] text-brand-500">新建</span> }

function PreviewSites({ ids, sites }: { ids: number[]; sites: Map<number, Site> }) {
  if (!ids.length) return null
  return <ol className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">{ids.map((id, index) => {
    const site = sites.get(id)
    return <li key={`${id}-${index}`} className="flex min-w-0 items-center gap-2 rounded-xl bg-line/5 p-2"><span className="shrink-0 text-[10px] tabular-nums text-fg/35">{index + 1}</span>{site ? <PreviewIcon site={site} /> : <span className="size-7 shrink-0 rounded-lg bg-line/10" />}<span className="min-w-0 break-words text-[11px] leading-relaxed text-fg/80">{site?.title ?? `未知图标 #${id}`}</span></li>
  })}</ol>
}

function PreviewIcon({ site }: { site: Site }) {
  const src = site.icon_url?.trim() || faviconUrl(site)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const text = site.icon_text?.trim() || emojiOf(site.title) || initialOf(site.title)
  if (src && !failed && !(emojiOf(site.title) && !site.icon_url)) return <img src={src} width={28} height={28} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-7 shrink-0 rounded-lg object-contain" />
  return <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand-500/10 text-xs font-semibold text-brand-500" aria-hidden>{text}</span>
}
