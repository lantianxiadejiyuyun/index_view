import { api, apiResponse } from './api.ts'

export type LingxiUser = { id: string | number; username: string; display_name?: string; timezone?: string }
export type LingxiSettings = { configured: boolean; base_url: string; has_token: boolean; user: LingxiUser | null; updated_at: string | null }
export type LingxiEvent = { id: string; occurrence_id?: string; title: string; start: string; end: string | null; all_day: boolean; description: string; location: string; rrule?: string | null; reminder_minutes?: number | null }
export type LingxiTask = { id: string; title: string; notes: string; due: string | null; status: 'open' | 'done' | 'cancelled'; priority: 1 | 2 | 3 }
export type LingxiSession = { id: string; title: string; updated_at: string }
export type LingxiMessage = { id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; created_at: string }
export type LingxiEventInput = Omit<LingxiEvent, 'id'>
export type LingxiTaskInput = Omit<LingxiTask, 'id'>
export type LingxiStreamEvent = { event: string; data: Record<string, unknown> }
const path = (id: string) => encodeURIComponent(id)
const write = (method: string, value?: unknown): RequestInit => ({ method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })

async function paged<T extends { id: string }>(url: string, key: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = []
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ limit: '200', offset: String(page * 200) })
    const data = await api<Record<string, unknown>>(`${url}${url.includes('?') ? '&' : '?'}${params}`, {}, { signal })
    const values = data[key]
    if (!Array.isArray(values)) throw new Error('灵犀返回了无效列表')
    items.push(...values.map(value => ({ ...value, id: String(value.id) })) as T[])
    const pagination = data.pagination as { total?: number } | undefined
    if (!pagination || typeof pagination.total !== 'number' || items.length >= pagination.total || !values.length) return items
  }
  throw new Error('灵犀记录超过 10000 条，请在灵犀中整理后再读取')
}

export const lingxi = {
  settings: (signal?: AbortSignal) => api<LingxiSettings>('/api/lingxi/settings', {}, { signal }),
  saveSettings: (value: { base_url: string; api_token?: string }, signal?: AbortSignal) => api<LingxiSettings>('/api/lingxi/settings', write('PUT', value), { signal }),
  disconnect: (signal?: AbortSignal) => api<{ ok: boolean }>('/api/lingxi/settings', write('DELETE'), { signal }),
  me: (signal?: AbortSignal) => api<{ user: LingxiUser; capabilities: string[] }>('/api/lingxi/me', {}, { signal }),
  calendar: (start: string, end: string, signal?: AbortSignal) => api<{ events: LingxiEvent[]; timezone: string }>(`/api/lingxi/calendar?${new URLSearchParams({ start, end })}`, {}, { signal }),
  event: (id: string, signal?: AbortSignal) => api<{ event: LingxiEvent }>(`/api/lingxi/calendar/${path(id)}`, {}, { signal }),
  createEvent: (input: LingxiEventInput) => api<{ event: LingxiEvent }>('/api/lingxi/calendar', write('POST', input)),
  updateEvent: (id: string, input: LingxiEventInput) => api<{ event: LingxiEvent }>(`/api/lingxi/calendar/${path(id)}`, write('PATCH', input)),
  deleteEvent: (id: string) => api<{ ok: boolean }>(`/api/lingxi/calendar/${path(id)}`, write('DELETE')),
  tasks: async (signal?: AbortSignal) => ({ tasks: await paged<LingxiTask>('/api/lingxi/tasks?status=all', 'tasks', signal) }),
  createTask: (input: LingxiTaskInput) => api<{ task: LingxiTask }>('/api/lingxi/tasks', write('POST', input)),
  updateTask: (id: string, input: Partial<LingxiTaskInput>) => api<{ task: LingxiTask }>(`/api/lingxi/tasks/${path(id)}`, write('PATCH', input)),
  deleteTask: (id: string) => api<{ ok: boolean }>(`/api/lingxi/tasks/${path(id)}`, write('DELETE')),
  sessions: async (signal?: AbortSignal) => ({ sessions: await paged<LingxiSession>('/api/lingxi/sessions', 'sessions', signal) }),
  createSession: async (title: string, signal?: AbortSignal) => { const data = await api<{ session: LingxiSession }>('/api/lingxi/sessions', write('POST', { title }), { signal }); return { session: { ...data.session, id: String(data.session.id) } } },
  updateSession: (id: string, title: string) => api<{ session: LingxiSession }>(`/api/lingxi/sessions/${path(id)}`, write('PATCH', { title })),
  deleteSession: (id: string) => api<{ ok: boolean }>(`/api/lingxi/sessions/${path(id)}`, write('DELETE')),
  messages: async (id: string, signal?: AbortSignal) => ({ messages: await paged<LingxiMessage>(`/api/lingxi/sessions/${path(id)}/messages`, 'messages', signal) }),
}

/** Read SSE incrementally without putting either service's token into browser storage or URLs. */
export async function streamLingxiMessage(id: string, message: string, onEvent: (event: LingxiStreamEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await apiResponse(`/api/lingxi/sessions/${path(id)}/messages`, {
    ...write('POST', { message }), headers: { Accept: 'text/event-stream' }, signal,
  })
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('聊天服务未返回流式回复')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = '', completed = false
  const consume = (block: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!data.length) return
    const value = data.join('\n')
    if (value === '[DONE]') { completed = true; onEvent({ event: 'done', data: {} }); return }
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { throw new Error('聊天服务返回了无效消息') }
    const payload = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { content: String(parsed ?? '') }
    if (event === 'done') completed = true
    if (event === 'error') throw new Error(typeof payload.data === 'string' ? payload.data : typeof payload.message === 'string' ? payload.message : '灵犀暂时无法回复')
    onEvent({ event, data: payload })
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      pending = pending.replace(/\r\n/g, '\n')
      if (pending.length > 2_000_000) throw new Error('聊天服务返回的消息过长')
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        consume(pending.slice(0, boundary)); pending = pending.slice(boundary + 2)
      }
      if (done) break
    }
    if (pending.trim()) consume(pending)
    if (!completed) throw new Error('回复连接已中断，可重新读取会话查看已保存内容')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>()
export function zonedDateInput(value: string | Date, timezone: string, dateOnly = false): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (!Number.isFinite(date.getTime())) return ''
  let formatter = zonedFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    if (zonedFormatters.size >= 30) zonedFormatters.clear()
    zonedFormatters.set(timezone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  const day = `${parts.year}-${parts.month}-${parts.day}`
  return dateOnly ? day : `${day}T${parts.hour}:${parts.minute}`
}

/** Resolve a wall-clock input in the account's IANA zone, including DST offsets. */
export function zonedInputToISO(value: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请输入有效日期与时间')
  const target = Date.parse(`${value}:00Z`)
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 16) !== value) throw new Error('请输入有效日期与时间')
  let instant = target
  for (let i = 0; i < 4; i++) {
    const rendered = zonedDateInput(new Date(instant), timezone)
    const correction = target - Date.parse(`${rendered}:00Z`)
    if (!correction) return new Date(instant).toISOString()
    instant += correction
  }
  throw new Error('此时间因时区夏令时切换不存在，请选择其他时间')
}

/** Some zones advance at midnight. A calendar day starts at its first valid wall-clock minute. */
export function zonedDayStartToISO(day: string, timezone: string): string {
  const parsed = Date.parse(`${day}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day) throw new Error('请输入有效日期')
  for (let minute = 0; minute < 180; minute++) {
    try { return zonedInputToISO(`${day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, timezone) }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('夏令时')) throw error }
  }
  throw new Error('此日期因时区切换无法使用，请选择其他日期')
}

export function deadlineLabel(due: string, now = Date.now()): { label: string; overdue: boolean } {
  const time = Date.parse(due)
  if (!Number.isFinite(time)) return { label: '日期无效', overdue: false }
  const delta = time - now, minutes = Math.ceil(Math.abs(delta) / 60_000)
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60)
  const rest = minutes % 60
  const duration = days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${rest}分钟` : `${Math.max(1, rest)}分钟`
  return { label: delta < 0 ? `已逾期 ${duration}` : `剩余 ${duration}`, overdue: delta < 0 }
}
