/**
 * 页面内提示：只用当前 frame 的 URL 匹配账号，不读取表单值或页面文本。
 * 只有用户点选账号或扩展弹窗请求填充时才取密码；不提交表单。
 */
;(() => {
  const state = {
    known: false,
    locked: true,
    prompt: true,
    items: [],
    field: null,
    open: false,
    shown: false,
    filling: false,
    url: location.href,
    revision: 0,
    locale: 'zh-CN',
    messages: {},
  }
  // closed ShadowRoot 不能通过 host.shadowRoot 取回，必须保留自己的引用。
  let ui = null
  let refreshTimer = 0
  let positionTimer = 0
  let forceRefresh = false

  function text(source, params = {}) {
    const translated = state.messages[source]
    const template = typeof translated === 'string' ? translated : source
    return template.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(params, key) ? String(params[key]) : token)
  }

  function visible(el) {
    if (!el?.isConnected || el.disabled || el.readOnly || el.closest('[hidden], [inert]')) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 20 || rect.height < 8) return false
    const style = getComputedStyle(el)
    return !['hidden', 'collapse'].includes(style.visibility) && style.display !== 'none' && style.opacity !== '0'
  }

  function passwordField(el) {
    return el instanceof HTMLInputElement && el.type === 'password' && visible(el)
  }

  function findPasswordField() {
    if (passwordField(document.activeElement)) return document.activeElement
    if (passwordField(state.field)) return state.field
    const fields = [...document.querySelectorAll('input[type="password"]')].filter(visible)
    // 注册/改密页的新密码框，不默认写入已有密码；用户主动聚焦后仍可选择填充。
    return fields.find((el) => el.autocomplete === 'current-password')
      ?? fields.find((el) => !el.autocomplete.split(/\s+/).includes('new-password'))
      ?? null
  }

  function ensureUi() {
    if (ui) {
      if (!ui.host.isConnected) document.documentElement.append(ui.host)
      return ui
    }
    const host = document.createElement('div')
    host.id = 'hd-pm-root'
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;display:none'
    const shadow = host.attachShadow({ mode: 'closed' })
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          --surface: #fff; --text: #17243b; --muted: #6b7c96; --line: #e3eaf5;
          --brand: #2865e8; --soft: #edf4ff; --hover: #f1f6ff; --shadow: rgba(32, 61, 115, .16);
          color-scheme: light; color: var(--text); font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          direction: ltr; text-align: left; -webkit-font-smoothing: antialiased;
        }
        *, *::before, *::after { box-sizing: border-box; }
        button { margin: 0; font: inherit; color: inherit; cursor: pointer; }
        button:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
        button:disabled { cursor: wait; opacity: .65; }
        .chip {
          display: inline-flex; align-items: center; gap: 8px; user-select: none;
          max-width: min(360px, calc(100vw - 16px)); text-align: left;
          min-height: 32px; padding: 4px 10px 4px 5px; border-radius: 11px;
          color: var(--brand); background: var(--surface); border: 1px solid var(--line);
          box-shadow: 0 3px 12px -3px var(--shadow); transition: background .16s, box-shadow .16s;
        }
        .chip:hover { background: var(--hover); box-shadow: 0 5px 18px -3px var(--shadow); }
        .chip::after { content: ''; width: 5px; height: 5px; flex-shrink: 0; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg) translateY(-2px); margin-left: 2px; }
        .chip[aria-expanded="true"]::after { transform: rotate(225deg) translate(-1px, -1px); }
        .chip.locked { color: var(--muted); }
        .chip.locked::after { display: none; }
        .mark { display: grid; place-items: center; flex-shrink: 0; width: 22px; height: 22px; border-radius: 7px; color: var(--brand); background: var(--soft); }
        .mark svg { display: block; width: 14px; height: 14px; }
        .label { overflow-wrap: anywhere; font-weight: 550; }
        .panel {
          margin-top: 7px; padding: 5px; width: 280px; max-width: calc(100vw - 16px); max-height: min(300px, 55vh);
          overflow: auto; overscroll-behavior: contain; border-radius: 14px; background: var(--surface); border: 1px solid var(--line);
          box-shadow: 0 10px 32px -8px var(--shadow); scrollbar-width: thin;
        }
        .panel:not(.hide) { animation: appear .14s ease-out; }
        .panel-head { padding: 6px 8px 7px; font-size: 10px; font-weight: 600; color: var(--muted); }
        .item { display: block; width: 100%; padding: 9px 10px; text-align: left; border-radius: 9px;
          border: 0; background: transparent; transition: background .14s; }
        .item + .item { margin-top: 2px; }
        .item:hover, .item:focus-visible { background: var(--hover); }
        .t { display: block; font-weight: 600; font-size: 12px; overflow-wrap: anywhere; }
        .u { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; overflow-wrap: anywhere; }
        .hide { display: none; }
        @keyframes appear { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-color-scheme: dark) {
          .wrap { --surface: #162237; --text: #e5ecf7; --muted: #9baecb; --line: #2b3b54;
            --brand: #8ab4ff; --soft: #21395f; --hover: #20334f; --shadow: rgba(0, 0, 0, .42); color-scheme: dark; }
        }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
      </style>
      <div class="wrap">
        <button type="button" class="chip" aria-expanded="false" aria-controls="accounts"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></span><span class="label" aria-live="polite" aria-atomic="true"></span></button>
        <div id="accounts" class="panel hide" role="group"></div>
      </div>`
    ui = {
      host,
      chip: shadow.querySelector('.chip'),
      panel: shadow.querySelector('.panel'),
      label: shadow.querySelector('.label'),
    }
    ui.chip.addEventListener('click', (event) => {
      event.stopPropagation()
      event.preventDefault()
      if (state.locked) return render(text('密码库已锁定 · 点扩展图标解锁'))
      state.open = !state.open
      renderPanel()
      position()
    })
    // Shadow DOM 外的 document 看到的 target 是 host，保留外部点击关闭行为。
    host.addEventListener('click', (event) => event.stopPropagation())
    document.documentElement.append(host)
    return ui
  }

  function renderPanel() {
    if (!ui) return
    ui.chip.setAttribute('aria-expanded', String(state.open))
    ui.panel.setAttribute('aria-label', text('选择要填充的账号'))
    ui.panel.classList.toggle('hide', !state.open)
    ui.panel.replaceChildren()
    if (!state.open) return
    const heading = document.createElement('div')
    heading.className = 'panel-head'
    heading.textContent = text('选择要填充的账号')
    ui.panel.append(heading)
    for (const item of state.items) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'item'
      row.disabled = state.filling
      const title = document.createElement('span')
      title.className = 't'
      title.textContent = item.title || text('（未命名）')
      const user = document.createElement('span')
      user.className = 'u'
      user.textContent = item.username || text('（没有用户名）')
      row.append(title, user)
      row.addEventListener('click', () => void fillItem(item, state.field))
      ui.panel.append(row)
    }
  }

  function render(label) {
    if (!state.known || !state.prompt || !passwordField(state.field)
      || (!state.locked && state.items.length === 0)
      || (state.locked && document.activeElement !== state.field && document.activeElement !== ui?.host)) return hide()
    const { chip, label: labelEl } = ensureUi()
    ui.host.setAttribute('lang', state.locale)
    state.shown = true
    chip.classList.toggle('locked', state.locked)
    chip.disabled = state.filling
    labelEl.textContent = label ?? (state.locked ? text('密码库已锁定 · 点扩展图标解锁') : text('保存了 {count} 个账号', { count: state.items.length }))
    renderPanel()
    position()
  }

  function hide() {
    state.shown = false
    state.open = false
    if (ui) {
      ui.host.style.display = 'none'
      ui.panel.replaceChildren()
      ui.panel.classList.add('hide')
      ui.chip.setAttribute('aria-expanded', 'false')
    }
  }

  function position() {
    if (!ui || !state.shown) return
    if (!passwordField(state.field)) return hide()
    const rect = state.field.getBoundingClientRect()
    const offscreen = rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth
    ui.host.style.display = offscreen ? 'none' : 'block'
    if (offscreen) return
    const bounds = ui.host.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.right - bounds.width, innerWidth - bounds.width - 8))
    const chipHeight = ui.chip.getBoundingClientRect().height
    const preferredTop = rect.top >= chipHeight + 8 ? rect.top - chipHeight - 6 : rect.bottom + 6
    const top = Math.max(8, Math.min(preferredTop, innerHeight - bounds.height - 8))
    ui.host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }

  function schedulePosition() {
    if (positionTimer || !state.shown) return
    positionTimer = requestAnimationFrame(() => {
      positionTimer = 0
      position()
    })
  }

  function setValue(el, value) {
    if (!el) return
    // 调用原生 setter，避开 React 等框架的实例 value tracker，再派发标准事件。
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  }

  function usernameFieldFor(pwField) {
    // form.elements 包括通过 form="id" 关联、但位于 <form> 外面的输入框。
    const scope = pwField.form ? [...pwField.form.elements] : [...document.querySelectorAll('input')]
    const candidates = scope.filter((el) => el instanceof HTMLInputElement
      && el.form === pwField.form && visible(el) && ['text', 'email', 'tel'].includes(el.type)
      && !el.autocomplete.split(/\s+/).includes('one-time-code'))
    // 无 form 时只取本密码框之前、上一个密码框之后的字段，避免写进搜索或另一套登录表单。
    const before = candidates.filter((el) => el.compareDocumentPosition(pwField) & Node.DOCUMENT_POSITION_FOLLOWING)
    const previous = [...document.querySelectorAll('input[type="password"]')].filter((el) =>
      el !== pwField && el.form === pwField.form
      && (el.compareDocumentPosition(pwField) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1)
    const nearby = pwField.form || !previous ? before : before.filter((el) =>
      previous.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    const associated = pwField.form ? candidates : nearby
    const explicit = associated.filter((el) => el.autocomplete.split(/\s+/).some((token) => ['username', 'email'].includes(token)))
    if (explicit.length) return explicit.at(-1)
    const hinted = associated.filter((el) => el.type === 'email' || /user|email|login|account/i.test(`${el.name} ${el.id}`))
    if (hinted.length) return hinted.at(-1)
    return pwField.form ? nearby.at(-1) ?? null : null
  }

  async function send(type, payload = {}) {
    let response
    try { response = await chrome.runtime.sendMessage({ type, ...payload }) }
    catch { throw new Error(text('扩展连接已断开，请刷新页面后重试')) }
    if (!response?.ok) throw new Error(text(response?.error || '扩展连接已断开，请刷新页面后重试'))
    return response.data
  }

  function applyLocale(data) {
    state.locale = typeof data.locale === 'string' ? data.locale : state.locale
    state.messages = data.ui && typeof data.ui === 'object' ? data.ui : state.messages
  }

  function applyMatch(data) {
    applyLocale(data)
    state.known = true
    state.locked = Boolean(data.locked)
    state.prompt = data.prompt !== false
    state.items = Array.isArray(data.items) ? data.items : []
  }

  async function fillItem(item, field) {
    if (state.filling) return { ok: false, error: text('正在填充，请稍候') }
    if (!passwordField(field)) return { ok: false, error: text('这个页面里没找到可填写的密码框') }
    const url = location.href
    state.filling = true
    render(text('正在填充…'))
    let message
    try {
      const data = await send('fill', { id: item.id, url })
      // 等后台期间 SPA 可能已经换页/替换表单，不能把旧请求写入新页面。
      if (location.href !== url || !passwordField(field)) throw new Error(text('页面或表单已变化，请重新选择账号'))
      setValue(usernameFieldFor(field), data.username ?? '')
      if (location.href !== url || !passwordField(field)) throw new Error(text('页面或表单已变化，请重新选择账号'))
      setValue(field, data.password ?? '')
      field.focus()
      state.field = field
      state.open = false
      message = text('已填充：{title}', { title: item.title || text('账号') })
      return { ok: true, filled: true }
    } catch (error) {
      message = error?.message || text('填充失败，请重试')
      return { ok: false, error: message }
    } finally {
      state.filling = false
      render(message)
    }
  }

  async function refresh(force = false) {
    const url = location.href
    if (url !== state.url) {
      state.url = url
      state.known = false
      state.items = []
      hide()
    }
    const revision = ++state.revision
    state.field = findPasswordField()
    if (!state.field) return hide()
    if (force || !state.known) {
      try {
        const data = await send('match', { url })
        if (revision !== state.revision || location.href !== url) return
        applyMatch(data)
      } catch {
        if (revision === state.revision) {
          state.known = false
          hide()
        }
        return
      }
    }
    render()
  }

  function scheduleRefresh(force = false) {
    forceRefresh ||= force
    // 不在持续 DOM 更新时重置计时器，避免动态页面上无限推迟刷新。
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = 0
      const force = forceRefresh
      forceRefresh = false
      void refresh(force)
    }, 150)
  }

  document.addEventListener('focusin', (event) => {
    if (!passwordField(event.target)) return
    state.field = event.target
    state.open = false
    scheduleRefresh(true)
  }, true)

  function closePanel() {
    if (!state.open) return
    state.open = false
    renderPanel()
    position()
  }
  document.addEventListener('click', closePanel)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.open) return
    closePanel()
    ui?.chip.focus()
  }, true)
  addEventListener('scroll', schedulePosition, { passive: true, capture: true })
  addEventListener('resize', schedulePosition, { passive: true })
  addEventListener('popstate', () => scheduleRefresh(true))
  addEventListener('hashchange', () => scheduleRefresh(true))
  addEventListener('pageshow', () => scheduleRefresh(true))
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh(true)
  })
  // Content script 在隔离世界中改写 history，拦不住页面 JS 的 pushState。
  // 只比较 URL（不扫描 DOM / 不发送消息），覆盖没有 DOM 变动的 SPA 跳转。
  setInterval(() => {
    if (!document.hidden && location.href !== state.url) scheduleRefresh(true)
  }, 1000)

  function hasPassword(node) {
    return node?.nodeType === Node.ELEMENT_NODE && node !== ui?.host
      && (node.matches('input[type="password"]') || Boolean(node.querySelector('input[type="password"]')))
  }
  new MutationObserver((records) => {
    if (records.some((record) => {
      if (record.target === ui?.host || ui?.host.contains(record.target)) return false
      if (record.type === 'attributes') return hasPassword(record.target) || record.target === state.field
      return [...record.addedNodes, ...record.removedNodes].some(hasPassword)
    })) scheduleRefresh()
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'disabled', 'readonly', 'hidden', 'inert', 'style', 'class', 'autocomplete'],
  })

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false
    if (message?.type === 'hd-pm-refresh') {
      state.known = false
      state.items = []
      state.revision++
      hide()
      scheduleRefresh(true)
      return false
    }
    if (message?.type !== 'hd-pm-fill') return false
    ;(async () => {
      const url = location.href
      const field = findPasswordField()
      const data = await send('match', { url })
      applyLocale(data)
      if (url !== location.href) return { ok: false, error: text('页面已变化，请重新选择账号') }
      applyMatch(data)
      if (!field) return { ok: false, error: text('这个页面里没找到可填写的密码框；嵌入的登录表单可点击框旁提示填充') }
      if (state.locked) return { ok: false, error: text('密码库已锁定，请先解锁') }
      const item = state.items.find((entry) => entry.id === message.id)
      if (!item) return { ok: false, error: text('该账号的网址与当前页面不匹配，未填充') }
      state.field = field
      return fillItem(item, field)
    })().then(respond).catch((error) => respond({ ok: false, error: error?.message || text('填充失败，请刷新页面重试') }))
    return true
  })

  scheduleRefresh()
})()
