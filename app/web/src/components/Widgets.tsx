import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Briefcase,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Quote,
  Sun,
  Wind,
} from 'lucide-react'
import { api } from '../lib/api.ts'
import type { Hitokoto, Weather } from '../lib/types.ts'
import { useApp } from '../store/app.ts'

/** WMO 天气码 → 图标。分组与后端的中文描述表保持一致。 */
function weatherIcon(code: number, isDay: boolean) {
  if (code === 0) return isDay ? Sun : Sun
  if (code === 1 || code === 2) return CloudSun
  if (code === 3) return Cloud
  if (code === 45 || code === 48) return CloudFog
  if (code >= 51 && code <= 57) return CloudDrizzle
  if (code >= 61 && code <= 67) return CloudRain
  if (code >= 71 && code <= 77) return CloudSnow
  if (code >= 80 && code <= 82) return CloudRain
  if (code >= 85 && code <= 86) return CloudSnow
  if (code >= 95) return CloudLightning
  return Cloud
}

export function WeatherWidget() {
  const enabled = useApp((s) => s.settings.show_weather)
  const city = useApp((s) => s.settings.weather_city)
  const [data, setData] = useState<Weather | null>(null)

  useEffect(() => {
    if (!enabled) return
    let alive = true

    const url = city ? `/api/widgets/weather?city=${encodeURIComponent(city)}` : '/api/widgets/weather'
    api<Weather>(url, {}, { retry: false })
      .then((res) => {
        if (alive) setData(res)
      })
      .catch(() => {
        // 外部接口不可用时整个小组件隐藏，而不是在首页上摆一个报错框
        if (alive) setData(null)
      })

    return () => {
      alive = false
    }
  }, [enabled, city])

  if (!enabled || !data) return null

  const Icon = weatherIcon(data.weather_code, data.is_day)

  return (
    <div className="glass flex items-center gap-3 rounded-2xl px-4 py-2.5 text-fg">
      <Icon className="size-7 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold leading-none tabular-nums">
            {Math.round(data.temperature)}°
          </span>
          <span className="truncate text-xs text-fg/75">{data.description}</span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-fg/55">
          <span className="truncate">{data.city}</span>
          <span className="flex items-center gap-1">
            <Droplets className="size-3" aria-hidden />
            {Math.round(data.humidity)}%
          </span>
          <span className="hidden items-center gap-1 sm:flex">
            <Wind className="size-3" aria-hidden />
            {Math.round(data.wind_speed)}km/h
          </span>
        </div>
      </div>
    </div>
  )
}

export function HitokotoWidget() {
  const enabled = useApp((s) => s.settings.show_hitokoto)
  const [data, setData] = useState<Hitokoto | null>(null)

  useEffect(() => {
    if (!enabled) return
    let alive = true

    api<Hitokoto>('/api/widgets/hitokoto', {}, { retry: false })
      .then((res) => {
        if (alive && res?.text) setData(res)
      })
      .catch(() => {
        if (alive) setData(null)
      })

    return () => {
      alive = false
    }
  }, [enabled])

  if (!enabled || !data) return null

  const attribution = [data.author, data.source].filter(Boolean).join(' · ')

  return (
    <div className="glass flex max-w-md items-start gap-3 rounded-2xl px-4 py-2.5 text-fg">
      <Quote className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs leading-relaxed text-fg/85">{data.text}</p>
        {attribution && <p className="mt-1 text-[11px] text-fg/45">— {attribution}</p>}
      </div>
    </div>
  )
}

/**
 * 工作台入口。
 *
 * 和别的组件不一样，这个不发任何请求 —— 它就是一颗去工作台的入口。
 * 工作台里放的是账号密码，首页不该把它们摊出来，只给一个门。
 */
export function WorkbenchWidget() {
  const enabled = useApp((s) => s.settings.show_workbench)
  if (!enabled) return null

  return (
    <Link
      to="/workbench"
      className="glass group flex items-center gap-3 rounded-2xl px-4 py-2.5 text-fg transition hover:ring-1 hover:ring-accent/40"
    >
      <Briefcase className="size-6 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 text-left">
        <div className="flex items-center gap-1 text-sm font-medium leading-none">
          工作台
          <ArrowRight
            className="size-3.5 text-fg/40 transition group-hover:translate-x-0.5 group-hover:text-fg/70"
            aria-hidden
          />
        </div>
        <p className="mt-1 text-[11px] text-fg/55">后台账号、密码与用途</p>
      </div>
    </Link>
  )
}

/** 几个小组件并排；都为不可用时整行不占位 */
export function WidgetRow() {
  const showWeather = useApp((s) => s.settings.show_weather)
  const showHitokoto = useApp((s) => s.settings.show_hitokoto)
  const showWorkbench = useApp((s) => s.settings.show_workbench)

  if (!showWeather && !showHitokoto && !showWorkbench) return null

  return (
    <div className="mb-6 flex flex-wrap items-stretch justify-center gap-3">
      {showWeather && <WeatherWidget />}
      {showHitokoto && <HitokotoWidget />}
      {showWorkbench && <WorkbenchWidget />}
    </div>
  )
}
