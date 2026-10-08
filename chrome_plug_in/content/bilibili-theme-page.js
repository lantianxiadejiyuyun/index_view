/* Runs in MAIN solely to reach Bilibili's own theme controller. No extension API. */
(() => {
  if (!/(^|\.)bilibili\.com$/.test(location.hostname) || window.top !== window) return
  const attribute = 'data-hd-pm-bilibili-theme'
  const nativeSelector = '.bili-header, #app, #__css-map__'
  let original = null
  let applying = false
  let pending = false
  let lastController = null
  let lastTheme = null
  let retryTimer = null
  let retries = 0
  const retryDelays = [100, 500, 1500, 5000]

  function retryController() {
    if (retryTimer !== null || retries >= retryDelays.length) return
    retryTimer = setTimeout(() => { retryTimer = null; schedule() }, retryDelays[retries++])
  }
  function stopRetries() {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    retries = 0
  }

  function stylesheet() {
    const link = document.getElementById('__css-map__')
    if (!link || link.tagName !== 'LINK') return null
    try {
      const url = new URL(link.href, location.href)
      if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 's1.hdslb.com') return null
      const match = url.pathname.match(/^(\/bfs\/(?:seed\/jinkela\/short\/bili-theme|static\/jinkela\/long\/laputa-css)\/)(light|dark)(_all)?\.css$/)
      return match ? { link, url, prefix: match[1], theme: match[2], suffix: match[3] || '' } : null
    } catch { return null }
  }
  function cookieTheme() {
    try { return document.cookie.match(/(?:^|;\s*)theme_style=(light|dark)(?:;|$)/)?.[1] || null } catch { return null }
  }
  function setCookie(theme) {
    try {
      if (cookieTheme() === theme) return
      document.cookie = `theme_style=${theme}; path=/; domain=.bilibili.com; max-age=31536000; SameSite=Lax`
    } catch { /* Styling still works when site cookies are blocked. */ }
  }
  function headerController() {
    const controller = (instance) => {
      const provides = instance?.provides
      return provides?.emitter && typeof provides.emitter.emit === 'function' && provides.theme
        ? { identity: provides.emitter, theme: provides.theme.value, change: (theme) => provides.emitter.emit('themeChange', theme) } : null
    }
    for (const node of document.querySelectorAll('.bili-header')) {
      let instance = node.__vueParentComponent
      for (let depth = 0; instance && depth < 12; depth += 1, instance = instance.parent) {
        const found = controller(instance)
        if (found) return found
      }
    }
    // The homepage's production Vue build omits __vueParentComponent, but its
    // root vnode retains the mounted BiliHeader component. Bound the traversal.
    const stack = [document.getElementById('app')?._vnode]
    const seen = new Set()
    while (stack.length && seen.size < 500) {
      const node = stack.pop()
      if (!node || typeof node !== 'object' || seen.has(node)) continue
      seen.add(node)
      const instance = node.component
      if (instance?.type?.name === 'BiliHeader') {
        const found = controller(instance)
        if (found) return found
      }
      if (instance?.subTree) stack.push(instance.subTree)
      if (Array.isArray(node.children)) stack.push(...node.children.slice(0, 500).reverse())
    }
    return null
  }
  function nativeController() {
    const live = location.hostname === 'live.bilibili.com' && window.bililiveThemeV2
    if (live && typeof live.changeTheme === 'function' && typeof live.getTheme === 'function') {
      // Cookies may be blocked; the visible stylesheet is authoritative and
      // prevents a failed cookie write from causing an endless observer loop.
      return { identity: live, theme: stylesheet()?.theme || live.getTheme(), change: (theme) => live.changeTheme(theme) }
    }
    return headerController()
  }
  function snapshot(css, controller) {
    const root = document.documentElement
    return {
      theme: ['dark', 'light'].includes(controller?.theme) ? controller.theme
        : css?.theme || (root.classList.contains('bili_dark') ? 'dark' : 'light'),
      href: css?.link.getAttribute('href') ?? null, link: css?.link ?? null,
      cookie: cookieTheme(), darkClass: root.classList.contains('bili_dark'),
      labStyle: root.getAttribute('lab-style'), colorScheme: root.style.colorScheme,
    }
  }
  function fallback(theme, css) {
    const url = new URL(css.url.href)
    url.pathname = `${css.prefix}${theme}${css.suffix}.css`
    if (css.link.href !== url.href) css.link.href = url.href
    if (['www.bilibili.com', 'bilibili.com'].includes(location.hostname)) {
      document.documentElement.classList.toggle('bili_dark', theme === 'dark')
    }
    setCookie(theme)
    document.dispatchEvent(new CustomEvent('biliThemeChange', { detail: { theme }, bubbles: true, cancelable: true }))
  }
  function restore() {
    if (!original) return
    const saved = original
    original = null
    const css = stylesheet()
    const controller = nativeController()
    try { controller?.change(saved.theme) } catch { /* Restore DOM below even if the native controller was removed. */ }
    if (saved.link?.isConnected) saved.link.setAttribute('href', saved.href)
    else if (css) fallback(saved.theme, css)
    const root = document.documentElement
    root.classList.toggle('bili_dark', saved.darkClass)
    if (saved.labStyle === null) root.removeAttribute('lab-style')
    else root.setAttribute('lab-style', saved.labStyle)
    root.style.colorScheme = saved.colorScheme
    if (saved.cookie) setCookie(saved.cookie)
    else {
      try {
        document.cookie = 'theme_style=; path=/; domain=.bilibili.com; max-age=0'
        document.cookie = 'theme_style=; path=/; max-age=0'
      } catch { /* Cookies can be blocked. */ }
    }
    lastController = null
    lastTheme = null
  }
  function apply() {
    pending = false
    if (applying || !document.documentElement) return
    const theme = document.documentElement.getAttribute(attribute)
    applying = true
    try {
      if (!['dark', 'light'].includes(theme)) { stopRetries(); restore(); return }
      const css = stylesheet()
      const controller = nativeController()
      if (!controller) retryController()
      else stopRetries()
      if (!css && !controller) return // Unsupported pages keep their own appearance.
      original ||= snapshot(css, controller)
      if (controller) {
        if (controller.identity !== lastController || theme !== lastTheme
          || (['dark', 'light'].includes(controller.theme) && controller.theme !== theme) || (css && css.theme !== theme)) {
          controller.change(theme)
          lastController = controller.identity
          lastTheme = theme
        }
      } else if (css.theme !== theme || lastTheme !== theme) {
        fallback(theme, css)
        lastController = null
        lastTheme = theme
      }
    } catch {
      // Native internals can change independently of the extension. Retain the
      // official stylesheet fallback, without injecting remote code or filters.
      const css = stylesheet()
      if (css && ['dark', 'light'].includes(theme) && css.theme !== theme) fallback(theme, css)
    } finally { applying = false }
  }
  function schedule() {
    if (pending || applying) return
    pending = true
    queueMicrotask(apply)
  }
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type === 'attributes'
      ? (record.target === document.documentElement && record.attributeName === attribute)
        || (record.target.id === '__css-map__' && ['href', 'id'].includes(record.attributeName))
      : [...record.addedNodes].some((node) => node.nodeType === 1
        && (node.matches(nativeSelector) || node.querySelector(nativeSelector))))) schedule()
  })
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: [attribute, 'href', 'id'] })
  document.addEventListener('DOMContentLoaded', schedule, { once: true })
  window.addEventListener('pageshow', schedule)
  window.addEventListener('load', schedule)
  window.addEventListener('biliThemeChange', schedule)
  schedule()
})()
