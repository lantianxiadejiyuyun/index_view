import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Loader2, Search, Trash2, TriangleAlert } from 'lucide-react'
import { ApiError, errorMessage } from '../lib/api.ts'
import type { Site } from '../lib/types.ts'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { Modal, btnDanger, btnGhost, btnPrimary, fieldClass, labelClass } from './Modal.tsx'

type Props = { open: boolean; onClose: () => void; all?: boolean }

/** Unmount between openings so an old selection or confirmation can never be reused. */
export function BulkSiteDeleteModal({ open, onClose, all = false }: Props) {
  return open ? <BulkSiteDeleteDialog onClose={onClose} all={all} /> : null
}

function BulkSiteDeleteDialog({ onClose, all }: Omit<Props, 'open'>) {
  const sites = useApp((s) => s.sites)
  const folders = useApp((s) => s.folders)
  const categories = useApp((s) => s.categories)
  const canEdit = useApp((s) => s.canEdit)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [review, setReview] = useState<Site[] | null>(() => all ? [...sites] : null)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [needsReviewRefresh, setNeedsReviewRefresh] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const content = useRef<HTMLDivElement>(null)
  const id = useId()
  const reviewing = review !== null
  const chosen = sites.filter((site) => selected.has(site.id))
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return sites.filter((site) => {
      const inScope = scope === 'all' ||
        (scope === 'no-folder' && site.folder_id == null) ||
        (scope === 'no-category' && site.category_id == null) ||
        scope === `folder:${site.folder_id}` || scope === `category:${site.category_id}`
      return inScope && (!term || [site.title, site.description, site.url_public, site.url_lan]
        .some((value) => value?.toLocaleLowerCase().includes(term)))
    })
  }, [sites, query, scope])
  const allVisibleSelected = filtered.length > 0 && filtered.every((site) => selected.has(site.id))
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]))
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]))

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]')
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
    ) ?? []).filter((element) => element.getClientRects().length > 0)
    content.current?.querySelector<HTMLInputElement>('input')?.focus()
    if (!dialog?.contains(document.activeElement)) focusable()[0]?.focus()
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== 'Tab') return
      const elements = focusable(), first = elements[0], last = elements.at(-1)
      if (!first || !last) return
      if (!dialog?.contains(document.activeElement) ||
        (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener('keydown', trapFocus)
    return () => {
      window.removeEventListener('keydown', trapFocus)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    if (reviewing && !all) content.current?.querySelector<HTMLElement>('[data-delete-review]')?.focus()
  }, [reviewing, all])

  function close() { if (!busyRef.current) onClose() }

  function toggle(siteId: number) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(siteId)) next.delete(siteId)
      else next.add(siteId)
      return next
    })
  }

  async function remove() {
    if (busyRef.current || needsReviewRefresh || !canEdit || !review?.length || (all && confirmation !== '删除所有图标')) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const count = await useApp.getState().bulkDeleteSites(all
        ? { all: true, confirm: 'delete-all-sites', expected_ids: review.map((site) => site.id) }
        : { ids: review.map((site) => site.id) })
      toast.success(`已删除 ${count} 个图标`)
      onClose()
    } catch (err) {
      if (all && err instanceof ApiError && err.status === 409 && err.code === 'sites_changed') {
        setNeedsReviewRefresh(true)
        setConfirmation('')
      }
      setError(errorMessage(err, '删除失败，请稍后重试'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function refreshReview() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setRefreshing(true)
    setError(null)
    try {
      const currentSites = await useApp.getState().refreshSitesForDeletion()
      setReview([...currentSites])
      setConfirmation('')
      setNeedsReviewRefresh(false)
      toast.success('清单已刷新，请核对后重新输入确认文字')
    } catch (err) {
      setError(errorMessage(err, '刷新清单失败，请稍后重试'))
    } finally {
      busyRef.current = false
      setBusy(false)
      setRefreshing(false)
    }
  }

  function location(site: Site) {
    return [categoryNames.get(site.category_id ?? -1) ?? '未分组',
      site.folder_id == null ? '未放入文件夹' : folderNames.get(site.folder_id) ?? '文件夹'].join(' · ')
  }

  return <Modal open title={all ? '删除所有图标' : reviewing ? '确认批量删除' : '批量删除图标'} onClose={close} size="wide" footer={<>
    {reviewing && !all && <button type="button" className={`${btnGhost} mr-auto`} disabled={busy} onClick={() => { setReview(null); setError(null) }}>返回选择</button>}
    <button type="button" className={btnGhost} disabled={busy} onClick={close}>取消</button>
    {reviewing ? <button type="button" className={`${btnDanger} inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50`} disabled={busy || needsReviewRefresh || !canEdit || !review.length || (all && confirmation !== '删除所有图标')} onClick={() => void remove()}>
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
      {refreshing ? '刷新清单中…' : busy ? '删除中…' : `确认删除 ${review.length} 个图标`}
    </button> : <button type="button" className={btnPrimary} disabled={!canEdit || chosen.length === 0} onClick={() => { setReview([...chosen]); setError(null) }}>下一步：确认删除 {chosen.length} 个</button>}
  </>}>
    <div ref={content} className="space-y-4" aria-busy={busy}>
      {!canEdit && <p role="alert" className="text-sm text-danger">请先登录管理员账号再删除图标。</p>}
      {reviewing ? <>
        <div className="flex gap-2 rounded-xl border border-rose-400/25 bg-rose-500/10 p-3 text-sm leading-relaxed text-fg/80">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <p data-delete-review tabIndex={-1}>将删除以下 <strong>{review.length}</strong> 个图标及其链接记录，无法撤销。文件夹、分组和其他配置会保留。</p>
        </div>
        <ul aria-label="待删除图标" className="max-h-64 divide-y divide-line/10 overflow-y-auto rounded-xl border border-line/15">
          {review.map((site) => <li key={site.id} className="min-w-0 px-3 py-2.5">
            <p className="break-words text-sm font-medium text-fg">{site.title}</p>
            <p className="mt-0.5 truncate text-xs text-fg/50">{location(site)}</p>
            <p className="mt-0.5 truncate text-xs text-fg/50">{site.url_public || site.url_lan || '无链接'}</p>
          </li>)}
          {review.length === 0 && <li className="p-5 text-center text-sm text-fg/55">当前没有可删除的图标</li>}
        </ul>
        {all && <div>
          <label htmlFor={`${id}-confirmation`} className={labelClass}>输入“删除所有图标”以确认</label>
          <input id={`${id}-confirmation`} className={fieldClass} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy || needsReviewRefresh || !canEdit || !review.length} placeholder="删除所有图标" autoComplete="off" spellCheck={false} />
          <p className="mt-2 text-xs text-fg/55">需要留存时，请先到「数据备份」导出。</p>
        </div>}
      </> : <>
        <p className="text-sm leading-relaxed text-fg/60">勾选要删除的图标，下一步核对清单后再确认删除。</p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div>
            <label htmlFor={`${id}-search`} className={labelClass}>搜索图标</label>
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-fg/40" aria-hidden />
              <input id={`${id}-search`} type="search" className={`${fieldClass} pl-9`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、描述或网址" />
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-scope`} className={labelClass}>所在位置</label>
            <select id={`${id}-scope`} className={fieldClass} value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="all">全部图标</option><option value="no-folder">未放入文件夹</option><option value="no-category">未分组</option>
              {folders.length > 0 && <optgroup label="文件夹">{folders.map((folder) => <option key={folder.id} value={`folder:${folder.id}`}>{folder.name}</option>)}</optgroup>}
              {categories.length > 0 && <optgroup label="分组">{categories.map((category) => <option key={category.id} value={`category:${category.id}`}>{category.name}</option>)}</optgroup>}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" className={`${btnGhost} text-xs`} disabled={!filtered.length || allVisibleSelected} onClick={() => setSelected((current) => new Set([...current, ...filtered.map((site) => site.id)]))}>选择当前结果（{filtered.length}）</button>
          <button type="button" className={`${btnGhost} text-xs`} disabled={!selected.size} onClick={() => setSelected(new Set())}>清空选择</button>
          <span role="status" className="ml-auto text-fg/60">已选 {chosen.length} / 共 {sites.length} 个</span>
        </div>
        <ul aria-label="选择要删除的图标" className="max-h-[42dvh] divide-y divide-line/10 overflow-y-auto rounded-xl border border-line/15">
          {filtered.map((site) => <li key={site.id}>
            <label className={`flex min-h-16 cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-line/10 ${selected.has(site.id) ? 'bg-brand-500/10' : ''}`}>
              <input type="checkbox" className="size-4 shrink-0 accent-brand-500" checked={selected.has(site.id)} onChange={() => toggle(site.id)} aria-label={`选择图标 ${site.title}`} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-fg">{site.title}</span><span className="mt-0.5 block truncate text-xs text-fg/50">{location(site)}</span><span className="mt-0.5 block truncate text-xs text-fg/45">{site.url_public || site.url_lan || '无链接'}</span></span>
            </label>
          </li>)}
          {filtered.length === 0 && <li className="p-6 text-center text-sm text-fg/55">{sites.length ? '没有符合条件的图标' : '当前没有图标'}</li>}
        </ul>
        <p className="text-xs text-fg/50">切换搜索或筛选会保留已选图标。</p>
      </>}
      {error && <p role="alert" className="rounded-xl border border-rose-400/25 bg-rose-500/10 p-3 text-sm leading-relaxed text-danger">{error}</p>}
      {needsReviewRefresh && <div className="space-y-2">
        <p className="text-xs leading-relaxed text-fg/65">图标清单发生变化，本次没有删除任何图标。请刷新清单并重新确认。</p>
        <button type="button" className={`${btnGhost} inline-flex items-center gap-1.5`} disabled={busy} onClick={() => void refreshReview()}>{refreshing && <Loader2 className="size-4 animate-spin" aria-hidden />}刷新清单</button>
      </div>}
    </div>
  </Modal>
}
