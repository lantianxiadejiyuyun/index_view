import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const root = fileURLToPath(new URL('../app/server/', import.meta.url))
const workspace = mkdtempSync(path.join(tmpdir(), 'hd-lingxi-ws-'))
const previousPrivate = process.env.LINGXI_ALLOW_PRIVATE_NETWORK
const clients = new Set(), upstreamSockets = new Set(), received = []
let h, server, upstream, wss, stop, url, wsUrl, upstreamUrl, token, sessionId, holdChat = false
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
before(async () => {
  process.env.LINGXI_ALLOW_PRIVATE_NETWORK = 'true'
  await build({
    stdin: { contents: `
      import { Hono } from 'hono'; import { serve } from '@hono/node-server';
      import { lingxiRoutes } from './src/routes/lingxi.ts';
      export { WebSocket, WebSocketServer } from 'ws';
      export { attachLingxiWebSocket, createLingxiWebSocketTicket } from './src/lib/lingxi-ws.ts';
      export { sealLingxiSecret } from './src/lib/lingxi-secrets.ts';
      export { sql, closeDb } from './src/lib/db.ts'; export { initDatabase } from './src/db/schema.ts';
      export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
      export function startFixture() { const app = new Hono(); app.route('/api', lingxiRoutes); return serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'}); }
    `, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: path.join(workspace, 'fixture.mjs'), banner: { js: SERVER_ESM_BANNER },
    plugins: [{ name: 'lingxi-ws-fixture', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', resolveDir: root, contents: `
        import { mkdirSync } from 'node:fs'; export const DB_FILE=${JSON.stringify(path.join(workspace, 'app.db'))};
        export const REFRESH_DAYS=30, PUBLIC_VIEW=false, ADMIN_USERNAME='lingxi-ws', ADMIN_PASSWORD='fixture-only';
        export const ENV_AGENT_TOKEN='fixture-agent', ENV_JWT_SECRET='fixture-root';
        export function ensureDirs(){mkdirSync(${JSON.stringify(workspace)},{recursive:true});}
      ` }))
    } }],
  })
  h = await import(pathToFileURL(path.join(workspace, 'fixture.mjs')).href)
  h.initDatabase()
})
beforeEach(async () => {
  h.sql.exec('DELETE FROM lingxi_bindings; DELETE FROM lingxi_vault_grants; DELETE FROM lingxi_vault_audit;')
  const session = h.createRefreshToken(1, 'ws-fixture', null); sessionId = session.sessionId
  token = await h.issueAccessToken({ id: 1, username: 'lingxi-ws' }, sessionId)
  received.length = 0; holdChat = false
  upstream = createServer((_req, res) => { res.writeHead(404); res.end() })
  wss = new h.WebSocketServer({ server: upstream, path: '/lingxi/api/v1/ws' })
  wss.on('connection', (socket, req) => {
    upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket))
    received.push({ url: req.url, cookie: req.headers.cookie })
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); received.push(frame)
      if (frame.type === 'auth') { assert.equal(frame.token, 'lx_ws_fixture'); socket.send(JSON.stringify({ type: 'ready', data: { user_id: 7, username: 'test', protocol: 'lingxi.v1' } })) }
      if (frame.type === 'chat.send' && !holdChat) {
        for (const [seq, type, data] of [[1, 'delta', '临时'], [2, 'done', '完整回复']]) socket.send(JSON.stringify({ seq, type, data, conversation_id: frame.conversation_id, request_id: frame.request_id }))
      }
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}/lingxi`
  h.sql.run('INSERT INTO lingxi_bindings (user_id,base_url,api_token_encrypted,user_json,updated_at) VALUES (1,?,?,?,?)', upstreamUrl, h.sealLingxiSecret(1, 'api-token', 'lx_ws_fixture'), JSON.stringify({ id: 7, username: 'test', timezone: 'UTC' }), Date.now())
  server = h.startFixture(); stop = h.attachLingxiWebSocket(server, { authTimeoutMs: 100, sweepMs: 20, idleMs: 10_000 })
  if (!server.listening) await once(server, 'listening')
  url = `http://127.0.0.1:${server.address().port}`; wsUrl = url.replace('http:', 'ws:') + '/api/lingxi/ws'
})
afterEach(async () => {
  await stop?.()
  for (const socket of clients) socket.terminate(); clients.clear()
  for (const socket of upstreamSockets) socket.terminate(); upstreamSockets.clear()
  wss?.close(); upstream?.closeAllConnections(); server?.closeAllConnections()
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  if (upstream?.listening) await new Promise(resolve => upstream.close(resolve))
})
after(() => {
  h?.closeDb()
  if (previousPrivate === undefined) delete process.env.LINGXI_ALLOW_PRIVATE_NETWORK; else process.env.LINGXI_ALLOW_PRIVATE_NETWORK = previousPrivate
  assert.equal(path.dirname(path.resolve(workspace)), path.resolve(tmpdir()))
  assert.ok(path.basename(workspace).startsWith('hd-lingxi-ws-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
async function ticket() {
  const response = await fetch(url + '/api/lingxi/ws-ticket', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200, await response.clone().text())
  const value = await response.json(); assert.equal(value.path, '/api/lingxi/ws'); assert.ok(value.expires_at <= Date.now() + 60_000)
  assert.ok(!JSON.stringify(value).includes('lx_ws_fixture'))
  return value.ticket
}
async function open(address = wsUrl, options = {}) {
  const socket = new h.WebSocket(address, options); clients.add(socket)
  const client = { socket, messages: [], code: null, closed: null }
  socket.on('message', raw => client.messages.push(JSON.parse(raw.toString())))
  socket.on('error', () => {})
  client.closed = new Promise(resolve => socket.once('close', (code, reason) => { client.code = code; resolve({ code, reason: reason.toString() }) }))
  await once(socket, 'open')
  return client
}
async function frame(client, type) {
  const started = Date.now()
  while (Date.now() - started < 2000) {
    const index = client.messages.findIndex(message => message.type === type)
    if (index >= 0) return client.messages.splice(index, 1)[0]
    if (client.code !== null) assert.fail(`closed ${client.code} before ${type}`)
    await delay(5)
  }
  assert.fail(`missing ${type}`)
}
async function connected() {
  const credential = await ticket(), client = await open()
  client.socket.send(JSON.stringify({ type: 'auth', ticket: credential }))
  await frame(client, 'ready'); return { client, credential }
}

test('WebSocket authenticates with a single-use ticket, hides binding Token and streams upstream events once', async () => {
  const { client, credential } = await connected()
  assert.equal(received[0].url, '/lingxi/api/v1/ws'); assert.equal(received[0].cookie, undefined)
  client.socket.send(JSON.stringify({ type: 'chat.send', conversation_id: 19, message: '你好', request_id: 'req1' }))
  assert.equal((await frame(client, 'delta')).data, '临时')
  assert.equal((await frame(client, 'done')).data, '完整回复')
  assert.equal(received.filter(value => value.type === 'chat.send').length, 1)
  assert.ok(!JSON.stringify(client.messages).includes('lx_ws_fixture'))
  const replay = await open(); replay.socket.send(JSON.stringify({ type: 'auth', ticket: credential }))
  assert.equal((await replay.closed).code, 1008)
})

test('WebSocket rejects unauthenticated, revoked, query-token and cross-origin connections', async () => {
  const idle = await open(); assert.equal((await idle.closed).code, 1008)
  const credential = await ticket()
  h.sql.run('UPDATE auth_sessions SET revoked_at=? WHERE id=?', Date.now(), sessionId)
  const revoked = await open(); revoked.socket.send(JSON.stringify({ type: 'auth', ticket: credential }))
  assert.equal((await revoked.closed).code, 1008)
  for (const [address, options] of [[wsUrl + '?ticket=not-allowed', {}], [wsUrl, { origin: 'https://foreign.example' }]]) {
    await assert.rejects(open(address, options), /400|403/)
  }
  assert.equal(received.length, 0)
})

test('Active WebSockets close both sides when session revoked or binding changes', async () => {
  const { client } = await connected()
  h.sql.run('UPDATE lingxi_bindings SET updated_at=updated_at+1 WHERE user_id=1')
  assert.equal((await client.closed).code, 1008)
  const started = Date.now()
  while (upstreamSockets.size && Date.now() - started < 1000) await delay(5)
  assert.equal(upstreamSockets.size, 0)
})

test('WebSocket blocks concurrent sends and propagates upstream closure without replay', async () => {
  holdChat = true
  const { client } = await connected()
  client.socket.send(JSON.stringify({ type: 'chat.send', conversation_id: 19, message: '第一条' }))
  client.socket.send(JSON.stringify({ type: 'chat.send', conversation_id: 19, message: '第二条' }))
  assert.match((await frame(client, 'error')).data, /等待/)
  assert.equal(received.filter(value => value.type === 'chat.send').length, 1)
  for (const socket of upstreamSockets) socket.close()
  assert.equal((await client.closed).code, 1011)
  assert.equal(received.filter(value => value.type === 'chat.send').length, 1)
})

test('Upstream validation error with seq zero releases the slot without requiring a done frame', async () => {
  holdChat = true
  const { client } = await connected()
  client.socket.send(JSON.stringify({ type: 'chat.send', conversation_id: 999, message: '不存在的会话' }))
  await delay(10)
  for (const socket of upstreamSockets) socket.send(JSON.stringify({ type: 'error', seq: 0, data: { code: 'not_found', error: '会话不存在' } }))
  assert.equal((await frame(client, 'error')).seq, 0)
  holdChat = false
  client.socket.send(JSON.stringify({ type: 'chat.send', conversation_id: 19, message: '正常会话' }))
  assert.equal((await frame(client, 'done')).data, '完整回复')
  assert.equal(received.filter(value => value.type === 'chat.send').length, 2)
})

test('Lingxi adapter ignores unrelated upgrade paths so agent relay and other sockets can coexist', async () => {
  let touched = false
  server.on('upgrade', (req, socket) => { if (req.url === '/other') { touched = true; socket.end('HTTP/1.1 418 Test\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } })
  await assert.rejects(open(wsUrl.replace('/api/lingxi/ws', '/other')), /418/)
  assert.equal(touched, true)
})
