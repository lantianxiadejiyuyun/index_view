import { passwordStrength } from '../src/generator.js'
import { $, send, setMsg, run, setDisabled, clearPasswords } from '../ui/common.js'
import { t, initI18n, localize, onLanguageChange, getLanguagePreference, getLocale, setLanguage, translateError } from '../ui/i18n.js'
import { initIntro } from '../ui/intro.js'
import { createServerFormCache, selectServerForm } from '../ui/server-form-cache.js'
import { normalizeServer } from '../src/sync.js'

await initI18n()
localize()
initWebsiteAppearance()
await initIntro({ surface: 'options' })

// Website appearance belongs to this browser, independently of the vault and sync.
function initWebsiteAppearance() {
  const select = $('bilibili-theme')
  const message = $('website-appearance-msg')
  const themeFrom = (value) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'bilibiliTheme') && value.bilibiliTheme === 'off' ? 'off' : 'system'
  let confirmedTheme = 'system'
  let loading = true
  let saving = false
  let revision = 0
  let messageKey = ''
  let messageKind = ''
  const render = () => {
    select.value = confirmedTheme
    select.disabled = loading || saving
  }
  const showMessage = (key = '', kind = '') => {
    messageKey = key
    messageKind = kind
    setMsg(message, key ? t(key) : '', kind)
  }
  onLanguageChange(() => setMsg(message, messageKey ? t(messageKey) : '', messageKind))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, 'websiteAppearance')) return
    revision += 1
    confirmedTheme = themeFrom(changes.websiteAppearance.newValue)
    render()
    showMessage()
  })
  select.addEventListener('change', async () => {
    if (loading || saving) { render(); return }
    const nextTheme = select.value === 'off' ? 'off' : 'system'
    const startedAt = revision
    saving = true
    select.disabled = true
    showMessage()
    try {
      await chrome.storage.local.set({ websiteAppearance: { bilibiliTheme: nextTheme } })
      if (startedAt === revision) confirmedTheme = nextTheme
      showMessage('已保存', 'ok')
    } catch {
      // Keep the last confirmed value, including newer changes from another settings page.
      showMessage('网站外观保存失败，请重试。', 'bad')
    } finally {
      saving = false
      render()
    }
  })
  render()
  const startedAt = revision
  void (async () => {
    try {
      const stored = await chrome.storage.local.get('websiteAppearance')
      if (startedAt === revision) confirmedTheme = themeFrom(stored.websiteAppearance)
    } catch {
      if (startedAt === revision) showMessage('无法读取网站外观设置。', 'bad')
    } finally {
      loading = false
      render()
    }
  })()
}

let hasVault = false
let wizardActive = false
let locked = true
let wizardStep = 1
let wizardResult = null
let accountState = null
let formDraft = null
let accountInputsReady = false
let wizardInputsReady = false
let settingsState = {}
let savingSettings = false
let settingsRevision = 0
const formCache = createServerFormCache({
  send,
  onError: (err) => setMsg($('page-msg'), translateError(err), 'bad'),
  onInvalidate: resetConnectionDraft,
})
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'hd-pm-form-draft-reset') formCache.invalidate(msg.revision)
})
formDraft = await formCache.load().catch(() => null)
const serverActions = ['account-connect', 'account-test', 'account-forget', 'sync-push', 'sync-pull', 'sync-overwrite']
const wizardActions = ['srv-connect', 'srv-local-only']
const lingxiActions = ['lingxi-authorize', 'lingxi-sync', 'lingxi-revoke']
const bind = (id, msg, action) => $(id).addEventListener('click', () => {
  const peers = serverActions.includes(id) ? serverActions : wizardActions.includes(id) ? wizardActions : lingxiActions.includes(id) ? lingxiActions : []
  return run($(id), $(msg), action, peers.map($))
})
function show(section) {
  for (const id of ['setup', 'locked', 'main']) $(id).classList.toggle('hidden', id !== section)
}
function showStep(step) {
  wizardActive = true
  wizardStep = step
  show('setup')
  $('wizard-step-title').textContent = t('第 {step} 步 / 共 3 步', { step })
  for (const n of [1, 2, 3]) $(`step-${n}`).classList.toggle('hidden', n !== step)
  if (step === 2 && !wizardInputsReady) {
    fillServerForm('srv')
    wizardInputsReady = true
  }
}
function fillServerForm(prefix, account = accountState) {
  const draft = selectServerForm(formDraft, account)
  $(`${prefix}-base`).value = draft.base
  $(`${prefix}-user`).value = draft.user
}
function resetConnectionDraft() {
  formDraft = null
  accountState = null
  accountInputsReady = true
  wizardInputsReady = false
  for (const prefix of ['account', 'srv']) {
    $(`${prefix}-base`).value = ''
    $(`${prefix}-user`).value = ''
    $(`${prefix}-password`).value = ''
  }
  renderAccountText()
  updatePasswordHint()
}
function updatePasswordHint() {
  const base = normalizeServer($('account-base').value)
  const sameAccount = accountState?.configured && base.ok && base.base === accountState.base
    && $('account-user').value.trim() === accountState.user
  $('account-password').placeholder = sameAccount
    ? t('已加密保存，留空可沿用') : t('请输入站点密码')
}
async function saveConnectedForm(result) {
  formDraft = { base: result.base, user: result.user }
  await formCache.flush(formDraft)
  fillServerForm('account')
  fillServerForm('srv')
  accountInputsReady = true
  wizardInputsReady = true
  updatePasswordHint()
}
function setWizardResult(key, params = {}) {
  wizardResult = { key, params }
  const translated = { ...params }
  if (translated.message) translated.message = translateError(translated.message)
  $('wizard-result').textContent = t(key, translated)
}
function renderStrength() {
  const password = $('wizard-password').value
  $('wizard-strength').textContent = password
    ? t('强度估计：{strength}', { strength: t(passwordStrength(password).label) }) : ''
}
function applyState(st) {
  hasVault = st.hasVault
  locked = st.locked
  setDisabled($('export-encrypted'), !hasVault)
  setDisabled($('export-plain'), locked)
  $('lock-now').classList.toggle('hidden', locked)
  $('disable-persistent-unlock').classList.toggle('hidden', !st.locked || st.settings?.neverAutoLock !== true)
  $('danger-section').classList.toggle('hidden', !hasVault)
  for (const link of document.querySelectorAll('[data-unlocked-nav]')) link.classList.toggle('hidden', locked || !hasVault)
  if (locked) {
    void formCache.flush().catch((err) => setMsg($('page-msg'), translateError(err), 'bad'))
    clearPasswords()
    $('account-state').textContent = ''
    $('account-user').value = ''
    $('account-base').value = ''
    $('account-msg').textContent = ''
    $('wizard-result').textContent = ''
    $('lingxi-consent').checked = false
    $('lingxi-state').textContent = ''
    $('lingxi-msg').textContent = ''
    accountState = null
    accountInputsReady = false
    wizardInputsReady = false
    wizardResult = null
    wizardActive = false
  }
}
async function refresh() {
  const st = await send('status')
  applyState(st)
  if (!st.hasVault) { showStep(1); return }
  if (st.locked) { show('locked'); $('unlock-password').focus(); return }
  if (!wizardActive) show('main')
  if (!savingSettings) renderSettings(st.settings)
  await renderAccount(true)
  await renderLingxi()
}
$('wizard-password').addEventListener('input', renderStrength)
bind('wizard-create', 'wizard-msg', async () => {
  const password = $('wizard-password').value
  if (password.length < 8) throw new Error(t('主密码至少 8 位，建议使用较长且独特的口令'))
  if (password !== $('wizard-password2').value) throw new Error(t('两次输入的主密码不一致'))
  setMsg($('wizard-msg'), t('正在创建…'))
  await send('create', { password })
  clearPasswords()
  applyState(await send('status'))
  showStep(2)
})
bind('srv-local-only', 'srv-msg', async () => {
  setWizardResult('密码库已准备好，目前仅保存在当前浏览器。可以随时从设置中连接服务器。')
  showStep(3)
})
bind('wizard-done', 'page-msg', async () => { wizardActive = false; await refresh() })
bind('srv-connect', 'srv-msg', async () => {
  const base = $('srv-base').value.trim()
  const user = $('srv-user').value.trim()
  const password = $('srv-password').value
  if (!base || !user || !password) throw new Error(t('请填写服务器地址、站点账号和站点密码'))
  setMsg($('srv-msg'), t('正在连接…'))
  const result = await send('account-connect', { base, user, password })
  $('srv-password').value = ''
  await saveConnectedForm(result)
  if (result.conflict) {
    wizardActive = false
    await refresh()
    setMsg($('account-msg'), result.message ? translateError(result.message) : t('服务器已有密码库，请输入其主密码，再下载恢复。'), 'warn')
    $('remote-password').focus()
  } else {
    if (result.pushed) setWizardResult('服务器已连接，首份密文已上传。')
    else setWizardResult('服务器已绑定。{message}', { message: result.message || '可在设置中手动同步。' })
    showStep(3)
  }
})
const doUnlock = () => run($('unlock-btn'), $('unlock-msg'), async () => {
  setMsg($('unlock-msg'), t('正在解锁…'))
  await send('unlock', { password: $('unlock-password').value })
  $('unlock-password').value = ''
  setMsg($('unlock-msg'))
  wizardActive = false
  await refresh()
})
$('unlock-btn').addEventListener('click', doUnlock)
$('unlock-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') void doUnlock() })
bind('lock-now', 'page-msg', async () => { await send('lock'); await refresh() })
bind('disable-persistent-unlock', 'unlock-msg', async () => {
  await send('settings-set', { settings: { neverAutoLock: false } })
  setMsg($('unlock-msg'), t('已保存'), 'ok')
  await refresh()
})

const preferenceControls = [['never-auto-lock', 'neverAutoLock'], ['auto-lock', 'autoLockMinutes'], ['lock-on-idle', 'lockOnIdle'], ['auto-push', 'autoPush'], ['prompt-on-match', 'promptOnMatch']]
function renderSettings(st = settingsState) {
  settingsState = { ...st }
  const neverAutoLock = st.neverAutoLock === true
  $('never-auto-lock').checked = neverAutoLock
  $('auto-lock').value = String(st.autoLockMinutes ?? 10)
  $('lock-on-idle').checked = st.lockOnIdle !== false
  $('auto-push').checked = st.autoPush !== false
  $('prompt-on-match').checked = st.promptOnMatch !== false
  $('auto-lock-help').classList.toggle('hidden', neverAutoLock)
  for (const [id] of preferenceControls) {
    $(id).disabled = savingSettings || (neverAutoLock && (id === 'auto-lock' || id === 'lock-on-idle'))
  }
}
for (const [id, key] of preferenceControls) {
  $(id).addEventListener('change', async () => {
    if (savingSettings) { renderSettings(); return }
    const el = $(id)
    const value = id === 'auto-lock' ? Number(el.value) : el.checked
    const previous = settingsState
    savingSettings = true
    settingsRevision += 1
    renderSettings({ ...previous, [key]: value })
    try {
      settingsState = await send('settings-set', { settings: { [key]: value } })
      setMsg($('settings-msg'), t('已保存'), 'ok')
    } catch (err) {
      settingsState = previous
      setMsg($('settings-msg'), translateError(err), 'bad')
      try { settingsState = await send('settings-get') } catch { /* Restore the last confirmed settings if the worker is unavailable. */ }
    } finally {
      savingSettings = false
      settingsRevision += 1
      renderSettings()
    }
  })
}
async function renderAccount(fillInputs = false) {
  const st = await send('account-status')
  accountState = st
  const configured = st.configured && st.enabled !== false
  renderAccountText()
  $('account-state').style.whiteSpace = 'pre-line'
  $('account-state').className = `note${st.lastError || st.conflict ? ' warn' : ''}`
  $('conflict-note').classList.toggle('hidden', !st.conflict)
  $('sync-overwrite').classList.toggle('hidden', !st.conflict)
  for (const id of ['sync-pull', 'sync-push', 'sync-overwrite', 'account-forget']) setDisabled($(id), !configured)
  if (fillInputs && !accountInputsReady) {
    fillServerForm('account', st)
    accountInputsReady = true
  }
  updatePasswordHint()
}
function renderAccountText() {
  const st = accountState
  if (!st || locked) { $('account-state').textContent = ''; return }
  const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString(getLocale()) : t('从未')
  $('account-state').textContent = st.configured && st.enabled !== false
    ? [
      `${st.user} · ${st.base}${st.insecure ? t('（内网 HTTP）') : ''}`,
      `${t('服务器版本 v{version}', { version: st.version })} · ${t('上次同步：{time}', { time: when })}`,
      st.dirty ? t('本机有待上传修改') : '',
      st.lastError ? translateError(st.lastError) : '',
    ].filter(Boolean).join('\n')
    : t('未绑定服务器，密码库仅保存在当前浏览器。')
}
async function renderLingxi() {
  for (const id of lingxiActions) setDisabled($(id), true)
  try {
    const state = await send('lingxi-status')
    $('lingxi-state').textContent = !state.connected ? t('请先绑定服务器账号')
      : !state.enabled ? t('后台读取开关已关闭')
        : state.authorized ? t('已授权全部 {count} 条密码', { count: state.item_count })
          : t('等待本机解锁后确认授权')
    if (state.lastError) $('lingxi-state').textContent += '\n' + translateError(state.lastError)
    if (state.enabled && state.authorized && !state.service_connected) $('lingxi-state').textContent += '\n' + t('授权副本已保存，正在连接灵犀读取服务')
    setDisabled($('lingxi-authorize'), !state.connected || !state.enabled)
    setDisabled($('lingxi-sync'), !state.authorized)
    setDisabled($('lingxi-revoke'), !state.enabled)
  } catch (error) { $('lingxi-state').textContent = translateError(error) }
}
bind('lingxi-authorize', 'lingxi-msg', async () => {
  if (!$('lingxi-consent').checked) throw new Error(t('请先勾选密码读取授权'))
  await send('lingxi-authorize', { consent: true })
  $('lingxi-consent').checked = false
  setMsg($('lingxi-msg'), t('密码授权副本已加密保存'), 'ok')
  await renderLingxi()
})
bind('lingxi-sync', 'lingxi-msg', async () => {
  await send('sync-push')
  await send('lingxi-sync')
  setMsg($('lingxi-msg'), t('密码授权副本已加密保存'), 'ok')
  await renderLingxi()
})
bind('lingxi-revoke', 'lingxi-msg', async () => {
  await send('lingxi-revoke')
  $('lingxi-consent').checked = false
  setMsg($('lingxi-msg'), t('读取已关闭，后台授权副本已删除'), 'ok')
  await renderLingxi()
})
bind('account-connect', 'account-msg', async () => {
  setMsg($('account-msg'), t('正在连接…'))
  const base = $('account-base').value.trim()
  const user = $('account-user').value.trim()
  const password = $('account-password').value
  if (!base || !user) throw new Error(t('请填写服务器地址和站点账号'))
  const res = await send('account-connect', { base, user, password })
  $('account-password').value = ''
  await saveConnectedForm(res)
  await renderAccount(true)
  setMsg($('account-msg'), res.pushed ? t('已连接并上传密文') : res.message ? translateError(res.message) : t('已连接，请选择同步方向'), res.conflict ? 'warn' : res.pushed ? 'ok' : '')
})
bind('account-test', 'account-msg', async () => {
  setMsg($('account-msg'), t('正在测试…'))
  const res = await send('account-test', { base: $('account-base').value.trim() })
  setMsg($('account-msg'), res.ok ? t('连接正常：{base}{notice}', { base: res.base, notice: res.insecure ? t('（内网 HTTP）') : '' }) : t('服务器没有正常响应'), res.ok ? 'ok' : 'bad')
})
bind('account-forget', 'account-msg', async () => {
  if (!confirm(t('解绑后保留本机密码库，停止同步；服务器密文不变。继续？'))) return
  const result = await send('account-forget')
  formCache.invalidate(result.draftRevision)
  await renderAccount(true)
  setMsg($('account-msg'), t('已解绑'), 'ok')
})
async function syncAction(type, payload) {
  try {
    const res = await send(type, payload)
    setMsg($('account-msg'), res.pulled ? t('已恢复 {count} 条账号；以后使用服务器密码库的主密码解锁。', { count: res.items }) : res.pushed ? t('上传完成 · v{version}', { version: res.version }) : res.reason === 'up-to-date' ? t('已是最新版本') : res.reason === 'empty' ? t('服务器尚无密码库，请先上传本机密文。') : res.message ? translateError(res.message) : t('没有执行同步，请检查绑定状态'), res.pulled || res.pushed || res.reason === 'up-to-date' ? 'ok' : 'warn')
    if (res.pulled) $('remote-password').value = ''
  } catch (err) {
    if (err.code === 'remote_password_required') $('remote-password').focus()
    throw err
  } finally { await renderAccount() }
}
bind('sync-pull', 'account-msg', async () => {
  if (!confirm(t('下载会替换本机全部条目及主密码，未上传的修改会丢失。建议先导出密文备份。继续下载？'))) return
  setMsg($('account-msg'), t('正在下载并验证密文…'))
  await syncAction('sync-pull', { force: true, password: $('remote-password').value || undefined })
})
bind('sync-push', 'account-msg', async () => {
  setMsg($('account-msg'), t('正在上传…'))
  await syncAction('sync-push', {})
})
bind('sync-overwrite', 'account-msg', async () => {
  if (!confirm(t('用本机密码库替换服务器版本？其他设备尚未同步到本机的修改会丢失。请确认已保留需要的备份。'))) return
  setMsg($('account-msg'), t('正在覆盖服务器版本…'))
  await syncAction('sync-push', { force: true })
})
bind('change-master', 'master-msg', async () => {
  const current = $('master-current').value
  const next = $('master-next').value
  if (next.length < 8) throw new Error(t('新主密码至少 8 位'))
  if (next !== $('master-confirm').value) throw new Error(t('两次输入的新主密码不一致'))
  await send('change-master', { current, next })
  for (const id of ['master-current', 'master-next', 'master-confirm']) $(id).value = ''
  setMsg($('master-msg'), t('主密码已更新。同步完成后，其他设备需使用新主密码下载恢复。'), 'ok')
  await renderAccount()
})
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
bind('export-encrypted', 'io-msg', async () => {
  const { text } = await send('export', { plain: false })
  download(`vault-encrypted-${new Date().toISOString().slice(0, 10)}.json`, text)
  setMsg($('io-msg'), t('密文备份已导出，请保留对应的主密码。'), 'ok')
})
bind('export-plain', 'io-msg', async () => {
  if (!confirm(t('明文文件可直接查看全部密码。确认导出？'))) return
  const { text } = await send('export', { plain: true })
  download('vault-plain.json', text)
  setMsg($('io-msg'), t('明文已导出，请妥善处理文件。'), 'ok')
})
$('import-file').addEventListener('change', async (e) => {
  const input = e.target
  const file = input.files?.[0]
  if (!file) return
  input.disabled = true
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error(t('文件超过 4 MB，拒绝导入'))
    const text = await file.text()
    let data
    try { data = JSON.parse(text) } catch { throw new Error(t('不是有效的 JSON 文件')) }
    const encrypted = data?.kind === 'encrypted-vault'
    if (encrypted && hasVault && !confirm(t('密文导入会替换当前密码库并停用同步。确认已备份需要保留的内容？'))) return
    const { imported } = await send('import', { text, password: $('import-password').value })
    $('import-password').value = ''
    wizardActive = false
    await refresh()
    setMsg($('io-msg'), t('已导入 {count} 条账号', { count: imported }) + (encrypted ? t('。同步已停用，请重新绑定服务器。') : ''), 'ok')
  } catch (err) { setMsg($('io-msg'), translateError(err), 'bad') }
  finally { input.value = ''; input.disabled = false }
})
bind('reset-all', 'page-msg', async () => {
  if (!confirm(t('清空当前浏览器全部密码库与设置？服务器上的密文不会被删除。'))) return
  if (!confirm(t('确认已备份需要保留的数据？本机删除无法撤销。'))) return
  const result = await send('reset-all')
  formCache.invalidate(result.draftRevision)
  clearPasswords()
  location.reload()
})
async function checkState(force = false) {
  if (document.hidden && !force) return
  const revision = settingsRevision
  const st = await send('status')
  $('disable-persistent-unlock').classList.toggle('hidden', !st.locked || st.settings?.neverAutoLock !== true)
  if (st.locked !== locked || st.hasVault !== hasVault) await refresh()
  else if (!st.locked && !wizardActive) {
    if (!savingSettings && revision === settingsRevision) renderSettings(st.settings)
    await renderAccount()
    await renderLingxi()
  }
}
setInterval(() => void checkState().catch(() => {}), 15_000)
window.addEventListener('focus', () => void checkState().catch(() => {}))
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'hd-pm-state-changed') void checkState(true).catch(() => {})
})
$('language-select').value = getLanguagePreference()
$('language-select').addEventListener('change', async () => {
  try { await setLanguage($('language-select').value) }
  catch (err) { setMsg($('page-msg'), translateError(err), 'bad') }
})
onLanguageChange(() => {
  $('language-select').value = getLanguagePreference()
  if (wizardActive) $('wizard-step-title').textContent = t('第 {step} 步 / 共 3 步', { step: wizardStep })
  if (wizardResult) setWizardResult(wizardResult.key, wizardResult.params)
  else $('wizard-result').textContent = ''
  renderStrength()
  renderAccountText()
  updatePasswordHint()
})
for (const prefix of ['account', 'srv']) {
  const editable = () => !locked && !$(prefix === 'account' ? 'main' : 'step-2').classList.contains('hidden')
  const capture = () => {
    formDraft = { base: $(`${prefix}-base`).value, user: $(`${prefix}-user`).value }
    return formDraft
  }
  for (const name of ['base', 'user']) {
    $(`${prefix}-${name}`).addEventListener('input', () => {
      if (!editable()) return
      formCache.schedule(capture())
      updatePasswordHint()
    })
    $(`${prefix}-${name}`).addEventListener('blur', () => {
      if (!editable()) return
      void formCache.flush(capture()).catch((err) => setMsg($('page-msg'), translateError(err), 'bad'))
    })
  }
}
window.addEventListener('pagehide', () => { void formCache.flush().catch(() => {}) })
for (const link of document.querySelectorAll('.settings-nav a')) {
  link.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.settings-nav a')) other.classList.toggle('active', other === link)
  })
}
void refresh().catch((err) => setMsg($('page-msg'), translateError(err), 'bad'))
