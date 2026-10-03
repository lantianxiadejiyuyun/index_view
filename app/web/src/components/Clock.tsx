import { useEffect, useRef, useState } from 'react'
import { readableToneStyle, useReadableTone } from '../lib/useWallpaperTone.ts'
import { useApp } from '../store/app.ts'
import { useWeather } from '../lib/useWeather.ts'
import { SolarTimeline } from './weather/SolarTimeline.tsx'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function greetingOf(hour: number): string {
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  if (hour < 23) return '晚上好'
  return '夜深了'
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function Clock() {
  const showClock = useApp((s) => s.settings.show_clock)
  const showGreeting = useApp((s) => s.settings.show_greeting)
  const title = useApp((s) => s.settings.site_title)
  const subtitle = useApp((s) => s.settings.site_subtitle)
  const weather = useWeather(showClock)

  const [now, setNow] = useState(() => new Date())

  // 时钟块自己查「压在壁纸的哪一块上」—— 壁纸上半亮下半暗时，
  // 全局判定照顾不到每一处文字，各自判断才稳。
  // 用户也可以在设置里强制黑/白，这里把偏好一起传进去。
  const tonePref = useApp((s) => s.settings.tone_clock)
  const headerRef = useRef<HTMLElement>(null)
  const tone = useReadableTone(headerRef, tonePref)

  useEffect(() => {
    // 对齐到整分钟再开始计时，避免长时间挂着的页面出现分钟跳变延迟
    let timer: number
    const tick = () => {
      setNow(new Date())
      const ms = 60_000 - (Date.now() % 60_000)
      timer = window.setTimeout(tick, ms)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [])

  const hour = now.getHours()

  return (
    <header
      ref={headerRef}
      style={readableToneStyle(tone)}
      className="home-clock mb-6 text-center text-wp sm:mb-8"
    >
      {showGreeting && (
        <p className="home-clock-greeting text-shadow-soft mb-2 text-base font-semibold tracking-wide text-wp/85 sm:text-lg">
          {greetingOf(hour)}
          {title ? ` · ${title}` : ''}
        </p>
      )}

      {showClock && (
        <>
          <div className="text-shadow-soft flex items-end justify-center gap-2 tabular-nums">
            <span className="home-clock-time text-6xl font-bold leading-none tracking-tight sm:text-7xl">
              {pad(hour)}:{pad(now.getMinutes())}
            </span>
          </div>
          <p className="home-clock-date text-shadow-soft mt-3 text-base font-medium text-wp/80 sm:text-lg">
            <span className="home-clock-date-full">{now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · {WEEKDAYS[now.getDay()]}</span>
            <span className="home-clock-date-short hidden" aria-hidden="true">{now.getMonth() + 1} 月 {now.getDate()} 日 · {WEEKDAYS[now.getDay()]}</span>
          </p>
          <SolarTimeline data={weather} now={now} />
        </>
      )}

      {subtitle && (
        <p className="home-clock-subtitle text-shadow-soft mt-2 text-sm text-wp/75 sm:text-base">{subtitle}</p>
      )}
    </header>
  )
}
