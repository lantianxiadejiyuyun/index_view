import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'

const source = readFileSync(new URL('../app/web/src/lib/api.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' })
let moduleId = 0
const freshClient = () => import(`data:text/javascript,${encodeURIComponent(`${code}\n// network ${moduleId++}`)}`)
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('a transient read transport failure retries once and recovers', async (t) => {
  const client = await freshClient()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw new TypeError('Failed to fetch')
    return json({ ok: true })
  })
  assert.deepEqual(await client.api('/api/bootstrap'), { ok: true })
  assert.equal(calls, 2)
})

test('persistent read network failure is bounded and has a useful Chinese message', async (t) => {
  const client = await freshClient()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new TypeError('Failed to fetch') })
  await assert.rejects(client.api('/api/bootstrap'), (err) => {
    assert.equal(err.code, 'network_error')
    assert.equal(err.status, 0)
    assert.match(client.errorMessage(err), /网络.*重试/)
    return true
  })
  assert.equal(calls, 2)
})

test('a read retries a temporary gateway failure, but not a validation failure', async (t) => {
  const client = await freshClient()
  const counts = new Map()
  t.mock.method(globalThis, 'fetch', async (path) => {
    counts.set(path, (counts.get(path) ?? 0) + 1)
    if (path === '/bad') return json({ message: '参数无效' }, 400)
    return counts.get(path) === 1 ? new Response('<html>upstream restarting</html>', { status: 502 }) : json({ ok: true })
  })
  assert.deepEqual(await client.api('/read'), { ok: true })
  await assert.rejects(client.api('/bad'), { status: 400, message: '参数无效' })
  assert.deepEqual([...counts.entries()], [['/read', 2], ['/bad', 1]])
})

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`${method} is never retried after an ambiguous network or gateway failure`, async (t) => {
    const client = await freshClient()
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1
      if (calls === 1) throw new TypeError('Failed to fetch')
      return new Response('Bad Gateway', { status: 502 })
    })
    await assert.rejects(client.api('/write', { method }), { code: 'network_error' })
    assert.equal(calls, 1)
    await assert.rejects(client.api('/write', { method }), { status: 502, message: '服务器暂时不可用，请稍后重试' })
    assert.equal(calls, 2)
  })
}

for (const failure of ['network', '503', 'invalid-json', 'missing-token']) {
  test(`refresh ${failure} does not mark a valid session expired and a later retry can recover`, async (t) => {
    const client = await freshClient()
    client.setAccessToken('old')
    let expired = 0
    let refreshes = 0
    client.onSessionExpired(() => { expired += 1 })
    t.mock.method(globalThis, 'fetch', async (path, init) => {
      if (path !== '/api/auth/refresh') return init.headers.get('Authorization') === 'Bearer new' ? json({ ok: true }) : json({}, 401)
      if (++refreshes > 1) return json({ access_token: 'new' })
      if (failure === 'network') throw new TypeError('Failed to fetch')
      if (failure === '503') return new Response('unavailable', { status: 503 })
      if (failure === 'invalid-json') return new Response('<html>gateway</html>')
      return json(null)
    })
    await assert.rejects(client.api('/protected'), (err) => err.status !== 401)
    assert.equal(expired, 0)
    assert.equal(refreshes, 1)
    assert.deepEqual(await client.api('/protected'), { ok: true })
    assert.equal(refreshes, 2)
    assert.equal(expired, 0)
  })
}

test('cancelling during retry backoff prevents another request', async (t) => {
  const client = await freshClient()
  const controller = new AbortController()
  const started = deferred()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; started.resolve(); throw new TypeError('Failed to fetch') })
  const request = client.api('/read', {}, { signal: controller.signal })
  await started.promise
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('cancellation while reading an error response retains the AbortError', async (t) => {
  const client = await freshClient()
  const controller = new AbortController()
  const response = json({}, 400)
  t.mock.method(response, 'json', async () => {
    controller.abort()
    throw controller.signal.reason
  })
  t.mock.method(globalThis, 'fetch', async () => response)
  await assert.rejects(client.api('/read', {}, { signal: controller.signal }), { name: 'AbortError' })
})

test('concurrent temporary refresh failures share one attempt and never emit session expiry', async (t) => {
  const client = await freshClient()
  client.setAccessToken('old')
  const response = deferred()
  const started = deferred()
  let refreshes = 0
  let expired = 0
  client.onSessionExpired(() => { expired += 1 })
  t.mock.method(globalThis, 'fetch', async (path) => {
    if (path !== '/api/auth/refresh') return json({}, 401)
    refreshes += 1
    started.resolve()
    return response.promise
  })
  const results = Promise.allSettled([client.api('/one'), client.api('/two')])
  await started.promise
  response.resolve(new Response('gateway unavailable', { status: 503 }))
  assert.ok((await results).every((result) => result.status === 'rejected' && result.reason.status === 503))
  assert.equal(refreshes, 1)
  assert.equal(expired, 0)
})

test('cancelling one waiter immediately releases it without cancelling the shared refresh', async (t) => {
  const client = await freshClient()
  const controller = new AbortController()
  const started = deferred()
  const response = deferred()
  let refreshes = 0
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/api/auth/refresh') { refreshes += 1; started.resolve(); return response.promise }
    return init.headers.get('Authorization') === 'Bearer new' ? json({ ok: true }) : json({}, 401)
  })
  const cancelled = client.api('/cancelled', {}, { signal: controller.signal })
  const active = client.api('/active')
  await started.promise
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  response.resolve(json({ access_token: 'new' }))
  assert.deepEqual(await active, { ok: true })
  assert.equal(refreshes, 1)
})

test('HTML success responses and non-object JSON errors do not leak parser errors', async (t) => {
  const client = await freshClient()
  t.mock.method(globalThis, 'fetch', async (path) => path === '/html'
    ? new Response('<html>login</html>')
    : json(null, 500))
  await assert.rejects(client.api('/html'), { code: 'invalid_response' })
  await assert.rejects(client.api('/null-error'), { status: 500, message: '服务器暂时不可用，请稍后重试' })
})

test('known native network messages are translated while programming errors retain their details', async () => {
  const client = await freshClient()
  for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
    assert.equal(client.errorMessage(new TypeError(message)), '无法连接服务器，请检查网络后重试')
  }
  assert.equal(client.errorMessage(new TypeError('Undefined variable')), 'Undefined variable')
})
