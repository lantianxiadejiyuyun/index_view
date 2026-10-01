import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { createServerFormCache, safeServerForm, selectServerForm } from '../chrome_plug_in/ui/server-form-cache.js'

function memoryWorker(initial = null) {
  const state = { revision: 'generation-1', draft: safeServerForm(initial) }
  const requests = []
  const writes = []
  return {
    state, requests, writes,
    async send(type, payload = {}) {
      requests.push({ type, ...structuredClone(payload) })
      if (type === 'server-form-get') return structuredClone(state)
      assert.equal(type, 'server-form-save')
      if (payload.revision !== state.revision) return { saved: false, revision: state.revision }
      state.draft = safeServerForm(payload.draft)
      writes.push(structuredClone(state.draft))
      return { saved: true, revision: state.revision }
    },
    invalidate() { state.revision += '-next'; state.draft = null; return state.revision },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { resolve, promise }
}

test('drafts send only address and username, never a password or token', async () => {
  const worker = memoryWorker()
  const cache = createServerFormCache({ send: worker.send })
  await cache.load()
  await cache.flush({ base: 'https://example.test', user: 'alice', password: 'secret', token: 'token' })
  assert.deepEqual(worker.state.draft, { base: 'https://example.test', user: 'alice' })
  assert.deepEqual(worker.requests.at(-1).draft, worker.state.draft)
  const newPage = createServerFormCache({ send: worker.send })
  assert.deepEqual(await newPage.load(), worker.state.draft)
})

test('draft values take precedence over an existing binding, including deliberately empty inputs', () => {
  const bound = { base: 'https://bound.test', user: 'bound-user' }
  assert.deepEqual(selectServerForm({ base: 'https://draft.test', user: 'draft-user' }, bound), { base: 'https://draft.test', user: 'draft-user' })
  assert.deepEqual(selectServerForm({ base: '', user: '' }, bound), { base: '', user: '' })
  assert.deepEqual(selectServerForm(null, bound), bound)
  assert.deepEqual(selectServerForm(null, null), { base: '', user: '' })
  for (const invalid of [null, 'text', [], { base: 1, user: 'alice' }, { base: 'url' }]) assert.equal(safeServerForm(invalid), null)
})

test('typing is debounced and sends only the most recent values', async () => {
  const worker = memoryWorker()
  const cache = createServerFormCache({ send: worker.send, delay: 5 })
  await cache.load()
  cache.schedule({ base: 'h', user: '' })
  cache.schedule({ base: 'https://exa', user: '' })
  cache.schedule({ base: 'https://example.test', user: 'alice' })
  assert.equal(worker.writes.length, 0)
  await wait(25)
  await cache.flush()
  assert.equal(worker.writes.length, 1)
  assert.deepEqual(worker.state.draft, { base: 'https://example.test', user: 'alice' })
})

test('blur-style flush sends immediately and cancels its pending timer', async () => {
  const worker = memoryWorker()
  const cache = createServerFormCache({ send: worker.send, delay: 5 })
  await cache.load()
  cache.schedule({ base: 'https://old.test', user: 'old' })
  await cache.flush({ base: 'https://new.test', user: 'new' })
  assert.deepEqual(worker.state.draft, { base: 'https://new.test', user: 'new' })
  await wait(15)
  assert.equal(worker.writes.length, 1)
})

test('a reset broadcast cancels pending writes and clears the current view once', async () => {
  const worker = memoryWorker({ base: 'https://old.test', user: 'old' })
  let cleared = 0
  const cache = createServerFormCache({ send: worker.send, delay: 5, onInvalidate: () => { cleared += 1 } })
  await cache.load()
  cache.schedule({ base: 'https://new.test', user: 'new' })
  const revision = worker.invalidate()
  cache.invalidate(revision)
  cache.invalidate(revision)
  await wait(15)
  assert.equal(worker.state.draft, null)
  assert.equal(worker.writes.length, 0)
  assert.equal(cleared, 1)
})

test('a missed reset broadcast is recovered from a rejected stale save', async () => {
  const worker = memoryWorker()
  let cleared = 0
  const cache = createServerFormCache({ send: worker.send, onInvalidate: () => { cleared += 1 } })
  await cache.load()
  worker.invalidate()
  assert.equal((await cache.flush({ base: 'https://old.test', user: 'old' })).saved, false)
  assert.equal(worker.state.draft, null)
  assert.equal(cleared, 1)
  assert.equal((await cache.flush({ base: 'https://intentional-new.test', user: 'new' })).saved, true)
})

test('pagehide dispatches its latest values even while an earlier response is still pending', async () => {
  const worker = memoryWorker()
  const response = deferred()
  let saves = 0
  const cache = createServerFormCache({ send(type, payload) {
    const result = worker.send(type, payload)
    if (type === 'server-form-save' && ++saves === 1) return response.promise.then(() => result)
    return result
  } })
  await cache.load()
  const first = cache.flush({ base: 'https://first.test', user: 'first' })
  cache.schedule({ base: 'https://latest.test', user: 'latest' })
  const closing = cache.flush()
  assert.equal(worker.requests.filter((request) => request.type === 'server-form-save').length, 2)
  assert.deepEqual(worker.state.draft, { base: 'https://latest.test', user: 'latest' })
  response.resolve()
  await Promise.all([first, closing])
})

test('a late initial read cannot restore the draft cleared by a reset broadcast', async () => {
  const response = deferred()
  const requests = []
  const cache = createServerFormCache({ send(type, payload) {
    if (type === 'server-form-get') return response.promise
    requests.push(payload)
    return Promise.resolve({ saved: true, revision: payload.revision })
  } })
  const loading = cache.load()
  cache.invalidate('generation-2')
  response.resolve({ revision: 'generation-1', draft: { base: 'https://old.test', user: 'old' } })
  assert.equal(await loading, null)
  await cache.flush({ base: 'https://new.test', user: 'new' })
  assert.equal(requests[0].revision, 'generation-2')
})

test('a delayed old response does not clear edits made after the reset', async () => {
  const response = deferred()
  let cleared = 0
  let saves = 0
  const cache = createServerFormCache({
    onInvalidate: () => { cleared += 1 },
    send(type, payload) {
      if (type === 'server-form-get') return Promise.resolve({ revision: 'generation-1', draft: null })
      if (++saves === 1) return response.promise
      return Promise.resolve({ saved: true, revision: payload.revision })
    },
  })
  await cache.load()
  const old = cache.flush({ base: 'https://old.test', user: 'old' })
  cache.invalidate('generation-2')
  await cache.flush({ base: 'https://new.test', user: 'new' })
  response.resolve({ saved: false, revision: 'generation-2' })
  await old
  assert.equal(cleared, 1)
})

test('a failed response does not block later saves', async () => {
  const worker = memoryWorker()
  let fail = true
  const cache = createServerFormCache({ async send(type, payload) {
    if (type === 'server-form-save' && fail) { fail = false; throw new Error('test storage failure') }
    return worker.send(type, payload)
  } })
  await cache.load()
  await assert.rejects(cache.flush({ base: 'https://first.test', user: 'first' }), /test storage failure/)
  await cache.flush({ base: 'https://second.test', user: 'second' })
  assert.equal(worker.state.draft.base, 'https://second.test')
})
