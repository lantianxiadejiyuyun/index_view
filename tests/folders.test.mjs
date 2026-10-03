import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const serverRoot = fileURLToPath(new URL('../app/server/', import.meta.url))
const workspace = mkdtempSync(path.join(tmpdir(), 'hd-folders-'))
const dbFile = path.join(workspace, 'app.db')
let h, token, legacySites, v14Folder, v14Sites

async function bundle(name, legacyVersion, databaseFile = dbFile) {
  const output = path.join(workspace, name + '.mjs')
  await build({
    stdin: { contents: `
      import { Hono } from 'hono';
      import { siteRoutes } from './src/routes/sites.ts';
      import { folderRoutes } from './src/routes/folders.ts';
      import { desktopRoutes } from './src/routes/desktop.ts';
      import { settingsRoutes } from './src/routes/settings.ts';
      import { bootstrapRoutes } from './src/routes/bootstrap.ts';
      import { importRoutes } from './src/routes/import.ts';
      export const app = new Hono().route('/api', siteRoutes).route('/api', folderRoutes).route('/api', desktopRoutes).route('/api', settingsRoutes).route('/api', bootstrapRoutes).route('/api', importRoutes);
      export { sql, closeDb } from './src/lib/db.ts';
      export { initDatabase } from './src/db/schema.ts';
      export { createAccessOnlySession, issueAccessToken } from './src/lib/tokens.ts';
    `, resolveDir: serverRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: output,
    banner: { js: SERVER_ESM_BANNER },
    plugins: [{ name: 'isolated-folders', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'folders-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'folders-fixture' }, () => ({ contents: `
        export const DB_FILE = ${JSON.stringify(databaseFile)};
        export const REFRESH_DAYS = 30;
        export const ADMIN_USERNAME = 'folder-fixture';
        export const ADMIN_PASSWORD = 'fixture-only-password';
        export const ENV_AGENT_TOKEN = 'fixture-agent';
        export const ENV_JWT_SECRET = 'fixture-only-jwt-secret';
        export const PUBLIC_VIEW = true;
        export function ensureDirs() {}
      `, loader: 'js' }))
      if (legacyVersion) builder.onLoad({ filter: /[\\/]db[\\/]schema\.ts$/ }, ({ path: source }) => ({
        contents: readFileSync(source, 'utf8').replace('m.version > current', `m.version > current && m.version <= ${legacyVersion}`)
          .replace('(SELECT COUNT(*) FROM categories) + (SELECT COUNT(*) FROM folders)', '(SELECT COUNT(*) FROM categories)'), loader: 'ts',
      }))
    } }],
  })
  return import(pathToFileURL(output).href)
}

before(async () => {
  const old = await bundle('legacy', 13)
  old.initDatabase()
  assert.equal(old.sql.get('PRAGMA user_version').user_version, 13)
  legacySites = old.sql.all('SELECT * FROM sites ORDER BY id').map(row => ({ ...row }))
  old.closeDb()
  const v14 = await bundle('v14', 14)
  v14.initDatabase()
  v14.sql.run('INSERT INTO folders (id, name, category_id, columns, rows, color, sort_order, created_at, updated_at) VALUES (23, ?, ?, 4, 3, ?, 7, 10, 20)', 'Existing folder', legacySites[0].category_id, '#123abc')
  v14.sql.run('UPDATE sites SET folder_id = 23 WHERE id = ?', legacySites[0].id)
  v14.sql.run("INSERT INTO folders (id, name, created_at, updated_at) VALUES (300, 'Deleted folder', 10, 20)")
  v14.sql.run('DELETE FROM folders WHERE id = 300')
  v14Folder = v14.sql.get('SELECT * FROM folders WHERE id = 23')
  v14Sites = v14.sql.all('SELECT * FROM sites ORDER BY id')
  v14.closeDb()
  h = await bundle('current')
  h.initDatabase()
  const user = h.sql.get('SELECT id, username FROM users ORDER BY id LIMIT 1')
  token = await h.issueAccessToken(user, h.createAccessOnlySession(user.id, 'Test browser', '192.0.2.1'))
})
after(() => {
  h?.closeDb()
  assert.equal(path.dirname(workspace), path.resolve(tmpdir()))
  assert.ok(path.basename(workspace).startsWith('hd-folders-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
})
function request(route, body, method = body === undefined ? 'GET' : 'POST', authorized = true) {
  return h.app.request('/api' + route, { method, headers: {
    ...(authorized ? { Authorization: 'Bearer ' + token } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}
async function json(route, body, method, status = 200) {
  const response = await request(route, body, method)
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  return result
}
function state() {
  return { categories: h.sql.all('SELECT * FROM categories ORDER BY id'), folders: h.sql.all('SELECT * FROM folders ORDER BY id'), sites: h.sql.all('SELECT * FROM sites ORDER BY id') }
}
async function fixture() {
  h.sql.exec('DELETE FROM sites; DELETE FROM folders; DELETE FROM categories;')
  const a = (await json('/categories', { name: 'Work' }, 'POST', 201)).category.id
  const b = (await json('/categories', { name: 'Personal' }, 'POST', 201)).category.id
  const sites = []
  for (let i = 0; i < 4; i++) sites.push((await json('/sites', { title: 'Site ' + i, url_public: 'https://example.com/' + i, category_id: i < 2 ? a : b }, 'POST', 201)).site.id)
  return { a, b, sites }
}
const site = id => h.sql.get('SELECT * FROM sites WHERE id = ?', id)

test('v13 through v15 migration preserves every original bookmark and v14 folder membership', async () => {
  assert.equal(h.sql.get('PRAGMA user_version').user_version, 17)
  const current = h.sql.all('SELECT * FROM sites ORDER BY id')
  assert.deepEqual(current.map(({ folder_id, ...rest }) => rest), legacySites)
  assert.deepEqual(current, v14Sites)
  assert.deepEqual(h.sql.get('SELECT * FROM folders WHERE id = 23'), v14Folder)
  assert.equal(h.sql.get("SELECT seq FROM sqlite_sequence WHERE name = 'folders'").seq, 300)
  assert.equal(h.sql.get('PRAGMA foreign_keys').foreign_keys, 1)
  assert.ok(h.sql.all('PRAGMA index_list(folders)').some(item => item.name === 'idx_folders_category'))
  assert.deepEqual(h.sql.all('PRAGMA foreign_key_check'), [])
  assert.equal((await json('/bootstrap')).folders[0].id, 23)
  const created = await json('/folders', { name: 'After migration' }, 'POST', 201)
  assert.equal(created.folder.id, 301)
})

test('v15 migration rolls back the table and version and restores foreign keys when integrity validation fails', async () => {
  const file = path.join(workspace, 'invalid-v14.db')
  const old = await bundle('invalid-v14', 14, file)
  old.initDatabase()
  old.sql.run("INSERT INTO folders (name, created_at, updated_at) VALUES ('Keep on rollback', 1, 2)")
  old.sql.exec('PRAGMA foreign_keys = OFF')
  old.sql.run('UPDATE sites SET folder_id = 99999 WHERE id = (SELECT MIN(id) FROM sites)')
  old.sql.exec('PRAGMA foreign_keys = ON')
  const before = old.sql.all('SELECT * FROM folders')
  old.closeDb()
  const current = await bundle('invalid-current', undefined, file)
  try {
    assert.throws(() => current.initDatabase(), /Foreign key validation failed/)
    assert.equal(current.sql.get('PRAGMA user_version').user_version, 14)
    assert.equal(current.sql.get('PRAGMA foreign_keys').foreign_keys, 1)
    assert.deepEqual(current.sql.all('SELECT * FROM folders'), before)
    assert.equal(current.sql.get("SELECT name FROM sqlite_master WHERE name = 'folders_next'"), undefined)
    assert.throws(() => current.sql.run('UPDATE folders SET columns = 5'), /CHECK constraint failed/)
  } finally { current.closeDb() }
})

test('folder writes require a live authenticated session', async () => {
  for (const [route, method, body] of [['/folders', 'POST', { name: 'Blocked' }], ['/folders/1', 'PUT', { name: 'Blocked' }], ['/folders/1', 'DELETE', undefined]]) {
    assert.equal((await request(route, body, method, false)).status, 401)
  }
})

test('creating a folder moves its selected sites together and bootstrap returns their membership', async () => {
  const { a, sites } = await fixture()
  const result = await json('/folders', { name: 'Resources', category_id: a, columns: 3, rows: 2, color: '#aabbcc', site_ids: [sites[0], sites[2]] }, 'POST', 201)
  assert.equal(result.folder.columns, 3)
  assert.equal(result.folder.rows, 2)
  assert.equal(result.sites.length, 4)
  for (const id of [sites[0], sites[2]]) { assert.equal(site(id).folder_id, result.folder.id); assert.equal(site(id).category_id, a) }
  assert.equal(site(sites[1]).folder_id, null)
  const bootstrap = await json('/bootstrap')
  assert.equal(bootstrap.folders[0].name, 'Resources')
  assert.equal(bootstrap.sites.find(item => item.id === sites[2]).folder_id, result.folder.id)
})

test('all preset and arbitrary custom folder dimensions survive update and backup roundtrip', async () => {
  await fixture()
  const { folder } = await json('/folders', { name: 'Sizes' }, 'POST', 201)
  for (let columns = 1; columns <= 4; columns++) for (let rows = 1; rows <= 3; rows++) {
    const result = await json('/folders/' + folder.id, { columns, rows }, 'PUT')
    assert.equal(result.folder.columns, columns)
    assert.equal(result.folder.rows, rows)
    assert.equal(result.folder.name, 'Sizes')
  }
  for (const [columns, rows] of [[5, 4], [100, 1000], [99999, 88888], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    const result = await json('/folders/' + folder.id, { columns, rows }, 'PUT')
    assert.equal(result.folder.columns, columns)
    assert.equal(result.folder.rows, rows)
    const backup = await json('/export')
    await json('/import', { ...backup, folders: backup.folders.filter(item => item.id === folder.id), mode: 'merge' })
    const imported = h.sql.get('SELECT columns, rows FROM folders ORDER BY id DESC LIMIT 1')
    assert.equal(imported.columns, columns)
    assert.equal(imported.rows, rows)
  }
})

test('invalid dimensions, references and membership reject the entire folder write', async () => {
  const { a, sites } = await fixture()
  const { folder } = await json('/folders', { name: 'Keep', category_id: a, site_ids: [sites[0]] }, 'POST', 201)
  for (const patch of [{ columns: 0 }, { columns: -1 }, { columns: 1.5 }, { columns: Number.MAX_SAFE_INTEGER + 1 }, { rows: 0 }, { rows: -1 }, { rows: 1.5 }, { rows: Number.MAX_SAFE_INTEGER + 1 }, { rows: null }, { color: 'red' }, { name: ' ' }, { category_id: 999999 }, { site_ids: [sites[1], 999999] }, { site_ids: [sites[1], sites[1]] }, { site_ids: [null] }, { site_ids: 'bad' }]) {
    const before = state()
    assert.equal((await request('/folders/' + folder.id, { name: 'Changed', ...patch }, 'PUT')).status, 400, JSON.stringify(patch))
    assert.deepEqual(state(), before)
  }
  for (const field of ['columns', 'rows']) {
    const before = state()
    const response = await h.app.request('/api/folders/' + folder.id, { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: `{"${field}":1e999}` })
    assert.equal(response.status, 400)
    assert.deepEqual(state(), before)
  }
  const before = state()
  assert.equal((await request('/folders', { name: 'Invalid new', site_ids: [sites[1], 999999] })).status, 400)
  assert.deepEqual(state(), before)
})

test('exact membership selection unwraps deselected sites and moves members between folders', async () => {
  const { a, b, sites } = await fixture()
  const first = (await json('/folders', { name: 'First', category_id: a, site_ids: [sites[0], sites[1]] }, 'POST', 201)).folder
  const second = (await json('/folders', { name: 'Second', category_id: b, site_ids: [sites[0], sites[2]] }, 'POST', 201)).folder
  assert.equal(site(sites[0]).folder_id, second.id)
  await json('/folders/' + first.id, { category_id: b, site_ids: [sites[3]] }, 'PUT')
  assert.equal(site(sites[1]).folder_id, null)
  assert.equal(site(sites[1]).category_id, b)
  assert.equal(site(sites[3]).folder_id, first.id)
  await json('/folders/' + second.id, { category_id: null }, 'PUT')
  for (const id of [sites[0], sites[2]]) { assert.equal(site(id).category_id, null); assert.equal(site(id).folder_id, second.id) }
})

test('deleting a folder unwraps all its bookmarks without deleting any', async () => {
  const { a, sites } = await fixture()
  const { folder } = await json('/folders', { name: 'Unwrap', category_id: a, site_ids: sites }, 'POST', 201)
  const result = await json('/folders/' + folder.id, undefined, 'DELETE')
  assert.equal(result.sites.length, sites.length)
  assert.ok(result.sites.every(item => item.folder_id === null && item.category_id === a))
  assert.equal(h.sql.all('SELECT * FROM folders').length, 0)
})

test('site creation, moves and editing respect the selected folder group', async () => {
  const { a, b, sites } = await fixture()
  const { folder } = await json('/folders', { name: 'Destination', category_id: a }, 'POST', 201)
  const created = (await json('/sites', { title: 'Inside', url_public: 'https://example.com/new', category_id: b, folder_id: folder.id }, 'POST', 201)).site
  assert.equal(created.category_id, a)
  await json('/sites/' + sites[2], { folder_id: folder.id }, 'PUT')
  assert.equal(site(sites[2]).category_id, a)
  await json('/sites/' + sites[2], { title: 'Renamed' }, 'PUT')
  assert.equal(site(sites[2]).folder_id, folder.id)
  await json('/sites/' + sites[2], { category_id: b }, 'PUT')
  assert.equal(site(sites[2]).folder_id, null)
  await json('/sites/' + created.id, { folder_id: null }, 'PUT')
  assert.equal(site(created.id).category_id, a)
  assert.equal(site(created.id).folder_id, null)
  const before = state()
  assert.equal((await request('/sites/' + sites[0], { folder_id: 999999 }, 'PUT')).status, 400)
  assert.equal((await request('/sites', { title: 'Invalid', url_public: 'https://example.com', folder_id: 999999 })).status, 400)
  assert.deepEqual(state(), before)
})

test('reorder preserves membership, detaches direct group moves and rejects partial invalid batches', async () => {
  const { a, b, sites } = await fixture()
  const { folder } = await json('/folders', { name: 'Sort', category_id: a, site_ids: [sites[0], sites[1]] }, 'POST', 201)
  await json('/sites/reorder', { items: [{ id: sites[0], category_id: a, sort_order: 12 }] }, 'PATCH')
  assert.equal(site(sites[0]).folder_id, folder.id)
  await json('/sites/reorder', { items: [{ id: sites[0], category_id: b, sort_order: 1 }] }, 'PATCH')
  assert.equal(site(sites[0]).folder_id, null)
  await json('/sites/reorder', { items: [{ id: sites[2], folder_id: folder.id, sort_order: 0 }] }, 'PATCH')
  assert.equal(site(sites[2]).folder_id, folder.id)
  assert.equal(site(sites[2]).category_id, a)
  const before = state()
  assert.equal((await request('/sites/reorder', { items: [{ id: sites[0], sort_order: 98 }, { id: sites[1], folder_id: 999999 }] }, 'PATCH')).status, 400)
  assert.deepEqual(state(), before)
})

test('category detach retains folders and membership while category delete removes its contents', async () => {
  let f = await fixture()
  let folder = (await json('/folders', { name: 'Detach', category_id: f.a, site_ids: [f.sites[0]] }, 'POST', 201)).folder
  await json('/categories/' + f.a + '?mode=detach', undefined, 'DELETE')
  assert.equal(h.sql.get('SELECT category_id FROM folders WHERE id = ?', folder.id).category_id, null)
  assert.equal(site(f.sites[0]).category_id, null)
  assert.equal(site(f.sites[0]).folder_id, folder.id)
  f = await fixture()
  folder = (await json('/folders', { name: 'Delete', category_id: f.a, site_ids: [f.sites[0]] }, 'POST', 201)).folder
  await json('/categories/' + f.a + '?mode=delete', undefined, 'DELETE')
  assert.equal(h.sql.get('SELECT id FROM folders WHERE id = ?', folder.id), undefined)
  assert.equal(site(f.sites[0]), undefined)
  assert.ok(site(f.sites[2]))
  assert.deepEqual(h.sql.all('PRAGMA foreign_key_check'), [])
})

test('backup v2 roundtrip restores folder sizes, membership, dual links and empty folders', async () => {
  const { a, sites } = await fixture()
  await json('/folders', { name: 'Wide', category_id: a, columns: 4, rows: 3, color: '#123abc', site_ids: [sites[0], sites[2]] }, 'POST', 201)
  await json('/folders', { name: 'Empty', columns: 1, rows: 1 }, 'POST', 201)
  await json('/sites/' + sites[0], { url_lan: 'http://192.168.1.20/app', lan_port: 8080, link_mode: 'lan' }, 'PUT')
  const backup = await json('/export')
  assert.equal(backup.version, 2)
  assert.equal(backup.settings.jwt_secret, undefined)
  const counts = await json('/import', { ...backup, mode: 'replace' })
  assert.deepEqual([counts.categories, counts.folders, counts.sites], [2, 2, 4])
  const restored = await json('/export')
  const wide = restored.folders.find(item => item.name === 'Wide')
  assert.deepEqual([wide.columns, wide.rows, wide.color], [4, 3, '#123abc'])
  assert.equal(restored.sites.filter(item => item.folder_id === wide.id).length, 2)
  const dual = restored.sites.find(item => item.title === 'Site 0')
  assert.deepEqual([dual.url_lan, dual.lan_port, dual.link_mode], ['http://192.168.1.20/app', 8080, 'lan'])
  assert.equal(dual.category_id, wide.category_id)
  assert.equal(restored.folders.length, 2)
  const merged = await json('/import', { ...backup, mode: 'merge' })
  assert.equal(merged.folders, 2)
  assert.equal((await json('/export')).folders.length, 4)
  assert.deepEqual(h.sql.all('PRAGMA foreign_key_check'), [])
})

test('invalid folder backup is rejected atomically before replace or settings changes', async () => {
  await fixture()
  const valid = { categories: [{ id: 7, name: 'Backup group' }], folders: [{ id: 5, name: 'Backup folder', category_id: 7, columns: 2, rows: 2 }], sites: [{ title: 'Backup site', url: 'https://example.com', category_id: 7, folder_id: 5 }] }
  const variants = [
    { ...valid, folders: [{ ...valid.folders[0], columns: 0 }] },
    { ...valid, folders: [{ ...valid.folders[0], category_id: 99 }] },
    { ...valid, folders: [...valid.folders, ...valid.folders] },
    { ...valid, sites: [{ ...valid.sites[0], folder_id: 99 }] },
    { ...valid, folders: 'invalid' },
    { categories: [], folders: [], sites: [{ title: 'No address' }] },
  ]
  for (const backup of variants) {
    const before = state()
    const setting = h.sql.get("SELECT value FROM settings WHERE key = 'site_title'").value
    assert.equal((await request('/import', { ...backup, settings: { site_title: 'Must not change' } })).status, 400)
    assert.deepEqual(state(), before)
    assert.equal(h.sql.get("SELECT value FROM settings WHERE key = 'site_title'").value, setting)
  }
})

test('legacy backup without folders remains importable and folders-only backup is supported', async () => {
  await fixture()
  await json('/folders', { name: 'Old folder' }, 'POST', 201)
  await json('/import', { version: 1, categories: [{ id: 8, name: 'Legacy' }], sites: [{ title: 'Legacy site', category_id: 8, url: 'example.com' }] })
  let data = await json('/bootstrap')
  assert.deepEqual(data.folders, [])
  assert.equal(data.sites[0].folder_id, null)
  assert.equal(data.categories[0].name, 'Legacy')
  await json('/import', { folders: [{ id: 100, name: 'Empty workspace', columns: 3, rows: 1 }] })
  data = await json('/bootstrap')
  assert.equal(data.folders[0].name, 'Empty workspace')
  assert.equal(data.sites.length, 0)
  h.initDatabase()
  assert.equal(h.sql.get('SELECT COUNT(*) AS n FROM sites').n, 0)
  assert.deepEqual(h.sql.all('PRAGMA foreign_key_check'), [])
})

test('HTML bookmark replacement removes old folders and merge preserves them', async () => {
  const { a, sites } = await fixture()
  const { folder } = await json('/folders', { name: 'Keep on merge', category_id: a, site_ids: [sites[0]] }, 'POST', 201)
  const categories = [{ name: 'Browser imports', sites: [{ title: 'Imported', url: 'https://example.org' }] }]
  await json('/import/bookmarks/commit', { mode: 'merge', categories })
  assert.equal(site(sites[0]).folder_id, folder.id)
  await json('/import/bookmarks/commit', { mode: 'replace', categories })
  const data = await json('/bootstrap')
  assert.equal(data.folders.length, 0)
  assert.equal(data.sites.length, 1)
  assert.equal(data.sites[0].folder_id, null)
})

test('desktop endpoints and folder ordering require authentication', async () => {
  for (const [route, method, body] of [['/desktop/layout', 'GET'], ['/desktop/layout', 'PATCH', {}], ['/desktop/move', 'POST', {}], ['/desktop/collect-groups', 'POST', {}], ['/folders/reorder', 'PATCH', {}]]) {
    assert.equal((await request(route, body, method, false)).status, 401)
  }
})

test('desktop position patches merge independently across screen sizes and reject stale IDs atomically', async () => {
  const { sites } = await fixture()
  const id = `site:${sites[0]}`
  await json('/desktop/layout', { viewport: 'wide', reset: true }, 'PATCH')
  await json('/desktop/layout', { viewport: 'compact', reset: true }, 'PATCH')
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id, col: 8, row: 3 }] }, 'PATCH')
  await json('/desktop/layout', { viewport: 'compact', placements: [{ id, col: 1, row: 7 }] }, 'PATCH')
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: 'widget:clock', col: 0, row: 4 }] }, 'PATCH')
  const before = await json('/desktop/layout')
  assert.deepEqual(before.layout.wide[id], { col: 8, row: 3 })
  assert.deepEqual(before.layout.compact[id], { col: 1, row: 7 })
  for (const placements of [[{ id, col: 3, row: 1 }, { id: 'folder:999999', col: 0, row: 0 }], [{ id, col: 0, row: -1 }], [{ id, col: 12, row: 1 }], [{ id, col: 1.5, row: 0 }], [{ id: '__proto__', col: 0, row: 0 }], [{ id, col: 0, row: 0 }, { id, col: 0, row: 1 }]]) {
    await json('/desktop/layout', { viewport: 'wide', placements }, 'PATCH', 400)
    assert.deepEqual(await json('/desktop/layout'), before)
  }
  await json('/desktop/layout', { viewport: 'compact', reset: true }, 'PATCH')
  assert.deepEqual((await json('/desktop/layout')).layout.wide, before.layout.wide)
})

test('desktop folder drops preserve icon content and atomically detach with a saved position', async () => {
  const { a, b, sites } = await fixture()
  const { folder } = await json('/folders', { name: 'Target', category_id: b, site_ids: [sites[2]] }, 'POST', 201)
  const original = site(sites[0])
  await json('/desktop/move', { site_id: sites[0], folder_id: folder.id, viewport: 'wide' })
  assert.equal(site(sites[0]).folder_id, folder.id)
  assert.equal(site(sites[0]).category_id, b)
  assert.equal(site(sites[0]).url_public, original.url_public)
  assert.equal(site(sites[0]).title, original.title)
  assert.notEqual(a, b)
  const before = site(sites[0])
  await json('/desktop/move', { site_id: sites[0], folder_id: null, viewport: 'compact', position: { col: 4, row: 1 } }, 'POST', 400)
  assert.deepEqual(site(sites[0]), before)
  await json('/desktop/move', { site_id: sites[0], folder_id: null, viewport: 'wide', position: { col: 6, row: 9 } })
  assert.equal(site(sites[0]).folder_id, null)
  assert.deepEqual((await json('/desktop/layout')).layout.wide[`site:${sites[0]}`], { col: 6, row: 9 })
})

test('a desktop storage failure rolls back both folder membership and coordinates', async () => {
  const { a, sites } = await fixture()
  const { folder } = await json('/folders', { name: 'Source', category_id: a, site_ids: [sites[0]] }, 'POST', 201)
  const before = state()
  h.sql.exec("CREATE TRIGGER fail_desktop BEFORE INSERT ON settings WHEN NEW.key = 'desktop_layout' BEGIN SELECT RAISE(ABORT, 'fixture'); END")
  try {
    assert.equal((await request('/desktop/move', { site_id: sites[0], folder_id: null, viewport: 'wide', position: { col: 0, row: 0 } })).status, 500)
    assert.deepEqual(state(), before)
    assert.equal(site(sites[0]).folder_id, folder.id)
  } finally { h.sql.exec('DROP TRIGGER fail_desktop') }
})

test('folder reorder moves its members to the destination category without changing size or URLs', async () => {
  const { a, b, sites } = await fixture()
  const first = (await json('/folders', { name: 'One', category_id: a, columns: 10, rows: 6, site_ids: [sites[0]] }, 'POST', 201)).folder
  const second = (await json('/folders', { name: 'Two', category_id: b }, 'POST', 201)).folder
  const before = site(sites[0])
  const result = await json('/folders/reorder', { items: [{ id: second.id, category_id: b }, { id: first.id, category_id: b }] }, 'PATCH')
  assert.deepEqual(result.folders.map(f => f.id), [second.id, first.id])
  assert.equal(result.folders[1].columns, 10)
  assert.equal(result.folders[1].rows, 6)
  assert.equal(site(sites[0]).category_id, b)
  assert.equal(site(sites[0]).folder_id, first.id)
  assert.equal(site(sites[0]).url_public, before.url_public)
  const snapshot = state()
  await json('/folders/reorder', { items: [{ id: first.id, category_id: a }, { id: 999999, category_id: b }] }, 'PATCH', 400)
  assert.deepEqual(state(), snapshot)
})

test('collecting legacy groups creates folders once and preserves existing folders and categories', async () => {
  const { a, sites } = await fixture()
  const existing = (await json('/folders', { name: 'Existing', category_id: a, site_ids: [sites[0]] }, 'POST', 201)).folder
  const originalCategories = state().categories
  const collected = await json('/desktop/collect-groups', {})
  assert.equal(collected.created, 2)
  assert.equal(site(sites[0]).folder_id, existing.id)
  assert.ok(collected.sites.every(site => site.folder_id))
  assert.deepEqual(state().categories, originalCategories)
  assert.equal((await json('/desktop/collect-groups', {})).created, 0)
})

test('desktop backup restore remaps layout IDs and preserves phone layout and home mode', async () => {
  const { a, sites } = await fixture()
  const { folder } = await json('/folders', { name: 'Restore me', category_id: a, site_ids: [sites[0]] }, 'POST', 201)
  await json('/settings', { home_mode: 'desktop' }, 'PUT')
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: `folder:${folder.id}`, col: 7, row: 5 }, { id: `site:${sites[1]}`, col: 9, row: 1 }] }, 'PATCH')
  await json('/desktop/layout', { viewport: 'compact', placements: [{ id: `folder:${folder.id}`, col: 1, row: 3 }] }, 'PATCH')
  const exported = await json('/export')
  await json('/import', { ...exported, mode: 'replace' })
  const current = await json('/bootstrap')
  const newFolder = current.folders.find(f => f.name === 'Restore me')
  const newSite = current.sites.find(s => s.title === 'Site 1')
  assert.notEqual(newFolder.id, folder.id)
  const { layout } = await json('/desktop/layout')
  assert.deepEqual(layout.wide[`folder:${newFolder.id}`], { col: 7, row: 5 })
  assert.deepEqual(layout.compact[`folder:${newFolder.id}`], { col: 1, row: 3 })
  assert.deepEqual(layout.wide[`site:${newSite.id}`], { col: 9, row: 1 })
  assert.equal(current.settings.home_mode, 'desktop')
  const before = state()
  await json('/import', { ...exported, mode: 'replace', settings: { desktop_layout: '{broken' } }, 'POST', 400)
  assert.deepEqual(state(), before)
})

test('calendar layout persists independently on both devices and rejects unknown widgets atomically', async () => {
  const { sites } = await fixture()
  for (const viewport of ['wide', 'compact']) await json('/desktop/layout', { viewport, reset: true }, 'PATCH')
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: `site:${sites[0]}`, col: 1, row: 4 }, { id: 'widget:clock', col: 5, row: 1 }] }, 'PATCH')
  const original = (await json('/desktop/layout')).layout
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: 'widget:calendar', col: 8, row: 7 }] }, 'PATCH')
  await json('/desktop/layout', { viewport: 'compact', placements: [{ id: 'widget:calendar', col: 0, row: 11 }] }, 'PATCH')
  const before = await json('/desktop/layout')
  assert.deepEqual(before.layout.wide, { ...original.wide, 'widget:calendar': { col: 8, row: 7 } })
  assert.deepEqual(before.layout.compact, { 'widget:calendar': { col: 0, row: 11 } })
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: 'widget:calendar', col: 0, row: 0 }, { id: 'widget:unknown', col: 4, row: 4 }] }, 'PATCH', 400)
  assert.deepEqual(await json('/desktop/layout'), before)
  assert.deepEqual(JSON.parse((await json('/export')).settings.desktop_layout), before.layout)
})

test('calendar backup replace restores both positions and merge preserves existing widget positions', async () => {
  await fixture()
  for (const viewport of ['wide', 'compact']) await json('/desktop/layout', { viewport, reset: true }, 'PATCH')
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: 'widget:calendar', col: 8, row: 4 }, { id: 'widget:clock', col: 0, row: 12 }, { id: 'widget:search', col: 3, row: 12 }] }, 'PATCH')
  await json('/desktop/layout', { viewport: 'compact', placements: [{ id: 'widget:calendar', col: 0, row: 7 }, { id: 'widget:clock', col: 0, row: 0 }, { id: 'widget:search', col: 0, row: 2 }] }, 'PATCH')
  const backup = await json('/export')
  const original = (await json('/desktop/layout')).layout
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: 'widget:calendar', col: 4, row: 14 }] }, 'PATCH')
  await json('/import', { ...backup, mode: 'replace' })
  assert.deepEqual((await json('/desktop/layout')).layout, original)

  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: 'widget:calendar', col: 4, row: 14 }] }, 'PATCH')
  await json('/desktop/layout', { viewport: 'compact', placements: [{ id: 'widget:calendar', col: 0, row: 18 }] }, 'PATCH')
  const current = (await json('/desktop/layout')).layout
  await json('/import', { ...backup, mode: 'merge' })
  assert.deepEqual((await json('/desktop/layout')).layout, current)
})

test('desktop header and calendar preferences preserve coordinates and reject invalid modes before mutation', async () => {
  const { sites } = await fixture()
  await json('/desktop/layout', { viewport: 'wide', placements: [{ id: `site:${sites[0]}`, col: 5, row: 9 }, { id: 'widget:clock', col: 1, row: 2 }, { id: 'widget:search', col: 4, row: 5 }, { id: 'widget:calendar', col: 8, row: 12 }] }, 'PATCH')
  const layout = await json('/desktop/layout')
  for (const [mode, visible] of [['widgets', false], ['hero', true]]) {
    const result = await json('/settings', { desktop_header_mode: mode, show_calendar: visible }, 'PUT')
    assert.equal(result.settings.desktop_header_mode, mode)
    assert.equal(result.settings.show_calendar, String(visible))
    assert.deepEqual(await json('/desktop/layout'), layout)
  }
  const before = await json('/settings')
  await json('/settings', { desktop_header_mode: 'automatic', show_calendar: false }, 'PUT', 400)
  assert.deepEqual(await json('/settings'), before)
  assert.deepEqual(await json('/desktop/layout'), layout)

  const backup = await json('/export')
  const original = state()
  await json('/import', { ...backup, mode: 'replace', settings: { ...backup.settings, desktop_header_mode: 'automatic' } }, 'POST', 400)
  assert.deepEqual(state(), original)
  assert.deepEqual(await json('/settings'), before)
})
