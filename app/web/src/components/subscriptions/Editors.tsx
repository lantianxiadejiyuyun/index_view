import { useRef, useState, type FormEvent } from 'react'
import { Modal, btnGhost, btnPrimary, fieldClass, labelClass } from '../Modal.tsx'
import { errorMessage } from '../../lib/api.ts'
import { SUBSCRIPTION_PROTOCOLS, relayNodeHint, relayNodeLabel, splitLines, type ProfileInput, type SourceInput, type SubscriptionProfile, type SubscriptionRelayNode, type SubscriptionSource } from '../../lib/subscriptions.ts'

const checkClass = 'flex items-center gap-2 text-sm text-fg/80'
const hintClass = 'mt-1.5 text-xs leading-relaxed text-fg/50'

export function SourceEditor({ source, relayNodes, onSave, onClose }: {
  source: SubscriptionSource | null
  relayNodes: SubscriptionRelayNode[]
  onSave: (input: SourceInput) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(source?.name ?? '')
  const [url, setUrl] = useState(source?.url ?? '')
  const [note, setNote] = useState(source?.note ?? '')
  const [enabled, setEnabled] = useState(source?.enabled ?? true)
  const [interval, setInterval] = useState(String(source?.refresh_interval_minutes ?? 60))
  const [fetchAgentId, setFetchAgentId] = useState<number | null>(source?.fetch_agent_id ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const selectedRelay = relayNodes.find((node) => node.id === fetchAgentId)
  const missingRelay = fetchAgentId !== null && !selectedRelay

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    const minutes = Number(interval)
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080) {
      setError('刷新间隔必须是 5 到 10080 分钟之间的整数')
      return
    }
    submitting.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave({ name: name.trim(), url: url.trim(), note: note.trim(), enabled, refresh_interval_minutes: minutes, fetch_agent_id: fetchAgentId })
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) setError(errorMessage(err, '保存订阅源失败'))
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return (
    <Modal open title={source ? '编辑订阅源' : '添加订阅源'} onClose={() => { if (!saving) onClose() }} footer={
      <><button type="button" className={btnGhost} disabled={saving} onClick={onClose}>取消</button><button type="submit" form="subscription-source-form" className={btnPrimary} disabled={saving}>{saving ? '保存中…' : '保存订阅源'}</button></>
    }>
      <form id="subscription-source-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={saving} className="space-y-4 disabled:opacity-60">
          <div><label className={labelClass} htmlFor="subscription-source-name">名称</label><input id="subscription-source-name" className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus placeholder="例如：日常使用" /></div>
          <div><label className={labelClass} htmlFor="subscription-source-url">订阅地址</label><input id="subscription-source-url" className={`${fieldClass} font-mono text-xs`} type="url" maxLength={4096} value={url} onChange={(e) => setUrl(e.target.value)} required autoComplete="off" spellCheck={false} placeholder="https://example.com/subscription" /><p className={hintClass}>填写原始订阅链接，支持 Clash / Mihomo YAML、节点链接或 Base64 链接列表。</p></div>
          <div>
            <label className={labelClass} htmlFor="subscription-source-agent">拉取方式</label>
            <select id="subscription-source-agent" className={fieldClass} value={fetchAgentId ?? ''} onChange={(event) => setFetchAgentId(event.target.value === '' ? null : Number(event.target.value))} aria-describedby="subscription-source-agent-hint">
              <option value="">服务器直接拉取</option>
              {relayNodes.map((node) => <option key={node.id} value={node.id} disabled={!node.enabled || !node.approved}>{relayNodeLabel(node)}</option>)}
              {missingRelay && <option value={fetchAgentId!} disabled>原探针 {source?.fetch_agent_name || `#${fetchAgentId}`}（当前不可用）</option>}
            </select>
            <p id="subscription-source-agent-hint" className={hintClass}>{fetchAgentId === null ? '由服务器连接订阅地址。也可指定探针，在探针所在网络拉取后回传服务器。' : missingRelay ? '原探针已无法读取，当前选择仍会保留。请重新选择可用探针，或改为服务器直接拉取。' : relayNodeHint(selectedRelay!)}</p>
          </div>
          <div><label className={labelClass} htmlFor="subscription-source-note">备注</label><textarea id="subscription-source-note" className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="套餐、用途或其他说明" /></div>
          <div><label className={labelClass} htmlFor="subscription-source-interval">定时拉取间隔（分钟）</label><input id="subscription-source-interval" className={fieldClass} type="number" min={5} max={10080} step={1} value={interval} onChange={(e) => setInterval(e.target.value)} required /><p className={hintClass}>5 分钟到 7 天。服务器负责定时拉取，关闭页面后仍会继续。</p></div>
          <label className={checkClass}><input type="checkbox" className="size-4 accent-brand-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />启用定时拉取</label>
          <p className={hintClass}>暂停定时拉取后，已有缓存仍可用于封装，也可以手动拉取。</p>
        </fieldset>
        {error && <p role="alert" className="mt-4 break-words rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </form>
    </Modal>
  )
}

export function ProfileEditor({ profile, sources, onSave, onClose }: {
  profile: SubscriptionProfile | null
  sources: SubscriptionSource[]
  onSave: (input: ProfileInput) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(profile?.name ?? '')
  const [note, setNote] = useState(profile?.note ?? '')
  const [selected, setSelected] = useState<number[]>(profile?.source_ids ?? [])
  const [enabled, setEnabled] = useState(profile?.enabled ?? true)
  const [include, setInclude] = useState(profile?.rules.include.join('\n') ?? '')
  const [exclude, setExclude] = useState(profile?.rules.exclude.join('\n') ?? '')
  const [protocols, setProtocols] = useState<string[]>(profile?.rules.protocols.filter((p) => (SUBSCRIPTION_PROTOCOLS as readonly string[]).includes(p)) ?? [])
  const [customProtocols, setCustomProtocols] = useState(profile?.rules.protocols.filter((p) => !(SUBSCRIPTION_PROTOCOLS as readonly string[]).includes(p)).join(', ') ?? '')
  const [prefix, setPrefix] = useState(profile?.rules.name_prefix ?? '')
  const [appendSource, setAppendSource] = useState(profile?.rules.append_source ?? false)
  const [deduplicate, setDeduplicate] = useState(profile?.rules.deduplicate ?? true)
  const [routing, setRouting] = useState(profile?.rules.rules.join('\n') ?? 'MATCH,PROXY')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const missingIds = selected.filter((id) => !sources.some((source) => source.id === id))
  const toggleSource = (id: number) => setSelected((value) => value.includes(id) ? value.filter((item) => item !== id) : [...value, id])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    if (selected.length === 0) { setError('至少选择一个订阅源'); return }
    if (missingIds.length > 0) { setError('请取消已删除的订阅源，再保存配置'); return }
    submitting.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave({
        name: name.trim(), note: note.trim(), source_ids: selected, enabled,
        rules: {
          include: splitLines(include), exclude: splitLines(exclude),
          protocols: [...new Set([...protocols, ...customProtocols.split(/[,\r\n]+/).map((p) => p.trim().toLowerCase()).filter(Boolean)])],
          name_prefix: prefix, append_source: appendSource, deduplicate,
          rules: routing.trim() ? splitLines(routing) : ['MATCH,PROXY'],
        },
      })
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) setError(errorMessage(err, '保存封装配置失败'))
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return (
    <Modal open size="wide" title={profile ? '编辑封装配置' : '新建封装配置'} onClose={() => { if (!saving) onClose() }} footer={
      <><button type="button" className={btnGhost} disabled={saving} onClick={onClose}>取消</button><button type="submit" form="subscription-profile-form" className={btnPrimary} disabled={saving}>{saving ? '保存中…' : '保存配置'}</button></>
    }>
      <form id="subscription-profile-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={saving} className="space-y-5 disabled:opacity-60">
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label htmlFor="subscription-profile-name" className={labelClass}>配置名称</label><input id="subscription-profile-name" className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus placeholder="例如：日常网络" /></div>
            <div><label htmlFor="subscription-profile-note" className={labelClass}>备注</label><input id="subscription-profile-note" className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="这份配置的用途" /></div>
          </div>
          <fieldset className="rounded-2xl border border-line/15 p-3">
            <legend className="px-1 text-xs font-medium text-fg/80">选择订阅源 · 已选 {selected.length} 个</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {sources.map((source) => <label key={source.id} className={`${checkClass} min-w-0 rounded-xl bg-line/5 px-3 py-2`}><input type="checkbox" className="size-4 shrink-0 accent-brand-500" checked={selected.includes(source.id)} onChange={() => toggleSource(source.id)} /><span className="min-w-0"><span className="block break-words">{source.name}</span><span className="text-xs text-fg/45">{source.proxy_count} 个缓存节点{source.enabled ? '' : ' · 已暂停定时拉取'}</span></span></label>)}
              {missingIds.map((id) => <label key={id} className={`${checkClass} text-warn`}><input type="checkbox" checked onChange={() => toggleSource(id)} />已删除的订阅源 #{id}（取消选择）</label>)}
            </div>
            {sources.length === 0 && <p className="text-sm text-fg/55">还没有订阅源，请先添加。</p>}
          </fieldset>
          <div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label htmlFor="subscription-profile-include" className={labelClass}>包含关键词</label><textarea id="subscription-profile-include" className={fieldClass} rows={3} value={include} onChange={(e) => setInclude(e.target.value)} placeholder="香港&#10;日本" /></div>
              <div><label htmlFor="subscription-profile-exclude" className={labelClass}>排除关键词</label><textarea id="subscription-profile-exclude" className={fieldClass} rows={3} value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="过期&#10;测试" /></div>
            </div>
            <p className={hintClass}>按节点名称匹配，一行一个关键词，作为普通文本处理。包含留空保留全部；排除优先。</p>
          </div>
          <fieldset>
            <legend className={labelClass}>协议筛选（不选则保留全部）</legend>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{SUBSCRIPTION_PROTOCOLS.map((protocol) => <label key={protocol} className={`${checkClass} text-xs`}><input type="checkbox" className="size-3.5 accent-brand-500" checked={protocols.includes(protocol)} onChange={() => setProtocols((value) => value.includes(protocol) ? value.filter((item) => item !== protocol) : [...value, protocol])} />{protocol}</label>)}</div>
            <label htmlFor="subscription-profile-protocols" className={`${labelClass} mt-3`}>其他协议类型</label><input id="subscription-profile-protocols" className={fieldClass} value={customProtocols} onChange={(e) => setCustomProtocols(e.target.value)} placeholder="使用逗号分隔，例如：ssh, mieru" />
          </fieldset>
          <div><label htmlFor="subscription-profile-prefix" className={labelClass}>节点名称前缀</label><input id="subscription-profile-prefix" className={fieldClass} value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={100} placeholder="可留空，例如：[日常] " /></div>
          <div className="flex flex-wrap gap-x-6 gap-y-3"><label className={checkClass}><input type="checkbox" className="size-4 accent-brand-500" checked={appendSource} onChange={(e) => setAppendSource(e.target.checked)} />名称追加来源</label><label className={checkClass}><input type="checkbox" className="size-4 accent-brand-500" checked={deduplicate} onChange={(e) => setDeduplicate(e.target.checked)} />去除重复节点</label></div>
          <div><label htmlFor="subscription-profile-rules" className={labelClass}>自定义路由规则</label><textarea id="subscription-profile-rules" className={`${fieldClass} font-mono text-xs`} value={routing} onChange={(e) => setRouting(e.target.value)} rows={5} spellCheck={false} placeholder="MATCH,PROXY" /><p className={hintClass}>每行一条 Clash 规则，仅用于 YAML。留空使用 MATCH,PROXY；可使用 PROXY、DIRECT、REJECT。</p></div>
          <label className={checkClass}><input type="checkbox" className="size-4 accent-brand-500" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />启用分享链接</label>
          <p className={hintClass}>停用后分享链接不可访问，管理页面仍可预览。</p>
        </fieldset>
        {error && <p role="alert" className="mt-4 break-words rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </form>
    </Modal>
  )
}
