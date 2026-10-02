import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('../app/web/src/lib/subscriptions.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
})
const helpers = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const saved = { ...helpers.DEEPSEEK_PRESET, has_api_key: true, configured: true }

test('DeepSeek ships with the current documented endpoint and model', () => {
  assert.deepEqual(helpers.DEEPSEEK_PRESET, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash' })
})

test('changing provider or destination cannot accidentally reuse a saved API key', () => {
  assert.equal(helpers.aiSettingsInputError({ ...helpers.DEEPSEEK_PRESET }, saved), null)
  assert.equal(helpers.aiSettingsInputError({ ...helpers.DEEPSEEK_PRESET, base_url: 'https://api.deepseek.com/' }, saved), null)
  for (const change of [{ provider: 'openai-compatible' }, { base_url: 'https://elsewhere.example/v1' }]) {
    const input = { ...helpers.DEEPSEEK_PRESET, ...change }
    assert.match(helpers.aiSettingsInputError(input, saved), /新的 API Key/)
    assert.equal(helpers.aiSettingsInputError({ ...input, api_key: 'new-key' }, saved), null)
    assert.equal(helpers.aiSettingsInputError({ ...input, clear_api_key: true }, saved), null)
  }
  assert.equal(helpers.aiSettingsInputError({ ...helpers.DEEPSEEK_PRESET, model: 'custom-model' }, saved), null)
  assert.equal(helpers.aiSettingsInputError({ ...helpers.DEEPSEEK_PRESET, base_url: 'https://elsewhere.example/v1' }, { ...saved, has_api_key: false }), null)
})

test('AI destination input excludes URL credentials and ambiguous URL metadata', () => {
  for (const base_url of ['invalid', 'file:///secret', 'https://user:key@example.com', 'https://example.com/v1?key=secret', 'https://example.com/#secret']) {
    assert.equal(typeof helpers.aiSettingsInputError({ ...helpers.DEEPSEEK_PRESET, base_url }, null), 'string')
  }
  assert.match(helpers.aiSettingsInputError({ ...helpers.DEEPSEEK_PRESET, model: '  ' }, null), /模型/)
})

test('AI application never permits a partial, empty, or invalid rules response', () => {
  const valid = { rules: ['DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,PROXY'], diagnostics: [], can_apply: true, summary: '分流', model: 'test' }
  assert.equal(helpers.canApplyAIRules(valid), true)
  assert.equal(helpers.canApplyAIRules({ ...valid, can_apply: false }), false)
  assert.equal(helpers.canApplyAIRules({ ...valid, rules: [] }), false)
  assert.equal(helpers.canApplyAIRules({ ...valid, diagnostics: [{ level: 'error', message: 'Bad policy' }] }), false)
  assert.equal(helpers.canApplyAIRules({ ...valid, diagnostics: [{ level: 'warning', message: 'Check coverage' }] }), true)
})

test('AI generation sends only explicit routing context and retains rule order', async () => {
  const original = globalThis.fetch
  const rules = ['DOMAIN,example.com,DIRECT', 'DOMAIN,example.com,DIRECT', 'MATCH,PROXY']
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body), method: init.method })
    return new Response(JSON.stringify({ rules, diagnostics: [], can_apply: true, summary: '', model: 'test' }), { status: 200 })
  }
  try {
    const input = { prompt: '  使用这些规则  ', current_rules: rules, url: 'https://subscription.example/secret', sources: [{ password: 'node-secret' }], api_key: 'provider-secret' }
    const payload = helpers.subscriptionAIPayload(input)
    assert.notEqual(payload.current_rules, rules)
    await helpers.subscriptions.generateRules(input)
    await helpers.subscriptions.generateRules({ prompt: '不附带规则', sources: input.sources })
    assert.deepEqual(calls, [
      { path: '/api/subscriptions/ai/generate', method: 'POST', body: { prompt: '使用这些规则', current_rules: rules } },
      { path: '/api/subscriptions/ai/generate', method: 'POST', body: { prompt: '不附带规则' } },
    ])
  } finally { globalThis.fetch = original }
})

test('draft preview uses a read-only composition endpoint for each output format', async () => {
  const original = globalThis.fetch
  const calls = []
  const input = { name: 'draft', note: '', source_ids: [3], rules: { rules: ['MATCH,PROXY'] }, enabled: true }
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init.method, input: JSON.parse(init.body) })
    return new Response(JSON.stringify({ proxy_count: 2, content: 'preview', warnings: [], content_type: 'text/plain' }))
  }
  try {
    for (const format of ['clash', 'links', 'base64']) await helpers.subscriptions.previewDraft(input, format)
    assert.deepEqual(calls.map((call) => call.path), ['clash', 'links', 'base64'].map((format) => `/api/subscriptions/profiles/preview?format=${format}`))
    assert.ok(calls.every((call) => call.method === 'POST' && JSON.stringify(call.input) === JSON.stringify(input)))
  } finally { globalThis.fetch = original }
})

test('canceling AI generation aborts its request and releases the pending deadline', async () => {
  const original = globalThis.fetch
  let started
  const ready = new Promise((resolve) => { started = resolve })
  globalThis.fetch = async (_path, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    started()
  })
  try {
    const controller = new AbortController()
    const pending = helpers.subscriptions.generateRules({ prompt: 'direct' }, controller.signal)
    await ready
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
  } finally { globalThis.fetch = original }
})
