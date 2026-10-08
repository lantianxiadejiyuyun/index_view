import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../chrome_plug_in/content/shopping-account-theme.js', import.meta.url), 'utf8')
const css = await readFile(new URL('../chrome_plug_in/content/shopping-account-adaptive.css', import.meta.url), 'utf8')
const baseCSS = await readFile(new URL('../chrome_plug_in/content/shopping-theme.css', import.meta.url), 'utf8')
const accountCSS = await readFile(new URL('../chrome_plug_in/content/shopping-account-theme.css', import.meta.url), 'utf8')
const prefix = 'data-hd-pm-account-'
const rootNames = ['data-hd-pm-shopping-theme', 'data-hd-pm-shopping-site', 'data-hd-pm-shopping-page']
const hosts = ['buyertrade.taobao.com', 'cart.taobao.com', 'item-paimai.taobao.com', 'i.taobao.com',
  'rate.taobao.com', 'refund2.taobao.com', 'rights.taobao.com', 'jubao.taobao.com']

const rulesOf = text => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, declarations]) => ({ selector: selector.trim(), declarations }))
const colorDeclaration = declarations => /(?:^|;)\s*color\s*:\s*([^;!]+)/.exec(declarations)?.[1].trim()
function selectorSubjects(list) {
  let depth = 0
  let start = 0
  const selectors = []
  for (let index = 0; index < list.length; index++) {
    if (list[index] === '(' || list[index] === '[') depth++
    if (list[index] === ')' || list[index] === ']') depth--
    if (list[index] === ',' && depth === 0) { selectors.push(list.slice(start, index).trim()); start = index + 1 }
  }
  selectors.push(list.slice(start).trim())
  return selectors.map(selector => {
    const subject = selector.replace(/:is\(([^)]+)\)/g, (whole, inside) => /^(?:\[[^\]]+\]\s*,?\s*)+$/.test(inside) ? '' : whole)
      .replace(/:not\(\[[^\]]+\]\)/g, '').replace(/\s+\[[^\]]+\]/g, ' element').replace(/\[[^\]]+\]/g, '').trim()
    return { selector, subject }
  })
}
// Read root/body declarations from production CSS, including their account
// exclusion. This reproduces the actual integration failure omitted by the
// earlier mock that modeled only the adaptive marker stylesheet.
const baseRootRules = rulesOf(baseCSS).flatMap(rule => selectorSubjects(rule.selector)
  .filter(({ subject }) => subject === 'html' || subject === 'html body')
  .map(({ selector, subject }) => ({ ...rule, selector, subject })))
const accountRules = rulesOf(accountCSS)

function page({ host = 'i.taobao.com', enabled = true, subframe = false, productionBase = false } = {}) {
  const observers = new Set()
  const frames = new Map()
  const events = new Map()
  const writes = []
  let sequence = 0
  let reads = 0
  let document
  function mutate(target, type, extra = {}) {
    const record = { target, type, addedNodes: [], removedNodes: [], ...extra }
    for (const observer of observers) {
      for (const { node, options } of observer.targets) {
        if (target !== node && !(options.subtree && node.contains(target))) continue
        if (type === 'attributes' && (!options.attributes || (options.attributeFilter && !options.attributeFilter.includes(record.attributeName)))) continue
        if (type === 'childList' && !options.childList) continue
        observer.records.push(record)
        break
      }
    }
  }
  class Element {
    constructor(tag = 'div', visual = {}) {
      this.nodeType = 1
      this.tagName = tag.toUpperCase()
      this.children = []
      this.attributes = new Map()
      this.parentElement = null
      this.visual = visual
      Object.defineProperty(this, 'textContent', { get() { throw new Error('Page text read') }, set() { throw new Error('Page text write') } })
      Object.defineProperty(this, 'value', { get() { throw new Error('Form value read') }, set() { throw new Error('Form value write') } })
      Object.defineProperty(this, 'style', { get() { throw new Error('Inline style access') } })
    }
    get firstElementChild() { return this.children[0] ?? null }
    get nextElementSibling() {
      return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null
    }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    hasAttribute(name) { return this.attributes.has(name) }
    setAttribute(name, value) {
      this.attributes.set(name, String(value)); writes.push([this, name, String(value)])
      mutate(this, 'attributes', { attributeName: name })
    }
    removeAttribute(name) {
      if (!this.attributes.delete(name)) return
      writes.push([this, name, null]); mutate(this, 'attributes', { attributeName: name })
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)) }
    append(...nodes) {
      for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node) }
      mutate(this, 'childList', { addedNodes: nodes })
    }
    remove() {
      if (!this.parentElement) return
      const parent = this.parentElement
      parent.children.splice(parent.children.indexOf(this), 1)
      this.parentElement = null
      mutate(parent, 'childList', { removedNodes: [this] })
    }
    update(visual, attribute = 'style') {
      Object.assign(this.visual, visual)
      mutate(this, 'attributes', { attributeName: attribute })
    }
  }
  const root = new Element('html', { backgroundColor: 'rgb(20, 23, 27)', color: 'rgb(31, 31, 31)' })
  const body = new Element('body', { backgroundColor: 'rgb(255, 255, 255)' })
  root.append(body)
  const enabledCSS = () => root.getAttribute(rootNames[0]) === 'dark'
    && root.getAttribute(rootNames[1]) === 'taobao' && root.getAttribute(rootNames[2]) === 'taobao-account'
  function computed(node) {
    const parent = node.parentElement ? computed(node.parentElement) : null
    const result = { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none',
      color: parent?.color ?? 'rgb(31, 31, 31)', borderTopColor: 'rgba(0, 0, 0, 0)',
      borderRightColor: 'rgba(0, 0, 0, 0)', borderBottomColor: 'rgba(0, 0, 0, 0)',
      borderLeftColor: 'rgba(0, 0, 0, 0)', ...node.visual }
    if (enabledCSS()) {
      if (productionBase) {
        const subject = node === root ? 'html' : node === body ? 'html body' : null
        for (const rule of baseRootRules) {
          if (rule.subject !== subject || rule.selector.includes(':not([data-hd-pm-shopping-page="taobao-account"])')) continue
          if (/background-color\s*:/.test(rule.declarations)) result.backgroundColor = 'rgb(20, 23, 27)'
          if (colorDeclaration(rule.declarations)) result.color = 'rgb(233, 237, 242)'
        }
        const classes = (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
        for (const rule of accountRules) {
          if (!classes.some(name => new RegExp('\\.' + name + '\\s*(?=[,)])').test(rule.selector))) continue
          if (/background-color\s*:/.test(rule.declarations)) result.backgroundColor = 'rgb(29, 33, 39)'
          if (colorDeclaration(rule.declarations)) result.color = 'rgb(233, 237, 242)'
        }
      }
      const bg = node.getAttribute(prefix + 'bg')
      const fg = node.getAttribute(prefix + 'fg')
      if (bg) result.backgroundColor = bg === 'surface' ? 'rgb(29, 33, 39)' : 'rgb(37, 43, 51)'
      if (fg) result.color = { text: 'rgb(233, 237, 242)', muted: 'rgb(179, 189, 201)', ink: 'rgb(31, 31, 31)' }[fg]
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (node.hasAttribute(prefix + 'border-' + side)) result[`border${side[0].toUpperCase()}${side.slice(1)}Color`] = 'rgb(60, 70, 83)'
      }
    }
    return result
  }
  const listen = (name, callback) => events.set(name, [...(events.get(name) ?? []), callback])
  document = { documentElement: root, body, addEventListener: listen }
  for (const name of ['cookie', 'textContent']) Object.defineProperty(document, name, { get() { throw new Error('Private page data access') } })
  const context = { document, location: { hostname: host }, console,
    getComputedStyle(node) { reads++; return computed(node) },
    addEventListener: listen,
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; this.records = []; observers.add(this) }
      observe(node, options) { this.targets.push({ node, options }) }
      disconnect() { this.targets = []; this.records = [] }
    },
  }
  for (const name of ['chrome', 'fetch', 'XMLHttpRequest', 'localStorage', 'sessionStorage']) {
    Object.defineProperty(context, name, { get() { throw new Error('Forbidden capability: ' + name) } })
  }
  context.window = context
  context.top = subframe ? {} : context
  root.setAttribute(rootNames[1], 'taobao')
  root.setAttribute(rootNames[2], 'taobao-account')
  if (enabled) root.setAttribute(rootNames[0], 'dark')
  const flushObservers = () => {
    for (const observer of observers) if (observer.records.length) observer.callback(observer.records.splice(0))
  }
  return { root, body, Element, writes, computed,
    get reads() { return reads },
    get pendingFrames() { return frames.size },
    start() { vm.runInNewContext(source, context, { filename: 'shopping-account-theme.js' }) },
    flushObservers,
    frame() {
      flushObservers()
      const next = [...frames.entries()]
      frames.clear()
      for (const [, callback] of next) callback()
      flushObservers()
    },
    flush() {
      for (let round = 0; round < 200; round++) {
        this.frame()
        if (!frames.size && ![...observers].some(observer => observer.records.length)) return
      }
      throw new Error('Unbounded mutation/frame loop')
    },
  }
}

test('fallback accepts exactly the eight account hosts, top frame, and all three root markers', () => {
  for (const host of hosts) {
    const p = page({ host }); p.start(); p.flush()
    assert.equal(p.body.getAttribute(prefix + 'bg'), 'surface', host)
  }
  for (const options of [{ host: 'www.taobao.com' }, { host: 'i.taobao.com.attacker.example' },
    { host: 'detail.tmall.com' }, { subframe: true }, { enabled: false }]) {
    const p = page(options); p.start(); p.flush()
    assert.equal(p.body.getAttribute(prefix + 'bg'), null)
    assert.equal(p.reads, 0)
  }
  for (const name of rootNames) {
    const p = page(); p.root.removeAttribute(name); p.start(); p.flush()
    assert.equal(p.reads, 0, name)
  }
})

test('pairs neutral backgrounds with readable text and only neutral border sides', () => {
  const p = page()
  const panel = new p.Element('div', { backgroundColor: 'rgb(238, 238, 238)', color: 'rgb(40, 40, 40)',
    borderTopColor: 'rgb(220, 220, 220)', borderBottomColor: 'rgb(255, 80, 0)' })
  const muted = new p.Element('span', { color: 'rgb(128, 128, 128)' })
  panel.append(muted); p.body.append(panel); p.start(); p.flush()
  assert.equal(panel.getAttribute(prefix + 'bg'), 'raised')
  assert.equal(panel.getAttribute(prefix + 'fg'), 'text')
  assert.equal(muted.getAttribute(prefix + 'fg'), 'muted')
  assert.equal(panel.getAttribute(prefix + 'border-top'), 'neutral')
  assert.equal(panel.getAttribute(prefix + 'border-bottom'), null)
})

test('preserves brand surfaces/prices, media, QR quiet zones and URL background subtrees', () => {
  const p = page()
  const button = new p.Element('button', { backgroundColor: 'rgb(255, 230, 0)' })
  const explicitButton = new p.Element('button', { backgroundColor: 'rgb(255, 230, 0)', color: 'rgb(8, 8, 8)' })
  const price = new p.Element('span', { color: 'rgb(255, 80, 0)' })
  const photo = new p.Element('img', { backgroundColor: 'rgb(255, 255, 255)' })
  const qr = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)' }); qr.setAttribute('class', 'login-qrcode-wrapper')
  const qrChild = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)' }); qr.append(qrChild)
  const mediaHolder = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)' }); mediaHolder.setAttribute('role', 'img'); mediaHolder.append(new p.Element('canvas'))
  const productCard = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)' }); productCard.append(new p.Element('img'))
  const banner = new p.Element('div', { backgroundImage: 'url("https://example.invalid/image.png")' })
  const bannerChild = new p.Element('span', { backgroundColor: 'rgb(255, 255, 255)' }); banner.append(bannerChild)
  p.body.append(button, explicitButton, price, photo, qr, mediaHolder, banner, productCard); p.start(); p.flush()
  for (const node of [button, photo, qr, qrChild, mediaHolder, banner, bannerChild]) assert.equal(node.getAttribute(prefix + 'bg'), null)
  assert.equal(p.computed(button).color, 'rgb(31, 31, 31)', 'inherited black text stays black on yellow')
  assert.equal(explicitButton.getAttribute(prefix + 'fg'), null, 'explicit brand label foreground is not changed')
  assert.equal(p.computed(explicitButton).color, 'rgb(8, 8, 8)')
  assert.equal(productCard.getAttribute(prefix + 'bg'), 'surface', 'ordinary product images do not exempt the surrounding card')
  assert.equal(price.getAttribute(prefix + 'fg'), null)
  assert.equal(p.computed(price).color, 'rgb(255, 80, 0)')
})

test('observes new content and external class/style changes, without reacting to owned attributes', () => {
  const p = page(); p.start(); p.flush()
  const panel = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(10, 10, 10)' })
  p.body.append(panel); p.flush()
  assert.equal(panel.getAttribute(prefix + 'bg'), 'surface')
  panel.update({ backgroundColor: 'rgb(255, 220, 0)' }, 'class'); p.flush()
  assert.equal(panel.getAttribute(prefix + 'bg'), null)
  assert.equal(p.computed(panel).color, 'rgb(10, 10, 10)')
  panel.update({ backgroundColor: 'rgb(240, 240, 240)' }); p.flush()
  assert.equal(panel.getAttribute(prefix + 'bg'), 'surface')
  const before = p.reads; p.flush(); p.flush()
  assert.equal(p.reads, before, 'no recurring full-DOM polling')
  assert.equal(p.pendingFrames, 0, 'owned marker writes cannot create observer loops')
})

test('adding a protected ancestor removes previously adapted child markers', () => {
  const p = page()
  const panel = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)' })
  const child = new p.Element('span', { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' })
  panel.append(child); p.body.append(panel); p.start(); p.flush()
  assert.equal(child.getAttribute(prefix + 'bg'), 'surface')
  panel.setAttribute('class', 'qr-code'); p.flush()
  assert.equal(child.getAttribute(prefix + 'bg'), null)
  assert.equal(child.getAttribute(prefix + 'fg'), null)
  panel.removeAttribute('class'); p.flush()
  assert.equal(child.getAttribute(prefix + 'bg'), 'surface')
  panel.update({ backgroundImage: 'url("decorative.png")' }); p.flush()
  assert.equal(child.getAttribute(prefix + 'bg'), null)
})

test('stopping immediately restores CSS and clears only owned attributes; reenabling rescans', () => {
  const p = page()
  const panel = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' })
  panel.setAttribute('style', 'background: white; color: black')
  panel.setAttribute('class', 'original-panel'); panel.setAttribute('data-business', 'keep')
  p.body.append(panel); p.start(); p.flush()
  p.root.removeAttribute(rootNames[0])
  assert.equal(p.computed(panel).backgroundColor, 'rgb(255, 255, 255)', 'CSS stops before observer delivery')
  p.flushObservers()
  assert.equal(p.pendingFrames, 0)
  for (const name of panel.attributes.keys()) assert.ok(!name.startsWith(prefix))
  assert.equal(panel.getAttribute('style'), 'background: white; color: black')
  assert.equal(panel.getAttribute('class'), 'original-panel')
  assert.equal(panel.getAttribute('data-business'), 'keep')
  const reads = p.reads; panel.update({ backgroundColor: 'rgb(235, 235, 235)' }); p.flush()
  assert.equal(p.reads, reads, 'content observer is disconnected while off')
  p.root.setAttribute(rootNames[0], 'dark'); p.flush()
  assert.equal(panel.getAttribute(prefix + 'bg'), 'raised')
})

test('large trees adapt in batches of at most 80 elements and detach cleanup terminates', () => {
  const p = page()
  const nodes = Array.from({ length: 245 }, () => new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)' }))
  p.body.append(...nodes); p.start(); p.frame()
  assert.equal(nodes.filter(node => node.hasAttribute(prefix + 'bg')).length, 79, 'body consumes one slot')
  assert.equal(p.pendingFrames, 1)
  p.frame()
  assert.equal(nodes.filter(node => node.hasAttribute(prefix + 'bg')).length, 159)
  p.flush()
  assert.equal(nodes.filter(node => node.hasAttribute(prefix + 'bg')).length, 245)
  const before = p.reads
  const added = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)' })
  p.body.append(added); p.flush()
  assert.equal(added.getAttribute(prefix + 'bg'), 'surface')
  assert.ok(p.reads - before < 20, 'one appended card does not revisit 245 unchanged siblings')
  nodes[0].remove(); p.flush()
  assert.equal(nodes[0].getAttribute(prefix + 'bg'), null)
  assert.equal(p.pendingFrames, 0)
})

test('fallback stylesheet is entirely triple-gated and never filters media or changes geometry', () => {
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  assert.equal(selectors.length, 9)
  for (const [, list, declarations] of selectors) {
    for (const selector of list.trim().split(',\n')) {
      assert.match(selector.trim(), /^html\[data-hd-pm-shopping-theme="dark"\]\[data-hd-pm-shopping-site="taobao"\]\[data-hd-pm-shopping-page="taobao-account"\] body/)
    }
    for (const declaration of declarations.trim().split(';').filter(Boolean)) assert.match(declaration.trim(), /^(?:background-color|color|border-(?:top|right|bottom|left)-color):/)
  }
  assert.doesNotMatch(source, /(?:\.textContent|\.innerText|\.value\b|document\.cookie|localStorage|chrome\.|fetch\(|XMLHttpRequest)/)
})

test('production root and account container styles leave native inherited foreground measurable', () => {
  const foregroundRules = baseRootRules.filter(rule => colorDeclaration(rule.declarations)
    || /--tbpc-primary-color\s*:/.test(rule.declarations))
  assert.ok(foregroundRules.length >= 3, 'root, body and neutral-token color rules remain for other pages')
  for (const rule of foregroundRules) assert.ok(rule.selector.includes(':not([data-hd-pm-shopping-page="taobao-account"])'), rule.selector)
  for (const className of ['next-card', 'next-card-body', 'next-table', 'next-dialog', 'next-dialog-body', 'next-input']) {
    for (const rule of accountRules.filter(rule => new RegExp('\\.' + className + '\\s*(?=[,)])').test(rule.selector))) {
      assert.equal(colorDeclaration(rule.declarations), undefined, `${className} must not hide a branded child's native inherited text`)
    }
  }
})

test('yellow inherited labels stay dark with production CSS; explicit white brand labels remain white', () => {
  for (const className of ['', 'next-card', 'next-card-body', 'next-table', 'next-dialog', 'next-dialog-body', 'next-input']) {
    const p = page({ productionBase: true })
    p.body.visual.color = 'rgb(51, 51, 51)'
    const panel = new p.Element('div', { backgroundColor: 'rgb(255, 255, 255)' })
    if (className) panel.setAttribute('class', className)
    const inherited = new p.Element('button', { backgroundColor: 'rgb(255, 233, 90)' })
    const inheritedLabel = new p.Element('span')
    inherited.append(inheritedLabel)
    const explicitWhite = new p.Element('button', { backgroundColor: 'rgb(255, 233, 90)', color: 'rgb(255, 255, 255)' })
    const whiteLabel = new p.Element('span')
    explicitWhite.append(whiteLabel)
    panel.append(inherited, explicitWhite); p.body.append(panel)
    p.start(); p.flush()
    assert.equal(p.body.getAttribute(prefix + 'fg'), 'text', 'body foreground is reversibly owned by the adaptive script')
    assert.equal(p.computed(inheritedLabel).color, 'rgb(31, 31, 31)', className || 'legacy panel')
    assert.equal(inherited.getAttribute(prefix + 'fg'), 'ink')
    assert.equal(explicitWhite.getAttribute(prefix + 'fg'), null, 'do not assume every bright button needs black text')
    assert.equal(p.computed(whiteLabel).color, 'rgb(255, 255, 255)')
    p.root.removeAttribute(rootNames[0]); p.flush()
    assert.equal(p.computed(inheritedLabel).color, 'rgb(51, 51, 51)')
    assert.equal(p.computed(whiteLabel).color, 'rgb(255, 255, 255)')
  }
})
