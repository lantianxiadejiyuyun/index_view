import { t, initI18n, localize, onLanguageChange } from './i18n.js'

const INTRO_VERSION = 1
let initialized = false
let dialog
let previousFocus

export async function initIntro({ surface = 'popup' } = {}) {
  if (initialized) return
  initialized = true
  await initI18n()
  dialog = document.createElement('dialog')
  dialog.id = 'intro-dialog'
  dialog.className = `intro-dialog intro-${surface}`
  dialog.setAttribute('aria-labelledby', 'intro-title')
  dialog.setAttribute('aria-describedby', 'intro-description')
  dialog.innerHTML = `
    <div class="intro-content">
      <div class="intro-topline"><span class="eyebrow" data-i18n="认识你的密码库">认识你的密码库</span><button id="intro-close" class="icon-button" data-i18n-aria-label="关闭介绍" aria-label="关闭介绍">×</button></div>
      <div class="intro-art" aria-hidden="true"><span class="intro-orbit orbit-one"></span><span class="intro-orbit orbit-two"></span><img src="../icons/icon128.png" width="64" height="64" alt="" /><span class="intro-spark spark-one"></span><span class="intro-spark spark-two"></span></div>
      <h2 id="intro-title" data-i18n="把密码，留在你手里">把密码，留在你手里</h2>
      <p id="intro-description" data-i18n="从保存到填充，让每一次登录都更从容。">从保存到填充，让每一次登录都更从容。</p>
      <div class="intro-features">
        <div class="intro-feature"><span class="feature-number">01</span><div><h3 data-i18n="本机加密保存">本机加密保存</h3><p data-i18n="用一个主密码守护账号。默认仅在解锁时将密钥保留于内存；开启永久关闭自动上锁后，会在本机保存恢复密钥。">用一个主密码守护账号。默认仅在解锁时将密钥保留于内存；开启永久关闭自动上锁后，会在本机保存恢复密钥。</p></div></div>
        <div class="intro-feature"><span class="feature-number">02</span><div><h3 data-i18n="匹配网站，一键填充">匹配网站，一键填充</h3><p data-i18n="保存网站与账号，在登录表单旁选择要填入的账号。">保存网站与账号，在登录表单旁选择要填入的账号。</p></div></div>
        <div class="intro-feature"><span class="feature-number">03</span><div><h3 data-i18n="同步，由你决定">同步，由你决定</h3><p data-i18n="仅在本机使用，或连接自己的服务器同步密文。">仅在本机使用，或连接自己的服务器同步密文。</p></div></div>
      </div>
      <div class="intro-reminder" data-i18n="请牢记主密码：忘记后无法找回。建议定期导出密文备份。">请牢记主密码：忘记后无法找回。建议定期导出密文备份。</div>
      <button id="intro-start" class="primary full-width" data-i18n="开始使用">开始使用</button>
      <p class="intro-footnote" data-i18n="以后可以通过「使用介绍」再次查看。">以后可以通过「使用介绍」再次查看。</p>
      <p id="intro-error" class="msg bad" role="alert"></p>
    </div>`
  document.body.append(dialog)
  const markSeen = async () => {
    try { await chrome.storage.local.set({ introSeenVersion: INTRO_VERSION }) }
    catch { /* The introduction remains usable when preferences cannot be stored. */ }
  }
  const close = async () => { await markSeen(); dialog.close() }
  dialog.querySelector('#intro-close').addEventListener('click', () => void close())
  dialog.querySelector('#intro-start').addEventListener('click', () => void close())
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void close() })
  dialog.addEventListener('close', () => {
    if (previousFocus?.isConnected && !previousFocus.closest('.hidden')) previousFocus.focus()
  })
  const open = () => {
    if (dialog.open) return
    previousFocus = document.activeElement
    localize(dialog)
    dialog.showModal()
    dialog.querySelector('#intro-start').focus({ preventScroll: true })
    dialog.scrollTop = 0
  }
  for (const button of document.querySelectorAll('[data-intro-open]')) button.addEventListener('click', open)
  onLanguageChange(() => localize(dialog))
  localize(dialog)
  try {
    const state = await chrome.storage.local.get('introSeenVersion')
    if (state.introSeenVersion !== INTRO_VERSION) open()
  } catch {
    // A manual introduction is still available if initial preference reads fail.
    dialog.querySelector('#intro-error').textContent = t('无法读取介绍偏好，下次打开时可能会再次显示。')
  }
}
