import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { createFile, exportEncrypted, unlockWithKey } from '../chrome_plug_in/src/vault.js'
import { writeSessionKey } from '../chrome_plug_in/src/session-key.js'
import { deferred, fixture, PASSWORD, setup } from './helpers/extension-autolock-harness.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const test = (name, fn) => nodeTest(name, { timeout: 15_000 }, fn)
function keysIn(value) {
  if (value instanceof CryptoKey) return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(keysIn)
}
function resumeKeys(h) { return h.idb.entries().flatMap((entry) => keysIn(entry.value)) }
async function create(h) {
  await h.ok('create', { password: PASSWORD })
  await h.ok('save', { item: { id: 'fixture-account', title: 'Fixture account', url: 'example.test', username: 'fixture-user', password: 'fixture-vault-secret' } })
}
async function enable(h) { await h.ok('settings-set', { settings: { neverAutoLock: true } }) }

test('auto-lock remains enabled by default and does not persist a recovery key', async (t) => {
  const h = await setup(t)
  await create(h)
  assert.equal((await h.ok('settings-get')).neverAutoLock, false)
  assert.equal(resumeKeys(h).length, 0)
  assert.equal(h.idb.operations.some((operation) => operation.kind === 'put'), false)
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
  await h.ok('unlock', { password: PASSWORD })
  await h.idle('locked')
  assert.equal((await h.ok('status')).locked, true)
})

test('never auto-lock skips timer, idle and OS lock and survives worker re-creation with persisted storage', async (t) => {
  const h = await setup(t)
  await create(h)
  await h.ok('settings-set', { settings: { autoLockMinutes: 1, lockOnIdle: true, neverAutoLock: true } })
  const keys = resumeKeys(h)
  assert.equal(keys.length, 1)
  assert.equal(keys[0].extractable, false)
  assert.equal(keys[0].algorithm.name, 'AES-GCM')
  await assert.rejects(crypto.subtle.exportKey('raw', keys[0]))
  const persisted = JSON.stringify([h.storage, h.idb.entries()])
  for (const secret of [PASSWORD, 'fixture-vault-secret', 'fixture-user']) assert.equal(persisted.includes(secret), false)
  h.advance(48 * 60 * 60_000)
  await h.alarm()
  await h.idle('idle')
  await h.idle('locked')
  assert.equal((await h.ok('status')).locked, false)
  for (let restart = 0; restart < 2; restart++) {
    await h.restart()
    assert.equal((await h.ok('status')).locked, false)
    assert.equal((await h.ok('list')).items[0].password, 'fixture-vault-secret')
  }
})

test('disabling persistent unlock restores earlier timer and idle preferences and removes recovery keys', async (t) => {
  const h = await setup(t)
  await create(h)
  await h.ok('settings-set', { settings: { autoLockMinutes: 2, lockOnIdle: false, neverAutoLock: true } })
  const settings = await h.ok('settings-set', { settings: { neverAutoLock: false } })
  assert.equal(settings.autoLockMinutes, 2)
  assert.equal(settings.lockOnIdle, false)
  assert.equal(resumeKeys(h).length, 0)
  assert.equal((await h.ok('status')).locked, false)
  await h.idle('idle')
  assert.equal((await h.ok('status')).locked, false)
  h.advance(121_000)
  await h.alarm()
  assert.equal((await h.ok('status')).locked, true)
  await h.ok('unlock', { password: PASSWORD })
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
})

test('manual lock clears persisted unlock and only a later explicit unlock re-arms it', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  await h.ok('lock')
  assert.equal((await h.ok('settings-get')).neverAutoLock, true)
  assert.equal(resumeKeys(h).length, 0)
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
  await h.alarm()
  await h.idle('active')
  assert.equal((await h.ok('status')).locked, true)
  await h.ok('unlock', { password: PASSWORD })
  assert.equal(resumeKeys(h).length, 1)
  await h.restart()
  assert.equal((await h.ok('status')).locked, false)
})

test('never auto-lock must be a boolean and website messages cannot change it', async (t) => {
  const h = await setup(t)
  await create(h)
  for (const neverAutoLock of ['true', 1, null, [], {}]) {
    assert.equal((await h.send('settings-set', { settings: { neverAutoLock } })).ok, false)
  }
  const content = { id: h.chrome.runtime.id, tab: { id: 1 }, url: 'https://example.test' }
  assert.equal((await h.send('settings-set', { settings: { neverAutoLock: true } }, content)).code, 'forbidden')
  assert.equal((await h.ok('settings-get')).neverAutoLock, false)
  assert.equal(resumeKeys(h).length, 0)
})

test('permanent unlock cannot be enabled from a locked vault', async (t) => {
  const h = await setup(t, { stored: { file: await fixture() } })
  assert.equal((await h.send('settings-set', { settings: { neverAutoLock: true } })).code, 'locked')
  assert.equal((await h.ok('settings-get')).neverAutoLock, false)
  assert.equal(resumeKeys(h).length, 0)
})

test('failed recovery-key persistence does not enable the mode or lose the existing session', async (t) => {
  const h = await setup(t)
  await create(h)
  h.idb.intercept(({ kind }) => {
    if (kind === 'put') throw new DOMException('Fixture quota exceeded', 'QuotaExceededError')
  })
  assert.equal((await h.send('settings-set', { settings: { neverAutoLock: true } })).ok, false)
  assert.equal((await h.ok('settings-get')).neverAutoLock, false)
  assert.equal(h.storage.unlockRecovery, null)
  assert.equal(resumeKeys(h).length, 0)
  assert.equal((await h.ok('list')).items.length, 1)
  h.idb.intercept(null)
  await enable(h)
  await h.restart()
  assert.equal((await h.ok('status')).locked, false)
})

test('importing an encrypted backup replaces the stored recovery key', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  const oldKey = resumeKeys(h)[0]
  const backupPassword = 'backup-fixture-master-password'
  const backup = await fixture(backupPassword, 'Imported account')
  await h.ok('import', { text: exportEncrypted(backup), password: backupPassword })
  await assert.rejects(unlockWithKey(h.storage.file, oldKey))
  assert.equal(resumeKeys(h).length, 1)
  await h.restart()
  assert.equal((await h.ok('status')).locked, false)
  assert.equal((await h.ok('list')).items[0].title, 'Imported account')
})

test('pulling a remote vault with a different salt replaces the recovery key and retains this binding', async (t) => {
  const remotePassword = 'remote-fixture-master'
  const h = await setup(t, { remoteFile: await fixture(remotePassword, 'Remote account'), remoteVersion: 9 })
  await create(h)
  await enable(h)
  const oldKey = resumeKeys(h)[0]
  assert.equal((await h.connect()).conflict, true)
  assert.equal((await h.send('sync-pull', { force: true })).code, 'remote_password_required')
  assert.equal((await h.ok('sync-pull', { force: true, password: remotePassword })).items, 1)
  await assert.rejects(unlockWithKey(h.storage.file, oldKey))
  await h.restart()
  assert.equal((await h.ok('status')).locked, false)
  assert.equal((await h.ok('list')).items[0].title, 'Remote account')
  const account = await h.ok('account-status')
  assert.equal(account.configured, true)
  assert.equal(account.signedIn, false)
  assert.equal(account.version, 9)
  assert.equal((await h.ok('sync-push')).version, 10)
  assert.equal(h.requests.filter((request) => request.url.pathname === '/api/auth/login').length, 2)
})

test('the first list and content fill requests wait for startup recovery', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  for (const type of ['list', 'fill']) {
    const started = deferred()
    const release = deferred()
    t.after(() => release.resolve())
    h.idb.intercept(async ({ kind }) => {
      if (kind === 'get') { started.resolve(); await release.promise }
    })
    await h.restart()
    await started.promise
    let settled = false
    const sender = type === 'fill' ? { id: h.chrome.runtime.id, tab: { id: 1 }, url: 'https://example.test/login' } : undefined
    const result = h.send(type, type === 'fill' ? { id: 'fixture-account' } : {}, sender).then((result) => { settled = true; return result })
    await tick()
    assert.equal(settled, false)
    release.resolve()
    const response = await result
    assert.equal(response.ok, true)
    assert.equal(type === 'fill' ? response.data.password : response.data.items[0].password, 'fixture-vault-secret')
    h.idb.intercept(null)
  }
})

test('a resumed worker can authenticate again and upload dirty encrypted data from its alarm', async (t) => {
  const h = await setup(t, { remoteFile: null })
  await create(h)
  await enable(h)
  await h.connect()
  // Persist changes while automatic push is disabled, then model the enabled
  // preference on wake without leaving a timer in the discarded worker.
  await h.ok('settings-set', { settings: { autoPush: false } })
  await h.ok('save', { item: { id: 'fixture-account', title: 'Pending upload' } })
  h.storage.settings.autoPush = true
  await h.restart()
  await h.alarm('vault-push')
  // Automatic sync is enqueued; a later serialized operation is its barrier.
  await h.ok('settings-set', { settings: {} })
  assert.equal(h.storage.sync.dirty, false)
  assert.equal(h.remote.version, 2)
  assert.equal(h.requests.filter((request) => request.url.pathname === '/api/auth/login').length, 2)
  assert.equal(JSON.stringify(h.remote).includes('fixture-vault-secret'), false)
  assert.equal((await unlockWithKey(JSON.parse(h.remote.blob), resumeKeys(h)[0])).vault.items[0].title, 'Pending upload')
})

test('changing the master password replaces the recovery key and keeps edited items', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  const oldKey = resumeKeys(h)[0]
  await h.ok('change-master', { current: PASSWORD, next: 'replacement-fixture-master' })
  await assert.rejects(unlockWithKey(h.storage.file, oldKey))
  assert.equal(resumeKeys(h).length, 1)
  await h.ok('save', { item: { id: 'fixture-account', title: 'Updated after rekey' } })
  await h.restart()
  assert.equal((await h.ok('status')).locked, false)
  assert.equal((await h.ok('list')).items[0].title, 'Updated after rekey')
})

test('malformed recovery records fail closed without breaking later password unlock', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  h.idb.replace(() => ({ corrupt: 'not a CryptoKey' }))
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
  await h.ok('unlock', { password: PASSWORD })
  assert.equal((await h.ok('list')).items.length, 1)
  await h.restart()
  assert.equal((await h.ok('status')).locked, false)
})

test('a valid CryptoKey for a different vault cannot silently unlock a replaced file', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  h.storage.file = await fixture('unrelated-fixture-master', 'Unrelated vault')
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
  assert.equal((await h.send('list')).code, 'locked')
  await h.ok('unlock', { password: 'unrelated-fixture-master' })
  assert.equal((await h.ok('list')).items[0].title, 'Unrelated vault')
})

test('a recovery record with correct metadata but a wrong CryptoKey remains locked', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  const unrelated = await createFile('unrelated-fixture-master')
  h.idb.replace((record) => ({ ...record, vaultKey: unrelated.vaultKey }))
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
  assert.equal(h.storage.unlockRecovery, null)
  await h.ok('unlock', { password: PASSWORD })
  assert.equal((await h.ok('list')).items[0].password, 'fixture-vault-secret')
})

test('manual lock racing with persistence cannot resurrect the session after restart', async (t) => {
  const h = await setup(t)
  await create(h)
  const started = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  let paused = false
  h.idb.intercept(async (operation) => {
    if (operation.kind === 'put' && !paused) {
      paused = true
      started.resolve()
      await release.promise
    }
  })
  const enabling = h.send('settings-set', { settings: { neverAutoLock: true } })
  await started.promise
  const locking = h.send('lock')
  await tick()
  release.resolve()
  assert.equal((await locking).ok, true)
  await enabling
  h.idb.intercept(null)
  assert.equal((await h.ok('status')).locked, true)
  assert.equal(resumeKeys(h).length, 0)
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
})

test('manual lock racing with startup recovery discards a key already being read', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  const started = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  let paused = false
  h.idb.intercept(async (operation) => {
    if (operation.kind === 'get' && !paused) {
      paused = true
      started.resolve()
      await release.promise
    }
  })
  const restarted = h.restart()
  await started.promise
  const locking = h.send('lock')
  await tick()
  release.resolve()
  await restarted
  assert.equal((await locking).ok, true)
  h.idb.intercept(null)
  assert.equal((await h.ok('status')).locked, true)
  assert.equal(resumeKeys(h).length, 0)
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
})

test('a late recovery marker write cannot undo a manual lock', async (t) => {
  const h = await setup(t)
  await create(h)
  const started = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  let paused = false
  h.interceptStorage(async ({ kind, patch }) => {
    if (kind === 'set' && typeof patch.unlockRecovery === 'string' && !paused) {
      paused = true
      started.resolve()
      await release.promise
    }
  })
  const enabling = h.send('settings-set', { settings: { neverAutoLock: true } })
  await started.promise
  const locking = h.send('lock')
  await tick()
  release.resolve()
  assert.equal((await locking).ok, true)
  await enabling
  h.interceptStorage(null)
  assert.equal(h.storage.unlockRecovery, null)
  assert.equal(resumeKeys(h).length, 0)
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
})

test('unavailable recovery storage fails closed and password unlock still works', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  h.idb.intercept(({ kind }) => {
    if (kind === 'get') throw new DOMException('Fixture storage unavailable', 'UnknownError')
  })
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
  assert.equal(h.storage.unlockRecovery, null)
  h.idb.intercept(null)
  await h.ok('unlock', { password: PASSWORD })
  assert.equal((await h.ok('list')).items.length, 1)
  await h.restart()
  assert.equal((await h.ok('status')).locked, false)
})

test('persistent IndexedDB failure still allows disabling the mode and unlocking with the master password', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  h.idb.intercept(({ kind }) => {
    if (kind === 'open') throw new DOMException('Fixture database stays unavailable', 'UnknownError')
  })
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
  assert.equal(h.storage.unlockRecovery, null)
  assert.equal((await h.ok('settings-set', { settings: { neverAutoLock: false } })).neverAutoLock, false)
  await h.ok('unlock', { password: PASSWORD })
  assert.equal((await h.ok('list')).items[0].password, 'fixture-vault-secret')
  await h.restart()
  assert.equal((await h.ok('status')).locked, true)
  assert.equal(h.storage.unlockRecovery, null)
  h.idb.intercept(null)
})

test('reset removes recovery material and cannot restore an erased vault', async (t) => {
  const h = await setup(t)
  await create(h)
  await enable(h)
  await h.ok('reset-all')
  assert.equal(resumeKeys(h).length, 0)
  await h.restart()
  const state = await h.ok('status')
  assert.equal(state.hasVault, false)
  assert.equal(state.locked, true)
  assert.equal(state.settings.neverAutoLock, false)
})

test('an IndexedDB open succeeding after being blocked cannot write a recovery key', async (t) => {
  const previous = globalThis.indexedDB
  t.after(() => { globalThis.indexedDB = previous })
  const request = {}
  let closed = 0
  let transactions = 0
  globalThis.indexedDB = { open: () => request }
  const writing = writeSessionKey({ token: 'must-not-persist' })
  request.onblocked()
  await assert.rejects(writing, /存储被占用/)
  request.result = {
    close() { closed++ },
    transaction() { transactions++; throw new Error('Abandoned open must not run a transaction') },
  }
  request.onsuccess()
  assert.equal(closed, 1)
  assert.equal(transactions, 0)
})
