import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../app/web/src/components/lingxi/LingxiSessionSelect.tsx', import.meta.url))
const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { sessionMenuPosition, sessionTypeaheadIndex } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('session menu fits a narrow phone and opens above a trigger near the bottom', () => {
  const rect = sessionMenuPosition({ left: 170, top: 610, bottom: 652, width: 142 }, { left: 0, top: 0, width: 320, height: 700 }, 20)
  assert.equal(rect.width, 280)
  assert.equal(rect.left, 32)
  assert.equal(rect.maxHeight, 320)
  assert.equal(rect.top + rect.maxHeight, 604)
  assert.ok(rect.left + rect.width <= 312)
})

test('session menu clamps to the visible viewport after mobile zoom or keyboard resize', () => {
  const rect = sessionMenuPosition({ left: 170, top: 300, bottom: 342, width: 400 }, { left: 80, top: 120, width: 240, height: 300 }, 20)
  assert.equal(rect.left, 88)
  assert.equal(rect.width, 224)
  assert.ok(rect.top >= 128)
  assert.ok(rect.top + rect.maxHeight <= 412)
})

test('short session menus stay below the trigger without an oversized blank surface', () => {
  const rect = sessionMenuPosition({ left: 30, top: 60, bottom: 102, width: 380 }, { left: 0, top: 0, width: 1200, height: 800 }, 2)
  assert.deepEqual(rect, { left: 30, top: 108, width: 380, maxHeight: 102 })
})

test('session typeahead wraps, cycles equal prefixes and retains active selection when no match exists', () => {
  const options = [{ id: '1', title: 'Alpha' }, { id: '2', title: 'Beta' }, { id: '3', title: 'Alpine' }]
  assert.equal(sessionTypeaheadIndex(options, 'a', 0), 2)
  assert.equal(sessionTypeaheadIndex(options, 'A', 2), 0)
  assert.equal(sessionTypeaheadIndex(options, 'alpi', 0), 2)
  assert.equal(sessionTypeaheadIndex(options, 'absent', 1), 1)
  assert.equal(sessionTypeaheadIndex(options, 'b', -1), 1)
})

test('session typeahead supports Chinese titles, unnamed sessions and an empty list', () => {
  const options = [{ id: 'calendar', title: '日程安排' }, { id: 'blank', title: '' }]
  assert.equal(sessionTypeaheadIndex(options, '日程', 1), 0)
  assert.equal(sessionTypeaheadIndex(options, '未命名', 0), 1)
  assert.equal(sessionTypeaheadIndex([], 'a', -1), -1)
})
