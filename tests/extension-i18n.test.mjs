import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRANSLATIONS, MESSAGE_KEYS } from '../chrome_plug_in/ui/translations.js'
import { resolveLocale, tForLocale } from '../chrome_plug_in/ui/i18n.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja']
const placeholders = (text) => [...new Set(text.match(/\{[A-Za-z][A-Za-z\d_]*\}/g) ?? [])].sort()
let instance = 0

function mockChrome(t, { language, browserLanguage = 'en-US', get } = {}) {
  const previous = globalThis.chrome
  const data = { ...(language ? { language } : {}), file: { fixture: 'encrypted' }, sync: { version: 7 } }
  const listeners = []
  const writes = []
  const emit = (changes, area = 'local') => listeners.forEach((listener) => listener(changes, area))
  globalThis.chrome = {
    i18n: { getUILanguage: () => browserLanguage },
    storage: {
      local: {
        get: get ?? (async () => structuredClone(data)),
        set: async (patch) => {
          writes.push(structuredClone(patch))
          const changes = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]))
          Object.assign(data, structuredClone(patch))
          emit(changes)
        },
      },
      onChanged: { addListener: (listener) => listeners.push(listener) },
    },
  }
  t.after(() => { globalThis.chrome = previous })
  return { data, writes, listeners, emit }
}
const fresh = () => import('../chrome_plug_in/ui/i18n.js?test=' + ++instance)

test('locale negotiation covers scripts, regions, underscores and unsupported languages', () => {
  for (const [input, expected] of [
    ['zh', 'zh-CN'], ['zh-CN', 'zh-CN'], ['zh_SG', 'zh-CN'], ['zh-Hans-HK', 'zh-CN'],
    ['zh-TW', 'zh-TW'], ['zh-Hant', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'],
    ['en-GB', 'en'], ['en_US', 'en'], ['ja-JP', 'ja'], ['fr-FR', 'en'], ['invalid', 'en'],
  ]) assert.equal(resolveLocale(input), expected, input)
  assert.equal(resolveLocale('auto', 'ja-JP'), 'ja')
  assert.equal(resolveLocale('auto', 'zh-Hant-TW'), 'zh-TW')
  assert.equal(resolveLocale('auto', 'de-DE'), 'en')
})

test('all four dictionaries have complete values and preserve every named placeholder', () => {
  assert.equal(new Set(MESSAGE_KEYS).size, MESSAGE_KEYS.length, 'Duplicate source messages')
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(TRANSLATIONS[locale]).sort(), [...MESSAGE_KEYS].sort(), locale)
    for (const source of MESSAGE_KEYS) {
      const translated = TRANSLATIONS[locale][source]
      assert.equal(typeof translated, 'string', locale + ': ' + source)
      assert.ok(translated.length, locale + ': ' + source)
      assert.deepEqual(placeholders(translated), placeholders(source), locale + ': ' + source)
    }
  }
})

test('template substitution preserves zero, user text, HTML-like text and unknown placeholders', () => {
  assert.equal(tForLocale('en', '{count} 条密码', { count: 0 }), '0 passwords')
  const title = '<img onerror=alert(1)> 用户 {count}'
  assert.equal(tForLocale('en', '已填充：{title}', { title, count: 99 }), 'Filled: ' + title)
  assert.equal(tForLocale('ja', '已填充：{title}', { title }), '入力しました：' + title)
  assert.equal(tForLocale('en', '保存了 {count} 个账号'), '{count} saved accounts')
  assert.equal(tForLocale('fr', '保存了 {count} 个账号', { count: 2 }), '2 saved accounts')
  assert.equal(tForLocale('ja', 'Customer 自定义条目'), 'Customer 自定义条目')
})

test('initialization uses saved preferences and installs only one storage listener', async (t) => {
  const mock = mockChrome(t, { language: 'ja', browserLanguage: 'zh-CN' })
  const i18n = await fresh()
  assert.equal(await i18n.initI18n(), 'ja')
  assert.equal(await i18n.initI18n(), 'ja')
  assert.equal(mock.listeners.length, 1)
  assert.equal(i18n.getLanguagePreference(), 'ja')
  assert.equal(i18n.t('设置'), '設定')
})

test('browser language remains usable when storage is unavailable', async (t) => {
  mockChrome(t, { browserLanguage: 'zh-Hant-TW', get: async () => { throw new Error('Fixture storage unavailable') } })
  const i18n = await fresh()
  assert.equal(await i18n.initI18n(), 'zh-TW')
  assert.equal(i18n.getLanguagePreference(), 'auto')
})

test('storage changes update open views immediately and never write vault data', async (t) => {
  const mock = mockChrome(t, { language: 'en', browserLanguage: 'zh-TW' })
  const first = await fresh()
  const second = await fresh()
  await Promise.all([first.initI18n(), second.initI18n()])
  const changes = []
  const unsubscribe = second.onLanguageChange((value) => changes.push(value))
  await first.setLanguage('ja')
  assert.equal(first.getLocale(), 'ja')
  assert.equal(second.getLocale(), 'ja')
  assert.deepEqual(changes, [{ preference: 'ja', locale: 'ja' }])
  assert.deepEqual(mock.writes, [{ language: 'ja' }])
  assert.deepEqual(mock.data.file, { fixture: 'encrypted' })
  assert.deepEqual(mock.data.sync, { version: 7 })
  unsubscribe()
  mock.emit({ language: { newValue: 'zh-CN' } }, 'sync')
  assert.equal(second.getLocale(), 'ja', 'Non-local storage must not change UI language')
  mock.emit({ language: { oldValue: 'ja' } })
  assert.equal(second.getLanguagePreference(), 'auto')
  assert.equal(second.getLocale(), 'zh-TW')
  assert.equal(changes.length, 1)
})

test('a late initial storage read cannot overwrite a newer language event', async (t) => {
  let finishRead
  const read = new Promise((resolve) => { finishRead = resolve })
  const mock = mockChrome(t, { get: () => read })
  const i18n = await fresh()
  const ready = i18n.initI18n()
  mock.emit({ language: { newValue: 'ja' } })
  finishRead({ language: 'en' })
  await ready
  assert.equal(i18n.getLocale(), 'ja')
})

test('language writes serialize; invalid choices never persist', async (t) => {
  const mock = mockChrome(t)
  const i18n = await fresh()
  await Promise.all([i18n.setLanguage('ja'), i18n.setLanguage('zh-TW'), i18n.setLanguage('en')])
  assert.equal(i18n.getLocale(), 'en')
  assert.deepEqual(mock.writes.map((patch) => patch.language), ['ja', 'zh-TW', 'en'])
  await assert.rejects(i18n.setLanguage('fr-FR'), /Unsupported/)
  assert.equal(mock.writes.length, 3)
})

test('error translation handles known application errors without rewriting unknown server or user text', async (t) => {
  mockChrome(t, { language: 'en' })
  const i18n = await fresh()
  await i18n.initI18n()
  assert.equal(i18n.translateError({ code: 'bad_password', message: 'unrecognized fixture text' }), 'Incorrect master password')
  assert.equal(i18n.translateError(new Error('条目不存在')), 'Entry not found')
  assert.equal(i18n.translateError(new Error('服务器返回 503')), 'The server returned 503')
  assert.equal(i18n.translateError(new Error('尝试过于频繁，请 45 秒后再试')), 'Too many attempts. Try again in 45 seconds.')
  assert.equal(i18n.translateError('服务器上的保险库已经变过了'), 'The server vault has changed')
  assert.equal(i18n.translateError(new Error('条目 username 必须是有效文本')), 'The entry’s Username must be valid text')
  assert.equal(i18n.translateError(new Error('用户自定义：我的账号与密码')), '用户自定义：我的账号与密码')
  assert.equal(i18n.translateError('Customer <img> {name}'), 'Customer <img> {name}')
})

test('localize changes only marked application text and attributes, leaving user values untouched', async (t) => {
  mockChrome(t, { language: 'en' })
  const i18n = await fresh()
  await i18n.initI18n()
  function element(text, attributes = {}) {
    return {
      textContent: text, value: '用户输入：密码管理器', attributes: { ...attributes },
      hasAttribute(name) { return Object.hasOwn(this.attributes, name) },
      getAttribute(name) { return this.attributes[name] ?? null },
      setAttribute(name, value) { this.attributes[name] = value },
      matches() { return Object.keys(this.attributes).some((name) => name.startsWith('data-i18n')) },
      querySelectorAll() { return [] },
    }
  }
  const marked = element('密码管理器', { 'data-i18n': '密码管理器' })
  const userTitle = element('密码管理器')
  const input = element('', { 'data-i18n-placeholder': '主密码', placeholder: '主密码', 'data-i18n-aria-label': '搜索密码库' })
  const document = {
    nodeType: 9, documentElement: { lang: 'zh-CN' },
    querySelectorAll: () => [marked, userTitle, input].filter((el) => el.matches()),
  }
  for (const el of [marked, userTitle, input]) el.ownerDocument = document
  i18n.localize(document)
  assert.equal(marked.textContent, 'Password Manager')
  assert.equal(userTitle.textContent, '密码管理器')
  assert.equal(input.value, '用户输入：密码管理器')
  assert.equal(input.getAttribute('placeholder'), 'Master password')
  assert.equal(input.getAttribute('aria-label'), 'Search vault')
  assert.equal(document.documentElement.lang, 'en')
  await i18n.setLanguage('ja')
  i18n.localize(marked)
  assert.equal(marked.textContent, 'パスワードマネージャー')
  assert.equal(marked.getAttribute('data-i18n'), '密码管理器')
})

test('manifest metadata resolves in every Chrome locale and has no new permissions', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'chrome_plug_in/manifest.json'), 'utf8'))
  assert.equal(manifest.default_locale, 'en')
  assert.equal(manifest.version, '0.8.0')
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'idle', 'clipboardWrite'])
  const references = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((match) => match[1])
  for (const locale of ['en', 'zh_CN', 'zh_TW', 'ja']) {
    const messages = JSON.parse(await fs.readFile(path.join(ROOT, 'chrome_plug_in/_locales', locale, 'messages.json'), 'utf8'))
    for (const key of references) assert.ok(messages[key]?.message, locale + ': ' + key)
  }
})

test('all UI markers, literal translations, content phrases and fixed errors have translations', async () => {
  const files = [
    'popup/popup.html', 'popup/popup.js', 'options/options.html', 'options/options.js',
    'ui/intro.js', 'ui/common.js', 'ui/i18n.js', 'background.js',
    'src/crypto.js', 'src/vault.js', 'src/sync.js', 'src/match.js',
  ]
  const required = new Map([
    ...['空', '很弱', '弱', '一般', '强', '很强', '可在设置中手动同步。'].map((key) => [key, 'dynamic UI value']),
  ])
  const add = (key, file) => { if (/[\u3400-\u9fff]/.test(key)) required.set(key, file) }
  for (const file of files) {
    const source = await fs.readFile(path.join(ROOT, 'chrome_plug_in', file), 'utf8')
    for (const match of source.matchAll(/data-i18n(?:-(?:placeholder|title|aria-label))?="([^"]+)"/g)) add(match[1], file)
    for (const match of source.matchAll(/(?:\bt|\bsetWizardResult|new Error|new SyncError|\bfailure)\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)) {
      add(match[1].slice(1, -1).replaceAll('\\n', '\n'), file)
    }
    const content = source.match(/const CONTENT_UI\s*=\s*\[([\s\S]+?)\]/)
    if (content) for (const match of content[1].matchAll(/'([^']+)'/g)) add(match[1], file)
    const errors = source.match(/const ERROR_SOURCES\s*=\s*Object.freeze\(\{([\s\S]+?)\}\)/)
    if (errors) for (const match of errors[1].matchAll(/'([^']+)'/g)) add(match[1], file)
  }
  const missing = []
  for (const [key, file] of required) for (const locale of LOCALES) {
    if (!Object.hasOwn(TRANSLATIONS[locale], key)) missing.push(locale + ': ' + key + ' (' + file + ')')
  }
  assert.deepEqual(missing, [])
})
