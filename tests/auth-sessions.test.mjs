import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const serverRoot = fileURLToPath(new URL('../app/server/', import.meta.url))
const workspace = mkdtempSync(path.join(tmpdir(), 'hd-auth-sessions-'))
const dbFile = path.join(workspace, 'app.db')
const secret = 'fixture-only-session-jwt-secret'
const password = 'fixture-session-password'
const legacyRaw = 'fixture-v12-live-refresh-token'
const legacyRevokedRaw = 'fixture-v12-revoked-refresh-token'
let h
let userCounter = 0

async function bundle(name, legacy = false) {
  const output = path.join(workspace, name + '.mjs')
  await build({
    stdin: { contents: `
      export { authRoutes } from './src/routes/auth.ts';
      export { sql, closeDb } from './src/lib/db.ts';
      export { initDatabase } from './src/db/schema.ts';
      export * from './src/lib/tokens.ts';
      export { hashPassword, sha256 } from './src/lib/password.ts';
      export { sign } from 'hono/jwt';
    `, resolveDir: serverRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: output,
    banner: { js: SERVER_ESM_BANNER },
    plugins: [{ name: 'isolated-auth', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'auth-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'auth-fixture' }, () => ({ contents: `
        export const DB_FILE = ${JSON.stringify(dbFile)};
        export const REFRESH_DAYS = 30;
        export const ADMIN_USERNAME = 'legacy-fixture';
        export const ADMIN_PASSWORD = ${JSON.stringify(password)};
        export const ENV_AGENT_TOKEN = 'fixture-agent';
        export const ENV_JWT_SECRET = ${JSON.stringify(secret)};
        export function ensureDirs() {}
      `, loader: 'js' }))
      if (legacy) builder.onLoad({ filter: /[\\/]db[\\/]schema\.ts$/ }, ({ path: source }) => ({
        contents: readFileSync(source, 'utf8').replace('m.version > current', 'm.version > current && m.version <= 12')
          .replace('(SELECT COUNT(*) FROM categories) + (SELECT COUNT(*) FROM folders)', '(SELECT COUNT(*) FROM categories)'), loader: 'ts',
      }))
    } }],
  })
  return import(pathToFileURL(output).href)
}

before(async () => {
  const old = await bundle('legacy', true)
  old.initDatabase()
  assert.equal(old.sql.get('PRAGMA user_version').user_version, 12)
  for (const [raw, revoked] of [[legacyRaw, null], [legacyRevokedRaw, Date.now() - 1000]]) {
    old.sql.run('INSERT INTO refresh_tokens (user_id,token_hash,ua,ip,expires_at,revoked_at,created_at) VALUES (1,?,?,?,?,?,?)',
      old.sha256(raw), 'Legacy Chrome/100 Windows', '192.0.2.10', Date.now() + 86400_000, revoked, Date.now() - 120_000)
  }
  old.closeDb()
  h = await bundle('current')
  h.initDatabase()
})
after(() => {
  h?.closeDb()
  assert.equal(path.dirname(workspace), path.resolve(tmpdir()))
  assert.ok(path.basename(workspace).startsWith('hd-auth-sessions-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
})

function account() {
  const username = 'fixture-' + ++userCounter
  const id = h.sql.run('INSERT INTO users (username,password_hash,created_at,updated_at) VALUES (?,?,?,?)', username, h.hashPassword(password), Date.now(), Date.now()).lastInsertRowid
  return { id, username }
}
function request(route, { method = 'GET', token, cookie, body, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0', ip = '192.0.2.11' } = {}) {
  return h.authRoutes.request(route, { method, headers: {
    ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: 'hd_rt=' + cookie } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': ua, 'x-forwarded-for': ip,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}
function rawCookie(response) { return /hd_rt=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1] }
function payload(token) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')) }
async function login(user, options = {}) {
  const response = await request('/login', { method: 'POST', body: { username: user.username, password }, ...options })
  assert.equal(response.status, 200, await response.clone().text())
  const body = await response.json()
  return { token: body.access_token, cookie: rawCookie(response), id: payload(body.access_token).sid, body, response }
}
async function me(device, expected = 200) {
  const response = await request('/me', { token: device.token })
  assert.equal(response.status, expected)
  return response.json()
}
async function refresh(cookie) { return request('/refresh', { method: 'POST', cookie }) }
function ageToken(cookie, age = 61_000) { h.sql.run('UPDATE refresh_tokens SET created_at = ? WHERE token_hash = ?', Date.now() - age, h.sha256(cookie)) }


test('v12 migration preserves live cookies, upgrades to sid, and rejects legacy access and revoked cookies', async () => {
  assert.equal(h.sql.get('PRAGMA user_version').user_version, 14)
  const token = await h.sign({ sub: 1, username: 'legacy-fixture', exp: Math.floor(Date.now() / 1000) + 3600 }, secret, 'HS256')
  assert.equal((await request('/me', { token })).status, 401)
  const response = await refresh(legacyRaw)
  assert.equal(response.status, 200)
  const body = await response.json()
  const sid = payload(body.access_token).sid
  assert.match(sid, /^[a-f0-9]{32}$/)
  assert.deepEqual(body.user, { id: 1, username: 'legacy-fixture' })
  assert.equal((await refresh(legacyRevokedRaw)).status, 401)
  await me({ token: body.access_token })
  const session = h.sql.get('SELECT * FROM auth_sessions WHERE id = ?', sid)
  assert.equal(session.ua, 'Legacy Chrome/100 Windows')
  assert.equal(session.created_at < Date.now() - 60_000, true)
})

test('independent devices list bounded metadata, keep stable session IDs across refresh, and never store raw tokens', async () => {
  const user = account()
  const a = await login(user)
  const b = await login(user, { ua: 'Mozilla/5.0 (iPhone) Version/18 Safari/605', ip: '192.0.2.12' })
  assert.notEqual(a.id, b.id)
  await me(a); await me(b)
  const response = await request('/sessions', { token: a.token })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const { sessions } = await response.json()
  assert.equal(sessions.length, 2)
  assert.equal(sessions.filter((s) => s.current).length, 1)
  assert.equal(sessions.find((s) => s.current).id, a.id)
  assert.equal(sessions.find((s) => s.id === b.id).device, 'Safari · iOS')
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['id', 'device', 'ua', 'ip', 'created_at', 'last_seen_at', 'expires_at', 'current'].sort())
  ageToken(a.cookie)
  const renewed = await refresh(a.cookie)
  assert.equal(renewed.status, 200)
  assert.equal(payload((await renewed.json()).access_token).sid, a.id)
  await me(b)
  const records = JSON.stringify(h.sql.all('SELECT * FROM refresh_tokens WHERE user_id = ?', user.id))
  assert.equal(records.includes(a.cookie), false)
  assert.equal(records.includes(rawCookie(renewed)), false)
})

test('simultaneous tabs reuse recent token and deterministically return the same rotated successor', async () => {
  const a = await login(account())
  const recent = await Promise.all(Array.from({ length: 4 }, () => refresh(a.cookie)))
  for (const response of recent) { assert.equal(response.status, 200); assert.equal(rawCookie(response), a.cookie) }
  ageToken(a.cookie)
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => refresh(a.cookie)))
  const successor = rawCookie(concurrent[0])
  assert.notEqual(successor, a.cookie)
  for (const response of concurrent) {
    assert.equal(response.status, 200)
    assert.equal(rawCookie(response), successor)
    assert.equal(payload((await response.json()).access_token).sid, a.id)
  }
  assert.equal(rawCookie(await refresh(successor)), successor)
  assert.equal(h.sql.get('SELECT COUNT(*) AS n FROM refresh_tokens WHERE session_id = ?', a.id).n, 2)
  await me(a)
})

test('late replay revokes only its device, including already issued access tokens', async () => {
  const user = account()
  const a = await login(user)
  const b = await login(user)
  ageToken(a.cookie)
  const response = await refresh(a.cookie)
  const successor = rawCookie(response)
  const access = (await response.json()).access_token
  h.sql.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?', Date.now() - 31_000, h.sha256(a.cookie))
  const replay = await refresh(a.cookie)
  assert.equal(replay.status, 401)
  assert.equal((await replay.json()).reason, 'replay')
  await me(a, 401); await me({ token: access }, 401)
  assert.equal((await refresh(successor)).status, 401)
  await me(b)
  assert.equal((await refresh(b.cookie)).status, 200)
})

test('cookie logout and access-only logout immediately invalidate only the current session', async () => {
  const user = account()
  const a = await login(user)
  const b = await login(user)
  assert.equal((await request('/logout', { method: 'POST', cookie: a.cookie })).status, 200)
  await me(a, 401); await me(b)
  assert.equal((await refresh(a.cookie)).status, 401)
  assert.equal((await request('/logout', { method: 'POST', token: b.token })).status, 200)
  await me(b, 401)
  assert.equal((await refresh(b.cookie)).status, 401)
})

test('remove one device and revoke others are user-scoped and preserve the requesting device', async () => {
  const user = account()
  const a = await login(user)
  const b = await login(user)
  const c = await login(user)
  const foreign = await login(account())
  assert.equal((await request('/sessions/' + foreign.id, { method: 'DELETE', token: a.token })).status, 404)
  const removed = await request('/sessions/' + b.id, { method: 'DELETE', token: a.token })
  assert.deepEqual(await removed.json(), { ok: true, current: false })
  await me(b, 401)
  assert.equal((await refresh(b.cookie)).status, 401)
  await me(a); await me(c); await me(foreign)
  const others = await request('/sessions/revoke-others', { method: 'POST', token: a.token })
  assert.deepEqual(await others.json(), { ok: true, revoked: 1 })
  await me(c, 401); await me(a); await me(foreign)
  assert.deepEqual(await (await request('/sessions/' + a.id, { method: 'DELETE', token: a.token })).json(), { ok: true, current: true })
  await me(a, 401)
})

test('password change invalidates all user access and refresh sessions but no other account', async () => {
  const user = account()
  const a = await login(user)
  const b = await login(user)
  const foreign = await login(account())
  const response = await request('/password', { method: 'POST', token: a.token, body: { current_password: password, new_password: 'changed-fixture-password' } })
  assert.equal(response.status, 200)
  await me(a, 401); await me(b, 401); await me(foreign)
  assert.equal((await refresh(a.cookie)).status, 401)
  assert.equal((await refresh(b.cookie)).status, 401)
  assert.equal((await request('/login', { method: 'POST', body: { username: user.username, password: 'changed-fixture-password' } })).status, 200)
})

test('repeat login replaces its cookie session without ghost entries or disturbing other devices', async () => {
  const user = account()
  const a = await login(user)
  const b = await login(user)
  const replacement = await login(user, { cookie: a.cookie })
  await me(a, 401); await me(b); await me(replacement)
  const { sessions } = await (await request('/sessions', { token: replacement.token })).json()
  assert.equal(sessions.length, 2)
  const bearerReplacement = await login(user, { token: replacement.token })
  await me(replacement, 401); await me(bearerReplacement); await me(b)
  const foreign = await login(account())
  await login(user, { cookie: foreign.cookie, token: foreign.token })
  await me(foreign)
})

test('authentication rejects expired, wrong-user and missing sessions and suppresses all response caching', async () => {
  const user = account()
  const a = await login(user)
  const foreign = await login(account())
  const wrongOwner = await h.sign({ sub: user.id, sid: foreign.id, exp: Math.floor(Date.now() / 1000) + 3600 }, secret, 'HS256')
  assert.equal((await request('/me', { token: wrongOwner })).status, 401)
  h.sql.run('UPDATE auth_sessions SET expires_at = ? WHERE id = ?', Date.now() - 1, a.id)
  await me(a, 401)
  assert.equal((await refresh(a.cookie)).status, 401)
  for (const [route, method] of [['/sessions', 'GET'], ['/sessions/invalid', 'DELETE'], ['/sessions/revoke-others', 'POST'], ['/refresh', 'POST'], ['/login', 'POST']]) {
    const response = await request(route, { method })
    assert.ok(response.status >= 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('device metadata is bounded and token hashes for a still-active family survive pruning', async () => {
  const user = account()
  const a = await login(user, { ua: 'X'.repeat(1500), ip: '9'.repeat(400) })
  const row = h.sql.get('SELECT * FROM auth_sessions WHERE id = ?', a.id)
  assert.equal(row.ua.length, 512)
  assert.equal(row.ip.length, 128)
  ageToken(a.cookie)
  assert.equal((await refresh(a.cookie)).status, 200)
  h.sql.run('UPDATE refresh_tokens SET revoked_at = ?, expires_at = ? WHERE token_hash = ?', Date.now() - 9 * 86400_000, Date.now() - 1, h.sha256(a.cookie))
  h.pruneRefreshTokens()
  assert.ok(h.sql.get('SELECT 1 FROM refresh_tokens WHERE token_hash = ?', h.sha256(a.cookie)))
  assert.equal((await refresh(a.cookie)).status, 401)
  await me(a, 401)
})

test('explicit extension login is access-only, labelled, short-lived and independent of browser cookies', async () => {
  const user = account()
  const web = await login(user)
  const extension = await login(user, {
    cookie: web.cookie, token: web.token,
    body: { username: user.username, password, client: 'extension' },
  })
  assert.equal(extension.response.headers.get('set-cookie'), null)
  assert.equal(extension.cookie, undefined)
  assert.equal(h.sql.get('SELECT COUNT(*) AS n FROM refresh_tokens WHERE session_id = ?', extension.id).n, 0)
  const row = h.sql.get('SELECT * FROM auth_sessions WHERE id = ?', extension.id)
  assert.equal(row.client, 'extension')
  assert.equal(row.expires_at - row.created_at, h.ACCESS_TTL_SEC * 1000)
  await me(web); await me(extension)
  const { sessions } = await (await request('/sessions', { token: web.token })).json()
  assert.equal(sessions.find((s) => s.id === extension.id).device, 'Chrome 扩展')
  assert.equal(sessions.length, 2)
  h.sql.run('UPDATE auth_sessions SET expires_at = ? WHERE id = ?', Date.now() - 1, extension.id)
  await me(extension, 401)
  await me(web)
})

test('extension re-login replaces only its prior extension session and logout never clears the web cookie', async () => {
  const user = account()
  const web = await login(user)
  const body = { username: user.username, password, client: 'extension' }
  const first = await login(user, { body })
  const replacement = await login(user, { body, token: first.token, cookie: web.cookie })
  assert.equal(replacement.response.headers.get('set-cookie'), null)
  await me(first, 401); await me(web); await me(replacement)
  const response = await request('/logout', { method: 'POST', token: replacement.token, cookie: web.cookie })
  assert.equal(response.headers.get('set-cookie'), null)
  await me(replacement, 401); await me(web)
  assert.equal((await refresh(web.cookie)).status, 200)
  const final = await login(user, { body })
  const deleted = await request('/sessions/' + final.id, { method: 'DELETE', token: final.token, cookie: web.cookie })
  assert.deepEqual(await deleted.json(), { ok: true, current: true })
  assert.equal(deleted.headers.get('set-cookie'), null)
  await me(final, 401); await me(web)
})

test('a password change during async previous-token verification prevents stale-password login', async () => {
  const user = account()
  const a = await login(user)
  const originalVerify = globalThis.crypto.subtle.verify
  let changed = false
  globalThis.crypto.subtle.verify = async function (...args) {
    const verified = await originalVerify.apply(this, args)
    if (!changed) {
      changed = true
      h.updatePasswordAndRevokeSessions(user.id, h.hashPassword('changed-during-login'))
    }
    return verified
  }
  try {
    const response = await request('/login', { method: 'POST', token: a.token, body: { username: user.username, password } })
    assert.equal(changed, true)
    assert.equal(response.status, 401)
    assert.equal(h.sql.get('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL', user.id).n, 0)
  } finally {
    globalThis.crypto.subtle.verify = originalVerify
  }
})

test('password update and revocation roll back together when a write fails', async () => {
  const user = account()
  const a = await login(user)
  const originalHash = h.sql.get('SELECT password_hash FROM users WHERE id = ?', user.id).password_hash
  h.sql.exec("CREATE TEMP TRIGGER fail_session_revoke BEFORE UPDATE OF revoked_at ON auth_sessions BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END")
  try {
    assert.throws(() => h.updatePasswordAndRevokeSessions(user.id, h.hashPassword('rollback-fixture-password')), /fixture write failure/)
  } finally {
    h.sql.exec('DROP TRIGGER fail_session_revoke')
  }
  assert.equal(h.sql.get('SELECT password_hash FROM users WHERE id = ?', user.id).password_hash, originalHash)
  await me(a)
  assert.equal((await refresh(a.cookie)).status, 200)
})
