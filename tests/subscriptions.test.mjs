import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const serverRoot = fileURLToPath(new URL('../app/server/', import.meta.url))
const tempRoot = path.resolve(tmpdir())
const workspace = mkdtempSync(path.join(tempRoot, 'hd-subscription-test-'))
const databaseDir = path.join(workspace, 'data')
const bundleFile = path.join(workspace, 'subscriptions.mjs')
const calls = []
let harness
let token
let otherToken
let respond
const existingFetch = globalThis.__subscriptionTestFetch

function fixture(name = 'Fixture node') {
  return JSON.stringify({ proxies: [{ name, type: 'ss', server: 'node.example.test', port: 443, cipher: 'aes-128-gcm', password: 'fixture-node-secret' }] })
}
function upstream(name = 'Fixture node') {
  return { text: fixture(name), subscription_userinfo: 'upload=10; download=20; total=100; expire=2000000000' }
}
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('fixture did not reach its expected asynchronous state')
}

before(async () => {
  // Substitute config before imports execute. Neither .env nor the real user DB
  // is ever opened. The fetch function is replaced at its module boundary.
  await build({
    stdin: {
      contents: `
        export { subscriptionRoutes } from './src/routes/subscriptions.ts';
        export * from './src/lib/subscriptions.ts';
        export { sql, closeDb } from './src/lib/db.ts';
        export { initDatabase } from './src/db/schema.ts';
        export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
        export { parseSubscription } from './src/lib/subscription-codec.ts';
      `,
      resolveDir: serverRoot, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundleFile,
    banner: { js: SERVER_ESM_BANNER },
    plugins: [{
      name: 'isolated-subscriptions',
      setup(builder) {
        builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'subscription-fixture' }))
        builder.onResolve({ filter: /\/subscription-fetch\.js$/ }, () => ({ path: 'fetch', namespace: 'subscription-fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'subscription-fixture' }, ({ path: name }) => ({
          contents: name === 'config' ? `
            import { mkdirSync } from 'node:fs';
            export const DB_FILE = ${JSON.stringify(path.join(databaseDir, 'app.db'))};
            export const REFRESH_DAYS = 30;
            export const ADMIN_USERNAME = 'subscription-fixture';
            export const ADMIN_PASSWORD = 'test-only-password';
            export const ENV_AGENT_TOKEN = 'test-only-agent';
            export const ENV_JWT_SECRET = 'test-only-jwt-secret-for-subscriptions';
            export function ensureDirs() { mkdirSync(${JSON.stringify(databaseDir)}, { recursive: true }); }
          ` : `
            export { validateSubscriptionUrl } from ${JSON.stringify(path.join(serverRoot, 'src/lib/subscription-fetch.ts'))};
            export async function fetchSubscription(url) { return globalThis.__subscriptionTestFetch(url); }
          `,
          resolveDir: serverRoot, loader: 'js',
        }))
      },
    }],
  })
  globalThis.__subscriptionTestFetch = async (url) => {
    assert.match(url, /^https:\/\/source[\w-]*\.example\.test\//, 'only fixture source URLs may be fetched')
    calls.push(url)
    return respond(url)
  }
  harness = await import(pathToFileURL(bundleFile).href)
  harness.initDatabase()
  harness.sql.run(`INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (2, 'other-fixture', 'not-used', 1, 1)`)
  const session = harness.createRefreshToken(1, 'fixture', null)
  const otherSession = harness.createRefreshToken(2, 'fixture', null)
  token = await harness.issueAccessToken({ id: 1, username: 'subscription-fixture' }, session.sessionId)
  otherToken = await harness.issueAccessToken({ id: 2, username: 'other-fixture' }, otherSession.sessionId)
})
beforeEach(() => {
  harness.sql.run('DELETE FROM subscription_profiles')
  harness.sql.run('DELETE FROM subscription_sources')
  calls.length = 0
  respond = async () => upstream()
})
after(() => {
  harness?.closeDb()
  if (existingFetch === undefined) delete globalThis.__subscriptionTestFetch
  else globalThis.__subscriptionTestFetch = existingFetch
  assert.equal(path.dirname(path.resolve(workspace)), tempRoot)
  assert.ok(path.basename(workspace).startsWith('hd-subscription-test-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
})

function request(route = '', { method = 'GET', body, auth = token } = {}) {
  return harness.subscriptionRoutes.request('/subscriptions' + route, {
    method,
    headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
async function source(patch = {}, auth = token) {
  const response = await request('/sources', { method: 'POST', body: { name: 'Fixture source', url: 'https://source.example.test/list?secret=fixture-only', ...patch }, auth })
  assert.equal(response.status, 201, await response.clone().text())
  return (await response.json()).source
}
async function profile(ids, patch = {}, auth = token) {
  const response = await request('/profiles', { method: 'POST', body: { name: 'Fixture profile', source_ids: ids, ...patch }, auth })
  assert.equal(response.status, 201, await response.clone().text())
  return (await response.json()).profile
}
async function refresh(id, auth = token) {
  return request(`/sources/${id}/refresh`, { method: 'POST', auth })
}
async function listing(auth = token) { return (await request('', { auth })).json() }

test('current migration retains durable subscription tables, and creation does not fetch', async () => {
  assert.equal(harness.sql.get('PRAGMA user_version').user_version, 14)
  const created = await source()
  assert.equal(created.refresh_interval_minutes, 60)
  assert.equal(created.proxy_count, 0)
  assert.equal(created.fetching, false)
  assert.equal(created.last_attempt_at, null)
  assert.ok(created.next_fetch_at <= Date.now())
  assert.equal(calls.length, 0)
  const disabled = await source({ enabled: false, refresh_interval_minutes: 5 })
  assert.equal(disabled.next_fetch_at, null)
  const result = await listing()
  assert.equal(result.sources.length, 2)
  assert.equal(result.profiles.length, 0)
  assert.equal(typeof result.server_time, 'number')
  assert.equal(result.sources[0].proxies_json, undefined)
  assert.equal(result.sources[0].user_id, undefined)
})

test('all management endpoints require authentication and cache suppression', async () => {
  for (const [route, method] of [
    ['', 'GET'], ['/sources', 'POST'], ['/sources/1', 'PUT'], ['/sources/1', 'DELETE'],
    ['/sources/1/refresh', 'POST'], ['/refresh', 'POST'], ['/profiles', 'POST'],
    ['/profiles/1', 'PUT'], ['/profiles/1', 'DELETE'], ['/profiles/1/rotate-token', 'POST'], ['/profiles/1/preview', 'GET'], ['/rules/import', 'POST'],
  ]) {
    const response = await request(route, { method, auth: null })
    assert.equal(response.status, 401, route)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(calls.length, 0)
})

test('authenticated rule import analyzes without mutating subscriptions or fetching providers', async () => {
  const response = await request('/rules/import', { method: 'POST', body: {
    content: 'rule-providers: {remote: {url: "https://provider.example.test/never-fetch"}}\nrules:\n- DOMAIN,a.example.test,Custom\n- MATCH,DIRECT',
    policy_map: { Custom: 'REJECT' },
  } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const result = await response.json()
  assert.equal(result.can_apply, true)
  assert.deepEqual(result.rules, ['DOMAIN,a.example.test,REJECT', 'MATCH,DIRECT'])
  assert.equal(harness.sql.get('SELECT COUNT(*) AS total FROM subscription_sources').total, 0)
  assert.equal(harness.sql.get('SELECT COUNT(*) AS total FROM subscription_profiles').total, 0)
  assert.equal(calls.length, 0)
  const invalid = await request('/rules/import', { method: 'POST', body: { content: 'rules: [false]' } })
  assert.equal(invalid.status, 200)
  assert.equal((await invalid.json()).can_apply, false)
})

test('rule import bounds declared and actual streamed JSON bytes with auth first and no-store errors', async () => {
  const max = 8 * 1024 * 1024
  for (const auth of [null, token]) {
    let pulled = 0
    const response = await harness.subscriptionRoutes.request('/subscriptions/rules/import', {
      method: 'POST', duplex: 'half',
      headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), 'Content-Length': String(max + 1) },
      body: new ReadableStream({ pull(controller) { pulled++; controller.close() } }, { highWaterMark: 0 }),
    })
    assert.equal(response.status, auth ? 413 : 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(pulled, 0)
  }
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Transfer-Encoding': 'chunked' }]) {
    let pulls = 0
    let cancelled = false
    const response = await harness.subscriptionRoutes.request('/subscriptions/rules/import', {
      method: 'POST', duplex: 'half', headers: { Authorization: 'Bearer ' + token, ...headers },
      body: new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)) },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 }),
    })
    assert.equal(response.status, 413)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(pulls, 9)
    assert.equal(cancelled, true)
  }
  const decoded = await request('/rules/import', { method: 'POST', body: { content: 'x'.repeat(1024 * 1024 + 1) } })
  assert.equal(decoded.status, 200)
  const report = await decoded.json()
  assert.equal(report.can_apply, false)
  assert.equal(report.diagnostics[0].code, 'CONTENT_TOO_LARGE')
})

test('source/profile IDs and rules cannot cross account boundaries', async () => {
  const mine = await source()
  const theirs = await source({ name: 'Other account source' }, otherToken)
  const configured = await profile([mine.id])
  assert.equal((await listing(otherToken)).sources[0].id, theirs.id)
  assert.deepEqual((await listing(otherToken)).profiles, [])
  for (const [route, method] of [
    [`/sources/${mine.id}`, 'PUT'], [`/sources/${mine.id}`, 'DELETE'], [`/sources/${mine.id}/refresh`, 'POST'],
    [`/profiles/${configured.id}`, 'PUT'], [`/profiles/${configured.id}`, 'DELETE'],
    [`/profiles/${configured.id}/rotate-token`, 'POST'], [`/profiles/${configured.id}/preview`, 'GET'],
  ]) assert.equal((await request(route, { method, auth: otherToken, body: method === 'PUT' ? { name: 'Changed' } : undefined })).status, 404)
  const foreign = await request('/profiles', { method: 'POST', body: { name: 'Unauthorized mix', source_ids: [theirs.id] } })
  assert.equal(foreign.status, 400)
  const update = await request(`/profiles/${configured.id}`, { method: 'PUT', body: { name: 'Should not persist', source_ids: [mine.id, theirs.id] } })
  assert.equal(update.status, 400)
  assert.equal((await listing()).profiles[0].name, 'Fixture profile')
  assert.equal(calls.length, 0)
})

test('validations reject invalid intervals, addresses, names, booleans and IDs before mutation', async () => {
  for (const patch of [
    { name: '' }, { name: 'x'.repeat(101) }, { note: 'x'.repeat(2001) },
    { url: 'file:///private' }, { url: 'https://u:p@source.example.test/' }, { url: 'https://source.example.test/#fragment' },
    { refresh_interval_minutes: 4 }, { refresh_interval_minutes: 10081 }, { refresh_interval_minutes: 5.5 },
    { refresh_interval_minutes: '60' }, { enabled: 'false' },
  ]) {
    const response = await request('/sources', { method: 'POST', body: { name: 'Source', url: 'https://source.example.test/list', ...patch } })
    assert.equal(response.status, 400, JSON.stringify(patch))
  }
  assert.equal((await listing()).sources.length, 0)
  assert.equal((await request('/sources/0', { method: 'DELETE' })).status, 400)
  assert.equal((await request('/profiles/1/preview?format=invalid')).status, 400)
  assert.equal(calls.length, 0)
})

test('successful refresh persists parsed nodes and usage; failures preserve the last good cache and schedule retries', async () => {
  const created = await source({ refresh_interval_minutes: 5 })
  const success = (await (await refresh(created.id)).json()).source
  assert.equal(success.proxy_count, 1)
  assert.equal(success.usage.upload, 10)
  assert.equal(success.usage.download, 20)
  assert.equal(success.usage.total, 100)
  assert.equal(success.usage.expires_at, 2000000000000)
  assert.ok(success.last_success_at)
  const cached = harness.sql.get('SELECT proxies_json FROM subscription_sources WHERE id = ?', created.id).proxies_json
  for (const fail of [async () => { throw new Error('Fixture upstream unavailable') }, async () => ({ text: '<html>not a subscription</html>', subscription_userinfo: null })]) {
    respond = fail
    const failed = (await (await refresh(created.id)).json()).source
    assert.equal(failed.proxy_count, 1)
    assert.equal(failed.last_success_at, success.last_success_at)
    assert.ok(failed.last_error)
    assert.ok(failed.next_fetch_at >= Date.now() + 299_000)
    assert.equal(harness.sql.get('SELECT proxies_json FROM subscription_sources WHERE id = ?', created.id).proxies_json, cached)
  }
  respond = async () => upstream('Recovered')
  harness.sql.run('UPDATE subscription_sources SET next_fetch_at = 1 WHERE id = ?', created.id)
  await harness.runSubscriptionSchedulerTick()
  assert.equal((await listing()).sources[0].last_error, null)
  assert.match(harness.sql.get('SELECT proxies_json FROM subscription_sources WHERE id = ?', created.id).proxies_json, /Recovered/)
})

test('inflight refreshes deduplicate by source and advertise fetching state', async () => {
  const created = await source()
  const gate = deferred()
  respond = () => gate.promise
  const first = refresh(created.id)
  const second = refresh(created.id)
  await until(() => calls.length === 1)
  assert.equal((await listing()).sources[0].fetching, true)
  gate.resolve(upstream())
  assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [200, 200])
  assert.equal(calls.length, 1)
  assert.equal((await listing()).sources[0].fetching, false)
})

test('manual batches and scheduled work share a global limit of three fetches', async () => {
  for (let i = 0; i < 7; i++) await source({ url: `https://source${i}.example.test/list` }, i < 4 ? token : otherToken)
  let active = 0
  let maximum = 0
  const gates = []
  respond = async () => {
    active++
    maximum = Math.max(maximum, active)
    const gate = deferred()
    gates.push(gate)
    await gate.promise
    active--
    return upstream()
  }
  const manual = request('/refresh', { method: 'POST' })
  await until(() => calls.length === 3)
  const scheduled = harness.runSubscriptionSchedulerTick()
  for (let i = 0; i < 7; i++) {
    await until(() => gates.length > i)
    gates[i].resolve()
  }
  assert.equal((await manual).status, 200)
  await scheduled
  assert.equal(calls.length, 7)
  assert.equal(maximum, 3)
  assert.equal(active, 0)
})

test('URL edits discard old requests and clear old cache without overwriting edited settings', async () => {
  const created = await source()
  const gate = deferred()
  respond = () => gate.promise
  const pending = refresh(created.id)
  await until(() => calls.length === 1)
  const edited = await request(`/sources/${created.id}`, { method: 'PUT', body: { url: 'https://source-new.example.test/new', note: 'New source note' } })
  assert.equal(edited.status, 200)
  gate.resolve(upstream('Must not be saved'))
  assert.equal((await pending).status, 200)
  const row = (await listing()).sources[0]
  assert.equal(row.url, 'https://source-new.example.test/new')
  assert.equal(row.note, 'New source note')
  assert.equal(row.proxy_count, 0)
  assert.equal(row.last_success_at, null)
  assert.equal(row.last_error, null)
  respond = async () => upstream('Correct replacement')
  await harness.runSubscriptionSchedulerTick(Date.now() + 10)
  assert.equal((await listing()).sources[0].proxy_count, 1)
})

test('pausing or deleting a source during fetch cannot re-enable it or resurrect its row', async () => {
  const created = await source()
  let gate = deferred()
  respond = () => gate.promise
  const pending = refresh(created.id)
  await until(() => calls.length === 1)
  assert.equal((await request(`/sources/${created.id}`, { method: 'PUT', body: { enabled: false } })).status, 200)
  gate.resolve(upstream())
  await pending
  assert.equal((await listing()).sources[0].enabled, false)
  assert.equal((await listing()).sources[0].next_fetch_at, null)
  assert.equal((await listing()).sources[0].proxy_count, 0)
  gate = deferred()
  const deleting = refresh(created.id)
  await until(() => calls.length === 2)
  assert.equal((await request(`/sources/${created.id}`, { method: 'DELETE' })).status, 200)
  gate.resolve(upstream())
  assert.equal((await deleting).status, 404)
  assert.equal((await listing()).sources.length, 0)
})

test('scheduler reads persisted due times, ignores paused sources, and stop prevents late writes', async () => {
  const due = await source()
  const future = await source()
  const paused = await source({ enabled: false })
  harness.sql.run('UPDATE subscription_sources SET next_fetch_at = ? WHERE id = ?', Date.now() + 86_400_000, future.id)
  await harness.runSubscriptionSchedulerTick()
  assert.equal(calls.length, 1)
  assert.ok((await listing()).sources.find((item) => item.id === due.id).last_success_at)
  assert.equal((await listing()).sources.find((item) => item.id === paused.id).last_success_at, null)
  await harness.runSubscriptionSchedulerTick()
  assert.equal(calls.length, 1)
  // A newly started scheduler sees the database schedule, not an in-memory timer per source.
  harness.sql.run('UPDATE subscription_sources SET next_fetch_at = 1 WHERE id = ?', future.id)
  const gate = deferred()
  respond = () => gate.promise
  const stop = harness.startSubscriptionScheduler()
  await until(() => calls.length === 2)
  stop()
  gate.resolve(upstream())
  await harness.runSubscriptionSchedulerTick()
  assert.equal((await listing()).sources.find((item) => item.id === future.id).last_success_at, null)
  // Pausing affects automatic refresh only; explicit refresh remains available.
  respond = async () => upstream()
  assert.equal((await refresh(paused.id)).status, 200)
  const row = (await listing()).sources.find((item) => item.id === paused.id)
  assert.equal(row.proxy_count, 1)
  assert.equal(row.next_fetch_at, null)
})

test('share tokens are high entropy, rotate and revoke; anonymous feeds only read persisted cache', async () => {
  const created = await source({ enabled: false })
  await refresh(created.id)
  const configured = await profile([created.id])
  assert.match(configured.token, /^[A-Za-z0-9_-]{43}$/)
  const before = calls.length
  for (const format of ['clash', 'links', 'base64']) {
    const response = await request(`/feed/${configured.token}?format=${format}&url=https://untrusted.invalid`, { auth: null })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('subscription-userinfo'), 'upload=10; download=20; total=100; expire=2000000000')
    assert.ok((await response.text()).length > 0)
  }
  assert.equal(calls.length, before)
  const additional = await source()
  const merged = await profile([created.id, additional.id])
  const combinedFeed = await request(`/feed/${merged.token}`, { auth: null })
  assert.equal(combinedFeed.status, 200)
  assert.equal(combinedFeed.headers.get('subscription-userinfo'), null, 'never fabricate a combined quota')
  harness.sql.run('UPDATE subscription_sources SET usage_json = ? WHERE id = ?',
    JSON.stringify({ upload: 0, download: null, total: 100, expires_at: null }), created.id)
  assert.equal((await request(`/feed/${configured.token}`, { auth: null })).headers.get('subscription-userinfo'), 'upload=0; total=100')
  harness.sql.run('UPDATE subscription_sources SET usage_json = NULL WHERE id = ?', created.id)
  assert.equal((await request(`/feed/${configured.token}`, { auth: null })).headers.get('subscription-userinfo'), null)
  assert.equal((await request(`/feed/${configured.token}?format=other`, { auth: null })).status, 400)
  const rotated = (await (await request(`/profiles/${configured.id}/rotate-token`, { method: 'POST' })).json()).profile
  assert.notEqual(rotated.token, configured.token)
  assert.equal((await request(`/feed/${configured.token}`, { auth: null })).status, 404)
  assert.equal((await request(`/feed/${rotated.token}`, { auth: null })).status, 200)
  await request(`/profiles/${configured.id}`, { method: 'PUT', body: { enabled: false } })
  const revoked = await request(`/feed/${rotated.token}`, { auth: null })
  assert.equal(revoked.status, 404)
  assert.equal(revoked.headers.get('cache-control'), 'no-store')
  assert.equal((await request(`/profiles/${configured.id}/preview`)).status, 200)
  await request(`/profiles/${configured.id}`, { method: 'DELETE' })
  assert.equal((await request(`/feed/${rotated.token}`, { auth: null })).status, 404)
  assert.equal(calls.length, before)
})

test('preview carries cache health and parser warnings by source name without upstream URLs', async () => {
  const created = await source({ name: 'Named fixture' })
  const configured = await profile([created.id])
  const empty = await request(`/profiles/${configured.id}/preview`)
  assert.equal(empty.status, 200, await empty.clone().text())
  assert.match((await empty.json()).warnings.join(' '), /Named fixture/)
  assert.equal((await request(`/feed/${configured.token}`, { auth: null })).status, 503)
  await refresh(created.id)
  harness.sql.run('UPDATE subscription_sources SET warnings_json = ?, last_error = ? WHERE id = ?',
    JSON.stringify(['Skipped one unsupported fixture node']), 'Request failed for secret URL', created.id)
  const result = await (await request(`/profiles/${configured.id}/preview`)).json()
  assert.ok(result.warnings.some((warning) => warning.includes('Skipped one unsupported fixture node')))
  assert.ok(result.warnings.some((warning) => warning.includes('最近刷新失败')))
  assert.equal(result.warnings.some((warning) => warning.includes(created.url) || warning.includes('secret URL')), false)
  assert.equal(result.proxy_count, 1)
})

test('profile APIs persist source prefixes and export them through all preview and feed formats', async () => {
  const created = await source({ name: '来源 A' })
  await refresh(created.id)
  const configured = await profile([created.id], { rules: { prepend_source: true, name_prefix: 'P-' } })
  assert.equal(configured.rules.prepend_source, true)
  assert.equal(configured.rules.append_source, false)
  assert.equal((await listing()).profiles[0].rules.prepend_source, true)
  assert.equal(JSON.parse(harness.sql.get('SELECT rules_json FROM subscription_profiles WHERE id = ?', configured.id).rules_json).prepend_source, true)
  for (const format of ['clash', 'links', 'base64']) {
    const preview = await request(`/profiles/${configured.id}/preview?format=${format}`)
    assert.equal(preview.status, 200)
    const output = await preview.json()
    assert.equal(harness.parseSubscription(output.content).proxies[0].name, '[来源 A] P-Fixture node')
    const feed = await request(`/feed/${configured.token}?format=${format}`, { auth: null })
    assert.equal(feed.status, 200)
    assert.equal(harness.parseSubscription(await feed.text()).proxies[0].name, '[来源 A] P-Fixture node')
  }
  const conflict = await request(`/profiles/${configured.id}`, { method: 'PUT', body: { rules: { prepend_source: true, append_source: true } } })
  assert.equal(conflict.status, 400)
  assert.match((await conflict.json()).message, /不能同时前置和后置/)
  assert.equal((await listing()).profiles[0].rules.prepend_source, true)
  for (const prepend_source of [null, 1, 'true']) {
    const invalid = await request('/profiles', { method: 'POST', body: { name: 'Invalid source position', rules: { prepend_source } } })
    assert.equal(invalid.status, 400)
  }
  assert.equal((await listing()).profiles.length, 1)
})

test('legacy persisted rules return an explicit false prefix flag without changing suffix naming', async () => {
  const created = await source({ name: 'Legacy source' })
  await refresh(created.id)
  const configured = await profile([created.id], { rules: { append_source: true, name_prefix: 'P-' } })
  assert.equal(configured.rules.prepend_source, false, 'API callers that omit the option retain existing defaults')
  const legacy = { ...configured.rules }
  delete legacy.prepend_source
  harness.sql.run('UPDATE subscription_profiles SET rules_json = ? WHERE id = ?', JSON.stringify(legacy), configured.id)
  const listed = (await listing()).profiles[0]
  assert.equal(listed.rules.prepend_source, false)
  assert.equal(listed.rules.append_source, true)
  const updated = await request(`/profiles/${configured.id}`, { method: 'PUT', body: { note: 'Preserve old naming' } })
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).profile.rules.prepend_source, false)
  const preview = await (await request(`/profiles/${configured.id}/preview`)).json()
  assert.equal(harness.parseSubscription(preview.content).proxies[0].name, 'P-Fixture node [Legacy source]')
})

test('deleting a source updates profile selections atomically and preserves other accounts', async () => {
  const created = await source()
  const owned = await profile([created.id])
  const other = await source({}, otherToken)
  const unrelated = await profile([other.id], {}, otherToken)
  harness.sql.exec(`CREATE TRIGGER subscription_delete_fixture BEFORE DELETE ON subscription_sources
    WHEN OLD.id = ${created.id} BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;`)
  try {
    assert.equal((await request(`/sources/${created.id}`, { method: 'DELETE' })).status, 500)
    assert.deepEqual((await listing()).profiles.find((item) => item.id === owned.id).source_ids, [created.id])
    assert.equal((await listing()).sources.length, 1)
  } finally { harness.sql.exec('DROP TRIGGER subscription_delete_fixture') }
  assert.equal((await request(`/sources/${created.id}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual((await listing()).profiles[0].source_ids, [])
  assert.deepEqual((await listing(otherToken)).profiles.find((item) => item.id === unrelated.id).source_ids, [other.id])
})

test('per-account source and profile caps reject writes without affecting existing records', async () => {
  for (let i = 0; i < 100; i++) harness.createSubscriptionSource(1, { name: `Source ${i}`, url: `https://source${i}.example.test/list` })
  assert.equal((await request('/sources', { method: 'POST', body: { name: 'Over limit', url: 'https://source.example.test/' } })).status, 409)
  assert.equal((await listing()).sources.length, 100)
  assert.equal((await source({}, otherToken)).name, 'Fixture source')
  for (let i = 0; i < 100; i++) harness.createSubscriptionProfile(1, { name: `Profile ${i}`, source_ids: [] })
  assert.equal((await request('/profiles', { method: 'POST', body: { name: 'Over limit' } })).status, 409)
  assert.equal((await listing()).profiles.length, 100)
  assert.equal(calls.length, 0)
})
