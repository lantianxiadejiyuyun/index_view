import test from 'node:test'
import assert from 'node:assert/strict'
import { createFile, sealFile, unlockFile, upsertItem, exportEncrypted } from '../chrome_plug_in/src/vault.js'
import { createServerFormCache } from '../chrome_plug_in/ui/server-form-cache.js'

const PASSWORD = 'local-master-password'
let serial = 0
function event() {
  const listeners = []
  return { listeners, addListener: (listener) => listeners.push(listener) }
}
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function fixture(password = PASSWORD, title = 'Remote account') {
  const created = await createFile(password)
  const vault = upsertItem(created.vault, { title, url: 'example.com', username: 'fixture-user', password: 'fixture-secret' })
  return (await sealFile(created.file, vault, created.vaultKey)).file
}
async function setup(t, { remoteFile = null, remoteVersion = 0, stored = {}, browserLocale = 'zh-CN' } = {}) {
  const previousChrome = globalThis.chrome
  const previousFetch = globalThis.fetch
  const storage = structuredClone(stored)
  const requests = []
  const broadcasts = []
  const servers = new Map([['https://sync.example.test', {
    version: remoteVersion, blob: remoteFile ? JSON.stringify(remoteFile) : null,
  }]])
  const alarms = new Map()
  const runtime = {
    id: 'fixture-extension', getURL: (path = '') => 'chrome-extension://fixture-extension/' + path,
    onMessage: event(), onInstalled: event(), sendMessage: async (message) => { broadcasts.push(message); return {} },
  }
  const chrome = {
    runtime,
    i18n: { getUILanguage: () => browserLocale },
    storage: { local: {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, structuredClone(storage[key])])),
      set: async (patch) => {
        const changes = Object.fromEntries(Object.keys(patch).map((key) => [key, { oldValue: storage[key], newValue: patch[key] }]))
        Object.assign(storage, structuredClone(patch))
        for (const listener of chrome.storage.onChanged.listeners) listener(changes, 'local')
      },
      clear: async () => { for (const key of Object.keys(storage)) delete storage[key] },
    }, onChanged: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      query: async () => [], get: async () => ({}), sendMessage: async () => ({}),
      onActivated: event(), onUpdated: event(),
    },
    alarms: {
      create: (name, config) => { alarms.set(name, config) },
      clear: async (name) => alarms.delete(name), onAlarm: event(),
    },
    idle: { setDetectionInterval: () => {}, onStateChanged: event() },
  }
  let intercept = null
  globalThis.chrome = chrome
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input)
    const request = { url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null, options }
    requests.push(request)
    if (intercept) {
      const response = await intercept(request)
      if (response) return response
    }
    const server = servers.get(url.origin)
    assert.ok(server, 'tests must never call an unconfigured server: ' + url.origin)
    if (url.pathname === '/api/health') return Response.json({ ok: true, service: 'fixture-dashboard' })
    if (url.pathname === '/api/auth/login') return Response.json({ access_token: 'fixture-token' })
    if (url.pathname === '/api/vault' && request.method === 'GET') {
      return Response.json({ version: server.version, blob: server.blob, updated_at: null })
    }
    if (url.pathname === '/api/vault' && request.method === 'PUT') {
      if (request.body.base_version !== server.version) {
        return Response.json({ error: 'conflict', message: 'fixture conflict', version: server.version, blob: server.blob }, { status: 409 })
      }
      server.version += 1
      server.blob = request.body.blob
      return Response.json({ version: server.version })
    }
    throw new Error('Unexpected fixture request')
  }
  await import('../chrome_plug_in/background.js?fixture=' + ++serial)
  const sender = { id: runtime.id, url: runtime.getURL('options/options.html') }
  function send(type, payload = {}, origin = sender) {
    return new Promise((resolve) => runtime.onMessage.listeners[0]({ type, ...payload }, origin, resolve))
  }
  async function ok(type, payload = {}, origin) {
    const result = await send(type, payload, origin)
    assert.equal(result.ok, true, type + ': ' + result.error)
    return result.data
  }
  async function alarm(name) {
    await chrome.alarms.onAlarm.listeners[0]({ name })
    // The background queues sync separately. A queued settings write acts as a barrier.
    await ok('settings-set', { settings: {} })
  }
  t.after(async () => {
    await send('lock')
    await new Promise((resolve) => setImmediate(resolve))
    globalThis.chrome = previousChrome
    globalThis.fetch = previousFetch
  })
  return {
    storage, requests, servers, alarms, send, ok, alarm, chrome, broadcasts,
    intercept: (callback) => { intercept = callback },
    content: (url) => ({ id: runtime.id, tab: { id: 1 }, url }),
    connect: () => ok('account-connect', { base: 'https://sync.example.test', user: 'fixture-user', password: 'fixture-account-password' }),
  }
}

test('first binding uploads to an empty server and encrypted data alone persists', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  const connected = await h.connect()
  assert.equal(connected.pushed, true)
  assert.equal(h.storage.sync.version, 1)
  assert.equal(h.storage.sync.dirty, false)
  const persisted = JSON.stringify(h.storage)
  assert.equal(persisted.includes('fixture-account-password'), false)
  assert.equal(persisted.includes(PASSWORD), false)
  assert.equal(persisted.includes('fixture-token'), false)
  assert.equal(h.requests.find((request) => request.method === 'PUT').body.base_version, 0)
  const login = h.requests.find((request) => request.url.pathname === '/api/auth/login')
  assert.equal(login.body.client, 'extension')
  assert.equal(login.options.credentials, 'omit')
  assert.equal(login.options.headers.Authorization, undefined)
})

test('existing remote vault is never overwritten on bind and restores with its own salt and password', async (t) => {
  const remotePassword = 'different-remote-master'
  const remoteFile = await fixture(remotePassword)
  const h = await setup(t, { remoteFile, remoteVersion: 7 })
  await h.ok('create', { password: PASSWORD })
  const localSalt = h.storage.file.kdf.salt
  const connected = await h.connect()
  assert.equal(connected.conflict, true)
  assert.equal(connected.remoteVersion, 7)
  assert.equal(h.requests.filter((request) => request.method === 'PUT').length, 0)
  assert.equal(h.storage.sync.conflict, true)
  const required = await h.send('sync-pull', { force: true })
  assert.equal(required.code, 'remote_password_required')
  assert.equal(h.storage.file.kdf.salt, localSalt)
  const wrong = await h.send('sync-pull', { force: true, password: 'wrong-remote-password' })
  assert.equal(wrong.badPassword, true)
  const restored = await h.ok('sync-pull', { force: true, password: remotePassword })
  assert.equal(restored.items, 1)
  assert.equal(h.storage.file.kdf.salt, remoteFile.kdf.salt)
  assert.equal(h.storage.sync.version, 7)
  assert.equal(h.storage.sync.conflict, false)
  assert.equal((await h.ok('list')).items[0].title, 'Remote account')
  await h.ok('lock')
  await h.ok('unlock', { password: remotePassword })
  assert.equal((await h.ok('account-status')).configured, true)
  assert.equal((await h.ok('sync-push')).version, 8)
})

test('force upload reads current server version but still detects a second device racing the write', async (t) => {
  const h = await setup(t, { remoteFile: await fixture(), remoteVersion: 3 })
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  assert.equal((await h.send('sync-push')).code, 'conflict')
  let raced = false
  h.intercept((request) => {
    if (request.method === 'PUT' && !raced) {
      h.servers.get(request.url.origin).version += 1
      raced = true
    }
  })
  const conflict = await h.send('sync-push', { force: true })
  assert.equal(conflict.status, 409)
  assert.equal(h.storage.sync.conflict, true)
  assert.equal(h.storage.sync.remoteVersion, 4)
  assert.equal(h.storage.sync.version, 0)
  h.intercept(null)
  assert.equal((await h.ok('sync-push', { force: true })).version, 5)
  assert.equal(h.storage.sync.lastError, '')
})

test('changing the binding resets the version instead of reusing the previous server version', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  await h.ok('sync-push')
  h.servers.set('https://second.example.test', { version: 0, blob: null })
  const result = await h.ok('account-connect', { base: 'https://second.example.test', user: 'other-user', password: 'fixture-account-password' })
  assert.equal(result.pushed, true)
  assert.equal(result.version, 1)
  assert.equal(h.requests.find((request) => request.url.origin.includes('second') && request.method === 'PUT').body.base_version, 0)
  const login = h.requests.find((request) => request.url.origin.includes('second') && request.url.pathname === '/api/auth/login')
  assert.equal(login.options.headers.Authorization, undefined)
  assert.equal(login.options.credentials, 'omit')
  assert.equal(login.body.client, 'extension')
})

test('reconnecting the same normalized binding replaces only its own extension session', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  await h.ok('account-connect', { base: 'https://sync.example.test/', user: ' fixture-user ', password: '' })
  const logins = h.requests.filter((request) => request.url.pathname === '/api/auth/login')
  assert.equal(logins.length, 2)
  assert.equal(logins[0].options.headers.Authorization, undefined)
  assert.equal(logins[1].options.headers.Authorization, 'Bearer fixture-token')
  assert.equal(logins[1].options.credentials, 'omit')
  assert.deepEqual(logins[1].body, { username: 'fixture-user', password: 'fixture-account-password', client: 'extension' })
})

test('changing either server or username never sends the old session bearer to login', async (t) => {
  for (const [base, user] of [
    ['https://sync.example.test', 'another-user'],
    ['https://second.example.test', 'fixture-user'],
  ]) {
    await t.test(`${base} ${user}`, async (t) => {
      const h = await setup(t)
      await h.ok('create', { password: PASSWORD })
      await h.connect()
      h.servers.set('https://second.example.test', { version: 0, blob: null })
      await h.ok('account-connect', { base, user, password: 'replacement-password' })
      const login = h.requests.filter((request) => request.url.pathname === '/api/auth/login').at(-1)
      assert.equal(login.options.headers.Authorization, undefined)
      assert.equal(login.options.credentials, 'omit')
      assert.equal(login.body.client, 'extension')
    })
  }
})

test('locking while account login is pending cannot revive the session or persist a binding', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  const started = deferred()
  const release = deferred()
  h.intercept(async (request) => {
    if (request.url.pathname === '/api/auth/login') {
      started.resolve()
      await release.promise
    }
  })
  const connecting = h.send('account-connect', { base: 'https://sync.example.test', user: 'fixture-user', password: 'fixture-account-password' })
  await started.promise
  await h.ok('lock')
  release.resolve()
  assert.equal((await connecting).ok, false)
  assert.equal((await h.ok('status')).locked, true)
  assert.equal(h.storage.sync.enabled, false)
  assert.equal(h.requests.filter((request) => request.url.pathname === '/api/vault').length, 0)
})

test('locking during key derivation cancels unlock, including queued mutations', async (t) => {
  const h = await setup(t, { stored: { file: await fixture() } })
  const unlocking = h.send('unlock', { password: PASSWORD })
  const queued = h.send('save', { item: { title: 'Must not save', url: 'example.com' } })
  // Let unlock reach asynchronous PBKDF2 before issuing the lock.
  await new Promise((resolve) => setTimeout(resolve, 10))
  await h.ok('lock')
  assert.equal((await unlocking).ok, false)
  assert.equal((await queued).code, 'session_expired')
  assert.equal((await h.ok('status')).locked, true)
})

test('concurrent edits serialize instead of losing entries', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await Promise.all(Array.from({ length: 12 }, (_, index) => h.ok('save', {
    item: { id: 'id-' + index, title: 'Entry ' + index, url: 'example.com', password: 'fixture-' + index },
  })))
  assert.equal((await h.ok('list')).items.length, 12)
  assert.equal((await unlockFile(h.storage.file, PASSWORD)).vault.items.length, 12)
})

test('disabled auto-upload applies to deletion and pending sync alarms; manual sync still works', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  await h.ok('save', { item: { id: 'delete-me', title: 'Temporary', url: 'example.com' } })
  await h.ok('settings-set', { settings: { autoPush: false } })
  await h.ok('remove', { id: 'delete-me' })
  const before = h.requests.length
  await h.alarm('vault-push')
  assert.equal(h.requests.length, before)
  assert.equal(h.storage.sync.dirty, true)
  assert.equal((await h.ok('sync-push')).pushed, true)
})

test('content scripts cannot read the full vault or fill an unrelated document', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.ok('save', { item: { id: 'entry', title: 'Example', url: 'example.com', username: 'alice', password: 'fixture-secret' } })
  const evil = h.content('https://evil.test/login')
  assert.equal((await h.send('list', {}, evil)).code, 'forbidden')
  assert.equal((await h.send('fill', { id: 'entry', url: 'https://example.com' }, evil)).code, 'url_mismatch')
  assert.equal((await h.ok('match', { url: 'https://example.com' }, evil)).items.length, 0)
  const good = h.content('https://example.com/login')
  const match = await h.ok('match', {}, good)
  assert.equal(match.items[0].password, undefined)
  assert.equal((await h.ok('fill', { id: 'entry' }, good)).password, 'fixture-secret')
  await h.ok('settings-set', { settings: { promptOnMatch: false } })
  assert.equal((await h.ok('match', {}, good)).prompt, false)
  await h.ok('lock')
  const locked = await h.ok('match', {}, good)
  assert.equal(locked.prompt, false)
  assert.equal(locked.locked, true)
})

test('background page matching never postpones automatic locking', async (t) => {
  const h = await setup(t)
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  t.after(() => { Date.now = realNow })
  await h.ok('create', { password: PASSWORD })
  await h.ok('settings-set', { settings: { autoLockMinutes: 1 } })
  now += 61_000
  await h.ok('match', {}, h.content('https://example.com'))
  await h.chrome.alarms.onAlarm.listeners[0]({ name: 'lock-tick' })
  assert.equal((await h.ok('status')).locked, true)
})

test('encrypted import stops the old binding; plain imports persist and mark pending sync', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  await h.ok('import', { text: JSON.stringify({
    app: 'hd-pm', kind: 'plain-vault',
    items: [{ id: 'same-id', title: 'Imported', url: 'example.com', password: 'fixture-secret' }],
  }) })
  assert.equal(h.storage.sync.dirty, true)
  await h.ok('import', { text: exportEncrypted(await fixture('backup-master-password')), password: 'backup-master-password' })
  assert.equal(h.storage.sync.enabled, false)
  const before = h.requests.length
  assert.equal((await h.ok('sync-push')).reason, 'disabled')
  assert.equal(h.requests.length, before)
})

test('failed automatic upload records a visible error without discarding dirty local changes', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  await h.ok('save', { item: { title: 'Local change', url: 'example.com' } })
  h.intercept((request) => request.method === 'PUT'
    ? Response.json({ error: 'unavailable', message: 'fixture server unavailable' }, { status: 503 }) : null)
  await h.alarm('vault-push')
  assert.equal(h.storage.sync.dirty, true)
  assert.equal((await h.ok('account-status')).lastError, 'fixture server unavailable')
  assert.equal((await h.ok('list')).items.length, 1)
})

test('changing the master password preserves items and marks the new encrypted file for sync', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.ok('save', { item: { title: 'Keep this account', url: 'example.com', password: 'fixture-secret' } })
  await h.connect()
  const originalSalt = h.storage.file.kdf.salt
  await h.ok('change-master', { current: PASSWORD, next: 'replacement-master-password' })
  assert.notEqual(h.storage.file.kdf.salt, originalSalt)
  assert.equal(h.storage.sync.dirty, true)
  await assert.rejects(unlockFile(h.storage.file, PASSWORD), { name: 'BadPasswordError' })
  assert.equal((await unlockFile(h.storage.file, 'replacement-master-password')).vault.items[0].title, 'Keep this account')
  await h.alarm('vault-push')
  const remote = JSON.parse(h.servers.get('https://sync.example.test').blob)
  assert.equal((await unlockFile(remote, 'replacement-master-password')).vault.items[0].password, 'fixture-secret')
})

test('expired server tokens are refreshed once and malformed remote files preserve local data', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  await h.ok('save', { item: { title: 'Local account', url: 'example.com' } })
  let unauthorized = false
  h.intercept((request) => {
    if (request.method === 'PUT' && !unauthorized) {
      unauthorized = true
      return Response.json({ error: 'unauthorized', message: 'expired fixture token' }, { status: 401 })
    }
  })
  assert.equal((await h.ok('sync-push')).pushed, true)
  assert.equal(h.requests.filter((request) => request.url.pathname === '/api/auth/login').length, 2)
  const relogin = h.requests.filter((request) => request.url.pathname === '/api/auth/login').at(-1)
  assert.equal(relogin.body.client, 'extension')
  assert.equal(relogin.options.headers.Authorization, undefined, 'a rejected token must be discarded before reauth')
  assert.equal(relogin.options.credentials, 'omit')
  const originalFile = structuredClone(h.storage.file)
  const server = h.servers.get('https://sync.example.test')
  server.blob = JSON.stringify({ v: 99, payload: {} })
  server.version += 1
  const result = await h.send('sync-pull', { force: true, password: PASSWORD })
  assert.equal(result.code, 'invalid_remote_vault')
  assert.deepEqual(h.storage.file, originalFile)
  assert.equal((await h.ok('list')).items[0].title, 'Local account')
})

test('downloading from an empty server does not unexpectedly upload the local vault', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  const server = h.servers.get('https://sync.example.test')
  server.blob = null
  server.version = 0
  const uploads = h.requests.filter((request) => request.method === 'PUT').length
  assert.equal((await h.ok('sync-pull', { force: true })).reason, 'empty')
  assert.equal(h.requests.filter((request) => request.method === 'PUT').length, uploads)
})

test('content language auto mode follows supported browser locales while the vault is locked', async (t) => {
  for (const [browserLocale, expected] of [['en-GB', 'en'], ['ja-JP', 'ja'], ['zh-Hant-HK', 'zh-TW'], ['zh-CN', 'zh-CN']]) {
    await t.test(browserLocale, async (t) => {
      const h = await setup(t, { browserLocale })
      const result = await h.ok('match', {}, h.content('https://example.com'))
      assert.equal(result.locale, expected)
      assert.equal(result.locked, true)
      assert.equal(result.items.length, 0)
      assert.ok(result.ui['选择要填充的账号'])
      if (expected !== 'zh-CN') assert.notEqual(result.ui['选择要填充的账号'], '选择要填充的账号')
      assert.ok(result.ui['保存了 {count} 个账号'].includes('{count}'))
      assert.equal(h.requests.length, 0)
    })
  }
})

test('changing only the UI language refreshes webpages without modifying the vault or sync state', async (t) => {
  const h = await setup(t, { stored: { language: 'ja' }, browserLocale: 'en-US' })
  await h.ok('create', { password: PASSWORD })
  const original = { file: structuredClone(h.storage.file), sync: structuredClone(h.storage.sync) }
  assert.equal((await h.ok('match', {}, h.content('https://example.com'))).locale, 'ja')
  await new Promise((resolve) => setImmediate(resolve))
  const before = h.broadcasts.length
  await h.chrome.storage.local.set({ language: 'en' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.broadcasts.length, before + 1)
  assert.equal(h.broadcasts.at(-1).type, 'hd-pm-state-changed')
  const match = await h.ok('match', {}, h.content('https://example.com'))
  assert.equal(match.locale, 'en')
  assert.doesNotMatch(match.ui['密码库已锁定 · 点扩展图标解锁'], /[\u4e00-\u9fff]/)
  assert.deepEqual(h.storage.file, original.file)
  assert.deepEqual(h.storage.sync, original.sync)
  assert.equal(h.requests.length, 0)
})

test('content fill errors are translated while codes and stored account text remain unchanged', async (t) => {
  const h = await setup(t, { stored: { language: 'en' }, browserLocale: 'zh-CN' })
  const locked = await h.send('fill', { id: 'entry' }, h.content('https://example.com'))
  assert.equal(locked.code, 'locked')
  assert.doesNotMatch(locked.error, /[\u4e00-\u9fff]/)
  await h.ok('create', { password: PASSWORD })
  await h.ok('save', { item: { id: 'entry', title: '原始账号标题', url: 'example.com', username: '我的账号', password: 'fixture-secret' } })
  const match = await h.ok('match', {}, h.content('https://example.com'))
  assert.equal(match.items[0].title, '原始账号标题')
  assert.equal(match.items[0].username, '我的账号')
  const mismatch = await h.send('fill', { id: 'entry' }, h.content('https://different.example.test'))
  assert.equal(mismatch.code, 'url_mismatch')
  assert.doesNotMatch(mismatch.error, /[\u4e00-\u9fff]/)
  const missing = await h.send('fill', { id: 'missing' }, h.content('https://example.com'))
  assert.equal(missing.ok, false)
  assert.doesNotMatch(missing.error, /[\u4e00-\u9fff]/)
})

test('reconnecting the same normalized server and account can reuse an encrypted password', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  for (const password of ['', undefined]) {
    const result = await h.ok('account-connect', { base: 'https://SYNC.EXAMPLE.TEST/', user: ' fixture-user ', password })
    assert.equal(result.conflict, true, 'reconnect must retain protection for the existing remote vault')
    const login = h.requests.filter((request) => request.url.pathname === '/api/auth/login').at(-1)
    assert.equal(login.body.username, 'fixture-user')
    assert.equal(login.body.password, 'fixture-account-password')
    assert.equal(JSON.stringify(result).includes('fixture-account-password'), false)
  }
  assert.equal(JSON.stringify(h.storage).includes('fixture-account-password'), false)
})

test('editing the server while leaving password blank rejects before any request or binding changes', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  const before = h.requests.length
  const original = structuredClone(h.storage)
  const result = await h.send('account-connect', { base: 'https://other.example.test', user: 'fixture-user', password: '' })
  assert.equal(result.ok, false)
  assert.equal(h.requests.length, before)
  assert.deepEqual(h.storage, original)
})

test('editing the username while leaving password blank never sends the saved credentials', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  const before = h.requests.length
  const original = structuredClone(h.storage)
  const result = await h.send('account-connect', { base: 'https://sync.example.test', user: 'another-user' })
  assert.equal(result.ok, false)
  assert.equal(h.requests.length, before)
  assert.deepEqual(h.storage, original)
})

test('an explicitly entered password replaces the saved credential without exposing plaintext', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  const replacement = 'new-explicit-account-password'
  const result = await h.ok('account-connect', { base: 'https://sync.example.test', user: 'fixture-user', password: replacement })
  const login = h.requests.filter((request) => request.url.pathname === '/api/auth/login').at(-1)
  assert.equal(login.body.password, replacement)
  assert.equal((await unlockFile(h.storage.file, PASSWORD)).vault.account.password, replacement)
  assert.equal(JSON.stringify(h.storage).includes(replacement), false)
  assert.equal(JSON.stringify(result).includes(replacement), false)
})

test('background draft messages accept only trusted pages and store no password or token', async (t) => {
  const h = await setup(t)
  for (const type of ['server-form-get', 'server-form-save']) {
    const rejected = await h.send(type, {}, h.content('https://example.com'))
    assert.equal(rejected.code, 'forbidden')
  }
  const state = await h.ok('server-form-get')
  assert.equal(typeof state.revision, 'string')
  assert.equal(state.draft, null)
  const result = await h.ok('server-form-save', {
    revision: state.revision,
    draft: { base: 'https://example.test', user: 'alice', password: 'must-not-persist', token: 'must-not-persist' },
  })
  assert.equal(result.saved, true)
  assert.deepEqual(h.storage.serverFormDraft, { base: 'https://example.test', user: 'alice' })
  assert.equal(JSON.stringify(h.storage).includes('must-not-persist'), false)
  assert.equal((await h.ok('status')).locked, true)
  assert.equal(h.requests.length, 0)
})

test('another page cannot resurrect a draft after unbinding, even if it misses the broadcast', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  await h.connect()
  let cleared = 0
  const secondPage = createServerFormCache({ send: h.ok, onInvalidate: () => { cleared += 1 } })
  await secondPage.load()
  secondPage.schedule({ base: 'https://stale.example.test', user: 'stale-user' })
  const forgotten = await h.ok('account-forget')
  assert.equal(h.storage.serverFormDraft, null)
  assert.ok(h.broadcasts.some((message) => message.type === 'hd-pm-form-draft-reset' && message.revision === forgotten.draftRevision))
  const stale = await secondPage.flush()
  assert.equal(stale.saved, false)
  assert.equal(cleared, 1)
  assert.equal(h.storage.serverFormDraft, null)
  assert.equal((await secondPage.flush({ base: 'https://new.example.test', user: 'new-user' })).saved, true)
})

test('the worker finishes a pagehide draft after its earlier storage write, without another page callback', async (t) => {
  const h = await setup(t)
  const cache = createServerFormCache({ send: h.ok })
  await cache.load()
  const started = deferred()
  const release = deferred()
  const originalSet = h.chrome.storage.local.set
  let writes = 0
  h.chrome.storage.local.set = async (patch) => {
    if (patch.serverFormDraft && ++writes === 1) { started.resolve(); await release.promise }
    return originalSet(patch)
  }
  const first = cache.flush({ base: 'https://first.example.test', user: 'first' })
  await started.promise
  cache.schedule({ base: 'https://last.example.test', user: 'last' })
  const closing = cache.flush()
  // The final request has already reached the worker's queue. This page need not
  // receive or act on the first response for the last write to execute.
  release.resolve()
  await Promise.all([first, closing])
  assert.deepEqual(h.storage.serverFormDraft, { base: 'https://last.example.test', user: 'last' })
})

test('locking cancels a pending account connection but preserves a queued non-secret draft', async (t) => {
  const h = await setup(t)
  await h.ok('create', { password: PASSWORD })
  const { revision } = await h.ok('server-form-get')
  const started = deferred()
  const release = deferred()
  h.intercept(async (request) => {
    if (request.url.pathname === '/api/auth/login') { started.resolve(); await release.promise }
  })
  const connecting = h.send('account-connect', { base: 'https://sync.example.test', user: 'fixture-user', password: 'fixture-account-password' })
  await started.promise
  const saving = h.ok('server-form-save', { revision, draft: { base: 'https://draft.example.test', user: 'draft-user' } })
  await h.ok('lock')
  release.resolve()
  assert.equal((await connecting).ok, false)
  assert.equal((await saving).saved, true)
  assert.equal((await h.ok('status')).locked, true)
  assert.deepEqual(h.storage.serverFormDraft, { base: 'https://draft.example.test', user: 'draft-user' })
})

test('resetting all data invalidates old pages instead of reusing their draft generation', async (t) => {
  const h = await setup(t)
  const { revision } = await h.ok('server-form-get')
  await h.ok('server-form-save', { revision, draft: { base: 'https://old.example.test', user: 'old-user' } })
  const reset = await h.ok('reset-all')
  assert.notEqual(reset.draftRevision, revision)
  const stale = await h.ok('server-form-save', { revision, draft: { base: 'https://old.example.test', user: 'old-user' } })
  assert.equal(stale.saved, false)
  assert.equal(h.storage.serverFormDraft, null)
  assert.equal(h.storage.file, undefined)
  assert.equal(h.storage.sync, undefined)
})
