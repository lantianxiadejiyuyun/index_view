import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../app/web/src/lib/desktop-layout.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { arrangeDesktop, canvasDropPosition, desktopOccupants, dropPosition, parseDesktopLayout, overlaps, widgetResizeError } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const widgetsBundle = buildSync({ entryPoints: [fileURLToPath(new URL('../app/web/src/lib/desktop-widgets.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { widgetLabels, widgetSize, widgetSizePresets } = await import(`data:text/javascript;base64,${Buffer.from(widgetsBundle.outputFiles[0].text).toString('base64')}`)
test('desktop leaves intentional blank space, reserves saved tiles before automatic items and never overlaps', () => {
  const items = [{ id: 'site:1', width: 1, height: 1 }, { id: 'folder:1', width: 2, height: 2 }, { id: 'widget:clock', width: 4, height: 2 }]
  const placed = arrangeDesktop(items, { 'folder:1': { col: 1, row: 6 }, 'widget:clock': { col: 0, row: 0 } }, 4)
  assert.deepEqual({ col: placed[1].col, row: placed[1].row }, { col: 1, row: 6 })
  assert.equal(placed[0].row, 2)
  for (const a of placed) for (const b of placed) if (a.id !== b.id) assert.equal(overlaps(a, b), false)
})
test('drop coordinates snap to cells, clamp to the canvas and reject occupied targets without rearranging', () => {
  const item = { id: 'folder:1', width: 2, height: 2 }
  assert.deepEqual(dropPosition(item, { col: 1, row: 2 }, { x: 200, y: 100 }, 90, 90, 10, [], 4), { col: 2, row: 3 })
  assert.deepEqual(dropPosition(item, { col: 1, row: 2 }, { x: -999, y: -999 }, 90, 90, 10, [], 4), { col: 0, row: 0 })
  const occupied = [{ id: 'widget:clock', width: 4, height: 2, col: 0, row: 0 }]
  assert.equal(dropPosition(item, { col: 0, row: 0 }, { x: 0, y: 0 }, 90, 90, 10, occupied, 4), null)
  assert.deepEqual(occupied, [{ id: 'widget:clock', width: 4, height: 2, col: 0, row: 0 }])
  assert.equal(canvasDropPosition(item, { left: 0, top: 100 }, { left: 0, top: 0 }, 90, 90, 10, occupied, 4), null)
})
test('saved placements stay fixed even if a resized folder overlaps them', () => {
  const items = [{ id: 'site:1', width: 1, height: 1 }, { id: 'folder:1', width: 3, height: 3 }]
  const positions = { 'site:1': { col: 2, row: 2 }, 'folder:1': { col: 0, row: 0 } }
  const placed = arrangeDesktop(items, positions, 4)
  for (const item of placed) assert.deepEqual({col:item.col,row:item.row},positions[item.id])
  assert.deepEqual(positions, { 'site:1': { col: 2, row: 2 }, 'folder:1': { col: 0, row: 0 } })
})
test('removing a saved tile leaves its space empty rather than compacting survivors', () => {
  const items = [{ id: 'folder:1', width: 2, height: 2 }, { id: 'site:1', width: 1, height: 1 }, { id: 'site:2', width: 1, height: 1 }]
  const initial = arrangeDesktop(items, {}, 4)
  const saved = Object.fromEntries(initial.map(({id,col,row}) => [id,{col,row}]))
  const after = arrangeDesktop(items.filter(item => item.id !== 'site:1'), saved, 4)
  assert.deepEqual(after.find(item => item.id === 'site:2'), initial.find(item => item.id === 'site:2'))
  assert.deepEqual(after.find(item => item.id === 'folder:1'), initial.find(item => item.id === 'folder:1'))
})
test('imported layout rejects invalid positions and keeps device layouts independent', () => {
  const parsed = parseDesktopLayout(JSON.stringify({ wide: { 'site:1': { col: 10, row: 2 }, 'folder:1': { col: -1, row: 2 }, bad: { col: 1, row: 1 } }, compact: { 'site:1': { col: 2, row: 8 }, 'site:2': { col: 6, row: 0 } } }))
  assert.deepEqual(parsed.wide, { 'site:1': { col: 10, row: 2 } })
  assert.deepEqual(parsed.compact, { 'site:1': { col: 2, row: 8 } })
  assert.deepEqual(parseDesktopLayout('null'), { version: 1, wide: {}, compact: {} })
})
test('dragging remains accurate when scrolling moves the canvas under a stationary overlay', () => {
  const item = { id: 'folder:1', width: 2, height: 2 }
  assert.deepEqual(canvasDropPosition(item, { left: 16, top: 398 }, { left: 16, top: -434 }, 74.25, 92, 12, [], 4), { col: 0, row: 8 })
  assert.deepEqual(canvasDropPosition(item, { left: 16, top: 398 }, { left: 16, top: -330 }, 74.25, 92, 12, [], 4), { col: 0, row: 7 })
})

test('calendar positions survive parsing on both devices without displacing saved icons', () => {
  const saved = {
    version: 1,
    wide: { 'widget:calendar': { col: 8, row: 4 }, 'site:1': { col: 6, row: 8 } },
    compact: { 'widget:calendar': { col: 0, row: 9 }, 'site:1': { col: 3, row: 2 } },
  }
  const parsed = parseDesktopLayout(JSON.stringify(saved))
  assert.deepEqual(parsed, saved)
  for (const [view, columns, calendarWidth] of [['wide', 12, 4], ['compact', 4, 4]]) {
    const items = [{ id: 'widget:calendar', width: calendarWidth, height: 2 }, { id: 'site:1', width: 1, height: 1 }]
    const placed = arrangeDesktop(items, parsed[view], columns)
    for (const item of placed) assert.deepEqual({ col: item.col, row: item.row }, saved[view][item.id])
    assert.equal(overlaps(placed[0], placed[1]), false)
  }
})

test('every widget offers three distinct sizes on both viewports and retains its legacy default', () => {
  const legacy = { clock: [3, 2], search: [5, 1], weather: [4, 2], quote: [5, 1], workbench: [3, 1], calendar: [4, 2], 'lingxi-calendar': [4, 4], 'lingxi-schedule': [4, 4], 'lingxi-deadline': [3, 2], 'lingxi-chat': [5, 4] }
  assert.equal(Object.keys(widgetLabels).length, 10)
  for (const [name, [width, height]] of Object.entries(legacy)) for (const view of ['wide', 'compact']) {
    assert.deepEqual(widgetSize(name, view), { width: view === 'wide' ? width : 4, height })
    const presets = widgetSizePresets(name, view)
    assert.equal(new Set(presets.map(p => `${p.width}:${p.height}`)).size, 3)
    for (const preset of presets) {
      assert.ok(preset.width >= 1 && preset.width <= (view === 'wide' ? 12 : 4))
      assert.ok(preset.height >= 1 && preset.height <= 6)
      assert.deepEqual(widgetSize(name, view, preset), { width: preset.width, height: preset.height })
    }
  }
})

test('widget dimensions survive a layout round trip independently on each device; broken dimensions retain coordinates', () => {
  const original = { version: 1, wide: { 'widget:clock': { col: 2, row: 5, width: 2, height: 1 } }, compact: { 'widget:clock': { col: 0, row: 9, width: 4, height: 3 } } }
  assert.deepEqual(parseDesktopLayout(JSON.stringify(original)), original)
  for (const invalid of [{ width: 3 }, { width: 0, height: 1 }, { width: 2, height: 7 }, { width: 2.5, height: 1 }, { width: '2', height: 1 }]) {
    const layout = parseDesktopLayout(JSON.stringify({ wide: { 'widget:clock': { col: 2, row: 5, ...invalid } } }))
    assert.deepEqual(layout.wide['widget:clock'], { col: 2, row: 5 })
  }
  assert.deepEqual(parseDesktopLayout(JSON.stringify({ compact: { 'widget:clock': { col: 0, row: 1, width: 5, height: 2 }, 'site:1': { col: 1, row: 4, width: 3, height: 2 } } })).compact, { 'widget:clock': { col: 0, row: 1 }, 'site:1': { col: 1, row: 4 } })
})

test('widget resize remains anchored and rejects collisions and canvas overflow without changing other placements', () => {
  const clock = { id: 'widget:clock', col: 2, row: 4, width: 2, height: 1 }
  const neighbour = { id: 'site:1', col: 4, row: 4, width: 1, height: 1 }
  const occupied = [clock, neighbour]
  const before = structuredClone(occupied)
  assert.equal(widgetResizeError(clock, { width: 2, height: 3 }, occupied, 12), null)
  assert.match(widgetResizeError(clock, { width: 3, height: 1 }, occupied, 12), /占用/)
  assert.match(widgetResizeError(clock, { width: 3, height: 1 }, [clock], 4), /边缘/)
  assert.equal(widgetResizeError(clock, { width: 2, height: 1 }, [clock], 4), null)
  assert.deepEqual(occupied, before)
})

test('hidden widgets reserve their resized footprint across hide, reload and restore', () => {
  const layout = parseDesktopLayout(JSON.stringify({ compact: { 'widget:weather': { col: 0, row: 0, width: 2, height: 1 }, 'widget:clock': { col: 0, row: 2, width: 4, height: 3 } } }))
  const visible = [{ id: 'widget:weather', ...widgetSize('weather', 'compact', layout.compact['widget:weather']) }, { id: 'site:1', width: 1, height: 1 }]
  const occupants = desktopOccupants(visible, layout, 'compact')
  assert.deepEqual(occupants.find(p => p.id === 'widget:clock'), { id: 'widget:clock', col: 0, row: 2, width: 4, height: 3 })
  assert.match(widgetResizeError(occupants[0], { width: 2, height: 3 }, occupants, 4), /占用/)
  const restored = desktopOccupants([...visible, { id: 'widget:clock', ...widgetSize('clock', 'compact', layout.compact['widget:clock']) }], layout, 'compact')
  for (const item of restored) assert.deepEqual(item, occupants.find(p => p.id === item.id))
})
