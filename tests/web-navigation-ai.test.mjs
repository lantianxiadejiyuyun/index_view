import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('../app/web/src/lib/navigation-ai.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
})
const helpers = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const snapshot = () => ({
  sites: [
    { id: 1, title: '开发工具', category_id: 10, folder_id: 20, sort_order: 2, clicks: 3, url_public: 'https://fixture.example/one', updated_at: 1 },
    { id: 2, title: '资料', category_id: 11, folder_id: null, sort_order: 5, clicks: 0, url_public: 'https://fixture.example/two', updated_at: 1 },
  ],
  categories: [{ id: 10, name: '工具', sort_order: 1 }, { id: 11, name: '工作', sort_order: 2 }],
  folders: [
    { id: 20, name: '常用', category_id: 10, columns: 5, rows: 3, color: '#123abc', sort_order: 1 },
    { id: 21, name: '保留', category_id: 11, columns: 2, rows: 2, color: '#abc123', sort_order: 2 },
  ],
})
const preview = () => ({ groups: [{ category_id: 10, name: '工具', site_ids: [2], folders: [{ folder_id: 20, name: '常用', site_ids: [1] }] }] })

test('preview coverage rejects missing, duplicated, unknown and wrongly typed site IDs', () => {
  const sites = snapshot().sites
  assert.equal(helpers.navigationPreviewIncludesEverySite(preview(), sites), true)
  const variants = [
    value => { value.groups[0].site_ids = [] },
    value => { value.groups[0].site_ids = [1] },
    value => { value.groups[0].site_ids = [999] },
    value => { value.groups[0].site_ids = ['2'] },
    value => { value.groups[0].folders[0].site_ids.push(2) },
    value => { value.groups = [] },
  ]
  for (const mutate of variants) {
    const value = preview(); mutate(value)
    assert.equal(helpers.navigationPreviewIncludesEverySite(value, sites), false)
  }
})

test('layout fingerprint ignores clicks and response array order without mutating inputs', () => {
  const original = snapshot(), saved = structuredClone(original), next = snapshot()
  next.sites[0].clicks += 10
  for (const key of ['sites', 'categories', 'folders']) next[key].reverse()
  assert.equal(helpers.navigationLayoutFingerprint(original), helpers.navigationLayoutFingerprint(next))
  assert.deepEqual(original, saved)
  const legacy = snapshot(); delete legacy.sites[1].folder_id
  assert.equal(helpers.navigationLayoutFingerprint(original), helpers.navigationLayoutFingerprint(legacy))
})

test('content, positions, structure and folder size changes invalidate reviewed layouts', () => {
  const original = helpers.navigationLayoutFingerprint(snapshot())
  const mutations = [
    value => { value.sites[0].title = '新名称' },
    value => { value.sites[0].url_public = 'https://fixture.example/changed' },
    value => { value.sites[0].category_id = 11 },
    value => { value.sites[0].folder_id = null },
    value => { value.sites[0].sort_order++ },
    value => { value.categories[0].name = '新分组' },
    value => { value.folders[0].category_id = 11 },
    value => { value.folders[0].columns++ },
    value => { value.folders[0].rows++ },
    value => { value.folders[0].color = '#000000' },
    value => { value.sites.pop() },
  ]
  for (const mutate of mutations) {
    const value = snapshot(); mutate(value)
    assert.notEqual(helpers.navigationLayoutFingerprint(value), original)
  }
})

test('client requests only submit the trimmed preference or server-issued operation token', async () => {
  const original = globalThis.fetch, calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init.method, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ ok: true }))
  }
  try {
    await helpers.navigationAi.preview('  保留当前分组  ')
    await helpers.navigationAi.preview(' \n ')
    await helpers.navigationAi.apply('preview-token')
    await helpers.navigationAi.undo('undo-token')
    assert.deepEqual(calls, [
      { path: '/api/navigation/ai/preview', method: 'POST', body: { prompt: '保留当前分组' } },
      { path: '/api/navigation/ai/preview', method: 'POST', body: {} },
      { path: '/api/navigation/ai/apply', method: 'POST', body: { preview_token: 'preview-token' } },
      { path: '/api/navigation/ai/undo', method: 'POST', body: { undo_token: 'undo-token' } },
    ])
  } finally { globalThis.fetch = original }
})

// Drive only the helper's pending deadline; no wall-clock waits or paid AI calls.
async function withControlledRequests(run) {
  const originals = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  const timers = new Map(), calls = []
  let nextId = 1
  globalThis.setTimeout = (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id }
  globalThis.clearTimeout = id => { timers.delete(id) }
  globalThis.fetch = async (path, init) => new Promise((resolve, reject) => {
    calls.push({ path, init, resolve })
    if (init.signal.aborted) reject(init.signal.reason)
    else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  try { await run({ timers, calls }) }
  finally { Object.assign(globalThis, originals) }
}

const actions = [
  signal => helpers.navigationAi.preview('整理', signal),
  signal => helpers.navigationAi.apply('preview-token', signal),
  signal => helpers.navigationAi.undo('undo-token', signal),
]

test('canceling any pending operation rejects promptly and clears its request deadline', async () => {
  await withControlledRequests(async ({ timers, calls }) => {
    for (const action of actions) {
      const controller = new AbortController(), pending = action(controller.signal)
      assert.equal(timers.size, 1)
      controller.abort()
      await assert.rejects(pending, { name: 'AbortError' })
      assert.equal(calls.at(-1).init.signal.aborted, true)
      assert.equal(timers.size, 0)
    }
    const controller = new AbortController(), count = calls.length
    controller.abort()
    await assert.rejects(helpers.navigationAi.preview('取消', controller.signal), { name: 'AbortError' })
    assert.equal(calls.length, count)
    assert.equal(timers.size, 0)
  })
})

test('deadlines exit stalled requests and mutation retries retain the same token', async () => {
  await withControlledRequests(async ({ timers, calls }) => {
    for (const action of actions) {
      const pending = action()
      assert.equal(timers.size, 1)
      const previous = calls.at(-1)
      timers.values().next().value.callback()
      await assert.rejects(pending, /超时/)
      assert.equal(previous.init.signal.aborted, true)
      assert.equal(timers.size, 0)
      const retry = action()
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), JSON.parse(previous.init.body))
      calls.at(-1).resolve(new Response(JSON.stringify({ ok: true })))
      assert.deepEqual(await retry, { ok: true })
      assert.equal(timers.size, 0)
    }
  })
})

test('server conflicts remain actionable errors and release pending request deadlines', async () => {
  await withControlledRequests(async ({ timers, calls }) => {
    const pending = helpers.navigationAi.apply('stale-preview-token')
    calls.at(-1).resolve(new Response(JSON.stringify({ error: 'navigation_conflict', message: '首页已变化，请重新生成' }), { status: 409 }))
    await assert.rejects(pending, error => error.status === 409 && error.message === '首页已变化，请重新生成')
    assert.equal(timers.size, 0)
  })
})
