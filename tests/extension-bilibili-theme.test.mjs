import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const extensionRoot = new URL('../chrome_plug_in/', import.meta.url)
const isolatedSource = await readFile(new URL('content/bilibili-theme.js', extensionRoot), 'utf8')
const pageSource = await readFile(new URL('content/bilibili-theme-page.js', extensionRoot), 'utf8')
const appearanceCss = await readFile(new URL('content/bilibili-theme.css', extensionRoot), 'utf8')
const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'))
const preferenceAttribute = 'data-hd-pm-bilibili-theme'
const hideTipsAttribute = 'data-hd-pm-hide-bilibili-tips'
const officialLight = 'https://s1.hdslb.com/bfs/static/jinkela/long/laputa-css/light.css'
const officialDark = officialLight.replace('/light.css', '/dark.css')

// A deterministic page with observable DOM/storage effects. No browser, network,
// account, or vault is accessed; MAIN deliberately receives no extension API.
function page({ hostname = 'www.bilibili.com', dark = true, stored = {}, deferStorage = false, subframe = false, cookie = '', cookiesBlocked = false } = {}) {
  const observers = new Set()
  const timers = new Map()
  const intervals = new Map()
  const storageListeners = []
  const mediaListeners = []
  const events = new Map()
  const cookies = new Map(cookie.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=')
    return [part.slice(0, index), part.slice(index + 1)]
  }))
  let nextTimer = 1
  let document
  let releaseStorage
  const mutations = []
  function mutate(record) {
    mutations.push(record)
    for (const observer of observers) {
      for (const { target, options } of observer.targets) {
        if (record.target !== target && !(options.subtree && target.contains(record.target))) continue
        if (record.type === 'childList' && !options.childList) continue
        if (record.type === 'attributes' && (!options.attributes || (options.attributeFilter && !options.attributeFilter.includes(record.attributeName)))) continue
        observer.pending.push(record)
        break
      }
    }
  }
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase()
      this.nodeType = 1
      this.parentElement = null
      this.children = []
      this.attributes = new Map()
      this.textContent = ''
      this.listeners = new Map()
      this.style = {
        setProperty(name, value) { this[name] = String(value) },
        getPropertyValue(name) { return this[name] ?? '' },
        removeProperty(name) { const previous = this[name] ?? ''; delete this[name]; return previous },
      }
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        add: (...names) => { for (const name of names) this.classList.toggle(name, true) },
        remove: (...names) => { for (const name of names) this.classList.toggle(name, false) },
        toggle: (name, force) => {
          const names = new Set(this.className.split(/\s+/).filter(Boolean))
          const enabled = force ?? !names.has(name)
          if (enabled) names.add(name)
          else names.delete(name)
          const next = [...names].join(' ')
          if (next !== this.className) this.className = next
          return enabled
        },
      }
    }
    get parentNode() { return this.parentElement }
    get isConnected() { return this === document?.documentElement || Boolean(this.parentElement?.isConnected) }
    get id() { return this.getAttribute('id') ?? '' }
    set id(value) { this.setAttribute('id', value) }
    get className() { return this.getAttribute('class') ?? '' }
    set className(value) { this.setAttribute('class', value) }
    get href() { return new URL(this.getAttribute('href') ?? '', document.baseURI).href }
    set href(value) { this.setAttribute('href', value) }
    get rel() { return this.getAttribute('rel') ?? '' }
    set rel(value) { this.setAttribute('rel', value) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    hasAttribute(name) { return this.attributes.has(name) }
    setAttribute(name, value) {
      const oldValue = this.getAttribute(name)
      this.attributes.set(name, String(value))
      mutate({ type: 'attributes', target: this, attributeName: name, oldValue })
    }
    removeAttribute(name) {
      if (!this.attributes.has(name)) return
      const oldValue = this.getAttribute(name)
      this.attributes.delete(name)
      mutate({ type: 'attributes', target: this, attributeName: name, oldValue })
    }
    append(...nodes) {
      for (const node of nodes) {
        node.remove()
        node.parentElement = this
        this.children.push(node)
      }
      mutate({ type: 'childList', target: this, addedNodes: nodes, removedNodes: [] })
    }
    appendChild(node) { this.append(node); return node }
    remove() {
      if (!this.parentElement) return
      const parent = this.parentElement
      parent.children = parent.children.filter((node) => node !== this)
      this.parentElement = null
      mutate({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] })
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)) }
    matches(selector) {
      return selector.split(',').some((part) => {
        const token = part.trim()
        const tag = token.match(/^[a-z][a-z\d-]*/i)?.[0]
        if (tag && this.tagName !== tag.toUpperCase()) return false
        const id = token.match(/#([\w-]+)/)?.[1]
        if (id && this.id !== id) return false
        for (const [, name] of token.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false
        for (const [, name, value] of token.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
          if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value)) return false
        }
        return true
      })
    }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    addEventListener(type, callback) {
      const list = this.listeners.get(type) ?? []
      list.push(callback)
      this.listeners.set(type, list)
    }
  }
  const root = new Element('html')
  const head = new Element('head')
  const body = new Element('body')
  document = {
    documentElement: root,
    head,
    body,
    readyState: 'complete',
    baseURI: `https://${hostname}/`,
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => root.matches(selector) ? root : root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    getElementById: (id) => root.querySelector('#' + id),
    contains: (node) => root.contains(node),
    addEventListener: (type, callback) => listen(type, callback),
    dispatchEvent(event) {
      api.documentEvents.push(event)
      for (const callback of events.get(event.type) ?? []) callback(event)
      return true
    },
    get cookie() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
    set cookie(value) {
      api.cookieWrites.push(value)
      if (cookiesBlocked) return
      const [pair, ...attributes] = value.split(';').map((part) => part.trim())
      const index = pair.indexOf('=')
      const name = pair.slice(0, index)
      const expired = attributes.some((part) => /^max-age=0$/i.test(part) || (/^expires=/i.test(part) && new Date(part.slice(8)).getTime() < Date.now()))
      if (expired) cookies.delete(name)
      else cookies.set(name, pair.slice(index + 1))
    },
  }
  root.append(head, body)
  function listen(type, callback) {
    const list = events.get(type) ?? []
    list.push(callback)
    events.set(type, list)
  }
  const media = {
    matches: dark,
    addEventListener(type, callback) { if (type === 'change') mediaListeners.push(callback) },
    addListener(callback) { mediaListeners.push(callback) },
  }
  const context = {
    document,
    location: new URL(document.baseURI),
    URL,
    Element,
    HTMLElement: Element,
    HTMLLinkElement: Element,
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; this.pending = []; observers.add(this) }
      observe(target, options) { this.targets.push({ target, options }) }
      disconnect() { this.targets = []; this.pending = [] }
      takeRecords() { return this.pending.splice(0) }
    },
    setTimeout: (callback, delay) => {
      const id = nextTimer++
      api.timerDelays.push(delay)
      timers.set(id, callback)
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback) => { const id = nextTimer++; intervals.set(id, callback); return id },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame: (callback) => { const id = nextTimer++; timers.set(id, callback); return id },
    cancelAnimationFrame: (id) => timers.delete(id),
    addEventListener: listen,
    dispatchEvent: (event) => { for (const callback of events.get(event.type) ?? []) callback(event); return true },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options) } },
    queueMicrotask,
    matchMedia: (query) => { assert.equal(query, '(prefers-color-scheme: dark)'); return media },
    console,
  }
  context.window = context
  context.self = context
  context.top = subframe ? {} : context
  const api = {
    document, root, head, body, Element, media, mutations,
    reads: [], writes: [], cookieWrites: [], documentEvents: [], timerDelays: [],
    get pendingTimers() { return timers.size },
    get pendingIntervals() { return intervals.size },
    setPageGlobal(name, value) { context[name] = value },
    startIsolated() {
      const chrome = {
        storage: {
          local: {
            get: (keys) => {
              api.reads.push(keys)
              return deferStorage ? new Promise((resolve) => { releaseStorage = resolve }) : Promise.resolve(stored)
            },
            set: (value) => { api.writes.push(value); return Promise.resolve() },
          },
          onChanged: { addListener: (callback) => storageListeners.push(callback) },
        },
      }
      Object.defineProperty(chrome, 'runtime', { get() { throw new Error('Appearance scripts must not access vault messaging') } })
      vm.runInNewContext(isolatedSource, { ...context, chrome }, { filename: 'content/bilibili-theme.js' })
    },
    startMain() { vm.runInNewContext(pageSource, context, { filename: 'content/bilibili-theme-page.js' }) },
    resolveStorage(value) { assert.ok(releaseStorage, 'The initial settings read must be pending'); releaseStorage(value) },
    storageChange(changes, area = 'local') { for (const callback of storageListeners) callback(changes, area) },
    systemTheme(isDark) { media.matches = isDark; for (const callback of mediaListeners) callback({ matches: isDark }) },
    preference(theme) { root.setAttribute(preferenceAttribute, theme) },
    link(href = officialLight) {
      const link = new Element('link')
      link.id = '__css-map__'
      link.rel = 'stylesheet'
      link.setAttribute('href', href)
      head.append(link)
      return link
    },
    nativeHeader(initial = 'light') {
      const header = new Element('div')
      header.className = 'bili-header'
      const calls = []
      const theme = { value: initial }
      const emitter = { emit(event, value) {
        calls.push([event, value])
        if (event !== 'themeChange') return
        theme.value = value
        const link = document.getElementById('__css-map__')
        if (link) link.href = link.href.replace(/\/(?:light|dark)(_all)?\.css/, `/${value}$1.css`)
        root.classList.toggle('bili_dark', value === 'dark')
        document.cookie = `theme_style=${value}; path=/`
        api.event('biliThemeChange')
      } }
      header.__vueParentComponent = { parent: { provides: { emitter, theme }, parent: null }, provides: {} }
      body.append(header)
      return { header, calls, theme }
    },
    event(type) { for (const callback of events.get(type) ?? []) callback({ type }) },
    interval() { for (const callback of [...intervals.values()]) callback() },
    async flush({ runTimers = true } = {}) {
      for (let round = 0; round < 60; round++) {
        for (let turn = 0; turn < 4; turn++) await Promise.resolve()
        for (const observer of observers) if (observer.pending.length) observer.callback(observer.pending.splice(0), observer)
        const callbacks = runTimers ? [...timers.values()] : []
        if (runTimers) timers.clear()
        for (const callback of callbacks) callback()
        if ((!runTimers || !timers.size) && ![...observers].some((observer) => observer.pending.length)) {
          for (let turn = 0; turn < 4; turn++) await Promise.resolve()
          if ((!runTimers || !timers.size) && ![...observers].some((observer) => observer.pending.length)) return
        }
      }
      throw new Error('Unbounded Bilibili theme mutation/timer loop')
    },
  }
  return api
}

test('Bilibili scripts are scoped to the site, top frame, and separate execution worlds', () => {
  for (const [file, world] of [['content/bilibili-theme.js', 'ISOLATED'], ['content/bilibili-theme-page.js', 'MAIN']]) {
    const entry = manifest.content_scripts.find((entry) => entry.js.includes(file))
    assert.ok(entry, file)
    assert.equal(entry.world ?? 'ISOLATED', world)
    assert.equal(entry.all_frames ?? false, false)
    assert.ok(entry.matches.length > 0)
    assert.ok(entry.matches.every((match) => /^(?:\*|https?):\/\/(?:\*\.)?bilibili\.com\/\*$/.test(match)))
  }
})

test('missing settings default to system theme, stay live, and access only appearance storage', async () => {
  const p = page()
  p.startIsolated()
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'dark')
  p.systemTheme(false)
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'light')
  assert.deepEqual(p.reads.map((keys) => typeof keys === 'string' ? [keys] : Array.from(keys)), [['websiteAppearance']])
  assert.deepEqual(p.writes, [])
})

test('adblock notices are hidden by default independently of the Bilibili theme', async () => {
  const p = page({ stored: { websiteAppearance: { bilibiliTheme: 'off' } } })
  const notice = new p.Element('div')
  notice.className = 'adblock-tips'
  notice.textContent = 'Adblock notice fixture'
  const ordinary = new p.Element('div')
  ordinary.className = 'ordinary-tips'
  p.body.append(notice, ordinary)
  p.startIsolated()
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'off')
  assert.equal(p.root.getAttribute(hideTipsAttribute), 'true')
  const entry = manifest.content_scripts.find((entry) => entry.js.includes('content/bilibili-theme.js'))
  assert.ok(entry.css.includes('content/bilibili-theme.css'))
  assert.match(appearanceCss, /html\[data-hd-pm-hide-bilibili-tips=["']?true["']?\]\s+\.adblock-tips\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/, 'The notice rule must be gated by the dedicated setting')
  assert.equal(notice.isConnected, true, 'Hiding must preserve the original notice DOM')
  assert.equal(notice.textContent, 'Adblock notice fixture')
  assert.equal(ordinary.isConnected, true)
  assert.equal(notice.style.display, undefined, 'Do not leave inline styles that survive disabling')
  assert.equal(p.cookieWrites.length, 0)
  assert.deepEqual(p.writes, [])
})

test('the adblock notice preference changes live and remains independent from system theme changes', async () => {
  const p = page({ stored: { websiteAppearance: { bilibiliTheme: 'system', hideBilibiliAdblockTips: false } } })
  p.startIsolated()
  await p.flush()
  assert.equal(p.root.getAttribute(hideTipsAttribute), null)
  assert.equal(p.root.getAttribute(preferenceAttribute), 'dark')
  p.storageChange({ websiteAppearance: { newValue: { bilibiliTheme: 'off', hideBilibiliAdblockTips: true } } })
  await p.flush()
  assert.equal(p.root.getAttribute(hideTipsAttribute), 'true')
  p.systemTheme(false)
  await p.flush()
  assert.equal(p.root.getAttribute(hideTipsAttribute), 'true')
  assert.equal(p.root.getAttribute(preferenceAttribute), 'off')
  const lateNotice = new p.Element('div')
  lateNotice.className = 'adblock-tips'
  p.body.append(lateNotice)
  await p.flush()
  assert.equal(lateNotice.isConnected, true, 'Dynamically mounted notices remain reversible')
  p.storageChange({ websiteAppearance: { newValue: { bilibiliTheme: 'off', hideBilibiliAdblockTips: false } } })
  await p.flush()
  assert.equal(p.root.getAttribute(hideTipsAttribute), null)
  assert.equal(lateNotice.isConnected, true)
  assert.equal(lateNotice.style.display, undefined)
  assert.equal(p.root.getAttribute(preferenceAttribute), 'off')
  p.storageChange({ websiteAppearance: { newValue: undefined } })
  await p.flush()
  assert.equal(p.root.getAttribute(hideTipsAttribute), 'true')
  assert.equal(p.root.getAttribute(preferenceAttribute), 'light')
})

test('a late initial settings result cannot re-enable adblock notice hiding after it was disabled', async () => {
  const p = page({ deferStorage: true })
  p.startIsolated()
  p.storageChange({ websiteAppearance: { newValue: { bilibiliTheme: 'off', hideBilibiliAdblockTips: false } } })
  await p.flush()
  p.resolveStorage({ websiteAppearance: { bilibiliTheme: 'system', hideBilibiliAdblockTips: true } })
  await p.flush()
  assert.equal(p.root.getAttribute(hideTipsAttribute), null)
  assert.equal(p.root.getAttribute(preferenceAttribute), 'off')
})

test('local preference changes toggle system following and ignore unrelated storage areas and keys', async () => {
  const p = page({ stored: { websiteAppearance: { bilibiliTheme: 'off' } } })
  p.startIsolated()
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'off')
  p.systemTheme(false)
  p.storageChange({ websiteAppearance: { newValue: { bilibiliTheme: 'system' } } }, 'sync')
  p.storageChange({ file: { newValue: { vault: 'fixture' } } })
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'off')
  p.storageChange({ websiteAppearance: { newValue: { bilibiliTheme: 'system' } } })
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'light')
  p.systemTheme(true)
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'dark')
  p.storageChange({ websiteAppearance: { newValue: { bilibiliTheme: 'off' } } })
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'off')
})

test('a stale initial storage result cannot overwrite a newer local preference change', async () => {
  const p = page({ deferStorage: true })
  p.startIsolated()
  p.storageChange({ websiteAppearance: { newValue: { bilibiliTheme: 'off' } } })
  await p.flush()
  p.resolveStorage({ websiteAppearance: { bilibiliTheme: 'system' } })
  await p.flush()
  assert.equal(p.root.getAttribute(preferenceAttribute), 'off')
})

test('removing or corrupting the preference returns to the system default', async () => {
  for (const invalid of [undefined, null, 'off', { bilibiliTheme: 'invalid' }]) {
    const p = page({ stored: { websiteAppearance: { bilibiliTheme: 'off' } } })
    p.startIsolated()
    await p.flush()
    p.storageChange({ websiteAppearance: { newValue: invalid } })
    await p.flush()
    assert.equal(p.root.getAttribute(preferenceAttribute), 'dark')
  }
})

test('host boundaries reject lookalike domains and embedded frames', async () => {
  for (const options of [{ hostname: 'bilibili.com.evil.test' }, { hostname: 'evilbilibili.com' }, { hostname: 'example.test' }, { subframe: true }]) {
    const p = page(options)
    const link = p.link()
    p.preference('dark')
    p.startMain()
    p.startIsolated()
    await p.flush()
    assert.equal(link.href, officialLight)
    assert.equal(p.root.classList.contains('bili_dark'), false)
    assert.equal(p.reads.length, 0)
    assert.equal(p.cookieWrites.length, 0)
  }
})

test('the native header controller receives one change per system theme and restores its original theme', async () => {
  const p = page({ cookie: 'theme_style=light; unrelated=fixture' })
  const link = p.link()
  const native = p.nativeHeader('light')
  p.startMain()
  p.startIsolated()
  await p.flush()
  assert.deepEqual(native.calls, [['themeChange', 'dark']])
  assert.equal(native.theme.value, 'dark')
  assert.equal(link.href, officialDark)
  p.systemTheme(false)
  await p.flush()
  p.systemTheme(true)
  await p.flush()
  p.storageChange({ websiteAppearance: { newValue: { bilibiliTheme: 'off' } } })
  await p.flush()
  assert.deepEqual(native.calls, [
    ['themeChange', 'dark'], ['themeChange', 'light'], ['themeChange', 'dark'], ['themeChange', 'light'],
  ])
  assert.equal(link.href, officialLight)
  assert.equal(p.root.classList.contains('bili_dark'), false)
  assert.match(p.document.cookie, /(?:^|; )theme_style=light(?:;|$)/)
  assert.match(p.document.cookie, /(?:^|; )unrelated=fixture(?:;|$)/)
})

test('a header mounted after startup takes over from the stylesheet fallback without a feedback loop', async () => {
  const p = page()
  const link = p.link()
  p.preference('dark')
  p.startMain()
  await p.flush()
  assert.equal(link.href, officialDark)
  const native = p.nativeHeader('light')
  await p.flush()
  assert.deepEqual(native.calls, [['themeChange', 'dark']])
  const mutationCount = p.mutations.length
  const cookieCount = p.cookieWrites.length
  for (let i = 0; i < 5; i++) {
    p.event('biliThemeChange')
    p.event('pageshow')
    await p.flush()
  }
  assert.deepEqual(native.calls, [['themeChange', 'dark']])
  assert.equal(p.mutations.length, mutationCount)
  assert.equal(p.cookieWrites.length, cookieCount)
  p.preference('off')
  await p.flush()
  assert.deepEqual(native.calls, [['themeChange', 'dark'], ['themeChange', 'light']])
  assert.equal(link.href, officialLight)
  assert.doesNotMatch(p.document.cookie, /theme_style=/)
})

test('production Vue vnode discovery handles a nested and cyclic component tree', async () => {
  const p = page()
  p.link()
  const native = p.nativeHeader('light')
  const component = native.header.__vueParentComponent.parent
  component.type = { name: 'BiliHeader' }
  delete native.header.__vueParentComponent
  const app = new p.Element()
  app.id = 'app'
  const vnode = { children: [{ component }] }
  vnode.children.push(vnode)
  app._vnode = { component: { subTree: vnode } }
  p.body.append(app)
  p.preference('dark')
  p.startMain()
  await p.flush()
  assert.deepEqual(native.calls, [['themeChange', 'dark']])
})

test('the homepage native controller works without a stylesheet and restores the original class and theme', async () => {
  const p = page()
  p.root.className = 'homepage'
  const native = p.nativeHeader('light')
  p.preference('dark')
  p.startMain()
  await p.flush()
  assert.deepEqual(native.calls, [['themeChange', 'dark']])
  assert.equal(p.root.classList.contains('bili_dark'), true)
  p.preference('off')
  await p.flush()
  assert.deepEqual(native.calls, [['themeChange', 'dark'], ['themeChange', 'light']])
  assert.equal(native.theme.value, 'light')
  assert.equal(p.root.className, 'homepage')
  assert.equal(p.document.cookie, '')
})

test('live pages use their native controller and restore pre-existing live theme attributes', async () => {
  const p = page({ hostname: 'live.bilibili.com', cookie: 'theme_style=light' })
  const link = p.link('https://s1.hdslb.com/bfs/seed/jinkela/short/bili-theme/light_all.css?version=2')
  p.root.setAttribute('lab-style', 'light')
  p.root.style.colorScheme = 'light'
  const native = p.nativeHeader('light')
  let theme = 'light'
  const calls = []
  p.setPageGlobal('bililiveThemeV2', {
    getTheme: () => theme,
    changeTheme(value) {
      theme = value
      calls.push(value)
      link.href = link.href.replace(/\/(?:light|dark)_all\.css/, `/${value}_all.css`)
      p.root.setAttribute('lab-style', value)
      p.root.style.colorScheme = value
      p.event('biliThemeChange')
    },
  })
  p.preference('dark')
  p.startMain()
  await p.flush()
  assert.deepEqual(calls, ['dark'])
  assert.deepEqual(native.calls, [])
  assert.equal(p.root.getAttribute('lab-style'), 'dark')
  assert.equal(p.root.style.colorScheme, 'dark')
  p.preference('off')
  await p.flush()
  assert.deepEqual(calls, ['dark', 'light'])
  assert.equal(p.root.getAttribute('lab-style'), 'light')
  assert.equal(p.root.style.colorScheme, 'light')
  assert.equal(link.href, 'https://s1.hdslb.com/bfs/seed/jinkela/short/bili-theme/light_all.css?version=2')
})

test('fallback uses the official paired stylesheet and restores the exact original URL and page state', async () => {
  const p = page({ cookie: 'theme_style=dark; session_fixture=untouched' })
  const originalHref = '//s1.hdslb.com/bfs/seed/jinkela/short/bili-theme/dark_all.css?version=2#theme'
  const link = p.link(originalHref)
  p.root.className = 'page-shell bili_dark'
  p.root.style.colorScheme = 'dark'
  const video = new p.Element('video')
  const picture = new p.Element('img')
  video.setAttribute('src', 'https://fixture.test/video.mp4')
  picture.setAttribute('src', 'https://fixture.test/image.png')
  p.body.append(video, picture)
  p.preference('light')
  p.startMain()
  await p.flush()
  assert.equal(link.href, 'https://s1.hdslb.com/bfs/seed/jinkela/short/bili-theme/light_all.css?version=2#theme')
  assert.equal(p.root.classList.contains('bili_dark'), false)
  assert.match(p.document.cookie, /theme_style=light/)
  assert.equal(p.documentEvents.length, 1)
  assert.equal(p.documentEvents[0].type, 'biliThemeChange')
  assert.equal(p.documentEvents[0].detail.theme, 'light')
  assert.equal(p.documentEvents[0].bubbles, true)
  const writesAfterTheme = p.cookieWrites.length
  const mutationsAfterTheme = p.mutations.length
  for (let i = 0; i < 5; i++) { p.event('biliThemeChange'); p.interval(); await p.flush() }
  assert.equal(p.cookieWrites.length, writesAfterTheme)
  assert.equal(p.mutations.length, mutationsAfterTheme)
  p.preference('off')
  await p.flush()
  assert.equal(link.getAttribute('href'), originalHref)
  assert.equal(p.root.className, 'page-shell bili_dark')
  assert.equal(p.root.style.colorScheme, 'dark')
  assert.match(p.document.cookie, /theme_style=dark/)
  assert.match(p.document.cookie, /session_fixture=untouched/)
  assert.equal(video.style.filter, undefined)
  assert.equal(picture.style.filter, undefined)
  assert.equal(p.document.querySelectorAll('style').length, 0)
  assert.equal(video.getAttribute('src'), 'https://fixture.test/video.mp4')
  assert.equal(picture.getAttribute('src'), 'https://fixture.test/image.png')
})

test('a page without an original theme cookie returns to no cookie when disabled', async () => {
  const p = page({ cookie: 'unrelated=fixture' })
  const link = p.link()
  p.preference('dark')
  p.startMain()
  await p.flush()
  assert.match(p.document.cookie, /theme_style=dark/)
  p.preference('off')
  await p.flush()
  assert.equal(link.href, officialLight)
  assert.equal(p.document.cookie, 'unrelated=fixture')
})

test('unsupported or malformed fallback stylesheets and unsupported pages stay untouched', async () => {
  for (const href of [
    'https://s1.hdslb.com.evil.test/bfs/static/jinkela/long/laputa-css/light.css',
    'https://cdn.example.test/bfs/static/jinkela/long/laputa-css/light.css',
    'https://s1.hdslb.com/bfs/static/jinkela/long/unknown/light.css',
    'https://s1.hdslb.com/bfs/static/jinkela/long/laputa-css/unrelated.css',
    'https://s1.hdslb.com/bfs/static/jinkela/long/laputa-css/child/light.css',
    'data:text/css,body{}',
    '/light.css',
    undefined,
  ]) {
    const p = page()
    const link = href === undefined ? null : p.link(href)
    p.preference('dark')
    p.startMain()
    await p.flush()
    assert.equal(link?.getAttribute('href'), href)
    assert.equal(p.root.classList.contains('bili_dark'), false)
    assert.equal(p.cookieWrites.length, 0)
  }
})

test('a late stylesheet is discovered and a page theme reset is corrected only once', async () => {
  const p = page()
  p.preference('dark')
  p.startMain()
  await p.flush()
  assert.equal(p.cookieWrites.length, 0)
  const link = p.link()
  await p.flush()
  assert.equal(link.href, officialDark)
  link.href = officialLight
  await p.flush()
  assert.equal(link.href, officialDark)
  const settled = p.mutations.length
  await p.flush()
  assert.equal(p.mutations.length, settled)
})

test('turning off before a supported page appears never changes that page', async () => {
  const p = page()
  p.preference('off')
  p.startMain()
  const link = p.link()
  const native = p.nativeHeader('light')
  await p.flush()
  assert.equal(link.href, officialLight)
  assert.deepEqual(native.calls, [])
  assert.equal(p.cookieWrites.length, 0)
})

test('blocked cookies and a stale live theme getter cannot create an endless stylesheet mutation loop', async () => {
  const p = page({ hostname: 'live.bilibili.com', cookiesBlocked: true })
  const link = p.link()
  const calls = []
  p.setPageGlobal('bililiveThemeV2', {
    getTheme: () => 'light',
    changeTheme(theme) {
      calls.push(theme)
      // The native live implementation writes href even when its cookie-backed
      // getter remains stale. Reassigning the same value still emits a mutation.
      link.href = theme === 'dark' ? officialDark : officialLight
      p.document.cookie = `theme_style=${theme}; path=/`
      p.event('biliThemeChange')
    },
  })
  p.preference('dark')
  p.startMain()
  await p.flush()
  assert.deepEqual(calls, ['dark'])
  assert.equal(link.href, officialDark)
  assert.equal(p.document.cookie, '')
  const settled = p.mutations.length
  for (let i = 0; i < 5; i++) { p.event('biliThemeChange'); await p.flush() }
  assert.deepEqual(calls, ['dark'])
  assert.equal(p.mutations.length, settled)
  assert.equal(p.pendingTimers, 0)
  p.preference('off')
  await p.flush()
  assert.deepEqual(calls, ['dark', 'light'])
  assert.equal(link.href, officialLight)
})

test('existing server-rendered DOM discovers a silently mounted Vue controller on retry or load', async () => {
  for (const trigger of ['retry', 'load']) {
    const p = page()
    const native = p.nativeHeader('light')
    const component = native.header.__vueParentComponent.parent
    component.type = { name: 'BiliHeader' }
    delete native.header.__vueParentComponent
    const app = new p.Element()
    app.id = 'app'
    p.body.append(app)
    p.preference('dark')
    p.startMain()
    await p.flush({ runTimers: false })
    assert.deepEqual(native.calls, [])
    assert.equal(p.pendingTimers, 1)
    const beforeHydration = p.mutations.length
    app._vnode = { children: [{ component }] }
    assert.equal(p.mutations.length, beforeHydration, 'Vue hydration may attach instance properties without a DOM mutation')
    if (trigger === 'load') p.event('load')
    await p.flush({ runTimers: trigger === 'retry' })
    assert.deepEqual(native.calls, [['themeChange', 'dark']], trigger)
    assert.equal(p.root.classList.contains('bili_dark'), true)
    assert.equal(p.pendingTimers, 0, 'Obtaining the controller cancels pending retries')
    assert.deepEqual(p.timerDelays, [100])
    await p.flush()
    assert.deepEqual(native.calls, [['themeChange', 'dark']])
  }
})

test('unsupported pages exhaust a bounded retry budget and remain idle afterward', async () => {
  const p = page()
  p.preference('dark')
  p.startMain()
  await p.flush()
  assert.deepEqual(p.timerDelays, [100, 500, 1500, 5000])
  assert.equal(p.pendingTimers, 0)
  assert.equal(p.pendingIntervals, 0)
  assert.equal(p.cookieWrites.length, 0)
  const settled = p.mutations.length
  for (let i = 0; i < 5; i++) {
    p.event('pageshow')
    p.event('load')
    p.interval()
    await p.flush()
  }
  assert.deepEqual(p.timerDelays, [100, 500, 1500, 5000])
  assert.equal(p.pendingTimers, 0)
  assert.equal(p.mutations.length, settled)
})

test('turning off cancels pending controller retries before a later mount', async () => {
  const p = page()
  p.preference('dark')
  p.startMain()
  await p.flush({ runTimers: false })
  assert.equal(p.pendingTimers, 1)
  p.preference('off')
  await p.flush({ runTimers: false })
  assert.equal(p.pendingTimers, 0)
  const native = p.nativeHeader('light')
  p.event('load')
  p.event('pageshow')
  await p.flush()
  assert.deepEqual(native.calls, [])
  assert.deepEqual(p.timerDelays, [100])
  assert.equal(p.pendingTimers, 0)
  assert.equal(p.pendingIntervals, 0)
  assert.equal(p.cookieWrites.length, 0)
})
