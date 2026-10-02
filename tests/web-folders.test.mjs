import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const code = buildSync({ entryPoints: [fileURLToPath(new URL('../app/web/src/store/app.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
const saved = Object.fromEntries(['window', 'localStorage', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
let generation = 0
async function fixture() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hostname: 'fixture.example' } } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } })
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${++generation}`)).useApp
}
const folder = { id: 9, category_id: 1, name: '工作', columns: 2, rows: 2, color: null, sort_order: 0 }
const site = { id: 3, category_id: 1, folder_id: null, title: '文档', sort_order: 0, url_public: 'https://example.com', url_lan: null }

test('folder mutations use server membership results without leaving duplicated root cards', async () => {
  const store = await fixture()
  store.setState({ categories: [{ id: 1, name: '常用' }], sites: [site], editMode: true })
  let request
  globalThis.fetch = async (url, init) => { request = { url, method: init.method, body: JSON.parse(init.body) }; return Response.json({ folder, sites: [{ ...site, folder_id: 9 }] }) }
  await store.getState().createFolder({ name: '工作', category_id: 1, columns: 2, rows: 2, site_ids: [3] })
  assert.equal(request.url, '/api/folders')
  assert.deepEqual(request.body.site_ids, [3])
  assert.deepEqual(store.getState().folders, [folder])
  assert.equal(store.getState().sites[0].folder_id, 9)
  assert.equal(store.getState().editMode, true)
  globalThis.fetch = async () => Response.json({ folder: { ...folder, category_id: 2, columns: 4, rows: 3 }, sites: [{ ...site, category_id: 2, folder_id: 9 }] })
  await store.getState().updateFolder(9, { category_id: 2, columns: 4, rows: 3 })
  assert.equal(store.getState().folders[0].columns, 4)
  assert.equal(store.getState().sites[0].category_id, 2)
  globalThis.fetch = async () => Response.json({ sites: [{ ...site, category_id: 2 }] })
  await store.getState().deleteFolder(9)
  assert.deepEqual(store.getState().folders, [])
  assert.equal(store.getState().sites.length, 1)
  assert.equal(store.getState().sites[0].folder_id, null)
})

test('failed folder mutation preserves folders and their members', async () => {
  const store = await fixture()
  store.setState({ folders: [folder], sites: [{ ...site, folder_id: 9 }] })
  globalThis.fetch = async () => Response.json({ error: 'invalid_value', message: '尺寸无效' }, { status: 400 })
  await assert.rejects(store.getState().updateFolder(9, { columns: 99 }))
  await assert.rejects(store.getState().deleteFolder(9))
  assert.deepEqual(store.getState().folders, [folder])
  assert.equal(store.getState().sites[0].folder_id, 9)
})

test('category detach keeps folder membership while category delete removes both', async () => {
  for (const mode of ['detach', 'delete']) {
    const store = await fixture()
    store.setState({ categories: [{ id: 1, name: '常用' }], folders: [folder], sites: [{ ...site, folder_id: 9 }] })
    globalThis.fetch = async () => Response.json({ ok: true })
    await store.getState().deleteCategory(1, mode)
    assert.deepEqual(store.getState().categories, [])
    if (mode === 'detach') {
      assert.equal(store.getState().folders[0].category_id, null)
      assert.equal(store.getState().sites[0].category_id, null)
      assert.equal(store.getState().sites[0].folder_id, 9)
    } else {
      assert.deepEqual(store.getState().folders, [])
      assert.deepEqual(store.getState().sites, [])
    }
  }
})

test('old bootstrap payload clears stale folders and still loads sites', async () => {
  const store = await fixture()
  store.setState({ folders: [folder] })
  globalThis.fetch = async () => Response.json({ user: { id: 1, username: 'fixture' }, can_edit: true, settings: {}, categories: [], sites: [site] })
  await store.getState().bootstrap()
  assert.deepEqual(store.getState().folders, [])
  assert.deepEqual(store.getState().sites, [site])
})
