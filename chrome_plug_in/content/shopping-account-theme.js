/* Local neutral-color fallback for legacy Taobao account surfaces.
 * Reads rendered style only; never page text, form values, storage or network. */
(() => {
  const hosts = new Set(['buyertrade.taobao.com', 'cart.taobao.com', 'item-paimai.taobao.com',
    'i.taobao.com', 'rate.taobao.com', 'refund2.taobao.com', 'rights.taobao.com', 'jubao.taobao.com'])
  if (!hosts.has(location.hostname) || window.top !== window) return

  const rootAttributes = ['data-hd-pm-shopping-theme', 'data-hd-pm-shopping-site', 'data-hd-pm-shopping-page']
  const prefix = 'data-hd-pm-account-'
  const sides = ['top', 'right', 'bottom', 'left']
  const ownedAttributes = ['bg', 'fg', ...sides.map(side => `border-${side}`)].map(name => prefix + name)
  const skippedTags = new Set(['IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'IFRAME',
    'OBJECT', 'EMBED', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE'])
  const protectedName = /(?:qrcode|qr-code|captcha|barcode|verify-code|verification-code)|(?:^|[\s_-])qr(?:$|[\s_-])/i
  const tagged = new Set()
  let active = false
  let body = null
  let observedRoot = null
  let frame = null
  let queue = []
  let queueIndex = 0
  let queued = new WeakMap()
  let cursor = null
  let styles = new WeakMap()

  function color(value) {
    const match = /^rgba?\(([^)]+)\)$/i.exec(value || '')
    if (!match) return null
    const parts = match[1].trim().split(/[\s,\/]+/)
    if (parts.length < 3 || parts.length > 4) return null
    const rgb = parts.slice(0, 3).map(part => parseFloat(part) * (part.endsWith('%') ? 2.55 : 1))
    const alpha = parts[3] === undefined ? 1 : parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1)
    return [...rgb, alpha].every(Number.isFinite) ? [...rgb, alpha] : null
  }
  const lightness = rgb => (rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722) / 255
  const neutral = rgb => rgb && Math.max(...rgb.slice(0, 3)) - Math.min(...rgb.slice(0, 3)) <= 32
  function styleFor(node) {
    if (!styles.has(node)) styles.set(node, window.getComputedStyle(node))
    return styles.get(node)
  }
  function clear(node) {
    for (const name of ownedAttributes) if (node.hasAttribute(name)) node.removeAttribute(name)
    tagged.delete(node)
    styles.delete(node)
  }
  function mark(node, name, value) {
    node.setAttribute(prefix + name, value)
    tagged.add(node)
  }
  function foregroundFor(node) {
    // A darkened parent can change inherited text on a bright child. Read the
    // original inherited foreground without changing any site-owned property.
    const rendered = color(window.getComputedStyle(node).color)
    const parents = []
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const value = parent.getAttribute(prefix + 'fg')
      if (value) { parents.push([parent, value]); parent.removeAttribute(prefix + 'fg') }
    }
    const foreground = color(window.getComputedStyle(node).color)
    for (const [parent, value] of parents) parent.setAttribute(prefix + 'fg', value)
    return { foreground, inheritedOverride: parents.length > 0 && rendered && foreground
      && rendered.some((channel, index) => channel !== foreground[index]) }
  }
  function isProtected(node) {
    for (let parent = node; parent; parent = parent.parentElement) {
      if (skippedTags.has(parent.tagName)) return true
      if (protectedName.test(`${parent.getAttribute('class') || ''} ${parent.getAttribute('id') || ''}`)
          || parent.getAttribute('role') === 'img') return true
      if (/url\s*\(/i.test(styleFor(parent).backgroundImage || '')) return true
      if (parent === body) break
    }
    return false
  }
  function darkBackground(node, ownBackground) {
    let opacity = 0
    const result = [0, 0, 0]
    let depth = 0
    for (let parent = node; parent && depth < 64; parent = parent.parentElement, depth++) {
      const computed = styleFor(parent)
      // A gradient may contain a bright brand surface; do not infer contrast.
      if (computed.backgroundImage && computed.backgroundImage !== 'none') return false
      const mapped = parent.getAttribute(prefix + 'bg')
      const background = parent === node && ownBackground ? ownBackground
        : mapped ? (mapped === 'raised' ? [37, 43, 51, 1] : [29, 33, 39, 1]) : color(computed.backgroundColor)
      if (!background) return false
      const contribution = background[3] * (1 - opacity)
      for (let channel = 0; channel < 3; channel++) result[channel] += background[channel] * contribution
      opacity += contribution
      if (opacity >= .98) return lightness(result) < .38
    }
    return false
  }
  function inspect(node) {
    clear(node)
    if (!body.contains(node)) return false
    // Walk protected descendants too, so adding a QR class or image background
    // to an already adapted parent removes any old child markers.
    if (isProtected(node)) return false
    const computed = styleFor(node)
    const background = color(computed.backgroundColor)
    let adaptedBackground = null
    if ((!computed.backgroundImage || computed.backgroundImage === 'none')
        && neutral(background) && background[3] >= .85 && lightness(background) > .72) {
      const raised = lightness(background) < .94
      mark(node, 'bg', raised ? 'raised' : 'surface')
      adaptedBackground = raised ? [37, 43, 51, 1] : [29, 33, 39, 1]
    }
    const dark = darkBackground(node, adaptedBackground)
    const { foreground, inheritedOverride } = foregroundFor(node)
    if (dark && neutral(foreground) && foreground[3] >= .5 && lightness(foreground) < .6) {
      mark(node, 'fg', lightness(foreground) > .3 || foreground[3] < .8 ? 'muted' : 'text')
    } else if (!dark && inheritedOverride && neutral(foreground) && foreground[3] >= .8
        && lightness(foreground) < .3 && background && background[3] >= .85 && lightness(background) > .6) {
      // Preserve black inherited labels on yellow/other bright branded buttons.
      mark(node, 'fg', 'ink')
    }
    if (dark) {
      for (const side of sides) {
        const name = `border${side[0].toUpperCase()}${side.slice(1)}Color`
        const border = color(computed[name])
        if (neutral(border) && border[3] >= .5 && lightness(border) > .48) mark(node, `border-${side}`, 'neutral')
      }
    }
    return false
  }
  function enqueue(node, deep = true) {
    if (!active || node?.nodeType !== 1) return
    if (queued.has(node)) { if (deep) queued.get(node).deep = true; return }
    const job = { root: node, node, deep }
    queued.set(node, job)
    queue.push(job)
    schedule()
  }
  function schedule() {
    if (active && frame === null) frame = window.requestAnimationFrame(batch)
  }
  function nextNode(node, boundary, skipChildren) {
    if (!skipChildren && node.firstElementChild) return node.firstElementChild
    for (let current = node; current && current !== boundary; current = current.parentElement) {
      if (current.nextElementSibling) return current.nextElementSibling
    }
    return null
  }
  function batch() {
    frame = null
    if (!active) return
    styles = new WeakMap()
    let processed = 0
    while (processed < 80) {
      if (!cursor) {
        cursor = queue[queueIndex++]
        if (!cursor) break
        queued.delete(cursor.root)
      }
      const node = cursor.node
      const skipChildren = inspect(node)
      processed++
      cursor.node = cursor.deep ? nextNode(node, cursor.root, skipChildren) : null
      if (!cursor.node) cursor = null
    }
    if (queueIndex >= queue.length) { queue = []; queueIndex = 0 }
    if (cursor || queue.length) schedule()
  }
  const contentObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') enqueue(record.target)
      else {
        for (const node of record.addedNodes) enqueue(node)
        // Detached nodes get their owned markers removed in the same bounded walk.
        for (const node of record.removedNodes) enqueue(node)
        // Container-only CSS such as :empty can change; avoid rescanning siblings.
        enqueue(record.target, false)
      }
    }
  })
  function stop() {
    active = false
    contentObserver.disconnect()
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    queue = []
    queueIndex = 0
    cursor = null
    queued = new WeakMap()
    for (const node of tagged) clear(node)
    styles = new WeakMap()
    body = null
  }
  function refresh() {
    const root = document.documentElement
    if (root !== observedRoot) {
      rootObserver.disconnect()
      observedRoot = root
      rootObserver.observe(root || document, root
        ? { childList: true, attributes: true, attributeFilter: rootAttributes }
        : { childList: true })
    }
    const enabled = root?.getAttribute(rootAttributes[0]) === 'dark'
      && root.getAttribute(rootAttributes[1]) === 'taobao'
      && root.getAttribute(rootAttributes[2]) === 'taobao-account'
      && document.body
    if (!enabled) { if (active) stop(); return }
    if (active && body === document.body) return
    if (active) stop()
    body = document.body
    active = true
    contentObserver.observe(body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'id', 'role'] })
    enqueue(body)
  }
  const rootObserver = new MutationObserver(refresh)
  document.addEventListener('DOMContentLoaded', refresh, { once: true })
  window.addEventListener('pageshow', refresh)
  refresh()
})()
