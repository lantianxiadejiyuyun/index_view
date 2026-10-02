import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../app/web/src/lib/desktop-layout.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { arrangeDesktop, canvasDropPosition, dropPosition, parseDesktopLayout, overlaps } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
test('desktop leaves intentional blank space, reserves saved tiles before automatic items and never overlaps', () => {
  const items = [{ id: 'site:1', width: 1, height: 1 }, { id: 'folder:1', width: 2, height: 2 }, { id: 'widget:clock', width: 4, height: 2 }]
  const placed = arrangeDesktop(items, { 'folder:1': { col: 1, row: 6 }, 'widget:clock': { col: 0, row: 0 } }, 4)
  assert.deepEqual({ col: placed[1].col, row: placed[1].row }, { col: 1, row: 6 })
  assert.equal(placed[0].row, 2)
  for (const a of placed) for (const b of placed) if (a.id !== b.id) assert.equal(overlaps(a, b), false)
})
test('drop coordinates snap to cells, clamp to the canvas and seek a free position', () => {
  const item = { id: 'folder:1', width: 2, height: 2 }
  assert.deepEqual(dropPosition(item, { col: 1, row: 2 }, { x: 200, y: 100 }, 90, 90, 10, [], 4), { col: 2, row: 3 })
  assert.deepEqual(dropPosition(item, { col: 1, row: 2 }, { x: -999, y: -999 }, 90, 90, 10, [], 4), { col: 0, row: 0 })
  const occupied = [{ id: 'widget:clock', width: 4, height: 2, col: 0, row: 0 }]
  assert.deepEqual(dropPosition(item, { col: 0, row: 0 }, { x: 0, y: 0 }, 90, 90, 10, occupied, 4), { col: 0, row: 2 })
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
