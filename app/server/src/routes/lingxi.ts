import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { requireAuth } from '../middleware/auth.js'
import { deleteLingxiSettings, getLingxiSettings, lingxiData, lingxiObject, lingxiRequest, normalizeLingxiEvent, normalizeLingxiTask, saveLingxiSettings } from '../lib/lingxi.js'
import { LingxiError } from '../lib/lingxi-transport.js'
import { createLingxiWebSocketTicket } from '../lib/lingxi-ws.js'
import { getLingxiVaultSettings, readLingxiVaultGrant } from '../lib/lingxi-vault.js'

export const lingxiRoutes = new Hono<AppEnv>()
lingxiRoutes.use('/lingxi/*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff'); await next() })
lingxiRoutes.onError((error, c) => error instanceof LingxiError ? c.json({ error: error.code, message: error.message }, error.status) : c.json({ error: 'lingxi_internal_error', message: '灵犀联动暂时不可用，请稍后重试' }, 500))
lingxiRoutes.use('/lingxi/*', requireAuth)

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const limit = 64 * 1024
  if (Number(request.headers.get('content-length')) > limit) throw new LingxiError('请求内容超过 64 KB 限制', 413)
  const reader = request.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) { void reader.cancel().catch(() => {}); throw new LingxiError('请求内容超过 64 KB 限制', 413) }
      chunks.push(next.value)
    }
    return lingxiObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))))
  } catch (error) { if (error instanceof LingxiError) throw error; throw new LingxiError('请发送有效的 JSON 请求') }
  finally { reader.releaseLock() }
}
function id(value: string): string {
  if (!/^[1-9]\d{0,14}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new LingxiError('灵犀内容 ID 无效')
  return value
}
function timestamp(value: unknown, name: string, nullable = false): string | null {
  if (nullable && (value === null || value === '')) return null
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new LingxiError(`${name}必须是包含时区的日期时间`)
  return value
}
function text(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new LingxiError(`${name}格式无效或超过 ${max} 字符`)
  return value
}
function pageQuery(query: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = { limit: '200' }
  for (const field of ['limit', 'offset']) if (query[field] !== undefined) {
    const raw = query[field]!, value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < (field === 'limit' ? 1 : 0) || value > (field === 'limit' ? 200 : 1_000_000)) throw new LingxiError('分页参数无效')
    result[field] = raw
  }
  return result
}
function collection(data: unknown): unknown[] {
  if (!Array.isArray(data)) throw new LingxiError('灵犀返回了无效的列表', 502)
  return data
}
function vaultReadGrant(userId: number) {
  const grant = getLingxiVaultSettings(userId)
  if (!grant.enabled || !getLingxiSettings(userId).configured) throw new LingxiError('密码读取授权未开启', 403, 'lingxi_vault_disabled')
  if (grant.status !== 'ready' || grant.stale) throw new LingxiError('请在密码插件中授权并同步最新密码副本', 409, 'lingxi_vault_not_ready')
  const stored = readLingxiVaultGrant(userId)
  if (!stored?.service_token_hash || !/^[a-f0-9]{64}$/.test(stored.service_token_hash) || !stored.service_token_expires_at || stored.service_token_expires_at <= Date.now()) {
    throw new LingxiError('密码读取服务尚未连接，请在插件中同步授权副本后重试', 409, 'lingxi_vault_service_not_ready')
  }
  return { fingerprint: `${grant.grant_id}:${grant.snapshot_version}:${grant.source_version}:${stored.service_token_hash}:${stored.service_token_expires_at}`, vaultGrantHash: stored.service_token_hash }
}
function vaultItem(value: unknown, reveal: boolean): Record<string, unknown> {
  const item = lingxiObject(value)
  const strings = reveal ? ['id', 'title', 'site', 'username', 'password'] : ['id', 'title', 'site', 'username_masked']
  if (strings.some(key => typeof item[key] !== 'string') || !item.id || (!reveal && typeof item.password_set !== 'boolean')) throw new LingxiError('灵犀返回了无效的密码条目', 502)
  return Object.fromEntries([...strings, ...(!reveal ? ['password_set'] : [])].map(key => [key, item[key]]))
}
function taskBody(body: Record<string, unknown>, create: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (create || body.title !== undefined) result.title = text(body.title, '待办标题', 255, true)
  for (const field of ['notes', 'project']) if (body[field] !== undefined) result[field] = text(body[field], field === 'notes' ? '备注' : '项目', field === 'notes' ? 20_000 : 64)
  if (body.due !== undefined || body.due_at !== undefined) result.due_at = timestamp(Object.hasOwn(body, 'due') ? body.due : body.due_at, '截止时间', true)
  if (body.priority !== undefined) { if (![1, 2, 3].includes(Number(body.priority)) || typeof body.priority !== 'number') throw new LingxiError('优先级必须为 1–3'); result.priority = body.priority }
  if (body.status !== undefined) { if (typeof body.status !== 'string' || !['open', 'done', 'cancelled'].includes(body.status)) throw new LingxiError('待办状态无效'); result.status = body.status }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 20) throw new LingxiError('标签格式无效')
    result.tags = body.tags.map(value => text(value, '标签', 64, true))
  }
  if (!Object.keys(result).length) throw new LingxiError('请提供需要更新的待办内容')
  return result
}
function eventBody(body: Record<string, unknown>, create: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (create || body.title !== undefined) result.title = text(body.title, '日程标题', 255, true)
  for (const field of ['description', 'location']) if (body[field] !== undefined) result[field] = text(body[field], field === 'description' ? '日程说明' : '地点', field === 'description' ? 20_000 : 255)
  if (create || body.start !== undefined || body.start_at !== undefined) result.start_at = timestamp(body.start ?? body.start_at, '开始时间')
  if (body.end !== undefined || body.end_at !== undefined) result.end_at = timestamp(Object.hasOwn(body, 'end') ? body.end : body.end_at, '结束时间', true)
  if (typeof result.start_at === 'string' && typeof result.end_at === 'string' && Date.parse(result.end_at) <= Date.parse(result.start_at)) throw new LingxiError('结束时间必须晚于开始时间')
  if (body.all_day !== undefined) { if (typeof body.all_day !== 'boolean') throw new LingxiError('全天日程参数无效'); result.all_day = body.all_day }
  if (body.rrule !== undefined) result.rrule = body.rrule === null ? '' : text(body.rrule, '重复规则', 255)
  if (body.reminder_minutes !== undefined) {
    if (body.reminder_minutes !== null && (!Number.isSafeInteger(body.reminder_minutes) || Number(body.reminder_minutes) < 0 || Number(body.reminder_minutes) > 525600)) throw new LingxiError('提醒时间无效')
    result.reminder_minutes = body.reminder_minutes
  }
  if (!Object.keys(result).length) throw new LingxiError('请提供需要更新的日程内容')
  return result
}

lingxiRoutes.get('/lingxi/settings', c => c.json(getLingxiSettings(c.get('user').id)))
lingxiRoutes.post('/lingxi/ws-ticket', c => c.json(createLingxiWebSocketTicket(c.get('user').id, c.get('sessionId'))))
lingxiRoutes.put('/lingxi/settings', async c => c.json(await saveLingxiSettings(c.get('user').id, await readBody(c.req.raw), c.req.raw.signal, c.get('sessionId'))))
lingxiRoutes.delete('/lingxi/settings', c => { deleteLingxiSettings(c.get('user').id); return c.json({ ok: true }) })
lingxiRoutes.get('/lingxi/me', async c => {
  const { data } = await lingxiData(await lingxiRequest(c.get('user').id, { path: '/me', signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  const user = lingxiObject(data)
  return c.json({ user, capabilities: user.capabilities ?? [] })
})
lingxiRoutes.get('/lingxi/vault/items', async c => {
  const userId = c.get('user').id, grant = vaultReadGrant(userId), query = c.req.query(), params = pageQuery(query)
  if (query.q !== undefined) params.q = text(query.q, '搜索词', 200)
  const { data, pagination } = await lingxiData(await lingxiRequest(userId, { path: '/integrations/navigation-vault/items', query: params, vaultGrantHash: grant.vaultGrantHash, signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  if (vaultReadGrant(userId).fingerprint !== grant.fingerprint) throw new LingxiError('密码授权或副本已变化，请重新加载', 409, 'lingxi_vault_changed')
  return c.json({ items: collection(data).map(item => vaultItem(item, false)), ...(pagination ? { pagination } : {}) })
})
lingxiRoutes.post('/lingxi/vault/reveal', async c => {
  const body = await readBody(c.req.raw), userId = c.get('user').id, grant = vaultReadGrant(userId)
  const itemId = text(body.id, '密码条目 ID', 200, true)
  const { data } = await lingxiData(await lingxiRequest(userId, { path: '/integrations/navigation-vault/reveal', method: 'POST', body: { id: itemId }, vaultGrantHash: grant.vaultGrantHash, signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  if (vaultReadGrant(userId).fingerprint !== grant.fingerprint) throw new LingxiError('密码授权或副本已变化，请重新加载', 409, 'lingxi_vault_changed')
  const item = vaultItem(data, true)
  if (item.id !== itemId) throw new LingxiError('灵犀返回的密码条目不匹配', 502)
  return c.json({ item })
})
lingxiRoutes.get('/lingxi/calendar', async c => {
  const query = c.req.query(), start = timestamp(query.start, '开始时间')!, end = timestamp(query.end, '结束时间')!
  if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 93 * 86400_000) throw new LingxiError('日历查询范围须大于 0 且不超过 93 天')
  const { data, pagination } = await lingxiData(await lingxiRequest(c.get('user').id, { path: '/events/occurrences', query: { start, end }, signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ events: collection(data).map(normalizeLingxiEvent), timezone: getLingxiSettings(c.get('user').id).user?.timezone ?? 'UTC', ...(pagination ? { pagination } : {}) })
})
lingxiRoutes.post('/lingxi/calendar', async c => {
  const { data } = await lingxiData(await lingxiRequest(c.get('user').id, { path: '/events', method: 'POST', body: eventBody(await readBody(c.req.raw), true), signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ event: normalizeLingxiEvent(data) }, 201)
})
lingxiRoutes.get('/lingxi/calendar/:id', async c => {
  const { data } = await lingxiData(await lingxiRequest(c.get('user').id, { path: `/events/${id(c.req.param('id'))}`, signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ event: normalizeLingxiEvent(data) })
})
lingxiRoutes.patch('/lingxi/calendar/:id', async c => {
  const { data } = await lingxiData(await lingxiRequest(c.get('user').id, { path: `/events/${id(c.req.param('id'))}`, method: 'PATCH', body: eventBody(await readBody(c.req.raw), false), signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ event: normalizeLingxiEvent(data) })
})
lingxiRoutes.delete('/lingxi/calendar/:id', async c => {
  await lingxiRequest(c.get('user').id, { path: `/events/${id(c.req.param('id'))}`, method: 'DELETE', signal: c.req.raw.signal, sessionId: c.get('sessionId') })
  return c.json({ ok: true })
})
lingxiRoutes.get('/lingxi/tasks', async c => {
  const query = c.req.query(), params = pageQuery(query)
  if (query.status !== undefined && query.status !== 'all') { if (!['open', 'done', 'cancelled'].includes(query.status)) throw new LingxiError('待办状态无效'); params.status = query.status }
  if (query.q !== undefined) params.q = text(query.q, '搜索词', 200)
  for (const field of ['due_after', 'due_before']) if (query[field] !== undefined) params[field] = timestamp(query[field], '截止时间')!
  const { data, pagination } = await lingxiData(await lingxiRequest(c.get('user').id, { path: '/tasks', query: params, signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ tasks: collection(data).map(normalizeLingxiTask), timezone: getLingxiSettings(c.get('user').id).user?.timezone ?? 'UTC', ...(pagination ? { pagination } : {}) })
})
lingxiRoutes.post('/lingxi/tasks', async c => {
  const { data } = await lingxiData(await lingxiRequest(c.get('user').id, { path: '/tasks', method: 'POST', body: taskBody(await readBody(c.req.raw), true), signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ task: normalizeLingxiTask(data) }, 201)
})
lingxiRoutes.patch('/lingxi/tasks/:id', async c => {
  const { data } = await lingxiData(await lingxiRequest(c.get('user').id, { path: `/tasks/${id(c.req.param('id'))}`, method: 'PATCH', body: taskBody(await readBody(c.req.raw), false), signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ task: normalizeLingxiTask(data) })
})
lingxiRoutes.delete('/lingxi/tasks/:id', async c => {
  await lingxiRequest(c.get('user').id, { path: `/tasks/${id(c.req.param('id'))}`, method: 'DELETE', signal: c.req.raw.signal, sessionId: c.get('sessionId') }); return c.json({ ok: true })
})
lingxiRoutes.get('/lingxi/sessions', async c => {
  const { data, pagination } = await lingxiData(await lingxiRequest(c.get('user').id, { path: '/conversations', query: pageQuery(c.req.query()), signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ sessions: collection(data), ...(pagination ? { pagination } : {}) })
})
lingxiRoutes.post('/lingxi/sessions', async c => {
  const body = await readBody(c.req.raw), title = body.title === undefined ? '新对话' : text(body.title, '会话标题', 200, true)
  const { data } = await lingxiData(await lingxiRequest(c.get('user').id, { path: '/conversations', method: 'POST', body: { title }, signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ session: data }, 201)
})
lingxiRoutes.patch('/lingxi/sessions/:id', async c => {
  const body = await readBody(c.req.raw)
  const { data } = await lingxiData(await lingxiRequest(c.get('user').id, { path: `/conversations/${id(c.req.param('id'))}`, method: 'PATCH', body: { title: text(body.title, '会话标题', 200, true) }, signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ session: data })
})
lingxiRoutes.delete('/lingxi/sessions/:id', async c => {
  await lingxiRequest(c.get('user').id, { path: `/conversations/${id(c.req.param('id'))}`, method: 'DELETE', signal: c.req.raw.signal, sessionId: c.get('sessionId') }); return c.json({ ok: true })
})
lingxiRoutes.get('/lingxi/sessions/:id/messages', async c => {
  const { data, pagination } = await lingxiData(await lingxiRequest(c.get('user').id, { path: `/conversations/${id(c.req.param('id'))}/messages`, query: pageQuery(c.req.query()), signal: c.req.raw.signal, sessionId: c.get('sessionId') }))
  return c.json({ messages: collection(data), ...(pagination ? { pagination } : {}) })
})
lingxiRoutes.post('/lingxi/sessions/:id/messages', async c => {
  const body = await readBody(c.req.raw), message = text(body.message, '消息', 32_000, true)
  const requestId = body.request_id === undefined ? undefined : text(body.request_id, '请求编号', 100, true)
  return lingxiRequest(c.get('user').id, { path: `/conversations/${id(c.req.param('id'))}/messages`, method: 'POST', body: { message, stream: true, ...(requestId ? { request_id: requestId } : {}) }, stream: true, signal: c.req.raw.signal, sessionId: c.get('sessionId') })
})
