import { t, translateError } from './i18n.js'

export const $ = (id) => document.getElementById(id)

export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload })
  if (!res?.ok) {
    const err = new Error(res?.error ?? t('操作失败，请重试'))
    Object.assign(err, { badPassword: res?.badPassword, code: res?.code ?? (!res ? 'worker_unavailable' : undefined), status: res?.status })
    throw err
  }
  return res.data
}

export function setMsg(el, text = '', kind = '') {
  el.textContent = text
  el.className = `msg ${kind}`
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status')
}

export function setDisabled(button, disabled) {
  button.dataset.disabled = String(Boolean(disabled))
  button.disabled = Boolean(disabled) || button.getAttribute('aria-busy') === 'true'
}

export async function run(button, message, action, peers = []) {
  if (button.disabled) return
  const group = [...new Set([button, ...peers])]
  for (const el of group) { el.disabled = true; el.setAttribute('aria-busy', 'true') }
  try { await action() }
  catch (err) { setMsg(message, translateError(err), 'bad') }
  finally {
    for (const el of group) { el.removeAttribute('aria-busy'); el.disabled = el.dataset.disabled === 'true' }
  }
}

export function clearPasswords() {
  for (const input of document.querySelectorAll('input[type="password"], input[data-secret]')) {
    input.value = ''
    input.type = 'password'
  }
}
