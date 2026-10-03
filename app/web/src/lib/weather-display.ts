import type { Weather } from './types.ts'

export function cityDate(now: Date, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch { return '' }
}

export function solarTime(value: string | null | undefined, timezone?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone || 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
  } catch { return '—' }
}

export type SolarPhase = 'sunrise' | 'morning' | 'noon' | 'afternoon' | 'sunset' | 'night'
export const SOLAR_LABELS: Record<SolarPhase, string> = {
  sunrise: '日出时分', morning: '晨光', noon: '太阳正午', afternoon: '午后', sunset: '日落时分', night: '夜晚',
}

/** Ignore yesterday's solar path, including after a sleeping tab crosses midnight. */
export function solarState(data: Weather | null, now: Date) {
  if (!data || data.solar_date !== cityDate(now, data.timezone)) return null
  const rise = Date.parse(data.sunrise || '')
  const noon = Date.parse(data.solar_noon || '')
  const set = Date.parse(data.sunset || '')
  if (![rise, noon, set].every(Number.isFinite) || !(rise < noon && noon < set)) return null
  const time = now.getTime()
  const minute = 60_000
  let phase: SolarPhase
  if (Math.abs(time - rise) <= 30 * minute) phase = 'sunrise'
  else if (Math.abs(time - set) <= 30 * minute) phase = 'sunset'
  else if (time < rise || time > set) phase = 'night'
  else if (Math.abs(time - noon) <= 45 * minute) phase = 'noon'
  else phase = time < noon ? 'morning' : 'afternoon'
  const progress = Math.max(0, Math.min(1, time < noon ? .5 * (time - rise) / (noon - rise) : .5 + .5 * (time - noon) / (set - noon)))
  return { phase, progress, isDay: time >= rise && time < set }
}

export function uvReading(data: Weather, now = new Date()): number | null {
  const value = data.uv_index
  if (data.forecast_date !== cityDate(now, data.timezone) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

export function uvLevel(value: number): { label: string; level: string } {
  if (value < 3) return { label: '低', level: 'low' }
  if (value < 6) return { label: '中等', level: 'moderate' }
  if (value < 8) return { label: '高', level: 'high' }
  if (value < 11) return { label: '很高', level: 'very-high' }
  return { label: '极高', level: 'extreme' }
}
