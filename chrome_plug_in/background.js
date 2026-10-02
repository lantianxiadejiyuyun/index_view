/**
 * Service worker: encrypted persistence, serialized mutations, session lifetime and sync.
 * Content scripts can only match/fill credentials for their own document URL.
 */
import {
  BadPasswordError, createFile, exportEncrypted, exportPlain, parseImport,
  rekeyFile, removeItem, sealFile, unlockFile, unlockWithKey, upsertItem, validateFile,
} from './src/vault.js'
import { labelOf, matchItems, matches } from './src/match.js'
import * as sync from './src/sync.js'
import { resolveLocale, tForLocale } from './ui/i18n.js'
import { safeServerForm } from './ui/server-form-cache.js'

// Content scripts receive a small translated dictionary instead of importing UI code
// into a website or requesting an additional extension permission.
const CONTENT_UI = [
  '密码库已锁定 · 点扩展图标解锁', '保存了 {count} 个账号', '选择要填充的账号',
  '（未命名）', '（没有用户名）', '扩展连接已断开，请刷新页面后重试',
  '正在填充，请稍候', '这个页面里没找到可填写的密码框', '正在填充…',
  '页面或表单已变化，请重新选择账号', '已填充：{title}', '账号', '填充失败，请重试',
  '这个页面里没找到可填写的密码框；嵌入的登录表单可点击框旁提示填充',
  '页面已变化，请重新选择账号', '密码库已锁定，请先解锁',
  '该账号的网址与当前页面不匹配，未填充', '填充失败，请刷新页面重试',
]

function localeFor(language) {
  return resolveLocale(language, chrome.i18n?.getUILanguage?.())
}

const DEFAULT_SETTINGS = { autoLockMinutes: 10, lockOnIdle: true, autoPush: true, promptOnMatch: true }
const DEFAULT_SYNC = {
  base: '', user: '', version: 0, enabled: false, insecure: false,
  lastSyncAt: 0, dirty: false, conflict: false, remoteVersion: null, lastError: '',
}
let session = null
let sessionEpoch = 0
let lastActivity = Date.now()
let pushTimer = null
let work = Promise.resolve()

function failure(message, code) {
  return Object.assign(new Error(message), { code })
}
function assertEpoch(epoch) {
  if (epoch !== sessionEpoch) throw failure('操作已取消，保险库已锁定', 'session_expired')
}
function active(current = session) {
  if (!current || current !== session) throw failure('保险库已锁定，请重新解锁', 'locked')
  return current
}
function enqueue(task, epoch = sessionEpoch) {
  const result = work.then(() => { if (epoch !== null) assertEpoch(epoch); return task(epoch) })
  work = result.catch(() => {})
  return result
}
function touch() { lastActivity = Date.now() }

async function readAll() {
  const data = await chrome.storage.local.get(['file', 'settings', 'sync', 'language'])
  return {
    file: data.file ?? null,
    settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) },
    sync: { ...DEFAULT_SYNC, ...(data.sync ?? {}) },
    language: data.language ?? 'auto',
  }
}
async function writeSync(patch, current) {
  const state = await readAll()
  if (current) active(current)
  const next = { ...state.sync, ...patch }
  await chrome.storage.local.set({ sync: next })
  if (current) active(current)
  return next
}

async function readServerForm() {
  const data = await chrome.storage.local.get(['serverFormDraft', 'serverFormDraftRevision'])
  let revision = data.serverFormDraftRevision
  if (typeof revision !== 'string' || !revision) {
    revision = crypto.randomUUID()
    await chrome.storage.local.set({ serverFormDraftRevision: revision })
  }
  return { revision, draft: safeServerForm(data.serverFormDraft) }
}

async function invalidateServerForm() {
  const revision = crypto.randomUUID()
  // Clear the data and change its generation atomically. Old pages can no longer
  // save their pending drafts, even if they miss the following broadcast.
  await chrome.storage.local.set({ serverFormDraft: null, serverFormDraftRevision: revision })
  await chrome.runtime.sendMessage({ type: 'hd-pm-form-draft-reset', revision }).catch(() => {})
  return revision
}

/** Publish only after encryption and persistence succeed; never revive a discarded session. */
async function persist(current, vault, syncPatch = {}) {
  active(current)
  const state = await readAll()
  active(current)
  const sealed = await sealFile(state.file, vault, current.vaultKey)
  active(current)
  await chrome.storage.local.set({
    file: sealed.file,
    sync: { ...state.sync, dirty: true, ...syncPatch },
  })
  active(current)
  current.vault = sealed.vault
  return sealed.file
}

async function refreshBadge(tabId, url) {
  const hits = session && /^https?:/.test(url ?? '') ? matchItems(session.vault.items, url) : []
  await chrome.action.setBadgeText({ tabId, text: hits.length ? String(hits.length) : '' }).catch(() => {})
  if (hits.length) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f7cff' }).catch(() => {})
}
async function notifyState() {
  const tabs = await chrome.tabs.query({}).catch(() => [])
  await Promise.allSettled(tabs.filter((tab) => tab.id != null).map(async (tab) => {
    await refreshBadge(tab.id, tab.url ?? '')
    await chrome.tabs.sendMessage(tab.id, { type: 'hd-pm-refresh' }).catch(() => {})
  }))
  await chrome.runtime.sendMessage({ type: 'hd-pm-state-changed' }).catch(() => {})
}
function cancelPush() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
  void chrome.alarms.clear('vault-push')
}
async function schedulePush() {
  const state = await readAll()
  if (!session || !state.settings.autoPush || !state.sync.enabled || !state.sync.dirty || state.sync.conflict) return
  cancelPush()
  const epoch = sessionEpoch
  // Alarm survives service-worker suspension; the timer gives an active worker a quick flush.
  chrome.alarms.create('vault-push', { delayInMinutes: 1 })
  pushTimer = setTimeout(() => {
    pushTimer = null
    void chrome.alarms.clear('vault-push')
    void enqueue(() => pushNow({ automatic: true }), epoch).catch(() => {})
  }, 5000)
}

async function ensureToken(current, conf) {
  active(current)
  const account = current.vault.account
  if (!conf.enabled || !account || account.base !== conf.base || account.user !== conf.user) {
    throw failure('请先绑定服务器账号', 'no_account')
  }
  if (current.token) return current.token
  const { token } = await sync.login(account.base, account.user, account.password)
  active(current)
  current.token = token
  return token
}
async function withToken(current, conf, task) {
  const token = await ensureToken(current, conf)
  active(current)
  try {
    const result = await task(token)
    active(current)
    return result
  } catch (err) {
    active(current)
    if (err instanceof sync.SyncError && err.status === 401) {
      current.token = null
      const replacement = await ensureToken(current, conf)
      active(current)
      const result = await task(replacement)
      active(current)
      return result
    }
    throw err
  }
}
async function recordSyncError(err, current) {
  if (current !== session) return
  await writeSync({
    lastError: err.message,
    ...(err.status === 409 || err.code === 'conflict'
      ? { conflict: true, remoteVersion: err.data?.version ?? null } : {}),
  }, current)
  void notifyState()
}
function conflictError(version) {
  return new sync.SyncError('服务器已有不同版本，请选择下载服务器版本或确认覆盖上传', {
    status: 409, code: 'conflict', data: { version },
  })
}

async function pushNow({ force = false, automatic = false } = {}) {
  if (!session) return { pushed: false, reason: 'locked' }
  const current = active()
  const state = await readAll()
  active(current)
  const conf = state.sync
  if (!conf.enabled || !conf.base) return { pushed: false, reason: 'disabled' }
  if (automatic && (!state.settings.autoPush || !conf.dirty || conf.conflict)) {
    return { pushed: false, reason: conf.conflict ? 'conflict' : 'disabled' }
  }
  try {
    if (conf.conflict && !force) throw conflictError(conf.remoteVersion)
    let version = conf.version
    if (force) {
      const remote = await withToken(current, conf, (token) => sync.pull(conf.base, token))
      version = remote.version
    }
    const result = await withToken(current, conf, (token) =>
      sync.push(conf.base, token, version, JSON.stringify(state.file)))
    await writeSync({
      version: result.version, lastSyncAt: Date.now(), dirty: false,
      conflict: false, remoteVersion: null, lastError: '',
    }, current)
    void notifyState()
    return { pushed: true, version: result.version }
  } catch (err) {
    await recordSyncError(err, current)
    throw err
  }
}

async function pullNow({ force = false, password } = {}) {
  const current = active()
  const state = await readAll()
  active(current)
  const conf = state.sync
  if (!conf.enabled || !conf.base) throw failure('请先绑定服务器账号', 'no_account')
  try {
    const remote = await withToken(current, conf, (token) => sync.pull(conf.base, token))
    if (!remote.blob) return { pulled: false, reason: 'empty', version: remote.version }
    if (!force && remote.version === conf.version && !conf.conflict) {
      return { pulled: false, reason: 'up-to-date', version: remote.version }
    }
    if (!force && state.sync.dirty) throw conflictError(remote.version)
    let remoteFile
    try { remoteFile = validateFile(JSON.parse(remote.blob)) } catch (err) {
      throw failure(`服务器保险库无效：${err.message}`, 'invalid_remote_vault')
    }
    let unlocked
    if (typeof password === 'string' && password) {
      unlocked = await unlockFile(remoteFile, password)
    } else {
      const sameKdf = ['name', 'salt', 'iterations'].every((key) => remoteFile.kdf[key] === state.file.kdf[key])
      if (!sameKdf) throw failure('请输入服务器保险库的主密码，以恢复这台设备', 'remote_password_required')
      try { unlocked = await unlockWithKey(remoteFile, current.vaultKey) } catch (err) {
        if (err instanceof BadPasswordError) throw failure('请输入服务器保险库的主密码', 'remote_password_required')
        throw err
      }
    }
    active(current)
    // Keep the explicitly selected binding, rather than activating credentials from another device.
    const vault = { ...unlocked.vault, account: current.vault.account }
    const sealed = await sealFile(remoteFile, vault, unlocked.vaultKey)
    active(current)
    await chrome.storage.local.set({
      file: sealed.file,
      sync: {
        ...conf, version: remote.version, lastSyncAt: Date.now(), dirty: false,
        conflict: false, remoteVersion: null, lastError: '',
      },
    })
    active(current)
    current.vault = sealed.vault
    current.vaultKey = unlocked.vaultKey
    cancelPush()
    void notifyState()
    return { pulled: true, version: remote.version, items: sealed.vault.items.length }
  } catch (err) {
    await recordSyncError(err, current)
    throw err
  }
}

function doLock() {
  sessionEpoch += 1
  session = null
  cancelPush()
  void chrome.action.setBadgeText({ text: '' }).catch(() => {})
  void notifyState()
  return { locked: true }
}

const handlers = {
  'server-form-get': readServerForm,
  async 'server-form-save'({ draft, revision }) {
    const current = await readServerForm()
    if (revision !== current.revision) return { saved: false, revision: current.revision }
    const value = safeServerForm(draft)
    if (!value) throw new Error('设置格式无效')
    await chrome.storage.local.set({ serverFormDraft: value })
    return { saved: true, revision: current.revision }
  },
  async status() {
    const state = await readAll()
    return {
      hasVault: Boolean(state.file), locked: !session, items: session?.vault.items.length ?? null,
      settings: state.settings,
      sync: { ...state.sync, hasAccount: Boolean(session?.vault.account) },
    }
  },
  async create({ password }, _sender, epoch) {
    const existing = await readAll()
    assertEpoch(epoch)
    if (existing.file) throw new Error('保险库已经存在了（想换主密码请去设置页）')
    const created = await createFile(password)
    assertEpoch(epoch)
    await chrome.storage.local.set({ file: created.file, sync: { ...DEFAULT_SYNC, dirty: true } })
    assertEpoch(epoch)
    session = { vault: created.vault, vaultKey: created.vaultKey, token: null }
    touch()
    void notifyState()
    return { items: created.vault.items.length }
  },
  async unlock({ password }, _sender, epoch) {
    const state = await readAll()
    assertEpoch(epoch)
    const unlocked = await unlockFile(state.file, password)
    assertEpoch(epoch)
    session = { ...unlocked, token: null }
    touch()
    void notifyState()
    void schedulePush()
    return { items: unlocked.vault.items.length }
  },
  lock: doLock,
  async list() {
    const current = active()
    return { items: current.vault.items.map((item) => ({ ...item, title: labelOf(item) })) }
  },
  async match({ url }, sender) {
    const { settings, language } = await readAll()
    const current = session
    const documentUrl = sender.tab ? sender.url : url
    const locale = localeFor(language)
    return {
      locked: !current, prompt: settings.promptOnMatch,
      locale,
      ui: Object.fromEntries(CONTENT_UI.map((source) => [source, tForLocale(locale, source)])),
      items: current ? matchItems(current.vault.items, documentUrl).map((item) => ({
        id: item.id, title: labelOf(item), username: item.username, host: item.url,
      })) : [],
    }
  },
  async fill({ id, url }, sender) {
    const current = active()
    const item = current.vault.items.find((entry) => entry.id === id)
    if (!item) throw new Error('条目不存在')
    const documentUrl = sender.tab ? sender.url : url
    if (!matches(item, documentUrl)) throw failure('该账号的网址与当前页面不匹配，已取消填充', 'url_mismatch')
    touch()
    return { username: item.username, password: item.password }
  },
  async save({ item }) {
    const current = active()
    const next = upsertItem(current.vault, item)
    await persist(current, next)
    void notifyState()
    void schedulePush()
    return { ok: true, id: item.id ?? next.items.at(-1).id }
  },
  async remove({ id }) {
    const current = active()
    await persist(current, removeItem(current.vault, id))
    void notifyState()
    void schedulePush()
    return { ok: true }
  },
  async export({ plain = false }) {
    const { file } = await readAll()
    return plain ? { text: exportPlain(active().vault), kind: 'plain' }
      : { text: exportEncrypted(file), kind: 'encrypted' }
  },
  async import({ text, password }, _sender, epoch) {
    const parsed = parseImport(text)
    if (parsed.kind === 'encrypted') {
      const unlocked = await unlockFile(parsed.file, password)
      assertEpoch(epoch)
      // An imported backup must not silently target the previous binding.
      await chrome.storage.local.set({ file: parsed.file, sync: { ...DEFAULT_SYNC, dirty: true } })
      assertEpoch(epoch)
      session = { ...unlocked, token: null }
      touch()
      cancelPush()
      void notifyState()
      return { imported: unlocked.vault.items.length, disconnected: true }
    }
    const current = active()
    await persist(current, { ...current.vault, items: [...current.vault.items, ...parsed.items] })
    void notifyState()
    void schedulePush()
    return { imported: parsed.items.length }
  },
  async 'settings-get'() { return (await readAll()).settings },
  async 'settings-set'({ settings }) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('设置格式无效')
    const next = { ...(await readAll()).settings }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(settings, key)) continue
      const value = settings[key]
      if (key === 'autoLockMinutes') {
        if (!Number.isFinite(value) || value < 0 || value > 1440) throw new Error('自动锁定时间必须在 0 到 1440 分钟之间')
      } else if (typeof value !== 'boolean') throw new Error('开关设置必须是布尔值')
      next[key] = value
    }
    await chrome.storage.local.set({ settings: next })
    if (!next.autoPush) cancelPush()
    else void schedulePush()
    void notifyState()
    return next
  },
  async 'account-status'() {
    const { sync: conf } = await readAll()
    const account = session?.vault.account
    return {
      ...conf, ready: Boolean(session), configured: Boolean(conf.enabled && account?.base),
      signedIn: Boolean(session?.token),
    }
  },
  async 'account-test'({ base }) {
    const check = sync.normalizeServer(base)
    if (!check.ok) throw new Error(check.error)
    return { ...await sync.testConnection(check.base), base: check.base, insecure: check.insecure }
  },
  async 'account-connect'({ base, user, password }) {
    const current = active()
    const check = sync.normalizeServer(base)
    if (!check.ok) throw new Error(check.error)
    if (typeof user !== 'string' || !user.trim() || (password !== undefined && typeof password !== 'string')) {
      throw new Error('账号和密码都要填')
    }
    user = user.trim()
    if (!password) {
      const saved = current.vault.account
      // An empty field can reuse only this exact, normalized binding. Never send
      // the previous server's credentials to a newly edited address or username.
      if (saved?.base === check.base && saved.user === user && typeof saved.password === 'string') password = saved.password
    }
    if (!password) throw new Error('账号和密码都要填')
    await sync.testConnection(check.base)
    active(current)
    // Only replace an in-memory session from this exact binding. Never send a
    // previous server/account's bearer token to an edited destination.
    const saved = current.vault.account
    const previousToken = saved?.base === check.base && saved.user === user ? current.token : undefined
    const { token } = await sync.login(check.base, user, password, previousToken)
    active(current)
    const remote = await sync.pull(check.base, token)
    active(current)
    const account = { base: check.base, user, password }
    const hasRemote = Boolean(remote.blob)
    await persist(current, { ...current.vault, account }, {
      ...DEFAULT_SYNC, base: check.base, user, enabled: true, insecure: check.insecure,
      dirty: true, conflict: hasRemote, remoteVersion: hasRemote ? remote.version : null,
    })
    current.token = token
    cancelPush()
    void notifyState()
    if (hasRemote) {
      return {
        base: check.base, user, insecure: check.insecure, pushed: false, conflict: true,
        remoteVersion: remote.version, message: '服务器已有保险库，请选择下载恢复或确认覆盖上传',
      }
    }
    try {
      return { base: check.base, user, insecure: check.insecure, ...await pushNow() }
    } catch (err) {
      return { base: check.base, user, insecure: check.insecure, pushed: false, message: err.message, code: err.code }
    }
  },
  async 'account-forget'() {
    const current = active()
    const { account: _account, ...vault } = current.vault
    await persist(current, vault, { ...DEFAULT_SYNC, dirty: true })
    const draftRevision = await invalidateServerForm()
    current.token = null
    cancelPush()
    void notifyState()
    return { ok: true, draftRevision }
  },
  'sync-push': (payload) => pushNow(payload),
  'sync-pull': (payload) => pullNow(payload),
  async 'change-master'({ current: password, next }, _sender, epoch) {
    const state = await readAll()
    const unlocked = await unlockFile(state.file, password)
    assertEpoch(epoch)
    const rekeyed = await rekeyFile(state.file, unlocked.vault, next)
    assertEpoch(epoch)
    await chrome.storage.local.set({ file: rekeyed.file, sync: { ...state.sync, dirty: true } })
    assertEpoch(epoch)
    session = { vault: rekeyed.vault, vaultKey: rekeyed.vaultKey, token: null }
    touch()
    void schedulePush()
    void notifyState()
    return { ok: true }
  },
  async 'reset-all'() {
    doLock()
    await chrome.storage.local.clear()
    const draftRevision = await invalidateServerForm()
    void notifyState()
    return { ok: true, draftRevision }
  },
}

const reads = new Set(['status', 'settings-get', 'account-status', 'match', 'list', 'fill'])
const formMessages = new Set(['server-form-get', 'server-form-save'])
const interactions = new Set(['list', 'fill', 'save', 'remove', 'export', 'import', 'settings-set', 'account-connect', 'sync-push', 'sync-pull', 'change-master'])
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'hd-pm-state-changed' || msg?.type === 'hd-pm-form-draft-reset') return false
  const handler = Object.hasOwn(handlers, msg?.type) ? handlers[msg.type] : null
  const trusted = sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL(''))
  const content = sender.id === chrome.runtime.id && sender.tab && /^https?:/.test(sender.url ?? '')
  if (!handler || (!trusted && !(content && ['match', 'fill'].includes(msg?.type)))) {
    respond({ ok: false, error: handler ? '该页面无权执行此操作' : '未知消息', code: handler ? 'forbidden' : 'unknown_message' })
    return false
  }
  if (interactions.has(msg.type)) touch()
  const epoch = sessionEpoch
  const invoke = () => handler(msg, sender, epoch)
  const result = formMessages.has(msg.type)
    ? enqueue(invoke, null)
    : msg.type === 'lock' || reads.has(msg.type)
      ? Promise.resolve().then(invoke) : enqueue(invoke, epoch)
  result.then((data) => respond({ ok: true, data })).catch(async (err) => {
    let message = err?.message ?? String(err)
    // Extension pages translate source errors through their shared UI helper;
    // website frames have only their matched dictionary, so localize their errors here.
    if (content) {
      const { language } = await readAll().catch(() => ({ language: 'auto' }))
      message = tForLocale(localeFor(language), message)
    }
    respond({
      ok: false, error: message, badPassword: err instanceof BadPasswordError,
      code: err.code ?? (err instanceof BadPasswordError ? 'bad_password' : ''), status: err.status ?? 0,
    })
  })
  return true
})

chrome.alarms.create('lock-tick', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === 'vault-push') {
    void enqueue(() => pushNow({ automatic: true })).catch(() => {})
    return
  }
  if (name !== 'lock-tick' || !session) return
  const { settings } = await readAll()
  if (settings.autoLockMinutes > 0 && Date.now() - lastActivity >= settings.autoLockMinutes * 60_000) doLock()
})
if (chrome.idle?.onStateChanged) {
  chrome.idle.setDetectionInterval(120)
  chrome.idle.onStateChanged.addListener(async (state) => {
    if (state !== 'active' && (await readAll()).settings.lockOnIdle) doLock()
  })
}
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  await refreshBadge(tabId, tab?.url ?? '')
})
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) void refreshBadge(tabId, tab.url ?? '')
})
chrome.runtime.onInstalled.addListener(() => { void notifyState() })
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && Object.hasOwn(changes, 'language')) void notifyState()
})
