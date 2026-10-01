/** Popup operations stay inside the extension worker. */
import { generatePassword, passwordStrength } from '../src/generator.js'
import { matchItems } from '../src/match.js'
import { $, send, setMsg, run, setDisabled, clearPasswords } from '../ui/common.js'
import { t, initI18n, localize, onLanguageChange, getLanguagePreference, getLocale, setLanguage, translateError } from '../ui/i18n.js'
import { initIntro } from '../ui/intro.js'

let items = []
let current = null
let editing = null
let activeTab = null
let revealTimer
let flashTimer
let matchingIds = new Set()
let editConflict = false
let refreshing = Promise.resolve()
let lastStatus = null
let itemReadRevision = 0

function maskPassword() {
  clearTimeout(revealTimer)
  $('d-pass').textContent = '••••••••'
  $('d-reveal').textContent = t('显示')
  $('d-reveal').setAttribute('aria-pressed', 'false')
}
function show(view) {
  maskPassword()
  for (const id of ['gate', 'list-view', 'detail-view', 'edit-view']) $(id).classList.toggle('hidden', id !== view)
  if (view !== 'detail-view') {
    for (const id of ['d-title', 'd-url', 'd-user', 'd-notes']) $(id).textContent = ''
  }
  if (view === 'list-view') current = null
  if (view !== 'edit-view') {
    for (const id of ['e-title', 'e-url', 'e-user', 'e-pass', 'e-notes']) $(id).value = ''
    $('e-pass').type = 'password'
  }
}
function clearVaultView() {
  itemReadRevision += 1
  items = []
  current = editing = null
  matchingIds.clear()
  clearPasswords()
  $('list').replaceChildren()
  for (const id of ['d-title', 'd-url', 'd-user', 'd-notes', 'e-title', 'e-url', 'e-user', 'e-notes']) {
    $(id).textContent = ''
    if ('value' in $(id)) $(id).value = ''
  }
  $('search').value = ''
  clearTimeout(flashTimer)
  maskPassword()
}
async function boot() {
  const st = await send('status')
  lastStatus = st
  $('lock').classList.toggle('hidden', st.locked)
  if (st.locked || !st.hasVault) {
    clearVaultView()
    show('gate')
    $('gate-text').textContent = st.hasVault ? t('密码库已锁定，输入主密码继续。') : t('创建密码库，或从设置中恢复已有的密文备份。')
    $('gate-setup').classList.toggle('hidden', st.hasVault)
    $('gate-unlock').classList.toggle('hidden', !st.hasVault)
    $('sync-badge').textContent = st.hasVault ? t('已锁定') : t('欢迎使用')
    $('sync-badge').dataset.state = ''
    $('status-text').textContent = st.hasVault ? t('明文已从界面清除') : t('本机加密 · 自部署同步')
    if (st.hasVault) $('password').focus()
    return
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  activeTab = tab ?? null
  updateSyncBadge(st)
  await loadList()
  $('search').focus()
}
function updateSyncBadge(st) {
  const conf = st.sync ?? {}
  $('sync-badge').textContent = conf.conflict ? t('同步待处理') : conf.lastError ? t('同步失败') : conf.dirty && conf.enabled ? t('待上传') : conf.hasAccount && conf.enabled ? t('已连接 · v{version}', { version: conf.version ?? 0 }) : t('仅本机')
  $('sync-badge').title = conf.lastError ? translateError(conf.lastError) : ''
  $('sync-badge').dataset.state = conf.conflict || conf.lastError ? 'warn' : conf.hasAccount && conf.enabled ? 'ok' : ''
}
async function loadList() {
  const revision = ++itemReadRevision
  const { items: list } = await send('list')
  if (revision !== itemReadRevision) return
  items = list
  matchingIds = new Set(matchItems(items, activeTab?.url ?? '').map((it) => it.id))
  renderCounts()
  renderList()
  show('list-view')
}
function renderCounts() {
  $('status-text').textContent = t('{count} 条密码', { count: items.length })
  try {
    const url = new URL(activeTab?.url)
    $('site-context').textContent = /^https?:$/.test(url.protocol) ? url.hostname : t('当前页面不支持填充')
  } catch { $('site-context').textContent = t('当前页面不支持填充') }
  $('site-count').textContent = t('{count} 条匹配', { count: matchingIds.size })
}
function renderList() {
  const q = $('search').value.trim().toLowerCase()
  const list = items.filter((it) => (!q || `${it.title} ${it.url} ${it.username}`.toLowerCase().includes(q)) && (!$('only-matches').checked || matchingIds.has(it.id)))
    .sort((a, b) => Number(matchingIds.has(b.id)) - Number(matchingIds.has(a.id)) || a.title.localeCompare(b.title, getLocale()))
  const box = $('list')
  box.replaceChildren()
  $('empty').classList.toggle('hidden', list.length > 0)
  $('empty').textContent = !items.length ? t('还没有保存的账号。点击「＋」添加当前网站。') : t('没有匹配的条目，试试其他关键词或取消当前网站筛选。')
  for (const it of list) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'item'
    const title = document.createElement('span')
    title.className = 't'
    title.textContent = it.title || it.url || t('（未命名）')
    const u = document.createElement('span')
    u.className = 'u'
    u.textContent = [it.username, it.url].filter(Boolean).join(' · ') || t('没有用户名')
    const avatar = document.createElement('span')
    avatar.className = 'item-avatar'
    avatar.setAttribute('aria-hidden', 'true')
    avatar.textContent = Array.from(it.title || it.url || '•')[0].toLocaleUpperCase(getLocale())
    const copy = document.createElement('span')
    copy.className = 'item-copy'
    copy.append(title, u)
    el.append(avatar, copy)
    if (matchingIds.has(it.id)) {
      const tag = document.createElement('span')
      tag.className = 'match-tag'
      tag.textContent = t('当前网站')
      copy.append(tag)
    }
    const arrow = document.createElement('span')
    arrow.className = 'item-arrow'
    arrow.setAttribute('aria-hidden', 'true')
    arrow.textContent = '›'
    el.append(arrow)
    el.addEventListener('click', () => openDetail(it))
    box.append(el)
  }
}
function openDetail(item) {
  current = item
  $('d-title').textContent = item.title || t('（未命名）')
  $('d-url').textContent = item.url || '—'
  $('d-user').textContent = item.username || '—'
  $('d-notes').textContent = item.notes || '—'
  setDisabled($('d-fill'), !matchingIds.has(item.id))
  $('d-fill').title = matchingIds.has(item.id) ? t('填充当前页面的登录表单') : t('条目网址与当前页面不匹配')
  show('detail-view')
}
function flash(text, kind = '') {
  clearTimeout(flashTimer)
  setMsg($('status-text'), text, kind)
  flashTimer = setTimeout(() => setMsg($('status-text'), t('{count} 条密码', { count: items.length })), 4000)
}
$('d-back').addEventListener('click', () => show('list-view'))
$('d-reveal').addEventListener('click', () => {
  if ($('d-reveal').getAttribute('aria-pressed') === 'true') return maskPassword()
  $('d-pass').textContent = current?.password || t('（空密码）')
  $('d-reveal').textContent = t('隐藏')
  $('d-reveal').setAttribute('aria-pressed', 'true')
  revealTimer = setTimeout(maskPassword, 10_000)
})
for (const [id, field] of [['d-copy-user', 'username'], ['d-copy-pass', 'password']]) {
  $(id).addEventListener('click', () => run($(id), $('status-text'), async () => {
    if ((await send('status')).locked) { await boot(); return }
    await navigator.clipboard.writeText(current?.[field] ?? '')
    flash(field === 'username' ? t('已复制用户名') : t('已复制密码'))
  }))
}
$('d-fill').addEventListener('click', () => run($('d-fill'), $('status-text'), async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !current || !matchItems([current], tab.url ?? '').length) throw new Error('当前网址不匹配，未填充')
  let result
  try { result = await chrome.tabs.sendMessage(tab.id, { type: 'hd-pm-fill', id: current.id }, { frameId: 0 }) }
  catch { throw new Error('此页面暂不能填充；安装扩展后请先刷新页面') }
  if (!result?.ok || !result.filled) throw new Error(result?.error || '没有找到可填写的登录表单')
  window.close()
}))
$('d-edit').addEventListener('click', () => openEdit(current))
$('d-delete').addEventListener('click', () => run($('d-delete'), $('status-text'), async () => {
  if (!confirm(t('删除「{title}」？', { title: current.title || current.url }))) return
  await send('remove', { id: current.id })
  current = null
  await loadList()
}))
function openEdit(item) {
  editing = item ?? null
  editConflict = false
  show('edit-view')
  $('e-heading').textContent = item ? t('编辑账号') : t('添加账号')
  const isWebsite = /^https?:\/\//.test(activeTab?.url ?? '')
  $('e-title').value = item?.title ?? (isWebsite ? activeTab.title ?? '' : '')
  $('e-url').value = item?.url ?? (isWebsite ? new URL(activeTab.url).origin : '')
  $('e-user').value = item?.username ?? ''
  $('e-pass').value = item?.password ?? generatePassword({ length: 20 })
  $('e-pass').type = 'password'
  $('e-reveal').textContent = t('显示')
  $('e-notes').value = item?.notes ?? ''
  setMsg($('edit-msg'))
  $('e-title').focus()
}
$('add').addEventListener('click', () => openEdit(null))
$('e-cancel').addEventListener('click', () => {
  const latest = editing && items.find((item) => item.id === editing.id)
  editing = null
  if (latest) openDetail(latest)
  else show('list-view')
})
$('e-reveal').addEventListener('click', () => {
  const hidden = $('e-pass').type === 'password'
  $('e-pass').type = hidden ? 'text' : 'password'
  $('e-reveal').textContent = hidden ? t('隐藏') : t('显示')
})
$('e-gen').addEventListener('click', () => {
  if ($('e-pass').value && editing && !confirm(t('用新生成的密码替换当前输入？保存后生效。'))) return
  const length = Math.min(64, Math.max(8, Math.round(Number($('e-length').value) || 20)))
  $('e-length').value = String(length)
  $('e-pass').value = generatePassword({ length, symbol: $('e-symbols').checked })
  setMsg($('edit-msg'), t('已生成 {length} 位密码 · {strength}', { length, strength: t(passwordStrength($('e-pass').value).label) }), 'ok')
})
$('e-save').addEventListener('click', () => run($('e-save'), $('edit-msg'), async () => {
  if (editConflict && !confirm(t('密码库已在其他页面更新。仍将当前编辑保存到现在的密码库？'))) return
  const patch = { title: $('e-title').value.trim(), url: $('e-url').value.trim(), username: $('e-user').value.trim(), password: $('e-pass').value, notes: $('e-notes').value }
  if (!patch.title && !patch.url) throw new Error('标题和网址至少填一个')
  await send('save', { item: { ...(editing ?? { id: crypto.randomUUID() }), ...patch } })
  editing = current = null
  await loadList()
  flash(t('已保存'))
}))
const doUnlock = () => run($('unlock'), $('gate-msg'), async () => {
  setMsg($('gate-msg'), t('正在解锁…'))
  await send('unlock', { password: $('password').value })
  $('password').value = ''
  setMsg($('gate-msg'))
  await boot()
})
$('unlock').addEventListener('click', doUnlock)
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') void doUnlock() })
for (const id of ['setup', 'options', 'open-options']) $(id).addEventListener('click', () => chrome.runtime.openOptionsPage())
$('lock').addEventListener('click', () => run($('lock'), $('status-text'), async () => { await send('lock'); await boot() }))
$('search').addEventListener('input', renderList)
$('only-matches').addEventListener('change', renderList)
const checkLock = async (force = false) => {
  if ((document.hidden && !force) || !$('gate').classList.contains('hidden')) return
  const revision = itemReadRevision
  const st = await send('status')
  lastStatus = st
  if (st.locked) { await boot(); return }
  updateSyncBadge(st)
  if (!force) return
  const next = (await send('list')).items
  // A language/state broadcast begun before a save must not replace the newer list.
  if (revision !== itemReadRevision) return
  if (JSON.stringify(next) === JSON.stringify(items)) return
  items = next
  matchingIds = new Set(matchItems(items, activeTab?.url ?? '').map((it) => it.id))
  $('site-count').textContent = t('{count} 条匹配', { count: matchingIds.size })
  renderList()
  if (!$('edit-view').classList.contains('hidden')) {
    editConflict = true
    setMsg($('edit-msg'), t('密码库已在其他页面更新，当前输入已保留；保存前请核对。'), 'warn')
  } else if (!$('detail-view').classList.contains('hidden')) {
    const updated = items.find((it) => it.id === current?.id)
    if (updated) openDetail(updated)
    else { current = null; show('list-view') }
  }
  $('status-text').textContent = t('{count} 条密码', { count: items.length })
}
setInterval(() => void checkLock().catch(() => {}), 15_000)
window.addEventListener('focus', () => void checkLock().catch(() => {}))
document.addEventListener('visibilitychange', () => { if (document.hidden) maskPassword() })
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'hd-pm-state-changed') refreshing = refreshing.then(() => checkLock(true)).catch(() => {})
})
$('language-select').addEventListener('change', async () => {
  const select = $('language-select')
  select.disabled = true
  try { await setLanguage(select.value) }
  catch (err) { setMsg($('status-text'), translateError(err), 'bad'); select.value = getLanguagePreference() }
  finally { select.disabled = false }
})
onLanguageChange(() => {
  $('language-select').value = getLanguagePreference()
  if (!lastStatus) return
  clearTimeout(flashTimer)
  // Render labels from state without reopening a view or touching entered values.
  if (lastStatus.locked || !lastStatus.hasVault) {
    $('gate-text').textContent = lastStatus.hasVault ? t('密码库已锁定，输入主密码继续。') : t('创建密码库，或从设置中恢复已有的密文备份。')
    $('sync-badge').textContent = lastStatus.hasVault ? t('已锁定') : t('欢迎使用')
    $('status-text').textContent = lastStatus.hasVault ? t('明文已从界面清除') : t('本机加密 · 自部署同步')
  } else {
    updateSyncBadge(lastStatus)
    renderCounts()
    renderList()
  }
  $('d-reveal').textContent = $('d-reveal').getAttribute('aria-pressed') === 'true' ? t('隐藏') : t('显示')
  $('e-reveal').textContent = $('e-pass').type === 'password' ? t('显示') : t('隐藏')
  $('e-heading').textContent = editing ? t('编辑账号') : t('添加账号')
  if (current) $('d-fill').title = matchingIds.has(current.id) ? t('填充当前页面的登录表单') : t('条目网址与当前页面不匹配')
  if (editConflict) setMsg($('edit-msg'), t('密码库已在其他页面更新，当前输入已保留；保存前请核对。'), 'warn')
})
async function start() {
  await initI18n()
  localize()
  $('language-select').value = getLanguagePreference()
  await boot()
  await initIntro({ surface: 'popup' })
}
void start().catch((err) => { show('gate'); setMsg($('gate-msg'), translateError(err), 'bad') })
