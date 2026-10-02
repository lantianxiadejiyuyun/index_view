/** Smoke-test the shipped standalone server from an isolated deployment tree. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hd-server-bundle-'))
const deployed = path.join(fixture, 'app/server/dist/bundle.mjs')
await fs.mkdir(path.dirname(deployed), { recursive: true })
await fs.copyFile(path.join(root, 'app/server/dist/bundle.mjs'), deployed)
const reservation = net.createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const child = spawn(process.execPath, [deployed], {
  cwd: fixture, windowsHide: true,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(fixture, 'data'),
    NOTES_DIR: path.join(fixture, 'notes'), ADMIN_USERNAME: 'smoke-test', ADMIN_PASSWORD: 'test-only-password',
    JWT_SECRET: 'smoke-test-secret-not-a-production-credential', AGENT_TOKEN: 'smoke-test-only', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
const closed = once(child, 'close')
try {
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10_000)
    const read = (chunk) => {
      output += chunk.toString()
      if (output.includes(`127.0.0.1:${port}`)) { clearTimeout(deadline); resolve() }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('error', (err) => { clearTimeout(deadline); reject(err) })
    child.once('exit', (code) => { clearTimeout(deadline); reject(new Error(`Server exited ${code}: ${output}`)) })
  })
  const response = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).service, 'home-dashboard')
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-test', password: 'test-only-password' }),
  })
  assert.equal(login.status, 200)
  const { access_token: token } = await login.json()
  const subscriptions = await fetch(`http://127.0.0.1:${port}/api/subscriptions`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(subscriptions.status, 200)
  assert.deepEqual((await subscriptions.json()).sources, [])
  const imported = await fetch(`http://127.0.0.1:${port}/api/subscriptions/rules/import`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: "rules:\n  - 'DOMAIN-SUFFIX,example.com,Fixture Group'\n  - 'MATCH,Fixture Group'" }),
  })
  assert.equal(imported.status, 200)
  assert.equal(imported.headers.get('cache-control'), 'no-store')
  const analysis = await imported.json()
  assert.equal(analysis.can_apply, true)
  assert.deepEqual(analysis.rules, ['DOMAIN-SUFFIX,example.com,PROXY', 'MATCH,PROXY'])
  assert.deepEqual(analysis.policies, [{ name: 'Fixture Group', target: 'PROXY', count: 2 }])
  const sourceResponse = await fetch(`http://127.0.0.1:${port}/api/subscriptions/sources`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fixture source', url: 'https://source.example.invalid/feed', enabled: false }),
  })
  assert.equal(sourceResponse.status, 201)
  const { source } = await sourceResponse.json()
  const profileResponse = await fetch(`http://127.0.0.1:${port}/api/subscriptions/profiles`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Imported fixture', source_ids: [source.id], rules: { prepend_source: true, rules: analysis.rules } }),
  })
  assert.equal(profileResponse.status, 201)
  const { profile } = await profileResponse.json()
  assert.equal(profile.rules.prepend_source, true)
  assert.equal(profile.rules.append_source, false)
  assert.deepEqual(profile.rules.rules, analysis.rules)
  const secondLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mobile bundle fixture' },
    body: JSON.stringify({ username: 'smoke-test', password: 'test-only-password' }),
  })
  assert.equal(secondLogin.status, 200)
  const secondToken = (await secondLogin.json()).access_token
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/sessions`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(sessionResponse.headers.get('cache-control'), 'no-store')
  const { sessions } = await sessionResponse.json()
  assert.equal(sessions.length, 2)
  assert.equal(sessions.filter((session) => session.current).length, 1)
  const removed = await fetch(`http://127.0.0.1:${port}/api/auth/sessions/${sessions.find((session) => !session.current).id}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(removed.status, 200)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { authorization: `Bearer ${secondToken}` } })).status, 401)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200)
  console.log('PASS: standalone server starts without node_modules, migrates SQLite, and serves authenticated subscriptions')
  console.log('PASS: standalone rule import maps source groups and persists source-name prefix settings')
  console.log('PASS: independent device sessions and immediate single-device revocation')
} finally {
  child.kill()
  await closed
}
