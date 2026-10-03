import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import { lingxi, localDateKey, zonedDateInput, zonedDayStartToISO, zonedInputToISO, type LingxiEvent, type LingxiTask } from '../../lib/lingxi.ts'
import { errorMessage } from '../../lib/api.ts'
import { Modal, btnDanger, btnGhost, btnPrimary, fieldClass, labelClass } from '../Modal.tsx'
import { notifyLingxiChanged, useLingxiTimezone, WidgetLoading } from './shared.tsx'

function dateInput(value: string | null, timezone: string, allDay = false): string {
  if (!value) return ''
  return zonedDateInput(value, timezone, allDay)
}

export function LingxiEventEditor({ event, day, onClose }: { event?: LingxiEvent; day: string; onClose: () => void }) {
  const [mainEvent, setMainEvent] = useState<LingxiEvent | undefined>(undefined)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!event) return
    const controller = new AbortController()
    lingxi.event(event.id, controller.signal).then(data => { if (!controller.signal.aborted) setMainEvent(data.event) }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)) })
    return () => controller.abort()
  }, [event])
  return <EventForm event={mainEvent} day={day} onClose={onClose} isEdit={!!event} loading={!!event && !mainEvent} loadError={error} />
}

function EventForm({ event, day, onClose, isEdit, loading, loadError }: { event?: LingxiEvent; day: string; onClose: () => void; isEdit: boolean; loading: boolean; loadError: string }) {
  const timezone = useLingxiTimezone(), formId = useId()
  const [title, setTitle] = useState(event?.title ?? '')
  const [allDay, setAllDay] = useState(event?.all_day ?? false)
  const [start, setStart] = useState(event ? dateInput(event.start, timezone, event.all_day) : `${day}T09:00`)
  const [end, setEnd] = useState(event ? dateInput(event.end, timezone, event.all_day) : `${day}T10:00`)
  const [description, setDescription] = useState(event?.description ?? '')
  const [location, setLocation] = useState(event?.location ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    if (!event) return
    setTitle(event.title); setAllDay(event.all_day)
    setStart(dateInput(event.start, timezone, event.all_day)); setEnd(dateInput(event.end, timezone, event.all_day))
    setDescription(event.description ?? ''); setLocation(event.location ?? '')
  }, [event, timezone])
  async function save() {
    if (busy || loading) return
    setError('')
    if (!title.trim()) { setError('请填写日程名称'); return }
    if (!start || (end && new Date(end) <= new Date(start))) { setError(allDay ? '全天日程的结束日期不包含当天，需晚于开始日期' : '结束时间必须晚于开始时间'); return }
    setBusy(true)
    try {
      const input = { title: title.trim(), start: allDay ? zonedDayStartToISO(start, timezone) : zonedInputToISO(start, timezone), end: end ? allDay ? zonedDayStartToISO(end, timezone) : zonedInputToISO(end, timezone) : null, all_day: allDay, description: description.trim(), location: location.trim() }
      if (event) await lingxi.updateEvent(event.id, input)
      else await lingxi.createEvent(input)
      notifyLingxiChanged(); onClose()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  async function remove() {
    if (!event || busy) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBusy(true); setError('')
    try { await lingxi.deleteEvent(event.id); notifyLingxiChanged(); onClose() } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return createPortal(<div className="lingxi-editor"><Modal open title={isEdit ? '编辑灵犀日程' : '新建灵犀日程'} onClose={onClose} size="editor" footer={<div className="lingxi-editor-actions">{event && <button type="button" disabled={busy} className={`${btnDanger} lingxi-editor-delete flex items-center gap-2`} onClick={() => void remove()}><Trash2 size={14} />{confirmDelete ? '确认删除日程' : '删除'}</button>}<button type="button" disabled={busy} className={`${btnGhost} lingxi-editor-cancel`} onClick={onClose}>取消</button><button type="submit" form={formId} disabled={busy || loading} className={btnPrimary}>{busy ? '保存中…' : '保存日程'}</button></div>}><form id={formId} className="lingxi-editor-form" onSubmit={e => { e.preventDefault(); void save() }}>{loading ? loadError ? <p role="alert" className="lingxi-editor-error">{loadError}</p> : <WidgetLoading /> : <fieldset disabled={busy} className="disabled:opacity-60">
    <label className={labelClass}>日程名称<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} className={`${fieldClass} mt-2`} placeholder="准备产品评审" /></label>
    {event?.rrule && <p className="rounded-xl bg-brand-500/10 p-3 text-xs leading-relaxed text-fg/70">这是重复日程，修改或删除会作用于整个系列。开始时间显示该系列的首次时间。</p>}
    <label className="lingxi-editor-all-day text-fg"><input type="checkbox" checked={allDay} onChange={e => { const next = e.target.checked; setAllDay(next); setStart(value => next ? value.slice(0, 10) : `${value.slice(0, 10)}T09:00`); setEnd(value => { if (!value) return ''; if (!next) return `${value.slice(0, 10)}T10:00`; const last = new Date(`${value.slice(0, 10)}T00:00:00`); last.setDate(last.getDate() + 1); return localDateKey(last) }) }} />全天日程</label>
    <div className="grid gap-4 sm:grid-cols-2"><label className={labelClass}>开始<input required type={allDay ? 'date' : 'datetime-local'} value={start} onChange={e => setStart(e.target.value)} className={`${fieldClass} mt-2`} /></label><label className={labelClass}>{allDay ? '结束（不含当天）' : '结束'}<input type={allDay ? 'date' : 'datetime-local'} value={end} min={start} onChange={e => setEnd(e.target.value)} className={`${fieldClass} mt-2`} /></label></div>
    <label className={labelClass}>地点<input maxLength={255} value={location} onChange={e => setLocation(e.target.value)} className={`${fieldClass} mt-2`} placeholder="可选" /></label>
    <label className={labelClass}>备注<textarea rows={4} maxLength={10000} value={description} onChange={e => setDescription(e.target.value)} className={`${fieldClass} mt-2`} placeholder="日程说明" /></label>
    <p className="lingxi-editor-hint">时间按灵犀账号时区 {timezone} 输入，保存后同步到灵犀。</p>

  </fieldset>}{error && <p role="alert" className="lingxi-editor-error">{error}</p>}</form></Modal></div>, document.body)
}

export function LingxiTaskEditor({ task, onClose }: { task?: LingxiTask; onClose: () => void }) {
  const timezone = useLingxiTimezone(), formId = useId()
  const [title, setTitle] = useState(task?.title ?? ''), [notes, setNotes] = useState(task?.notes ?? ''), [due, setDue] = useState(dateInput(task?.due ?? null, timezone))
  const [priority, setPriority] = useState<LingxiTask['priority']>(task?.priority ?? 2), [status, setStatus] = useState<LingxiTask['status']>(task?.status ?? 'open')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false)
  async function save() {
    if (busy) return
    setError('')
    if (!title.trim()) { setError('请填写待办名称'); return }
    setBusy(true)
    try {
      const input = { title: title.trim(), notes: notes.trim(), due: due ? zonedInputToISO(due, timezone) : null, priority, status }
      if (task) await lingxi.updateTask(task.id, input)
      else await lingxi.createTask(input)
      notifyLingxiChanged(); onClose()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  async function remove() {
    if (!task || busy) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBusy(true); setError('')
    try { await lingxi.deleteTask(task.id); notifyLingxiChanged(); onClose() } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return createPortal(<div className="lingxi-editor"><Modal open title={task ? '编辑灵犀待办' : '新建灵犀待办'} onClose={onClose} size="editor" footer={<div className="lingxi-editor-actions">{task && <button type="button" disabled={busy} className={`${btnDanger} lingxi-editor-delete flex items-center gap-2`} onClick={() => void remove()}><Trash2 size={14} />{confirmDelete ? '确认删除待办' : '删除'}</button>}<button type="button" disabled={busy} className={`${btnGhost} lingxi-editor-cancel`} onClick={onClose}>取消</button><button type="submit" form={formId} disabled={busy} className={btnPrimary}>{busy ? '保存中…' : '保存待办'}</button></div>}><form id={formId} className="lingxi-editor-form" onSubmit={e => { e.preventDefault(); void save() }}><fieldset disabled={busy} className="disabled:opacity-60">
    <label className={labelClass}>待办名称<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} className={`${fieldClass} mt-2`} placeholder="需要完成的事情" /></label>
    <label className={labelClass}>截止时间<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} className={`${fieldClass} mt-2`} /><span className="mt-2 block font-normal text-fg/50">可留空；设置后会出现在 Deadline 组件中，按灵犀账号时区 {timezone} 输入。</span></label>
    <div className="grid gap-4 sm:grid-cols-2"><label className={labelClass}>优先级<select value={priority} onChange={e => setPriority(Number(e.target.value) as LingxiTask['priority'])} className={`${fieldClass} mt-2`}><option value={3}>高</option><option value={2}>普通</option><option value={1}>低</option></select></label><label className={labelClass}>状态<select value={status} onChange={e => setStatus(e.target.value as LingxiTask['status'])} className={`${fieldClass} mt-2`}><option value="open">待完成</option><option value="done">已完成</option><option value="cancelled">已取消</option></select></label></div>
    <label className={labelClass}>备注<textarea rows={4} maxLength={10000} value={notes} onChange={e => setNotes(e.target.value)} className={`${fieldClass} mt-2`} placeholder="任务说明" /></label>

  </fieldset>{error && <p role="alert" className="lingxi-editor-error">{error}</p>}</form></Modal></div>, document.body)
}
