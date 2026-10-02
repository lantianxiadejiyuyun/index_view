import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const serverRoot = fileURLToPath(new URL('../app/server/', import.meta.url))
const tempRoot = path.resolve(tmpdir())
const workspace = mkdtempSync(path.join(tempRoot, 'hd-subscription-relay-'))
const bundle = path.join(workspace, 'fixture.mjs')
const hash = (key) => createHash('sha256').update(key).digest('hex')
const encoded = (name = 'Relay node') => Buffer.from(JSON.stringify({ proxies: [{ name, type: 'ss', server: 'proxy.example.test', port: 443, cipher: 'aes-128-gcm', password: 'fixture-secret' }] })).toString('base64')
let h, token, otherToken, node, otherNode

before(async () => {
  await build({
    stdin: { contents: `
      export { subscriptionRoutes } from './src/routes/subscriptions.ts';
      export * from './src/lib/subscriptions.ts'; export * from './src/lib/subscription-relay.ts';
      export { sql, closeDb } from './src/lib/db.ts'; export { initDatabase } from './src/db/schema.ts';
      export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
    `, resolveDir: serverRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundle,
    banner: { js: SERVER_ESM_BANNER },
    plugins: [{ name: 'relay-fixture', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'relay-fixture' }))
      builder.onResolve({ filter: /\/subscription-fetch\.js$/ }, () => ({ path: 'fetch', namespace: 'relay-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'relay-fixture' }, ({ path: name }) => ({ loader: 'js', resolveDir: serverRoot, contents: name === 'config' ? `
        import { mkdirSync } from 'node:fs';
        export const DB_FILE = ${JSON.stringify(path.join(workspace, 'fixture.db'))};
        export const REFRESH_DAYS = 30, ADMIN_USERNAME = 'relay-fixture', ADMIN_PASSWORD = 'fixture-only-password';
        export const ENV_AGENT_TOKEN = 'shared-enrollment-only', ENV_JWT_SECRET = 'relay-fixture-test-jwt';
        export function ensureDirs() { mkdirSync(${JSON.stringify(workspace)}, { recursive: true }); }
      ` : `
        export { validateSubscriptionUrl } from ${JSON.stringify(path.join(serverRoot, 'src/lib/subscription-fetch.ts'))};
        export async function fetchSubscription() { throw new Error('DIRECT_FETCH_MUST_NOT_RUN'); }
      ` }))
    } }],
  })
  h = await import(pathToFileURL(bundle).href)
  h.initDatabase()
  h.sql.run("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (2, 'relay-other', 'unused', 1, 1)")
  const session = h.createRefreshToken(1, 'fixture', null)
  const otherSession = h.createRefreshToken(2, 'fixture', null)
  token = await h.issueAccessToken({ id: 1, username: 'relay-fixture' }, session.sessionId)
  otherToken = await h.issueAccessToken({ id: 2, username: 'relay-other' }, otherSession.sessionId)
})
beforeEach(() => {
  h.sql.run('DELETE FROM subscription_profiles')
  h.sql.run('DELETE FROM subscription_sources')
  h.sql.run('DELETE FROM agent_nodes')
  node = makeNode('one')
  otherNode = makeNode('two')
})
after(() => {
  h?.closeDb()
  assert.equal(path.dirname(path.resolve(workspace)), tempRoot)
  assert.ok(path.basename(workspace).startsWith('hd-subscription-relay-'))
  rmSync(workspace, { recursive: true, force: true })
})

function makeNode(name, fields = {}) {
  const key = `fixture-only-${name}-key`
  const agentId = `fixture-${name}`
  const result = h.sql.run(`INSERT INTO agent_nodes (name, base_url, agent_id, agent_key_hash, enabled, approved, last_seen_at, relay_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, name, `push://${agentId}`, agentId, hash(key), fields.enabled ?? 1, fields.approved ?? 1,
    fields.last_seen_at ?? Date.now(), fields.relay_seen_at === undefined ? Date.now() : fields.relay_seen_at, Date.now())
  return { id: result.lastInsertRowid, agent_id: agentId, key }
}
function request(route, { method = 'GET', body, auth = token } = {}) {
  return h.subscriptionRoutes.request('/subscriptions' + route, { method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
function agent(route, body, target = node, key = target.key, extras = {}) {
  return h.subscriptionRoutes.request('/agent/subscriptions/' + route, {
    method: 'POST', headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json', ...extras },
    body: JSON.stringify({ agent_id: target.agent_id, ...body }),
  })
}
async function source(fields = {}, auth = token) {
  const response = await request('/sources', { method: 'POST', auth, body: { name: 'Relay fixture', url: 'https://source.example.test/list?token=fixture-secret', fetch_agent_id: node.id, ...fields } })
  assert.equal(response.status, 201, await response.clone().text())
  return (await response.json()).source
}
async function refresh(id) {
  const response = await request(`/sources/${id}/refresh`, { method: 'POST' })
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).source
}
async function poll(target = node) {
  const response = await agent('poll', { version: 1 }, target)
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).job
}
async function result(job, fields = {}, target = node) {
  const response = await agent('result', { job_id: job.id, content_base64: encoded(), ...fields }, target)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
const row = (id) => h.sql.get('SELECT * FROM subscription_sources WHERE id = ?', id)
const jobs = () => h.sql.all('SELECT * FROM subscription_fetch_jobs')
async function cachedSource() {
  const created = await source()
  await refresh(created.id)
  assert.equal((await result(await poll())).accepted, true)
  return created
}

test('current schema preserves direct fetching defaults and relay metadata without node secrets', async () => {
  assert.equal(h.sql.get('PRAGMA user_version').user_version, 14)
  const direct = await source({ fetch_agent_id: null })
  assert.equal(direct.fetch_agent_id, null)
  assert.equal(direct.fetch_agent_name, null)
  assert.equal(direct.fetch_status, 'idle')
  makeNode('legacy', { relay_seen_at: null })
  makeNode('offline', { last_seen_at: 1, relay_seen_at: 1 })
  const data = await (await request('')).json()
  assert.equal(data.relay_nodes.length, 4)
  assert.equal(data.relay_nodes.find((item) => item.name === 'legacy').capable, false)
  assert.equal(data.relay_nodes.find((item) => item.name === 'offline').online, false)
  assert.deepEqual(Object.keys(data.relay_nodes[0]).sort(), ['id', 'name', 'enabled', 'approved', 'online', 'capable', 'last_seen_at', 'relay_transport', 'relay_connected'].sort())
  assert.equal(JSON.stringify(data).includes(node.key), false)
  assert.equal(JSON.stringify(data).includes(hash(node.key)), false)
})

test('relay authentication only accepts each approved enabled node dedicated key and v1 polling', async () => {
  for (const key of ['', 'shared-enrollment-only', otherNode.key, token]) assert.equal((await agent('poll', { version: 1 }, node, key)).status, 401)
  assert.equal((await agent('poll', { agent_id: otherNode.agent_id, version: 1 }, node)).status, 401)
  assert.equal((await agent('poll', { version: 2 })).status, 400)
  const denied = makeNode('denied', { approved: 0 })
  const disabled = makeNode('disabled', { enabled: 0 })
  for (const item of [denied, disabled]) assert.equal((await agent('poll', { version: 1 }, item)).status, 403)
  const legacy = makeNode('legacy', { relay_seen_at: null, last_seen_at: 1 })
  const heartbeat = await agent('poll', { version: 1 }, legacy)
  assert.equal(heartbeat.status, 200)
  assert.equal(heartbeat.headers.get('cache-control'), 'no-store')
  assert.ok(h.sql.get('SELECT relay_seen_at FROM agent_nodes WHERE id = ?', legacy.id).relay_seen_at > 1)
  assert.equal(jobs().length, 0)
})

test('source selection validates push node authorization while preserving account isolation', async () => {
  const denied = makeNode('denied', { approved: 0 })
  for (const fetch_agent_id of [0, -1, '1', 1.5, 99999, denied.id]) {
    assert.equal((await request('/sources', { method: 'POST', body: { name: 'Rejected', url: 'https://source.example.test/', fetch_agent_id } })).status, 400)
  }
  const created = await source()
  assert.equal((await request(`/sources/${created.id}/refresh`, { method: 'POST', auth: otherToken })).status, 404)
  assert.equal((await request(`/sources/${created.id}`, { method: 'PUT', auth: otherToken, body: { fetch_agent_id: otherNode.id } })).status, 404)
  assert.equal(jobs().length, 0)
})

test('manual refresh queues once, atomically leases once, and server parses content and traffic', async () => {
  const created = await source()
  const pending = await Promise.all([refresh(created.id), refresh(created.id), refresh(created.id)])
  assert.ok(pending.every((item) => item.fetching && item.fetch_status === 'queued'))
  assert.equal(jobs().length, 1)
  assert.match(jobs()[0].id, /^[A-Za-z0-9_-]{32}$/)
  const leased = await Promise.all([poll(), poll()])
  const job = leased.find(Boolean)
  assert.equal(leased.filter(Boolean).length, 1)
  assert.equal(job.url, created.url)
  assert.ok(job.expires_at > Date.now() + 110_000)
  assert.equal((await refresh(created.id)).fetch_status, 'fetching')
  assert.equal((await result(job, { subscription_userinfo: 'upload=10; download=20; total=100; expire=2000000000' })).accepted, true)
  const stored = row(created.id)
  assert.equal(stored.proxy_count, 1)
  assert.equal(stored.last_error, null)
  assert.deepEqual(JSON.parse(stored.usage_json), { upload: 10, download: 20, total: 100, expires_at: 2000000000000 })
  assert.ok(stored.next_fetch_at >= Date.now() + 3_599_000)
  assert.equal(jobs().length, 0)
  assert.deepEqual(await result(job, { content_base64: encoded('Duplicate must not replace cache') }), { ok: true, accepted: false })
  assert.deepEqual(row(created.id), stored)
})

test('cross-node polling and results cannot reveal or replace another node task', async () => {
  const mine = await source()
  const theirs = await source({ fetch_agent_id: otherNode.id, name: 'Other relay' })
  await refresh(mine.id)
  await refresh(theirs.id)
  const ownJob = await poll()
  const otherJob = await poll(otherNode)
  assert.notEqual(ownJob.id, otherJob.id)
  assert.deepEqual(await result(ownJob, {}, otherNode), { ok: true, accepted: false })
  assert.deepEqual(await result(otherJob, {}, node), { ok: true, accepted: false })
  assert.equal(row(mine.id).proxy_count, 0)
  assert.equal((await result(ownJob)).accepted, true)
  assert.equal((await result(otherJob, {}, otherNode)).accepted, true)
})

test('persisted jobs can be claimed by a new server process without any in-memory handoff', async () => {
  const created = await source()
  await refresh(created.id)
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const h = await import(${JSON.stringify(pathToFileURL(bundle).href)});
    const result = h.pollSubscriptionRelay(${JSON.stringify({ agent_id: node.agent_id, version: 1 })}, ${JSON.stringify(node.key)});
    process.stdout.write(JSON.stringify(result));
    h.closeDb();
  `], { encoding: 'utf8', windowsHide: true })
  const { job } = JSON.parse(child)
  assert.equal(job.id, jobs()[0].id)
  assert.equal(jobs()[0].state, 'leased')
  assert.equal((await result(job)).accepted, true)
  assert.equal(row(created.id).proxy_count, 1)
})

test('source note, URL, relay assignment and pause edits reject any already leased result', async () => {
  for (const edit of [{ note: 'Updated note' }, { url: 'https://replacement.example.test/' }, { fetch_agent_id: otherNode.id }, { enabled: false }]) {
    const created = await source()
    await refresh(created.id)
    const job = await poll()
    assert.equal((await request(`/sources/${created.id}`, { method: 'PUT', body: edit })).status, 200)
    const edited = row(created.id)
    assert.equal((await result(job)).accepted, false)
    assert.deepEqual(row(created.id), edited)
    assert.equal(jobs().length, 0)
  }
})

test('source deletion cascades jobs and a late response cannot resurrect data', async () => {
  const created = await source()
  await refresh(created.id)
  const job = await poll()
  assert.equal((await request(`/sources/${created.id}`, { method: 'DELETE' })).status, 200)
  assert.equal(jobs().length, 0)
  assert.equal((await result(job)).accepted, false)
  assert.equal(row(created.id), undefined)
})

test('node disable/re-enable, approval revoke and key reset permanently revoke in-flight jobs', async () => {
  for (const field of ['enabled', 'approved', 'agent_key_hash']) {
    const created = await source()
    await refresh(created.id)
    const job = await poll()
    h.sql.run(`UPDATE agent_nodes SET ${field} = ? WHERE id = ?`, field === 'agent_key_hash' ? null : 0, node.id)
    assert.equal(jobs().length, 0)
    const rejected = await agent('result', { job_id: job.id, content_base64: encoded() })
    assert.equal(rejected.status, field === 'agent_key_hash' ? 401 : 403)
    h.sql.run(`UPDATE agent_nodes SET ${field} = ? WHERE id = ?`, field === 'agent_key_hash' ? hash(node.key) : 1, node.id)
    const unchanged = row(created.id)
    assert.equal((await result(job)).accepted, false)
    assert.deepEqual(row(created.id), unchanged)
    await poll()
  }
})

test('deleting selected probe retains assignment and never silently falls back to server network', async () => {
  const created = await cachedSource()
  await refresh(created.id)
  const job = await poll()
  h.sql.run('DELETE FROM agent_nodes WHERE id = ?', node.id)
  assert.equal(jobs().length, 0)
  assert.equal(row(created.id).fetch_agent_id, node.id)
  const failed = await refresh(created.id)
  assert.equal(failed.fetch_agent_id, node.id)
  assert.equal(failed.fetch_agent_name, null)
  assert.match(failed.last_error, /已删除/)
  assert.equal(failed.proxy_count, 1)
  assert.equal((await agent('result', { job_id: job.id, content_base64: encoded() })).status, 401)
})

test('full-form edits can preserve a disabled or deleted relay while pausing and updating notes', async () => {
  const created = await cachedSource()
  h.sql.run('UPDATE agent_nodes SET enabled = 0 WHERE id = ?', node.id)
  const disabledEdit = await request(`/sources/${created.id}`, { method: 'PUT', body: {
    fetch_agent_id: node.id, enabled: false, note: 'Pause the disabled probe',
  } })
  assert.equal(disabledEdit.status, 200, await disabledEdit.clone().text())
  assert.equal(row(created.id).fetch_agent_id, node.id)
  assert.equal(row(created.id).next_fetch_at, null)
  assert.equal(row(created.id).note, 'Pause the disabled probe')
  assert.match((await refresh(created.id)).last_error, /停用/)
  assert.equal(jobs().length, 0)

  h.sql.run('DELETE FROM agent_nodes WHERE id = ?', node.id)
  const deletedEdit = await request(`/sources/${created.id}`, { method: 'PUT', body: {
    fetch_agent_id: node.id, enabled: false, note: 'Keep the removed probe assignment',
  } })
  assert.equal(deletedEdit.status, 200, await deletedEdit.clone().text())
  const saved = (await deletedEdit.json()).source
  assert.equal(saved.fetch_agent_id, node.id)
  assert.equal(saved.fetch_agent_name, null)
  assert.equal(saved.enabled, false)
  assert.equal(saved.next_fetch_at, null)
  assert.equal(saved.note, 'Keep the removed probe assignment')
  assert.equal(saved.proxy_count, 1)
  assert.match((await refresh(created.id)).last_error, /已删除/)
  assert.equal(jobs().length, 0)

  h.sql.run('UPDATE agent_nodes SET enabled = 0 WHERE id = ?', otherNode.id)
  const changedSelection = await request(`/sources/${created.id}`, { method: 'PUT', body: { fetch_agent_id: otherNode.id } })
  assert.equal(changedSelection.status, 400)
  assert.equal(row(created.id).fetch_agent_id, node.id)
})

test('expired queued and leased work retains cache, ignores late writes and schedules the next attempt', async () => {
  const created = await cachedSource()
  const cached = row(created.id).proxies_json
  for (const lease of [false, true]) {
    await refresh(created.id)
    const job = lease ? await poll() : jobs()[0]
    h.sql.run('UPDATE subscription_fetch_jobs SET expires_at = 1 WHERE id = ?', job.id)
    const unchanged = row(created.id)
    assert.equal((await result(job)).accepted, false)
    assert.deepEqual(row(created.id), unchanged)
    await h.runSubscriptionSchedulerTick()
    const expired = row(created.id)
    assert.equal(expired.proxies_json, cached)
    assert.match(expired.last_error, /时限/)
    assert.ok(expired.next_fetch_at > Date.now() + 3_599_000)
    assert.equal(jobs().length, 0)
  }
})

test('old and offline agents return actionable errors; versioned polling enables relay', async () => {
  const legacy = makeNode('legacy', { relay_seen_at: null })
  const created = await source({ fetch_agent_id: legacy.id })
  assert.match((await refresh(created.id)).last_error, /新版探针/)
  assert.equal(jobs().length, 0)
  await poll(legacy)
  assert.equal((await refresh(created.id)).fetch_status, 'queued')
  assert.equal((await result(await poll(legacy), {}, legacy)).accepted, true)
  h.sql.run('UPDATE agent_nodes SET relay_seen_at = 1 WHERE id = ?', legacy.id)
  assert.match((await refresh(created.id)).last_error, /未在线/)
  assert.equal(row(created.id).proxy_count, 1)
})

test('scheduled tasks use the configured relay; paused sources still permit explicit refresh', async () => {
  const automatic = await source()
  const paused = await source({ enabled: false })
  await h.runSubscriptionSchedulerTick()
  assert.equal(jobs().length, 1)
  assert.equal(jobs()[0].source_id, automatic.id)
  assert.equal((await result(await poll())).accepted, true)
  assert.equal((await refresh(paused.id)).fetch_status, 'queued')
  assert.equal((await result(await poll())).accepted, true)
  assert.equal(row(paused.id).next_fetch_at, null)
  assert.equal(row(paused.id).enabled, 0)
})

test('malformed, oversized and forged results cannot modify cached state or consume a lease', async () => {
  const created = await cachedSource()
  await refresh(created.id)
  const job = await poll()
  const unchanged = row(created.id)
  const malformed = [
    { content_base64: 'not base64!' }, { content_base64: 'YQ' }, { content_base64: 'YR==' },
    { content_base64: Buffer.from([0xff]).toString('base64') },
    { content_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') },
    { subscription_userinfo: 'x'.repeat(1025) }, { subscription_userinfo: 'total=10\r\nInjected: true' },
    { error_code: 'SECRET_RAW_ERROR' }, { error_code: 'TIMEOUT', content_base64: encoded() },
    { http_status: 900 }, { job_id: '../invalid' },
  ]
  for (const fields of malformed) {
    const response = await agent('result', { job_id: job.id, content_base64: encoded(), ...fields })
    assert.equal(response.status, 400, JSON.stringify(fields).slice(0, 80))
    assert.deepEqual(row(created.id), unchanged)
    assert.equal(jobs().length, 1)
  }
  const oversized = await agent('result', { job_id: job.id, extra: 'x'.repeat(4 * 1024 * 1024) })
  assert.equal(oversized.status, 413)
  const declared = await agent('result', { job_id: job.id }, node, node.key, { 'Content-Length': String(4 * 1024 * 1024 + 1) })
  assert.equal(declared.status, 413)
  assert.deepEqual(row(created.id), unchanged)
  assert.equal((await result(job)).accepted, true)
})

test('upstream errors and parser failures preserve cache and never echo probe-supplied secrets', async () => {
  const created = await cachedSource()
  const cached = row(created.id).proxies_json
  for (const error_code of ['NETWORK_UNREACHABLE', 'CONNECTION_REFUSED', 'CONNECTION_RESET', 'TIMEOUT', 'DNS_ERROR', 'TLS_ERROR', 'HTTP_ERROR', 'TOO_LARGE', 'INVALID_URL', 'PRIVATE_ADDRESS', 'FETCH_FAILED', 'UNSUPPORTED_ENCODING']) {
    await refresh(created.id)
    const job = await poll()
    const response = await agent('result', { job_id: job.id, error_code, http_status: 503, error: 'password=probe-secret' })
    assert.deepEqual(await response.json(), { ok: true, accepted: true })
    assert.equal(row(created.id).proxies_json, cached)
    assert.equal(row(created.id).last_error.includes('probe-secret'), false)
    assert.ok(row(created.id).last_error)
  }
  await refresh(created.id)
  assert.equal((await result(await poll(), { content_base64: Buffer.from('<html>secret-token-and-password</html>').toString('base64') })).accepted, true)
  assert.equal(row(created.id).proxies_json, cached)
  assert.match(row(created.id).last_error, /无法解析/)
  assert.equal(row(created.id).last_error.includes('secret-token'), false)
})

test('public feeds remain cache-only during queued relay refreshes', async () => {
  const created = await cachedSource()
  const response = await request('/profiles', { method: 'POST', body: { name: 'Relay export', source_ids: [created.id] } })
  const profile = (await response.json()).profile
  await refresh(created.id)
  const before = jobs()
  const feed = await request(`/feed/${profile.token}`, { auth: null })
  assert.equal(feed.status, 200)
  assert.match(await feed.text(), /Relay node/)
  assert.deepEqual(jobs(), before)
})
