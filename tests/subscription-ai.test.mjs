import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const root = fileURLToPath(new URL('../app/server/', import.meta.url))
const workspace = mkdtempSync(path.join(tmpdir(), 'hd-subscription-ai-'))
const output = path.join(workspace, 'fixture.mjs')
const existingRequest = globalThis.__aiFixtureRequest
let h, token, otherToken, respond
const calls = []
const validRules = ['DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,PROXY']
const completion = (content = JSON.stringify({ rules: validRules, summary: '示例域名直连，其余代理' }), finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { content } }] })
before(async () => {
  await build({
    stdin: { contents: `
      export { subscriptionRoutes } from './src/routes/subscriptions.ts';
      export * from './src/lib/subscription-ai.ts';
      export { requestAiCompletion, normalizeAiBaseUrl } from './src/lib/subscription-ai-transport.ts';
      export { sql, closeDb } from './src/lib/db.ts';
      export { initDatabase } from './src/db/schema.ts';
      export { issueAccessToken, createRefreshToken } from './src/lib/tokens.ts';
      export { bootstrapRoutes } from './src/routes/bootstrap.ts';
    `, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: output,
    banner: { js: SERVER_ESM_BANNER }, plugins: [{ name: 'ai-fixture', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'ai-fixture' }))
      builder.onResolve({ filter: /\/subscription-ai-transport\.js$/ }, () => ({ path: 'transport', namespace: 'ai-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'ai-fixture' }, ({ path: file }) => ({
        contents: file === 'config' ? `
          import { mkdirSync } from 'node:fs';
          export const DB_FILE = ${JSON.stringify(path.join(workspace, 'app.db'))};
          export const REFRESH_DAYS = 30;
          export const PUBLIC_VIEW = false;
          export const ADMIN_USERNAME = 'ai-fixture'; export const ADMIN_PASSWORD = 'test-only';
          export const ENV_AGENT_TOKEN = 'test-only-agent'; export const ENV_JWT_SECRET = 'test-only-ai-encryption-root';
          export const UPLOAD_DIR = ${JSON.stringify(path.join(workspace, 'uploads'))};
          export function ensureDirs() { mkdirSync(${JSON.stringify(workspace)}, { recursive: true }); }
        ` : `
          export { normalizeAiBaseUrl, SubscriptionAiError } from ${JSON.stringify(path.join(root, 'src/lib/subscription-ai-transport.ts'))};
          export const requestAiCompletion = (...args) => globalThis.__aiFixtureRequest(...args);
        `, resolveDir: root, loader: 'js',
      }))
    } }],
  })
  globalThis.__aiFixtureRequest = (...args) => { calls.push(args); return respond(...args) }
  h = await import(pathToFileURL(output).href)
  h.initDatabase()
  h.sql.run("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (2, 'other', 'unused', 1, 1)")
  const session = h.createRefreshToken(1, 'fixture', null), other = h.createRefreshToken(2, 'fixture', null)
  token = await h.issueAccessToken({ id: 1, username: 'ai-fixture' }, session.sessionId)
  otherToken = await h.issueAccessToken({ id: 2, username: 'other' }, other.sessionId)
})
beforeEach(() => {
  h.sql.run('DELETE FROM subscription_ai_settings')
  h.sql.run('DELETE FROM subscription_profiles')
  h.sql.run('DELETE FROM subscription_sources')
  respond = async () => completion()
  calls.length = 0
})
after(() => {
  h?.closeDb()
  if (existingRequest === undefined) delete globalThis.__aiFixtureRequest
  else globalThis.__aiFixtureRequest = existingRequest
  assert.equal(path.dirname(path.resolve(workspace)), path.resolve(tmpdir()))
  assert.ok(path.basename(workspace).startsWith('hd-subscription-ai-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
function request(route, body, auth = token, method = body === undefined ? 'GET' : 'POST') {
  return h.subscriptionRoutes.request('/subscriptions' + route, { method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function settings(body = { api_key: 'sk-fixture-private' }, auth = token) {
  const response = await request('/ai/settings', body, auth, 'PUT')
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).settings
}

test('DeepSeek defaults, settings encryption, account isolation and bootstrap exclusion', async () => {
  assert.equal(h.sql.get('PRAGMA user_version').user_version, 17)
  const initial = await request('/ai/settings')
  assert.equal(initial.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await initial.json()).settings, { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', has_api_key: false, configured: false })
  assert.equal((await request('/ai/settings', undefined, null)).status, 401)
  assert.equal((await request('/ai/generate', { prompt: 'test' })).status, 400)
  assert.equal((await settings()).has_api_key, true)
  const stored = h.sql.get('SELECT * FROM subscription_ai_settings WHERE user_id = 1')
  assert.match(stored.api_key_encrypted, /^v1\./)
  assert.ok(!JSON.stringify(stored).includes('sk-fixture-private'))
  assert.equal((await (await request('/ai/settings', undefined, otherToken)).json()).settings.has_api_key, false)
  const bootstrap = await h.bootstrapRoutes.request('/bootstrap', { headers: { Authorization: `Bearer ${token}` } })
  const bootstrapText = await bootstrap.text()
  assert.ok(!bootstrapText.includes('sk-fixture-private'))
  assert.ok(!bootstrapText.includes(stored.api_key_encrypted))
  assert.equal(h.sql.get("SELECT COUNT(*) AS total FROM settings WHERE key LIKE '%ai%'").total, 0)
})

test('blank key preserves encryption; destination changes require replacement/clear; ciphertext binds account', async () => {
  await settings()
  const saved = h.sql.get('SELECT api_key_encrypted FROM subscription_ai_settings WHERE user_id = 1').api_key_encrypted
  await settings({ api_key: '', model: 'deepseek-v4-pro' })
  assert.equal(h.sql.get('SELECT api_key_encrypted FROM subscription_ai_settings WHERE user_id = 1').api_key_encrypted, saved)
  assert.equal((await request('/ai/settings', { provider: 'openai-compatible', base_url: 'https://example.com/v1' }, token, 'PUT')).status, 400)
  await settings({ provider: 'openai-compatible', base_url: 'https://example.com/v1', api_key: 'replacement-key' })
  await settings({ api_key: 'other-key' }, otherToken)
  h.sql.run('UPDATE subscription_ai_settings SET api_key_encrypted = ? WHERE user_id = 2', saved)
  const swap = await request('/ai/test', {}, otherToken)
  assert.equal(swap.status, 503)
  assert.equal(calls.length, 0)
  await settings({ clear_api_key: true })
  assert.equal((await request('/ai/test', {})).status, 400)
})

test('settings reject invalid secrets, origins and protocol; compatible endpoint normalization is stable', async () => {
  for (const body of [null, [], { provider: 'unknown' }, { api_key: 'key\nmalformed' }, { api_key: '中文密钥' }, { api_key: 'key with spaces' }, { api_key: 'key', clear_api_key: true },
    { base_url: 'https://evil.test' }, { provider: 'openai-compatible', base_url: 'http://example.com' },
    { provider: 'openai-compatible', base_url: 'https://user:secret@example.com' },
    { provider: 'openai-compatible', base_url: 'https://example.com/?key=secret' }, { model: '' }, { clear_api_key: 'true' }]) {
    assert.equal((await request('/ai/settings', body, token, 'PUT')).status, 400)
  }
  assert.equal(h.normalizeAiBaseUrl('https://example.com/v1/chat/completions/'), 'https://example.com/v1')
  assert.throws(() => h.normalizeAiBaseUrl('https://127.0.0.1'), /内网/)
  assert.throws(() => h.normalizeAiBaseUrl('https://[::1]'), /内网/)
  assert.equal((await request('/ai/settings', { api_key: 'x'.repeat(20000) }, token, 'PUT')).status, 413)
})

test('generation transmits only explicit requirement/current rules and DeepSeek protocol fields', async () => {
  await settings()
  const response = await request('/ai/generate', { prompt: 'example.com 直连', current_rules: ['MATCH,PROXY'],
    source_url: 'https://secret-subscription.test/token', proxies: [{ password: 'node-password' }] })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.rules, validRules)
  assert.equal(result.can_apply, true)
  const [base, key, body] = calls[0]
  assert.equal(base, 'https://api.deepseek.com')
  assert.equal(key, 'sk-fixture-private')
  assert.equal(body.model, 'deepseek-flash')
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.equal(body.stream, false)
  assert.ok(!JSON.stringify(body).includes('secret-subscription'))
  assert.ok(!JSON.stringify(body).includes('node-password'))
  assert.deepEqual(JSON.parse(body.messages[1].content), { request: 'example.com 直连', current_rules: ['MATCH,PROXY'] })
  assert.equal(h.sql.get('SELECT COUNT(*) AS total FROM subscription_profiles').total, 0)
  await settings({ provider: 'openai-compatible', base_url: 'https://compatible.example/v1', api_key: 'custom-key' })
  await request('/ai/generate', { prompt: 'default', current_rules: [] })
  assert.deepEqual(Object.keys(calls[1][2]).sort(), ['messages', 'model', 'stream'])
})

test('invalid AI response never partially applies or silently maps policies/defaults', async () => {
  await settings()
  for (const content of ['not JSON', JSON.stringify({ rules: ['DOMAIN,example.com,UnknownGroup', 'MATCH,PROXY'], summary: 'x' }),
    JSON.stringify({ rules: ['DOMAIN,example.com,DIRECT'], summary: 'x' }), JSON.stringify({ rules: ['RULE-SET,remote,PROXY', 'MATCH,PROXY'], summary: 'x' }),
    JSON.stringify({ rules: ['MATCH,DIRECT', 'MATCH,PROXY'], summary: 'x' }), JSON.stringify({ rules: validRules, summary: 'x', proxies: [] }),
    JSON.stringify({ rules: null, summary: 'x' }), JSON.stringify({ summary: 'x' }), JSON.stringify({ rules: [], summary: 'x' })]) {
    respond = async () => completion(content)
    const response = await request('/ai/generate', { prompt: 'test' })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.can_apply, false)
    assert.deepEqual(result.rules, [])
    assert.equal(result.diagnostics[0].level, 'error')
  }
  assert.equal(h.parseAiRoutingResult('```json\n' + JSON.stringify({ rules: validRules, summary: 'x' }) + '\n```', 'model').can_apply, true)
  for (const finish of ['length', 'content_filter', 'aborted', null]) {
    respond = async () => completion(undefined, finish)
    assert.equal((await request('/ai/generate', { prompt: 'test' })).status, 502)
  }
  respond = async () => completion('')
  assert.equal((await request('/ai/generate', { prompt: 'test' })).status, 502)
  respond = async () => null
  assert.equal((await request('/ai/generate', { prompt: 'test' })).status, 502)
})

test('input validation and per-user inflight guard prevent duplicate calls and release after failure', async () => {
  await settings()
  for (const body of [null, [], {}, { prompt: ' ' }, { prompt: 'x'.repeat(8001) }, { prompt: 'test', current_rules: ['RULE-SET,foo,PROXY'] }]) {
    assert.equal((await request('/ai/generate', body)).status, 400)
  }
  assert.equal((await request('/ai/generate', { prompt: 'test', extra: 'x'.repeat(300000) })).status, 413)
  let release
  respond = () => new Promise(resolve => { release = resolve })
  const first = request('/ai/generate', { prompt: 'test' })
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(release)
  assert.equal((await request('/ai/test', {})).status, 409)
  assert.equal(calls.length, 1)
  release(completion('', 'length'))
  assert.equal((await first).status, 502)
  respond = async () => completion('OK')
  const testResult = await request('/ai/test', {})
  assert.equal(testResult.status, 200)
  assert.equal((await testResult.json()).ok, true)
})

test('draft preview uses owner cache, validates empty-cache rules and leaves all profiles/tokens unchanged', async () => {
  const sourceResponse = await request('/sources', { name: 'Source', url: 'https://example.com/sub?secret=fixture' })
  const source = (await sourceResponse.json()).source
  const proxies = [{ name: 'Fixture', type: 'ss', server: 'example.com', port: 443, cipher: 'aes-128-gcm', password: 'fixture' }]
  h.sql.run('UPDATE subscription_sources SET proxies_json = ?, proxy_count = 1, last_success_at = 1 WHERE id = ?', JSON.stringify(proxies), source.id)
  const body = { name: 'Draft', source_ids: [source.id], rules: { rules: validRules } }
  const draft = await request('/profiles/preview', body)
  assert.equal(draft.status, 200)
  const result = await draft.json()
  assert.equal(result.proxy_count, 1)
  assert.ok(result.content.includes('DOMAIN-SUFFIX,example.com,DIRECT'))
  assert.equal(h.sql.get('SELECT COUNT(*) AS total FROM subscription_profiles').total, 0)
  assert.equal((await request('/profiles/preview', body, otherToken)).status, 400)
  assert.equal((await request('/profiles/preview', { ...body, source_ids: [], rules: { rules: ['MATCH,Unknown'] } })).status, 400)
  assert.equal((await request('/profiles/preview', null)).status, 400)
})

test('real transport sends bearer only to pinned target, rejects redirects/private DNS/HTTP and sanitizes failures', async () => {
  const seen = []
  const server = createServer(async (req, res) => {
    let input = ''
    for await (const chunk of req) input += chunk
    seen.push({ url: req.url, auth: req.headers.authorization, body: input })
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/stolen' }); res.end(); return }
    if (req.url.startsWith('/auth')) { res.writeHead(401); res.end('private upstream API key details'); return }
    if (req.url.startsWith('/large')) { res.end('x'.repeat(100)); return }
    if (req.url.startsWith('/timeout')) return
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(completion('OK')))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const result = await h.requestAiCompletion(base + '/v1', 'fixture-bearer', { model: 'test', messages: [] }, { allowPrivate: true })
    assert.equal(result.choices[0].message.content, 'OK')
    assert.deepEqual(seen[0], { url: '/v1/chat/completions', auth: 'Bearer fixture-bearer', body: '{"model":"test","messages":[]}' })
    await assert.rejects(h.requestAiCompletion(base + '/redirect', 'fixture-bearer', {}, { allowPrivate: true }), /重定向/)
    assert.ok(!seen.some(item => item.url === '/stolen'))
    await assert.rejects(h.requestAiCompletion(base + '/auth', 'fixture-bearer', {}, { allowPrivate: true }), error => error.status === 400 && !error.message.includes('private upstream'))
    await assert.rejects(h.requestAiCompletion(base + '/large', 'fixture-bearer', {}, { allowPrivate: true, maxBytes: 32 }), /过大/)
    await assert.rejects(h.requestAiCompletion(base + '/timeout', 'fixture-bearer', {}, { allowPrivate: true, timeoutMs: 30 }), /超时/)
    await assert.rejects(h.requestAiCompletion(base, 'fixture-bearer', {}), /HTTPS/)
    await assert.rejects(h.requestAiCompletion('https://localhost', 'fixture-bearer', {}), /内网/)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
