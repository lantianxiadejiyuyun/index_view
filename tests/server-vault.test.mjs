import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'

const serverRoot = fileURLToPath(new URL('../app/server/', import.meta.url))
const tempRoot = path.resolve(tmpdir())
const workspace = mkdtempSync(path.join(tempRoot, 'hd-vault-test-'))
const databaseDir = path.join(workspace, 'data')
const bundleFile = path.join(workspace, 'routes.mjs')
const workerFile = path.join(workspace, 'writer.mjs')
let harness
let token

// The real config module can read .env and user data. Replace it at bundle time,
// before imports execute, so every DB connection is confined to this fixture.
before(async () => {
  await build({
    stdin: {
      contents: `
        export { vaultRoutes } from './src/routes/vault.ts';
        export { sql, closeDb } from './src/lib/db.ts';
        export { initDatabase } from './src/db/schema.ts';
        export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
      `,
      resolveDir: serverRoot,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundleFile,
    plugins: [{
      name: 'isolated-vault-config',
      setup(builder) {
        builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'vault-test' }))
        builder.onLoad({ filter: /.*/, namespace: 'vault-test' }, () => ({
          contents: `
            import { mkdirSync } from 'node:fs';
            export const DB_FILE = ${JSON.stringify(path.join(databaseDir, 'app.db'))};
            export const REFRESH_DAYS = 30;
            export const ADMIN_USERNAME = 'vault-test';
            export const ADMIN_PASSWORD = 'test-only-password';
            export const ENV_AGENT_TOKEN = 'test-only-agent-token';
            export const ENV_JWT_SECRET = undefined;
            export function ensureDirs() { mkdirSync(${JSON.stringify(databaseDir)}, { recursive: true }); }
          `,
          loader: 'js',
        }))
      },
    }],
  })
  harness = await import(pathToFileURL(bundleFile).href)
  harness.initDatabase()
  const session = harness.createRefreshToken(1, 'fixture', null)
  token = await harness.issueAccessToken({ id: 1, username: 'vault-test' }, session.sessionId)

  writeFileSync(workerFile, `
    const { vaultRoutes, closeDb } = await import(${JSON.stringify(pathToFileURL(bundleFile).href)});
    process.once('message', async ({ token, body }) => {
      try {
        const response = await vaultRoutes.request('/vault', {
          method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        process.send({ status: response.status, data: await response.json() });
      } finally { closeDb(); process.disconnect(); }
    });
    process.send({ ready: true });
  `)
})

beforeEach(() => harness.sql.run('DELETE FROM vaults'))

after(() => {
  harness?.closeDb()
  assert.equal(path.dirname(path.resolve(workspace)), tempRoot)
  assert.ok(path.basename(workspace).startsWith('hd-vault-test-'))
  rmSync(workspace, { recursive: true, force: true })
})

function envelope(overrides = {}) {
  return {
    v: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: Buffer.alloc(16, 1).toString('base64') },
    verifier: { iv: Buffer.alloc(12, 2).toString('base64'), data: Buffer.alloc(32, 3).toString('base64') },
    payload: { iv: Buffer.alloc(12, 4).toString('base64'), data: Buffer.alloc(32, 5).toString('base64') },
    updatedAt: 1,
    ...overrides,
  }
}

function put(body, auth = token) {
  return harness.vaultRoutes.request('/vault', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function get(auth = token) {
  return harness.vaultRoutes.request('/vault', { headers: { Authorization: `Bearer ${auth}` } })
}

test('vault responses are authenticated, isolated by account, and never cached', async () => {
  const unauthorized = await get('invalid')
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store')
  const empty = await get()
  assert.equal(empty.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await empty.json(), { version: 0, blob: null, updated_at: null })

  const blob = JSON.stringify(envelope())
  assert.equal((await put({ base_version: 0, blob })).status, 200)
  const saved = await get()
  assert.equal((await saved.json()).blob, blob)
  harness.sql.run("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (2, 'another-user', 'unused', 1, 1)")
  const otherSession = harness.createRefreshToken(2, 'fixture', null)
  const otherToken = await harness.issueAccessToken({ id: 2, username: 'another-user' }, otherSession.sessionId)
  assert.deepEqual(await (await get(otherToken)).json(), { version: 0, blob: null, updated_at: null })
})

test('base_version must be a present non-negative safe integer before any write', async () => {
  const blob = JSON.stringify(envelope())
  for (const base_version of [undefined, null, '0', true, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await put({ base_version, blob })
    assert.equal(response.status, 400, `accepted ${String(base_version)}`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal((await (await get()).json()).version, 0)
  assert.equal((await put({ base_version: 0, blob })).status, 200)
  assert.equal((await put({ blob })).status, 400)
  assert.equal((await (await get()).json()).version, 1)
})

test('creation requires version zero and stale updates preserve the current ciphertext', async () => {
  const blob = JSON.stringify(envelope())
  const missingConflict = await put({ base_version: 2, blob })
  assert.equal(missingConflict.status, 409)
  assert.equal((await missingConflict.json()).version, 0)
  const created = await put({ base_version: 0, blob })
  assert.equal((await created.json()).version, 1)

  const newer = JSON.stringify(envelope({ updatedAt: 2 }))
  const updated = await put({ base_version: 1, blob: newer })
  assert.equal((await updated.json()).version, 2)
  for (const base_version of [0, 1, 3]) {
    const conflict = await put({ base_version, blob })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.headers.get('cache-control'), 'no-store')
    const data = await conflict.json()
    assert.equal(data.version, 2)
    assert.equal(data.blob, newer)
  }
  assert.equal((await (await get()).json()).blob, newer)
})

test('the blob limit measures UTF-8 bytes instead of JavaScript characters', async () => {
  const oversized = JSON.stringify(envelope({ extra: '汉'.repeat(360_000) }))
  assert.ok(oversized.length < 1024 * 1024)
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 1024 * 1024)
  assert.equal((await put({ base_version: 0, blob: oversized })).status, 413)
  assert.equal((await (await get()).json()).version, 0)

  const prefix = envelope({ extra: '' })
  const padding = 1024 * 1024 - Buffer.byteLength(JSON.stringify(prefix), 'utf8')
  const atLimit = JSON.stringify({ ...prefix, extra: 'a'.repeat(padding) })
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 1024 * 1024)
  assert.equal((await put({ base_version: 0, blob: atLimit })).status, 200)
})

test('malformed encryption envelopes and unsupported KDF parameters cannot replace a vault', async () => {
  const blob = JSON.stringify(envelope())
  assert.equal((await put({ base_version: 0, blob })).status, 200)
  const badEnvelopes = [
    null, [], { payload: true }, envelope({ v: 2 }),
    envelope({ verifier: null }), envelope({ payload: { iv: '%%%%', data: 'AAAA' } }),
    envelope({ payload: { iv: Buffer.alloc(11).toString('base64'), data: Buffer.alloc(32).toString('base64') } }),
    envelope({ payload: { iv: Buffer.alloc(12).toString('base64'), data: Buffer.alloc(15).toString('base64') } }),
    envelope({ kdf: { ...envelope().kdf, iterations: 99_999 } }),
    envelope({ kdf: { ...envelope().kdf, iterations: 5_000_001 } }),
    envelope({ kdf: { ...envelope().kdf, name: 'unknown' } }),
    envelope({ kdf: { ...envelope().kdf, salt: 'AAAA' } }),
  ]
  for (const value of badEnvelopes) {
    assert.equal((await put({ base_version: 1, blob: JSON.stringify(value) })).status, 400)
  }
  assert.equal((await put({ base_version: 1, blob: '{bad json' })).status, 400)
  const saved = await (await get()).json()
  assert.equal(saved.version, 1)
  assert.equal(saved.blob, blob)
})

test('an existing empty version-zero record can receive its first vault', async () => {
  harness.sql.run('INSERT INTO vaults (user_id, version, created_at) VALUES (1, 0, 123)')
  const response = await put({ base_version: 0, blob: JSON.stringify(envelope()) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).version, 1)
  assert.equal(harness.sql.get('SELECT created_at FROM vaults WHERE user_id = 1').created_at, 123)
})

test('version increment never exceeds the JSON safe integer range', async () => {
  const blob = JSON.stringify(envelope())
  harness.sql.run('INSERT INTO vaults (user_id, version, blob, created_at) VALUES (1, ?, ?, 123)', Number.MAX_SAFE_INTEGER, blob)
  assert.equal((await put({ base_version: Number.MAX_SAFE_INTEGER, blob })).status, 409)
  assert.equal((await (await get()).json()).version, Number.MAX_SAFE_INTEGER)
})

for (const baseVersion of [0, 1]) {
  test(`independent processes cannot both write base version ${baseVersion}`, { timeout: 15000 }, async (t) => {
    if (baseVersion === 1) assert.equal((await put({ base_version: 0, blob: JSON.stringify(envelope()) })).status, 200)
    const workers = Array.from({ length: 2 }, () => fork(workerFile, {
      execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }))
    t.after(() => workers.forEach((worker) => { if (worker.exitCode === null) worker.kill() }))
    const exits = workers.map((worker) => once(worker, 'exit'))
    await Promise.all(workers.map((worker) => once(worker, 'message')))
    const replies = workers.map((worker) => once(worker, 'message').then(([reply]) => reply))
    workers.forEach((worker, index) => worker.send({
      token, body: { base_version: baseVersion, blob: JSON.stringify(envelope({ updatedAt: index + 2 })) },
    }))
    const results = await Promise.all(replies)
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
    const winnerVersion = baseVersion + 1
    assert.ok(results.every((result) => result.data.version === winnerVersion))
    assert.equal((await (await get()).json()).version, winnerVersion)
    assert.ok((await Promise.all(exits)).every(([code]) => code === 0))
  })
}
