import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(path.join(tmpdir(), 'hd-lingxi-vault-'))
const previousPublicUrl = process.env.NAVIGATION_PUBLIC_URL
let h, token, otherToken
const item = (id = 'one', password = 'fixture-password-only') => ({ id, title: 'Fixture', url: 'https://example.test/', username: 'fixture-user', password, notes: 'fixture-note', createdAt: 1, updatedAt: 2 })
before(async () => {
  delete process.env.NAVIGATION_PUBLIC_URL
  await build({ stdin: { contents: `
    export { lingxiVaultRoutes } from './src/routes/lingxi-vault.ts';
    export * from './src/lib/lingxi-vault.ts';
    export { sealLingxiSecret, openLingxiSecret } from './src/lib/lingxi-secrets.ts';
    export { sql, closeDb } from './src/lib/db.ts';
    export { initDatabase } from './src/db/schema.ts';
    export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
    export { calls, mockControl } from './src/lib/lingxi-transport.js';
  `, resolveDir: fileURLToPath(new URL('../app/server/', import.meta.url)), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: path.join(root, 'harness.mjs'),
    plugins: [{ name: 'isolated-lingxi-vault', setup(b) {
      b.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'fixture' }))
      b.onLoad({ filter: /^config$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        import {mkdirSync} from 'node:fs';
        export const DB_FILE=${JSON.stringify(path.join(root, 'db.sqlite'))};
        export const REFRESH_DAYS=30, ADMIN_USERNAME='fixture', ADMIN_PASSWORD='fixture-password', ENV_AGENT_TOKEN='fixture-agent', ENV_JWT_SECRET=undefined;
        export function ensureDirs(){mkdirSync(${JSON.stringify(root)}, {recursive:true})}
      ` }))
      b.onResolve({ filter: /\/lingxi-transport\.js$/ }, () => ({ path: 'transport', namespace: 'fixture' }))
      b.onLoad({ filter: /^transport$/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        export const calls=[], mockControl={fail:false};
        export async function requestLingxi(base, token, request){calls.push({base,token,request});if(mockControl.fail) throw new Error('fixture echoed ' + request.body.read_token);return Response.json({ok:true})}
      ` }))
    } }],
  })
  h = await import(pathToFileURL(path.join(root, 'harness.mjs')).href)
  h.initDatabase()
  h.sql.run("INSERT INTO users (id,username,password_hash,created_at,updated_at) VALUES (2,'another-fixture','unused',1,1)")
  token = await h.issueAccessToken({ id: 1, username: 'fixture' }, h.createRefreshToken(1, 'fixture', null).sessionId)
  otherToken = await h.issueAccessToken({ id: 2, username: 'another-fixture' }, h.createRefreshToken(2, 'fixture', null).sessionId)
})
beforeEach(() => {
  delete process.env.NAVIGATION_PUBLIC_URL
  h.calls.length = 0
  h.mockControl.fail = false
  h.sql.run('DELETE FROM lingxi_vault_grants'); h.sql.run('DELETE FROM lingxi_vault_audit')
  h.sql.run('DELETE FROM lingxi_bindings'); h.sql.run('DELETE FROM vaults')
  for (const id of [1, 2]) {
    h.sql.run('INSERT INTO lingxi_bindings (user_id,base_url,api_token_encrypted,user_json,updated_at) VALUES (?,?,?,?,?)', id, 'https://lingxi.example.test', h.sealLingxiSecret(id, 'api-token', 'upstream-fixture-token'), JSON.stringify({ id }), 1)
    h.sql.run('INSERT INTO vaults (user_id,version,blob,created_at) VALUES (?,1,?,1)', id, 'opaque-original-envelope')
  }
})
after(async () => {
  await h?.stopLingxiVaultRefreshScheduler()
  h?.closeDb()
  if (previousPublicUrl === undefined) delete process.env.NAVIGATION_PUBLIC_URL
  else process.env.NAVIGATION_PUBLIC_URL = previousPublicUrl
  assert.equal(path.dirname(root), path.resolve(tmpdir()))
  assert.ok(path.basename(root).startsWith('hd-lingxi-vault-'))
  rmSync(root, { recursive: true, force: true })
})
function request(pathname, { method = 'GET', body, auth = token } = {}) {
  return h.lingxiVaultRoutes.request('/lingxi/vault/' + pathname, { method,
    headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function grant(auth = token, items = [item()]) {
  const settings = await (await request('settings', { method: 'PUT', body: { enabled: true }, auth })).json()
  const response = await request('snapshot', { method: 'POST', auth, body: {
    grant_id: settings.grant_id, consent: true, base_version: 0, source_version: 1, items,
  } })
  assert.equal(response.status, 200)
  return response.json()
}
test('default off, mandatory binding, no-store and private settings', async () => {
  const response = await request('settings')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const settings = await response.json()
  assert.equal(settings.enabled, false); assert.equal(settings.status, 'disabled')
  assert.equal((await request('settings', { auth: 'invalid' })).status, 401)
  h.sql.run('DELETE FROM lingxi_bindings WHERE user_id=1')
  assert.equal((await request('settings', { method: 'PUT', body: { enabled: true } })).status, 409)
  assert.equal(JSON.stringify(settings).includes('fixture-password'), false)
})
test('backend enabled alone does not authorize snapshot upload', async () => {
  const { grant_id } = await (await request('settings', { method: 'PUT', body: { enabled: true } })).json()
  const body = { grant_id, base_version: 0, source_version: 1, items: [item()] }
  assert.equal((await request('snapshot', { method: 'POST', body })).status, 403)
  assert.equal(h.readLingxiVaultGrant(1).snapshot_encrypted, null)
  assert.throws(() => h.issueLingxiVaultServiceToken(1), /尚未就绪/)
})
test('authorized copy decrypts in backend and original ciphertext stays unchanged', async () => {
  const saved = await grant()
  assert.equal(saved.status, 'ready'); assert.equal(saved.item_count, 1)
  const row = h.readLingxiVaultGrant(1)
  assert.ok(!row.snapshot_encrypted.includes('fixture-password-only'))
  assert.deepEqual(h.decryptLingxiVaultSnapshot(row), [item()])
  assert.equal(h.sql.get('SELECT blob FROM vaults WHERE user_id=1').blob, 'opaque-original-envelope')
  assert.throws(() => h.openLingxiSecret(2, 'vault-snapshot', row.snapshot_encrypted))
  const { token: service } = h.issueLingxiVaultServiceToken(1)
  const response = await request('service/read', { method: 'POST', auth: service, body: {} })
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await response.json()).items, [item()])
  const audit = h.sql.all('SELECT * FROM lingxi_vault_audit')
  assert.ok(audit.some(entry => entry.action === 'read'))
  assert.ok(!JSON.stringify(audit).includes('fixture-password-only'))
})
test('service tokens are scope-limited, isolated and support exact item selection', async () => {
  await grant(token, [item('one'), item('two')]); await grant(otherToken, [item('other', 'different-secret')])
  const first = h.issueLingxiVaultServiceToken(1), second = h.issueLingxiVaultServiceToken(2)
  assert.equal((await request('service/read', { method: 'POST', body: {}, auth: token })).status, 401)
  assert.equal((await request('settings', { auth: first.token })).status, 401)
  const selected = await (await request('service/read', { method: 'POST', auth: first.token, body: { ids: ['two', 'other'] } })).json()
  assert.deepEqual(selected.items.map(entry => entry.id), ['two'])
  const other = await (await request('service/read', { method: 'POST', auth: second.token, body: {} })).json()
  assert.deepEqual(other.items, [item('other', 'different-secret')])
})
test('close switch destroys copy, invalidates tokens and requires new extension consent', async () => {
  const old = await grant(); const service = h.issueLingxiVaultServiceToken(1)
  assert.equal((await request('settings', { method: 'PUT', body: { enabled: false } })).status, 200)
  const row = h.readLingxiVaultGrant(1)
  assert.equal(row.snapshot_encrypted, null); assert.equal(row.service_token_hash, null); assert.equal(row.authorized_at, null)
  assert.equal((await request('service/read', { method: 'POST', auth: service.token, body: {} })).status, 401)
  const next = await (await request('settings', { method: 'PUT', body: { enabled: true } })).json()
  assert.notEqual(next.grant_id, old.grant_id)
  assert.equal((await request('snapshot', { method: 'POST', body: { grant_id: old.grant_id, consent: true, base_version: 0, source_version: 1, items: [item()] } })).status, 409)
  assert.equal((await request('snapshot', { method: 'POST', body: { grant_id: next.grant_id, base_version: 0, source_version: 1, items: [item()] } })).status, 403)
})
test('stale vault versions and malformed snapshots cannot replace the current copy', async () => {
  const saved = await grant(), service = h.issueLingxiVaultServiceToken(1)
  const body = { grant_id: saved.grant_id, base_version: 1, source_version: 1, items: [item()] }
  for (const override of [{ base_version: 0 }, { source_version: 2 }]) {
    assert.equal((await request('snapshot', { method: 'POST', body: { ...body, ...override } })).status, 409)
  }
  for (const items of [null, [item(), item()], [{ ...item(), password: 42 }], [{ ...item(), updatedAt: -1 }]]) {
    assert.equal((await request('snapshot', { method: 'POST', body: { ...body, items } })).status, 400)
  }
  h.sql.run('UPDATE vaults SET version=2 WHERE user_id=1')
  assert.equal((await request('service/read', { method: 'POST', auth: service.token, body: {} })).status, 409)
  assert.equal((await (await request('settings')).json()).stale, true)
  assert.equal((await request('snapshot', { method: 'POST', body: { ...body, source_version: 2 } })).status, 200)
  assert.equal((await request('service/read', { method: 'POST', auth: service.token, body: {} })).status, 200)
})
test('token expiry, rotation and missing binding fail closed', async () => {
  await grant(); const old = h.issueLingxiVaultServiceToken(1), current = h.issueLingxiVaultServiceToken(1)
  assert.equal((await request('service/read', { method: 'POST', auth: old.token, body: {} })).status, 401)
  h.sql.run('UPDATE lingxi_vault_grants SET service_token_expires_at=1 WHERE user_id=1')
  assert.equal((await request('service/read', { method: 'POST', auth: current.token, body: {} })).status, 401)
  const renewed = h.issueLingxiVaultServiceToken(1)
  h.sql.run('DELETE FROM lingxi_bindings WHERE user_id=1')
  assert.equal((await request('service/read', { method: 'POST', auth: renewed.token, body: {} })).status, 401)
})
test('revocation while a request body is arriving prevents decryption', async () => {
  await grant(); const service = h.issueLingxiVaultServiceToken(1)
  let finish
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{'))
    finish = () => { controller.enqueue(new TextEncoder().encode('}')); controller.close() }
  } })
  const pending = h.lingxiVaultRoutes.request(new Request('http://fixture/lingxi/vault/service/read', {
    method: 'POST', headers: { Authorization: 'Bearer ' + service.token, 'Content-Type': 'application/json' }, body, duplex: 'half',
  }))
  await new Promise(resolve => setTimeout(resolve, 10))
  h.revokeLingxiVault(1, 'disabled'); finish()
  const response = await pending
  assert.equal(response.status, 401)
  assert.equal(h.sql.get("SELECT COUNT(*) AS count FROM lingxi_vault_audit WHERE action='read'").count, 0)
})
test('callback registration uses configured public origin and never exposes tokens in settings', async () => {
  process.env.NAVIGATION_PUBLIC_URL = 'https://navigation.example.test'
  await grant()
  assert.equal(h.calls.length, 1)
  const call = h.calls[0]
  assert.equal(call.request.method, 'PUT')
  assert.equal(call.request.path, '/integrations/navigation-vault')
  assert.equal(call.request.body.read_url, 'https://navigation.example.test/api/lingxi/vault/service/read')
  assert.equal(call.request.body.scope, 'all')
  assert.equal(call.token, 'upstream-fixture-token')
  const settings = await (await request('settings')).json()
  assert.equal(settings.service_connected, true)
  assert.ok(!JSON.stringify(settings).includes(call.request.body.read_token))
})

test('callback registration failures expose no secrets and can be retried', async () => {
  process.env.NAVIGATION_PUBLIC_URL = 'https://navigation.example.test'
  h.mockControl.fail = true
  const saved = await grant()
  assert.equal(saved.status, 'ready'); assert.equal(saved.service_connected, false)
  assert.equal(h.readLingxiVaultGrant(1).service_token_hash, null)
  assert.ok(!JSON.stringify(saved).includes(h.calls[0].request.body.read_token))
  assert.ok(saved.audit.some(entry => entry.action === 'callback_failed'))
  h.mockControl.fail = false
  assert.equal(await h.registerLingxiVaultCallback(1), true)
  assert.equal(h.getLingxiVaultSettings(1).service_connected, true)
})

test('corrupt encrypted copies fail closed without returning decryption details', async () => {
  await grant(); const service = h.issueLingxiVaultServiceToken(1)
  h.sql.run("UPDATE lingxi_vault_grants SET snapshot_encrypted='corrupt' WHERE user_id=1")
  const response = await request('service/read', { method: 'POST', auth: service.token, body: {} })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'decrypt_failed')
})

test('scheduler renews expiring tokens and can stop before database shutdown', async () => {
  process.env.NAVIGATION_PUBLIC_URL = 'https://navigation.example.test'
  await grant()
  const first = h.calls[0].request.body.read_token
  h.sql.run('UPDATE lingxi_vault_grants SET service_token_expires_at=? WHERE user_id=1', Date.now() + 30_000)
  const stop = h.startLingxiVaultRefreshScheduler()
  for (let attempts = 0; attempts < 20 && h.calls.length < 2; attempts++) await new Promise(resolve => setTimeout(resolve, 5))
  await stop()
  assert.equal(h.calls.length, 2)
  assert.notEqual(h.calls[1].request.body.read_token, first)
  assert.ok(h.readLingxiVaultGrant(1).service_token_expires_at > Date.now() + 23 * 60 * 60_000)
  assert.equal((await request('service/read', { method: 'POST', auth: first, body: {} })).status, 401)
})
