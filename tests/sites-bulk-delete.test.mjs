import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const serverRoot = fileURLToPath(new URL('../app/server/', import.meta.url))
const workspace = mkdtempSync(path.join(tmpdir(), 'hd-bulk-delete-'))
let h, token, ids, folder, category

before(async () => {
  const output = path.join(workspace, 'fixture.mjs')
  await build({
    stdin: { contents: `
      import { Hono } from 'hono';
      import { siteRoutes } from './src/routes/sites.ts';
      export const app = new Hono().route('/api', siteRoutes);
      export { sql, closeDb } from './src/lib/db.ts';
      export { initDatabase, getSetting, putSetting } from './src/db/schema.ts';
      export { readDesktopLayout } from './src/routes/desktop.ts';
      export { createAccessOnlySession, issueAccessToken } from './src/lib/tokens.ts';
    `, resolveDir: serverRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: output,
    banner: { js: SERVER_ESM_BANNER },
    plugins: [{ name: 'bulk-delete-fixture', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const DB_FILE = ${JSON.stringify(path.join(workspace, 'app.db'))};
        export const REFRESH_DAYS = 30;
        export const ADMIN_USERNAME = 'bulk-fixture';
        export const ADMIN_PASSWORD = 'fixture-only-password';
        export const ENV_AGENT_TOKEN = 'fixture-agent';
        export const ENV_JWT_SECRET = 'fixture-only-jwt-secret';
        export function ensureDirs() {}
      `, loader: 'js' }))
    } }],
  })
  h = await import(pathToFileURL(output).href)
  h.initDatabase()
  const user = h.sql.get('SELECT id, username FROM users ORDER BY id LIMIT 1')
  token = await h.issueAccessToken(user, h.createAccessOnlySession(user.id, 'Bulk deletion test', '192.0.2.1'))
})

beforeEach(() => {
  h.sql.exec('DELETE FROM sites; DELETE FROM folders; DELETE FROM categories;')
  category = h.sql.run("INSERT INTO categories (name, created_at) VALUES ('Keep category', 1)").lastInsertRowid
  folder = h.sql.run("INSERT INTO folders (name, category_id, columns, rows, created_at, updated_at) VALUES ('Keep folder', ?, 3, 2, 1, 1)", category).lastInsertRowid
  ids = Array.from({ length: 3 }, (_, index) => h.sql.run(
    'INSERT INTO sites (title, url_public, category_id, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
    `Site ${index}`, `https://example.com/${index}`, category, index === 1 ? folder : null,
  ).lastInsertRowid)
  h.putSetting('keep-bulk-fixture', 'Other settings survive deletion')
  h.putSetting('desktop_layout', JSON.stringify({ version: 1,
    wide: { [`site:${ids[0]}`]: { col: 3, row: 2 }, [`site:${ids[1]}`]: { col: 4, row: 2 }, [`site:${ids[2]}`]: { col: 5, row: 2 }, [`folder:${folder}`]: { col: 0, row: 3 }, 'widget:clock': { col: 0, row: 0, width: 6, height: 2 } },
    compact: { [`site:${ids[0]}`]: { col: 0, row: 9 }, [`site:${ids[1]}`]: { col: 1, row: 9 }, [`site:${ids[2]}`]: { col: 2, row: 9 }, [`folder:${folder}`]: { col: 0, row: 5 }, 'widget:clock': { col: 0, row: 0, width: 4, height: 3 } },
  }))
  h.putSetting('home_layout', JSON.stringify({ version: 1,
    wide: { [`site:${ids[0]}`]: { col: 8, row: 3 }, [`site:${ids[1]}`]: { col: 9, row: 3 }, [`site:${ids[2]}`]: { col: 10, row: 3 }, [`folder:${folder}`]: { col: 1, row: 6 }, 'widget:clock': { col: 0, row: 0, width: 4, height: 2 } },
    compact: { [`site:${ids[0]}`]: { col: 0, row: 12 }, [`site:${ids[1]}`]: { col: 1, row: 12 }, [`site:${ids[2]}`]: { col: 2, row: 12 }, [`folder:${folder}`]: { col: 0, row: 8 }, 'widget:clock': { col: 0, row: 0, width: 2, height: 1 } },
  }))
})

after(() => {
  h?.closeDb()
  assert.equal(path.dirname(workspace), path.resolve(tmpdir()))
  assert.ok(path.basename(workspace).startsWith('hd-bulk-delete-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
})

function request(body, authorized = true, raw = false) {
  return h.app.request('/api/sites/bulk-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ? body : JSON.stringify(body),
  })
}
function state() {
  return Object.fromEntries(['sites', 'folders', 'categories', 'settings'].map(table => [table, h.sql.all(`SELECT * FROM ${table} ORDER BY ${table === 'settings' ? 'key' : 'id'}`)]))
}

test('bulk deletion requires authentication for both scopes and never changes data anonymously', async () => {
  const original = state()
  for (const body of [{ ids }, { all: true, confirm: 'delete-all-sites', expected_ids: ids }]) {
    assert.equal((await request(body, false)).status, 401)
    assert.deepEqual(state(), original)
  }
})

test('selected deletion includes folder members and prunes both desktop layouts while retaining other data', async () => {
  const original = state()
  const layout = h.readDesktopLayout()
  const homeLayout = h.readDesktopLayout('home')
  const response = await request({ ids: ids.slice(0, 2) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const result = await response.json()
  assert.equal(result.ok, true)
  assert.equal(result.deleted_count, 2)
  assert.deepEqual(result.deleted_ids, ids.slice(0, 2))
  assert.deepEqual(result.sites.map(site => site.id), ids.slice(2))
  for (const view of ['wide', 'compact']) {
    delete layout[view][`site:${ids[0]}`]
    delete layout[view][`site:${ids[1]}`]
    delete homeLayout[view][`site:${ids[0]}`]
    delete homeLayout[view][`site:${ids[1]}`]
  }
  assert.deepEqual(result.desktop_layout, layout)
  assert.deepEqual(result.desktop_layout.wide['widget:clock'], { col: 0, row: 0, width: 6, height: 2 })
  assert.deepEqual(result.desktop_layout.compact['widget:clock'], { col: 0, row: 0, width: 4, height: 3 })
  assert.deepEqual(JSON.parse(h.getSetting('desktop_layout')), layout)
  assert.deepEqual(result.home_layout, homeLayout)
  assert.deepEqual(JSON.parse(h.getSetting('home_layout')), homeLayout)
  assert.deepEqual(state().sites, original.sites.slice(2))
  assert.deepEqual(state().folders, original.folders)
  assert.deepEqual(state().categories, original.categories)
  assert.deepEqual(state().settings.filter(row => !['desktop_layout', 'home_layout'].includes(row.key)), original.settings.filter(row => !['desktop_layout', 'home_layout'].includes(row.key)))
})

test('invalid or ambiguous scopes, malformed JSON, duplicate IDs and oversized selections cannot delete anything', async () => {
  const original = state()
  const invalid = [
    {}, null, [], { ids: [] }, { ids: '1' }, { ids: [String(ids[0])] }, { ids: [0] }, { ids: [-1] },
    { ids: [1.5] }, { ids: [Number.MAX_SAFE_INTEGER + 1] }, { ids: [null] }, { ids: [true] }, { ids: [ids[0], ids[0]] },
    { ids: [ids[0]], all: false }, { all: true }, { all: 'true', confirm: 'delete-all-sites' },
    { all: true, confirm: 'yes' }, { all: true, confirm: 'delete-all-sites', ids: [] },
    { ids: [ids[0]], confirm: 'delete-all-sites' }, { ids: Array.from({ length: 10001 }, (_, index) => index + 1) },
    { ids: [ids[0]], expected_ids: ids },
    { all: true, confirm: 'delete-all-sites' },
    ...[null, 'all', [String(ids[0])], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [null], [true], [ids[0], ids[0]], Array.from({ length: 10001 }, (_, index) => index + 1)].map(expected_ids => ({ all: true, confirm: 'delete-all-sites', expected_ids })),
  ]
  for (const body of invalid) {
    const response = await request(body)
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 100))
    assert.deepEqual(state(), original)
  }
  assert.equal((await request('{bad json', true, true)).status, 400)
  assert.deepEqual(state(), original)
})

test('a stale selection fails atomically before deleting any still-existing icon', async () => {
  const original = state()
  const response = await request({ ids: [ids[0], ids.at(-1) + 100, ids[1]] })
  assert.equal(response.status, 400)
  assert.match((await response.json()).message, /已变更/)
  assert.deepEqual(state(), original)
})

test('explicit confirmed all scope clears every icon and retains empty folders, groups and widgets; repeating is harmless', async () => {
  const original = state()
  const layout = h.readDesktopLayout()
  const homeLayout = h.readDesktopLayout('home')
  const response = await request({ all: true, confirm: 'delete-all-sites', expected_ids: [...ids].reverse() })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.deleted_ids, ids)
  assert.equal(result.deleted_count, ids.length)
  assert.deepEqual(result.sites, [])
  for (const view of ['wide', 'compact']) for (const id of ids) {
    delete layout[view][`site:${id}`]
    delete homeLayout[view][`site:${id}`]
  }
  assert.deepEqual(result.desktop_layout, layout)
  assert.deepEqual(result.home_layout, homeLayout)
  assert.deepEqual(state().folders, original.folders)
  assert.deepEqual(state().categories, original.categories)
  assert.equal(h.getSetting('keep-bulk-fixture'), 'Other settings survive deletion')
  const repeated = await (await request({ all: true, confirm: 'delete-all-sites', expected_ids: [] })).json()
  assert.equal(repeated.deleted_count, 0)
  assert.deepEqual(repeated.deleted_ids, [])
  assert.deepEqual(repeated.desktop_layout, layout)
  assert.deepEqual(repeated.home_layout, homeLayout)
})

test('all deletion rejects icons added after review without touching any current data', async () => {
  h.sql.run("INSERT INTO sites (title, url_public, created_at, updated_at) VALUES ('Another device', 'https://example.com/new', 1, 1)")
  const beforeAttempt = state()
  const response = await request({ all: true, confirm: 'delete-all-sites', expected_ids: ids })
  assert.equal(response.status, 409)
  const error = await response.json()
  assert.equal(error.error, 'sites_changed')
  assert.match(error.message, /刷新清单.*重新确认/)
  assert.deepEqual(state(), beforeAttempt)
})

test('all deletion rejects removals or same-count replacements after review and leaves layout unchanged', async () => {
  h.sql.run('DELETE FROM sites WHERE id = ?', ids[0])
  const afterRemoval = state()
  const removed = await request({ all: true, confirm: 'delete-all-sites', expected_ids: ids })
  assert.equal(removed.status, 409)
  assert.equal((await removed.json()).error, 'sites_changed')
  assert.deepEqual(state(), afterRemoval)

  h.sql.run("INSERT INTO sites (title, url_public, created_at, updated_at) VALUES ('Replacement', 'https://example.com/replacement', 1, 1)")
  const afterReplacement = state()
  const replaced = await request({ all: true, confirm: 'delete-all-sites', expected_ids: ids })
  assert.equal(replaced.status, 409)
  assert.equal((await replaced.json()).error, 'sites_changed')
  assert.deepEqual(state(), afterReplacement)
})

test('an empty reviewed snapshot cannot clear a nonempty library', async () => {
  const original = state()
  const response = await request({ all: true, confirm: 'delete-all-sites', expected_ids: [] })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'sites_changed')
  assert.deepEqual(state(), original)
})

test('body size is limited before any mutation and oversized requests return a readable error', async () => {
  const original = state()
  const response = await request({ all: true, confirm: 'delete-all-sites', expected_ids: ids, padding: 'a'.repeat(256 * 1024) })
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error, 'payload_too_large')
  assert.deepEqual(state(), original)
})

test('database failures roll back every selected deletion and its layout update', async () => {
  const original = state()
  h.sql.exec(`CREATE TRIGGER fail_bulk_delete BEFORE DELETE ON sites WHEN OLD.id = ${ids[1]} BEGIN SELECT RAISE(ABORT, 'fixture deletion failure'); END;`)
  try {
    assert.equal((await request({ ids })).status, 500)
    assert.deepEqual(state(), original)
  } finally { h.sql.exec('DROP TRIGGER fail_bulk_delete') }

  h.sql.exec("CREATE TRIGGER fail_bulk_layout BEFORE UPDATE ON settings WHEN NEW.key = 'desktop_layout' BEGIN SELECT RAISE(ABORT, 'fixture layout failure'); END;")
  try {
    assert.equal((await request({ all: true, confirm: 'delete-all-sites', expected_ids: ids })).status, 500)
    assert.deepEqual(state(), original)
  } finally { h.sql.exec('DROP TRIGGER fail_bulk_layout') }

  // Home is persisted after desktop; a failure must roll back both layouts and the icons.
  h.sql.exec("CREATE TRIGGER fail_bulk_home BEFORE UPDATE ON settings WHEN NEW.key = 'home_layout' BEGIN SELECT RAISE(ABORT, 'fixture home layout failure'); END;")
  try {
    assert.equal((await request({ ids })).status, 500)
    assert.deepEqual(state(), original)
  } finally { h.sql.exec('DROP TRIGGER fail_bulk_home') }
})

test('existing single-icon deletion remains authenticated and cannot delete neighboring icons or folders', async () => {
  const original = state()
  const route = `/api/sites/${ids[1]}`
  assert.equal((await h.app.request(route, { method: 'DELETE' })).status, 401)
  assert.deepEqual(state(), original)
  const response = await h.app.request(route, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(state().sites, original.sites.filter(site => site.id !== ids[1]))
  assert.deepEqual(state().folders, original.folders)
  assert.deepEqual(state().categories, original.categories)
})
