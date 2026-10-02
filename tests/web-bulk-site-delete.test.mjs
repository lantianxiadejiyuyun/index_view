import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('../app/web/src/store/app.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
})
let instance = 0
async function createStore(t) {
  const previousWindow = globalThis.window
  globalThis.window = { location: { hostname: 'fixture.example' } }
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  const source = `${bundle.outputFiles[0].text}\n// fresh store ${instance++}`
  const { useApp } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  return useApp
}

const fixtures = () => ({
  sites: [{ id: 1, title: '保留', folder_id: 10, url_public: 'https://fixture.example/one' }, { id: 2, title: '删除', folder_id: null, url_public: 'https://fixture.example/two' }],
  folders: [{ id: 10, name: '保留文件夹', category_id: 20 }],
  categories: [{ id: 20, name: '保留分组' }],
  rawSettings: { wallpaper_url: '/wallpaper.jpg', desktop_layout: JSON.stringify({ version: 1, wide: { 'site:2': { col: 4, row: 3 } }, compact: {} }) },
  status: 'ready', canEdit: true, editMode: true,
})

test('bulk delete waits for success, uses server state and preserves the current page and settings', async (t) => {
  const store = await createStore(t), before = fixtures()
  store.setState(before)
  let complete
  const calls = []
  t.mock.method(globalThis, 'fetch', (path, init) => {
    calls.push({ path, method: init.method, body: JSON.parse(init.body) })
    return new Promise((resolve) => { complete = resolve })
  })
  const pending = store.getState().bulkDeleteSites({ ids: [2] })
  assert.deepEqual(store.getState().sites, before.sites)
  assert.equal(store.getState().status, 'ready')
  // Include another device's newly added icon to prove the returned list is authoritative.
  const remaining = [before.sites[0], { id: 3, title: '另一设备新增', url_public: 'https://fixture.example/three' }]
  const layout = { version: 1, wide: { 'folder:10': { col: 2, row: 1 } }, compact: {} }
  complete(new Response(JSON.stringify({ sites: remaining, deleted_count: 1, desktop_layout: layout })))
  assert.equal(await pending, 1)
  assert.deepEqual(calls, [{ path: '/api/sites/bulk-delete', method: 'POST', body: { ids: [2] } }])
  assert.deepEqual(store.getState().sites, remaining)
  assert.deepEqual(store.getState().folders, before.folders)
  assert.deepEqual(store.getState().categories, before.categories)
  assert.equal(store.getState().rawSettings.wallpaper_url, before.rawSettings.wallpaper_url)
  assert.deepEqual(JSON.parse(store.getState().rawSettings.desktop_layout), layout)
  assert.equal(store.getState().status, 'ready')
  assert.equal(store.getState().editMode, true)
})

test('failed deletion leaves every icon and saved desktop position available for retry', async (t) => {
  const store = await createStore(t), before = fixtures()
  store.setState(before)
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'bad_request', message: '图标已变化，请重新选择' }), { status: 400 }))
  await assert.rejects(store.getState().bulkDeleteSites({ ids: [2] }), { message: '图标已变化，请重新选择' })
  assert.deepEqual(store.getState().sites, before.sites)
  assert.deepEqual(store.getState().rawSettings, before.rawSettings)
  assert.equal(store.getState().status, 'ready')
})

test('delete-all sends the explicit confirmation and keeps empty folders and groups', async (t) => {
  const store = await createStore(t), before = fixtures(), calls = []
  store.setState(before)
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ sites: [], deleted_count: 2, desktop_layout: { version: 1, wide: {}, compact: {} } }))
  })
  assert.equal(await store.getState().bulkDeleteSites({ all: true, confirm: 'delete-all-sites', expected_ids: [1, 2] }), 2)
  assert.deepEqual(calls, [{ path: '/api/sites/bulk-delete', body: { all: true, confirm: 'delete-all-sites', expected_ids: [1, 2] } }])
  assert.deepEqual(store.getState().sites, [])
  assert.deepEqual(store.getState().folders, before.folders)
  assert.deepEqual(store.getState().categories, before.categories)
})

test('a changed delete-all review does not mutate state and can refresh without unmounting the page', async (t) => {
  const store = await createStore(t), before = fixtures(), calls = []
  store.setState(before)
  const refreshedSites = [...before.sites, { id: 3, title: '另一设备新增', folder_id: null }]
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, method: init.method ?? 'GET' })
    if (path === '/api/sites/bulk-delete') {
      assert.deepEqual(JSON.parse(init.body).expected_ids, [1, 2])
      return new Response(JSON.stringify({ error: 'sites_changed', message: '图标清单已变更，请刷新清单后重新确认' }), { status: 409 })
    }
    assert.equal(init.cache, 'no-store')
    return new Response(JSON.stringify({ sites: refreshedSites, folders: before.folders, categories: before.categories, settings: { wallpaper_url: '/new-wallpaper.jpg', desktop_layout: 'updated-layout' } }))
  })
  await assert.rejects(store.getState().bulkDeleteSites({ all: true, confirm: 'delete-all-sites', expected_ids: [1, 2] }), { status: 409, code: 'sites_changed' })
  assert.deepEqual(store.getState().sites, before.sites)
  assert.deepEqual(store.getState().rawSettings, before.rawSettings)
  const statuses = []
  const unsubscribe = store.subscribe((state) => statuses.push(state.status))
  assert.deepEqual(await store.getState().refreshSitesForDeletion(), refreshedSites)
  unsubscribe()
  assert.deepEqual(statuses, ['ready'])
  assert.equal(store.getState().editMode, true)
  assert.equal(store.getState().rawSettings.desktop_layout, 'updated-layout')
  assert.equal(store.getState().rawSettings.wallpaper_url, '/wallpaper.jpg')
  assert.deepEqual(calls, [{ path: '/api/sites/bulk-delete', method: 'POST' }, { path: '/api/bootstrap', method: 'GET' }])
})

test('bootstrap retries silent restoration after a temporary refresh connection failure', async (t) => {
  const store = await createStore(t)
  let refreshes = 0
  const before = fixtures()
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/api/auth/refresh') {
      if (++refreshes === 1) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ access_token: 'fixture-access-token' }))
    }
    assert.equal(path, '/api/bootstrap')
    const loggedIn = init.headers.get('Authorization') === 'Bearer fixture-access-token'
    return new Response(JSON.stringify({ ...before, settings: {}, user: loggedIn ? { id: 1, username: 'fixture' } : null, can_edit: loggedIn }))
  })
  await store.getState().bootstrap()
  assert.equal(store.getState().status, 'error')
  await store.getState().bootstrap()
  assert.equal(refreshes, 2)
  assert.equal(store.getState().status, 'ready')
  assert.equal(store.getState().canEdit, true)
})
