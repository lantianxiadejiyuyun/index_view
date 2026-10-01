import { useEffect, useRef, useState } from 'react'
import { btnGhost, btnPrimary, fieldClass, labelClass } from '../Modal.tsx'
import { errorMessage } from '../../lib/api.ts'
import {
  RULE_IMPORT_POLICIES, canApplyImportedRules,
  ruleImportContentError, ruleImportFileError, subscriptions,
  type RuleImportPolicy, type RuleImportResult,
} from '../../lib/subscriptions.ts'

export function RuleImport({ existingRuleCount, onApply }: { existingRuleCount: number; onApply: (rules: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [defaultPolicy, setDefaultPolicy] = useState<RuleImportPolicy>('PROXY')
  const [policyMap, setPolicyMap] = useState<Record<string, RuleImportPolicy>>({})
  const [analysis, setAnalysis] = useState<{ revision: number; output: RuleImportResult } | null>(null)
  const [revision, setRevision] = useState(0)
  const [analyzing, setAnalyzing] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const currentRevision = useRef(0)
  const request = useRef<AbortController | null>(null)
  const fileReader = useRef<FileReader | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      currentRevision.current++
      request.current?.abort()
      fileReader.current?.abort()
    }
  }, [])

  function invalidate() {
    const next = ++currentRevision.current
    request.current?.abort()
    request.current = null
    fileReader.current?.abort()
    fileReader.current = null
    setRevision(next)
    setAnalyzing(false)
    setReading(false)
    setError(null)
    setNotice(null)
    return next
  }

  function close() {
    invalidate()
    setOpen(false)
  }

  function readFile(file: File) {
    const version = invalidate()
    const invalid = ruleImportFileError(file)
    if (invalid) { setError(invalid); return }
    const reader = new FileReader()
    fileReader.current = reader
    setReading(true)
    reader.onload = () => {
      if (!mounted.current || currentRevision.current !== version || fileReader.current !== reader) return
      fileReader.current = null
      setReading(false)
      const text = typeof reader.result === 'string' ? reader.result : ''
      const invalidContent = ruleImportContentError(text)
      if (invalidContent) { setError(invalidContent); return }
      setContent(text)
      setPolicyMap({})
      setAnalysis(null)
    }
    reader.onerror = () => {
      if (!mounted.current || currentRevision.current !== version || fileReader.current !== reader) return
      fileReader.current = null
      setReading(false)
      setError('无法读取规则文件，请重新选择或直接粘贴内容')
    }
    reader.readAsText(file, 'utf-8')
  }

  async function analyze() {
    if (request.current || reading) return
    const invalid = ruleImportContentError(content)
    if (invalid) { setError(invalid); return }
    const version = currentRevision.current
    const controller = new AbortController()
    request.current = controller
    setAnalyzing(true)
    setError(null)
    setNotice(null)
    try {
      const output = await subscriptions.importRules({ content, policy_map: policyMap, default_policy: defaultPolicy }, controller.signal)
      if (mounted.current && !controller.signal.aborted && version === currentRevision.current) setAnalysis({ revision: version, output })
    } catch (err) {
      if (mounted.current && !controller.signal.aborted && version === currentRevision.current) setError(errorMessage(err, '规则分析失败'))
    } finally {
      if (request.current === controller) {
        request.current = null
        if (mounted.current) setAnalyzing(false)
      }
    }
  }

  const output = analysis?.output
  const stale = analysis !== null && analysis.revision !== revision
  const canApply = Boolean(output && canApplyImportedRules(output) && !stale && !analyzing && !reading && !error)
  function apply() {
    if (!canApply || !analysis || analysis.revision !== currentRevision.current) return
    const rules = [...analysis.output.rules]
    close()
    onApply(rules)
    setNotice(`已替换为 ${rules.length} 条规则，保存配置后才会生效。`)
  }

  return <section className="mt-3 rounded-xl border border-line/15 p-3">
    <button type="button" className={`${btnGhost} px-2.5 py-1.5 text-xs`} aria-expanded={open} aria-controls="subscription-rule-import-panel" onClick={() => open ? close() : setOpen(true)}>{open ? '收起规则导入' : '导入 YAML / 文本'}</button>
    {notice && <p role="status" className="mt-2 text-xs text-success">{notice}</p>}
    {open && <div id="subscription-rule-import-panel" className="mt-3 space-y-3">
      <p className="text-xs leading-relaxed text-fg/55">支持 Clash YAML、规则列表与纯文本，只导入路由规则，不导入节点、DNS 或分组。文件或粘贴内容最大 1 MiB；应用后还需保存当前配置。</p>
      <div><label htmlFor="subscription-rule-import-file" className={labelClass}>选择规则文件</label><input id="subscription-rule-import-file" type="file" accept=".yaml,.yml,.txt" className="block w-full text-xs text-fg/65 file:mr-3 file:rounded-lg file:border-0 file:bg-line/10 file:px-3 file:py-2 file:text-fg" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) readFile(file) }} />{reading && <p role="status" className="mt-1 text-xs text-fg/55">正在读取文件…</p>}</div>
      <div><label htmlFor="subscription-rule-import-content" className={labelClass}>或粘贴 YAML / 规则文本</label><textarea id="subscription-rule-import-content" className={`${fieldClass} font-mono text-xs`} rows={5} value={content} spellCheck={false} placeholder={'rules:\n  - DOMAIN-SUFFIX,example.com,快雷GO\n  - MATCH,快雷GO'} onChange={(event) => { invalidate(); setContent(event.target.value); setPolicyMap({}); setAnalysis(null) }} /></div>
      <div><label htmlFor="subscription-rule-import-default" className={labelClass}>缺失策略及兜底规则</label><select id="subscription-rule-import-default" className={fieldClass} value={defaultPolicy} onChange={(event) => { invalidate(); setDefaultPolicy(event.target.value as RuleImportPolicy) }}>{RULE_IMPORT_POLICIES.map((policy) => <option key={policy} value={policy}>{policy}</option>)}</select><p className="mt-1 text-xs text-fg/50">未知分组（例如“快雷GO”）默认映射到 PROXY，分析后可逐项调整。修改内容或策略后需重新分析。</p></div>
      <button type="button" className={`${btnGhost} text-xs`} disabled={analyzing || reading} onClick={() => void analyze()}>{analyzing ? '正在分析…' : analysis ? '重新分析规则' : '分析规则'}</button>
      {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
      {output && <div className="space-y-3">
        <p role="status" className={`text-xs ${stale ? 'text-warn' : 'text-fg/70'}`}>{stale ? '上次分析结果已过期，请重新分析。' : `原始 ${output.total} 条规则，应用后 ${output.imported} 条（含兜底规则）。`}</p>
        {output.policies.length > 0 && <fieldset className="space-y-2"><legend className={`${labelClass} mb-2`}>策略映射</legend>{output.policies.map((policy, index) => {
          const builtIn = (RULE_IMPORT_POLICIES as readonly string[]).includes(policy.name)
          return <div key={policy.name} className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2"><label htmlFor={`subscription-rule-policy-${index}`} className="break-words text-xs text-fg/70">{policy.name || '未指定策略'} <span className="text-fg/45">（{policy.count} 条{builtIn ? ' · 固定策略' : ''}）</span></label><select id={`subscription-rule-policy-${index}`} className={`${fieldClass} text-xs`} disabled={builtIn} value={!builtIn && Object.hasOwn(policyMap, policy.name) ? policyMap[policy.name] : policy.target} onChange={(event) => { if (builtIn) return; invalidate(); setPolicyMap((current) => ({ ...current, [policy.name]: event.target.value as RuleImportPolicy })) }}>{RULE_IMPORT_POLICIES.map((target) => <option key={target} value={target}>{target}</option>)}</select></div>
        })}</fieldset>}
        {output.diagnostics.length > 0 && <ul className="max-h-44 space-y-1 overflow-auto rounded-lg bg-line/5 p-2 text-xs" aria-label="规则导入诊断">{output.diagnostics.map((item, index) => <li key={`${item.code}-${index}`} className={`break-words ${item.level === 'error' ? 'text-danger' : item.level === 'warning' ? 'text-warn' : 'text-fg/60'}`}>{item.line ? `第 ${item.line} 行${item.column ? `，第 ${item.column} 列` : ''}：` : ''}{item.level === 'error' ? '错误：' : item.level === 'warning' ? '提示：' : ''}{item.message}</li>)}</ul>}
        <pre className="max-h-44 overflow-auto rounded-lg bg-line/5 p-2 font-mono text-[11px] text-fg/75" aria-label="待导入规则预览">{output.rules.join('\n') || '没有可导入规则'}</pre>
        {!canApplyImportedRules(output) && !stale && <p className="text-xs text-danger">请先修正错误并重新分析，不会导入部分规则。</p>}
        <button type="button" className={`${btnPrimary} text-xs`} disabled={!canApply} onClick={apply}>应用规则（替换当前 {existingRuleCount} 条）</button>
      </div>}
    </div>}
  </section>
}
