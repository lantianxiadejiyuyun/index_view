import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowUpRight, CheckCircle2, KeyRound, Loader2, ShieldCheck, Unplug } from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import { lingxi, type LingxiSettings } from '../../lib/lingxi.ts'
import { useApp } from '../../store/app.ts'
import { btnDanger, btnGhost, btnPrimary, fieldClass, labelClass } from '../Modal.tsx'
import { notifyLingxiChanged } from '../lingxi/shared.tsx'
import { LingxiVaultPanel } from '../lingxi/LingxiVaultPanel.tsx'
import { SettingsSection } from './Section.tsx'
import { ToggleField } from './controls.tsx'
import { useSettingsSave } from './saver.tsx'

type VaultGrant = { enabled: boolean; grant_id: string | null; status: 'disabled' | 'awaiting_extension' | 'ready'; item_count: number; snapshot_version: number | null; source_version: number | null; updated_at: string | null; authorized_at: string | null; scope: 'all'; can_decrypt: boolean }

export function LingxiSection() {
  const user = useApp(state => state.user)
  return user ? <LingxiSettingsContent key={user.id} /> : null
}

function LingxiSettingsContent() {
  const location = useLocation()
  const [settings, setSettings] = useState<LingxiSettings | null>(null), [grant, setGrant] = useState<VaultGrant | null>(null)
  const [baseUrl, setBaseUrl] = useState(''), [token, setToken] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [grantBusy, setGrantBusy] = useState(false)
  const [error, setError] = useState(''), [grantError, setGrantError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0), [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const request = useRef<AbortController | null>(null)
  const preferences = useApp(state => state.settings), { save } = useSettingsSave()
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (loading || location.hash !== '#lingxi-vault') return
    const frame = requestAnimationFrame(() => document.getElementById('lingxi-vault')?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [loading, location.hash])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setGrantError(''); setGrant(null)
    lingxi.settings(controller.signal).then(value => { if (!controller.signal.aborted) { setSettings(value); setBaseUrl(value.base_url ?? '') } }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    api<VaultGrant>('/api/lingxi/vault/settings', {}, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setGrant(value) }).catch(err => { if (!controller.signal.aborted) setGrantError(errorMessage(err)) })
    return () => controller.abort()
  }, [reload])

  async function connect() {
    if (busy) return
    setError(''); setNotice(''); setConfirmDisconnect(false)
    let address: URL
    try { address = new URL(baseUrl.trim()); if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error() } catch { setError('请输入完整的灵犀后台地址，不含账号密码、查询参数或片段'); return }
    if ((!settings?.has_token || baseUrl.trim().replace(/\/$/, '') !== settings.base_url.replace(/\/$/, '')) && !token.trim()) { setError('首次连接或更换地址时，请填写灵犀 API Token'); return }
    const controller = new AbortController(); request.current = controller; setBusy(true)
    try {
      const saved = await lingxi.saveSettings({ base_url: baseUrl.trim(), ...(token.trim() ? { api_token: token.trim() } : {}) }, controller.signal)
      if (!controller.signal.aborted) { setSettings(saved); setGrant(null); setBaseUrl(saved.base_url); setToken(''); setNotice(`已连接 ${saved.user?.display_name || saved.user?.username || '灵犀账号'}，后续登录导航站即可使用。`); notifyLingxiChanged(); setReload(value => value + 1) }
    } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)) } finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function disconnect() {
    if (busy) return
    if (!confirmDisconnect) { setConfirmDisconnect(true); return }
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(''); setNotice('')
    try { await lingxi.disconnect(controller.signal); if (!controller.signal.aborted) { setToken(''); setGrant(null); setSettings({ configured: false, base_url: '', has_token: false, user: null, updated_at: null }); setConfirmDisconnect(false); setNotice('已解除绑定，并撤销灵犀读取密码的授权。'); notifyLingxiChanged(); setReload(value => value + 1) } } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)) } finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function toggleGrant(enabled: boolean) {
    if (grantBusy) return
    setGrantBusy(true); setGrantError('')
    try { const value = await api<VaultGrant>('/api/lingxi/vault/settings', { method: 'PUT', body: JSON.stringify({ enabled }) }); setGrant(value) } catch (err) { setGrantError(errorMessage(err)) } finally { setGrantBusy(false) }
  }
  return <SettingsSection id="lingxi" description="连接灵犀账号，在导航站使用日程、待办与 AI 对话。">
    <div className="lingxi-settings">
      <section className="lingxi-setting-panel" aria-labelledby="lingxi-connection-heading">
        <h3 id="lingxi-connection-heading" className="lingxi-setting-heading"><CheckCircle2 size={17} />账号连接</h3>
        {loading && !settings ? <p role="status" className="flex items-center gap-2 text-sm text-fg/65"><Loader2 size={16} className="animate-spin" />正在读取连接设置…</p> : <>
          <div className="lingxi-connection-status">
            <div className="lingxi-connection-copy"><CheckCircle2 size={21} className={settings?.configured ? 'text-success' : 'text-fg/40'} /><div><p className="lingxi-connection-name">{settings?.configured ? `已绑定 · ${settings.user?.display_name || settings.user?.username || '灵犀账号'}` : '尚未连接灵犀'}</p><p className="lingxi-setting-hint">{settings?.configured ? '登录导航站即可继续使用，无需重复登录灵犀。' : '从灵犀的账号设置中复制 API Token，在此连接一次。'}</p></div></div>
            {settings?.configured && <Link className={`${btnGhost} flex items-center gap-2`} to="/lingxi">打开灵犀工作区<ArrowUpRight size={16} /></Link>}
          </div>
          <form className="lingxi-settings-form" onSubmit={event => { event.preventDefault(); void connect() }}><fieldset disabled={busy || loading} className="disabled:opacity-60">
            <div><label className={labelClass} htmlFor="lingxi-base-url">灵犀后台地址</label><input id="lingxi-base-url" type="url" required maxLength={2048} className={fieldClass} value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setNotice('') }} autoComplete="off" spellCheck={false} placeholder="https://bot.example.com/lingxi" /><p className="lingxi-setting-hint mt-2">使用服务器可访问的后台 HTTPS 地址，并保留 /lingxi 等入口前缀。</p></div>
            <div><label className={labelClass} htmlFor="lingxi-api-token">灵犀 API Token{settings?.has_token && <span className="ml-2 font-normal text-success">已加密保存</span>}</label><input id="lingxi-api-token" type="password" maxLength={4096} className={fieldClass} value={token} onChange={event => setToken(event.target.value)} autoComplete="new-password" placeholder={settings?.has_token ? '留空保留已保存 Token' : '从灵犀账号设置中复制 Token'} /><p className="lingxi-setting-hint mt-2">仅用于当前导航站账号，后台加密保存。无需填写灵犀登录密码。</p></div>
            <div className="lingxi-settings-actions"><button type="submit" className={btnPrimary}>{busy ? '连接中…' : '保存并连接'}</button><button type="button" className={btnGhost} onClick={() => setReload(value => value + 1)}>刷新状态</button>{settings?.configured && <button type="button" className={`${btnDanger} flex items-center gap-2`} onClick={() => void disconnect()}><Unplug size={15} />{confirmDisconnect ? '确认解绑并撤销密码授权' : '解除绑定'}</button>}</div>
            {confirmDisconnect && <p className="lingxi-setting-hint">解绑会删除连接密钥与密码授权副本，保留灵犀中的日程和聊天。再次点击确认解绑。</p>}
          </fieldset></form>
        </>}
        {error && <div role="alert" className="lingxi-error"><p>{error}</p>{!settings && <button type="button" className={`${btnGhost} mt-2`} onClick={() => setReload(value => value + 1)}>重新读取</button>}</div>}
        {notice && <p role="status" className="lingxi-settings-notice mt-4">{notice}</p>}
      </section>

      <section className="lingxi-setting-panel" aria-labelledby="lingxi-vault">
        <h3 id="lingxi-vault" className="lingxi-setting-heading scroll-mt-6"><KeyRound size={17} />插件密码读取授权</h3>
        <label className="lingxi-grant-toggle"><span><span className="block text-sm font-semibold text-fg">允许灵犀读取密码</span><span className="lingxi-setting-hint">授权范围：Chrome 密码插件同步到此账号的全部密码。</span></span><span className="lingxi-switch"><input type="checkbox" role="switch" aria-label="允许灵犀读取密码" checked={grant?.enabled ?? false} disabled={!grant || grantBusy || busy || !settings?.configured} onChange={event => void toggleGrant(event.target.checked)} /><span className="lingxi-switch-track" aria-hidden /></span></label>
        <div className="lingxi-grant-description"><ShieldCheck size={17} /><p className="lingxi-setting-hint">开启后，请在 Chrome 插件中解锁保险库并确认授权。原保险库保持端到端加密；授权副本由后台加密保存，并按权限解密读取。</p></div>
        {grant && <div className="lingxi-grant-status" data-state={grant.status}><strong>{grant.status === 'ready' ? `已授权全部密码 · ${grant.item_count} 条` : grant.status === 'awaiting_extension' ? '等待插件解锁并授权同步' : '密码读取已关闭'}</strong>{grant.updated_at && <p className="lingxi-setting-hint">上次同步：{new Date(grant.updated_at).toLocaleString('zh-CN')}</p>}<p className="lingxi-setting-hint">关闭会立即禁止读取，并撤销授权、删除后台副本。再次开启后需重新授权。</p></div>}
        {!busy && !loading && !grantBusy && settings?.configured && grant?.enabled && grant.status === 'ready' && <LingxiVaultPanel key={grant.grant_id} />}
        {grantBusy && <p role="status" className="lingxi-setting-hint mt-3">正在更新授权…</p>}
        {grantError && <p role="alert" className="lingxi-error">{grantError}</p>}
      </section>

      <section className="lingxi-setting-panel" aria-labelledby="lingxi-widgets-heading">
        <h3 id="lingxi-widgets-heading" className="lingxi-setting-heading">首页小组件</h3>
        <div className="grid gap-3 sm:grid-cols-2"><ToggleField label="灵犀日历" hint="按月查看并编辑日程" checked={preferences.show_lingxi_calendar} onChange={next => void save({ show_lingxi_calendar: next })} /><ToggleField label="日程与待办" hint="查看日程、添加任务和标记完成" checked={preferences.show_lingxi_schedule} onChange={next => void save({ show_lingxi_schedule: next })} /><ToggleField label="Deadline" hint="截止时间与逾期倒计时" checked={preferences.show_lingxi_deadline} onChange={next => void save({ show_lingxi_deadline: next })} /><ToggleField label="灵犀 AI 聊天" hint="继续现有会话，实时接收回复" checked={preferences.show_lingxi_chat} onChange={next => void save({ show_lingxi_chat: next })} /></div>
        <p className="lingxi-setting-hint mt-4">私人组件仅对已登录账号显示。桌面模式可在组件菜单中单独添加与拖动。</p>
      </section>
    </div>
  </SettingsSection>
}
