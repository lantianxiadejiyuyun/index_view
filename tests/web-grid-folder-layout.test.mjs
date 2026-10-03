import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

async function load(path) {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' }).outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
const { folderResizeError } = await load('../app/web/src/lib/grid-folder-layout.ts')
const { desktopSettingsItems } = await load('../app/web/src/lib/desktop-settings-layout.ts')
const { normalizeSettings } = await load('../app/web/src/lib/settings.ts')
const disabled = Object.fromEntries(['clock', 'calendar', 'weather', 'hitokoto', 'workbench', 'lingxi_calendar', 'lingxi_schedule', 'lingxi_deadline', 'lingxi_chat'].map(name => [`show_${name}`, 'false']))
const empty = () => ({ version: 1, wide: {}, compact: {} })
const folder = (id, columns = 2, rows = 1) => ({ id, columns, rows, name: `Folder ${id}`, sort_order: id })
const site = (id, folder_id = null) => ({ id, folder_id, sort_order: id })
function input(scope = 'desktop', viewport = 'wide', positions = {}, extra = {}) {
  const layout = empty()
  layout[viewport] = { 'folder:1': { col: 0, row: 2 }, ...positions }
  if (scope === 'home') layout[viewport]['widget:search'] = { col: 0, row: 1000 }
  return {
    folderId: 1, columns: 3, rows: 1,
    settings: normalizeSettings({ ...disabled, desktop_header_mode: 'hero' }),
    user: { id: 1, username: 'fixture' }, sites: [], folders: [folder(1)],
    rawSettings: { [`${scope}_layout`]: JSON.stringify(layout) }, ...extra,
  }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item) }
  return value
}

for (const scope of ['home', 'desktop']) for (const viewport of ['wide', 'compact']) {
  test(`${scope}/${viewport}: growth checks its saved anchors and never relocates a blocker`, () => {
    const args = input(scope, viewport, { 'site:1': { col: 2, row: 2 } }, { sites: [site(1)] })
    const original = structuredClone(args)
    const error = folderResizeError(freeze(args))
    assert.match(error, /重叠/)
    assert.ok(error.includes(scope === 'home' ? '普通首页' : '桌面'))
    assert.ok(error.includes(viewport === 'wide' ? '电脑' : '手机'))
    assert.deepEqual(args, original)
    assert.equal(folderResizeError({ ...args, sites: [] }), null)
  })

  test(`${scope}/${viewport}: right-edge growth is rejected instead of shifting the folder left`, () => {
    const args = input(scope, viewport, { 'folder:1': { col: viewport === 'wide' ? 10 : 2, row: 2 } })
    assert.match(folderResizeError(args), /右边界/)
    assert.equal(folderResizeError({ ...args, columns: 1 }), null)
  })
}

test('another viewport or scope can block a size that fits the current desktop', () => {
  const args = input('desktop', 'wide')
  const desktop = JSON.parse(args.rawSettings.desktop_layout)
  desktop.compact = { 'folder:1': { col: 2, row: 7 } }
  args.rawSettings.desktop_layout = JSON.stringify(desktop)
  assert.match(folderResizeError(args), /桌面的手机布局.*右边界/)
  desktop.compact = {}
  args.rawSettings.desktop_layout = JSON.stringify(desktop)
  const home = empty()
  home.wide = { 'folder:1': { col: 0, row: 6 }, 'site:1': { col: 2, row: 6 }, 'widget:search': { col: 0, row: 50 } }
  args.rawSettings.home_layout = JSON.stringify(home)
  args.sites = [site(1)]
  assert.match(folderResizeError(args), /普通首页的电脑布局.*重叠/)
  delete args.rawSettings.home_layout
  assert.equal(folderResizeError(args), null)
})

test('large blocking folders reserve all rows, including beyond row six in both modes', () => {
  for (const scope of ['home', 'desktop']) {
    const args = input(scope, 'wide', { 'folder:1': { col: 0, row: 7 }, 'folder:2': { col: 2, row: 0 } }, { folders: [folder(1, 1, 1), folder(2, 3, 10)] })
    assert.match(folderResizeError(args), /重叠/)
    const layout = JSON.parse(args.rawSettings[`${scope}_layout`])
    assert.equal(desktopSettingsItems([], args.folders, [], layout, 'wide').find(item => item.id === 'folder:2').height, 10)
  }
})

test('a tall folder can grow freely beyond six rows but cannot cover the next fixed icon', () => {
  for (const scope of ['home', 'desktop']) {
    const args = input(scope, 'wide', { 'folder:1': { col: 0, row: 5 }, 'site:1': { col: 1, row: 13 } }, { columns: 2, rows: 8, folders: [folder(1, 2, 7)], sites: [site(1)] })
    assert.equal(folderResizeError(args), null)
    assert.match(folderResizeError({ ...args, rows: 9 }), /重叠/)
    assert.equal(folderResizeError({ ...args, rows: 100, sites: [] }), null)
  }
})

test('stored arbitrary widths adapt to each viewport without changing the input dimensions', () => {
  for (const viewport of ['wide', 'compact']) {
    const args = input('desktop', viewport, {}, { columns: 100, rows: 100 })
    assert.equal(folderResizeError(freeze(args)), null)
    assert.equal(args.columns, 100)
    assert.equal(args.rows, 100)
  }
})

test('shrinking or keeping the same footprint is permitted even with a historical overlap', () => {
  const args = input('desktop', 'wide', { 'site:1': { col: 1, row: 3 } }, { folders: [folder(1, 3, 3)], columns: 2, rows: 2, sites: [site(1)] })
  assert.equal(folderResizeError(args), null)
  assert.equal(folderResizeError({ ...args, columns: 3, rows: 3 }), null)
  // A shorter but wider shape adds cells, so it still needs collision validation.
  const mixed = input('desktop', 'wide', { 'site:1': { col: 2, row: 2 } }, { folders: [folder(1, 2, 3)], sites: [site(1)] })
  assert.match(folderResizeError(mixed), /重叠/)
})

test('visible widgets block expansion while hidden and unauthenticated widgets do not', () => {
  const args = input('desktop', 'wide', { 'widget:weather': { col: 2, row: 2, width: 2, height: 1 } })
  assert.equal(folderResizeError(args), null)
  assert.match(folderResizeError({ ...args, settings: { ...args.settings, show_weather: true } }), /重叠/)
  const chat = input('desktop', 'wide', { 'widget:lingxi-chat': { col: 2, row: 2, width: 4, height: 3 } })
  chat.settings.show_lingxi_chat = true
  assert.match(folderResizeError(chat), /重叠/)
  assert.equal(folderResizeError({ ...chat, user: null }), null)
})

test('narrowing an old clamped folder while increasing its height checks the restored saved column', () => {
  for (const viewport of ['wide', 'compact']) {
    const gridColumns = viewport === 'wide' ? 12 : 4
    const args = input('desktop', viewport, {
      'folder:1': { col: gridColumns - 2, row: 0 }, 'site:1': { col: gridColumns - 1, row: 1 },
    }, { folders: [folder(1, 4, 1)], sites: [site(1)], columns: 2, rows: 2 })
    assert.match(folderResizeError(args), /重叠/)
    assert.equal(folderResizeError({ ...args, sites: [] }), null)
  }
})

test('unsaved visible icons are checked at their current derived position without sorting them away', () => {
  const args = input('desktop', 'wide', { 'folder:1': { col: 0, row: 0 } }, { sites: [site(1)] })
  const raw = args.rawSettings.desktop_layout
  assert.match(folderResizeError(args), /重叠/)
  assert.equal(args.rawSettings.desktop_layout, raw)
  assert.equal(JSON.parse(raw).wide['site:1'], undefined)
})

test('folder members have no canvas footprint, while orphaned folder references still do', () => {
  const args = input('desktop', 'wide', { 'site:1': { col: 2, row: 2 } }, { sites: [site(1, 1)] })
  assert.equal(folderResizeError(args), null)
  assert.match(folderResizeError({ ...args, sites: [site(1, 999)] }), /重叠/)
})

test('empty and invalid legacy layouts remain uninitialized and do not prevent a resize', () => {
  const args = input()
  for (const rawSettings of [{}, { desktop_layout: JSON.stringify(empty()), home_layout: JSON.stringify(empty()) }, { desktop_layout: 'invalid json', home_layout: '{}' }]) {
    assert.equal(folderResizeError({ ...args, columns: 20, rows: 20, rawSettings }), null)
  }
})

test('invalid dimensions and a folder removed while the editor is open are rejected', () => {
  const args = input()
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(folderResizeError({ ...args, columns: value }), /整数/)
    assert.match(folderResizeError({ ...args, rows: value }), /整数/)
  }
  assert.match(folderResizeError({ ...args, folders: [] }), /已不存在/)
})
