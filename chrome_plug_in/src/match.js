/** Match credentials to an exact host. Subdomain sharing must be explicit. */
export function hostOf(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw || /\s/.test(raw)) return ''
  const candidate = raw.startsWith('//') ? `https:${raw}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    return url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
}

export function normalizeItemUrl(input) {
  if (typeof input !== 'string') throw new Error('网址必须是文本')
  const raw = input.trim()
  if (!raw) return ''
  if (raw.startsWith('*.')) {
    const domain = raw.slice(2)
    const host = hostOf(domain)
    if (!host || host.includes(':') || !host.includes('.') || /[/*?#@:]/.test(domain)
      || /^\d+(\.\d+){3}$/.test(host)) throw new Error('通配网址请使用 *.example.com 格式')
    return `*.${host}`
  }
  if (raw.includes('*') || !hostOf(raw)) throw new Error('请输入有效的 http/https 网址或主机名')
  return raw
}

export function matches(item, url) {
  const host = hostOf(url)
  if (!host || typeof item?.url !== 'string') return false
  const pattern = item.url.trim()
  if (pattern.startsWith('*.')) {
    let normalized
    try { normalized = normalizeItemUrl(pattern) } catch { return false }
    const domain = normalized.slice(2)
    return host !== domain && host.endsWith(`.${domain}`)
  }
  return !pattern.includes('*') && hostOf(pattern) === host
}

export function matchItems(items, url) {
  const host = hostOf(url)
  return (Array.isArray(items) ? items : []).filter((item) => matches(item, url)).sort((a, b) => {
    const exact = Number(hostOf(b.url) === host) - Number(hostOf(a.url) === host)
    return exact || String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-Hans-CN')
  })
}

export function labelOf(item) {
  return String(item?.title ?? '').trim() || hostOf(item?.url) || '（未命名）'
}
