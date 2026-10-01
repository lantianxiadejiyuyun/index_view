import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../chrome_plug_in/content/prompt.js', import.meta.url), 'utf8')

// Small DOM/runtime harness: no browser, network, or real vault is accessed.
function page() {
  const timers = new Map()
  const intervals = []
  const pendingMutations = []
  const shadows = new Map()
  const windowEvents = new Map()
  const documentEvents = new Map()
  let nextTimer = 1
  let observer
  let receiver
  let document
  const mutate = (record) => {
    if (document?.documentElement.contains(record.target)) pendingMutations.push(record)
  }
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase()
      this.nodeType = 1
      this.parentElement = null
      this.children = []
      this.listeners = new Map()
      this.attributes = new Map()
      this.className = ''
      this.id = ''
      this.textContent = ''
      this.disabled = false
      this.readOnly = false
      this.hidden = false
      this.inert = false
      this.rect = { top: 200, bottom: 230, left: 200, right: 400, width: 200, height: 30 }
      this.style = new Proxy({}, { set: (object, key, value) => {
        object[key] = value
        mutate({ type: 'attributes', target: this })
        return true
      } })
      this.classList = {
        add: (name) => this.classList.toggle(name, true),
        contains: (name) => this.className.split(' ').includes(name),
        toggle: (name, force) => {
          const names = new Set(this.className.split(' ').filter(Boolean))
          const add = force ?? !names.has(name)
          if (add) names.add(name)
          else names.delete(name)
          this.className = [...names].join(' ')
          return add
        },
      }
    }
    get isConnected() { return this === document?.documentElement || Boolean(this.parentElement?.isConnected || this.host?.isConnected) }
    get shadowRoot() { return null }
    attachShadow() {
      const root = new Element('shadow-root')
      root.host = this
      shadows.set(this, root)
      return root
    }
    set innerHTML(_value) {
      const chip = new Element('button')
      chip.className = 'chip'
      const label = new Element('span')
      label.className = 'label'
      chip.append(label)
      const panel = new Element()
      panel.className = 'panel hide'
      this.append(chip, panel)
    }
    append(...nodes) {
      for (const node of nodes) {
        node.remove()
        node.parentElement = this
        this.children.push(node)
      }
      mutate({ type: 'childList', target: this, addedNodes: nodes, removedNodes: [] })
    }
    remove() {
      if (!this.parentElement) return
      const parent = this.parentElement
      parent.children = parent.children.filter((node) => node !== this)
      this.parentElement = null
      mutate({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] })
    }
    replaceChildren(...nodes) {
      for (const node of [...this.children]) node.remove()
      if (nodes.length) this.append(...nodes)
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)) }
    closest() {
      for (let el = this; el; el = el.parentElement) if (el.hidden || el.inert) return el
      return null
    }
    matches(selector) {
      if (selector === 'input') return this.tagName === 'INPUT'
      if (selector === 'input[type="password"]') return this.tagName === 'INPUT' && this.type === 'password'
      return selector.startsWith('.') && this.classList.contains(selector.slice(1))
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    getBoundingClientRect() { return this.rect }
    compareDocumentPosition(other) {
      const inputs = document.querySelectorAll('input')
      return inputs.indexOf(this) < inputs.indexOf(other) ? 4 : 2
    }
    setAttribute(name, value) { this.attributes.set(name, value) }
    addEventListener(type, callback) {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(callback)
      this.listeners.set(type, listeners)
    }
    dispatchEvent(event) {
      event.target = this
      for (const callback of this.listeners.get(event.type) ?? []) callback(event)
      return true
    }
    focus() {
      document.activeElement = this
      for (const callback of documentEvents.get('focusin') ?? []) callback({ target: this })
    }
  }
  class Input extends Element {
    constructor(options = {}) {
      super('input')
      this.type = 'text'
      this.name = ''
      this.autocomplete = ''
      this.form = null
      this._value = ''
      this.valueReads = 0
      this.emitted = []
      Object.assign(this, options)
    }
    set value(value) { this._value = value }
    get value() { this.valueReads++; return this._value }
    dispatchEvent(event) {
      this.emitted.push(event)
      return super.dispatchEvent(event)
    }
  }
  const root = new Element('html')
  document = {
    documentElement: root,
    activeElement: null,
    hidden: false,
    createElement: (tag) => tag === 'input' ? new Input() : new Element(tag),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener(type, callback) {
      const list = documentEvents.get(type) ?? []
      list.push(callback)
      documentEvents.set(type, list)
    },
  }
  const api = {
    document,
    Input,
    Element,
    messages: [],
    location: { href: 'https://example.test/login' },
    match: { locked: false, prompt: true, items: [{ id: 'saved', title: '测试账号', username: 'alice' }] },
    fill: { username: 'alice', password: 'test-secret-only' },
    onSend: null,
    get hosts() { return root.children.filter((node) => node.id === 'hd-pm-root') },
    get shadow() { return shadows.get(this.hosts[0]) },
    append(...nodes) { root.append(...nodes) },
    attribute(node) { mutate({ type: 'attributes', target: node }) },
    event(type, event = {}) { for (const cb of windowEvents.get(type) ?? []) cb(event) },
    interval() { for (const cb of intervals) cb() },
    click(node) { node.dispatchEvent({ type: 'click', stopPropagation() {}, preventDefault() {} }) },
    async message(message, senderId = 'extension-id') {
      return new Promise((resolve) => {
        if (!receiver(message, { id: senderId }, resolve)) resolve(undefined)
      })
    },
    async flush() {
      for (let round = 0; round < 30; round++) {
        if (pendingMutations.length) observer?.(pendingMutations.splice(0))
        const current = [...timers]
        timers.clear()
        for (const [, callback] of current) callback()
        for (let turn = 0; turn < 8; turn++) await Promise.resolve()
        if (!timers.size && !pendingMutations.length) return
      }
      throw new Error('Unbounded content-script refresh loop')
    },
  }
  vm.runInNewContext(source, {
    document,
    location: api.location,
    HTMLInputElement: Input,
    Node: { ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 },
    innerHeight: 800,
    innerWidth: 1200,
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options) } },
    MutationObserver: class {
      constructor(callback) { observer = callback }
      observe() {}
    },
    getComputedStyle: (el) => ({ visibility: 'visible', display: 'block', opacity: '1', ...el.style }),
    setTimeout: (callback) => { const id = nextTimer++; timers.set(id, callback); return id },
    setInterval: (callback) => intervals.push(callback),
    requestAnimationFrame: (callback) => { const id = nextTimer++; timers.set(id, callback); return id },
    addEventListener: (type, callback) => {
      const list = windowEvents.get(type) ?? []
      list.push(callback)
      windowEvents.set(type, list)
    },
    chrome: {
      runtime: {
        id: 'extension-id',
        onMessage: { addListener(callback) { receiver = callback } },
        async sendMessage(message) {
          api.messages.push(message)
          if (api.onSend) return api.onSend(message)
          return { ok: true, data: message.type === 'match' ? api.match : api.fill }
        },
      },
    },
  }, { filename: 'content/prompt.js' })
  return api
}

test('late password forms create one closed shadow root without a self-refresh loop', async () => {
  const p = page()
  await p.flush()
  assert.equal(p.hosts.length, 0)
  assert.equal(p.messages.length, 0)
  p.append(new p.Input({ type: 'password' }))
  await p.flush()
  assert.equal(p.hosts.length, 1)
  assert.equal(p.hosts[0].shadowRoot, null)
  assert.equal(p.messages.length, 1)
  for (let i = 0; i < 5; i++) {
    p.event('scroll')
    await p.message({ type: 'hd-pm-refresh' })
    await p.flush()
  }
  assert.equal(p.hosts.length, 1)
  assert.equal(p.messages.length, 6)
})

test('disabled prompts stay hidden on focus and scroll, including a locked vault', async () => {
  const p = page()
  const password = new p.Input({ type: 'password' })
  p.append(password)
  await p.flush()
  p.match = { locked: true, prompt: false, items: [] }
  await p.message({ type: 'hd-pm-refresh' })
  password.focus()
  await p.flush()
  p.event('scroll')
  p.event('resize')
  await p.flush()
  assert.equal(p.hosts.length, 1)
  assert.equal(p.hosts[0].style.display, 'none')
  assert.equal(p.messages.filter((m) => m.type === 'fill').length, 0)
})

test('attribute changes reveal late forms without repeated background matching', async () => {
  const p = page()
  const wrapper = new p.Element()
  const password = new p.Input({ type: 'password' })
  wrapper.hidden = true
  wrapper.append(password)
  p.append(wrapper)
  await p.flush()
  assert.equal(p.hosts.length, 0)
  wrapper.hidden = false
  p.attribute(wrapper)
  await p.flush()
  assert.equal(p.hosts.length, 1)
  for (let i = 0; i < 10; i++) p.attribute(wrapper)
  await p.flush()
  assert.equal(p.messages.length, 1)
})

test('fills the focused form and its external username using native input events', async () => {
  const p = page()
  const firstForm = { elements: [] }
  const secondForm = { elements: [] }
  const firstUser = new p.Input({ form: firstForm, autocomplete: 'username' })
  const firstPassword = new p.Input({ form: firstForm, type: 'password' })
  const secondUser = new p.Input({ form: secondForm, autocomplete: 'section-login username' })
  const otp = new p.Input({ form: secondForm, name: 'user-code', autocomplete: 'one-time-code' })
  const secondPassword = new p.Input({ form: secondForm, type: 'password' })
  firstForm.elements = [firstUser, firstPassword]
  secondForm.elements = [secondUser, otp, secondPassword]
  p.append(firstUser, firstPassword, secondUser, otp, secondPassword)
  let frameworkSetterCalls = 0
  Object.defineProperty(secondPassword, 'value', { set() { frameworkSetterCalls++ } })
  secondPassword.focus()
  await p.flush()
  const result = await p.message({ type: 'hd-pm-fill', id: 'saved' })
  assert.equal(result.ok, true)
  assert.equal(result.filled, true)
  assert.equal(secondUser._value, 'alice')
  assert.equal(secondPassword._value, 'test-secret-only')
  assert.equal(firstUser._value, '')
  assert.equal(firstPassword._value, '')
  assert.equal(otp._value, '')
  assert.equal(frameworkSetterCalls, 0)
  assert.deepEqual(secondPassword.emitted.map((event) => event.type), ['input', 'change'])
  assert.ok(secondPassword.emitted.every((event) => event.bubbles && event.composed))
  assert.equal(firstUser.valueReads + secondUser.valueReads + secondPassword.valueReads, 0)
})

test('unmatched popup selections do not request a password, and failures reach the popup', async () => {
  const p = page()
  const password = new p.Input({ type: 'password' })
  p.append(password)
  await p.flush()
  const unmatched = await p.message({ type: 'hd-pm-fill', id: 'other-site' })
  assert.equal(unmatched.ok, false)
  assert.match(unmatched.error, /不匹配/)
  assert.equal(p.messages.filter((message) => message.type === 'fill').length, 0)
  p.onSend = async (message) => message.type === 'fill'
    ? { ok: false, error: '密码库已锁定' }
    : { ok: true, data: p.match }
  const failure = await p.message({ type: 'hd-pm-fill', id: 'saved' })
  assert.equal(failure.ok, false)
  assert.equal(failure.error, '密码库已锁定')
  assert.equal(password._value, '')
})

test('SPA URL changes invalidate cached matches even without DOM mutations', async () => {
  const p = page()
  p.append(new p.Input({ type: 'password' }))
  await p.flush()
  p.match = { locked: false, prompt: true, items: [] }
  p.location.href = 'https://example.test/account'
  p.interval()
  await p.flush()
  assert.equal(p.messages.length, 2)
  assert.equal(p.messages[1].url, p.location.href)
  assert.equal(p.hosts[0].style.display, 'none')
})

test('password responses cannot write after the form is replaced', async () => {
  const p = page()
  const password = new p.Input({ type: 'password' })
  p.append(password)
  await p.flush()
  let release
  p.onSend = (message) => message.type === 'fill'
    ? new Promise((resolve) => { release = resolve })
    : { ok: true, data: p.match }
  const pending = p.message({ type: 'hd-pm-fill', id: 'saved' })
  await p.flush()
  assert.ok(release)
  password.remove()
  const replacement = new p.Input({ type: 'password' })
  p.append(replacement)
  release({ ok: true, data: p.fill })
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /表单已变化/)
  assert.equal(password._value, '')
  assert.equal(replacement._value, '')
})

test('username input handlers replacing the form cannot receive a password on the old field', async () => {
  const p = page()
  const form = { elements: [] }
  const user = new p.Input({ form, autocomplete: 'username' })
  const password = new p.Input({ form, type: 'password' })
  form.elements = [user, password]
  p.append(user, password)
  user.addEventListener('input', () => password.remove())
  await p.flush()
  const result = await p.message({ type: 'hd-pm-fill', id: 'saved' })
  assert.equal(result.ok, false)
  assert.equal(password._value, '')
})

test('new-password forms are not suggested until explicitly focused; foreign extension messages are ignored', async () => {
  const p = page()
  const password = new p.Input({ type: 'password', autocomplete: 'new-password' })
  p.append(password)
  await p.flush()
  assert.equal(p.hosts.length, 0)
  const ignored = await p.message({ type: 'hd-pm-fill', id: 'saved' }, 'another-extension')
  assert.equal(ignored, undefined)
  password.focus()
  await p.flush()
  assert.equal(p.hosts.length, 1)
})

test('formless login groups do not fill an earlier account or unrelated search input', async () => {
  const p = page()
  const firstUser = new p.Input({ autocomplete: 'username' })
  const firstPassword = new p.Input({ type: 'password' })
  const search = new p.Input({ name: 'search' })
  const secondPassword = new p.Input({ type: 'password' })
  p.append(firstUser, firstPassword, search, secondPassword)
  secondPassword.focus()
  await p.flush()
  const result = await p.message({ type: 'hd-pm-fill', id: 'saved' })
  assert.equal(result.ok, true)
  assert.equal(secondPassword._value, 'test-secret-only')
  assert.equal(firstPassword._value, '')
  assert.equal(firstUser._value, '')
  assert.equal(search._value, '')
})

test('out-of-order match responses cannot restore stale SPA account hints', async () => {
  const p = page()
  const pending = []
  p.onSend = () => new Promise((resolve) => pending.push(resolve))
  p.append(new p.Input({ type: 'password' }))
  await p.flush()
  p.location.href = 'https://example.test/another-login'
  p.interval()
  await p.flush()
  assert.equal(pending.length, 2)
  pending[1]({ ok: true, data: p.match })
  await p.flush()
  assert.equal(p.hosts[0].style.display, 'block')
  pending[0]({ ok: true, data: { locked: false, prompt: true, items: [] } })
  await p.flush()
  assert.equal(p.hosts[0].style.display, 'block')
  assert.match(p.shadow.querySelector('.label').textContent, /1 个账号/)
})

test('removed password fields hide existing prompts without recreating UI on scroll', async () => {
  const p = page()
  const password = new p.Input({ type: 'password' })
  p.append(password)
  await p.flush()
  password.remove()
  await p.flush()
  p.event('scroll')
  await p.flush()
  assert.equal(p.hosts.length, 1)
  assert.equal(p.hosts[0].style.display, 'none')
  const result = await p.message({ type: 'hd-pm-fill', id: 'saved' })
  assert.equal(result.ok, false)
  assert.match(result.error, /没找到可填写的密码框/)
})

test('a language refresh translates the existing chip, account picker, and accessible labels', async () => {
  const p = page()
  p.append(new p.Input({ type: 'password' }))
  await p.flush()
  const host = p.hosts[0]
  p.match = {
    ...p.match, locale: 'en', items: [{ id: 'saved', title: '', username: '' }],
    ui: {
      '保存了 {count} 个账号': '{count} saved accounts',
      '选择要填充的账号': 'Choose an account to fill',
      '（未命名）': '(Untitled)',
      '（没有用户名）': '(No username)',
    },
  }
  await p.message({ type: 'hd-pm-refresh' })
  await p.flush()
  assert.equal(p.hosts.length, 1)
  assert.equal(p.hosts[0], host)
  assert.equal(host.attributes.get('lang'), 'en')
  assert.equal(p.shadow.querySelector('.label').textContent, '1 saved accounts')
  p.click(p.shadow.querySelector('.chip'))
  assert.equal(p.shadow.querySelector('.panel').attributes.get('aria-label'), 'Choose an account to fill')
  assert.equal(p.shadow.querySelector('.panel-head').textContent, 'Choose an account to fill')
  assert.equal(p.shadow.querySelector('.t').textContent, '(Untitled)')
  assert.equal(p.shadow.querySelector('.u').textContent, '(No username)')
})

test('fill results localize templates while leaving user account titles intact', async () => {
  const p = page()
  const title = '<Private name> {count}'
  p.match = {
    ...p.match, locale: 'ja', items: [{ id: 'saved', title, username: 'alice' }],
    ui: { '已填充：{title}': '入力済み：{title}' },
  }
  p.append(new p.Input({ type: 'password' }))
  await p.flush()
  const result = await p.message({ type: 'hd-pm-fill', id: 'saved' })
  assert.equal(result.filled, true)
  assert.equal(p.shadow.querySelector('.label').textContent, '入力済み：' + title)
})

test('manual fill obtains the selected language even when the page has no password field', async () => {
  const p = page()
  p.match = {
    ...p.match, locale: 'zh-TW', ui: {
      '这个页面里没找到可填写的密码框；嵌入的登录表单可点击框旁提示填充': '找不到可填寫的密碼欄位；嵌入表單可點選欄位旁的提示',
    },
  }
  await p.flush()
  assert.equal(p.messages.length, 0)
  const result = await p.message({ type: 'hd-pm-fill', id: 'saved' })
  assert.equal(result.ok, false)
  assert.equal(result.error, '找不到可填寫的密碼欄位；嵌入表單可點選欄位旁的提示')
  assert.equal(p.messages.length, 1)
  assert.equal(p.hosts.length, 0)
})

test('extension disconnection errors use the latest selected language', async () => {
  const p = page()
  p.match = {
    ...p.match, locale: 'en', ui: {
      '扩展连接已断开，请刷新页面后重试': 'Extension disconnected. Refresh this page and try again.',
    },
  }
  p.append(new p.Input({ type: 'password' }))
  await p.flush()
  p.onSend = async () => { throw new Error('Extension context invalidated') }
  const result = await p.message({ type: 'hd-pm-fill', id: 'saved' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'Extension disconnected. Refresh this page and try again.')
})
