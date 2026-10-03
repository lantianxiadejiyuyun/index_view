import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

async function load(path) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { planGridSiteRestore, planGridCollectionRestore } = await load('../app/web/src/lib/grid-site-layout.ts')
const { desktopSettingsItems, visibleDesktopWidgetNames } = await load('../app/web/src/lib/desktop-settings-layout.ts')
const { desktopOccupants, overlaps } = await load('../app/web/src/lib/desktop-layout.ts')
const { normalizeSettings } = await load('../app/web/src/lib/settings.ts')
const disabled = Object.fromEntries(['clock', 'calendar', 'weather', 'hitokoto', 'workbench', 'lingxi_calendar', 'lingxi_schedule', 'lingxi_deadline', 'lingxi_chat'].map(name => [`show_${name}`, 'false']))
const settings = patch => normalizeSettings({ ...disabled, desktop_header_mode: 'hero', ...Object.fromEntries(Object.entries(patch ?? {}).map(([key, value]) => [key, String(value)])) })
const empty = () => ({ version: 1, wide: {}, compact: {} })
const site = (id, folder_id = null, sort_order = id) => ({ id, folder_id, sort_order })
const folder = (id, columns = 1, rows = 1) => ({ id, columns, rows, sort_order: id })
function fixture(patch = {}) {
  const restoring = site(1, 10, 0)
  return { scope: 'desktop', viewport: 'wide', target: { col: 9, row: 8 }, site: restoring, settings: settings(), authenticated: true, sites: [restoring], folders: [folder(10)], rawSettings: {}, ...patch }
}
function applyPlan(input, plan) {
  const layouts = Object.fromEntries(['desktop', 'home'].map(scope => [scope, JSON.parse(input.rawSettings[`${scope}_layout`] ?? JSON.stringify(empty()))]))
  for (const { scope, viewport, placements } of [...plan.freeze, ...plan.restore]) {
    for (const { id, ...position } of placements) layouts[scope][viewport][id] = position
  }
  return layouts
}
function assertExistingTilesStay(input, plan) {
  const updated = applyPlan(input, plan)
  const remaining = input.sites.filter(item => item.id !== input.site.id)
  const restoredSites = [...remaining, { ...input.site, folder_id: null }]
  for (const { scope, viewport } of plan.restore) {
    const old = JSON.parse(input.rawSettings[`${scope}_layout`] ?? JSON.stringify(empty()))
    const names = visibleDesktopWidgetNames(input.settings, input.authenticated, scope)
    const before = desktopOccupants(desktopSettingsItems(names, input.folders, remaining, old, viewport), old, viewport)
    const after = desktopOccupants(desktopSettingsItems(names, input.folders, restoredSites, updated[scope], viewport), updated[scope], viewport)
    for (const tile of before) assert.deepEqual(after.find(item => item.id === tile.id), tile, `${scope}/${viewport}: ${tile.id} moved`)
    const restored = after.find(item => item.id === `site:${input.site.id}`)
    assert.ok(restored)
    assert.ok(after.every(item => item.id === restored.id || !overlaps(item, restored)), `${scope}/${viewport}: restored site overlaps`)
  }
}

test('keeps four independent scopes and viewports, using only the active confirmed target', () => {
  const desktop = empty(), home = empty()
  desktop.wide['site:1'] = { col: 8, row: 4 }
  desktop.compact['site:1'] = { col: 2, row: 5 }
  home.wide['site:1'] = { col: 7, row: 6 }
  home.compact['site:1'] = { col: 3, row: 7 }
  const input = fixture({ scope: 'home', viewport: 'compact', target: { col: 1, row: 9 }, rawSettings: { desktop_layout: JSON.stringify(desktop), home_layout: JSON.stringify(home) } })
  const original = structuredClone(input)
  const plan = planGridSiteRestore(input)
  assert.deepEqual(plan.restore, [
    { scope: 'desktop', viewport: 'wide', placements: [{ id: 'site:1', col: 8, row: 4 }] },
    { scope: 'desktop', viewport: 'compact', placements: [{ id: 'site:1', col: 2, row: 5 }] },
    { scope: 'home', viewport: 'wide', placements: [{ id: 'site:1', col: 7, row: 6 }] },
    { scope: 'home', viewport: 'compact', placements: [{ id: 'site:1', col: 1, row: 9 }] },
  ])
  assertExistingTilesStay(input, plan)
  assert.deepEqual(input, original)
})

test('a stale occupied position relocates only the restored icon and freezes unsaved visible tiles', () => {
  const desktop = empty(), home = empty()
  for (const view of ['wide', 'compact']) {
    desktop[view] = { 'site:1': { col: 0, row: 3 }, 'site:2': { col: 0, row: 3 } }
    home[view] = { 'site:1': { col: 1, row: 3 }, 'widget:weather': { col: 0, row: 3, width: 3, height: 2 } }
  }
  const input = fixture({ settings: settings({ show_weather: true, show_lingxi_chat: true }), sites: [site(1, 10, 0), site(2), site(3), site(4, 10)], rawSettings: { desktop_layout: JSON.stringify(desktop), home_layout: JSON.stringify(home) } })
  const plan = planGridSiteRestore(input)
  for (const batch of plan.freeze) {
    assert.ok(batch.placements.some(item => item.id === 'site:3'))
    assert.ok(batch.placements.every(item => item.id !== 'site:1' && item.id !== 'site:4'))
    assert.ok(batch.placements.filter(item => item.id.startsWith('widget:')).every(item => item.width > 0 && item.height > 0))
    assert.ok(batch.placements.filter(item => !item.id.startsWith('widget:')).every(item => !('width' in item) && !('height' in item)))
  }
  assertExistingTilesStay(input, plan)
  for (const batch of plan.restore.filter(item => !(item.scope === input.scope && item.viewport === input.viewport))) {
    const old = (batch.scope === 'home' ? home : desktop)[batch.viewport]['site:1']
    assert.notDeepEqual(batch.placements[0], { id: 'site:1', ...old })
  }
})

test('empty inactive views stay uninitialized while the active view freezes its original ordering', () => {
  const input = fixture({ sites: [site(1, 10, 0), site(2), site(3)] })
  const plan = planGridSiteRestore(input)
  assert.deepEqual(plan.restore.map(({ scope, viewport }) => [scope, viewport]), [['desktop', 'wide']])
  assert.deepEqual(plan.freeze.map(({ scope, viewport }) => [scope, viewport]), [['desktop', 'wide']])
  assertExistingTilesStay(input, plan)
  const updated = applyPlan(input, plan)
  assert.deepEqual(updated.desktop.compact, {})
  assert.deepEqual(updated.home, empty())
  // Lower sort_order of the restored icon must not move these initial tiles.
  assert.deepEqual(updated.desktop.wide['folder:10'], { col: 0, row: 0 })
  assert.deepEqual(updated.desktop.wide['site:2'], { col: 1, row: 0 })
  assert.deepEqual(updated.desktop.wide['site:3'], { col: 2, row: 0 })
})

test('scope-specific widget visibility is respected and hidden preferences are not obstacles', () => {
  const desktop = empty(), home = empty()
  desktop.compact = { 'site:1': { col: 1, row: 0 }, 'widget:clock': { col: 0, row: 0, width: 4, height: 2 }, 'widget:lingxi-chat': { col: 0, row: 0, width: 4, height: 4 } }
  home.compact = { ...desktop.compact }
  const input = fixture({ settings: settings({ show_clock: true, show_lingxi_chat: true }), authenticated: false, folders: [], rawSettings: { desktop_layout: JSON.stringify(desktop), home_layout: JSON.stringify(home) } })
  const plan = planGridSiteRestore(input)
  assert.deepEqual(plan.restore.find(item => item.scope === 'desktop' && item.viewport === 'compact').placements, [{ id: 'site:1', col: 1, row: 0 }])
  assert.ok(plan.restore.find(item => item.scope === 'home').placements[0].row >= 3)
  assert.ok(plan.freeze.every(batch => batch.placements.every(item => item.id !== 'widget:lingxi-chat')))
  assertExistingTilesStay(input, plan)
})

test('restoration excludes even a member of a now missing folder from initial occupants', () => {
  const desktop = empty()
  desktop.compact = { 'site:1': { col: 0, row: 0 }, 'site:2': { col: 3, row: 0 } }
  const input = fixture({ site: site(1, 999), sites: [site(1, 999), site(2)], folders: [], rawSettings: { desktop_layout: JSON.stringify(desktop) } })
  const plan = planGridSiteRestore(input)
  assert.deepEqual(plan.restore.find(item => item.viewport === 'compact').placements, [{ id: 'site:1', col: 0, row: 0 }])
  assertExistingTilesStay(input, plan)
})

test('occupied or invalid active targets fail without choosing another active position', () => {
  const input = fixture({ sites: [site(1, 10), site(2)] })
  const original = structuredClone(input)
  assert.throws(() => planGridSiteRestore({ ...input, target: { col: 1, row: 0 } }), /已被占用/)
  for (const target of [{ col: -1, row: 0 }, { col: 12, row: 0 }, { col: 0.5, row: 0 }, { col: 0, row: 10001 }, { col: 0, row: NaN }]) {
    assert.throws(() => planGridSiteRestore({ ...input, target }), /位置无效/)
  }
  assert.deepEqual(input, original)
})

test('a conflicting old position at the row limit may reuse earlier free space', () => {
  const desktop = empty()
  desktop.compact = { 'site:1': { col: 0, row: 10000 }, 'folder:10': { col: 0, row: 10000 } }
  const input = fixture({ folders: [folder(10, 4)], rawSettings: { desktop_layout: JSON.stringify(desktop) } })
  const plan = planGridSiteRestore(input)
  assert.deepEqual(plan.restore.find(item => item.viewport === 'compact').placements, [{ id: 'site:1', col: 0, row: 0 }])
  assertExistingTilesStay(input, plan)
})

test('tall folders keep their full occupied height while restoring another canvas', () => {
  const desktop = empty()
  desktop.compact = { 'site:1': { col: 0, row: 6 }, 'folder:10': { col: 0, row: 0 } }
  const input = fixture({ folders: [folder(10, 4, 8)], rawSettings: { desktop_layout: JSON.stringify(desktop) } })
  const plan = planGridSiteRestore(input)
  assert.deepEqual(plan.restore.find(item => item.viewport === 'compact').placements, [{ id: 'site:1', col: 0, row: 8 }])
  assertExistingTilesStay(input, plan)
})

function collectionFixture(patch = {}) {
  return { settings: settings(), authenticated: true, rawSettings: {}, beforeSites: [site(1, 10), site(2, 10), site(3)], beforeFolders: [folder(10)], sites: [site(1), site(2), site(3)], folders: [folder(10)], ...patch }
}
function assertCollectionTilesStay(input, plan) {
  const updated = applyPlan(input, plan)
  for (const { scope, viewport, placements } of plan.restore) {
    const old = JSON.parse(input.rawSettings[`${scope}_layout`])
    const names = visibleDesktopWidgetNames(input.settings, input.authenticated, scope)
    const before = desktopOccupants(desktopSettingsItems(names, input.beforeFolders, input.beforeSites, old, viewport), old, viewport)
    const after = desktopOccupants(desktopSettingsItems(names, input.folders, input.sites, updated[scope], viewport), updated[scope], viewport)
    for (const tile of before) {
      const remaining = after.find(item => item.id === tile.id)
      if (remaining) assert.deepEqual(remaining, tile, `${scope}/${viewport}: ${tile.id} moved`)
    }
    for (const { id } of placements) {
      const restored = after.find(item => item.id === id)
      assert.ok(after.every(item => item.id === id || !overlaps(item, restored)), `${scope}/${viewport}: ${id} overlaps`)
    }
  }
}

test('collection restoration reserves all free old positions before relocating conflicting members', () => {
  const desktop = empty()
  desktop.wide = { 'folder:10': { col: 4, row: 0 }, 'site:1': { col: 0, row: 0 }, 'site:2': { col: 1, row: 0 }, 'site:3': { col: 0, row: 0 } }
  const input = collectionFixture({ rawSettings: { desktop_layout: JSON.stringify(desktop) } })
  const original = structuredClone(input)
  const plan = planGridCollectionRestore(input)
  assert.deepEqual(plan, { freeze: [], restore: [{ scope: 'desktop', viewport: 'wide', placements: [{ id: 'site:1', col: 2, row: 0 }, { id: 'site:2', col: 1, row: 0 }] }] })
  assertCollectionTilesStay(input, plan)
  assert.deepEqual(input, original)
})

test('deleting an unsaved folder releases its cells without pulling other unsaved icons into its gap', () => {
  const desktop = empty(), home = empty()
  for (const layout of [desktop, home]) for (const view of ['wide', 'compact']) {
    layout[view] = { 'widget:search': { col: 0, row: 10, width: 4, height: 1 }, 'site:1': { col: 0, row: 0 }, 'site:2': { col: 1, row: 0 } }
  }
  const input = collectionFixture({ beforeFolders: [folder(10, 2)], folders: [], rawSettings: { desktop_layout: JSON.stringify(desktop), home_layout: JSON.stringify(home) } })
  const plan = planGridCollectionRestore(input)
  assert.equal(plan.restore.length, 4)
  for (const batch of plan.freeze) assert.deepEqual(batch.placements, [{ id: 'site:3', col: 2, row: 0 }])
  for (const batch of plan.restore) assert.deepEqual(batch.placements, [{ id: 'site:1', col: 0, row: 0 }, { id: 'site:2', col: 1, row: 0 }])
  assertCollectionTilesStay(input, plan)
})

test('collection restoration leaves all unused views empty and preserves independent stored positions', () => {
  const desktop = empty(), home = empty()
  desktop.compact = { 'folder:10': { col: 0, row: 0 }, 'site:1': { col: 1, row: 7 }, 'site:2': { col: 2, row: 7 } }
  home.wide = { 'widget:search': { col: 0, row: 0, width: 4, height: 1 }, 'site:1': { col: 5, row: 2 }, 'site:2': { col: 7, row: 2 } }
  const input = collectionFixture({ rawSettings: { desktop_layout: JSON.stringify(desktop), home_layout: JSON.stringify(home) } })
  const plan = planGridCollectionRestore(input)
  assert.deepEqual(plan.restore.map(({ scope, viewport }) => [scope, viewport]), [['desktop', 'compact'], ['home', 'wide']])
  const updated = applyPlan(input, plan)
  assert.deepEqual(updated.desktop.wide, {})
  assert.deepEqual(updated.home.compact, {})
  for (const batch of plan.restore) for (const { id, ...position } of batch.placements) {
    assert.deepEqual(position, (batch.scope === 'home' ? home : desktop)[batch.viewport][id])
  }
  assertCollectionTilesStay(input, plan)
})

test('only previously valid folder members becoming loose are restored', () => {
  const desktop = empty()
  desktop.wide['folder:10'] = { col: 0, row: 0 }
  const input = collectionFixture({
    rawSettings: { desktop_layout: JSON.stringify(desktop) },
    beforeSites: [site(1, 10), site(2, 10), site(3, 999), site(4), site(5, 10)],
    sites: [site(1), site(2, 20), site(3), site(4), site(6)],
    folders: [folder(10), folder(20)],
  })
  const plan = planGridCollectionRestore(input)
  assert.deepEqual(plan.restore.flatMap(batch => batch.placements.map(item => item.id)), ['site:1'])
  assertCollectionTilesStay(input, plan)
  assert.deepEqual(planGridCollectionRestore({ ...input, sites: input.beforeSites, folders: input.beforeFolders }), { freeze: [], restore: [] })
  assert.deepEqual(planGridCollectionRestore({ ...input, rawSettings: {} }), { freeze: [], restore: [] })
})

test('moving a different loose icon into a folder releases its cell for restored members', () => {
  const desktop = empty()
  desktop.wide = { 'folder:10': { col: 4, row: 2 }, 'site:1': { col: 1, row: 0 }, 'site:2': { col: 2, row: 0 }, 'site:3': { col: 1, row: 0 } }
  const input = collectionFixture({ sites: [site(1), site(2), site(3, 10)], rawSettings: { desktop_layout: JSON.stringify(desktop) } })
  const plan = planGridCollectionRestore(input)
  assert.deepEqual(plan.restore[0].placements, [{ id: 'site:1', col: 1, row: 0 }, { id: 'site:2', col: 2, row: 0 }])
  assertCollectionTilesStay(input, plan)
})
