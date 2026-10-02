import { useEffect, useRef, useState } from 'react'
import { btnGhost, fieldClass, labelClass } from '../Modal.tsx'
import { errorMessage } from '../../lib/api.ts'
import { OUTPUT_FORMATS, subscriptions, type ProfileInput, type SubscriptionFormat, type SubscriptionOutput } from '../../lib/subscriptions.ts'

export function DraftPreview({ input, missingSources }: { input: ProfileInput; missingSources: boolean }) {
  const [format, setFormat] = useState<SubscriptionFormat>('clash')
  const [result, setResult] = useState<{ fingerprint: string; output: SubscriptionOutput } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const fingerprint = JSON.stringify({ input, format })
  const latestFingerprint = useRef(fingerprint)
  latestFingerprint.current = fingerprint
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    request.current?.abort()
    request.current = null
    setBusy(false)
    setError(null)
    return () => { request.current?.abort(); request.current = null }
  }, [fingerprint])
  const output = result?.fingerprint === fingerprint ? result.output : null

  async function preview() {
    if (request.current || !input.name || !input.source_ids.length || missingSources) return
    const controller = new AbortController()
    const snapshot = fingerprint
    request.current = controller
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const value = await subscriptions.previewDraft(input, format, controller.signal)
      if (!controller.signal.aborted && latestFingerprint.current === snapshot) { setResult({ fingerprint: snapshot, output: value }); setChecked(true) }
    } catch (err) {
      if (!controller.signal.aborted && latestFingerprint.current === snapshot) setError(errorMessage(err, '检查草稿失败'))
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }

  return <div className="min-w-0 space-y-3">
    <p className="text-xs leading-relaxed text-fg/55">使用现有节点缓存检查规则和输出，不触发订阅拉取，也不会保存草稿。</p>
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end"><div className="min-w-0 flex-1"><label htmlFor="subscription-draft-format" className={labelClass}>输出格式</label><select id="subscription-draft-format" className={fieldClass} value={format} onChange={(event) => setFormat(event.target.value as SubscriptionFormat)}>{OUTPUT_FORMATS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div><button type="button" className={`${btnGhost} shrink-0 text-xs`} disabled={busy || !input.name || !input.source_ids.length || missingSources} onClick={() => void preview()}>{busy ? '正在检查…' : checked ? '重新检查草稿' : '检查并预览'}</button></div>
    {(!input.name || !input.source_ids.length || missingSources) && <p className="text-xs text-fg/50">先填写配置名称，并选择有效订阅源后即可检查。</p>}
    {checked && !output && !busy && !error && <p role="status" className="text-xs text-warn">草稿已修改，请重新检查最新输出。</p>}
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    {output && <div className="min-w-0 space-y-2 rounded-xl border border-line/15 bg-line/5 p-3">
      <p role="status" className={`text-xs font-medium ${output.proxy_count ? 'text-success' : 'text-warn'}`}>检查完成 · 输出 {output.proxy_count} 个节点{format === 'clash' ? ` · ${input.rules.rules.length} 条路由规则` : ' · 链接格式不包含路由规则'}</p>
      {output.warnings.length > 0 && <ul className="max-h-36 space-y-1 overflow-auto text-xs text-warn" aria-label="草稿检查提示">{output.warnings.map((warning, index) => <li className="break-words" key={index}>{warning}</li>)}</ul>}
      <details><summary className="cursor-pointer py-2 text-xs text-fg/70">查看输出内容</summary><pre className="max-h-64 overflow-auto rounded-lg bg-line/5 p-2 text-[11px] text-fg/70" aria-label="封装草稿预览">{output.content}</pre></details>
    </div>}
  </div>
}
