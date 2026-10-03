import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Circle, Clock3, ListTodo, MessageCircle, Pencil, Plus, RefreshCw, Send, Square, Trash2 } from 'lucide-react'
import { errorMessage } from '../../lib/api.ts'
import { deadlineLabel, lingxi, localDateKey, streamLingxiMessage, zonedDateInput, zonedDayStartToISO, type LingxiEvent, type LingxiMessage, type LingxiTask } from '../../lib/lingxi.ts'
import { useApp } from '../../store/app.ts'
import { LingxiEventEditor, LingxiTaskEditor } from './editors.tsx'
import { renderChatMarkdown } from './chat-markdown.ts'
import { formatLingxiDate, LingxiAccess, notifyLingxiChanged, useLingxiResource, useLingxiTimezone, WidgetError, WidgetFrame, WidgetHeaderActions, WidgetLoading, type LingxiWidgetProps } from './shared.tsx'

function IconButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) { return <button type="button" className="lingxi-icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button> }

function AssistantMessage({ content }: { content: string }) {
  const html = useMemo(() => renderChatMarkdown(content), [content])
  return <div className="lingxi-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

export function LingxiCalendarWidget(props: LingxiWidgetProps) { return <WidgetFrame {...props} title="灵犀日历" icon={<CalendarDays size={16} />}><LingxiAccess><CalendarContent /></LingxiAccess></WidgetFrame> }
export function LingxiScheduleWidget(props: LingxiWidgetProps) { return <WidgetFrame {...props} title="日程与待办" icon={<ListTodo size={16} />}><LingxiAccess><ScheduleContent /></LingxiAccess></WidgetFrame> }
export function LingxiDeadlineWidget(props: LingxiWidgetProps) { return <WidgetFrame {...props} title="Deadline" icon={<Clock3 size={16} />}><LingxiAccess><DeadlineContent /></LingxiAccess></WidgetFrame> }
export function LingxiChatWidget(props: LingxiWidgetProps) { return <WidgetFrame {...props} title="灵犀 AI" icon={<MessageCircle size={16} />}><LingxiAccess><ChatContent /></LingxiAccess></WidgetFrame> }

function eventDayRange(event: LingxiEvent, timezone: string): { start: string; end: string } {
  const start = zonedDateInput(event.start, timezone, true)
  const endDate = event.end ? new Date(event.end) : null
  // Calendar range ends are exclusive; a one-day event with no end still belongs to its start day.
  const end = endDate && Number.isFinite(endDate.getTime()) && endDate.getTime() > new Date(event.start).getTime()
    ? zonedDateInput(new Date(endDate.getTime() - 1), timezone, true)
    : start
  return { start, end }
}

function CalendarContent() {
  const timezone = useLingxiTimezone(), today = zonedDateInput(new Date(), timezone, true)
  const [month, setMonth] = useState(() => { const date = new Date(`${today}T00:00:00`); return new Date(date.getFullYear(), date.getMonth(), 1) })
  const [selected, setSelected] = useState(today)
  const [editor, setEditor] = useState<{ event?: LingxiEvent } | null>(null)
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const gridStart = new Date(first); gridStart.setDate(1 - ((first.getDay() + 6) % 7))
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridEnd.getDate() + 42)
  const startKey = zonedDayStartToISO(localDateKey(gridStart), timezone), endKey = zonedDayStartToISO(localDateKey(gridEnd), timezone)
  const resource = useLingxiResource(signal => lingxi.calendar(startKey, endKey, signal), [startKey, endKey])
  const days = Array.from({ length: 42 }, (_, index) => { const day = new Date(gridStart); day.setDate(day.getDate() + index); return day })
  const ranges = useMemo(() => (resource.data?.events ?? []).map(event => ({ event, ...eventDayRange(event, timezone) })), [resource.data, timezone])
  const selectedEvents = ranges.filter(range => selected >= range.start && selected <= range.end).map(range => range.event).sort((a, b) => a.start.localeCompare(b.start))
  function changeMonth(delta: number) { const next = new Date(month.getFullYear(), month.getMonth() + delta, 1); setMonth(next); setSelected(localDateKey(next)) }
  return <>
    <div className="lingxi-month-heading"><strong>{month.getFullYear()} 年 {month.getMonth() + 1} 月</strong><div className="lingxi-month-actions"><IconButton label="上个月" onClick={() => changeMonth(-1)}><ChevronLeft size={15} /></IconButton><button className="lingxi-link" onClick={() => { const now = new Date(`${today}T00:00:00`); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); setSelected(today) }}>今天</button><IconButton label="下个月" onClick={() => changeMonth(1)}><ChevronRight size={15} /></IconButton><IconButton label="新建日程" onClick={() => setEditor({})}><Plus size={16} /></IconButton></div></div>
    <div className="lingxi-calendar-grid" aria-label="选择日历日期">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span className="lingxi-weekday" key={day}>{day}</span>)}{days.map(day => { const key = localDateKey(day), hasEvents = ranges.some(range => key >= range.start && key <= range.end); return <button type="button" key={key} className="lingxi-day" data-today={key === today} data-outside={day.getMonth() !== month.getMonth()} data-selected={key === selected} data-events={hasEvents} aria-pressed={key === selected} aria-label={`${key}${hasEvents ? '，有日程' : ''}`} onClick={() => setSelected(key)}>{day.getDate()}</button> })}</div>
    <div className="lingxi-day-agenda"><h3><span>{selected} · {selectedEvents.length} 项日程</span><span className="lingxi-calendar-zone">{timezone}</span></h3>{resource.loading && !resource.data ? <WidgetLoading /> : resource.error ? <WidgetError message={resource.error} onRetry={resource.reload} /> : selectedEvents.length ? selectedEvents.map(event => <button key={event.occurrence_id ?? `${event.id}:${event.start}`} className="lingxi-event" type="button" onClick={() => setEditor({ event })}><span className="lingxi-event-time">{event.all_day ? '全天' : formatLingxiDate(event.start, { hour: '2-digit', minute: '2-digit' }, timezone)}</span><span className="min-w-0"><span className="lingxi-event-title">{event.title}</span>{event.location && <span className="lingxi-event-meta">{event.location}</span>}</span></button>) : <button type="button" className="lingxi-link" onClick={() => setEditor({})}>暂无日程，添加一项</button>}</div>
    {editor && <LingxiEventEditor event={editor.event} day={selected} onClose={() => setEditor(null)} />}
  </>
}

function ScheduleContent() {
  const timezone = useLingxiTimezone()
  const [filter, setFilter] = useState<'open' | 'calendar' | 'done'>('open')
  const [taskEditor, setTaskEditor] = useState<{ task?: LingxiTask } | null>(null), [eventEditor, setEventEditor] = useState<{ event?: LingxiEvent } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null), [mutationError, setMutationError] = useState('')
  const today = zonedDateInput(new Date(), timezone, true), rangeStart = zonedDayStartToISO(today, timezone), nextMonth = new Date(`${today}T00:00:00`); nextMonth.setDate(nextMonth.getDate() + 30)
  const until = zonedDayStartToISO(localDateKey(nextMonth), timezone)
  const resource = useLingxiResource(signal => lingxi.tasks(signal))
  const calendar = useLingxiResource(signal => lingxi.calendar(rangeStart, until, signal), [rangeStart, until])
  const tasks = (resource.data?.tasks ?? []).filter(task => filter === 'done' ? task.status !== 'open' : task.status === 'open').sort((a, b) => (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity) || b.priority - a.priority)
  async function toggle(task: LingxiTask) {
    if (busyId) return
    setBusyId(task.id); setMutationError('')
    try { await lingxi.updateTask(task.id, { status: task.status === 'done' ? 'open' : 'done' }); notifyLingxiChanged() } catch (err) { setMutationError(errorMessage(err)) } finally { setBusyId(null) }
  }
  return <>
    <div className="lingxi-schedule-toolbar"><div className="lingxi-filter" aria-label="日程类型">{([['open', '待办'], ['calendar', '日程'], ['done', '已结束']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div><IconButton label={filter === 'calendar' ? '新建日程' : '新建待办'} onClick={() => filter === 'calendar' ? setEventEditor({}) : setTaskEditor({})}><Plus size={16} /></IconButton></div>
    {mutationError && <p className="lingxi-error" role="alert">{mutationError}</p>}
    {filter === 'calendar' ? calendar.loading && !calendar.data ? <WidgetLoading /> : calendar.error ? <WidgetError message={calendar.error} onRetry={calendar.reload} /> : calendar.data?.events.length ? <div className="lingxi-list">{[...calendar.data.events].sort((a, b) => a.start.localeCompare(b.start)).map(event => <button key={event.occurrence_id ?? `${event.id}:${event.start}`} type="button" className="lingxi-event" onClick={() => setEventEditor({ event })}><span className="min-w-0"><span className="lingxi-event-title">{event.title}</span><span className="lingxi-event-meta">{formatLingxiDate(event.start, event.all_day ? { month: 'short', day: 'numeric' } : undefined, timezone)}{event.all_day ? ' · 全天' : ''}{event.location ? ` · ${event.location}` : ''}</span></span></button>)}</div> : <div className="lingxi-empty">未来 30 天没有日程<button className="lingxi-link" type="button" onClick={() => setEventEditor({})}>添加日程</button></div>
      : resource.loading && !resource.data ? <WidgetLoading /> : resource.error ? <WidgetError message={resource.error} onRetry={resource.reload} /> : tasks.length ? <div className="lingxi-list">{tasks.map(task => <div key={task.id} className="lingxi-task" data-done={task.status === 'done'}><button type="button" className="lingxi-task-check" disabled={!!busyId} onClick={() => void toggle(task)} aria-label={task.status === 'done' ? `重新打开 ${task.title}` : `完成 ${task.title}`}>{task.status === 'done' ? <CheckCircle2 size={17} /> : <Circle size={17} />}</button><button type="button" className="lingxi-task-content" onClick={() => setTaskEditor({ task })}><span className="lingxi-event-title"><span className="lingxi-priority" data-priority={task.priority} />{task.title}</span><span className="lingxi-event-meta">{task.status === 'cancelled' ? '已取消 · ' : ''}{task.due ? formatLingxiDate(task.due, undefined, timezone) : '没有截止时间'}</span></button></div>)}</div> : <div className="lingxi-empty">{filter === 'done' ? '还没有结束的待办' : '待办清空了，留点时间给自己。'}{filter === 'open' && <button type="button" className="lingxi-link" onClick={() => setTaskEditor({})}>添加待办</button>}</div>}
    {taskEditor && <LingxiTaskEditor task={taskEditor.task} onClose={() => setTaskEditor(null)} />}{eventEditor && <LingxiEventEditor event={eventEditor.event} day={today} onClose={() => setEventEditor(null)} />}
  </>
}

function DeadlineContent() {
  const timezone = useLingxiTimezone()
  const resource = useLingxiResource(signal => lingxi.tasks(signal))
  const [now, setNow] = useState(Date.now()), [editor, setEditor] = useState<{ task?: LingxiTask } | null>(null)
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const tasks = (resource.data?.tasks ?? []).filter(task => task.status === 'open' && task.due && Number.isFinite(Date.parse(task.due))).sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!))
  return <><WidgetHeaderActions><IconButton label="新建截止任务" onClick={() => setEditor({})}><Plus size={15} /></IconButton></WidgetHeaderActions>{resource.loading && !resource.data ? <WidgetLoading /> : resource.error ? <WidgetError message={resource.error} onRetry={resource.reload} /> : tasks.length ? <div className="lingxi-list">{tasks.map(task => { const countdown = deadlineLabel(task.due!, now); return <button key={task.id} type="button" className="lingxi-deadline" onClick={() => setEditor({ task })}><span className="lingxi-event-title text-xs">{task.title}</span><p className="lingxi-countdown" data-overdue={countdown.overdue}>{countdown.label}</p><span className="lingxi-event-meta">{formatLingxiDate(task.due, undefined, timezone)}</span></button> })}</div> : <div className="lingxi-empty"><p>目前没有待完成的截止任务。</p><button className="lingxi-link" type="button" onClick={() => setEditor({})}>设置一个 Deadline</button></div>}{editor && <LingxiTaskEditor task={editor.task} onClose={() => setEditor(null)} />}</>
}

function ChatContent() {
  const sessions = useLingxiResource(signal => lingxi.sessions(signal))
  const [selected, setSelected] = useState(''), [messages, setMessages] = useState<LingxiMessage[]>([]), [input, setInput] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('')
  const [rename, setRename] = useState(false), [sessionTitle, setSessionTitle] = useState(''), [confirmDelete, setConfirmDelete] = useState(false), [historyVersion, setHistoryVersion] = useState(0)
  const [vaultHint, setVaultHint] = useState(false)
  const request = useRef<AbortController | null>(null), messagesViewport = useRef<HTMLDivElement | null>(null), streamingNewSession = useRef('')
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => { if (!selected && sessions.data?.sessions[0]) setSelected(sessions.data.sessions[0].id) }, [selected, sessions.data])
  useEffect(() => {
    const controller = new AbortController()
    setVaultHint(false)
    if (selected && streamingNewSession.current === selected) { streamingNewSession.current = ''; setLoadingHistory(false); return () => controller.abort() }
    setMessages([]); setError(''); setConfirmDelete(false); setRename(false)
    if (!selected) return () => controller.abort()
    setLoadingHistory(true)
    lingxi.messages(selected, controller.signal).then(data => { if (!controller.signal.aborted) setMessages(data.messages.filter(message => message.role === 'user' || message.role === 'assistant')) }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)) }).finally(() => { if (!controller.signal.aborted) setLoadingHistory(false) })
    return () => controller.abort()
  }, [selected, historyVersion])
  useEffect(() => { const viewport = messagesViewport.current; if (viewport) viewport.scrollTop = viewport.scrollHeight }, [messages])

  async function newSession() {
    if (busy || request.current) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try { const { session } = await lingxi.createSession('新对话', controller.signal); if (!controller.signal.aborted) { sessions.setData(data => ({ sessions: [session, ...(data?.sessions ?? [])] })); setSelected(session.id) } } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)) } finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function send() {
    const message = input.trim()
    if (!message || busy || request.current || loadingHistory || sessions.loading || sessions.error || (!selected && sessions.data?.sessions.length)) return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setVaultHint(false); setStatus('灵犀正在思考…')
    let id = selected
    try {
      if (!id) { const { session } = await lingxi.createSession(message.slice(0, 40), controller.signal); id = session.id; streamingNewSession.current = id; sessions.setData(data => ({ sessions: [session, ...(data?.sessions ?? [])] })); setSelected(id) }
      const suffix = `${Date.now()}-${Math.random()}`, assistantId = `pending-ai-${suffix}`
      setInput('')
      setMessages(value => [...value, { id: `pending-user-${suffix}`, role: 'user', content: message, created_at: new Date().toISOString() }, { id: assistantId, role: 'assistant', content: '', created_at: new Date().toISOString() }])
      await streamLingxiMessage(id, message, ({ event, data }) => {
        if (event === 'delta') { const text = typeof data.data === 'string' ? data.data : ''; setStatus('正在回复…'); setMessages(value => value.map(item => item.id === assistantId ? { ...item, content: item.content + text } : item)) }
        if (event === 'tool') {
          setStatus('灵犀正在处理请求…')
          const tool = data.data
          if (tool && typeof tool === 'object' && 'name' in tool && tool.name === 'search_navigation_vault' && 'ok' in tool && tool.ok === true) setVaultHint(true)
        }
        if (event === 'notice' && typeof data.data === 'string') setStatus(data.data)
        if (event === 'title') { const title = typeof data.data === 'string' ? data.data : ''; if (title) sessions.setData(value => value ? { sessions: value.sessions.map(session => session.id === id ? { ...session, title } : session) } : value) }
        if (event === 'done') { setStatus(''); if (typeof data.data === 'string') setMessages(value => value.map(item => item.id === assistantId ? { ...item, content: data.data as string } : item)) }
      }, controller.signal)
      sessions.reload(); notifyLingxiChanged()
    } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)); else setStatus('已停止接收，可重新读取已保存的回复') } finally { if (request.current === controller) { request.current = null; setBusy(false); if (!controller.signal.aborted) setStatus('') } }
  }
  async function saveTitle() {
    if (!selected || busy || !sessionTitle.trim()) return
    setBusy(true); setError('')
    try { await lingxi.updateSession(selected, sessionTitle.trim()); sessions.reload(); setRename(false) } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  async function removeSession() {
    if (!selected || busy) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBusy(true); setError('')
    try { await lingxi.deleteSession(selected); const remaining = (sessions.data?.sessions ?? []).filter(item => item.id !== selected); sessions.setData({ sessions: remaining }); setSelected(remaining[0]?.id ?? ''); setMessages([]); setConfirmDelete(false) } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return <div className="lingxi-chat"><div className="lingxi-chat-toolbar"><select aria-label="灵犀会话" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>{!sessions.data?.sessions.length && <option value="">新对话</option>}{sessions.data?.sessions.map(session => <option key={session.id} value={session.id}>{session.title || '未命名对话'}</option>)}</select><IconButton label="新建对话" disabled={busy} onClick={() => void newSession()}><Plus size={16} /><span>新对话</span></IconButton><IconButton label="重命名对话" disabled={!selected || busy} onClick={() => { setSessionTitle(sessions.data?.sessions.find(session => session.id === selected)?.title ?? ''); setRename(value => !value) }}><Pencil size={13} /></IconButton><IconButton label={confirmDelete ? '确认删除对话' : '删除对话'} disabled={!selected || busy} onClick={() => void removeSession()}><Trash2 size={13} /></IconButton><IconButton label="重新读取对话" disabled={busy} onClick={() => { sessions.reload(); setHistoryVersion(value => value + 1) }}><RefreshCw size={13} /></IconButton></div>
    {confirmDelete && <div className="lingxi-chat-confirm"><span>将删除整个会话</span><button type="button" className="lingxi-link" onClick={() => void removeSession()} disabled={busy}>确认删除</button><button type="button" className="lingxi-link" onClick={() => setConfirmDelete(false)}>取消</button></div>}
    {rename && <form className="lingxi-chat-rename" onSubmit={e => { e.preventDefault(); void saveTitle() }}><input aria-label="会话名称" className="lingxi-chat-title-input" autoFocus value={sessionTitle} maxLength={200} onChange={e => setSessionTitle(e.target.value)} /><button type="submit" className="lingxi-link" disabled={busy}>保存</button></form>}
    {sessions.error && <WidgetError message={sessions.error} onRetry={sessions.reload} />}
    <div ref={messagesViewport} className="lingxi-messages" role="log" aria-label="灵犀聊天记录" aria-live="polite">{loadingHistory ? <WidgetLoading /> : messages.length ? messages.map(message => <div key={message.id} className="lingxi-message" data-role={message.role}><span className="lingxi-message-label">{message.role === 'user' ? '你' : '灵犀'}</span>{message.role === 'assistant' && message.content ? <AssistantMessage content={message.content} /> : message.content || (busy ? '正在思考…' : '暂无回复内容')}</div>) : <div className="lingxi-empty"><MessageCircle size={25} /><p>告诉灵犀今天的计划，<br />从这里继续你的对话。</p></div>}</div>
    {error && <p className="lingxi-error" role="alert">{error}</p>}
    {vaultHint && <Link to="/settings/lingxi#lingxi-vault" className="lingxi-link justify-start">打开密码查看 →</Link>}
    <span className="lingxi-chat-status" role="status">{status}</span>
    <form className="lingxi-composer" onSubmit={event => { event.preventDefault(); void send() }}><textarea aria-label="发送给灵犀的消息" placeholder="和灵犀聊聊…" rows={2} maxLength={12000} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />{busy ? <button type="button" className="lingxi-send" aria-label="停止回复" onClick={() => request.current?.abort()}><Square size={13} /></button> : <button type="submit" className="lingxi-send" disabled={!input.trim() || loadingHistory || sessions.loading || !!sessions.error} aria-label="发送消息"><Send size={15} /></button>}</form>
  </div>
}

export function LingxiHomeWidgets() {
  const settings = useApp(state => state.settings), user = useApp(state => state.user)
  if (!user || ![settings.show_lingxi_calendar, settings.show_lingxi_schedule, settings.show_lingxi_deadline, settings.show_lingxi_chat].some(Boolean)) return null
  return <div className="lingxi-home-widgets" aria-label="灵犀小组件">
    {settings.show_lingxi_calendar && <div><LingxiCalendarWidget /></div>}
    {settings.show_lingxi_schedule && <div><LingxiScheduleWidget /></div>}
    {settings.show_lingxi_deadline && <div><LingxiDeadlineWidget /></div>}
    {settings.show_lingxi_chat && <div><LingxiChatWidget /></div>}
  </div>
}
