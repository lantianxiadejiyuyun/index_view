import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'

const requireServer = createRequire(new URL('../app/server/package.json', import.meta.url))
const { WebSocketServer } = requireServer('ws')
const agentPath = path.resolve('agent/node/index.mjs')
const code = await readFile(agentPath, 'utf8')
const workerCode = code.slice(code.indexOf('const SUBSCRIPTION_MAX_BYTES'), code.indexOf('// ── HTTP 服务'))
let instance = 0
async function worker(t, options = {}) {
  const text = `
    import http from 'node:http'; import https from 'node:https';
    import { lookup as subscriptionLookup } from 'node:dns/promises';
    import { BlockList, isIP } from 'node:net';
    import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
    const REPORT_TO=${JSON.stringify(options.server ?? '')};
    let AGENT_KEY=${JSON.stringify(options.key === null ? null : options.key ?? 'fixture-key')};
    const AGENT_ID='fixture-agent';
    let subscriptionApproved=${JSON.stringify(options.approved ?? true)};
    const process={env:{AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK:'true',NODE_TLS_REJECT_UNAUTHORIZED:${JSON.stringify(options.tlsReject)}}};
    ${workerCode}
    export {subscriptionTick,subscriptionWsUrl,stopSubscriptionWorker};
    export function state() { return {pending:subscriptionPending,queued:subscriptionQueued,busy:subscriptionBusy,approved:subscriptionApproved,connection:subscriptionConnection,reconnectAt:subscriptionReconnectAt,attempt:subscriptionReconnectAttempt} }
    export function setState(value) {
      if ('approved' in value) { if (value.approved) subscriptionApproved=true; else subscriptionInvalidateAuthorization() }
      if ('key' in value) AGENT_KEY=value.key;
      if ('reconnectAt' in value) subscriptionReconnectAt=value.reconnectAt;
      if ('attempt' in value) subscriptionReconnectAttempt=value.attempt;
      if (subscriptionPending && 'retryAt' in value) subscriptionPending.retry_at=value.retryAt;
    }
    // Fixture instance ${instance++}
  `
  const result = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
  t.after(() => result.stopSubscriptionWorker())
  return result
}

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
async function eventually(predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)) }
  throw new Error('Fixture did not reach expected state before deadline')
}
async function fixture(t, options = {}) {
  const state = { upgrades: 0, polls: 0, reports: 0, enrolls: 0, pulls: 0, frames: [], results: [], connections: [], resultStatus: options.resultStatus ?? 200, job: null, serverTime: null, pings: 0 }
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 8192 })
  const basePath = options.basePath ?? ''
  const key = options.key ?? 'fixture-key'
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/source')) {
      state.pulls++
      assert.equal(req.headers['x-agent-key'], undefined)
      assert.equal(req.headers['x-agent-token'], undefined)
      assert.equal(req.headers['user-agent'], 'clash.meta')
      setTimeout(() => {
        res.writeHead(200, { 'content-encoding': 'gzip', 'subscription-userinfo': 'upload=1; download=2; total=100; expire=2000000000' })
        res.end(gzipSync('proxies: []\n'))
      }, options.sourceDelay ?? 10).unref()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/enroll')) { state.enrolls++; res.writeHead(403); res.end('{}'); return }
    if (req.url.endsWith('/report')) {
      state.reports++
      assert.equal(req.headers['x-agent-key'], key)
      assert.ok(body.metrics.cpu_cores > 0)
      res.writeHead(options.pending ? 403 : 200); res.end('{}'); return
    }
    if (req.url.endsWith('/poll')) { state.polls++; res.writeHead(404); res.end('{}'); return }
    if (req.url === `${basePath}/api/agent/subscriptions/result`) {
      assert.equal(req.headers['x-agent-key'], key)
      state.results.push(body)
      res.writeHead(options.failFirstResult && state.results.length === 1 ? 503 : state.resultStatus)
      res.end(JSON.stringify({ ok: true, accepted: options.accepted ?? true })); return
    }
    res.writeHead(404); res.end('{}')
  })
  server.on('upgrade', (req, socket, head) => {
    state.upgrades++
    assert.equal(req.url, `${basePath}/api/agent/subscriptions/ws`)
    assert.equal(req.headers['x-agent-key'], undefined)
    assert.equal(req.headers.authorization, undefined)
    if (options.oldServer) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    if (options.redirect) { socket.end(`HTTP/1.1 302 Found\r\nLocation: ${options.redirect}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return }
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws))
  })
  wsServer.on('connection', (ws) => {
    state.connections.push(ws)
    let authenticated = false
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      state.frames.push(frame)
      if (!authenticated) {
        assert.equal(frame.type, 'auth')
        assert.equal(frame.key, key)
        assert.equal(frame.version, 1)
        assert.equal(typeof frame.agent_id, 'string')
        authenticated = true
        if (options.denyAuth) { ws.close(1008); return }
        if (options.noReady) return
        ws.send(JSON.stringify({ type: 'ready', version: 1, heartbeat_ms: 25_000, server_time: Date.now() }))
        if (options.autoJob) {
          state.job ??= { id: 'fixture-job', url: `${state.base}/source?token=private-secret`, expires_at: Date.now() + 90_000 }
          ws.send(JSON.stringify({ type: 'job', job: state.job, server_time: Date.now() }))
        }
      } else if (frame.type === 'ping') {
        state.pings++
        if (!options.noPong) ws.send(JSON.stringify({ type: 'pong', server_time: Date.now() }))
      } else {
        assert.equal(frame.type, 'ack')
        if (options.disconnectFirstAck && state.connections.length === 1) ws.terminate()
      }
    })
  })
  await listen(server)
  state.base = `http://127.0.0.1:${server.address().port}`
  state.server = state.base + basePath
  state.send = (job, serverTime = Date.now()) => state.connections.at(-1).send(JSON.stringify({ type: 'job', job, server_time: serverTime }))
  state.makeJob = (id, life = 90_000) => ({ id, url: `${state.base}/source?token=private-secret`, expires_at: Date.now() + life })
  t.after(async () => {
    for (const client of wsServer.clients) client.terminate()
    await new Promise((resolve) => wsServer.close(resolve))
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return state
}

async function connect(w, state) {
  await w.subscriptionTick()
  await eventually(() => w.state().connection?.ready)
  assert.equal(state.frames[0].type, 'auth')
}

test('agent WSS preserves configured base path and refuses credentials, fragments and query strings', async (t) => {
  const w = await worker(t)
  assert.equal(w.subscriptionWsUrl('https://example.com/gateway/'), 'wss://example.com/gateway/api/agent/subscriptions/ws')
  assert.equal(w.subscriptionWsUrl('http://127.0.0.1:1234'), 'ws://127.0.0.1:1234/api/agent/subscriptions/ws')
  for (const value of ['https://a:secret@example.com', 'https://example.com/#secret', 'https://example.com/?secret=1', 'wss://example.com']) assert.throws(() => w.subscriptionWsUrl(value))
  const insecure = await worker(t, { tlsReject: '0' })
  assert.throws(() => insecure.subscriptionWsUrl('https://example.com'), error => error.code === 'TLS_ERROR')
})

test('WSS task is acknowledged, fetched once and delivered over HTTPS-compatible result endpoint', async (t) => {
  const state = await fixture(t, { basePath: '/gateway' })
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  const job = state.makeJob('one')
  state.send(job)
  await eventually(() => state.results.length === 1)
  state.send(job)
  await eventually(() => state.frames.filter(f => f.type === 'ack').length === 2)
  assert.equal(state.pulls, 1)
  assert.equal(state.polls, 0)
  assert.equal(Buffer.from(state.results[0].content_base64, 'base64').toString(), 'proxies: []\n')
  assert.match(state.results[0].subscription_userinfo, /download=2/)
  assert.ok(state.frames.every(f => !('content_base64' in f) && !('subscription_userinfo' in f)))
})

test('WSS reconnect replays lease but never refetches; failed delivery retries saved bytes', async (t) => {
  const state = await fixture(t, { autoJob: true, sourceDelay: 100, resultStatus: 503 })
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  await eventually(() => state.results.length === 1)
  state.connections[0].terminate()
  await eventually(() => !w.state().connection)
  assert.ok(w.state().attempt >= 1)
  w.setState({ reconnectAt: 0 })
  await w.subscriptionTick()
  await eventually(() => state.frames.filter(f => f.type === 'ack').length === 2)
  assert.equal(state.pulls, 1)
  state.resultStatus = 200
  w.setState({ retryAt: 0 })
  await w.subscriptionTick()
  assert.deepEqual(state.results[1], state.results[0])
  assert.equal(state.pulls, 1)
})

test('WSS uses server clock for leases, rejects expired or excessive leases, keeps bounded pending results', async (t) => {
  const state = await fixture(t, { resultStatus: 503 })
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  const serverTime = Date.now() - 86_400_000
  state.send({ ...state.makeJob('clock-skew'), expires_at: serverTime + 90_000 }, serverTime)
  await eventually(() => state.results.length === 1 && !w.state().busy)
  for (let i = 0; i < 5; i++) { w.setState({ retryAt: 0 }); await w.subscriptionTick() }
  assert.equal(state.results.length, 4)
  assert.equal(w.state().pending, null)
  state.send(state.makeJob('expired', -1))
  await eventually(() => !w.state().connection)
  assert.equal(state.pulls, 1)
  w.setState({ reconnectAt: 0 }); await connect(w, state)
  state.send(state.makeJob('overlong', 600_000))
  await eventually(() => !w.state().connection)
  assert.equal(state.pulls, 1)
})

test('WSS holds one queued job during work and never acknowledges an overflowing job', async (t) => {
  const state = await fixture(t, { sourceDelay: 250 })
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  state.send(state.makeJob('active'))
  await eventually(() => state.pulls === 1)
  state.send(state.makeJob('queued'))
  await eventually(() => state.frames.some(f => f.job_id === 'queued'))
  state.send(state.makeJob('overflow'))
  await eventually(() => !w.state().connection)
  assert.equal(state.frames.some(f => f.job_id === 'overflow'), false)
  await eventually(() => state.results.length === 1 && !w.state().busy)
  await w.subscriptionTick()
  await eventually(() => state.results.length === 2)
  assert.deepEqual(state.results.map(r => r.job_id), ['active', 'queued'])
})

test('authorization loss cancels active source request and discards queued and pending results', async (t) => {
  const state = await fixture(t, { sourceDelay: 200 })
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  state.send(state.makeJob('active'))
  await eventually(() => state.pulls === 1)
  state.connections[0].close(1008)
  await eventually(() => !w.state().approved && !w.state().busy)
  assert.equal(state.results.length, 0)
  assert.equal(w.state().pending, null)
  assert.equal(w.state().queued, null)
  await w.subscriptionTick()
  assert.equal(state.upgrades, 1)
})

test('result endpoint auth denial revokes WSS, clears result and waits for fresh metrics approval', async (t) => {
  const state = await fixture(t, { resultStatus: 403 })
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  state.send(state.makeJob('result-denied'))
  await eventually(() => state.results.length === 1 && !w.state().busy)
  assert.equal(w.state().approved, false)
  assert.equal(w.state().pending, null)
  assert.equal(w.state().connection, null)
  await w.subscriptionTick()
  assert.equal(state.upgrades, 1)
})

test('shutdown cancels active fetch, closes socket, and cannot restart the worker', async (t) => {
  const state = await fixture(t, { sourceDelay: 200 })
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  state.send(state.makeJob('shutdown-active'))
  await eventually(() => state.pulls === 1)
  w.stopSubscriptionWorker()
  await eventually(() => !w.state().busy)
  await w.subscriptionTick()
  assert.equal(w.state().connection, null)
  assert.equal(state.results.length, 0)
  assert.equal(state.upgrades, 1)
})

test('changed dedicated key closes channel and stops old result delivery until metrics authentication succeeds', async (t) => {
  const state = await fixture(t, { resultStatus: 503 })
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  state.send(state.makeJob('key-change'))
  await eventually(() => state.results.length === 1)
  w.setState({ key: 'new-key', retryAt: 0 })
  await w.subscriptionTick()
  assert.equal(w.state().approved, false)
  assert.equal(w.state().connection, null)
  assert.equal(w.state().pending, null)
  assert.equal(state.results.length, 1)
})

test('WSS ping/pong updates liveness; stale connection reconnects and stable connection resets backoff', async (t) => {
  const state = await fixture(t)
  const w = await worker(t, { server: state.server })
  await connect(w, state)
  const connection = w.state().connection
  connection.lastPingAt = Date.now() - 26_000
  await w.subscriptionTick()
  await eventually(() => state.pings === 1)
  connection.lastReceivedAt = Date.now() - 51_000
  w.setState({ attempt: 20 })
  const beforeDisconnect = Date.now()
  await w.subscriptionTick()
  assert.equal(w.state().connection, null)
  assert.ok(w.state().reconnectAt - beforeDisconnect <= 30_100)
  w.setState({ reconnectAt: 0 }); await connect(w, state)
  w.state().connection.readyAt = Date.now() - 61_000
  await w.subscriptionTick()
  assert.equal(w.state().attempt, 0)
})

test('custom authorization close codes cancel task state', { concurrency: true }, async (t) => {
  await Promise.all([4401, 4403].map(code => t.test(String(code), async (t) => {
    const state = await fixture(t)
    const w = await worker(t, { server: state.server })
    await connect(w, state)
    state.connections[0].close(code)
    await eventually(() => !w.state().approved)
    assert.equal(w.state().connection, null)
  })))
})

test('WSS closes oversized, binary and unknown frames without exposing raw contents', async (t) => {
  for (const message of ['x'.repeat(8193), Buffer.from('{}'), JSON.stringify({ type: 'unexpected', secret: 'private-secret' })]) {
    await t.test(typeof message === 'string' ? String(message.length) : 'binary', async (t) => {
      const state = await fixture(t)
      const w = await worker(t, { server: state.server })
      await connect(w, state)
      state.connections[0].send(message)
      await eventually(() => !w.state().connection)
      assert.equal(state.results.length, 0)
    })
  }
})

test('Node native WebSocket does not follow HTTP 302 or send auth to its target', async (t) => {
  const target = await fixture(t)
  const source = await fixture(t, { redirect: target.server.replace(/^http/, 'ws') + '/api/agent/subscriptions/ws' })
  const w = await worker(t, { server: source.server })
  await w.subscriptionTick()
  await eventually(() => source.upgrades === 1 && !w.state().connection)
  assert.equal(target.upgrades, 0)
  assert.equal(target.frames.length, 0)
  assert.equal(source.frames.length, 0)
})

test('WSS handshake deadline closes a server that never acknowledges authentication', { timeout: 8000 }, async (t) => {
  const state = await fixture(t, { noReady: true })
  const w = await worker(t, { server: state.server })
  await w.subscriptionTick()
  await eventually(() => state.frames.length === 1)
  await eventually(() => !w.state().connection, 6000)
  assert.equal(state.results.length, 0)
})

async function childFixture(t, options = {}) {
  const state = await fixture(t, { ...options, key: 'child-fixture-key' })
  const directory = await mkdtemp(path.join(tmpdir(), 'hd-agent-ws-test-'))
  const keyPath = path.join(directory, 'agent-key')
  if (!options.noKey) await writeFile(keyPath, 'child-fixture-key')
  const reserve = createServer(); await listen(reserve)
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const preload = `const real=globalThis.fetch;const names=new Set(['myip.ipip.net','ip.3322.net','ifconfig.me','api.ipify.org']);globalThis.fetch=(url,opts)=>names.has(new URL(String(url)).hostname)?Promise.resolve(new Response('8.8.8.8')):real(url,opts)`
  const child = spawn(process.execPath, ['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`, agentPath], {
    env: { ...process.env, AGENT_TOKEN: 'child-shared-token', AGENT_KEY_FILE: keyPath, AGENT_SERVER: state.server, AGENT_INTERVAL: '5', HOST: '127.0.0.1', PORT: String(port), AGENT_DISK_MOUNTS: directory, AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  state.logs = ''
  child.stdout.on('data', chunk => { state.logs += chunk })
  child.stderr.on('data', chunk => { state.logs += chunk })
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('hd-agent-ws-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  await eventually(() => { if (child.exitCode !== null) throw new Error('Agent child exited before startup'); return state.logs.includes('监听') })
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/info`)).json()).version, '1.2.0')
  return state
}

test('real agent subprocess uses WSS jobs and HTTPS results without any HTTP polling', { timeout: 30_000, concurrency: true }, async (t) => {
  await Promise.all([
    t.test('disconnect during source fetch and result retry preserve bytes without repeated fetch', async (t) => {
      const state = await childFixture(t, { autoJob: true, sourceDelay: 5500, disconnectFirstAck: true, failFirstResult: true })
      await eventually(() => state.results.length === 2)
      assert.ok(state.connections.length >= 2)
      assert.ok(state.reports >= 3, 'source fetch and delivery retry must not block metrics')
      assert.equal(state.pulls, 1)
      assert.deepEqual(state.results[1], state.results[0])
      assert.equal(state.polls, 0)
      assert.equal(state.logs.includes('private-secret'), false)
      assert.equal(state.logs.includes('child-fixture-key'), false)
    }),
    t.test('unapproved metrics never open WSS', async (t) => {
      const state = await childFixture(t, { pending: true })
      await eventually(() => state.reports >= 2)
      assert.equal(state.upgrades, 0); assert.equal(state.polls, 0)
    }),
    t.test('missing dedicated key only enrolls', async (t) => {
      const state = await childFixture(t, { noKey: true })
      await eventually(() => state.enrolls >= 2)
      assert.equal(state.upgrades, 0); assert.equal(state.polls, 0)
    }),
    t.test('WSS authentication denial never fetches', async (t) => {
      const state = await childFixture(t, { denyAuth: true })
      await eventually(() => state.frames.some(frame => frame.type === 'auth') && state.reports >= 2)
      assert.equal(state.pulls, 0); assert.equal(state.polls, 0)
    }),
    t.test('old 404 server keeps metrics alive with no poll fallback or secret error logs', async (t) => {
      const state = await childFixture(t, { oldServer: true })
      await eventually(() => state.upgrades >= 2 && state.reports >= 2)
      assert.equal(state.polls, 0); assert.equal(state.results.length, 0)
      // Startup URLs include random ports (for example 54040); those digits
      // are not an upstream HTTP status leaking through the error logger.
      assert.equal(/(?:^|\D)404(?:\D|$)/.test(state.logs), false)
      assert.equal(state.logs.includes('child-fixture-key'), false)
    }),
  ])
})
