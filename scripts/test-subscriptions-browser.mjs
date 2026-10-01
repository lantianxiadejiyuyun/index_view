/** Optional real-browser regression; all servers, credentials and data are synthetic. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from './server-bundle-options.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const serverRoot = path.join(ROOT, 'app/server')
const webDist = path.join(ROOT, 'app/web/dist')
await fs.mkdir(path.join(ROOT, '.tmp'), { recursive: true })
const fixture = await fs.mkdtemp(path.join(ROOT, '.tmp/subscriptions-browser-'))
const bundle = path.join(fixture, 'fixture.mjs')
const modulePath = process.env.PLAYWRIGHT_MODULE
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright')
process.env.SUBSCRIPTIONS_ALLOW_PRIVATE_NETWORK = 'true'
await build({
  stdin: { contents: `
    export { Hono } from 'hono';
    export { serve } from '@hono/node-server';
    export { serveStatic } from '@hono/node-server/serve-static';
    export { authRoutes } from './src/routes/auth.ts';
    export { bootstrapRoutes } from './src/routes/bootstrap.ts';
    export { subscriptionRoutes } from './src/routes/subscriptions.ts';
    export { startSubscriptionScheduler, runSubscriptionSchedulerTick } from './src/lib/subscriptions.ts';
    export { initDatabase } from './src/db/schema.ts';
    export { sql, closeDb } from './src/lib/db.ts';
  `, resolveDir: serverRoot, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile: bundle, banner: { js: SERVER_ESM_BANNER },
  plugins: [{ name: 'isolated-subscription-browser-config', setup(builder) {
    builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'subscription-browser' }))
    builder.onLoad({ filter: /.*/, namespace: 'subscription-browser' }, () => ({ loader: 'js', contents: `
      import { mkdirSync } from 'node:fs';
      export const DB_FILE = ${JSON.stringify(path.join(fixture, 'data/app.db'))};
      export const REFRESH_DAYS = 30;
      export const ADMIN_USERNAME = 'subscription-test';
      export const ADMIN_PASSWORD = 'Subscription-Test!2026';
      export const ENV_AGENT_TOKEN = 'test-only-agent-token';
      export const ENV_JWT_SECRET = 'test-only-secret-at-least-thirty-two-characters';
      export const PUBLIC_VIEW = false;
      export function ensureDirs() { mkdirSync(${JSON.stringify(path.join(fixture, 'data'))}, { recursive: true }); }
    ` }))
  } }],
})
const harness = await import(pathToFileURL(bundle).href)
harness.initDatabase()
for (const key of ['show_weather', 'show_hitokoto']) harness.sql.run('UPDATE settings SET value = ? WHERE key = ?', 'false', key)

let pulls = 0
let upstreamFail = false
const upstream = http.createServer((_req, res) => {
  pulls++
  if (upstreamFail) { res.writeHead(503); res.end('temporary test failure'); return }
  res.setHeader('Content-Type', 'application/yaml')
  res.setHeader('subscription-userinfo', `upload=1073741824; download=25769803776; total=107374182400; expire=${Math.floor(Date.now() / 1000) + 172800}`)
  res.end('proxies:\n  - name: Tokyo test\n    type: ss\n    server: proxy.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: synthetic-password\n  - name: Tokyo duplicate\n    type: ss\n    server: proxy.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: synthetic-password\n')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const sourceUrl = `http://127.0.0.1:${upstream.address().port}/subscription?token=test-only`
const app = new harness.Hono()
app.route('/api/auth', harness.authRoutes)
app.route('/api', harness.bootstrapRoutes)
app.route('/api', harness.subscriptionRoutes)
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))
app.use('*', harness.serveStatic({ root: webDist }))
const html = await fs.readFile(path.join(webDist, 'index.html'), 'utf8')
app.get('*', (c) => c.html(html))
const server = harness.serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
const errors = []
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto(`${base}/subscriptions`)
  await page.locator('#login-user').fill('subscription-test')
  await page.locator('#login-pass').fill('Subscription-Test!2026')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL('**/subscriptions')
  console.log('PASS: subscription route requires login and returns to the protected page')

  await page.getByRole('button', { name: '添加订阅源', exact: true }).first().click()
  await page.locator('#subscription-source-name').fill('日常订阅')
  await page.locator('#subscription-source-url').fill(sourceUrl)
  await page.locator('#subscription-source-note').fill('浏览器测试：100 GiB 套餐')
  await page.locator('#subscription-source-interval').fill('5')
  await page.getByRole('button', { name: '保存订阅源', exact: true }).click()
  const source = page.locator('article').filter({ has: page.getByRole('heading', { name: '日常订阅', exact: true }) })
  await source.getByRole('button', { name: '立即拉取', exact: true }).click()
  await source.getByText('已用 25 GiB', { exact: true }).waitFor()
  assert.match(await source.innerText(), /剩余 75 GiB/)
  assert.match(await source.innerText(), /剩余 [12] 天 \d{2}:\d{2}:\d{2}/)
  assert.match(await source.innerText(), /每 5 分钟/)
  assert.equal(await source.getByRole('progressbar').getAttribute('aria-valuenow'), '25')
  assert.equal(pulls, 1)
  await page.screenshot({ path: path.join(ROOT, '.tmp/subscriptions-desktop.png'), fullPage: true, animations: 'disabled' })
  console.log('PASS: source creation, remarks, manual fetch, traffic and expiry countdown')

  // Drive the real scheduler with an overdue persisted timestamp, without waiting five minutes.
  harness.sql.run('UPDATE subscription_sources SET next_fetch_at = ?', Date.now() - 1000)
  await harness.runSubscriptionSchedulerTick()
  assert.equal(pulls, 2)
  assert.ok(harness.sql.get('SELECT next_fetch_at FROM subscription_sources').next_fetch_at > Date.now())
  await source.getByRole('button', { name: '暂停定时', exact: true }).click()
  await source.getByRole('button', { name: '开启定时', exact: true }).waitFor()
  harness.sql.run('UPDATE subscription_sources SET next_fetch_at = ?', Date.now() - 1000)
  await harness.runSubscriptionSchedulerTick()
  assert.equal(pulls, 2)
  // Pausing only affects scheduled work; a failed manual refresh must retain valid cache.
  upstreamFail = true
  await source.getByRole('button', { name: '立即拉取', exact: true }).click()
  await source.getByText('拉取失败，继续使用上次成功的缓存', { exact: true }).waitFor()
  assert.match(await source.innerText(), /已用 25 GiB/)
  assert.equal(harness.sql.get('SELECT proxy_count FROM subscription_sources').proxy_count, 2)
  upstreamFail = false
  await source.getByRole('button', { name: '立即拉取', exact: true }).click()
  await source.getByText('拉取失败，继续使用上次成功的缓存', { exact: true }).waitFor({ state: 'hidden' })
  console.log('PASS: persisted scheduled refresh, pause, manual refresh and failure cache preservation')

  await page.getByRole('tab', { name: '封装配置', exact: true }).click()
  await page.getByRole('button', { name: '新建封装配置', exact: true }).first().click()
  await page.locator('#subscription-profile-name').fill('日常网络')
  await page.locator('#subscription-profile-note').fill('合并、去重与自定义分流')
  await page.getByRole('checkbox', { name: /日常订阅/ }).check()
  await page.locator('#subscription-profile-include').fill('Tokyo')
  await page.locator('#subscription-profile-prefix').fill('[日常] ')
  await page.getByRole('checkbox', { name: '名称追加来源', exact: true }).check()
  await page.getByRole('checkbox', { name: 'ss', exact: true }).check()
  await page.locator('#subscription-profile-rules').fill('DOMAIN-SUFFIX,example.com,DIRECT\nMATCH,PROXY')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  const profile = page.locator('article').filter({ has: page.getByRole('heading', { name: '日常网络', exact: true }) })
  await profile.getByRole('button', { name: '预览与下载', exact: true }).click()
  await page.getByText('1 个输出节点', { exact: true }).waitFor()
  const output = page.locator('pre[aria-label="订阅输出内容"]')
  const yaml = await output.innerText()
  assert.match(yaml, /DOMAIN-SUFFIX,example.com,DIRECT/)
  assert.match(yaml, /\[日常\].*Tokyo test.*日常订阅/)
  assert.match(yaml, /proxy-groups:/)
  const feedUrl = await page.locator('#subscription-preview-url').inputValue()
  const feed = await fetch(feedUrl)
  assert.equal(feed.status, 200)
  assert.equal(feed.headers.get('cache-control'), 'no-store')
  assert.equal(await feed.text(), yaml)
  const pullsBeforeFeed = pulls
  await page.getByRole('button', { name: '通用链接列表', exact: true }).click()
  await output.filter({ hasText: /^ss:\/\// }).waitFor()
  const links = await output.innerText()
  assert.equal(links.trim().split('\n').length, 1)
  assert.equal(await (await fetch(await page.locator('#subscription-preview-url').inputValue())).text(), links)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载', exact: true }).click()
  const download = await downloaded
  assert.match(download.suggestedFilename(), /-links\.txt$/)
  assert.equal(await fs.readFile(await download.path(), 'utf8'), links)
  await page.getByRole('button', { name: 'Base64 链接列表', exact: true }).click()
  await output.filter({ hasText: /^c3M6/ }).waitFor()
  assert.equal(Buffer.from(await output.innerText(), 'base64').toString('utf8'), links)
  assert.equal(pulls, pullsBeforeFeed)
  await page.getByRole('button', { name: 'Clash / Mihomo YAML', exact: true }).click()
  await output.filter({ hasText: /proxy-groups:/ }).waitFor()
  await page.screenshot({ path: path.join(ROOT, '.tmp/subscriptions-preview.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: '关闭', exact: true }).last().click()
  console.log('PASS: source selection, protocol filtering, deduplication, naming, rules, three formats and download')

  await profile.getByRole('button', { name: '重置链接', exact: true }).click()
  await page.getByText('分享链接已重置，请复制新链接', { exact: true }).waitFor()
  assert.equal((await fetch(feedUrl)).status, 404)
  await profile.getByRole('button', { name: '停用分享', exact: true }).click()
  await profile.getByRole('button', { name: '启用分享', exact: true }).waitFor()
  await profile.getByRole('button', { name: '预览与下载', exact: true }).click()
  await page.getByText('1 个输出节点', { exact: true }).waitFor()
  const rotatedUrl = await page.locator('#subscription-preview-url').inputValue()
  assert.notEqual(rotatedUrl, feedUrl)
  assert.equal((await fetch(rotatedUrl)).status, 404)
  await page.getByRole('button', { name: '关闭', exact: true }).last().click()
  await profile.getByRole('button', { name: '启用分享', exact: true }).click()
  await profile.getByRole('button', { name: '停用分享', exact: true }).waitFor()
  assert.equal((await fetch(rotatedUrl)).status, 200)
  await page.reload()
  await page.getByRole('tab', { name: '封装配置', exact: true }).click()
  await profile.getByText('合并、去重与自定义分流', { exact: true }).waitFor()
  console.log('PASS: revocable feed tokens, disabled sharing, authenticated preview and persisted data')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tab', { name: '订阅源', exact: true }).click()
  await source.getByText('已用 25 GiB', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.screenshot({ path: path.join(ROOT, '.tmp/subscriptions-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: path.join(ROOT, '.tmp/subscriptions-mobile-dark.png'), fullPage: true, animations: 'disabled' })
  await source.getByRole('button', { name: '编辑订阅源 日常订阅', exact: true }).click()
  await page.locator('#subscription-source-note').fill('修改后的备注')
  await page.getByRole('button', { name: '保存订阅源', exact: true }).click()
  await source.getByText('修改后的备注', { exact: true }).waitFor()
  await page.getByRole('tab', { name: '封装配置', exact: true }).click()
  await profile.getByRole('button', { name: '删除封装配置 日常网络', exact: true }).click()
  await profile.waitFor({ state: 'hidden' })
  assert.equal((await fetch(rotatedUrl)).status, 404)
  await page.getByRole('tab', { name: '订阅源', exact: true }).click()
  await source.getByRole('button', { name: '删除订阅源 日常订阅', exact: true }).click()
  await source.waitFor({ state: 'hidden' })
  console.log('PASS: mobile layout, source editing and deletion lifecycle')
  assert.deepEqual(errors, [])
  console.log(`Screenshots: ${path.join(ROOT, '.tmp/subscriptions-*.png')}`)
} finally {
  await browser?.close()
  server.closeAllConnections()
  upstream.closeAllConnections()
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))])
  harness.closeDb()
}
