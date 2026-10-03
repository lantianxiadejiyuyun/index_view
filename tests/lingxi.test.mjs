import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { after, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const root = fileURLToPath(new URL('../app/server/', import.meta.url))
const workspace = mkdtempSync(path.join(tmpdir(), 'hd-lingxi-'))
const previousTransport = globalThis.__lingxiRequest
let h, token, otherToken, respond
const calls = []
const user = { id: 7, username: 'lingxi-test', timezone: 'Asia/Shanghai', capabilities: ['tasks', 'calendar', 'chat'] }
const json = data => new Response(JSON.stringify({ ok: true, data }), { headers: { 'Content-Type': 'application/json' } })
before(async () => {
  await build({
    stdin: { contents: `
      export { lingxiRoutes } from './src/routes/lingxi.ts';
      export * from './src/lib/lingxi.ts';
      export * from './src/lib/lingxi-secrets.ts';
      export { requestLingxi, normalizeLingxiBaseUrl, validateLingxiPath, LingxiError } from './src/lib/lingxi-transport.ts';
      export { sql, closeDb } from './src/lib/db.ts';
      export { initDatabase } from './src/db/schema.ts';
      export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
      export { bootstrapRoutes } from './src/routes/bootstrap.ts';
    `, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: path.join(workspace, 'fixture.mjs'),
    banner: { js: SERVER_ESM_BANNER }, plugins: [{ name: 'lingxi-fixture', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'lingxi-fixture' }))
      builder.onResolve({ filter: /\/lingxi-transport\.js$/ }, args => ({ path: args.importer.endsWith('lingxi.ts') || args.importer.endsWith('lingxi-vault.ts') ? 'transport-mock' : 'transport-real', namespace: 'lingxi-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'lingxi-fixture' }, ({ path: file }) => ({
        contents: file === 'config' ? `
          import { mkdirSync } from 'node:fs';
          export const DB_FILE = ${JSON.stringify(path.join(workspace, 'app.db'))};
          export const REFRESH_DAYS = 30, PUBLIC_VIEW = false;
          export const ADMIN_USERNAME = 'lingxi-fixture', ADMIN_PASSWORD = 'test-only';
          export const ENV_AGENT_TOKEN = 'test-agent', ENV_JWT_SECRET = 'test-lingxi-encryption';
          export function ensureDirs() { mkdirSync(${JSON.stringify(workspace)}, { recursive: true }); }
        ` : `export * from ${JSON.stringify(path.join(root, 'src/lib/lingxi-transport.ts'))}; ${file === 'transport-mock' ? 'export const requestLingxi = (...args) => globalThis.__lingxiRequest(...args);' : ''}`,
        resolveDir: root, loader: 'js',
      }))
    } }],
  })
  globalThis.__lingxiRequest = (...args) => { calls.push(args); return respond(...args) }
  h = await import(pathToFileURL(path.join(workspace, 'fixture.mjs')).href)
  h.initDatabase()
  h.sql.run("INSERT INTO users (id,username,password_hash,created_at,updated_at) VALUES (2,'other','unused',1,1)")
  const first = h.createRefreshToken(1, 'fixture', null), second = h.createRefreshToken(2, 'fixture', null)
  token = await h.issueAccessToken({ id: 1, username: 'lingxi-fixture' }, first.sessionId)
  otherToken = await h.issueAccessToken({ id: 2, username: 'other' }, second.sessionId)
})
beforeEach(() => {
  h.sql.exec('DELETE FROM lingxi_vault_audit; DELETE FROM lingxi_vault_grants; DELETE FROM lingxi_bindings; DELETE FROM vaults;')
  respond = async () => json(user)
  calls.length = 0
})
after(() => {
  h?.closeDb()
  if (previousTransport === undefined) delete globalThis.__lingxiRequest; else globalThis.__lingxiRequest = previousTransport
  assert.equal(path.dirname(path.resolve(workspace)), path.resolve(tmpdir()))
  assert.ok(path.basename(workspace).startsWith('hd-lingxi-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
function request(route, body, auth = token, method = body === undefined ? 'GET' : 'POST') {
  return h.lingxiRoutes.request('/lingxi' + route, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function bind(auth = token, input = { base_url: 'https://lingxi.example/lingxi/api/v1', api_token: 'lx_fixture_secret' }) {
  const response = await request('/settings', input, auth, 'PUT')
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}

test('Lingxi binding is authenticated, user-isolated, encrypted and excluded from bootstrap', async () => {
  assert.equal((await request('/settings', undefined, null)).status, 401)
  assert.equal((await request('/tasks')).status, 409)
  const result = await bind()
  assert.equal(result.base_url, 'https://lingxi.example/lingxi')
  assert.equal(result.user.id, 7)
  assert.equal(result.configured, true)
  const row = h.sql.get('SELECT * FROM lingxi_bindings WHERE user_id=1')
  assert.ok(row.api_token_encrypted.startsWith('v1.'))
  assert.ok(!JSON.stringify(row).includes('lx_fixture_secret'))
  const settings = await request('/settings')
  assert.equal(settings.headers.get('cache-control'), 'no-store')
  assert.ok(!(await settings.text()).includes('lx_fixture_secret'))
  assert.equal((await (await request('/settings', undefined, otherToken)).json()).configured, false)
  const bootstrap = await h.bootstrapRoutes.request('/bootstrap', { headers: { Authorization: `Bearer ${token}` } })
  const body = await bootstrap.text()
  assert.ok(!body.includes('lx_fixture_secret') && !body.includes(row.api_token_encrypted))
  assert.throws(() => h.openLingxiSecret(2, 'api-token', row.api_token_encrypted))
  assert.throws(() => h.openLingxiSecret(1, 'vault-snapshot', row.api_token_encrypted))
})

test('Failed rebinding preserves saved credentials; successful identity changes revoke vault access', async () => {
  await bind()
  const stored = h.sql.get('SELECT * FROM lingxi_bindings WHERE user_id=1')
  respond = async () => { throw new h.LingxiError('授权失效', 403) }
  assert.equal((await request('/settings', { api_token: 'lx_bad' }, token, 'PUT')).status, 403)
  assert.deepEqual(h.sql.get('SELECT * FROM lingxi_bindings WHERE user_id=1'), stored)
  assert.equal((await request('/settings', { base_url: 'https://different.example' }, token, 'PUT')).status, 400)
  h.sql.run("INSERT INTO lingxi_vault_grants (user_id,enabled,grant_id,snapshot_encrypted,updated_at) VALUES (1,1,'grant','secret-copy',1)")
  respond = async () => json({ ...user, id: 8 })
  await bind(token, { api_token: 'lx_new' })
  const grant = h.sql.get('SELECT * FROM lingxi_vault_grants WHERE user_id=1')
  assert.equal(grant.enabled, 0); assert.equal(grant.snapshot_encrypted, null)
  assert.equal((await request('/settings', undefined, token, 'DELETE')).status, 200)
  assert.equal(h.getLingxiSettings(1).configured, false)
})

test('Calendar and task adapters preserve occurrence IDs, timezone, null deadlines and pagination', async () => {
  await bind(); calls.length = 0
  respond = async (_base, _token, input) => {
    if (input.path === '/events/occurrences') return json([{ event_id: 4, occurrence_id: '4@2026-10-03', title: '日程', start_at: '2026-10-03T01:00:00Z', end_at: null }])
    if (input.path === '/events/4') return json({ id: 4, title: '系列主事件', start_at: '2026-09-01T01:00:00Z', end_at: null, rrule: 'FREQ=DAILY' })
    if (input.method === 'PATCH') return json({ id: 5, title: '待办', ...input.body })
    return new Response(JSON.stringify({ ok: true, data: [{ id: 5, due_at: '2026-10-05T12:00:00Z' }], pagination: { limit: 200, offset: 0, total: 201 } }), { headers: { 'Content-Type': 'application/json' } })
  }
  const calendar = await request('/calendar?start=2026-10-01T00%3A00%3A00Z&end=2026-11-01T00%3A00%3A00Z')
  assert.equal(calendar.status, 200)
  const events = await calendar.json()
  assert.equal(events.events[0].id, 4); assert.equal(events.events[0].occurrence_id, '4@2026-10-03'); assert.equal(events.events[0].start, '2026-10-03T01:00:00Z')
  assert.equal(events.timezone, 'Asia/Shanghai')
  const master = await (await request('/calendar/4')).json()
  assert.equal(master.event.start, '2026-09-01T01:00:00Z'); assert.equal(master.event.rrule, 'FREQ=DAILY')
  assert.equal((await request('/calendar?start=2026-10-01&end=2026-11-01')).status, 400)
  const tasks = await (await request('/tasks?status=open')).json()
  assert.equal(tasks.tasks[0].due, '2026-10-05T12:00:00Z'); assert.equal(tasks.pagination.total, 201)
  const cleared = await request('/tasks/5', { due: null, status: 'done', hidden_internal: 'never-forward' }, token, 'PATCH')
  assert.equal(cleared.status, 200)
  assert.deepEqual(calls.at(-1)[2].body, { due_at: null, status: 'done' })
  assert.equal((await cleared.json()).task.due, null)
})

test('Events, conversations and SSE use the exact upstream v1 contract without retrying messages', async () => {
  await bind(); calls.length = 0
  respond = async (_base, _token, input) => {
    if (input.stream) return new Response('event: delta\ndata: {"type":"delta","data":"草稿"}\n\nevent: done\ndata: {"type":"done","data":"最终"}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } })
    if (input.path === '/events') return json({ id: 6, ...input.body })
    if (input.method === 'POST') return json({ id: 8, title: input.body.title })
    return json([])
  }
  const event = await request('/calendar', { title: '例会', start: '2026-10-03T12:00:00+08:00', end: null, all_day: false })
  assert.equal(event.status, 201); assert.equal((await event.json()).event.end, null)
  assert.equal(calls.at(-1)[2].body.start_at, '2026-10-03T12:00:00+08:00')
  assert.equal((await request('/sessions', { title: '测试会话' })).status, 201)
  assert.equal(calls.at(-1)[2].path, '/conversations')
  const stream = await request('/sessions/8/messages', { message: '你好', request_id: 'nav-1' })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  assert.match(await stream.text(), /"data":"最终"/)
  assert.deepEqual(calls.at(-1)[2].body, { message: '你好', stream: true, request_id: 'nav-1' })
  assert.equal(calls.filter(call => call[2].path === '/conversations/8/messages').length, 1)
  assert.equal((await request('/sessions/0/messages', { message: '你好' })).status, 400)
  assert.equal((await request('/sessions/8/messages', { message: 'x'.repeat(70_000) })).status, 413)
})

test('Unbinding cancels in-flight SSE and prevents a pending first bind from restoring access', async () => {
  await bind()
  let upstreamController, aborted = false
  respond = async (_base, _token, input) => new Response(new ReadableStream({
    start(controller) { upstreamController = controller; input.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')) }, { once: true }) },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
  const stream = await request('/sessions/8/messages', { message: '测试中断' }), reader = stream.body.getReader()
  upstreamController.enqueue(new TextEncoder().encode('event: delta\ndata: first\n\n'))
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/)
  assert.equal((await request('/settings', undefined, token, 'DELETE')).status, 200)
  await assert.rejects(reader.read()); assert.equal(aborted, true)
  let resolveMe, started
  const waiting = new Promise(resolve => { started = resolve })
  respond = () => new Promise(resolve => { resolveMe = resolve; started() })
  const pendingBinding = request('/settings', { base_url: 'https://lingxi.example', api_token: 'lx_cancelled' }, token, 'PUT')
  await waiting
  await request('/settings', undefined, token, 'DELETE')
  resolveMe(json(user))
  assert.equal((await pendingBinding).status, 409)
  assert.equal(h.getLingxiSettings(1).configured, false)
})

test('Session revocation during a stream blocks subsequent data and releases the request slot', async () => {
  await bind()
  const session = h.createRefreshToken(1, 'revocation-fixture', null)
  const sessionToken = await h.issueAccessToken({ id: 1, username: 'lingxi-fixture' }, session.sessionId)
  let upstreamController, cancelled = false
  respond = async () => new Response(new ReadableStream({ start(controller) { upstreamController = controller }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'text/event-stream' } })
  const response = await request('/sessions/8/messages', { message: '撤销登录' }, sessionToken), reader = response.body.getReader()
  upstreamController.enqueue(new TextEncoder().encode('first'))
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
  h.sql.run('UPDATE auth_sessions SET revoked_at=? WHERE id=?', Date.now(), session.sessionId)
  upstreamController.enqueue(new TextEncoder().encode('must-not-arrive'))
  await assert.rejects(reader.read(), /已变更/)
  assert.equal(cancelled, true)
  respond = async () => json(user)
  assert.equal((await request('/me')).status, 200)
})

test('Revoking the navigation device while verifying a bind prevents credential persistence', async () => {
  const session = h.createRefreshToken(1, 'pending-bind-fixture', null)
  const sessionToken = await h.issueAccessToken({ id: 1, username: 'lingxi-fixture' }, session.sessionId)
  let resolveMe, started
  const waiting = new Promise(resolve => { started = resolve })
  respond = () => new Promise(resolve => { resolveMe = resolve; started() })
  const pendingBinding = request('/settings', { base_url: 'https://lingxi.example', api_token: 'lx_cancelled' }, sessionToken, 'PUT')
  await waiting
  h.sql.run('UPDATE auth_sessions SET revoked_at=? WHERE id=?', Date.now(), session.sessionId)
  resolveMe(json(user))
  assert.equal((await pendingBinding).status, 403)
  assert.equal(h.getLingxiSettings(1).configured, false)
})

function readyVault() {
  h.sql.run('INSERT INTO vaults (user_id,version,created_at) VALUES (1,3,1)')
  h.sql.run("INSERT INTO lingxi_vault_grants (user_id,enabled,grant_id,snapshot_encrypted,snapshot_version,source_version,authorized_at,updated_at,service_token_hash,service_token_expires_at) VALUES (1,1,'current-grant','encrypted-fixture',2,3,1,1,?,?)", '1'.repeat(64), Date.now() + 3600_000)
}
test('Protected vault metadata and reveal require a current local grant and preserve string IDs', async () => {
  await bind(); calls.length = 0
  assert.equal((await request('/vault/items')).status, 403)
  assert.equal((await request('/vault/reveal', { id: 'entry-uuid' })).status, 403)
  assert.equal(calls.length, 0)
  readyVault()
  const item = { id: 'entry-uuid', title: '测试账号', site: 'https://example.com', username_masked: 'a***', password_set: true, password: 'must-not-leak-in-list', notes: 'private notes' }
  respond = async (_base, _token, input) => input.method === 'POST' ? json({ id: 'entry-uuid', title: '测试账号', site: 'https://example.com', username: 'alice', password: 'explicit-click-secret' })
    : new Response(JSON.stringify({ ok: true, data: [item], pagination: { limit: 20, offset: 0, total: 1 } }), { headers: { 'Content-Type': 'application/json' } })
  const listing = await request('/vault/items?q=hello&limit=20&offset=0'), metadata = await listing.json()
  assert.equal(listing.headers.get('cache-control'), 'no-store')
  assert.deepEqual(metadata.items, [{ id: 'entry-uuid', title: '测试账号', site: 'https://example.com', username_masked: 'a***', password_set: true }])
  assert.equal(metadata.pagination.total, 1)
  assert.deepEqual(calls.at(-1)[2].query, { q: 'hello', limit: '20', offset: '0' })
  assert.equal(calls.at(-1)[2].vaultGrantHash, '1'.repeat(64))
  const reveal = await request('/vault/reveal', { id: 'entry-uuid', vaultGrantHash: '2'.repeat(64) })
  assert.equal(reveal.headers.get('cache-control'), 'no-store')
  assert.equal((await reveal.json()).item.password, 'explicit-click-secret')
  assert.equal(calls.at(-1)[2].path, '/integrations/navigation-vault/reveal')
  assert.deepEqual(calls.at(-1)[2].body, { id: 'entry-uuid' })
  assert.equal(calls.at(-1)[2].vaultGrantHash, '1'.repeat(64))
  const spoofed = await h.lingxiRoutes.request('/lingxi/vault/items?vaultGrantHash=' + '2'.repeat(64), { headers: { Authorization: `Bearer ${token}`, 'X-Navigation-Vault-Grant': '2'.repeat(64) } })
  assert.equal(spoofed.status, 200); assert.equal(calls.at(-1)[2].vaultGrantHash, '1'.repeat(64))
  const count = calls.length
  assert.equal((await request('/vault/items', undefined, otherToken)).status, 403)
  assert.equal((await request('/vault/reveal', { id: 12 })).status, 400)
  h.sql.run('UPDATE vaults SET version=4 WHERE user_id=1')
  assert.equal((await request('/vault/items')).status, 409)
  assert.equal(calls.length, count)
})

test('Vault reveal discards in-flight plaintext after permission revocation and rejects mismatched IDs', async () => {
  await bind(); readyVault()
  respond = async () => json({ id: 'other-entry', title: 'Wrong', site: 'https://example.com', username: 'alice', password: 'must-not-return' })
  const mismatch = await request('/vault/reveal', { id: 'requested-entry' })
  assert.equal(mismatch.status, 502); assert.ok(!(await mismatch.text()).includes('must-not-return'))
  let started, resolveReveal
  const waiting = new Promise(resolve => { started = resolve })
  respond = () => new Promise(resolve => { resolveReveal = resolve; started() })
  const pending = request('/vault/reveal', { id: 'requested-entry' })
  await waiting
  h.sql.run('UPDATE lingxi_vault_grants SET enabled=0 WHERE user_id=1')
  resolveReveal(json({ id: 'requested-entry', title: 'Right', site: 'https://example.com', username: 'alice', password: 'must-not-return' }))
  const rejected = await pending
  assert.equal(rejected.status, 403); assert.ok(!(await rejected.text()).includes('must-not-return'))
})

test('Vault requests require unexpired registration and discard in-flight results when the service token rotates', async () => {
  await bind(); readyVault(); calls.length = 0
  h.sql.run('UPDATE lingxi_vault_grants SET service_token_hash=NULL WHERE user_id=1')
  for (const route of ['/vault/items', '/vault/reveal']) {
    const response = await request(route, route.endsWith('reveal') ? { id: 'entry-uuid' } : undefined)
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'lingxi_vault_service_not_ready')
  }
  h.sql.run('UPDATE lingxi_vault_grants SET service_token_hash=?,service_token_expires_at=? WHERE user_id=1', '1'.repeat(64), Date.now() - 1)
  assert.equal((await request('/vault/items')).status, 409)
  assert.equal(calls.length, 0)
  h.sql.run('UPDATE lingxi_vault_grants SET service_token_expires_at=? WHERE user_id=1', Date.now() + 3600_000)
  let started, resolveReveal
  const waiting = new Promise(resolve => { started = resolve })
  respond = () => new Promise(resolve => { resolveReveal = resolve; started() })
  const pending = request('/vault/reveal', { id: 'entry-uuid' })
  await waiting
  assert.equal(calls.at(-1)[2].vaultGrantHash, '1'.repeat(64))
  h.sql.run('UPDATE lingxi_vault_grants SET service_token_hash=? WHERE user_id=1', '2'.repeat(64))
  resolveReveal(json({ id: 'entry-uuid', title: 'Synthetic', site: 'https://example.com', username: 'alice', password: 'rotated-secret-must-not-return' }))
  const response = await pending
  assert.equal(response.status, 409)
  const body = await response.json(); assert.equal(body.error, 'lingxi_vault_changed'); assert.ok(!JSON.stringify(body).includes('rotated-secret-must-not-return'))
})

test('Transport rejects private networks, unknown endpoints, credentials, downgrades and redirects', async () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/?token=secret', 'https://127.0.0.1', 'https://[::1]', 'https://example.com/%2fhidden']) assert.throws(() => h.normalizeLingxiBaseUrl(url))
  for (const endpoint of ['/chat', '/settings', '//evil.example/', '/conversations/1/../../settings', '/tasks?url=http://localhost']) assert.throws(() => h.validateLingxiPath(endpoint))
  await assert.rejects(h.requestLingxi('https://localhost', 'lx_test', { path: '/me' }), /内网|保留/)
  let received = 0
  const server = createServer((_req, res) => { received++; res.writeHead(302, { Location: 'http://127.0.0.1/private' }); res.end() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    await assert.rejects(h.requestLingxi(`http://127.0.0.1:${server.address().port}/lingxi`, 'lx_test', { path: '/me' }, { allowPrivate: true }), /重定向/)
    assert.equal(received, 1)
  } finally { server.close(); await once(server, 'close') }
})

test('Transport preserves entry prefix and bearer headers, bounds response bodies and translates upstream auth errors', async () => {
  let mode = 'good', seen
  const server = createServer(async (req, res) => {
    seen = { url: req.url, headers: req.headers }
    if (mode === 'large') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: 'x'.repeat(1000) })); return }
    if (mode === 'auth') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'lx_test rejected' })); return }
    if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>Sign in</html>'); return }
    if (mode === 'slow') return
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: user }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/lingxi`
  try {
    const response = await h.requestLingxi(base, 'lx_test', { path: '/me' }, { allowPrivate: true })
    assert.equal((await response.json()).data.id, 7)
    assert.equal(seen.url, '/lingxi/api/v1/me'); assert.equal(seen.headers.authorization, 'Bearer lx_test'); assert.equal(seen.headers.cookie, undefined)
    mode = 'large'; await assert.rejects(h.requestLingxi(base, 'lx_test', { path: '/me' }, { allowPrivate: true, maxBytes: 100 }), /过大/)
    mode = 'auth'; await assert.rejects(h.requestLingxi(base, 'lx_test', { path: '/me' }, { allowPrivate: true }), error => error.status === 403 && !error.message.includes('lx_test'))
    mode = 'html'; await assert.rejects(h.requestLingxi(base, 'lx_test', { path: '/me' }, { allowPrivate: true }), /JSON/)
    mode = 'slow'; await assert.rejects(h.requestLingxi(base, 'lx_test', { path: '/me' }, { allowPrivate: true, timeoutMs: 30 }), /超时/)
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close') }
})

test('Transport sends only the validated server grant hash in the fixed vault header', async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: [] }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/lingxi`
  try {
    for (const [path, method] of [['/integrations/navigation-vault/items', 'GET'], ['/integrations/navigation-vault/reveal', 'POST']]) {
      const response = await h.requestLingxi(base, 'lx_test', { path, method, vaultGrantHash: 'AB'.repeat(32), ...(method === 'POST' ? { body: { id: 'entry-uuid' } } : {}) }, { allowPrivate: true })
      await response.json()
      assert.equal(seen.at(-1).headers['x-navigation-vault-grant'], 'ab'.repeat(32))
      assert.ok(!seen.at(-1).url.includes('ab'.repeat(32)))
    }
    for (const vaultGrantHash of [undefined, '', '1'.repeat(63), 'g'.repeat(64), '1'.repeat(64) + '\r\nX-Injected: value']) {
      await assert.rejects(h.requestLingxi(base, 'lx_test', { path: '/integrations/navigation-vault/items', vaultGrantHash }, { allowPrivate: true }), /密码/)
    }
    await assert.rejects(h.requestLingxi(base, 'lx_test', { path: '/me', vaultGrantHash: '1'.repeat(64) }, { allowPrivate: true }), /校验/)
    assert.equal(seen.length, 2)
    await h.requestLingxi(base, 'lx_test', { path: '/me' }, { allowPrivate: true })
    assert.equal(seen.at(-1).headers['x-navigation-vault-grant'], undefined)
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close') }
})
