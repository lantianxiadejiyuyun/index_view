import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

const bundled = buildSync({ stdin: { contents: "export * from './app/web/src/lib/lingxi.ts'; export { setAccessToken } from './app/web/src/lib/api.ts'", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', write: false }).outputFiles[0].text
let counter = 0
const client = () => import(`data:text/javascript,${encodeURIComponent(`${bundled}\n// ${counter++}`)}`)
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function sse(text, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize)); controller.close() } }), { headers: { 'content-type': 'text/event-stream' } })
}

test('Lingxi streaming keeps authentication and decodes split UTF-8 / CRLF envelopes', async t => {
  const api = await client(); api.setAccessToken('navigation-test-token')
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls++
    assert.equal(path, '/api/lingxi/sessions/9/messages')
    assert.equal(init.headers.get('Authorization'), 'Bearer navigation-test-token')
    assert.deepEqual(JSON.parse(init.body), { message: '今天的日程' })
    return sse(': heartbeat\r\n\r\nevent: delta\r\ndata: {"type":"delta","data":"明天有会议"}\r\n\r\nevent: done\r\ndata: {"type":"done","data":"最终回复"}\r\n\r\n')
  })
  const events = []
  await api.streamLingxiMessage('9', '今天的日程', value => events.push(value), new AbortController().signal)
  assert.equal(calls, 1)
  assert.deepEqual(events.map(event => [event.event, event.data.data]), [['delta', '明天有会议'], ['done', '最终回复']])
})

test('an SSE error remains a failure even when upstream sends done afterwards', async t => {
  const api = await client()
  t.mock.method(globalThis, 'fetch', async () => sse('event: error\ndata: {"type":"error","data":"模型暂不可用"}\n\nevent: done\ndata: {"type":"done","data":""}\n\n', 20))
  const events = []
  await assert.rejects(api.streamLingxiMessage('1', 'hello', value => events.push(value), new AbortController().signal), /模型暂不可用/)
  assert.deepEqual(events, [])
})

test('interrupted SSE does not silently succeed or resend a tool-executing chat', async t => {
  const api = await client(); let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return sse('event: delta\ndata: {"data":"已收到"}\n\n') })
  await assert.rejects(api.streamLingxiMessage('1', '新增日程', () => {}, new AbortController().signal), /连接已中断/)
  assert.equal(calls, 1)
})

test('paginated task loading includes later pages and normalizes numeric ids', async t => {
  const api = await client(), offsets = []
  t.mock.method(globalThis, 'fetch', async path => {
    const query = new URL(path, 'https://navigation.invalid').searchParams
    assert.equal(query.get('status'), 'all'); assert.equal(query.get('limit'), '200')
    const offset = Number(query.get('offset')); offsets.push(offset)
    return json({ tasks: Array.from({ length: offset ? 1 : 200 }, (_, i) => ({ id: offset + i + 1, title: '任务' })), pagination: { limit: 200, offset, total: 201 } })
  })
  const { tasks } = await api.lingxi.tasks()
  assert.deepEqual(offsets, [0, 200]); assert.equal(tasks.length, 201); assert.equal(tasks[200].id, '201')
})

test('calendar and datetime inputs use the Lingxi account timezone, including DST', async () => {
  const api = await client()
  assert.equal(api.zonedDateInput('2026-10-03T18:30:00Z', 'Asia/Shanghai', true), '2026-10-04')
  assert.equal(api.zonedInputToISO('2026-10-04T00:00', 'Asia/Shanghai'), '2026-10-03T16:00:00.000Z')
  assert.equal(api.zonedInputToISO('2026-07-04T09:30', 'America/New_York'), '2026-07-04T13:30:00.000Z')
  assert.equal(api.zonedInputToISO('2026-01-04T09:30', 'America/New_York'), '2026-01-04T14:30:00.000Z')
  assert.throws(() => api.zonedInputToISO('2026-03-08T02:30', 'America/New_York'), /夏令时/)
  assert.throws(() => api.zonedInputToISO('2026-02-30T09:30', 'Asia/Shanghai'), /有效日期/)
  assert.equal(api.zonedDayStartToISO('2026-03-08', 'America/Havana'), '2026-03-08T05:00:00.000Z')
  assert.equal(api.zonedDayStartToISO('2026-03-09', 'America/Havana'), '2026-03-09T04:00:00.000Z')
})

test('cancelling a stream does not deliver a late response or replay the message', async t => {
  const api = await client(), controller = new AbortController(), events = []
  let resolve, calls = 0
  t.mock.method(globalThis, 'fetch', () => { calls++; return new Promise(done => { resolve = done }) })
  const pending = api.streamLingxiMessage('1', '新增待办', value => events.push(value), controller.signal)
  controller.abort()
  resolve(sse('event: done\ndata: {"data":"late"}\n\n'))
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(calls, 1); assert.deepEqual(events, [])
})

test('deadline duration retains overdue state and ignores invalid dates', async () => {
  const api = await client(), now = Date.parse('2026-10-03T00:00:00Z')
  assert.deepEqual(api.deadlineLabel('2026-10-04T01:00:00Z', now), { label: '剩余 1天 1小时', overdue: false })
  assert.deepEqual(api.deadlineLabel('2026-10-02T23:30:00Z', now), { label: '已逾期 30分钟', overdue: true })
  assert.deepEqual(api.deadlineLabel('invalid', now), { label: '日期无效', overdue: false })
})
