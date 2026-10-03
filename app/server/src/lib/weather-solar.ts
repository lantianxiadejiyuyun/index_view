/** Approximate sea-level solar times, following NOAA's published equations.
 * https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 * Terrain and atmospheric conditions can move the observed sunrise/sunset.
 */
export type SolarTimes = {
  solar_date: string
  sunrise: string | null
  solar_noon: string
  sunset: string | null
  solar_source: 'calculated'
}

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true } catch { return false }
}

export function dateAtZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (key: string) => parts.find((item) => item.type === key)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function calculateSolarTimes(latitude: number, longitude: number, timezone: string, now = new Date()): SolarTimes | null {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || !validTimeZone(timezone) || !Number.isFinite(now.getTime())) return null
  const solar_date = dateAtZone(now, timezone)
  const dayStart = Date.parse(`${solar_date}T00:00:00Z`)
  const year = Number(solar_date.slice(0, 4))
  const dayOfYear = (dayStart - Date.UTC(year, 0, 1)) / 86400000 + 1
  const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000
  const gamma = 2 * Math.PI / daysInYear * (dayOfYear - 1)
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
  const radians = Math.PI / 180
  const cosine = Math.cos(90.833 * radians) / (Math.cos(latitude * radians) * Math.cos(declination)) - Math.tan(latitude * radians) * Math.tan(declination)
  let noonMinutes = 720 - 4 * longitude - equation
  const noonLocalDate = dateAtZone(new Date(dayStart + noonMinutes * 60000), timezone)
  if (noonLocalDate > solar_date) noonMinutes -= 1440
  else if (noonLocalDate < solar_date) noonMinutes += 1440
  const iso = (minutes: number) => new Date(dayStart + Math.round(minutes * 60) * 1000).toISOString()
  // At high latitudes sunrise and sunset may not happen on this date.
  const angle = cosine >= -1 && cosine <= 1 ? Math.acos(cosine) / radians : null
  return { solar_date, sunrise: angle === null ? null : iso(noonMinutes - 4 * angle), solar_noon: iso(noonMinutes), sunset: angle === null ? null : iso(noonMinutes + 4 * angle), solar_source: 'calculated' }
}
