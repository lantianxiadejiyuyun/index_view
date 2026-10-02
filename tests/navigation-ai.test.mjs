import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const root = fileURLToPath(new URL('../app/server/', import.meta.url))
const workspace = mkdtempSync(path.join(tmpdir(), 'hd-navigation-ai-'))
const bundleFile = path.join(workspace, 'fixture.mjs')
const originalTransport = globalThis.__navigationAiFixtureRequest
let h, token, otherToken, respond
const calls = []
const completion = (value, finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] })
const plan = () => ({ summary: '将开发工具整理到独立分组，并保留既有文件夹。', groups: [
  { category_id: 10, name: '原分组', site_ids: [103], folders: [] },
  { category_id: null, name: '开发工具', site_ids: [102], folders: [
    { folder_id: 30, name: '原文件夹', site_ids: [100] },
    { folder_id: null, name: '常用收藏', site_ids: [101] },
  ] },
] })

before(async () => {
  await build({
    stdin: { contents: `
      export { navigationAiRoutes } from './src/routes/navigation-ai.ts';
      export * from './src/lib/navigation-ai.ts';
      export { saveSubscriptionAiSettings } from './src/lib/subscription-ai.ts';
      export { sql, closeDb } from './src/lib/db.ts';
      export { initDatabase } from './src/db/schema.ts';
      export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
    `, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundleFile,
    banner: { js: SERVER_ESM_BANNER }, plugins: [{ name: 'navigation-ai-fixture', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'navigation-ai-fixture' }))
      builder.onResolve({ filter: /\/subscription-ai-transport\.js$/ }, () => ({ path: 'transport', namespace: 'navigation-ai-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'navigation-ai-fixture' }, ({ path: file }) => ({
        contents: file === 'config' ? `
          import { mkdirSync } from 'node:fs';
          export const DB_FILE = ${JSON.stringify(path.join(workspace, 'app.db'))};
          export const REFRESH_DAYS = 30, PUBLIC_VIEW = false;
          export const ADMIN_USERNAME = 'navigation-fixture', ADMIN_PASSWORD = 'test-only';
          export const ENV_AGENT_TOKEN = 'fixture-agent', ENV_JWT_SECRET = 'fixture-navigation-ai-root';
          export function ensureDirs() { mkdirSync(${JSON.stringify(workspace)}, { recursive: true }); }
        ` : `
          export { normalizeAiBaseUrl, SubscriptionAiError } from ${JSON.stringify(path.join(root, 'src/lib/subscription-ai-transport.ts'))};
          export const requestAiCompletion = (...args) => globalThis.__navigationAiFixtureRequest(...args);
        `, resolveDir: root, loader: 'js',
      }))
    } }],
  })
  globalThis.__navigationAiFixtureRequest = (...args) => { calls.push(args); return respond(...args) }
  h = await import(pathToFileURL(bundleFile).href)
  h.initDatabase()
  h.sql.run("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (2, 'other-fixture', 'unused', 1, 1)")
  const first = h.createRefreshToken(1, 'fixture', null), second = h.createRefreshToken(2, 'fixture', null)
  token = await h.issueAccessToken({ id: 1, username: 'navigation-fixture' }, first.sessionId)
  otherToken = await h.issueAccessToken({ id: 2, username: 'other-fixture' }, second.sessionId)
})

beforeEach(() => {
  h.sql.exec('DROP TRIGGER IF EXISTS navigation_ai_fail; DELETE FROM sites; DELETE FROM folders; DELETE FROM categories; DELETE FROM subscription_ai_settings;')
  h.sql.run("INSERT INTO categories (id, name, icon, sort_order, created_at) VALUES (10, '原分组', 'Code', 4, 1), (20, '保留分组', 'Book', 9, 1)")
  h.sql.run("INSERT INTO folders (id, name, category_id, columns, rows, color, sort_order, created_at, updated_at) VALUES (30, '原文件夹', 10, 7, 9, '#123abc', 5, 1, 1), (40, '空文件夹', 20, 3, 2, '#abcdef', 8, 1, 1)")
  for (const [id, title, category, folder, order] of [[100, '开发工具一', 10, 30, 7], [101, '开发工具二', 10, 30, 3], [102, '工作资料', 20, null, 12], [103, '随手收藏', null, null, 6]]) {
    h.sql.run(`INSERT INTO sites (id, category_id, folder_id, title, description, url_public, url_lan, lan_port, link_mode, icon_url, icon_text, color, source, sort_order, clicks, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 9443, 'auto', ?, '图', '#112233', 'manual', ?, 11, 1, 1)`,
    id, category, folder, title, `private-description-${id}`, `https://fixture.example/${id}?secret=do-not-send`, `http://192.168.1.5/${id}`, `https://fixture.example/icon-${id}?token=private-icon`, order)
  }
  h.saveSubscriptionAiSettings(1, { api_key: 'fixture-private-ai-key' })
  h.saveSubscriptionAiSettings(2, { api_key: 'fixture-other-ai-key' })
  respond = async () => completion(plan())
  calls.length = 0
})

after(() => {
  h?.closeDb()
  if (originalTransport === undefined) delete globalThis.__navigationAiFixtureRequest
  else globalThis.__navigationAiFixtureRequest = originalTransport
  assert.equal(path.dirname(path.resolve(workspace)), path.resolve(tmpdir()))
  assert.ok(path.basename(workspace).startsWith('hd-navigation-ai-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

function request(action, body = {}, auth = token) {
  return h.navigationAiRoutes.request('/navigation/ai/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
  })
}
function snapshot() {
  return Object.fromEntries(['sites', 'categories', 'folders'].map(table => [table, h.sql.all(`SELECT * FROM ${table} ORDER BY id`).map(row => ({ ...row }))]))
}
function siteContents() {
  return h.sql.all('SELECT id,title,description,url_public,url_lan,lan_port,link_mode,icon_url,icon_text,color,source,created_at FROM sites ORDER BY id').map(row => ({ ...row }))
}
function layout(state) {
  return { sites: state.sites.map(({ id, category_id, folder_id, sort_order }) => ({ id, category_id, folder_id, sort_order })),
    categories: state.categories.map(({ id, name, icon, sort_order }) => ({ id, name, icon, sort_order })),
    folders: state.folders.map(({ id, name, category_id, columns, rows, color, sort_order }) => ({ id, name, category_id, columns, rows, color, sort_order })) }
}
async function success(action, body = {}, auth = token) {
  const response = await request(action, body, auth)
  assert.equal(response.status, 200, `${action}: ${await response.clone().text()}`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json()
}
async function rejected(action, body, auth = token) {
  const response = await request(action, body, auth)
  assert.ok(response.status >= 400 && response.status < 500, `${action} should reject: ${response.status} ${await response.clone().text()}`)
  return response
}

test('all organization actions require login and previews/tokens are bound to their account', async () => {
  const before = snapshot()
  for (const action of ['preview', 'apply', 'undo']) {
    const response = await request(action, {}, null)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const preview = await success('preview')
  await rejected('apply', { preview_token: preview.preview_token }, otherToken)
  assert.deepEqual(snapshot(), before)
  const applied = await success('apply', { preview_token: preview.preview_token })
  const afterApply = snapshot()
  await rejected('undo', { undo_token: applied.undo_token }, otherToken)
  assert.deepEqual(snapshot(), afterApply)
})

test('preview sends only explicit titles and structure to AI and never modifies navigation', async () => {
  const before = snapshot()
  const started = Date.now()
  await rejected('preview', { prompt: '按用途整理', url: 'https://malicious.example/should-not-send', api_key: 'injected-do-not-send' })
  assert.equal(calls.length, 0)
  const preview = await success('preview', { prompt: '按用途整理' })
  assert.deepEqual(snapshot(), before)
  assert.equal(typeof preview.preview_token, 'string')
  assert.ok(preview.preview_token.length >= 32)
  assert.ok(preview.expires_at > started && preview.expires_at <= Date.now() + 15 * 60_000 + 1000)
  assert.deepEqual(preview.groups, plan().groups)
  assert.equal(preview.summary, plan().summary)
  assert.equal(preview.model, 'deepseek-flash')
  assert.equal(calls.length, 1)
  const [base, key, body] = calls[0]
  assert.equal(base, 'https://api.deepseek.com')
  assert.equal(key, 'fixture-private-ai-key')
  const sent = JSON.stringify(body)
  for (const secret of ['private-description', 'do-not-send', '192.168.1.5', 'private-icon', 'fixture-private-ai-key']) assert.ok(!sent.includes(secret), secret)
  const context = JSON.parse(body.messages.find(message => message.role === 'user').content)
  assert.deepEqual(Object.keys(context).sort(), ['categories', 'folders', 'layout', 'request', 'sites'])
  assert.equal(context.request, '按用途整理')
  assert.deepEqual(context.categories, before.categories.map(({ id, name }) => ({ id, name })))
  assert.deepEqual(context.folders, before.folders.map(({ id, name, category_id }) => ({ id, name, category_id })))
  assert.deepEqual(context.layout, before.sites.map(({ id, category_id, folder_id, sort_order }) => ({ site_id: id, category_id, folder_id, sort_order })))
  const siteItems = context.sites
  assert.equal(siteItems.length, 4)
  assert.deepEqual(siteItems.map(site => site.id).sort((a, b) => a - b), [100, 101, 102, 103])
  assert.ok(siteItems.every(site => Object.keys(site).every(key => ['id', 'title'].includes(key))))
  assert.ok(!JSON.stringify(context).includes('clicks'))
  assert.deepEqual(preview.sites.map(({ id, title }) => ({ id, title })).sort((a, b) => a.id - b.id), siteItems)
  assert.equal(preview.sites.find(site => site.id === 100).url_public, before.sites.find(site => site.id === 100).url_public)
})

test('invalid, duplicate or omitted site identities cannot produce an applicable preview', async () => {
  const mutations = [
    value => { value.groups[0].site_ids = [999999] },
    value => { value.groups[0].site_ids.push(100) },
    value => { value.groups[1].folders[1].site_ids = [] },
    value => { value.groups[0].site_ids = ['103'] },
    value => { value.groups[0].site_ids = [-1] },
    value => { value.groups[0].category_id = 999999 },
    value => { value.groups[1].category_id = 10 },
    value => { value.groups[1].folders[0].folder_id = 999999 },
    value => { value.groups[1].folders[1].folder_id = 30 },
    value => { value.groups[0].name = '   ' },
    value => { value.groups[1].folders[1].name = '' },
    value => { value.groups[1].name = 'x'.repeat(1000) },
    value => { value.groups[1].folders[1].name = 'x\u0000y' },
  ]
  const before = snapshot()
  for (const change of mutations) {
    const invalid = plan(); change(invalid)
    respond = async () => completion(invalid)
    const response = await request('preview')
    assert.ok([400, 502].includes(response.status), `invalid model proposal: ${response.status}`)
    assert.deepEqual(snapshot(), before)
  }
})

test('malformed, truncated and unsupported model response shapes never write navigation', async () => {
  const before = snapshot()
  for (const value of ['not json', [], {}, { groups: [], summary: '' }, { ...plan(), sites: [{ id: 100, title: 'overwritten' }] }]) {
    respond = async () => completion(value)
    const response = await request('preview')
    assert.ok(response.status >= 400, await response.text())
    assert.deepEqual(snapshot(), before)
  }
  respond = async () => completion(plan(), 'length')
  assert.equal((await request('preview')).status, 502)
  assert.deepEqual(snapshot(), before)
})

test('apply preserves all site contents, uses folder categories consistently and preserves existing folder dimensions', async () => {
  const before = snapshot(), contents = siteContents()
  const preview = await success('preview')
  const result = await success('apply', { preview_token: preview.preview_token })
  assert.equal(result.ok, true)
  assert.equal(typeof result.undo_token, 'string')
  assert.ok(result.undo_expires_at > Date.now())
  assert.equal(result.sites.length, 4)
  assert.equal(result.categories.length, 3)
  assert.equal(result.folders.length, 3)
  assert.deepEqual(siteContents(), contents)
  const after = snapshot(), newCategory = after.categories.find(category => category.name === '开发工具')
  const newFolder = after.folders.find(folder => folder.name === '常用收藏')
  assert.ok(newCategory && newFolder)
  const oldFolder = after.folders.find(folder => folder.id === 30)
  assert.deepEqual([oldFolder.columns, oldFolder.rows, oldFolder.color], [7, 9, '#123abc'])
  assert.equal(oldFolder.category_id, newCategory.id)
  assert.equal(newFolder.category_id, newCategory.id)
  const byId = new Map(after.sites.map(site => [site.id, site]))
  assert.deepEqual([byId.get(100).category_id, byId.get(100).folder_id], [newCategory.id, 30])
  assert.deepEqual([byId.get(101).category_id, byId.get(101).folder_id], [newCategory.id, newFolder.id])
  assert.deepEqual([byId.get(102).category_id, byId.get(102).folder_id], [newCategory.id, null])
  assert.deepEqual([byId.get(103).category_id, byId.get(103).folder_id], [10, null])
  assert.ok(after.categories.find(category => category.id === 10).sort_order < newCategory.sort_order)
  assert.ok(oldFolder.sort_order < newFolder.sort_order)
  const untouchedFolder = after.folders.find(folder => folder.id === 40)
  assert.deepEqual([untouchedFolder.name, untouchedFolder.category_id, untouchedFolder.columns, untouchedFolder.rows, untouchedFolder.color], ['空文件夹', 20, 3, 2, '#abcdef'])
  const untouchedCategory = after.categories.find(category => category.id === 20)
  assert.deepEqual([untouchedCategory.name, untouchedCategory.icon], ['保留分组', 'Book'])
  assert.ok(after.sites.every(site => site.clicks === 11))
})

test('apply and undo are idempotent retries and undo removes only structures made by that application', async () => {
  const original = layout(snapshot()), contents = siteContents()
  const preview = await success('preview')
  const first = await success('apply', { preview_token: preview.preview_token })
  const applied = snapshot()
  const retry = await success('apply', { preview_token: preview.preview_token })
  assert.equal(retry.undo_token, first.undo_token)
  assert.deepEqual(snapshot(), applied)
  const undone = await success('undo', { undo_token: first.undo_token })
  assert.equal(undone.ok, true)
  assert.deepEqual(layout(snapshot()), original)
  assert.deepEqual(siteContents(), contents)
  const restored = snapshot()
  assert.equal((await success('undo', { undo_token: first.undo_token })).ok, true)
  assert.deepEqual(snapshot(), restored)
  assert.deepEqual(restored.categories.map(row => row.id), [10, 20])
  assert.deepEqual(restored.folders.map(row => row.id), [30, 40])
})

test('direct site order is applied exactly and restored by undo', async () => {
  respond = async () => completion({ summary: '统一顺序', groups: [{ category_id: 10, name: '原分组', site_ids: [103, 101, 100, 102], folders: [] }] })
  const original = layout(snapshot()), preview = await success('preview')
  const applied = await success('apply', { preview_token: preview.preview_token })
  assert.deepEqual(h.sql.all('SELECT id FROM sites ORDER BY sort_order,id').map(row => row.id), [103, 101, 100, 102])
  await success('undo', { undo_token: applied.undo_token })
  assert.deepEqual(layout(snapshot()), original)
})

test('edits to content or layout after preview prevent stale apply without overwriting the edit', async () => {
  for (const statement of ["UPDATE sites SET title = title || '改' WHERE id = 100", "UPDATE sites SET url_public = 'https://changed.example' WHERE id = 100",
    "UPDATE sites SET sort_order = sort_order + 1 WHERE id = 100", "UPDATE folders SET columns = columns + 1 WHERE id = 30", "UPDATE categories SET name = name || '改' WHERE id = 10"]) {
    const preview = await success('preview')
    h.sql.run(statement)
    const edited = snapshot()
    assert.equal((await request('apply', { preview_token: preview.preview_token })).status, 409)
    assert.deepEqual(snapshot(), edited)
  }
})

test('edits after applying prevent stale undo instead of restoring over new work', async () => {
  const preview = await success('preview')
  const applied = await success('apply', { preview_token: preview.preview_token })
  h.sql.run("UPDATE sites SET description = 'new manual description' WHERE id = 100")
  const edited = snapshot()
  assert.equal((await request('undo', { undo_token: applied.undo_token })).status, 409)
  assert.deepEqual(snapshot(), edited)
})

test('ordinary click increments do not invalidate previews or undo, and clicks are never rolled back', async () => {
  const original = layout(snapshot()), preview = await success('preview')
  h.sql.run('UPDATE sites SET clicks = clicks + 1 WHERE id = 100')
  const applied = await success('apply', { preview_token: preview.preview_token })
  h.sql.run('UPDATE sites SET clicks = clicks + 2 WHERE id = 100')
  await success('undo', { undo_token: applied.undo_token })
  assert.equal(h.sql.get('SELECT clicks FROM sites WHERE id = 100').clicks, 14)
  assert.deepEqual(layout(snapshot()), original)
})

test('idempotent response bodies preserve fresh click counts after both apply and undo', async () => {
  const preview = await success('preview'), applied = await success('apply', { preview_token: preview.preview_token })
  h.sql.run('UPDATE sites SET clicks = clicks + 3 WHERE id = 100')
  const applyRetry = await success('apply', { preview_token: preview.preview_token })
  assert.equal(applyRetry.sites.find(site => site.id === 100).clicks, 14)
  assert.equal(h.sql.get('SELECT clicks FROM sites WHERE id = 100').clicks, 14)
  await success('undo', { undo_token: applied.undo_token })
  h.sql.run('UPDATE sites SET clicks = clicks + 2 WHERE id = 100')
  const undoRetry = await success('undo', { undo_token: applied.undo_token })
  assert.equal(undoRetry.sites.find(site => site.id === 100).clicks, 16)
  assert.equal(h.sql.get('SELECT clicks FROM sites WHERE id = 100').clicks, 16)
})

test('retries after another device edits navigation must reject or return the current state, never cached old contents', async () => {
  const preview = await success('preview'), applied = await success('apply', { preview_token: preview.preview_token })
  h.sql.run("UPDATE sites SET title = 'edited-on-another-device', category_id = 20, folder_id = NULL WHERE id = 100")
  const edited = snapshot()
  const response = await request('apply', { preview_token: preview.preview_token })
  assert.ok([200, 409].includes(response.status))
  if (response.status === 200) {
    const site = (await response.json()).sites.find(site => site.id === 100)
    assert.deepEqual([site.title, site.category_id, site.folder_id], ['edited-on-another-device', 20, null])
  }
  assert.deepEqual(snapshot(), edited)
  assert.equal((await request('undo', { undo_token: applied.undo_token })).status, 409)
})

test('edits while AI is generating cannot be overwritten by the late proposal', async () => {
  let release
  respond = () => new Promise(resolve => { release = resolve })
  const generating = request('preview')
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(release)
  h.sql.run("UPDATE sites SET title = 'changed-during-generation' WHERE id = 100")
  const edited = snapshot()
  release(completion(plan()))
  const response = await generating
  assert.ok([200, 409].includes(response.status))
  if (response.status === 200) {
    const preview = await response.json()
    assert.equal((await request('apply', { preview_token: preview.preview_token })).status, 409)
  }
  assert.deepEqual(snapshot(), edited)
})

test('two previews of the same starting layout cannot both apply after the first moves sites', async () => {
  const first = await success('preview'), second = await success('preview', {}, otherToken)
  await success('apply', { preview_token: first.preview_token })
  const applied = snapshot()
  assert.equal((await request('apply', { preview_token: second.preview_token }, otherToken)).status, 409)
  assert.deepEqual(snapshot(), applied)
})

test('expired preview and undo tokens cannot mutate navigation', async () => {
  const originalNow = Date.now
  const preview = await success('preview')
  const before = snapshot()
  try {
    Date.now = () => preview.expires_at + 1
    await rejected('apply', { preview_token: preview.preview_token })
    assert.deepEqual(snapshot(), before)
  } finally { Date.now = originalNow }
  const next = await success('preview'), applied = await success('apply', { preview_token: next.preview_token })
  const after = snapshot()
  try {
    Date.now = () => applied.undo_expires_at + 1
    await rejected('undo', { undo_token: applied.undo_token })
    assert.deepEqual(snapshot(), after)
  } finally { Date.now = originalNow }
})

test('injected transaction failure rolls back all structures and site moves; same preview can retry', async () => {
  const before = snapshot(), preview = await success('preview')
  h.sql.exec("CREATE TRIGGER navigation_ai_fail BEFORE UPDATE ON sites WHEN OLD.id = 101 BEGIN SELECT RAISE(ABORT, 'fixture transaction failure'); END;")
  const failed = await request('apply', { preview_token: preview.preview_token })
  assert.ok(failed.status >= 400)
  assert.deepEqual(snapshot(), before)
  h.sql.exec('DROP TRIGGER navigation_ai_fail')
  const applied = await success('apply', { preview_token: preview.preview_token })
  const moved = snapshot()
  h.sql.exec("CREATE TRIGGER navigation_ai_fail BEFORE UPDATE ON sites WHEN OLD.id = 101 BEGIN SELECT RAISE(ABORT, 'fixture undo failure'); END;")
  assert.ok((await request('undo', { undo_token: applied.undo_token })).status >= 400)
  assert.deepEqual(snapshot(), moved)
  h.sql.exec('DROP TRIGGER navigation_ai_fail')
  await success('undo', { undo_token: applied.undo_token })
  assert.deepEqual(layout(snapshot()), layout(before))
})

test('untrusted token/body data never becomes an editable plan', async () => {
  const before = snapshot()
  for (const body of [null, [], {}, { preview_token: 'guessed' }, { preview_token: {}, groups: plan().groups }]) await rejected('apply', body)
  for (const body of [null, [], {}, { undo_token: 'guessed' }, { undo_token: {} }]) await rejected('undo', body)
  for (const body of [null, [], { prompt: 1 }, { prompt: 'x'.repeat(100000) }]) await rejected('preview', body)
  assert.deepEqual(snapshot(), before)
  assert.equal(calls.length, 0)
})

test('empty and oversized navigation is rejected before an AI request; the 300-site boundary is supported', async () => {
  h.sql.run('DELETE FROM sites')
  await rejected('preview', {})
  assert.equal(calls.length, 0)
  for (let id = 1000; id < 1300; id++) h.sql.run("INSERT INTO sites (id,title,url_public,created_at,updated_at) VALUES (?,?,'https://fixture.example',1,1)", id, `站点 ${id}`)
  respond = async () => completion({ summary: '统一整理', groups: [{ category_id: 10, name: '原分组', site_ids: Array.from({ length: 300 }, (_, index) => 1000 + index), folders: [] }] })
  assert.equal((await success('preview')).groups[0].site_ids.length, 300)
  h.sql.run("INSERT INTO sites (id,title,created_at,updated_at) VALUES (1300,'超限站点',1,1)")
  const before = snapshot(), count = calls.length
  await rejected('preview', {})
  assert.equal(calls.length, count)
  assert.deepEqual(snapshot(), before)
})

test('structure limit counts retained empty structures and prevents proposals from exceeding capacity', async () => {
  for (let id = 1000; id < 1596; id++) h.sql.run('INSERT INTO categories (id,name,sort_order,created_at) VALUES (?,?,0,1)', id, `保留空分组 ${id}`)
  const before = snapshot()
  assert.equal(before.categories.length + before.folders.length, 600)
  assert.equal((await request('preview')).status, 502)
  assert.deepEqual(snapshot(), before)
  respond = async () => completion({ summary: '复用原分组', groups: [{ category_id: 10, name: '原分组', site_ids: [100, 101, 102, 103], folders: [] }] })
  const preview = await success('preview')
  assert.equal(preview.groups[0].site_ids.length, 4)
  h.sql.run("INSERT INTO categories (id,name,sort_order,created_at) VALUES (2000,'超限空分组',0,1)")
  const count = calls.length, oversized = snapshot()
  await rejected('preview', {})
  assert.equal(calls.length, count)
  assert.deepEqual(snapshot(), oversized)
})
