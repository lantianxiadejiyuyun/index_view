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
  MapPin,
  Moon,
  CloudMoon,
  Quote,
  Sun,
  Thermometer,
  Wind,
} from 'lucide-react'
import { api } from '../lib/api.ts'
import type { Hitokoto } from '../lib/types.ts'
import { useApp } from '../store/app.ts'
import { useWeather } from '../lib/useWeather.ts'
import { cityDate, solarState, uvLevel, uvReading } from '../lib/weather-display.ts'
import { WeatherScene } from './weather/WeatherScene.tsx'
import { citySilhouette } from './weather/weather-scene-model.ts'
import './weather/weather-widget.css'

/** WMO 天气码 → 图标。分组与后端的中文描述表保持一致。 */
function weatherIcon(code: number, isDay: boolean) {
  if (code === 0) return isDay ? Sun : Moon
  if (code === 1 || code === 2) return isDay ? CloudSun : CloudMoon
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
  const data = useWeather(enabled)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  if (!enabled || !data) return null

  const isDay = solarState(data, now)?.isDay ?? data.is_day
  const Icon = weatherIcon(data.weather_code, isDay)
  const uv = uvReading(data, now)
  const level = uv === null ? null : uvLevel(uv)
  const hasRange = data.forecast_date === cityDate(now, data.timezone) && typeof data.temperature_min === 'number' && Number.isFinite(data.temperature_min) && typeof data.temperature_max === 'number' && Number.isFinite(data.temperature_max)

  return (
    <div className="weather-widget weather-rich glass rounded-2xl text-fg" data-day={isDay ? 'day' : 'night'}>
      <WeatherScene city={data.city} code={data.weather_code} isDay={isDay} />
      <div className="weather-content">
        <div className="weather-heading"><span className="weather-city"><MapPin aria-hidden="true" />{data.city}</span><span className="weather-live-label">{citySilhouette(data.city).landmark}</span></div>
        <div className="weather-main">
          <span className="weather-temperature">{Math.round(data.temperature)}<small>°</small></span>
          <div className="weather-summary"><span className="weather-description"><Icon aria-hidden="true" />{data.description}</span><span className="weather-feels">体感 {Math.round(data.apparent_temperature)}°</span></div>
        </div>
        <span className="weather-compact-uv" data-uv={level?.level ?? 'unknown'}>UV 峰值 {uv === null ? '暂无' : `${uv.toFixed(1)} · ${level?.label}`}</span>
        <div className="weather-metrics">
          <div className="weather-metric weather-uv" data-uv={level?.level ?? 'unknown'}><span><Sun aria-hidden="true" />今日 UV 峰值</span><strong>{uv === null ? '暂无数据' : <>{uv.toFixed(1)}<small>{level?.label}</small></>}</strong></div>
          <div className="weather-metric"><span><Droplets aria-hidden="true" />湿度</span><strong>{Math.round(data.humidity)}<small>%</small></strong></div>
          <div className="weather-metric"><span><Wind aria-hidden="true" />风速</span><strong>{Math.round(data.wind_speed)}<small>km/h</small></strong></div>
          <div className="weather-metric weather-range"><span><Thermometer aria-hidden="true" />今日温度</span><strong>{hasRange ? `${Math.round(data.temperature_min!)}° / ${Math.round(data.temperature_max!)}°` : '暂无数据'}</strong></div>
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
    <div className="quote-widget glass flex max-w-md items-start gap-3 rounded-2xl px-4 py-2.5 text-fg">
      <Quote className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <div className="quote-content min-w-0">
        <p className="quote-text text-xs leading-relaxed text-fg/85">{data.text}</p>
        {attribution && <p className="quote-attribution mt-1 text-[11px] text-fg/45">— {attribution}</p>}
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
      className="workbench-widget glass group flex items-center gap-3 rounded-2xl px-4 py-2.5 text-fg transition hover:ring-1 hover:ring-accent/40"
    >
      <Briefcase className="size-6 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 text-left">
        <div className="workbench-title flex items-center gap-1 text-sm font-medium leading-none">
          工作台
          <ArrowRight
            className="size-3.5 text-fg/40 transition group-hover:translate-x-0.5 group-hover:text-fg/70"
            aria-hidden
          />
        </div>
        <p className="workbench-description mt-1 text-[11px] text-fg/55">后台账号、密码与用途</p>
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
    <div className="home-widgets mb-6 flex flex-wrap items-stretch justify-center gap-3">
      {showWeather && <WeatherWidget />}
      {showHitokoto && <HitokotoWidget />}
      {showWorkbench && <WorkbenchWidget />}
    </div>
  )
}
