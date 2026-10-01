import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'

const source = readFileSync(new URL('../app/web/src/lib/api.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' })
let moduleId = 0

function freshClient() {
  return import(`data:text/javascript,${encodeURIComponent(`${code}\n// instance ${moduleId++}`)}`)
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

test('concurrent unauthorized requests share one refresh and replay with the new token', async (t) => {
  const client = await freshClient()
  client.setAccessToken('old')
  const refreshStarted = deferred()
  const refreshResponse = deferred()
  let refreshes = 0
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/api/auth/refresh') {
      refreshes += 1
      refreshStarted.resolve()
      return refreshResponse.promise
    }
    return init.headers.get('Authorization') === 'Bearer new'
      ? json({ path })
      : json({ error: 'expired' }, 401)
  })

  const requests = Promise.all([client.api('/one'), client.api('/two')])
  await refreshStarted.promise
  refreshResponse.resolve(json({ access_token: 'new' }))
  assert.deepEqual(await requests, [{ path: '/one' }, { path: '/two' }])
  assert.equal(refreshes, 1)
})

test('a late unauthorized response reuses the completed refresh instead of rotating again', async (t) => {
  const client = await freshClient()
  client.setAccessToken('old')
  const lateResponse = deferred()
  let refreshes = 0
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/api/auth/refresh') {
      refreshes += 1
      return json({ access_token: 'new' })
    }
    if (init.headers.get('Authorization') === 'Bearer new') return json({ ok: true })
    return path === '/late' ? lateResponse.promise : json({}, 401)
  })

  const first = client.api('/first')
  const late = client.api('/late')
  await first
  lateResponse.resolve(json({}, 401))
  assert.deepEqual(await late, { ok: true })
  assert.equal(refreshes, 1)
})

test('failed concurrent refresh notifies session expiry only once', async (t) => {
  const client = await freshClient()
  client.setAccessToken('old')
  const refreshStarted = deferred()
  const refreshResponse = deferred()
  let notifications = 0
  client.onSessionExpired(() => { notifications += 1 })
  t.mock.method(globalThis, 'fetch', async (path) => {
    if (path === '/api/auth/refresh') {
      refreshStarted.resolve()
      return refreshResponse.promise
    }
    return json({ message: '会话过期' }, 401)
  })

  const requests = Promise.allSettled([client.api('/one'), client.api('/two')])
  await refreshStarted.promise
  refreshResponse.resolve(json({}, 401))
  const results = await requests
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.status === 401))
  assert.equal(notifications, 1)
})

for (const nextToken of [null, 'new-login']) {
  test(`a pending refresh cannot overwrite ${nextToken === null ? 'logout' : 'a newer login'}`, async (t) => {
    const client = await freshClient()
    client.setAccessToken('old')
    const refreshResponse = deferred()
    let authorization
    t.mock.method(globalThis, 'fetch', async (path, init) => {
      if (path === '/api/auth/refresh') return refreshResponse.promise
      authorization = init.headers.get('Authorization')
      return json({ ok: true })
    })

    const refreshing = client.refreshSession()
    client.setAccessToken(nextToken)
    refreshResponse.resolve(json({ access_token: 'stale' }))
    assert.equal(await refreshing, nextToken !== null)
    await client.api('/probe')
    assert.equal(authorization, nextToken === null ? null : `Bearer ${nextToken}`)
  })
}

test('a late unauthorized request does not restore a session after logout', async (t) => {
  const client = await freshClient()
  client.setAccessToken('old')
  const response = deferred()
  const paths = []
  t.mock.method(globalThis, 'fetch', async (path) => {
    paths.push(path)
    return response.promise
  })

  const request = client.api('/protected')
  client.setAccessToken(null)
  response.resolve(json({}, 401))
  await assert.rejects(request, { status: 401 })
  assert.deepEqual(paths, ['/protected'])
})

test('RequestInit.signal reaches fetch and already aborted requests never start', async (t) => {
  const client = await freshClient()
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_path, init) => {
    calls += 1
    assert.equal(init.signal, controller.signal)
    return json({ ok: true })
  })

  await client.api('/probe', { signal: controller.signal })
  controller.abort()
  await assert.rejects(client.api('/probe', { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('cancellation after a 401 prevents refresh', async (t) => {
  const client = await freshClient()
  const controller = new AbortController()
  const paths = []
  t.mock.method(globalThis, 'fetch', async (path) => {
    paths.push(path)
    controller.abort()
    return json({}, 401)
  })

  await assert.rejects(client.api('/protected', {}, { signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(paths, ['/protected'])
})

test('cancelling one request during shared refresh stops its replay but preserves other requests', async (t) => {
  const client = await freshClient()
  client.setAccessToken('old')
  const controller = new AbortController()
  const refreshStarted = deferred()
  const refreshResponse = deferred()
  const replayed = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/api/auth/refresh') {
      refreshStarted.resolve()
      return refreshResponse.promise
    }
    if (init.headers.get('Authorization') === 'Bearer new') {
      replayed.push(path)
      return json({ ok: true })
    }
    return json({}, 401)
  })

  const cancelled = client.api('/cancelled', {}, { signal: controller.signal })
  const active = client.api('/active')
  const cancelledResult = assert.rejects(cancelled, { name: 'AbortError' })
  await refreshStarted.promise
  controller.abort()
  refreshResponse.resolve(json({ access_token: 'new' }))
  await cancelledResult
  assert.deepEqual(await active, { ok: true })
  assert.deepEqual(replayed, ['/active'])
})

test('a second 401 after refresh fails without an endless retry loop', async (t) => {
  const client = await freshClient()
  const paths = []
  t.mock.method(globalThis, 'fetch', async (path) => {
    paths.push(path)
    return path === '/api/auth/refresh' ? json({ access_token: 'new' }) : json({}, 401)
  })

  await assert.rejects(client.api('/protected'), { status: 401 })
  assert.deepEqual(paths, ['/protected', '/api/auth/refresh', '/protected'])
})
