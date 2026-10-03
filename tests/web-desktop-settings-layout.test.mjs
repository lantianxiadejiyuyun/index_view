import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

function bundle(path) {
  return buildSync({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
}
const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const { planDesktopSettingsLayout, desktopSettingsItems, visibleDesktopWidgetNames } = await load(bundle('../app/web/src/lib/desktop-settings-layout.ts'))
const { normalizeSettings } = await load(bundle('../app/web/src/lib/settings.ts'))
const { desktopOccupants, overlaps } = await load(bundle('../app/web/src/lib/desktop-layout.ts'))
const storeCode = bundle('../app/web/src/store/app.ts')
const disabled = Object.fromEntries(['clock', 'calendar', 'weather', 'hitokoto', 'workbench', 'lingxi_calendar', 'lingxi_schedule', 'lingxi_deadline', 'lingxi_chat'].map(name => [`show_${name}`, 'false']))
const settings = patch => normalizeSettings({ ...disabled, desktop_header_mode: 'hero', ...Object.fromEntries(Object.entries(patch ?? {}).map(([key, value]) => [key, String(value)])) })
const empty = () => ({ version: 1, wide: {}, compact: {} })
const site = (id, sort_order = id, folder_id = null) => ({ id, sort_order, folder_id })
const folder = (id, columns, rows, sort_order = id) => ({ id, columns, rows, sort_order })
const plan = (before, after, layout = empty(), sites = [], folders = [], authenticated = true) => planDesktopSettingsLayout({ before, after, layout, sites, folders, authenticated })
function applyPlan(layout, result) {
  const next = structuredClone(layout)
  for (const batch of [...result.freeze, ...result.restore]) for (const { id, ...position } of batch.placements) next[batch.viewport][id] = { ...next[batch.viewport][id], ...position }
  return next
}

test('unrelated settings and hero clock changes never plan desktop writes', () => {
  const before = settings()
  for (const patch of [{ site_title: 'new' }, { theme: 'dark' }, { show_clock: true }, { desktop_header_mode: 'hero' }]) assert.equal(plan(before, settings(patch)), null)
  assert.equal(plan(before, settings({ show_lingxi_chat: true }), empty(), [], [], false), null)
  assert.deepEqual(visibleDesktopWidgetNames(settings({ desktop_header_mode: 'widgets', show_clock: false }), true), ['search'])
})

test('initial ordering matches the desktop and excludes folder members while keeping orphaned sites', () => {
  const folders = [folder(8, 9, 3, 1), folder(3, 2, 1, 0)]
  const sites = [site(4, 5), site(2, 1, 8), site(5, 2, 999), site(1, 0)]
  const original = structuredClone({ folders, sites })
  const items = desktopSettingsItems(['calendar', 'weather', 'lingxi-chat'], folders, sites, empty(), 'compact')
  assert.deepEqual(items.map(item => item.id), ['widget:calendar', 'widget:weather', 'folder:3', 'folder:8', 'site:1', 'site:5', 'site:4', 'widget:lingxi-chat'])
  assert.equal(items.find(item => item.id === 'folder:8').width, 4)
  assert.deepEqual({ folders, sites }, original)
})

test('hiding freezes both device layouts including the hidden tile and does not discard stored dimensions', () => {
  const before = settings({ show_weather: true, show_workbench: true })
  const after = settings({ show_weather: false, show_workbench: true })
  const layout = empty()
  layout.wide['widget:weather'] = { col: 3, row: 6, width: 2, height: 1 }
  const sites = [site(1), site(2)]
  const result = plan(before, after, layout, sites)
  assert.deepEqual(result.restore, [])
  assert.deepEqual(result.freeze.map(batch => batch.viewport), ['wide', 'compact'])
  const persisted = applyPlan(layout, result)
  assert.deepEqual(persisted.wide['widget:weather'], layout.wide['widget:weather'])
  for (const view of ['wide', 'compact']) {
    const previous = desktopOccupants(desktopSettingsItems(visibleDesktopWidgetNames(before, true), [], sites, layout, view), layout, view)
    const visible = desktopOccupants(desktopSettingsItems(visibleDesktopWidgetNames(after, true), [], sites, persisted, view), persisted, view)
    for (const item of visible) assert.deepEqual(item, previous.find(old => old.id === item.id))
    assert.ok(persisted[view]['widget:weather'])
  }
})

test('restoring keeps an empty desktop position and relocates only the conflicting mobile widget', () => {
  const layout = empty()
  layout.wide = { 'site:1': { col: 0, row: 0 }, 'widget:weather': { col: 8, row: 5, width: 2, height: 1 } }
  layout.compact = { 'site:1': { col: 0, row: 2 }, 'widget:weather': { col: 0, row: 2, width: 4, height: 3 } }
  const original = structuredClone(layout)
  const result = plan(settings(), settings({ show_weather: true }), layout, [site(1)])
  const persisted = applyPlan(layout, result)
  assert.deepEqual(persisted.wide['widget:weather'], layout.wide['widget:weather'])
  assert.deepEqual(persisted.compact['widget:weather'], { col: 0, row: 3, width: 4, height: 3 })
  assert.deepEqual(result.relocated, [{ id: 'widget:weather', viewport: 'compact' }])
  for (const view of ['wide', 'compact']) assert.deepEqual(persisted[view]['site:1'], layout[view]['site:1'])
  assert.deepEqual(layout, original)
})

test('hero to widgets reserves all free saved restoration targets before relocating conflicts', () => {
  const layout = empty()
  layout.wide = { 'site:1': { col: 0, row: 0 }, 'widget:clock': { col: 0, row: 0, width: 3, height: 2 }, 'widget:search': { col: 3, row: 0, width: 5, height: 1 } }
  const before = settings({ show_clock: true })
  const result = plan(before, { ...before, desktop_header_mode: 'widgets' }, layout, [site(1)])
  const wide = result.restore.find(batch => batch.viewport === 'wide').placements
  assert.deepEqual(wide.find(item => item.id === 'widget:search'), { id: 'widget:search', ...layout.wide['widget:search'] })
  assert.ok(wide.every(item => !overlaps(item, { id: 'site:1', width: 1, height: 1, ...layout.wide['site:1'] })))
  assert.equal(overlaps(wide[0], wide[1]), false)
  assert.equal(result.restore.find(batch => batch.viewport === 'compact').placements.length, 2)
})

test('one patch can hide one widget and reuse its space for a restored widget without moving icons', () => {
  const before = settings({ show_weather: true })
  const after = settings({ show_workbench: true })
  const layout = empty()
  for (const view of ['wide', 'compact']) layout[view] = {
    'widget:weather': { col: 0, row: 3, width: 2, height: 1 },
    'widget:workbench': { col: 0, row: 3, width: 2, height: 1 },
    'site:1': { col: 3, row: 5 },
  }
  const result = plan(before, after, layout, [site(1)])
  assert.deepEqual(result.relocated, [])
  for (const view of ['wide', 'compact']) {
    const persisted = applyPlan(layout, result)[view]
    assert.deepEqual(persisted['widget:workbench'], layout[view]['widget:workbench'])
    assert.deepEqual(persisted['site:1'], layout[view]['site:1'])
  }
})

test('home always includes the search and enabled clock even when desktop uses its hero', () => {
  const before = settings({ show_clock: true })
  assert.deepEqual(visibleDesktopWidgetNames(before, true, 'home'), ['clock', 'search'])
  assert.deepEqual(visibleDesktopWidgetNames(before, true), [])
  const layout = empty()
  layout.wide['widget:clock'] = { col: 3, row: 5, width: 2, height: 1 }
  assert.equal(planDesktopSettingsLayout({ before, after: { ...before, desktop_header_mode: 'widgets' }, authenticated: true, folders: [], sites: [], layout, scope: 'home' }), null)
  const hidden = planDesktopSettingsLayout({ before, after: { ...before, show_clock: false }, authenticated: true, folders: [], sites: [], layout, scope: 'home' })
  assert.deepEqual(hidden.freeze.map(batch => batch.viewport), ['wide'])
  assert.equal(hidden.freeze[0].placements[0].id, 'widget:search')
  assert.deepEqual(hidden.restore, [])
})

test('settings changes leave uninitialized home viewports empty and preserve only existing home layouts', () => {
  const before = settings(), after = settings({ show_weather: true })
  const args = { before, after, authenticated: true, folders: [], sites: [site(1)], scope: 'home' }
  assert.equal(planDesktopSettingsLayout({ ...args, layout: empty() }), null)
  const layout = empty()
  layout.wide['site:1'] = { col: 9, row: 8 }
  const result = planDesktopSettingsLayout({ ...args, layout })
  assert.ok(result.freeze.every(batch => batch.viewport === 'wide'))
  assert.ok(result.restore.every(batch => batch.viewport === 'wide'))
  const persisted = applyPlan(layout, result)
  assert.deepEqual(persisted.wide['site:1'], layout.wide['site:1'])
  assert.deepEqual(persisted.compact, {})
  assert.ok(persisted.wide['widget:search'])
  assert.ok(persisted.wide['widget:weather'])
})

const savedGlobals = Object.fromEntries(['window', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
after(() => { for (const [key, descriptor] of Object.entries(savedGlobals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
let generation = 0
async function storeFixture(initial, layout = empty(), sites = [site(1)], homeLayout) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hostname: 'fixture.example' } } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } })
  const { useApp } = await load(`${storeCode}\n// store ${++generation}`)
  const raw = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, String(value)]))
  raw.desktop_layout = JSON.stringify(layout)
  if (homeLayout) raw.home_layout = JSON.stringify(homeLayout)
  useApp.setState({ settings: initial, rawSettings: raw, user: { id: 1, username: 'fixture' }, sites, folders: [] })
  return { store: useApp, serverSettings: { ...raw }, serverLayout: structuredClone(layout), serverHomeLayout: structuredClone(homeLayout ?? empty()), calls: [] }
}
function mockServer(fixture, reject) {
  globalThis.fetch = async (path, init) => {
    const body = JSON.parse(init.body)
    fixture.calls.push({ path, method: init.method, body })
    if (reject?.(path, body)) return Response.json({ error: 'bad_request', message: 'fixture write failed' }, { status: 400 })
    if (path === '/api/desktop/layout') {
      const layout = body.scope === 'home' ? fixture.serverHomeLayout : fixture.serverLayout
      for (const { id, ...p } of body.placements) layout[body.viewport][id] = { ...layout[body.viewport][id], ...p }
      fixture.serverSettings[body.scope === 'home' ? 'home_layout' : 'desktop_layout'] = JSON.stringify(layout)
      return Response.json({ layout })
    }
    assert.equal(path, '/api/settings')
    Object.assign(fixture.serverSettings, Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value)])))
    return Response.json({ settings: fixture.serverSettings })
  }
}

test('shared settings save freezes both views, restores safely, then enables the widget and keeps theme local', async () => {
  const fixture = await storeFixture(settings())
  mockServer(fixture)
  await fixture.store.getState().saveSettings({ show_lingxi_chat: true, theme: 'dark' })
  assert.deepEqual(fixture.calls.map(call => call.path), ['/api/desktop/layout', '/api/desktop/layout', '/api/desktop/layout', '/api/desktop/layout', '/api/settings'])
  assert.deepEqual(fixture.calls.slice(0, 4).map(call => call.body.viewport), ['wide', 'compact', 'wide', 'compact'])
  assert.deepEqual(fixture.calls.at(-1).body, { show_lingxi_chat: true })
  assert.equal(fixture.store.getState().settings.show_lingxi_chat, true)
  assert.equal(fixture.store.getState().settings.theme, 'dark')
  for (const view of ['wide', 'compact']) {
    const layout = JSON.parse(fixture.store.getState().rawSettings.desktop_layout)
    assert.deepEqual(layout[view]['site:1'], { col: 0, row: 0 })
    assert.ok(layout[view]['widget:lingxi-chat'].row > 0 || layout[view]['widget:lingxi-chat'].col > 0)
  }
})

test('a failed second-view placement never sends the visibility setting and a later retry succeeds', async () => {
  const fixture = await storeFixture(settings())
  mockServer(fixture, (path, body) => path === '/api/desktop/layout' && body.viewport === 'compact' && body.placements.some(p => p.id === 'widget:weather'))
  await assert.rejects(fixture.store.getState().saveSettings({ show_weather: true }), /fixture write failed/)
  assert.equal(fixture.calls.some(call => call.path === '/api/settings'), false)
  assert.equal(fixture.store.getState().settings.show_weather, false)
  mockServer(fixture)
  await fixture.store.getState().saveSettings({ show_weather: true })
  assert.equal(fixture.store.getState().settings.show_weather, true)
})

test('concurrent settings toggles plan from the last persisted state and never overlap restored widgets', async () => {
  const fixture = await storeFixture(settings(), empty(), [])
  mockServer(fixture)
  await Promise.all([fixture.store.getState().saveSettings({ show_weather: true }), fixture.store.getState().saveSettings({ show_workbench: true })])
  assert.equal(fixture.store.getState().settings.show_weather, true)
  assert.equal(fixture.store.getState().settings.show_workbench, true)
  for (const view of ['wide', 'compact']) {
    const positions = fixture.serverLayout[view]
    assert.equal(overlaps({ id: 'widget:weather', ...positions['widget:weather'] }, { id: 'widget:workbench', ...positions['widget:workbench'] }), false)
  }
})

test('an unrelated shared setting makes one request and a theme-only change makes none', async () => {
  const fixture = await storeFixture(settings())
  mockServer(fixture)
  await fixture.store.getState().saveSettings({ site_title: '仅改标题' })
  assert.deepEqual(fixture.calls.map(call => call.path), ['/api/settings'])
  await fixture.store.getState().saveSettings({ theme: 'light' })
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.store.getState().settings.theme, 'light')
})

test('clock settings restore only initialized home layouts while desktop stays in hero mode', async () => {
  const desktop = empty(), home = empty()
  desktop.wide['widget:clock'] = { col: 8, row: 10, width: 4, height: 2 }
  home.wide = { 'widget:search': { col: 0, row: 0, width: 5, height: 1 }, 'widget:clock': { col: 5, row: 0, width: 3, height: 2 }, 'site:1': { col: 9, row: 9 } }
  const fixture = await storeFixture(settings(), desktop, [site(1)], home)
  mockServer(fixture)
  await fixture.store.getState().saveSettings({ show_clock: true })
  assert.deepEqual(fixture.calls.map(call => [call.path, call.body.scope, call.body.viewport]), [['/api/desktop/layout', 'home', 'wide'], ['/api/settings', undefined, undefined]])
  assert.deepEqual(fixture.serverLayout, desktop)
  assert.deepEqual(fixture.serverHomeLayout, home)
  assert.deepEqual(fixture.serverHomeLayout.compact, {})
})

test('shared widget settings restore both scopes with independent positions and dimensions', async () => {
  const desktop = empty(), home = empty()
  for (const view of ['wide', 'compact']) {
    desktop[view] = { 'site:1': { col: 0, row: 0 }, 'widget:weather': { col: 0, row: 3, width: 2, height: 1 } }
    home[view] = { 'site:1': { col: 3, row: 5 }, 'widget:search': { col: 0, row: 0, width: 3, height: 1 }, 'widget:weather': { col: 0, row: 7, width: 4, height: 3 } }
  }
  const fixture = await storeFixture(settings(), desktop, [site(1)], home)
  mockServer(fixture)
  await fixture.store.getState().saveSettings({ show_weather: true })
  const writes = fixture.calls.filter(call => call.path === '/api/desktop/layout')
  assert.deepEqual(writes.map(call => [call.body.scope ?? 'desktop', call.body.viewport]), [['desktop', 'wide'], ['desktop', 'compact'], ['home', 'wide'], ['home', 'compact']])
  assert.deepEqual(fixture.serverLayout, desktop)
  assert.deepEqual(fixture.serverHomeLayout, home)
  assert.deepEqual(JSON.parse(fixture.store.getState().rawSettings.desktop_layout), desktop)
  assert.deepEqual(JSON.parse(fixture.store.getState().rawSettings.home_layout), home)
})

test('a home layout save failure leaves the shared visibility setting unchanged', async () => {
  const home = empty()
  home.wide['site:1'] = { col: 3, row: 8 }
  const fixture = await storeFixture(settings(), empty(), [site(1)], home)
  mockServer(fixture, (path, body) => path === '/api/desktop/layout' && body.scope === 'home')
  await assert.rejects(fixture.store.getState().saveSettings({ show_weather: true }), /fixture write failed/)
  assert.equal(fixture.calls.some(call => call.path === '/api/settings'), false)
  assert.equal(fixture.store.getState().settings.show_weather, false)
  assert.deepEqual(JSON.parse(fixture.store.getState().rawSettings.home_layout), home)
})

test('saving settings does not create a home layout that has never been arranged', async () => {
  const fixture = await storeFixture(settings(), empty(), [], empty())
  mockServer(fixture)
  await fixture.store.getState().saveSettings({ show_weather: true })
  assert.equal(fixture.calls.some(call => call.body.scope === 'home'), false)
  assert.deepEqual(fixture.serverHomeLayout, empty())
  assert.deepEqual(JSON.parse(fixture.store.getState().rawSettings.home_layout), empty())
})
