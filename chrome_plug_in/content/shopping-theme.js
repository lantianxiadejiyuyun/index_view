/* Site-scoped, local appearance only. No page storage, network or vault access. */
(() => {
  const accountHosts = new Set([
    'i.taobao.com', 'cart.taobao.com', 'buyertrade.taobao.com', 'item-paimai.taobao.com',
    'rate.taobao.com', 'refund2.taobao.com', 'rights.taobao.com', 'jubao.taobao.com',
  ])
  const accountPage = accountHosts.has(location.hostname)
  const detailPage = location.hostname === 'item.taobao.com' || location.hostname === 'detail.tmall.com'
  const site = accountPage || detailPage || /^(?:(?:www|s)\.)?taobao\.com$/.test(location.hostname) ? 'taobao'
    : /^(www\.)?goofish\.com$/.test(location.hostname) ? 'goofish' : null
  if (!site || window.top !== window) return
  const attribute = 'data-hd-pm-shopping-theme'
  const siteAttribute = 'data-hd-pm-shopping-site'
  const pageAttribute = 'data-hd-pm-shopping-page'
  const page = accountPage ? 'taobao-account' : detailPage ? 'taobao-detail' : location.hostname === 's.taobao.com' ? 'taobao-search' : null
  const preference = `${site}Theme`
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let mode = 'off'
  let revision = 0
  const normalize = value => value?.[preference] === 'off' ? 'off' : 'system'
  function apply() {
    const root = document.documentElement
    if (!root) return
    if (root.getAttribute(siteAttribute) !== site) root.setAttribute(siteAttribute, site)
    if (page) {
      if (root.getAttribute(pageAttribute) !== page) root.setAttribute(pageAttribute, page)
    } else if (root.hasAttribute(pageAttribute)) root.removeAttribute(pageAttribute)
    if (mode === 'system' && media.matches) {
      if (root.getAttribute(attribute) !== 'dark') root.setAttribute(attribute, 'dark')
    } else if (root.hasAttribute(attribute)) root.removeAttribute(attribute)
  }
  media.addEventListener('change', apply)
  document.addEventListener('DOMContentLoaded', apply, { once: true })
  window.addEventListener('pageshow', apply)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, 'websiteAppearance')) return
    revision += 1
    mode = normalize(changes.websiteAppearance.newValue)
    apply()
  })
  const initialRevision = revision
  chrome.storage.local.get(['websiteAppearance']).then(data => {
    if (revision !== initialRevision) return
    mode = normalize(data.websiteAppearance)
    apply()
  }).catch(() => {
    // Respect a previously disabled feature if its preferences cannot be read.
    if (revision === initialRevision) { mode = 'off'; apply() }
  })
})()
