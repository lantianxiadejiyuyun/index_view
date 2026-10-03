import assert from 'node:assert/strict'
import { createFile, sealFile, upsertItem } from '../../chrome_plug_in/src/vault.js'

export const PASSWORD = 'autolock-fixture-master-password'
let serial = 0
const tick = () => new Promise((resolve) => setImmediate(resolve))
const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener) } })
export function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

export async function fixture(password = PASSWORD, title = 'Autolock fixture') {
  const created = await createFile(password)
  const vault = upsertItem(created.vault, {
    title, url: 'example.test', username: 'fixture-user', password: 'fixture-vault-secret',
  })
  return (await sealFile(created.file, vault, created.vaultKey)).file
}

// The fake preserves structured-cloned CryptoKeys across new worker instances.
// Requests and transaction completion are separate asynchronous events, allowing
// tests to pause a commit while a manual lock invalidates the worker's session.
function indexedDbFixture() {
  const databases = new Map()
  const operations = []
  let interceptor = null
  const api = {
    open(name, version = 1) {
      const request = {}
      setImmediate(async () => {
        try {
          await interceptor?.({ kind: 'open', name })
          const upgrade = !databases.has(name)
          if (upgrade) databases.set(name, new Map())
          const stores = databases.get(name)
          const db = {
            name, version, close() {},
            objectStoreNames: { contains: (store) => stores.has(store) },
            createObjectStore(store) { stores.set(store, new Map()); return {} },
            transaction(storeNames, mode) {
              const tx = { error: null, oncomplete: null, onerror: null, onabort: null }
              let pending = 0
              let ended = false
              let checkQueued = false
              const complete = () => {
                if (checkQueued) return
                checkQueued = true
                setImmediate(() => {
                  checkQueued = false
                  if (ended || pending > 0) return
                  ended = true
                  tx.oncomplete?.({ target: tx })
                })
              }
              tx.abort = () => {
                if (ended) return
                ended = true
                tx.error = new DOMException('Aborted fixture transaction', 'AbortError')
                tx.onabort?.({ target: tx })
              }
              tx.objectStore = (storeName) => {
                const store = stores.get(storeName)
                assert.ok(store, 'Unknown fixture object store: ' + storeName)
                function operation(kind, key, value) {
                  assert.equal(ended, false, 'Cannot use completed transaction')
                  const req = {}
                  pending++
                  setImmediate(async () => {
                    try {
                      const info = { kind, database: name, store: storeName, mode, key, value }
                      operations.push(info)
                      await interceptor?.(info)
                      if (ended) return
                      if (kind === 'get') req.result = structuredClone(store.get(key))
                      if (kind === 'put') { store.set(key, structuredClone(value)); req.result = key }
                      if (kind === 'delete') store.delete(key)
                      if (kind === 'clear') store.clear()
                      req.onsuccess?.({ target: req })
                      pending--
                      complete()
                    } catch (error) {
                      req.error = error
                      req.onerror?.({ target: req })
                      tx.error = error
                      ended = true
                      tx.onerror?.({ target: tx })
                      tx.onabort?.({ target: tx })
                    }
                  })
                  return req
                }
                return {
                  get: (key) => operation('get', key),
                  put: (value, key) => operation('put', key, value),
                  delete: (key) => operation('delete', key),
                  clear: () => operation('clear'),
                }
              }
              complete()
              return tx
            },
          }
          request.result = db
          if (upgrade) request.onupgradeneeded?.({ target: request })
          request.onsuccess?.({ target: request })
        } catch (error) {
          request.error = error
          request.onerror?.({ target: request })
        }
      })
      return request
    },
  }
  return {
    api, operations,
    intercept(callback) { interceptor = callback },
    entries() {
      return [...databases].flatMap(([database, stores]) => [...stores].flatMap(([store, records]) =>
        [...records].map(([key, value]) => ({ database, store, key, value: structuredClone(value) }))))
    },
    replace(mapper) {
      for (const stores of databases.values()) for (const records of stores.values()) {
        for (const [key, value] of records) records.set(key, mapper(structuredClone(value)))
      }
    },
  }
}

export async function setup(t, { stored = {}, remoteFile = undefined, remoteVersion = 0 } = {}) {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch, indexedDB: globalThis.indexedDB, now: Date.now }
  const storage = structuredClone(stored)
  const idb = indexedDbFixture()
  let chrome
  let now = previous.now()
  let storageInterceptor = null
  const requests = []
  const remote = remoteFile === undefined ? null : { version: remoteVersion, blob: remoteFile ? JSON.stringify(remoteFile) : null }
  Date.now = () => now
  globalThis.indexedDB = idb.api
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input)
    assert.ok(remote && url.origin === 'https://autolock-sync.example.test', 'Autolock tests must never make real network requests')
    const request = { url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null, options }
    requests.push(request)
    if (url.pathname === '/api/health') return Response.json({ ok: true })
    if (url.pathname === '/api/auth/login') return Response.json({ access_token: 'autolock-fixture-token' })
    if (url.pathname === '/api/vault' && request.method === 'GET') return Response.json({ ...remote, updated_at: null })
    if (url.pathname === '/api/vault' && request.method === 'PUT') {
      if (request.body.base_version !== remote.version) return Response.json({ error: 'conflict', ...remote }, { status: 409 })
      remote.version++
      remote.blob = request.body.blob
      return Response.json({ version: remote.version })
    }
    throw new Error('Unexpected autolock fixture request: ' + url.pathname)
  }
  async function restart() {
    await tick()
    const runtime = {
      id: 'autolock-fixture', getURL: (path = '') => 'chrome-extension://autolock-fixture/' + path,
      onMessage: event(), onInstalled: event(), onStartup: event(), sendMessage: async () => ({}),
    }
    chrome = {
      runtime, i18n: { getUILanguage: () => 'zh-CN' },
      storage: {
        local: {
          get: async (keys) => {
            await storageInterceptor?.({ kind: 'get', keys })
            if (typeof keys === 'string') keys = [keys]
            return Object.fromEntries((keys ?? Object.keys(storage)).filter((key) => key in storage)
              .map((key) => [key, structuredClone(storage[key])]))
          },
          set: async (patch) => {
            await storageInterceptor?.({ kind: 'set', patch })
            const changes = Object.fromEntries(Object.keys(patch).map((key) => [key, { oldValue: storage[key], newValue: patch[key] }]))
            Object.assign(storage, structuredClone(patch))
            for (const listener of chrome.storage.onChanged.listeners) listener(changes, 'local')
          },
          remove: async (keys) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete storage[key] },
          clear: async () => { for (const key of Object.keys(storage)) delete storage[key] },
        },
        onChanged: event(),
      },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: { query: async () => [], get: async () => ({}), sendMessage: async () => ({}), onActivated: event(), onUpdated: event() },
      alarms: { create() {}, clear: async () => true, onAlarm: event() },
      idle: { setDetectionInterval() {}, onStateChanged: event() },
    }
    globalThis.chrome = chrome
    await import('../../chrome_plug_in/background.js?autolock=' + ++serial)
  }
  function send(type, payload = {}, sender) {
    sender ??= { id: chrome.runtime.id, url: chrome.runtime.getURL('options/options.html') }
    return new Promise((resolve) => chrome.runtime.onMessage.listeners[0]({ type, ...payload }, sender, resolve))
  }
  async function ok(type, payload = {}, sender) {
    const result = await send(type, payload, sender)
    assert.equal(result.ok, true, type + ': ' + result.error)
    return result.data
  }
  await restart()
  t.after(async () => {
    storageInterceptor = null
    idb.intercept(null)
    await send('lock')
    await tick()
    globalThis.chrome = previous.chrome
    globalThis.fetch = previous.fetch
    globalThis.indexedDB = previous.indexedDB
    Date.now = previous.now
  })
  return {
    storage, idb, send, ok, restart, requests, remote,
    get chrome() { return chrome },
    advance(ms) { now += ms },
    interceptStorage(callback) { storageInterceptor = callback },
    async alarm(name = 'lock-tick') { await chrome.alarms.onAlarm.listeners[0]({ name }); await tick() },
    async idle(state) { await chrome.idle.onStateChanged.listeners[0](state); await tick() },
    connect: () => ok('account-connect', { base: 'https://autolock-sync.example.test', user: 'fixture-user', password: 'fixture-server-password' }),
  }
}
