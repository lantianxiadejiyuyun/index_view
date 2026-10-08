import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../chrome_plug_in/src/appearance.js'
import { tForLocale } from '../chrome_plug_in/ui/i18n.js'
import { send as runtimeSend } from '../chrome_plug_in/ui/common.js'
import { deferred, fixture, setup } from './helpers/extension-autolock-harness.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const optionsSource = await readFile(new URL('../chrome_plug_in/options/options.js', import.meta.url), 'utf8')
const optionsHtml = await readFile(new URL('../chrome_plug_in/options/options.html', import.meta.url), 'utf8')
const appearanceUiSource = optionsSource.slice(optionsSource.indexOf('function initWebsiteAppearance()'), optionsSource.indexOf('\nlet hasVault'))
const controlIds = ['bilibili-theme', 'taobao-theme', 'goofish-theme', 'hide-bilibili-adblock-tips']

function optionsView(send, timers = {}) {
  const elements = Object.fromEntries([...controlIds, 'website-appearance-msg', 'website-appearance-retry'].map((id) => [id, {
    type: id === 'hide-bilibili-adblock-tips' ? 'checkbox' : 'select-one',
    value: '', checked: false, disabled: false, textContent: '', listeners: {},
    classList: { values: new Set(), toggle(name, enabled) { if (enabled) this.values.add(name); else this.values.delete(name) }, contains(name) { return this.values.has(name) } },
    addEventListener(type, listener) { this.listeners[type] = listener },
  }]))
  const listeners = []
  const languageListeners = []
  let locale = 'zh-CN'
  vm.runInNewContext(appearanceUiSource + '\ninitWebsiteAppearance()', {
    $: (id) => elements[id],
    send, normalizeAppearance, setTimeout: timers.setTimeout ?? setTimeout, clearTimeout: timers.clearTimeout ?? clearTimeout,
    setMsg: (el, text, kind) => Object.assign(el, { textContent: text, kind }),
    t: (key, values) => tForLocale(locale, key, values),
    translateError: (error) => tForLocale(locale, error.message),
    onLanguageChange: (listener) => languageListeners.push(listener),
    chrome: { storage: { onChanged: { addListener: (listener) => listeners.push(listener) } } },
  })
  return {
    elements,
    get message() { return elements['website-appearance-msg'] },
    retry() { return elements['website-appearance-retry'].listeners.click() },
    change(id, value) {
      const element = elements[id]
      if (element.type === 'checkbox') element.checked = value
      else element.value = value
      return element.listeners.change()
    },
    emit(value, area = 'local') { listeners.forEach((listener) => listener({ websiteAppearance: { newValue: value } }, area)) },
    language(value) { locale = value; languageListeners.forEach((listener) => listener()) },
  }
}

test('appearance defaults extend existing Bilibili preferences and reject corrupt or inherited values', () => {
  assert.deepEqual(normalizeAppearance({ bilibiliTheme: 'off' }), { ...DEFAULT_APPEARANCE, bilibiliTheme: 'off' })
  for (const value of [undefined, null, [], 'off', { bilibiliTheme: true, taobaoTheme: 'dark', goofishTheme: null, hideBilibiliAdblockTips: 'false' }, Object.create({ taobaoTheme: 'off', hideBilibiliAdblockTips: false })]) {
    assert.deepEqual(normalizeAppearance(value), DEFAULT_APPEARANCE)
  }
  assert.deepEqual(normalizeAppearance({ goofishTheme: 'off', hideBilibiliAdblockTips: false }), { ...DEFAULT_APPEARANCE, goofishTheme: 'off', hideBilibiliAdblockTips: false })
})

test('first-run appearance settings need no vault and only access their own storage key', async (t) => {
  const h = await setup(t)
  assert.equal((await h.ok('status')).hasVault, false)
  const operations = []
  h.interceptStorage((operation) => operations.push(operation))
  assert.deepEqual(await h.ok('appearance-get'), DEFAULT_APPEARANCE)
  assert.deepEqual(await h.ok('appearance-set', { appearance: { taobaoTheme: 'off' } }), { ...DEFAULT_APPEARANCE, taobaoTheme: 'off' })
  assert.deepEqual(h.storage, { websiteAppearance: { taobaoTheme: 'off' } })
  assert.deepEqual(operations.map(({ kind, keys, patch }) => [kind, keys ?? Object.keys(patch)]), [
    ['get', 'websiteAppearance'], ['get', 'websiteAppearance'], ['set', ['websiteAppearance']],
  ])
  assert.deepEqual(h.requests, [])
  assert.deepEqual(h.idb.operations, [])
})

test('locked-vault appearance updates preserve encrypted data, sync state and unrelated preferences', async (t) => {
  const stored = {
    file: await fixture(), sync: { enabled: true, version: 7, dirty: true },
    settings: { autoLockMinutes: 5 }, language: 'ja',
    websiteAppearance: { bilibiliTheme: 'off', futureOption: { enabled: true } },
  }
  const h = await setup(t, { stored })
  assert.equal((await h.ok('status')).locked, true)
  await h.ok('appearance-set', { appearance: { goofishTheme: 'off' } })
  assert.deepEqual(h.storage, { ...stored, websiteAppearance: { ...stored.websiteAppearance, goofishTheme: 'off' } })
  assert.equal((await h.ok('status')).locked, true)
})

test('website content scripts and other extensions cannot read or modify appearance through runtime messages', async (t) => {
  const h = await setup(t)
  await h.ok('status')
  const operations = []
  h.interceptStorage((operation) => operations.push(operation))
  const id = h.chrome.runtime.id
  for (const sender of [
    { id, tab: { id: 1 }, url: 'https://www.bilibili.com/' },
    { id, tab: { id: 2 }, url: 'https://www.taobao.com/' },
    { id, tab: { id: 3 }, url: 'https://www.goofish.com/' },
    { id: 'other-extension', url: h.chrome.runtime.getURL('options/options.html') },
    { id, url: 'chrome-extension://' + id + '.evil.test/options/options.html' },
    { id },
  ]) {
    for (const type of ['appearance-get', 'appearance-set']) {
      assert.equal((await h.send(type, { appearance: { taobaoTheme: 'off' } }, sender)).code, 'forbidden')
    }
  }
  assert.deepEqual(operations, [])
  assert.deepEqual(h.storage, {})
})

test('appearance patches validate every key and value before any storage access', async (t) => {
  const h = await setup(t)
  await h.ok('status')
  const operations = []
  h.interceptStorage((operation) => operations.push(operation))
  for (const appearance of [undefined, null, [], 'off', {},
    { bilibiliTheme: 'dark' }, { taobaoTheme: true }, { goofishTheme: null },
    { hideBilibiliAdblockTips: 'false' }, { hideBilibiliAdblockTips: 0 },
    { unknownTheme: 'off' }, { taobaoTheme: 'off', file: {} },
    JSON.parse('{"__proto__":{"taobaoTheme":"off"}}'),
  ]) assert.equal((await h.send('appearance-set', { appearance })).code, 'invalid_appearance')
  assert.deepEqual(operations, [])
  assert.deepEqual(h.storage, {})
})

test('concurrent settings pages merge sibling patches without losing older or future fields', async (t) => {
  const h = await setup(t, { stored: { websiteAppearance: { bilibiliTheme: 'off', futureOption: 123 } } })
  await h.ok('status')
  const started = deferred()
  const release = deferred()
  const writes = []
  h.interceptStorage(async ({ kind, patch }) => {
    if (kind !== 'set') return
    writes.push(structuredClone(patch))
    if (writes.length === 1) { started.resolve(); await release.promise }
  })
  const first = h.ok('appearance-set', { appearance: { taobaoTheme: 'off' } })
  await started.promise
  const second = h.ok('appearance-set', { appearance: { goofishTheme: 'off' } }, {
    id: h.chrome.runtime.id, tab: { id: 2 }, url: h.chrome.runtime.getURL('options/options.html'),
  })
  const third = h.ok('appearance-set', { appearance: { hideBilibiliAdblockTips: false } })
  await tick()
  const pendingWrites = writes.length
  release.resolve()
  await Promise.all([first, second, third])
  assert.equal(pendingWrites, 1, 'Only the first settings page can write while its transaction is pending')
  assert.deepEqual(h.storage.websiteAppearance, {
    bilibiliTheme: 'off', taobaoTheme: 'off', goofishTheme: 'off', hideBilibiliAdblockTips: false, futureOption: 123,
  })
})

test('failed appearance writes keep the stored preferences and do not poison later requests', async (t) => {
  const h = await setup(t, { stored: { websiteAppearance: { bilibiliTheme: 'off' } } })
  await h.ok('status')
  let failures = 0
  h.interceptStorage(({ kind, patch }) => {
    if (kind === 'set' && patch.websiteAppearance && failures++ === 0) throw new Error('Fixture storage failure')
  })
  assert.equal((await h.send('appearance-set', { appearance: { taobaoTheme: 'off' } })).ok, false)
  assert.deepEqual(h.storage.websiteAppearance, { bilibiliTheme: 'off' })
  await h.ok('appearance-set', { appearance: { goofishTheme: 'off' } })
  assert.deepEqual(await h.ok('appearance-get'), { ...DEFAULT_APPEARANCE, bilibiliTheme: 'off', goofishTheme: 'off' })
})

test('reset-all waits for pending appearance writes and clears their results', async (t) => {
  const h = await setup(t, { stored: { websiteAppearance: { bilibiliTheme: 'off', futureOption: 123 } } })
  await h.ok('status')
  const started = deferred()
  const release = deferred()
  h.interceptStorage(async ({ kind, patch }) => {
    if (kind === 'set' && patch.websiteAppearance) { started.resolve(); await release.promise }
  })
  const pending = h.ok('appearance-set', { appearance: { taobaoTheme: 'off' } })
  await started.promise
  let resetCompleted = false
  const reset = h.ok('reset-all').then(() => { resetCompleted = true })
  for (let turn = 0; turn < 10; turn++) await tick()
  const completedBeforeWrite = resetCompleted
  release.resolve()
  await Promise.all([pending, reset])
  assert.equal(completedBeforeWrite, false, 'Reset must not finish before an older appearance write')
  assert.equal(h.storage.websiteAppearance, undefined, 'An old appearance write must never resurrect cleared settings')
  assert.deepEqual(await h.ok('appearance-get'), DEFAULT_APPEARANCE)
})

test('a failed reset leaves preferences available and never blocks the appearance queue', async (t) => {
  const h = await setup(t, { stored: { websiteAppearance: { bilibiliTheme: 'off' } } })
  await h.ok('status')
  const clear = h.chrome.storage.local.clear
  h.chrome.storage.local.clear = async () => { throw new Error('Fixture failed reset') }
  assert.equal((await h.send('reset-all')).ok, false)
  assert.deepEqual(h.storage.websiteAppearance, { bilibiliTheme: 'off' })
  await h.ok('appearance-set', { appearance: { goofishTheme: 'off' } })
  assert.deepEqual(await h.ok('appearance-get'), { ...DEFAULT_APPEARANCE, bilibiliTheme: 'off', goofishTheme: 'off' })
  h.chrome.storage.local.clear = clear
  await h.ok('reset-all')
  assert.deepEqual(await h.ok('appearance-get'), DEFAULT_APPEARANCE)
})

test('appearance requests finish while vault startup recovery is still blocked', async (t) => {
  const h = await setup(t)
  await h.ok('status')
  const started = deferred()
  const release = deferred()
  h.interceptStorage(async ({ kind, keys }) => {
    if (kind === 'get' && Array.isArray(keys) && keys.includes('file')) { started.resolve(); await release.promise }
  })
  await h.restart()
  await started.promise
  let completed = false
  const request = h.ok('appearance-set', { appearance: { hideBilibiliAdblockTips: false } })
    .then(() => h.ok('appearance-get')).then((value) => { completed = true; return value })
  await tick()
  const completedBeforeRecovery = completed
  release.resolve()
  const result = await request
  assert.equal(completedBeforeRecovery, true)
  assert.equal(result.hideBilibiliAdblockTips, false)
})

test('all appearance controls are available outside vault sections and have four-language labels', () => {
  const section = optionsHtml.slice(optionsHtml.indexOf('<section id="website-appearance-section"'), optionsHtml.indexOf('<section id="danger-section"'))
  assert.ok(optionsHtml.indexOf('</section>', optionsHtml.indexOf('<section id="main"')) < optionsHtml.indexOf('<section id="website-appearance-section"'))
  assert.doesNotMatch(section, /class="[^"\n]*hidden/)
  for (const id of controlIds) assert.ok(section.includes(`id="${id}"`))
  for (const label of ['淘宝深色模式', '闲鱼深色模式', '隐藏 Bilibili 广告拦截提示', '网站外观设置无效']) {
    for (const locale of ['en', 'zh-TW', 'ja']) assert.notEqual(tForLocale(locale, label), label)
    assert.equal(tForLocale('zh-CN', label), label)
  }
})

test('options use one-field runtime patches and restore the last confirmed values after a failed save', async () => {
  const calls = []
  const view = optionsView(async (type, payload) => {
    calls.push([type, payload && JSON.parse(JSON.stringify(payload))])
    if (type === 'appearance-get') return { bilibiliTheme: 'off', goofishTheme: 'off' }
    throw new Error('Fixture failed write')
  })
  await tick()
  assert.equal(view.elements['taobao-theme'].value, 'system')
  await view.change('taobao-theme', 'off')
  assert.equal(view.elements['taobao-theme'].value, 'system')
  assert.equal(view.elements['bilibili-theme'].value, 'off')
  assert.equal(view.elements['goofish-theme'].value, 'off')
  assert.equal(view.message.kind, 'bad')
  assert.deepEqual(calls, [['appearance-get', undefined], ['appearance-set', { appearance: { taobaoTheme: 'off' } }]])
  await view.change('hide-bilibili-adblock-tips', false)
  assert.equal(view.elements['hide-bilibili-adblock-tips'].checked, true)
  assert.deepEqual(calls.at(-1), ['appearance-set', { appearance: { hideBilibiliAdblockTips: false } }])
  assert.ok(controlIds.every((id) => !view.elements[id].disabled))
  view.language('en')
  assert.equal(view.message.textContent, 'Could not save website appearance: Fixture failed write')
})

test('options follow cross-page changes and deletion while ignoring changes from sync storage', async () => {
  const view = optionsView(async () => DEFAULT_APPEARANCE)
  await tick()
  view.emit({ taobaoTheme: 'off', goofishTheme: 'off', hideBilibiliAdblockTips: false })
  assert.equal(view.elements['taobao-theme'].value, 'off')
  assert.equal(view.elements['goofish-theme'].value, 'off')
  assert.equal(view.elements['hide-bilibili-adblock-tips'].checked, false)
  view.emit(DEFAULT_APPEARANCE, 'sync')
  assert.equal(view.elements['taobao-theme'].value, 'off')
  view.emit(undefined)
  assert.equal(view.elements['taobao-theme'].value, 'system')
  assert.equal(view.elements['goofish-theme'].value, 'system')
  assert.equal(view.elements['hide-bilibili-adblock-tips'].checked, true)
})

test('late initial reads or write acknowledgements never overwrite newer settings-page changes', async () => {
  const initial = deferred()
  const saved = deferred()
  const view = optionsView((type) => type === 'appearance-get' ? initial.promise : saved.promise)
  assert.ok(controlIds.every((id) => view.elements[id].disabled))
  view.emit({ bilibiliTheme: 'off', taobaoTheme: 'off' })
  initial.resolve(DEFAULT_APPEARANCE)
  await tick()
  assert.equal(view.elements['bilibili-theme'].value, 'off')
  assert.equal(view.elements['taobao-theme'].value, 'off')
  const saving = view.change('goofish-theme', 'off')
  view.emit({ taobaoTheme: 'off', hideBilibiliAdblockTips: false })
  saved.resolve({ ...DEFAULT_APPEARANCE, goofishTheme: 'off' })
  await saving
  assert.equal(view.elements['goofish-theme'].value, 'system')
  assert.equal(view.elements['taobao-theme'].value, 'off')
  assert.equal(view.elements['hide-bilibili-adblock-tips'].checked, false)
})

test('an older worker preserves unknown_message and keeps unread controls disabled until a successful retry', async (t) => {
  const previous = globalThis.chrome
  let supported = false
  const calls = []
  globalThis.chrome = { runtime: { sendMessage: async (message) => {
    calls.push(message)
    return supported ? { ok: true, data: { ...DEFAULT_APPEARANCE, taobaoTheme: 'off' } }
      : { ok: false, error: '未知消息', code: 'unknown_message' }
  } } }
  t.after(() => { globalThis.chrome = previous })
  const view = optionsView(runtimeSend)
  await tick()
  assert.match(view.message.textContent, /后台尚未支持.*重新加载扩展/)
  assert.ok(controlIds.every((id) => view.elements[id].disabled))
  assert.equal(view.elements['bilibili-theme'].value, '')
  assert.equal(view.elements['hide-bilibili-adblock-tips'].indeterminate, true)
  assert.equal(view.elements['website-appearance-retry'].disabled, false)
  await view.change('taobao-theme', 'off')
  assert.equal(calls.length, 1, 'Unread controls must not send a save')
  supported = true
  await view.retry()
  assert.equal(view.elements['taobao-theme'].value, 'off')
  assert.ok(controlIds.every((id) => !view.elements[id].disabled))
  assert.equal(view.elements['website-appearance-retry'].classList.contains('hidden'), true)
})

test('missing runtime replies and disconnected channels show recovery instructions without invented storage errors', async (t) => {
  const previous = globalThis.chrome
  t.after(() => { globalThis.chrome = previous })
  for (const error of [null,
    new Error('Could not establish connection. Receiving end does not exist.'),
    new Error('The message port closed before a response was received.'),
    new Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'),
    new Error('Extension context invalidated.'),
  ]) {
    globalThis.chrome = { runtime: { sendMessage: async () => { if (error) throw error } } }
    const view = optionsView(runtimeSend)
    await tick()
    assert.match(view.message.textContent, /重新加载扩展.*重新打开设置页/)
    assert.match(view.message.textContent, error?.message.includes('invalidated') ? /连接已失效/ : /未收到.*响应/)
    assert.ok(controlIds.every((id) => view.elements[id].disabled))
    assert.equal(view.elements['bilibili-theme'].value, '')
  }
})

test('an unresponsive worker times out with a retry control and never enables unread preferences', async () => {
  let timeout
  const view = optionsView(() => new Promise(() => {}), {
    setTimeout: (callback, delay) => { assert.equal(delay, 10000); timeout = callback; return 1 },
    clearTimeout: () => {},
  })
  timeout()
  await tick()
  assert.match(view.message.textContent, /未收到.*响应.*重新加载扩展/)
  assert.ok(controlIds.every((id) => view.elements[id].disabled))
  assert.equal(view.elements['website-appearance-retry'].disabled, false)
})

test('real storage read and write failures show their reason and preserve confirmed values', async (t) => {
  const h = await setup(t, { stored: { websiteAppearance: { bilibiliTheme: 'off' } } })
  await h.ok('status')
  h.chrome.runtime.sendMessage = (message) => h.send(message.type, message)
  let failRead = true
  let failWrite = true
  h.interceptStorage(({ kind, keys, patch }) => {
    if (kind === 'get' && keys === 'websiteAppearance' && failRead) throw new Error('Fixture storage unavailable')
    if (kind === 'set' && patch.websiteAppearance && failWrite) throw new Error('QUOTA_BYTES quota exceeded')
  })
  const view = optionsView(runtimeSend)
  await tick()
  assert.equal(view.message.textContent, '无法读取网站外观设置：Fixture storage unavailable')
  assert.ok(controlIds.every((id) => view.elements[id].disabled))
  failRead = false
  await view.retry()
  assert.equal(view.elements['bilibili-theme'].value, 'off')
  await view.change('taobao-theme', 'off')
  assert.equal(view.message.textContent, '网站外观保存失败：QUOTA_BYTES quota exceeded')
  assert.equal(view.elements['taobao-theme'].value, 'system')
  assert.equal(view.elements['bilibili-theme'].value, 'off')
  assert.ok(controlIds.every((id) => !view.elements[id].disabled))
  assert.deepEqual(h.storage.websiteAppearance, { bilibiliTheme: 'off' })
  failWrite = false
  await view.change('taobao-theme', 'off')
  assert.equal(view.elements['taobao-theme'].value, 'off')
  assert.deepEqual(h.storage.websiteAppearance, { bilibiliTheme: 'off', taobaoTheme: 'off' })
})

test('a worker mismatch during save retains confirmed state and requires a fresh successful read', async () => {
  const view = optionsView(async (type) => {
    if (type === 'appearance-get') return { ...DEFAULT_APPEARANCE, goofishTheme: 'off' }
    throw Object.assign(new Error('未知消息'), { code: 'unknown_message' })
  })
  await tick()
  await view.change('taobao-theme', 'off')
  assert.match(view.message.textContent, /后台尚未支持/)
  assert.equal(view.elements['goofish-theme'].value, 'off')
  assert.equal(view.elements['taobao-theme'].value, 'system')
  assert.ok(controlIds.every((id) => view.elements[id].disabled))
  view.emit({ taobaoTheme: 'off' })
  assert.ok(controlIds.every((id) => view.elements[id].disabled), 'A storage event alone cannot establish RPC support')
  await view.retry()
  assert.ok(controlIds.every((id) => !view.elements[id].disabled))
})
