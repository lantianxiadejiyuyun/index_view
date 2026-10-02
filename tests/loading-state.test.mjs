import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../app/web/src/store/loading.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text
let generation = 0
const fixture = () => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${++generation}`)

test('repeated photo progress updates retain one active operation and one end closes it', async () => {
  const { useLoading, beginLoading, updateLoading, endLoading } = await fixture()
  beginLoading('正在处理 4 张…')
  for (let index = 0; index < 4; index++) {
    updateLoading(`正在处理第 ${index + 1}/4 张…`)
    assert.equal(useLoading.getState().count, 1)
    assert.equal(useLoading.getState().text, `正在处理第 ${index + 1}/4 张…`)
  }
  updateLoading('正在上传 4 张…')
  assert.equal(useLoading.getState().count, 1)
  assert.equal(useLoading.getState().text, '正在上传 4 张…')
  endLoading()
  assert.equal(useLoading.getState().count, 0)
})

test('failed work closes only its own loading operation while another request remains pending', async () => {
  const { useLoading, updateLoading, withLoading } = await fixture()
  let finishBackground
  const background = withLoading('后台同步…', () => new Promise((resolve) => { finishBackground = resolve }))
  assert.equal(useLoading.getState().count, 1)
  await assert.rejects(withLoading('正在上传…', async () => {
    assert.equal(useLoading.getState().count, 2)
    for (let index = 0; index < 40; index++) updateLoading(`处理 ${index + 1}/40`)
    assert.equal(useLoading.getState().count, 2)
    throw new Error('Upload failed')
  }), /Upload failed/)
  assert.equal(useLoading.getState().count, 1, 'failure cleanup must leave the background operation active')
  finishBackground('done')
  assert.equal(await background, 'done')
  assert.equal(useLoading.getState().count, 0)
})

test('thumbnail backfill progress and skipped items do not leak loading references', async () => {
  const { useLoading, beginLoading, updateLoading, endLoading } = await fixture()
  beginLoading('正在处理 0/4…')
  try {
    for (let index = 0; index < 4; index++) {
      updateLoading(`正在处理 ${index + 1}/4…`)
      if (index === 1) continue
      if (index === 2) throw new Error('Unexpected image failure')
    }
  } catch (error) {
    assert.equal(error.message, 'Unexpected image failure')
  } finally {
    endLoading()
  }
  assert.equal(useLoading.getState().count, 0)
})

test('progress text alone never opens the overlay and synchronous failures release their reference', async () => {
  const { useLoading, updateLoading, withLoading, endLoading } = await fixture()
  updateLoading('稍后处理')
  assert.equal(useLoading.getState().count, 0)
  await assert.rejects(withLoading('开始处理…', () => { throw new Error('Immediate failure') }), /Immediate failure/)
  assert.equal(useLoading.getState().count, 0)
  endLoading()
  assert.equal(useLoading.getState().count, 0)
})
