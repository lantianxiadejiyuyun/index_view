/* Local appearance only. This script never reads vault data or sends credentials. */
(() => {
  if (!/(^|\.)bilibili\.com$/.test(location.hostname) || window.top !== window) return
  const attribute = 'data-hd-pm-bilibili-theme'
  const tipsAttribute = 'data-hd-pm-hide-bilibili-tips'
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let mode = 'off'
  let hideTips = false
  let revision = 0
  const normalize = (value) => value?.bilibiliTheme === 'off' ? 'off' : 'system'
  function apply() {
    const root = document.documentElement
    if (!root) return
    const theme = mode === 'off' ? 'off' : media.matches ? 'dark' : 'light'
    if (root.getAttribute(attribute) !== theme) root.setAttribute(attribute, theme)
    if (hideTips) {
      if (root.getAttribute(tipsAttribute) !== 'true') root.setAttribute(tipsAttribute, 'true')
    } else if (root.hasAttribute(tipsAttribute)) root.removeAttribute(tipsAttribute)
  }
  media.addEventListener('change', apply)
  document.addEventListener('DOMContentLoaded', apply, { once: true })
  window.addEventListener('pageshow', apply)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, 'websiteAppearance')) return
    revision += 1
    mode = normalize(changes.websiteAppearance.newValue)
    hideTips = changes.websiteAppearance.newValue?.hideBilibiliAdblockTips !== false
    apply()
  })
  const initialRevision = revision
  chrome.storage.local.get(['websiteAppearance']).then((data) => {
    if (revision !== initialRevision) return
    mode = normalize(data.websiteAppearance)
    hideTips = data.websiteAppearance?.hideBilibiliAdblockTips !== false
    apply()
  }).catch(() => {
    // An unavailable preference store must not override a previously disabled feature.
    if (revision === initialRevision) { mode = 'off'; apply() }
  })
})()
