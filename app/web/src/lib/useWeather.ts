import { useEffect, useState } from 'react'
import { useApp } from '../store/app.ts'
import { api } from './api.ts'
import type { Weather } from './types.ts'
import { cityDate } from './weather-display.ts'

type Entry = { data: Weather | null; fetched: number; pending?: Promise<void>; listeners: Set<() => void> }
const cache = new Map<string, Entry>()
const CACHE_MS = 5 * 60_000

/** The clock and weather share one request, also when both hero and grid clocks are visible. */
export function useWeather(enabled = true): Weather | null {
  const city = useApp((s) => s.settings.weather_city)
  const provider = useApp((s) => s.settings.weather_provider)
  const key = `${provider}:${city}`
  const [snapshot, setSnapshot] = useState<{ key: string; data: Weather | null }>({ key, data: null })
  useEffect(() => {
    if (!enabled) return
    let entry = cache.get(key)
    if (!entry) {
      entry = { data: null, fetched: 0, listeners: new Set() }
      // Only inactive entries are evicted; changing cities never retains unbounded data.
      if (cache.size >= 12) for (const [oldKey, old] of cache) if (!old.listeners.size && !old.pending) cache.delete(oldKey)
      cache.set(key, entry)
    }
    const current = entry
    const update = () => setSnapshot({ key, data: current.data })
    current.listeners.add(update)
    update()
    const fetchWeather = (force = false) => {
      if (current.pending || (!force && Date.now() - current.fetched < CACHE_MS)) return
      const url = city ? `/api/widgets/weather?city=${encodeURIComponent(city)}` : '/api/widgets/weather'
      current.pending = api<Weather>(url, {}, { retry: false })
        .then((data) => { current.data = data })
        .catch(() => { /* Keep the previous reading through transient network errors. */ })
        .finally(() => {
          current.fetched = Date.now()
          current.pending = undefined
          for (const listener of current.listeners) listener()
        })
    }
    fetchWeather()
    // China realtime returns first; give optional forecast enrichment time to arrive.
    const enrichment = window.setTimeout(() => {
      if (!current.data?.forecast_date && document.visibilityState !== 'hidden') fetchWeather(true)
    }, 12_000)
    const refresh = () => {
      const changedDay = !!current.data?.solar_date && current.data.solar_date !== cityDate(new Date(), current.data.timezone)
      if (document.visibilityState !== 'hidden') fetchWeather(changedDay)
    }
    const timer = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      current.listeners.delete(update)
      window.clearInterval(timer)
      window.clearTimeout(enrichment)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [key, city, enabled])
  return enabled && snapshot.key === key ? snapshot.data : null
}
