/** Optional browser regression: use an installed Playwright package and Chromium. No real profile or server. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createFile, sealFile, upsertItem } from '../chrome_plug_in/src/vault.js'
import { tForLocale } from '../chrome_plug_in/ui/i18n.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modulePath = process.env.PLAYWRIGHT_MODULE
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright')
await fs.mkdir(path.join(ROOT, '.tmp'), { recursive: true })
const profile = await fs.mkdtemp(path.join(ROOT, '.tmp', 'extension-browser-'))
await fs.mkdir(path.join(profile, 'Default'))
await fs.writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }))
const errors = []
const master = 'Browser-Test-Master!2026'
const remoteMaster = 'Remote-Test-Master!2026'
const remoteVault = await createFile(remoteMaster)
const sealed = await sealFile(remoteVault.file, upsertItem(remoteVault.vault, {
  id: 'remote-account', title: '远端演示账号', url: 'https://example.com', username: 'remote-demo', password: 'Remote-Demo!123',
}), remoteVault.vaultKey)
let remote = { version: 4, blob: JSON.stringify(sealed.file), updated_at: Date.now() }
let pushes = 0
let logins = 0
const server = http.createServer(async (req, res) => {
  if (req.url === '/login-form') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<!doctype html><title>本地填充测试</title><form id="login"><label>账号<input name="username" autocomplete="username"></label><label>密码<input name="password" type="password" autocomplete="current-password"></label><button>登录</button></form><form id="other"><input name="other-user"><input name="other-pass" type="password"></form>')
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, service: 'home-dashboard' }))
  if (req.url === '/api/auth/login') {
    logins++
    assert.deepEqual(body, { username: 'demo', password: 'Server-Demo!123' })
    return res.end(JSON.stringify({ access_token: 'test-access-token' }))
  }
  if (req.url !== '/api/vault') { res.statusCode = 404; return res.end('{}') }
  if (req.headers.authorization !== 'Bearer test-access-token') { res.statusCode = 401; return res.end('{}') }
  if (req.method === 'GET') return res.end(JSON.stringify(remote))
  if (body.base_version !== remote.version) {
    res.statusCode = 409
    return res.end(JSON.stringify({ error: 'conflict', message: '服务器版本已更新', ...remote }))
  }
  pushes++
  remote = { version: remote.version + 1, blob: body.blob, updated_at: Date.now() }
  res.end(JSON.stringify({ version: remote.version }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let context
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.TEST_BROWSER_CHANNEL || 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      ...(process.env.TEST_BROWSER_CHANNEL === 'chrome' ? [] : [`--disable-extensions-except=${path.join(ROOT, 'chrome_plug_in')}`, `--load-extension=${path.join(ROOT, 'chrome_plug_in')}`]),
      '--disable-background-networking', '--enable-unsafe-extension-debugging',
    ],
  })
  context.setDefaultTimeout(15_000)
  let installedId
  if (process.env.TEST_BROWSER_CHANNEL === 'chrome') {
    const cdp = await context.browser().newBrowserCDPSession()
    installedId = (await cdp.send('Extensions.loadUnpacked', { path: path.join(ROOT, 'chrome_plug_in') })).id
    await cdp.detach()
  }
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  await worker.evaluate(() => chrome.storage.local.set({ language: 'zh-CN' }))
  const id = installedId || new URL(worker.url()).host
  const url = (page) => `chrome-extension://${id}/${page}/${page}.html`
  const options = await context.newPage()
  const track = (page) => page.on('pageerror', (err) => errors.push(err.message))
  track(options)
  options.on('dialog', (dialog) => dialog.accept())
  await options.goto(url('options'))
  await options.locator('#intro-dialog').waitFor({ state: 'visible' })
  await options.screenshot({ path: path.join(ROOT, '.tmp', 'extension-intro-zh.png'), animations: 'disabled' })
  await options.locator('#intro-start').click()
  await options.locator('#intro-dialog').waitFor({ state: 'hidden' })
  await options.locator('#wizard-password').fill(master)
  await options.locator('#wizard-password2').fill(master)
  await options.locator('#wizard-create').click()
  await options.locator('#step-2').waitFor({ state: 'visible' })
  assert.match(await options.locator('#wizard-step-title').innerText(), /第 2 步/)
  await options.locator('#srv-local-only').click()
  await options.locator('#step-3').waitFor({ state: 'visible' })
  await options.locator('#wizard-done').click()
  await options.locator('#main').waitFor({ state: 'visible' })
  // Headless input does not count as OS activity. Keep unrelated desktop idle
  // transitions out of this UI scenario; lock propagation is exercised below.
  await options.locator('#lock-on-idle').uncheck()
  await options.locator('#settings-msg').filter({ hasText: '已保存' }).waitFor()
  console.log('PASS: first-run wizard completes without startup errors')

  const quickSettings = await context.newPage()
  track(quickSettings)
  await quickSettings.goto(url('options'))
  await quickSettings.locator('#main').waitFor({ state: 'visible' })
  await quickSettings.evaluate(() => {
    for (const [id, value] of [['account-base', 'http://127.0.0.1:9399'], ['account-user', 'closed-immediately']]) {
      const input = document.getElementById(id)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await quickSettings.close({ runBeforeUnload: true })
  await options.waitForFunction(async () => (await chrome.storage.local.get('serverFormDraft')).serverFormDraft?.user === 'closed-immediately')
  await options.reload()
  await options.locator('#main').waitFor({ state: 'visible' })
  assert.equal(await options.locator('#account-user').inputValue(), 'closed-immediately')
  console.log('PASS: closing settings immediately after input preserves the latest non-secret draft')

  await options.locator('#account-base').fill('http://127.0.0.1:9388')
  await options.locator('#account-user').fill('cached-demo')
  await options.locator('#account-password').fill('Unsaved-Test-Secret!')
  await options.locator('#language-select').selectOption('en')
  await options.waitForFunction(() => document.documentElement.lang === 'en')
  assert.equal(await options.locator('#account-user').inputValue(), 'cached-demo')
  assert.equal(await options.locator('#account-password').inputValue(), 'Unsaved-Test-Secret!')
  assert.equal(await options.locator('#intro-open').innerText(), tForLocale('en', '使用介绍'))
  await options.waitForFunction(async () => (await chrome.storage.local.get('serverFormDraft')).serverFormDraft?.user === 'cached-demo')
  const draft = await options.evaluate(async () => (await chrome.storage.local.get('serverFormDraft')).serverFormDraft)
  assert.deepEqual(draft, { base: 'http://127.0.0.1:9388', user: 'cached-demo' })
  await options.reload()
  await options.locator('#main').waitFor({ state: 'visible' })
  assert.equal(await options.locator('#account-base').inputValue(), 'http://127.0.0.1:9388')
  assert.equal(await options.locator('#account-user').inputValue(), 'cached-demo')
  assert.equal(await options.locator('#account-password').inputValue(), '')
  assert.equal(await options.locator('#intro-dialog').isVisible(), false)
  assert.equal(await options.locator('html').getAttribute('lang'), 'en')
  await options.locator('#intro-open').click()
  await options.locator('#intro-dialog').waitFor({ state: 'visible' })
  assert.equal(await options.locator('#intro-title').innerText(), tForLocale('en', '把密码，留在你手里'))
  await options.screenshot({ path: path.join(ROOT, '.tmp', 'extension-intro-en.png'), animations: 'disabled' })
  await options.keyboard.press('Escape')
  await options.locator('#intro-dialog').waitFor({ state: 'hidden' })
  assert.equal(await options.evaluate(() => document.activeElement.id), 'intro-open')
  await options.locator('#language-select').selectOption('zh-CN')
  console.log('PASS: language and non-secret server draft survive reload; introduction appears once and reopens accessibly')

  const popup = await context.newPage()
  await popup.setViewportSize({ width: 416, height: 600 })
  track(popup)
  popup.on('dialog', (dialog) => dialog.accept())
  await popup.goto(url('popup'))
  await popup.locator('#add').click()
  await popup.locator('#e-title').fill('本地测试账号')
  await popup.locator('#e-url').fill(base)
  await popup.locator('#e-user').fill('demo-user')
  await popup.locator('#e-pass').fill('Demo-Password!123')
  for (const locale of ['en', 'zh-TW', 'ja']) {
    await popup.locator('#language-select').selectOption(locale)
    await popup.waitForFunction((expected) => document.documentElement.lang === expected, locale)
    await options.waitForFunction((expected) => document.documentElement.lang === expected, locale)
    assert.equal(await popup.locator('#e-save').innerText(), tForLocale(locale, '保存账号'))
    assert.equal(await popup.locator('#e-title').inputValue(), '本地测试账号')
    assert.equal(await popup.locator('#e-pass').inputValue(), 'Demo-Password!123')
    assert.equal(await options.locator('#account-user').inputValue(), 'cached-demo')
    await popup.locator('#intro-open').click()
    assert.equal(await popup.locator('#intro-title').innerText(), tForLocale(locale, '把密码，留在你手里'))
    assert.equal(await popup.evaluate(() => document.querySelector('#intro-dialog').scrollWidth <= innerWidth), true)
    await popup.keyboard.press('Escape')
    await popup.locator('#intro-dialog').waitFor({ state: 'hidden' })
  }
  await popup.locator('#language-select').selectOption('zh-CN')
  console.log('PASS: all four UI languages update across pages without clearing edited credentials')
  assert.equal(await popup.locator('#e-pass').getAttribute('type'), 'password')
  await popup.locator('#e-save').click()
  await popup.waitForFunction(() => document.querySelector('.item') || document.querySelector('#edit-msg.bad')?.textContent)
  assert.equal(await popup.locator('#edit-msg.bad').count(), 0, await popup.locator('#edit-msg').innerText())
  await popup.locator('.item').first().click()
  assert.equal(await popup.locator('#d-pass').innerText(), '••••••••')
  await popup.locator('#d-reveal').click()
  assert.equal(await popup.locator('#d-pass').innerText(), 'Demo-Password!123')
  await popup.locator('#d-back').click()
  await popup.locator('#search').fill('does-not-exist')
  assert.match(await popup.locator('#empty').innerText(), /没有匹配/)
  await popup.locator('#search').fill('')
  await popup.screenshot({ path: path.join(ROOT, '.tmp', 'extension-popup-list.png'), animations: 'disabled' })
  await popup.locator('#intro-open').click()
  assert.equal(await popup.evaluate(() => document.querySelector('#intro-dialog').scrollWidth <= innerWidth), true)
  await popup.screenshot({ path: path.join(ROOT, '.tmp', 'extension-intro-popup.png'), animations: 'disabled' })
  await popup.locator('#intro-start').click()
  await popup.locator('.item').first().click()
  await popup.screenshot({ path: path.join(ROOT, '.tmp', 'extension-popup.png'), animations: 'disabled' })
  await popup.emulateMedia({ colorScheme: 'dark' })
  await popup.screenshot({ path: path.join(ROOT, '.tmp', 'extension-popup-dark.png'), animations: 'disabled' })
  await popup.emulateMedia({ colorScheme: 'light' })
  console.log('PASS: create, search, masked details and explicit reveal')

  const login = await context.newPage()
  track(login)
  await login.goto(`${base}/login-form`)
  await login.locator('#login input[type=password]').focus()
  const saved = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'list' }))
  const fill = await options.evaluate(async ({ base, id }) => {
    const tabs = await chrome.tabs.query({ url: `${base}/*` })
    return chrome.tabs.sendMessage(tabs[0].id, { type: 'hd-pm-fill', id }, { frameId: 0 })
  }, { base, id: saved.data.items[0].id })
  assert.equal(fill.ok, true, JSON.stringify(fill))
  assert.equal(fill.filled, true)
  assert.equal(await login.locator('#login input[name=username]').inputValue(), 'demo-user')
  assert.equal(await login.locator('#login input[name=password]').inputValue(), 'Demo-Password!123')
  assert.equal(await login.locator('#other input[name=other-pass]').inputValue(), '')
  console.log('PASS: real content-script fill only touches the selected form')

  await popup.bringToFront()
  await popup.locator('#d-edit').click()
  await popup.locator('#e-user').fill('unsaved-user-edit')
  await options.bringToFront()
  await options.locator('#auto-push').uncheck()
  await options.locator('#settings-msg').filter({ hasText: '已保存' }).waitFor()
  await options.locator('#account-base').fill(base)
  await options.locator('#account-user').fill('demo')
  await options.locator('#account-password').fill('Server-Demo!123')
  await options.locator('#account-connect').click()
  await options.locator('#conflict-note').waitFor({ state: 'visible' })
  assert.equal(pushes, 0)
  await options.locator('#remote-password').fill(remoteMaster)
  await options.locator('#sync-pull').click()
  await options.locator('#account-msg').filter({ hasText: '已恢复 1 条账号' }).waitFor()
  assert.equal(pushes, 0)
  const imported = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'list' }))
  assert.equal(imported.data.items[0].username, 'remote-demo')
  await popup.locator('#edit-msg').filter({ hasText: '密码库已在其他页面更新' }).waitFor()
  assert.equal(await popup.locator('#e-user').inputValue(), 'unsaved-user-edit')
  await popup.locator('#e-cancel').click()
  await popup.locator('.item').filter({ hasText: '远端演示账号' }).waitFor()
  assert.equal(await popup.locator('#detail-view').isVisible(), false)
  assert.equal(await popup.locator('#d-user').innerText(), '')
  await options.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await options.screenshot({ path: path.join(ROOT, '.tmp', 'extension-options.png'), fullPage: true, animations: 'disabled' })
  await options.screenshot({ path: path.join(ROOT, '.tmp', 'extension-options-top.png'), animations: 'disabled' })
  console.log('PASS: binding does not overwrite existing vault; cross-device recovery uses remote master password')

  await options.locator('#master-current').fill('Temporary-UI-Secret')
  await popup.bringToFront()
  await popup.locator('#lock').click()
  await options.locator('#locked').waitFor({ state: 'visible' })
  assert.equal(await options.locator('#master-current').inputValue(), '')
  assert.equal(await popup.locator('#d-user').innerText(), '')
  console.log('PASS: another-window recovery refreshes cached items; locking clears hidden options secrets')
  await options.bringToFront()
  await options.locator('#unlock-password').fill(remoteMaster)
  await options.locator('#unlock-btn').click()
  await options.locator('#main').waitFor({ state: 'visible' })
  await options.locator('#sync-push').click()
  await options.locator('#account-msg').filter({ hasText: '上传完成' }).waitFor()
  assert.equal(pushes, 1)
  assert.ok(logins >= 1)
  console.log('PASS: recovered master password unlocks; manual upload advances version')
  await options.reload()
  await options.locator('#main').waitFor({ state: 'visible' })
  assert.equal(await options.locator('#account-base').inputValue(), base)
  assert.equal(await options.locator('#account-user').inputValue(), 'demo')
  assert.equal(await options.locator('#account-password').inputValue(), '')
  assert.equal(await options.locator('#account-password').getAttribute('placeholder'), tForLocale('zh-CN', '已加密保存，留空可沿用'))
  const previousLogins = logins
  await options.locator('#account-connect').click()
  await options.locator('#conflict-note').waitFor({ state: 'visible' })
  assert.equal(logins, previousLogins + 1)
  assert.equal(pushes, 1)
  console.log('PASS: reconnect uses encrypted credentials with a blank password and preserves remote vault')
  await options.setViewportSize({ width: 540, height: 850 })
  await options.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await options.screenshot({ path: path.join(ROOT, '.tmp', 'extension-options-mobile.png'), fullPage: true, animations: 'disabled' })
  await options.setViewportSize({ width: 1280, height: 850 })
  await options.emulateMedia({ colorScheme: 'dark' })
  await options.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await options.screenshot({ path: path.join(ROOT, '.tmp', 'extension-options-dark.png'), fullPage: true, animations: 'disabled' })
  const secondSettings = await context.newPage()
  track(secondSettings)
  await secondSettings.goto(url('options'))
  await secondSettings.locator('#main').waitFor({ state: 'visible' })
  await secondSettings.locator('#account-user').fill('pending-other-tab')
  await options.locator('#account-forget').click()
  await options.locator('#account-msg').filter({ hasText: '已解绑' }).waitFor()
  assert.equal(await options.locator('#account-forget').isDisabled(), true)
  assert.equal(await options.locator('#sync-push').isDisabled(), true)
  const forgottenDraft = await options.evaluate(async () => (await chrome.storage.local.get('serverFormDraft')).serverFormDraft)
  assert.equal(forgottenDraft == null, true)
  await secondSettings.waitForFunction(() => document.getElementById('account-user').value === '')
  // Wait past the second page's debounce deadline to catch a stale resurrection.
  await secondSettings.waitForTimeout(350)
  assert.equal(await secondSettings.evaluate(async () => (await chrome.storage.local.get('serverFormDraft')).serverFormDraft == null), true)
  await secondSettings.close()
  console.log('PASS: unbinding clears drafts in every settings page without a stale delayed write')
  console.log('PASS: business-disabled buttons remain disabled after async actions')
  assert.deepEqual(errors, [])
  console.log('PASS: no extension page JavaScript errors')
  console.log(`Screenshots: ${path.join(ROOT, '.tmp', 'extension-popup.png')} and extension-options.png`)
} catch (err) {
  console.error('Browser page errors:', errors)
  for (const page of context?.pages() ?? []) {
    if (!page.url().includes('chrome-extension://')) continue
    console.error('Failed page state:', await page.evaluate(() => ({
      page: location.pathname,
      visibleViews: ['gate', 'list-view', 'detail-view', 'edit-view'].filter((id) => {
        const el = document.getElementById(id)
        return el && !el.classList.contains('hidden')
      }),
      gate: document.getElementById('gate-text')?.textContent,
      messages: Array.from(document.querySelectorAll('.msg')).map((el) => el.textContent).filter(Boolean),
    })).catch(() => null))
  }
  throw err
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}
