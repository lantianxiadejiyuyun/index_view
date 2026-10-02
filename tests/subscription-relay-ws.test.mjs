import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const root = fileURLToPath(new URL('../app/server/', import.meta.url))
const tempRoot = path.resolve(tmpdir())
const workspace = mkdtempSync(path.join(tempRoot, 'hd-relay-ws-'))
const bundle = path.join(workspace, 'fixture.mjs')
const hash = (key) => createHash('sha256').update(key).digest('hex')
const encoded = Buffer.from(JSON.stringify({ proxies: [{ name: 'WSS fixture', type: 'ss', server: 'proxy.example.test', port: 443, cipher: 'aes-128-gcm', password: 'fixture-password' }] })).toString('base64')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const defaults = { authTimeoutMs: 120, ackTimeoutMs: 250, idleTimeoutMs: 3_000, sweepMs: 15, maxUnauthenticated: 2 }
let h, server, stop, url, wsUrl, token, node, second
const clients = new Set()

before(async () => {
  await build({
    stdin: { contents: `
      import { Hono } from 'hono'; import { serve } from '@hono/node-server';
      import { subscriptionRoutes } from './src/routes/subscriptions.ts';
      export { WebSocket } from 'ws';
      export * from './src/lib/subscriptions.ts'; export * from './src/lib/subscription-relay.ts';
      export { attachSubscriptionRelayWebSocket } from './src/lib/subscription-relay-ws.ts';
      export { sql, closeDb } from './src/lib/db.ts'; export { initDatabase } from './src/db/schema.ts';
      export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
      export function startFixture() {
        const app = new Hono(); app.route('/api', subscriptionRoutes);
        return serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
      }
    `, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundle,
    banner: { js: SERVER_ESM_BANNER },
    plugins: [{ name: 'isolated-relay-sockets', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'fixture' }))
      builder.onResolve({ filter: /\/subscription-fetch\.js$/ }, () => ({ path: 'fetch', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ loader: 'js', resolveDir: root, contents: name === 'config' ? `
        import { mkdirSync } from 'node:fs'; export const DB_FILE = ${JSON.stringify(path.join(workspace, 'fixture.db'))};
        export const REFRESH_DAYS = 30, ADMIN_USERNAME = 'ws-fixture', ADMIN_PASSWORD = 'fixture-only-password';
        export const ENV_AGENT_TOKEN = 'fixture-shared-enrollment', ENV_JWT_SECRET = 'fixture-ws-jwt';
        export function ensureDirs() { mkdirSync(${JSON.stringify(workspace)}, { recursive: true }); }
      ` : `
        export { validateSubscriptionUrl } from ${JSON.stringify(path.join(root, 'src/lib/subscription-fetch.ts'))};
        export async function fetchSubscription() { throw new Error('DIRECT_FETCH_MUST_NOT_RUN'); }
      ` }))
    } }],
  })
  h = await import(pathToFileURL(bundle).href)
  h.initDatabase()
  const session = h.createRefreshToken(1, 'fixture', null)
  token = await h.issueAccessToken({ id: 1, username: 'ws-fixture' }, session.sessionId)
})
beforeEach(async () => {
  h.sql.run('DELETE FROM subscription_profiles')
  h.sql.run('DELETE FROM subscription_sources')
  h.sql.run('DELETE FROM agent_nodes')
  node = makeNode('one')
  second = makeNode('two')
  server = h.startFixture()
  stop = h.attachSubscriptionRelayWebSocket(server, defaults)
  if (!server.listening) await once(server, 'listening')
  url = `http://127.0.0.1:${server.address().port}`
  wsUrl = url.replace('http:', 'ws:') + '/api/agent/subscriptions/ws'
})
afterEach(async () => {
  await stop?.()
  for (const client of clients) client.socket.terminate()
  clients.clear()
  server?.closeAllConnections()
  if (server?.listening) await new Promise((resolve) => server.close(resolve))
})
after(() => {
  h?.closeDb()
  assert.equal(path.dirname(path.resolve(workspace)), tempRoot)
  assert.ok(path.basename(workspace).startsWith('hd-relay-ws-'))
  rmSync(workspace, { recursive: true, force: true })
})
function makeNode(name, fields = {}) {
  const key = `fixture-${name}-dedicated-key`
  const agent_id = `fixture-${name}`
  const inserted = h.sql.run(`INSERT INTO agent_nodes (name, base_url, agent_id, agent_key_hash, enabled, approved, last_seen_at, relay_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, name, `push://${agent_id}`, agent_id, hash(key), fields.enabled ?? 1, fields.approved ?? 1, Date.now(), Date.now(), Date.now())
  return { id: inserted.lastInsertRowid, agent_id, key }
}
async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  return fetch(url + '/api/subscriptions' + route, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function source(target = node, name = 'Source') {
  const response = await request('/sources', { name, url: `https://source.example.test/${name}?token=fixture-only`, fetch_agent_id: target.id })
  assert.equal(response.status, 201, await response.clone().text())
  return (await response.json()).source
}
async function refresh(id) {
  const response = await request(`/sources/${id}/refresh`, {})
  assert.equal(response.status, 200)
  return (await response.json()).source
}
async function postResult(job, target = node) {
  const response = await fetch(url + '/api/agent/subscriptions/result', { method: 'POST',
    headers: { 'X-Agent-Key': target.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: target.agent_id, job_id: job.id, content_base64: encoded, subscription_userinfo: 'upload=1; download=2; total=100' }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
async function openClient({ address = wsUrl, options } = {}) {
  const socket = new h.WebSocket(address, options)
  const client = { socket, messages: [], history: [], errors: [], closed: null, code: null }
  clients.add(client)
  socket.on('error', (error) => { client.errors.push(error) })
  socket.on('message', (value) => {
    const frame = JSON.parse(value.toString())
    client.messages.push(frame)
    client.history.push(frame)
  })
  client.closed = new Promise((resolve) => socket.once('close', (code, reason) => { client.code = code; resolve({ code, reason: reason.toString() }) }))
  await once(socket, 'open')
  return client
}
async function frame(client, type, timeout = 2_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const index = client.messages.findIndex((value) => value.type === type)
    if (index !== -1) return client.messages.splice(index, 1)[0]
    if (client.code !== null) assert.fail(`socket closed ${client.code} while waiting for ${type}`)
    await delay(5)
  }
  assert.fail(`no ${type} frame received`)
}
async function authorized(target = node) {
  const client = await openClient()
  client.socket.send(JSON.stringify({ type: 'auth', version: 1, agent_id: target.agent_id, key: target.key }))
  const ready = await frame(client, 'ready')
  assert.equal(ready.version, 1)
  assert.equal(ready.heartbeat_ms, 25_000)
  assert.ok(Math.abs(ready.server_time - Date.now()) < 2_000)
  return client
}
function ack(client, job) { client.socket.send(JSON.stringify({ type: 'ack', job_id: job.id })) }
async function rejectedUpgrade(address, options) {
  return new Promise((resolve, reject) => {
    const socket = new h.WebSocket(address, options)
    socket.on('error', () => {})
    socket.on('open', () => { socket.terminate(); reject(new Error('upgrade unexpectedly succeeded')) })
    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode
      response.resume()
      socket.terminate()
      resolve(status)
    })
  })
}
async function resetOptions(options) {
  await stop()
  stop = h.attachSubscriptionRelayWebSocket(server, { ...defaults, ...options })
}

test('WSS requires bounded first-frame dedicated-key authentication before revealing tasks', async () => {
  const created = await source()
  await refresh(created.id)
  const idle = await openClient()
  assert.equal((await idle.closed).code, 1008)
  assert.deepEqual(idle.history, [])
  for (const body of [
    { type: 'ping' }, { type: 'auth', version: 2, agent_id: node.agent_id, key: node.key },
    { type: 'auth', version: 1, agent_id: node.agent_id, key: second.key },
    { type: 'auth', version: 1, agent_id: node.agent_id, key: 'fixture-shared-enrollment' },
  ]) {
    const client = await openClient()
    client.socket.send(JSON.stringify(body))
    assert.equal((await client.closed).code, 1008)
    assert.equal(client.history.some((item) => item.type === 'job'), false)
  }
  const allowed = await authorized()
  const delivered = await frame(allowed, 'job')
  assert.equal(delivered.job.url, created.url)
  ack(allowed, delivered.job)
})

test('query credentials and browser-origin upgrades are rejected; unauthenticated socket count is bounded', async () => {
  assert.equal(await rejectedUpgrade(wsUrl + '?key=fixture-only'), 404)
  assert.equal(await rejectedUpgrade(wsUrl, { origin: 'https://untrusted.example.test' }), 403)
  await resetOptions({ authTimeoutMs: 1_000 })
  const one = await openClient()
  const two = await openClient()
  assert.equal(await rejectedUpgrade(wsUrl), 429)
  one.socket.send(JSON.stringify({ type: 'auth', version: 1, agent_id: node.agent_id, key: node.key }))
  await frame(one, 'ready')
  const third = await openClient()
  third.socket.terminate()
  two.socket.terminate()
})

test('binary and oversized frames are rejected without credentials or data in close reasons', async () => {
  const binary = await openClient()
  binary.socket.send(Buffer.from('secret-frame'))
  assert.equal((await binary.closed).code, 1002)
  const oversized = await openClient()
  oversized.socket.send('x'.repeat(8193))
  const closed = await oversized.closed
  assert.equal(closed.code, 1009)
  assert.equal(closed.reason.includes('secret'), false)
})

test('new queues immediately dispatch only to their selected probe and ACK does not complete a job', async () => {
  const firstClient = await authorized()
  const secondClient = await authorized(second)
  const firstSource = await source(node, 'first')
  const secondSource = await source(second, 'second')
  await refresh(firstSource.id)
  const firstJob = (await frame(firstClient, 'job')).job
  assert.equal(firstJob.url, firstSource.url)
  ack(firstClient, firstJob)
  await delay(45)
  assert.equal(secondClient.history.some((message) => message.type === 'job'), false)
  assert.equal(h.sql.get('SELECT proxy_count FROM subscription_sources WHERE id = ?', firstSource.id).proxy_count, 0)
  assert.equal(h.sql.get('SELECT state FROM subscription_fetch_jobs WHERE id = ?', firstJob.id).state, 'leased')
  await refresh(secondSource.id)
  const secondJob = (await frame(secondClient, 'job')).job
  ack(secondClient, secondJob)
  assert.equal(secondJob.url, secondSource.url)
  await delay(50)
  assert.equal(firstClient.history.filter((message) => message.type === 'job').length, 1)
  assert.equal(secondClient.history.filter((message) => message.type === 'job').length, 1)
  assert.equal((await postResult(firstJob, second)).accepted, false)
  assert.equal((await postResult(firstJob)).accepted, true)
  assert.equal((await postResult(secondJob, second)).accepted, true)
})

test('HTTPS results commit parsed cache and wake the next queued task without another poll', async () => {
  const client = await authorized()
  const first = await source(node, 'one')
  const next = await source(node, 'two')
  await refresh(first.id)
  const one = (await frame(client, 'job')).job
  ack(client, one)
  await refresh(next.id)
  await delay(35)
  assert.equal(client.history.filter((message) => message.type === 'job').length, 1)
  assert.deepEqual(await postResult(one), { ok: true, accepted: true })
  const two = (await frame(client, 'job')).job
  ack(client, two)
  assert.equal(two.url, next.url)
  assert.equal(h.sql.get('SELECT proxy_count FROM subscription_sources WHERE id = ?', first.id).proxy_count, 1)
  assert.deepEqual(await postResult(one), { ok: true, accepted: false })
  assert.equal((await postResult(two)).accepted, true)
})

test('reconnection replays the same uncompleted lease and deadline exactly once per connection', async () => {
  const first = await authorized()
  await refresh((await source()).id)
  const original = (await frame(first, 'job')).job
  ack(first, original)
  first.socket.terminate()
  await first.closed
  const replacement = await authorized()
  const replay = (await frame(replacement, 'job')).job
  assert.deepEqual(replay, original)
  ack(replacement, replay)
  await delay(50)
  assert.equal(replacement.history.filter((message) => message.type === 'job').length, 1)
  assert.equal((await postResult(replay)).accepted, true)
})

test('new connection replaces only that probe connection and legacy poll cannot double-lease', async () => {
  const first = await authorized()
  const unrelated = await authorized(second)
  await refresh((await source()).id)
  const job = (await frame(first, 'job')).job
  ack(first, job)
  const next = await authorized()
  assert.equal((await first.closed).code, 1012)
  const replay = (await frame(next, 'job')).job
  ack(next, replay)
  assert.equal(replay.id, job.id)
  const polled = h.pollSubscriptionRelay({ agent_id: node.agent_id, version: 1 }, node.key)
  assert.equal(polled.job, null)
  assert.equal(unrelated.code, null)
  assert.equal(h.listSubscriptionRelayNodes().find((item) => item.id === node.id).relay_transport, 'wss')
})

test('missing ACK disconnects for replay while ACK alone never removes the durable lease', async () => {
  await resetOptions({ ackTimeoutMs: 60 })
  const client = await authorized()
  await refresh((await source()).id)
  const job = (await frame(client, 'job')).job
  assert.equal((await client.closed).code, 1011)
  assert.equal(h.sql.get('SELECT state FROM subscription_fetch_jobs WHERE id = ?', job.id).state, 'leased')
  const again = await authorized()
  const replay = (await frame(again, 'job')).job
  ack(again, replay)
  assert.equal(replay.id, job.id)
  await delay(90)
  assert.equal(again.code, null)
})

test('active sockets are disconnected after approval revoke, disable or key reset', async () => {
  for (const field of ['approved', 'enabled', 'agent_key_hash']) {
    const client = await authorized()
    h.sql.run(`UPDATE agent_nodes SET ${field} = ? WHERE id = ?`, field === 'agent_key_hash' ? null : 0, node.id)
    assert.equal((await client.closed).code, 1008)
    const metadata = h.listSubscriptionRelayNodes().find((item) => item.id === node.id)
    assert.equal(metadata.relay_connected, false)
    assert.equal(metadata.relay_transport, null)
    h.sql.run(`UPDATE agent_nodes SET ${field} = ? WHERE id = ?`, field === 'agent_key_hash' ? hash(node.key) : 1, node.id)
  }
})

test('heartbeats return current server time and disconnected WSS is not reported connected', async () => {
  await resetOptions({ idleTimeoutMs: 110 })
  const client = await authorized()
  assert.equal(h.listSubscriptionRelayNodes().find((item) => item.id === node.id).relay_connected, true)
  client.socket.send(JSON.stringify({ type: 'ping' }))
  const pong = await frame(client, 'pong')
  assert.ok(Math.abs(pong.server_time - Date.now()) < 1_000)
  assert.equal((await client.closed).code, 1001)
  const metadata = h.listSubscriptionRelayNodes().find((item) => item.id === node.id)
  assert.equal(metadata.relay_connected, false)
  assert.equal(metadata.relay_transport, null)
  assert.equal(metadata.online, true, 'recent node heartbeat and current task connection are distinct')
  h.pollSubscriptionRelay({ agent_id: node.agent_id, version: 1 }, node.key)
  assert.equal(h.listSubscriptionRelayNodes().find((item) => item.id === node.id).relay_transport, 'https-poll')
})

test('expired leased task cannot update cache and does not prevent the next task dispatch', async () => {
  const client = await authorized()
  const first = await source(node, 'expire')
  const next = await source(node, 'next')
  await refresh(first.id)
  const expired = (await frame(client, 'job')).job
  ack(client, expired)
  await refresh(next.id)
  h.sql.run('UPDATE subscription_fetch_jobs SET expires_at = 1 WHERE id = ?', expired.id)
  await h.runSubscriptionSchedulerTick()
  const valid = (await frame(client, 'job')).job
  ack(client, valid)
  assert.equal(valid.url, next.url)
  assert.equal((await postResult(expired)).accepted, false)
  assert.equal(h.sql.get('SELECT proxy_count FROM subscription_sources WHERE id = ?', first.id).proxy_count, 0)
  assert.equal((await postResult(valid)).accepted, true)
})

test('source edits cancel old results before a replacement URL is dispatched', async () => {
  const client = await authorized()
  const created = await source()
  await refresh(created.id)
  const old = (await frame(client, 'job')).job
  ack(client, old)
  const update = await request(`/sources/${created.id}`, { url: 'https://replacement.example.test/' }, 'PUT')
  assert.equal(update.status, 200)
  await refresh(created.id)
  const next = (await frame(client, 'job')).job
  ack(client, next)
  assert.equal(next.url, 'https://replacement.example.test/')
  assert.notEqual(next.id, old.id)
  assert.equal((await postResult(old)).accepted, false)
  assert.equal(h.sql.get('SELECT proxy_count FROM subscription_sources WHERE id = ?', created.id).proxy_count, 0)
  assert.equal((await postResult(next)).accepted, true)
})

test('shutdown closes all socket sessions before returning without discarding leased jobs', async () => {
  const client = await authorized()
  await refresh((await source()).id)
  const job = (await frame(client, 'job')).job
  ack(client, job)
  await stop()
  assert.equal((await client.closed).code, 1001)
  assert.equal(h.listSubscriptionRelayNodes().find((item) => item.id === node.id).relay_connected, false)
  assert.equal(h.sql.get('SELECT id FROM subscription_fetch_jobs WHERE id = ?', job.id).id, job.id)
})
