import { useEffect, useRef, useState } from 'react'
import { Sparkles, Settings2, RefreshCw } from 'lucide-react'
import { btnGhost, btnPrimary, fieldClass, labelClass } from '../Modal.tsx'
import { errorMessage } from '../../lib/api.ts'
import {
  AI_ROUTING_TEMPLATES, canApplyAIRules, subscriptions,
  type SubscriptionAIResult, type SubscriptionAISettings,
} from '../../lib/subscriptions.ts'

export function AIRulesAssistant({ currentRules, onApply }: { currentRules: string[]; onApply: (rules: string[]) => void }) {
  const [settings, setSettings] = useState<SubscriptionAISettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [includeCurrent, setIncludeCurrent] = useState(true)
  const [generation, setGeneration] = useState<{ fingerprint: string; output: SubscriptionAIResult } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const fingerprint = JSON.stringify({ prompt, rules: currentRules, includeCurrent, settings })
  const latestFingerprint = useRef(fingerprint)
  latestFingerprint.current = fingerprint

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    subscriptions.aiSettings(controller.signal).then(({ settings: value }) => {
      if (controller.signal.aborted) return
      setSettings(value)
    }).catch((err) => {
      if (!controller.signal.aborted) setLoadError(errorMessage(err, '读取 AI 配置失败'))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])

  useEffect(() => {
    const refresh = () => setReload(value => value + 1)
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible) }
  }, [])

  useEffect(() => {
    request.current?.abort()
    request.current = null
    setGenerating(false)
    setGeneration(null)
    setError(null)
    return () => { request.current?.abort(); request.current = null }
  }, [fingerprint])

  async function generate() {
    if (request.current || loading || loadError || !settings?.configured || !prompt.trim()) return
    const controller = new AbortController()
    const snapshot = fingerprint
    request.current = controller
    setGenerating(true)
    setGeneration(null)
    setError(null)
    setNotice(null)
    try {
      const output = await subscriptions.generateRules({ prompt, ...(includeCurrent ? { current_rules: currentRules } : {}) }, controller.signal)
      if (!controller.signal.aborted && latestFingerprint.current === snapshot) setGeneration({ fingerprint: snapshot, output })
    } catch (err) {
      if (!controller.signal.aborted && latestFingerprint.current === snapshot) setError(errorMessage(err, '生成规则失败'))
    } finally {
      if (request.current === controller) { request.current = null; setGenerating(false) }
    }
  }

  function cancel() {
    request.current?.abort()
    request.current = null
    setGenerating(false)
    setNotice('已取消等待；已有规则保持不变。')
  }

  const output = generation?.fingerprint === fingerprint ? generation.output : null
  return <section className="min-w-0 space-y-3 rounded-2xl border border-brand-500/25 bg-brand-500/5 p-3 sm:p-4" aria-label="AI 路由助手">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h4 className="flex items-center gap-2 text-sm font-semibold text-fg"><Sparkles className="size-4 shrink-0 text-brand-500" aria-hidden />AI 路由助手</h4><p className="mt-1 break-words text-xs text-fg/55">{loading ? '正在读取配置…' : settings?.configured ? `${settings.provider === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容接口'} · ${settings.model}` : '已预置 DeepSeek，添加 API Key 即可开始'}</p></div>
      <div className="flex flex-wrap gap-2"><a href="/settings/ai" target="_blank" rel="noopener noreferrer" className={`${btnGhost} flex items-center gap-1.5 px-3 text-xs`}><Settings2 className="size-3.5" aria-hidden />AI 配置<span className="sr-only">（新标签页）</span></a><button type="button" className={`${btnGhost} px-3`} disabled={loading} aria-label="刷新 AI 配置" onClick={() => setReload(value => value + 1)}><RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden /></button></div>
    </div>
    {loadError && <div role="alert" className="space-y-2 text-xs text-danger"><p>{loadError}</p><button type="button" className={btnGhost} onClick={() => setReload((value) => value + 1)}>重新读取</button></div>}
    <p className="text-xs leading-relaxed text-fg/50">接口与密钥在设置页统一管理。配置将在新标签页打开，保留当前草稿；返回后自动刷新。</p>
    <div><label htmlFor="subscription-ai-prompt" className={labelClass}>用一句话描述分流需求</label><textarea id="subscription-ai-prompt" className={fieldClass} rows={3} value={prompt} maxLength={8000} onChange={(event) => { setPrompt(event.target.value); setNotice(null) }} placeholder="例如：GitHub 走代理，国内网站和局域网直连，其他流量走代理" /></div>
    <div className="flex flex-wrap gap-2" aria-label="分流需求示例">{AI_ROUTING_TEMPLATES.map((item) => <button type="button" key={item.label} className="min-h-10 rounded-lg border border-line/15 px-3 py-2 text-xs text-fg/70 transition hover:bg-line/10" onClick={() => { setPrompt(item.prompt); setNotice(null) }}>{item.label}</button>)}</div>
    <label className="flex items-center gap-2 text-xs text-fg/75"><input type="checkbox" className="size-4 accent-brand-500" checked={includeCurrent} onChange={(event) => { setIncludeCurrent(event.target.checked); setNotice(null) }} />基于当前分流规则修改</label>
    <p className="text-xs leading-relaxed text-fg/50">仅发送你填写的需求，以及勾选后的当前分流规则；不附带订阅地址或节点密钥。生成结果需检查并应用，再保存配置。</p>
    <div className="flex flex-wrap gap-2"><button type="button" className={`${btnPrimary} text-xs`} disabled={loading || !!loadError || !settings?.configured || !prompt.trim() || generating} onClick={() => void generate()}>{generating ? '正在生成并检查…' : '生成路由规则'}</button>{generating && <button type="button" className={`${btnGhost} text-xs`} onClick={cancel}>取消等待</button>}</div>
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    {notice && <p role="status" className="break-words text-xs text-success">{notice}</p>}
    {output && <div className="min-w-0 space-y-3 rounded-xl border border-line/15 bg-line/5 p-3">
      <div><p className="text-xs font-medium text-fg">待应用 · {output.rules.length} 条规则</p>{output.summary && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg/70">{output.summary}</p>}</div>
      {output.diagnostics.length > 0 && <ul className="max-h-40 space-y-1 overflow-auto text-xs" aria-label="AI 规则检查结果">{output.diagnostics.map((item, index) => <li key={`${item.code}-${index}`} className={`break-words ${item.level === 'error' ? 'text-danger' : item.level === 'warning' ? 'text-warn' : 'text-fg/60'}`}>{item.line ? `第 ${item.line} 行：` : ''}{item.message}</li>)}</ul>}
      <pre className="max-h-52 overflow-auto rounded-lg bg-line/5 p-2 text-[11px] text-fg/75" aria-label="AI 生成规则预览">{output.rules.join('\n') || '本次结果未通过检查，请调整需求后重试。'}</pre>
      <button type="button" className={`${btnPrimary} text-xs`} disabled={!canApplyAIRules(output)} onClick={() => {
        if (!generation || generation.fingerprint !== latestFingerprint.current || !canApplyAIRules(generation.output)) return
        onApply([...generation.output.rules])
        setGeneration(null)
        setNotice(`已替换当前 ${currentRules.length} 条规则；保存配置后生效。`)
      }}>应用到当前草稿</button>
    </div>}
  </section>
}
