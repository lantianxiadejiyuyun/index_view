/** Run the shipped server bundle and unmodified single-file agent together. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hd-agent-wss-e2e-'))
const bundle = path.join(fixture, 'app/server/dist/bundle.mjs')
await fs.mkdir(path.dirname(bundle), { recursive: true })
await fs.copyFile(path.join(root, 'app/server/dist/bundle.mjs'), bundle)
const reserve = async () => {
  const listener = net.createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
const serverPort = await reserve(), agentPort = await reserve()
const base = `http://127.0.0.1:${serverPort}`
let hits = 0, serverLogs = '', agentLogs = '', server, agent, token
const children = new Set()
const upstream = http.createServer((_req, res) => {
  hits++
  res.setHeader('content-type', 'application/yaml')
  res.setHeader('subscription-userinfo', 'upload=10; download=20; total=100; expire=2000000000')
  res.end('proxies:\n  - name: E2E fixture\n    type: ss\n    server: example.test\n    port: 443\n    cipher: aes-128-gcm\n    password: test-only\n')
}).listen(0, '127.0.0.1')
await once(upstream, 'listening')
async function eventually(fn, label, timeout = 25_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
function child(entry, env, append) {
  const proc = spawn(process.execPath, [entry], { cwd: fixture, windowsHide: true,
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(proc, 'close')
  proc.stdout.on('data', chunk => append(chunk.toString()))
  proc.stderr.on('data', chunk => append(chunk.toString()))
  proc.closed = closed
  children.add(proc)
  return proc
}
async function stop(proc) {
  if (!proc) return
  if (proc.exitCode === null && proc.signalCode === null) proc.kill()
  await Promise.race([proc.closed, new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Child did not shut down')), 12_000).unref()
  })])
  children.delete(proc)
}
async function startServer() {
  server = child(bundle, { HOST: '127.0.0.1', PORT: String(serverPort), NODE_ENV: 'production',
    DATA_DIR: path.join(fixture, 'data'), NOTES_DIR: path.join(fixture, 'notes'),
    ADMIN_USERNAME: 'wss-e2e', ADMIN_PASSWORD: 'test-only-password',
    AGENT_TOKEN: 'test-only-shared-token', JWT_SECRET: 'test-only-wss-secret',
    SUBSCRIPTIONS_ALLOW_PRIVATE_NETWORK: 'true' }, chunk => { serverLogs += chunk })
  await eventually(async () => {
    if (server.exitCode !== null) throw new Error('Server exited before ready')
    try { return (await fetch(`${base}/api/health`)).ok } catch { return false }
  }, 'server health')
}
async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert.ok(response.ok, `Fixture API ${method} ${route}: ${response.status}`)
  return response.json()
}
try {
  await startServer()
  token = (await request('/api/auth/login', { username: 'wss-e2e', password: 'test-only-password' })).access_token
  agent = child(path.join(root, 'agent/node/index.mjs'), {
    HOST: '127.0.0.1', PORT: String(agentPort), AGENT_NAME: 'WSS E2E probe', AGENT_INTERVAL: '5',
    AGENT_SERVER: base, AGENT_TOKEN: 'test-only-shared-token', AGENT_KEY_FILE: path.join(fixture, 'agent-key'),
    AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK: 'true', AGENT_DISK_MOUNTS: fixture,
  }, chunk => { agentLogs += chunk })
  let node
  await eventually(async () => {
    node = (await request('/api/nodes')).nodes.find(n => n.name === 'WSS E2E probe')
    return Boolean(node)
  }, 'agent enrollment')
  await request(`/api/nodes/${node.id}`, { approved: true }, 'PUT')
  const connected = async () => (await request('/api/subscriptions')).relay_nodes.some(n => n.id === node.id && n.relay_transport === 'wss' && n.relay_connected)
  await eventually(connected, 'authenticated WSS readiness')
  assert.equal((await (await fetch(`http://127.0.0.1:${agentPort}/api/info`)).json()).version, '1.2.0')
  const source = (await request('/api/subscriptions/sources', { name: 'WSS E2E source', enabled: false,
    url: `http://127.0.0.1:${upstream.address().port}/subscription?test-only=1`, fetch_agent_id: node.id })).source
  const refresh = async () => {
    const result = await request(`/api/subscriptions/sources/${source.id}/refresh`, {})
    assert.ok(result.source.fetching)
    let current
    await eventually(async () => {
      current = (await request('/api/subscriptions')).sources.find(s => s.id === source.id)
      return current && !current.fetching
    }, 'WS dispatch and HTTP result')
    assert.equal(current.last_error, null)
    assert.equal(current.proxy_count, 1)
    assert.deepEqual(current.usage, { upload: 10, download: 20, total: 100, expires_at: 2_000_000_000_000 })
  }
  await refresh()
  assert.equal(hits, 1)
  console.log('PASS: shipped bundle + real agent: enrollment, WSS assignment, HTTP result, parsed cache and usage')
  await stop(server)
  await startServer()
  await eventually(connected, 'WSS reconnect after server restart', 40_000)
  await refresh()
  assert.equal(hits, 2)
  assert.equal(serverLogs.includes('POST /api/agent/subscriptions/poll'), false, '1.2 agent must not poll for tasks')
  assert.equal(agentLogs.includes('subscription?test-only=1'), false, 'Source URL must not appear in logs')
  assert.equal(agentLogs.includes('test-only-password'), false)
  console.log('PASS: same probe reconnects after server restart; new task completes without HTTPS polling')
} finally {
  for (const proc of [...children]) await stop(proc)
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  // Only this run\'s known, generated fixture may be removed.
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(fixture).startsWith('hd-agent-wss-e2e-'))
  await fs.rm(fixture, { recursive: true, force: true })
}
