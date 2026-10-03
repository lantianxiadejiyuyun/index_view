import { sql } from './db.js'
import { openLingxiSecret, sealLingxiSecret } from './lingxi-secrets.js'
import { LingxiError, normalizeLingxiBaseUrl, requestLingxi, type LingxiRequest } from './lingxi-transport.js'
import { revokeLingxiVault } from './lingxi-vault.js'

type LingxiUser = { id: number; username: string; display_name: string; timezone: string }
type BindingRow = { user_id: number; base_url: string; api_token_encrypted: string; user_json: string; updated_at: number }
export type LingxiBinding = { base_url: string; api_token: string; user: LingxiUser; updated_at: number }
const settingsPending = new Set<number>()
const settingsCancelled = new Set<number>()
const requestsPending = new Map<number, number>()
const requestControllers = new Map<number, Set<AbortController>>()
function cancelLingxiRequests(userId: number): void {
  for (const controller of requestControllers.get(userId) ?? []) controller.abort()
}

export function lingxiObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LingxiError('灵犀请求必须为 JSON 对象')
  return value as Record<string, unknown>
}
function readBinding(userId: number): BindingRow | undefined {
  return sql.get<BindingRow>('SELECT * FROM lingxi_bindings WHERE user_id = ?', userId)
}
function sessionActive(userId: number, sessionId?: string): boolean {
  return !sessionId || Boolean(sql.get('SELECT id FROM auth_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?', sessionId, userId, Date.now()))
}
function userFrom(value: unknown): LingxiUser {
  const user = lingxiObject(value)
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0 || typeof user.username !== 'string' || !user.username || user.username.length > 200) throw new LingxiError('灵犀未返回有效的账号信息', 502)
  return { id: Number(user.id), username: user.username, display_name: typeof user.display_name === 'string' ? user.display_name.slice(0, 200) : user.username,
    timezone: typeof user.timezone === 'string' ? user.timezone.slice(0, 100) : 'UTC' }
}
export function getLingxiSettings(userId: number) {
  const row = readBinding(userId)
  return { configured: Boolean(row), base_url: row?.base_url ?? '', has_token: Boolean(row?.api_token_encrypted),
    user: row ? userFrom(JSON.parse(row.user_json)) : null, updated_at: row?.updated_at ?? null }
}
/** Internal only: never return this object from an HTTP route, export, bootstrap, or log. */
export function getLingxiBinding(userId: number): LingxiBinding {
  const row = readBinding(userId)
  if (!row) throw new LingxiError('请先在设置中绑定灵犀账号', 409, 'lingxi_not_configured')
  let token: string
  try { token = openLingxiSecret(userId, 'api-token', row.api_token_encrypted) }
  catch { throw new LingxiError('保存的灵犀 Token 无法解密，请重新绑定', 503) }
  return { base_url: row.base_url, api_token: token, user: userFrom(JSON.parse(row.user_json)), updated_at: row.updated_at }
}
export async function lingxiData(response: Response): Promise<{ data: unknown; pagination?: unknown }> {
  const value = lingxiObject(await response.json())
  if (value.ok !== true || !Object.hasOwn(value, 'data')) throw new LingxiError('灵犀返回了不兼容的接口数据', 502)
  return { data: value.data, ...(value.pagination ? { pagination: value.pagination } : {}) }
}
export async function saveLingxiSettings(userId: number, input: unknown, signal?: AbortSignal, sessionId?: string) {
  if (settingsPending.has(userId)) throw new LingxiError('正在验证灵犀连接，请等待完成', 409)
  const body = lingxiObject(input), previous = readBinding(userId)
  const baseUrl = normalizeLingxiBaseUrl(body.base_url ?? previous?.base_url)
  let token = typeof body.api_token === 'string' ? body.api_token.trim() : ''
  if (body.api_token !== undefined && (typeof body.api_token !== 'string' || body.api_token.length > 4096)) throw new LingxiError('灵犀 API Token 格式无效')
  if (!token) {
    if (!previous || previous.base_url !== baseUrl) throw new LingxiError('首次绑定或更换灵犀地址时，请填写 API Token')
    token = getLingxiBinding(userId).api_token
  }
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new LingxiError('灵犀 API Token 格式无效')
  settingsPending.add(userId)
  settingsCancelled.delete(userId)
  try {
    const { data } = await lingxiData(await requestLingxi(baseUrl, token, { path: '/me', signal }))
    if (signal?.aborted || !sessionActive(userId, sessionId)) throw new LingxiError('当前登录已变更，请重新加载后绑定', 403, 'lingxi_authorization_changed')
    const user = userFrom(data), current = readBinding(userId)
    if (settingsCancelled.has(userId) || current?.api_token_encrypted !== previous?.api_token_encrypted || current?.updated_at !== previous?.updated_at) throw new LingxiError('绑定已在其他页面更改，请刷新后重试', 409)
    const now = Math.max(Date.now(), (previous?.updated_at ?? 0) + 1)
    sql.tx(() => {
      if (previous && (previous.base_url !== baseUrl || userFrom(JSON.parse(previous.user_json)).id !== user.id)) revokeLingxiVault(userId, 'binding_changed')
      sql.run(`INSERT INTO lingxi_bindings (user_id, base_url, api_token_encrypted, user_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET base_url=excluded.base_url, api_token_encrypted=excluded.api_token_encrypted, user_json=excluded.user_json, updated_at=excluded.updated_at`,
      userId, baseUrl, sealLingxiSecret(userId, 'api-token', token), JSON.stringify(user), now)
    })
    cancelLingxiRequests(userId)
    return getLingxiSettings(userId)
  } finally { settingsPending.delete(userId); settingsCancelled.delete(userId) }
}
export function deleteLingxiSettings(userId: number): void {
  sql.tx(() => { revokeLingxiVault(userId, 'binding_removed'); sql.run('DELETE FROM lingxi_bindings WHERE user_id = ?', userId) })
  if (settingsPending.has(userId)) settingsCancelled.add(userId)
  cancelLingxiRequests(userId)
}
export async function lingxiRequest(userId: number, input: LingxiRequest & { sessionId?: string }): Promise<Response> {
  const count = requestsPending.get(userId) ?? 0
  if (count >= 8 || [...requestsPending.values()].reduce((a, b) => a + b, 0) >= 64) throw new LingxiError('灵犀请求过多，请稍后重试', 429)
  const binding = getLingxiBinding(userId)
  requestsPending.set(userId, count + 1)
  const controller = new AbortController(), controllers = requestControllers.get(userId) ?? new Set<AbortController>()
  controllers.add(controller); requestControllers.set(userId, controllers)
  const stillAuthorized = () => readBinding(userId)?.updated_at === binding.updated_at && sessionActive(userId, input.sessionId)
  const authorize = () => { if (!stillAuthorized()) { controller.abort(); throw new LingxiError('灵犀绑定或当前登录已变更，请重新加载', 403, 'lingxi_authorization_changed') } }
  let released = false
  const sweep = setInterval(() => { if (!stillAuthorized()) controller.abort() }, 2000); sweep.unref()
  const release = () => {
    if (released) return
    released = true; clearInterval(sweep); controllers.delete(controller); if (!controllers.size) requestControllers.delete(userId)
    const remaining = (requestsPending.get(userId) ?? 1) - 1; if (remaining) requestsPending.set(userId, remaining); else requestsPending.delete(userId)
  }
  try {
    authorize()
    const response = await requestLingxi(binding.base_url, binding.api_token, { ...input, signal: AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]) })
    authorize()
    if (!input.stream || !response.body) { release(); return response }
    const reader = response.body.getReader()
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { authorize(); const next = await reader.read(); authorize(); if (next.done) { release(); controller.close() } else controller.enqueue(next.value) }
        catch (error) { release(); void reader.cancel().catch(() => {}); controller.error(error) }
      },
      async cancel() { controller.abort(); release(); await reader.cancel() },
    }), { status: response.status, headers: response.headers })
  } catch (error) { release(); throw error }
}
export function normalizeLingxiEvent(input: unknown) {
  const value = lingxiObject(input)
  return { ...value, id: value.event_id ?? value.id, start: value.start_at, end: value.end_at ?? null }
}
export function normalizeLingxiTask(input: unknown) {
  const value = lingxiObject(input)
  return { ...value, due: value.due_at ?? null }
}
