import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, KeyRound, Loader2, Search } from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import { Modal, btnGhost, fieldClass, labelClass } from '../Modal.tsx'

type VaultItem = { id: string; title: string; site: string; username_masked: string; password_set: boolean }
type RevealedItem = { id: string; title: string; site: string; username: string; password: string }
type VaultPage = { items: VaultItem[]; pagination: { total: number; limit: number; offset: number } }

/** This view has no chat integration: plaintext only lives in a short-lived, user-opened dialog. */
export function LingxiVaultPanel() {
  const location = useLocation()
  const [open, setOpen] = useState(() => location.hash === '#lingxi-vault')
  return <div className="mt-4 border-t border-line/10 pt-3"><button type="button" aria-expanded={open} className="flex min-h-11 w-full items-center justify-between gap-3 text-left text-sm font-medium text-fg" onClick={() => setOpen(value => !value)}><span className="flex items-center gap-2"><KeyRound size={15} />查看已授权密码</span><ChevronDown size={16} className={open ? 'rotate-180' : ''} /></button>{open && <VaultContents />}</div>
}

function VaultContents() {
  const [draft, setDraft] = useState(''), [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [version, setVersion] = useState(0)
  const [page, setPage] = useState<VaultPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [view, setView] = useState<VaultItem | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setPage(null)
    api<VaultPage>(`/api/lingxi/vault/items?${new URLSearchParams({ q: query, limit: '50', offset: String(offset) })}`, {}, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setPage(value) }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query, offset, version])
  return <div className="mt-2 space-y-3"><p className="text-xs leading-relaxed text-fg/55">列表仅显示名称、站点与账号掩码。点击单条查看时才读取密码，密码不会加入 AI 聊天内容。</p><form className="flex gap-2" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); setOffset(0); setVersion(value => value + 1) }}><input className={fieldClass} value={draft} onChange={event => setDraft(event.target.value)} maxLength={200} aria-label="搜索已授权密码" placeholder="搜索站点或名称" /><button type="submit" className={btnGhost} aria-label="搜索密码"><Search size={16} /></button></form>
    {loading ? <p role="status" className="flex items-center gap-2 py-5 text-xs text-fg/55"><Loader2 size={15} className="animate-spin" />正在读取授权条目…</p> : error ? <div role="alert" className="space-y-2 text-xs text-danger"><p className="break-words">{error}</p><button type="button" className={btnGhost} onClick={() => setVersion(value => value + 1)}>重新读取</button></div> : page?.items.length ? <ul className="space-y-2">{page.items.map(item => <li key={item.id} className="flex min-w-0 items-center gap-3 rounded-xl bg-line/5 p-3"><span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium text-fg">{item.title || '未命名密码'}</span><span className="mt-1 block break-all text-xs text-fg/55">{item.site || '未填写站点'}{item.username_masked ? ` · ${item.username_masked}` : ''}</span>{!item.password_set && <span className="mt-1 block text-xs text-fg/45">未保存密码</span>}</span><button type="button" className={`${btnGhost} shrink-0`} onClick={() => setView(item)} aria-label={`查看 ${item.title || '未命名密码'}`}>查看</button></li>)}</ul> : <p className="py-5 text-center text-xs text-fg/50">{query ? '没有匹配的授权条目' : '暂无已同步的密码条目'}</p>}
    {page && <div className="flex items-center justify-between gap-2 text-xs text-fg/55"><span>共 {page.pagination.total} 条{page.items.length ? ` · ${offset + 1}–${offset + page.items.length}` : ''}</span><div className="flex items-center gap-1"><button type="button" aria-label="上一页密码" className="lingxi-icon-button" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 50))}><ChevronLeft size={16} /></button><button type="button" aria-label="下一页密码" className="lingxi-icon-button" disabled={offset + page.items.length >= page.pagination.total || loading} onClick={() => setOffset(value => value + 50)}><ChevronRight size={16} /></button></div></div>}
    {view && <RevealDialog key={view.id} item={view} onClose={() => setView(null)} />}
  </div>
}

function RevealDialog({ item, onClose }: { item: VaultItem; onClose: () => void }) {
  const [revealed, setRevealed] = useState<RevealedItem | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [visible, setVisible] = useState(true), [notice, setNotice] = useState('')
  const request = useRef<AbortController | null>(null), alive = useRef(true), closing = useRef(onClose)
  closing.current = onClose
  const close = useCallback(() => { request.current?.abort(); setRevealed(null); setNotice(''); closing.current() }, [])
  useEffect(() => {
    const controller = new AbortController(); request.current = controller; alive.current = true
    api<{ item: RevealedItem }>('/api/lingxi/vault/reveal', { method: 'POST', body: JSON.stringify({ id: item.id }) }, { signal: controller.signal }).then(value => { if (!controller.signal.aborted && document.visibilityState === 'visible') setRevealed(value.item) }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    const timer = window.setTimeout(close, 60_000)
    const hidden = () => { if (document.visibilityState !== 'visible') close() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', close)
    return () => { alive.current = false; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', close) }
  }, [item.id, close])
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); if (alive.current) setNotice(`${label}已复制`) } catch { if (alive.current) setNotice('无法写入剪贴板，请选择字段内容后手动复制') }
  }
  return createPortal(<Modal open title={item.title || '查看密码'} onClose={close}><div className="space-y-4">{loading ? <p role="status" className="flex items-center gap-2 text-sm text-fg/55"><Loader2 size={16} className="animate-spin" />正在读取选中条目…</p> : error ? <p role="alert" className="break-words text-sm text-danger">{error}</p> : revealed && <>
    <p className="break-all text-xs text-fg/60">{revealed.site || '未填写站点'}</p>
    <div><label className={labelClass} htmlFor="lingxi-vault-username">账号</label><div className="flex gap-2"><input id="lingxi-vault-username" className={fieldClass} readOnly value={revealed.username} autoComplete="off" /><button type="button" className={btnGhost} aria-label="复制账号" onClick={() => void copy(revealed.username, '账号')}><Copy size={15} /></button></div></div>
    <div><label className={labelClass} htmlFor="lingxi-vault-password">密码</label><div className="flex gap-2"><input id="lingxi-vault-password" className={fieldClass} readOnly type={visible ? 'text' : 'password'} value={revealed.password} autoComplete="off" spellCheck={false} /><button type="button" className={btnGhost} aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button><button type="button" className={btnGhost} aria-label="复制密码" onClick={() => void copy(revealed.password, '密码')}><Copy size={15} /></button></div></div>
    <p className="text-xs leading-relaxed text-fg/50">关闭弹窗、切换标签页或 60 秒后，页面会清除本次读取的密码。复制操作仅写入你的设备剪贴板。</p>
  </>}{notice && <p role="status" className="text-xs text-fg/65">{notice}</p>}<button type="button" className={`${btnGhost} w-full`} onClick={close}>关闭并清除</button></div></Modal>, document.body)
}
