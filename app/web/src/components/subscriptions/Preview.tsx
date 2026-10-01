import { useEffect, useState } from 'react'
import { Copy, Download, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Modal, btnGhost, fieldClass } from '../Modal.tsx'
import { errorMessage } from '../../lib/api.ts'
import { OUTPUT_FORMATS, subscriptionFeedUrl, subscriptions, type SubscriptionFormat, type SubscriptionOutput, type SubscriptionProfile } from '../../lib/subscriptions.ts'
import { toast } from '../../store/toast.ts'

/** HTTP 内网部署可能没有 Clipboard API，仍允许用户复制订阅链接。 */
export async function copySubscriptionText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch { /* 浏览器拒绝 Clipboard API 时使用当前用户操作的复制路径。 */ }
  const previous = document.activeElement
  const input = document.createElement('textarea')
  input.value = text
  input.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0'
  document.body.append(input)
  input.select()
  try {
    if (!document.execCommand('copy')) throw new Error('复制失败，请手动选择内容复制')
  } finally {
    input.remove()
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
  }
}

export function OutputWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return <details className="rounded-xl border border-warn/20 bg-warn/10 px-3 py-2 text-xs text-warn"><summary className="cursor-pointer font-medium"><TriangleAlert className="mr-1 inline size-3.5" aria-hidden />{warnings.length} 条提示</summary><ul className="mt-2 max-h-40 list-disc space-y-1 overflow-auto pl-4">{warnings.map((warning, index) => <li key={index} className="break-words leading-relaxed">{warning}</li>)}</ul></details>
}

export function SubscriptionPreview({ profile, onClose }: { profile: SubscriptionProfile; onClose: () => void }) {
  const [format, setFormat] = useState<SubscriptionFormat>('clash')
  const [response, setResponse] = useState<{ format: SubscriptionFormat; output: SubscriptionOutput } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const output = response?.format === format ? response.output : null

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setResponse(null)
    setError(null)
    void subscriptions.preview(profile.id, format, controller.signal).then((value) => {
      if (!controller.signal.aborted) setResponse({ format, output: value })
    }).catch((err) => {
      if (!controller.signal.aborted) setError(errorMessage(err, '生成预览失败'))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [profile.id, format, revision])

  async function copy(value: string, label: string) {
    try { await copySubscriptionText(value); toast.success(`${label}已复制`) }
    catch (err) { toast.error(errorMessage(err, '复制失败')) }
  }

  function download() {
    if (!output || output.proxy_count === 0) return
    const extension = OUTPUT_FORMATS.find((item) => item.value === format)?.extension ?? 'txt'
    const filename = profile.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100) || 'subscription'
    const url = URL.createObjectURL(new Blob([output.content], { type: output.content_type || 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${filename}-${format}.${extension}`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <Modal open size="wide" title={`预览 · ${profile.name}`} onClose={onClose} footer={<button type="button" className={btnGhost} onClick={onClose}>关闭</button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="输出格式">{OUTPUT_FORMATS.map((item) => <button key={item.value} type="button" aria-pressed={format === item.value} onClick={() => setFormat(item.value)} className={`rounded-xl border px-3 py-2 text-xs transition ${format === item.value ? 'border-brand-500/50 bg-brand-500/15 text-brand-500' : 'border-line/15 text-fg/65 hover:bg-line/10'}`}>{item.label}</button>)}</div>
        <div>
          <label htmlFor="subscription-preview-url" className="mb-1.5 block text-xs font-medium text-fg/65">当前格式的订阅链接{profile.enabled ? '' : '（分享已停用）'}</label>
          <div className="flex gap-2"><input id="subscription-preview-url" className={`${fieldClass} min-w-0 font-mono text-xs`} readOnly value={subscriptionFeedUrl(profile.token, format)} onFocus={(e) => e.target.select()} /><button type="button" className={`${btnGhost} shrink-0 px-3`} onClick={() => void copy(subscriptionFeedUrl(profile.token, format), '订阅链接')} aria-label="复制订阅链接"><Copy className="size-4" aria-hidden /></button></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-fg/60">{loading ? '正在生成预览…' : output ? `${output.proxy_count} 个输出节点` : '预览不可用'}</p>
          <div className="flex gap-2"><button type="button" className={`${btnGhost} px-2.5 py-1.5 text-xs`} disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw className="mr-1 inline size-3.5" aria-hidden />重新生成</button><button type="button" className={`${btnGhost} px-2.5 py-1.5 text-xs`} disabled={!output || output.proxy_count === 0 || loading} onClick={() => { if (output && output.proxy_count > 0) void copy(output.content, '预览内容') }}><Copy className="mr-1 inline size-3.5" aria-hidden />复制内容</button><button type="button" className={`${btnGhost} px-2.5 py-1.5 text-xs`} disabled={!output || output.proxy_count === 0 || loading} onClick={download}><Download className="mr-1 inline size-3.5" aria-hidden />下载</button></div>
        </div>
        {error && <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{error}</p>}
        {loading ? <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-fg/55"><Loader2 className="size-5 animate-spin" aria-hidden />正在读取缓存并生成配置</div> : output && <>
          <OutputWarnings warnings={output.warnings} />
          {output.proxy_count === 0 && <p className="rounded-xl bg-line/5 p-3 text-sm text-fg/60">没有可输出的节点，请检查订阅源缓存、关键词和协议筛选。</p>}
          <pre tabIndex={0} aria-label="订阅输出内容" className="max-h-[45dvh] min-h-40 overflow-auto rounded-2xl border border-line/15 bg-line/5 p-3 font-mono text-[11px] leading-relaxed text-fg/85 sm:p-4">{output.content || '（空内容）'}</pre>
        </>}
      </div>
    </Modal>
  )
}
