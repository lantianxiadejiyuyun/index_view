import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

function bundle(path) {
  return buildSync({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
}
const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const storeCode = bundle('../app/web/src/store/app.ts')
const { normalizeSettings } = await load(bundle('../app/web/src/lib/settings.ts'))
const { desktopSettingsItems, visibleDesktopWidgetNames } = await load(bundle('../app/web/src/lib/desktop-settings-layout.ts'))
const { desktopOccupants, overlaps } = await load(bundle('../app/web/src/lib/desktop-layout.ts'))
const originalGlobals = Object.fromEntries(['window', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
after(() => { for (const [key, descriptor] of Object.entries(originalGlobals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
const empty = () => ({ version: 1, wide: {}, compact: {} })
const site = (id, folder_id = null) => ({ id, folder_id, category_id: null, title: `fixture ${id}`, sort_order: id, link_mode: 'public' })
const folder = (id = 10) => ({ id, name: 'fixture folder', category_id: null, columns: 1, rows: 1, sort_order: id })
const disabled = Object.fromEntries(['clock', 'calendar', 'weather', 'hitokoto', 'workbench', 'lingxi_calendar', 'lingxi_schedule', 'lingxi_deadline', 'lingxi_chat'].map(name => [`show_${name}`, 'false']))
let generation = 0
async function fixture(options = {}) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hostname: 'fixture.example' } } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } })
  const { useApp } = await load(`${storeCode}\n// restore fixture ${++generation}`)
  const layouts = { desktop: empty(), home: empty() }
  for (const [scopeIndex, scope] of ['desktop', 'home'].entries()) for (const [viewIndex, viewport] of ['wide', 'compact'].entries()) {
    const row = 2 + scopeIndex * 4 + viewIndex
    layouts[scope][viewport] = {
      'folder:10': { col: 3, row: 12 },
      'site:1': { col: 0, row },
      'site:2': { col: 1, row },
      'site:3': { col: 0, row },
      'widget:search': { col: 0, row: 20, width: 4, height: 1 },
    }
  }
  Object.assign(layouts, options.layouts)
  const settings = normalizeSettings({ ...disabled, desktop_header_mode: 'hero', home_mode: options.homeMode ?? 'navigation' })
  const rawSettings = { ...disabled, desktop_header_mode: 'hero', home_mode: settings.home_mode, untouched: 'keep', desktop_layout: JSON.stringify(layouts.desktop), home_layout: JSON.stringify(layouts.home) }
  const sites = options.sites ?? [site(1, 10), site(2, 10), site(3), site(4)]
  const folders = options.folders ?? [folder()]
  useApp.setState({ status: 'ready', user: { id: 1, username: 'fixture' }, canEdit: true, sites: structuredClone(sites), folders: structuredClone(folders), settings, rawSettings, netMode: 'public' })
  return { store: useApp, layouts: structuredClone(layouts), sites: structuredClone(sites), folders: structuredClone(folders), calls: [], before: { layouts: structuredClone(layouts), sites: structuredClone(sites), folders: structuredClone(folders) } }
}
function mockServer(fixture, reject) {
  globalThis.fetch = async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    const call = { path, method: init.method, body }
    fixture.calls.push(call)
    if (reject?.(call, fixture)) throw new TypeError('Failed to fetch')
    if (path === '/api/desktop/layout') {
      assert.equal(init.method, 'PATCH')
      assert.ok(body.scope === 'desktop' || body.scope === 'home')
      assert.ok(body.placements.length <= 500)
      // Membership must remain unchanged until every layout request has succeeded.
      assert.deepEqual(fixture.store.getState().sites, fixture.before.sites)
      assert.deepEqual(fixture.store.getState().folders, fixture.before.folders)
      for (const { id, ...position } of body.placements) fixture.layouts[body.scope][body.viewport][id] = { ...fixture.layouts[body.scope][body.viewport][id], ...position }
      return Response.json({ layout: fixture.layouts[body.scope] })
    }
    const id = Number(path.split('/').at(-1))
    if (path.startsWith('/api/sites/')) {
      assert.equal(init.method, 'PUT')
      fixture.sites = fixture.sites.map(item => item.id === id ? { ...item, ...body } : item)
      return Response.json({ site: fixture.sites.find(item => item.id === id) })
    }
    assert.equal(path, `/api/folders/${id}`)
    if (init.method === 'DELETE') {
      fixture.sites = fixture.sites.map(item => item.folder_id === id ? { ...item, folder_id: null } : item)
      fixture.folders = fixture.folders.filter(item => item.id !== id)
      return Response.json({ sites: fixture.sites })
    }
    assert.equal(init.method, 'PUT')
    fixture.folders = fixture.folders.map(item => item.id === id ? { ...item, ...body } : item)
    if (body.site_ids) {
      fixture.sites = fixture.sites.map(item => body.site_ids.includes(item.id)
        ? { ...item, folder_id: id, sort_order: body.site_ids.indexOf(item.id) }
        : item.folder_id === id ? { ...item, folder_id: null } : item)
    }
    return Response.json({ folder: fixture.folders.find(item => item.id === id), sites: fixture.sites })
  }
}
function assertLayoutsAndMembers(fixture) {
  const state = fixture.store.getState()
  assert.deepEqual(state.sites, fixture.sites)
  assert.deepEqual(state.folders, fixture.folders)
  assert.equal(state.rawSettings.untouched, 'keep')
  for (const scope of ['desktop', 'home']) {
    assert.deepEqual(JSON.parse(state.rawSettings[`${scope}_layout`]), fixture.layouts[scope])
    for (const view of ['wide', 'compact']) {
      if (!Object.keys(fixture.before.layouts[scope][view]).length) {
        assert.deepEqual(fixture.layouts[scope][view], {})
        continue
      }
      const names = visibleDesktopWidgetNames(state.settings, true, scope)
      const before = desktopOccupants(desktopSettingsItems(names, fixture.before.folders, fixture.before.sites, fixture.before.layouts[scope], view), fixture.before.layouts[scope], view)
      const current = desktopOccupants(desktopSettingsItems(names, state.folders, state.sites, fixture.layouts[scope], view), fixture.layouts[scope], view)
      for (const item of before) {
        const remaining = current.find(other => other.id === item.id)
        if (remaining) assert.deepEqual(remaining, item, `${scope}/${view}: existing tile moved`)
      }
      for (const site of fixture.before.sites.filter(item => item.folder_id != null)) {
        const restored = current.find(item => item.id === `site:${site.id}`)
        if (restored) assert.ok(current.every(item => item.id === restored.id || !overlaps(item, restored)), `${scope}/${view}: restored tile overlaps`)
      }
    }
  }
}
const operations = [
  { name: 'updateSite', path: '/api/sites/1', method: 'PUT', invoke: store => store.getState().updateSite(1, { folder_id: null }) },
  { name: 'updateFolder', path: '/api/folders/10', method: 'PUT', invoke: store => store.getState().updateFolder(10, { site_ids: [] }) },
  { name: 'deleteFolder', path: '/api/folders/10', method: 'DELETE', invoke: store => store.getState().deleteFolder(10) },
]

for (const operation of operations) {
  test(`${operation.name} saves independent home/desktop placements before changing membership`, async () => {
    const f = await fixture()
    mockServer(f)
    await operation.invoke(f.store)
    assert.equal(f.calls.at(-1).path, operation.path)
    assert.equal(f.calls.at(-1).method, operation.method)
    const writes = f.calls.slice(0, -1)
    assert.ok(writes.length >= 4)
    assert.ok(writes.every(call => call.path === '/api/desktop/layout'))
    assert.deepEqual(new Set(writes.map(call => `${call.body.scope}/${call.body.viewport}`)), new Set(['desktop/wide', 'desktop/compact', 'home/wide', 'home/compact']))
    const firstRestore = writes.findIndex(call => call.body.placements.some(item => item.id === 'site:1'))
    assert.ok(firstRestore > 0)
    assert.ok(writes.slice(firstRestore).every(call => call.body.placements.some(item => item.id === 'site:1')))
    assertLayoutsAndMembers(f)
    const restored = ['desktop', 'home'].flatMap(scope => ['wide', 'compact'].map(view => f.layouts[scope][view]['site:1']))
    assert.equal(new Set(restored.map(position => position.row)).size, 4)
  })

  test(`${operation.name} stops before membership on a later layout network failure and can retry`, async () => {
    const f = await fixture()
    mockServer(f, call => call.path === '/api/desktop/layout' && call.body.scope === 'home')
    await assert.rejects(operation.invoke(f.store), /无法连接服务器/)
    assert.ok(f.calls.length > 1)
    assert.ok(f.calls.every(call => call.path === '/api/desktop/layout'))
    assert.deepEqual(f.store.getState().sites, f.before.sites)
    assert.deepEqual(f.store.getState().folders, f.before.folders)
    assert.deepEqual(f.sites, f.before.sites)
    assert.deepEqual(f.folders, f.before.folders)
    // Successfully frozen positions are kept, so retry plans from committed state.
    assert.deepEqual(JSON.parse(f.store.getState().rawSettings.desktop_layout), f.layouts.desktop)
    mockServer(f)
    await operation.invoke(f.store)
    assertLayoutsAndMembers(f)
  })
}

test('membership failure leaves folder members hidden and prepared positions safe for retry', async () => {
  const f = await fixture()
  mockServer(f, call => call.path === '/api/folders/10')
  await assert.rejects(f.store.getState().deleteFolder(10), /无法连接服务器/)
  assert.deepEqual(f.store.getState().sites, f.before.sites)
  assert.deepEqual(f.store.getState().folders, f.before.folders)
  const prepared = structuredClone(f.layouts)
  f.calls = []
  mockServer(f)
  await f.store.getState().deleteFolder(10)
  assert.deepEqual(f.layouts, prepared)
  assertLayoutsAndMembers(f)
})

test('failure on the final restore keeps partially prepared icons hidden until a successful retry', async () => {
  const f = await fixture()
  mockServer(f, call => call.path === '/api/desktop/layout' && call.body.scope === 'home' && call.body.viewport === 'compact' && call.body.placements.some(item => item.id === 'site:1'))
  await assert.rejects(f.store.getState().updateSite(1, { folder_id: null }), /无法连接服务器/)
  assert.ok(f.calls.every(call => call.path === '/api/desktop/layout'))
  assert.notDeepEqual(f.layouts.desktop.wide['site:1'], f.before.layouts.desktop.wide['site:1'])
  assert.notDeepEqual(f.layouts.home.wide['site:1'], f.before.layouts.home.wide['site:1'])
  assert.deepEqual(f.layouts.home.compact['site:1'], f.before.layouts.home.compact['site:1'])
  assert.deepEqual(f.store.getState().sites, f.before.sites)
  assert.deepEqual(f.store.getState().folders, f.before.folders)
  mockServer(f)
  await f.store.getState().updateSite(1, { folder_id: null })
  assertLayoutsAndMembers(f)
})

test('the selected page mode cannot cross-copy positions or initialize unused views', async () => {
  for (const homeMode of ['navigation', 'desktop']) {
    const desktop = empty(), home = empty()
    desktop.compact = { 'folder:10': { col: 3, row: 4 }, 'site:1': { col: 2, row: 6 } }
    home.wide = { 'widget:search': { col: 0, row: 0, width: 4, height: 1 }, 'site:1': { col: 7, row: 9 } }
    const f = await fixture({ homeMode, layouts: { desktop, home } })
    mockServer(f)
    await f.store.getState().updateSite(1, { folder_id: null })
    const writes = f.calls.filter(call => call.path === '/api/desktop/layout')
    assert.deepEqual(new Set(writes.map(call => `${call.body.scope}/${call.body.viewport}`)), new Set(['desktop/compact', 'home/wide']))
    assert.deepEqual(f.layouts.desktop.compact['site:1'], { col: 2, row: 6 })
    assert.deepEqual(f.layouts.home.wide['site:1'], { col: 7, row: 9 })
    assertLayoutsAndMembers(f)
  }
})

test('ordinary editing and moving into a folder do not make restoration writes', async () => {
  for (const operation of [store => store.getState().updateSite(1, { title: 'new name' }), store => store.getState().updateSite(3, { folder_id: 10 }), store => store.getState().updateFolder(10, { name: 'renamed' }), store => store.getState().updateFolder(10, { site_ids: [1, 2, 3] })]) {
    const f = await fixture()
    mockServer(f)
    await operation(f.store)
    assert.equal(f.calls.length, 1)
    assert.notEqual(f.calls[0].path, '/api/desktop/layout')
    assert.deepEqual(f.layouts, f.before.layouts)
  }
})

test('releasing folder members does not initialize any layout when all views were unused', async () => {
  const f = await fixture({ layouts: { desktop: empty(), home: empty() } })
  mockServer(f)
  await f.store.getState().updateFolder(10, { site_ids: [] })
  assert.deepEqual(f.calls.map(call => call.path), ['/api/folders/10'])
  assertLayoutsAndMembers(f)
})
