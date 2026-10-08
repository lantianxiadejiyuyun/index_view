/* Site-scoped, local appearance only. No page storage, network or vault access. */
(() => {
  const site = /^(www\.)?taobao\.com$/.test(location.hostname) ? 'taobao'
    : /^(www\.)?goofish\.com$/.test(location.hostname) ? 'goofish' : null
  if (!site || window.top !== window) return
  const attribute = 'data-hd-pm-shopping-theme'
  const siteAttribute = 'data-hd-pm-shopping-site'
  const preference = `${site}Theme`
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let mode = 'off'
  let revision = 0
  const normalize = value => value?.[preference] === 'off' ? 'off' : 'system'
  function apply() {
    const root = document.documentElement
    if (!root) return
    if (root.getAttribute(siteAttribute) !== site) root.setAttribute(siteAttribute, site)
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
