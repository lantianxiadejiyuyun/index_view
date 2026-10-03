import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import './desktop-calendar.css'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function localDate(year: number, month: number, day: number): Date {
  const date = new Date(0)
  // Noon avoids DST transitions around midnight; setFullYear also handles years below 100 correctly.
  date.setHours(12, 0, 0, 0)
  date.setFullYear(year, month, day)
  return date
}

function dateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function DesktopCalendar({ now }: { now?: Date } = {}) {
  const [clock, setClock] = useState(() => new Date())
  const [browsing, setBrowsing] = useState<{ year: number; month: number } | null>(null)
  const today = now ?? clock
  const todayKey = dateKey(today)
  const year = browsing?.year ?? today.getFullYear()
  const month = browsing?.month ?? today.getMonth()
  const first = localDate(year, month, 1)
  const days = Array.from({ length: 42 }, (_, index) => localDate(year, month, index + 1 - first.getDay()))
  const monthLabel = `${year}年${month + 1}月`
  const dayOfYear = Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(today.getFullYear(), 0, 1)) / 86_400_000) + 1

  useEffect(() => {
    if (now !== undefined) return
    let timer: number
    const update = () => {
      window.clearTimeout(timer)
      setClock(new Date())
      timer = window.setTimeout(update, 60_000 - Date.now() % 60_000)
    }
    const onVisible = () => { if (document.visibilityState === 'visible') update() }
    update()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [now])

  function moveMonth(direction: number) {
    const next = localDate(year, month + direction, 1)
    setBrowsing({ year: next.getFullYear(), month: next.getMonth() })
  }

  return (
    <section className="desktop-calendar" aria-label="日历">
      <div className="calendar-summary">
        <time dateTime={todayKey}>
          <span className="calendar-summary-month">{today.getFullYear()}年{today.getMonth() + 1}月</span>
          <span className="calendar-day-number">{today.getDate()}</span>
          <span className="calendar-weekday">星期{WEEKDAYS[today.getDay()]}</span>
        </time>
        <span className="calendar-year-progress">今年第 {dayOfYear} 天</span>
        <button type="button" className="calendar-today" aria-label="回到今天" onClick={() => setBrowsing(null)}>今天</button>
      </div>

      <div className="calendar-month-view">
        <div className="calendar-nav">
          <button type="button" aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft size={14} aria-hidden="true" /></button>
          <button type="button" className="calendar-month" aria-label={`${monthLabel}，回到今天`} title="回到今天" onClick={() => setBrowsing(null)}><span aria-live="polite" aria-atomic="true">{monthLabel}</span></button>
          <button type="button" aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight size={14} aria-hidden="true" /></button>
        </div>
        <table className="calendar-grid" aria-label={`${monthLabel}月历`}>
          <thead>
            <tr>{WEEKDAYS.map((day, index) => <th className="calendar-week-header" key={day} scope="col" aria-label={`星期${day}`} data-weekend={index === 0 || index === 6 ? true : undefined}>{day}</th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_, week) => (
              <tr key={week}>
                {days.slice(week * 7, week * 7 + 7).map(date => {
                  const key = dateKey(date)
                  const isToday = key === todayKey
                  const outside = date.getMonth() !== month
                  return <td key={key} className={`calendar-day${isToday ? ' is-today' : ''}${outside ? ' is-outside' : ''}`} data-weekend={date.getDay() === 0 || date.getDay() === 6 ? true : undefined}>
                    <time dateTime={key} aria-current={isToday ? 'date' : undefined} aria-label={`${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${isToday ? '，今天' : ''}`}>{date.getDate()}</time>
                  </td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
