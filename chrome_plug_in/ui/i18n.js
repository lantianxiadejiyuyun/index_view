/** UI language selection. Safe to import in a service worker: no top-level DOM access. */
import { TRANSLATIONS } from './translations.js'

export const LANGUAGES = Object.freeze(['auto', 'zh-CN', 'zh-TW', 'en', 'ja'])
function browserLanguage() {
  try {
    return globalThis.chrome?.i18n?.getUILanguage?.() || globalThis.navigator?.language || 'en'
  } catch {
    return globalThis.navigator?.language || 'en'
  }
}

export function resolveLocale(value = 'auto', browserLocale = browserLanguage()) {
  const raw = String(value === 'auto' ? browserLocale : value || '').replaceAll('_', '-').toLowerCase()
  if (/^zh(?:-|$)/.test(raw)) {
    if (raw.includes('-hans')) return 'zh-CN'
    if (raw.includes('-hant') || /-(tw|hk|mo)(?:-|$)/.test(raw)) return 'zh-TW'
    return 'zh-CN'
  }
  if (/^ja(?:-|$)/.test(raw)) return 'ja'
  return 'en'
}

const validPreference = (value) => LANGUAGES.includes(value) ? value : 'auto'
let preference = 'auto'
let locale = resolveLocale()
let initialization = null
let revision = 0
let languageWrite = Promise.resolve()
const listeners = new Set()

export function getLanguagePreference() { return preference }
export function getLocale() { return locale }

export function tForLocale(language, source, params = {}) {
  const key = typeof source === 'string' ? source : String(source ?? '')
  const target = resolveLocale(language ?? 'en', 'en')
  const template = TRANSLATIONS[target]?.[key] ?? TRANSLATIONS.en[key] ?? key
  return template.replace(/\{([A-Za-z][A-Za-z\d_]*)\}/g, (placeholder, name) =>
    params != null && Object.hasOwn(params, name) ? String(params[name] ?? '') : placeholder)
}

export function t(source, params = {}) { return tForLocale(locale, source, params) }

const ERROR_SOURCES = Object.freeze({
  bad_password: '主密码不正确',
  locked: '保险库已锁定，请重新解锁',
  session_expired: '操作已取消，保险库已锁定',
  remote_password_required: '请输入服务器保险库的主密码，以恢复这台设备',
  conflict: '服务器已有不同版本，请选择下载服务器版本或确认覆盖上传',
  url_mismatch: '该账号的网址与当前页面不匹配，已取消填充',
  no_account: '请先绑定服务器账号',
  forbidden: '该页面无权执行此操作',
  unknown_message: '未知消息',
  invalid_remote_vault: '服务器保险库格式无效',
  invalid_response: '服务器响应格式无效',
  invalid_version: '本机同步版本无效',
  invalid_blob: '保险库密文无效或超过 1 MB',
  no_server: '还没填服务器地址',
  invalid_server: '服务器地址无效',
  unauthorized: '服务器登录已失效，请检查站点账号和密码',
  invalid_credentials: '站点账号或密码不正确',
})

/** Only exact application messages and known codes are translated; unknown text stays intact. */
export function translateError(error) {
  const message = typeof error === 'string' ? error : error?.message ?? ''
  if (Object.hasOwn(TRANSLATIONS['zh-CN'], message)) return t(message)
  const source = ERROR_SOURCES[error?.code] ?? (error?.badPassword ? ERROR_SOURCES.bad_password : null)
  if (source) return t(source)
  const status = /^服务器返回 (\d{3})$/.exec(message)
  if (status) return t('服务器返回 {status}', { status: status[1] })
  const rateLimit = /^尝试过于频繁，请 (\d+) 秒后再试$/.exec(message)
  if (rateLimit) return t('尝试过于频繁，请 {seconds} 秒后再试', { seconds: rateLimit[1] })
  const limit = /^密文超过 (\d+) KB，拒绝保存$/.exec(message)
  if (limit) return t('密文超过 {size} KB，拒绝保存', { size: limit[1] })
  const field = /^条目 (title|url|username|password|notes) 必须是有效文本$/.exec(message)
  if (field) {
    const names = { title: '标题', url: '网址', username: '用户名', password: '密码', notes: '备注' }
    return t('条目的{name}必须是有效文本', { name: t(names[field[1]]) })
  }
  return message || t('操作失败，请重试')
}

/** Only explicitly marked application-owned nodes are localized. */
export function localize(root = globalThis.document) {
  if (!root) return root
  const selector = '[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria-label]'
  const elements = [...(root.matches?.(selector) ? [root] : []), ...(root.querySelectorAll?.(selector) ?? [])]
  for (const element of elements) {
    if (element.hasAttribute('data-i18n')) {
      let source = element.getAttribute('data-i18n')
      if (!source) {
        source = element.textContent
        element.setAttribute('data-i18n', source)
      }
      element.textContent = t(source)
    }
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      const source = element.getAttribute('data-i18n-' + attribute)
      if (source !== null) element.setAttribute(attribute, t(source))
    }
  }
  const document = root.nodeType === 9 ? root : root.ownerDocument
  if (document?.documentElement) document.documentElement.lang = locale
  return root
}

function applyPreference(value) {
  const next = validPreference(value)
  const nextLocale = resolveLocale(next)
  if (next === preference && nextLocale === locale) return
  preference = next
  locale = nextLocale
  localize()
  for (const callback of [...listeners]) {
    try { Promise.resolve(callback({ preference, locale })).catch(() => {}) } catch { /* A view must not block other views. */ }
  }
}

export function onLanguageChange(callback) {
  if (typeof callback !== 'function') throw new TypeError('Language listener must be a function')
  listeners.add(callback)
  return () => listeners.delete(callback)
}

export function initI18n() {
  if (!initialization) {
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !Object.hasOwn(changes, 'language')) return
      revision += 1
      applyPreference(changes.language.newValue)
    })
    const startedAt = revision
    initialization = (async () => {
      let stored = {}
      try { stored = await globalThis.chrome?.storage?.local?.get('language') ?? {} } catch { /* Browser locale remains available offline. */ }
      if (startedAt === revision) applyPreference(stored.language)
      localize()
      return locale
    })()
  }
  return initialization
}

export async function setLanguage(value) {
  if (!LANGUAGES.includes(value)) throw new Error(t('不支持的界面语言'))
  await initI18n()
  const write = languageWrite.then(async () => {
    await globalThis.chrome?.storage?.local?.set({ language: value })
    applyPreference(value)
    return locale
  })
  languageWrite = write.catch(() => {})
  return write
}
