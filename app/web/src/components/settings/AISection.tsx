import { useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { errorMessage } from '../../lib/api.ts'
import {
  DEEPSEEK_PRESET, aiSettingsInputError, subscriptions,
  type SubscriptionAISettings, type SubscriptionAISettingsInput,
} from '../../lib/subscriptions.ts'
import { btnGhost, btnPrimary, fieldClass, labelClass } from '../Modal.tsx'
import { SettingsSection } from './Section.tsx'

export function AISection() {
  const [settings, setSettings] = useState<SubscriptionAISettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    subscriptions.aiSettings(controller.signal).then(({ settings: value }) => {
      if (!controller.signal.aborted) setSettings(value)
    }).catch((err) => {
      if (!controller.signal.aborted) setError(errorMessage(err, '读取 AI 配置失败'))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reload])

  return <SettingsSection id="ai" description="预置 DeepSeek，也可连接自定义 OpenAI 兼容接口，用于首页图标整理与订阅路由配置">
    {loading && <p role="status" className="flex items-center gap-2 text-sm text-fg/60"><Loader2 className="size-4 animate-spin" aria-hidden />正在读取 AI 配置…</p>}
    {error && <div role="alert" className="space-y-3"><p className="break-words text-sm text-danger">{error}</p><button type="button" className={btnGhost} onClick={() => setReload((value) => value + 1)}>重新读取</button></div>}
    {!loading && !error && settings && <AISettingsForm settings={settings} onSaved={setSettings} />}
  </SettingsSection>
}

function AISettingsForm({ settings, onSaved }: { settings: SubscriptionAISettings; onSaved: (settings: SubscriptionAISettings) => void }) {
  const [provider, setProvider] = useState(settings.provider)
  const [baseUrl, setBaseUrl] = useState(settings.base_url)
  const [model, setModel] = useState(settings.model)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort(); request.current = null }, [])

  function edited() { setNotice(null); setError(null) }

  async function save(testConnection: boolean) {
    if (request.current) return
    const input: SubscriptionAISettingsInput = {
      provider, base_url: baseUrl.trim(), model: model.trim(),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      ...(clearKey ? { clear_api_key: true } : {}),
    }
    const invalid = aiSettingsInputError(input, settings)
    if (invalid) { setError(invalid); return }
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    edited()
    let savedSuccessfully = false
    try {
      const { settings: saved } = await subscriptions.saveAISettings(input, controller.signal)
      if (controller.signal.aborted) return
      savedSuccessfully = true
      setApiKey('')
      setClearKey(false)
      setProvider(saved.provider)
      setBaseUrl(saved.base_url)
      setModel(saved.model)
      onSaved(saved)
      if (testConnection) {
        if (!saved.configured) { setNotice('配置已保存；填写 API Key 后可测试连接。'); return }
        setNotice('配置已保存，正在测试连接…')
        const result = await subscriptions.testAI(controller.signal)
        if (!controller.signal.aborted) setNotice(result.message || `连接成功 · ${result.model}`)
      } else setNotice('接口配置已保存，可使用首页 AI 整理和订阅 AI 路由助手。')
    } catch (err) {
      if (!controller.signal.aborted) {
        setNotice(null)
        const message = errorMessage(err, savedSuccessfully ? '连接测试失败' : '保存接口设置失败')
        setError(savedSuccessfully ? `接口配置已保存，但连接测试未通过：${message}` : message)
      }
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }

  return <form id="subscription-ai-settings" className="min-w-0" onSubmit={(event) => { event.preventDefault(); void save(false) }}>
    <fieldset disabled={busy} className="min-w-0 space-y-4 disabled:opacity-60">
      <div className="break-words rounded-xl border border-brand-500/20 bg-brand-500/5 p-3 text-xs leading-relaxed text-fg/65">
        {settings.configured ? `当前已配置 ${settings.provider === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容接口'} · ${settings.model}。` : settings.provider === 'deepseek' ? 'DeepSeek 的接口地址和模型已预置，填写你的 API Key 后即可使用。' : '兼容接口的地址和模型已保存，填写你的 API Key 后即可使用。'}
        <span className="mt-1 block">此处需要点击保存；AI 配置仅用于当前账号。</span>
      </div>
      <div><label htmlFor="subscription-ai-provider" className={labelClass}>AI 服务</label><select id="subscription-ai-provider" className={fieldClass} value={provider} onChange={(event) => {
        const value = event.target.value as SubscriptionAISettings['provider']
        setProvider(value); setApiKey(''); setClearKey(false); edited()
        if (value === 'deepseek') { setBaseUrl(DEEPSEEK_PRESET.base_url); setModel(DEEPSEEK_PRESET.model) }
        else { setBaseUrl(''); setModel('') }
      }}><option value="deepseek">DeepSeek（已预置）</option><option value="openai-compatible">其他 OpenAI 兼容接口</option></select></div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0"><label htmlFor="subscription-ai-endpoint" className={labelClass}>接口地址</label><input id="subscription-ai-endpoint" className={fieldClass} inputMode="url" maxLength={2048} value={baseUrl} autoComplete="off" spellCheck={false} onChange={(event) => { setBaseUrl(event.target.value); edited() }} placeholder="https://api.example.com/v1" /><p className="mt-1.5 text-xs leading-relaxed text-fg/50">填写基础地址，系统会请求 Chat Completions。{provider === 'deepseek' ? 'DeepSeek 预设使用官方地址。' : ''}</p></div>
        <div className="min-w-0"><label htmlFor="subscription-ai-model" className={labelClass}>模型名称</label><input id="subscription-ai-model" className={fieldClass} maxLength={200} value={model} list={provider === 'deepseek' ? 'subscription-deepseek-models' : undefined} autoComplete="off" onChange={(event) => { setModel(event.target.value); edited() }} placeholder={provider === 'deepseek' ? 'deepseek-flash' : '填写服务商提供的模型 ID'} /><datalist id="subscription-deepseek-models"><option value="deepseek-flash" /><option value="deepseek-v4-pro" /></datalist></div>
      </div>
      <div><label htmlFor="subscription-ai-key" className={labelClass}>API Key{settings.has_api_key && <span className="ml-2 font-normal text-success">已保存</span>}</label><input id="subscription-ai-key" className={fieldClass} type="password" autoComplete="new-password" maxLength={4096} value={apiKey} disabled={clearKey} onChange={(event) => { setApiKey(event.target.value); edited() }} placeholder={settings.has_api_key ? '留空保留当前密钥；更换地址时需重新填写' : '填写你的 API Key'} /><p className="mt-1.5 text-xs leading-relaxed text-fg/50">密钥在服务端加密保存，保存后输入框会清空。更换服务或接口地址时，请填写新密钥，或明确清除已保存密钥。</p></div>
      {settings.has_api_key && <label className="flex items-center gap-2 text-xs text-fg/65"><input type="checkbox" className="size-4 accent-brand-500" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); setApiKey(''); edited() }} />清除已保存密钥</label>}
      <div className="flex flex-wrap gap-2"><button type="submit" className={btnPrimary}>{busy ? '处理中…' : '保存接口设置'}</button><button type="button" className={`${btnGhost} flex items-center gap-1.5`} onClick={() => void save(true)}><Check className="size-4" aria-hidden />保存并测试连接</button></div>
    </fieldset>
    {error && <p role="alert" className="mt-3 break-words rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="mt-3 break-words text-sm text-success">{notice}</p>}
  </form>
}
