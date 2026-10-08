import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const extensionRoot = new URL('../chrome_plug_in/', import.meta.url)
const source = await readFile(new URL('content/shopping-theme.js', extensionRoot), 'utf8')
const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'))
const themeAttribute = 'data-hd-pm-shopping-theme'

// Observe content-script effects without a browser profile, network, credentials,
// or application storage. Unsupported extension APIs deliberately throw.
function page({ hostname = 'www.taobao.com', dark = true, stored = {}, deferStorage = false, rejectStorage = false, subframe = false } = {}) {
  const mediaListeners = []
  const storageListeners = []
  const listeners = new Map()
  const observers = new Set()
  const timers = new Map()
  let nextTimer = 1
  let releaseStorage
  let document
  const mutations = []
  const cookieWrites = []
  const storageWrites = []
  const reads = []
  function mutate(target, type, attributeName) {
    const record = { target, type, attributeName }
    mutations.push(record)
    for (const observer of observers) {
      for (const { target: observed, options } of observer.targets) {
        if (target !== observed && !(options.subtree && observed.contains(target))) continue
        if (type === 'attributes' && (!options.attributes || (options.attributeFilter && !options.attributeFilter.includes(attributeName)))) continue
        if (type === 'childList' && !options.childList) continue
        observer.pending.push(record)
        break
      }
    }
  }
  class Element {
    constructor(tag) {
      this.nodeType = 1
      this.tagName = tag.toUpperCase()
      this.children = []
      this.attributes = new Map()
      this.parentElement = null
      this.textContent = ''
      this.style = {
        setProperty(name, value) { this[name] = String(value) },
        getPropertyValue(name) { return this[name] ?? '' },
        removeProperty(name) { const previous = this[name] ?? ''; delete this[name]; return previous },
      }
    }
    get id() { return this.getAttribute('id') ?? '' }
    set id(value) { this.setAttribute('id', value) }
    get className() { return this.getAttribute('class') ?? '' }
    set className(value) { this.setAttribute('class', value) }
    get parentNode() { return this.parentElement }
    get isConnected() { return this === document?.documentElement || Boolean(this.parentElement?.isConnected) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    hasAttribute(name) { return this.attributes.has(name) }
    setAttribute(name, value) { this.attributes.set(name, String(value)); mutate(this, 'attributes', name) }
    removeAttribute(name) { if (this.attributes.delete(name)) mutate(this, 'attributes', name) }
    append(...nodes) {
      for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node) }
      mutate(this, 'childList')
    }
    appendChild(node) { this.append(node); return node }
    remove() {
      if (!this.parentElement) return
      const parent = this.parentElement
      parent.children = parent.children.filter((node) => node !== this)
      this.parentElement = null
      mutate(parent, 'childList')
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)) }
    matches(selector) {
      return selector.split(',').some((part) => {
        const token = part.trim()
        const tag = token.match(/^[a-z][a-z\d-]*/i)?.[0]
        if (tag && this.tagName !== tag.toUpperCase()) return false
        const id = token.match(/#([\w-]+)/)?.[1]
        if (id && this.id !== id) return false
        for (const [, name] of token.matchAll(/\.([\w-]+)/g)) if (!this.className.split(/\s+/).includes(name)) return false
        for (const [, name, value] of token.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
          if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value)) return false
        }
        return true
      })
    }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  }
  const root = new Element('html')
  const head = new Element('head')
  const body = new Element('body')
  const listen = (type, callback) => listeners.set(type, [...(listeners.get(type) ?? []), callback])
  document = {
    documentElement: root, head, body, readyState: 'complete',
    createElement: (tag) => new Element(tag),
    getElementById: (id) => root.querySelector('#' + id),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener: listen,
    get cookie() { return 'theme=original; session=fixture' },
    set cookie(value) { cookieWrites.push(value) },
  }
  root.append(head, body)
  const media = {
    matches: dark,
    addEventListener: (type, callback) => { if (type === 'change') mediaListeners.push(callback) },
    addListener: (callback) => mediaListeners.push(callback),
  }
  const chrome = {
    storage: {
      local: {
        get(keys) {
          reads.push(Array.from(keys))
          if (rejectStorage) return Promise.reject(new Error('Preference storage unavailable'))
          return deferStorage ? new Promise((resolve) => { releaseStorage = resolve }) : Promise.resolve(stored)
        },
        set: (value) => { storageWrites.push(value); return Promise.resolve() },
      },
      onChanged: { addListener: (callback) => storageListeners.push(callback) },
    },
  }
  Object.defineProperty(chrome, 'runtime', { get() { throw new Error('Appearance scripts must not access vault messaging') } })
  const context = {
    document, chrome, console, URL, Element, HTMLElement: Element, Node: { ELEMENT_NODE: 1 },
    location: new URL(`https://${hostname}/`),
    addEventListener: listen,
    matchMedia(query) { assert.equal(query, '(prefers-color-scheme: dark)'); return media },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; this.pending = []; observers.add(this) }
      observe(target, options) { this.targets.push({ target, options }) }
      disconnect() { this.targets = []; this.pending = [] }
    },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame(callback) { const id = nextTimer++; timers.set(id, callback); return id },
    cancelAnimationFrame: (id) => timers.delete(id),
    queueMicrotask,
  }
  context.window = context
  context.self = context
  context.top = subframe ? {} : context
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('Do not change the site native theme preference') } })
  return {
    root, head, body, document, Element, reads, storageWrites, cookieWrites, mutations,
    start() { vm.runInNewContext(source, context, { filename: 'content/shopping-theme.js' }) },
    systemTheme(value) { media.matches = value; for (const callback of mediaListeners) callback({ matches: value }) },
    storageChange(changes, area = 'local') { for (const callback of storageListeners) callback(changes, area) },
    resolveStorage(value) { assert.ok(releaseStorage); releaseStorage(value) },
    event(type) { for (const callback of listeners.get(type) ?? []) callback({ type }) },
    async flush() {
      for (let round = 0; round < 60; round++) {
        for (let tick = 0; tick < 4; tick++) await Promise.resolve()
        for (const observer of observers) if (observer.pending.length) observer.callback(observer.pending.splice(0), observer)
        const callbacks = [...timers.values()]
        timers.clear()
        for (const callback of callbacks) callback()
        if (!timers.size && ![...observers].some((observer) => observer.pending.length)) return
      }
      throw new Error('Unbounded shopping theme mutation/timer loop')
    },
  }
}

test('shopping theme is installed only on the Taobao and Goofish main hosts in the top isolated frame', () => {
  const entry = manifest.content_scripts.find((entry) => entry.js.includes('content/shopping-theme.js'))
  assert.ok(entry)
  assert.equal(entry.world ?? 'ISOLATED', 'ISOLATED')
  assert.equal(entry.all_frames ?? false, false)
  assert.equal(entry.run_at, 'document_start')
  const hosts = entry.matches.map((match) => {
    const parsed = match.match(/^(?:\*|https?):\/\/((?:www\.)?(?:taobao|goofish)\.com)\/\*$/)
    assert.ok(parsed, `Unexpected shopping host scope: ${match}`)
    return parsed[1]
  })
  assert.deepEqual([...new Set(hosts)].sort(), ['goofish.com', 'taobao.com', 'www.goofish.com', 'www.taobao.com'])
  assert.ok(entry.css.includes('content/shopping-theme.css'))
})

test('every shopping CSS rule is scoped so removing the dark marker restores native styles', async () => {
  const css = (await readFile(new URL('content/shopping-theme.css', extensionRoot), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
  assert.ok(rules.length > 0)
  for (const [, selectorList] of rules) {
    let depth = 0
    let start = 0
    const selectors = []
    for (let i = 0; i < selectorList.length; i++) {
      const character = selectorList[i]
      if (character === '(' || character === '[') depth++
      if (character === ')' || character === ']') depth--
      if (character === ',' && depth === 0) { selectors.push(selectorList.slice(start, i)); start = i + 1 }
    }
    selectors.push(selectorList.slice(start))
    for (const selector of selectors) {
      assert.match(selector.trim(), /^html\[data-hd-pm-shopping-theme=["']dark["']\]/, selector)
      assert.match(selector, /\[data-hd-pm-shopping-site=["'](?:taobao|goofish)["']\]/, selector)
    }
  }
  assert.doesNotMatch(css, /\b(?:filter|backdrop-filter)\s*:/i, 'Media must not be recolored by a page-wide filter')
})

test('both shopping sites default to browser-following dark and revert in light mode', async () => {
  for (const hostname of ['taobao.com', 'www.taobao.com', 'goofish.com', 'www.goofish.com']) {
    const p = page({ hostname })
    p.start()
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), 'dark', hostname)
    assert.equal(p.root.getAttribute('data-hd-pm-shopping-site'), hostname.includes('taobao') ? 'taobao' : 'goofish')
    p.systemTheme(false)
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), null, hostname)
    p.systemTheme(true)
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), 'dark', hostname)
    assert.deepEqual(p.reads, [['websiteAppearance']])
    assert.deepEqual(p.storageWrites, [])
    assert.deepEqual(p.cookieWrites, [])
  }
})

test('a light browser never forces dark mode and a late document root is handled after loading', async () => {
  const light = page({ dark: false })
  light.start()
  await light.flush()
  assert.equal(light.root.getAttribute(themeAttribute), null)
  const p = page()
  p.document.documentElement = null
  p.document.head = null
  p.document.readyState = 'loading'
  p.start()
  await p.flush()
  assert.equal(p.root.getAttribute(themeAttribute), null)
  p.document.documentElement = p.root
  p.document.head = p.head
  p.document.readyState = 'interactive'
  p.event('DOMContentLoaded')
  await p.flush()
  assert.equal(p.root.getAttribute(themeAttribute), 'dark')
})

test('each shopping site uses its own preference without interference from the other site', async () => {
  for (const [hostname, key, other] of [['www.taobao.com', 'taobaoTheme', 'goofishTheme'], ['www.goofish.com', 'goofishTheme', 'taobaoTheme']]) {
    const p = page({ hostname, stored: { websiteAppearance: { [key]: 'off', [other]: 'system' } } })
    p.start()
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), null)
    p.systemTheme(false)
    p.systemTheme(true)
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), null)
    p.storageChange({ websiteAppearance: { newValue: { [key]: 'system', [other]: 'off' } } })
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), 'dark')
    p.storageChange({ websiteAppearance: { newValue: { [key]: 'off', [other]: 'system' } } })
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), null)
  }
})

test('shopping settings ignore unrelated storage updates and reject stale startup reads', async () => {
  const p = page({ deferStorage: true })
  p.start()
  p.storageChange({ websiteAppearance: { newValue: { taobaoTheme: 'off' } } })
  await p.flush()
  p.resolveStorage({ websiteAppearance: { taobaoTheme: 'system' } })
  await p.flush()
  assert.equal(p.root.getAttribute(themeAttribute), null)
  p.storageChange({ websiteAppearance: { newValue: { taobaoTheme: 'system' } } }, 'sync')
  p.storageChange({ file: { newValue: { vault: 'fixture' } } })
  await p.flush()
  assert.equal(p.root.getAttribute(themeAttribute), null)
  p.storageChange({ websiteAppearance: { newValue: { taobaoTheme: 'system' } } })
  await p.flush()
  assert.equal(p.root.getAttribute(themeAttribute), 'dark')
})

test('missing or malformed shopping preferences fall back to system mode', async () => {
  for (const invalid of [undefined, null, 'off', [], { taobaoTheme: 'invalid' }, { taobaoTheme: false }]) {
    const p = page({ stored: { websiteAppearance: { taobaoTheme: 'off' } } })
    p.start()
    await p.flush()
    p.storageChange({ websiteAppearance: { newValue: invalid } })
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), 'dark')
  }
})

test('unavailable preference storage leaves the shopping site appearance alone', async () => {
  const p = page({ rejectStorage: true })
  p.start()
  await p.flush()
  assert.equal(p.root.getAttribute(themeAttribute), null)
  assert.deepEqual(p.cookieWrites, [])
  assert.deepEqual(p.storageWrites, [])
})

test('shopping host boundaries reject unadapted subdomains, lookalikes, unrelated sites, and embedded frames', async () => {
  for (const options of [
    { hostname: 'taobao.com.evil.test' }, { hostname: 'eviltaobao.com' },
    { hostname: 'goofish.com.evil.test' }, { hostname: 'evilgoofish.com' },
    { hostname: 'item.taobao.com' }, { hostname: 'login.taobao.com' }, { hostname: 'pay.taobao.com' },
    { hostname: 'cart.taobao.com' }, { hostname: 'buy.taobao.com' }, { hostname: 'sub.www.taobao.com' },
    { hostname: 'item.goofish.com' }, { hostname: 'login.goofish.com' }, { hostname: 'pay.goofish.com' },
    { hostname: 'passport.goofish.com' }, { hostname: 'sub.www.goofish.com' },
    { hostname: 'example.test' }, { hostname: 'alipay.com' },
    { hostname: 'www.taobao.com', subframe: true }, { hostname: 'www.goofish.com', subframe: true },
  ]) {
    const p = page(options)
    const before = p.mutations.length
    p.start()
    await p.flush()
    assert.equal(p.root.getAttribute(themeAttribute), null)
    assert.equal(p.mutations.length, before)
    assert.deepEqual(p.reads, [])
  }
})

test('dark mode and disabling preserve original site theme, media, and payment content', async () => {
  const p = page()
  p.root.className = 'site-native-theme'
  p.root.setAttribute('data-theme', 'native-value')
  p.root.style.colorScheme = 'light'
  const image = new p.Element('img')
  image.setAttribute('src', 'https://fixture.test/product.png')
  const video = new p.Element('video')
  video.setAttribute('src', 'https://fixture.test/product.mp4')
  const payment = new p.Element('iframe')
  payment.setAttribute('src', 'https://www.alipay.com/payment-fixture')
  p.body.append(image, video, payment)
  p.start()
  await p.flush()
  assert.equal(p.root.getAttribute(themeAttribute), 'dark')
  p.storageChange({ websiteAppearance: { newValue: { taobaoTheme: 'off' } } })
  await p.flush()
  assert.equal(p.root.getAttribute(themeAttribute), null)
  assert.equal(p.root.className, 'site-native-theme')
  assert.equal(p.root.getAttribute('data-theme'), 'native-value')
  assert.equal(p.root.style.colorScheme, 'light')
  for (const element of [image, video, payment]) {
    assert.equal(element.isConnected, true)
    assert.equal(element.style.filter, undefined)
    assert.equal(element.style.background, undefined)
  }
  assert.equal(image.getAttribute('src'), 'https://fixture.test/product.png')
  assert.equal(video.getAttribute('src'), 'https://fixture.test/product.mp4')
  assert.equal(payment.getAttribute('src'), 'https://www.alipay.com/payment-fixture')
  assert.deepEqual(p.cookieWrites, [])
  assert.deepEqual(p.storageWrites, [])
  const settled = p.mutations.length
  for (let i = 0; i < 5; i++) { p.event('pageshow'); await p.flush() }
  assert.equal(p.mutations.length, settled, 'Repeated lifecycle events must settle without redundant DOM writes')
})
