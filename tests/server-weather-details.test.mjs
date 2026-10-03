import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const result = await build({
  stdin: { contents: `export * from './weather.ts'; export * from './weather-solar.ts'; export {cacheWrite, cacheRead} from './widget-cache.js';`, resolveDir: fileURLToPath(new URL('../app/server/src/lib/', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'isolated-weather-cache', setup(builder) {
    builder.onResolve({ filter: /widget-cache\.js$/ }, () => ({ path: 'cache', namespace: 'weather-test' }))
    builder.onLoad({ filter: /.*/, namespace: 'weather-test' }, () => ({ contents: `const store=new Map(); export function cacheRead(key){return store.get(key)||null};export function cacheWrite(key,value){store.set(key,{at:Date.now(),value})}`, loader: 'js' }))
  } }],
})
const { calculateSolarTimes, dateAtZone, parseWeatherForecast, weatherForToday, parseOpenMeteoCurrent, parseChinaWeather, getWeather, cacheWrite, cacheRead } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })
const place = { name: '宁波', latitude: 29.87, longitude: 121.55, timezone: 'Asia/Shanghai' }
const current = { city: '宁波', temperature: 26, apparent_temperature: 26, weather_code: 2, description: '多云', humidity: 63, wind_speed: 7, is_day: true, updated_at: '2026-10-02T12:00:00Z', provider: 'china' }
const rawForecast = (day, uv = 5.6) => ({ latitude: place.latitude, longitude: place.longitude, timezone: place.timezone, daily: { time: [day], uv_index_max: [uv], temperature_2m_min: [18.2], temperature_2m_max: [26.8] } })
const china = (name) => new Response(`var dataSK=${JSON.stringify({ cityname: name, temp: '26', weather: '多云', weathercode: 'd01', SD: '63%', wse: '7km/h' })};`)
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('solar times use the city date rather than the server or browser date', () => {
  const times = calculateSolarTimes(29.87, 121.55, 'Asia/Shanghai', new Date('2026-10-02T18:00:00Z'))
  assert.equal(times.solar_date, '2026-10-03')
  assert.equal(times.solar_source, 'calculated')
  assert.match(times.sunrise, /Z$/)
  for (const key of ['sunrise', 'solar_noon', 'sunset']) assert.equal(dateAtZone(new Date(times[key]), 'Asia/Shanghai'), '2026-10-03')
  const minutes = (key) => (Date.parse(times[key]) - Date.parse('2026-10-02T16:00:00Z')) / 60000
  // Ningbo in early October: sunrise ~05:50, solar noon ~11:43, sunset ~17:36.
  assert.ok(minutes('sunrise') > 340 && minutes('sunrise') < 365)
  assert.ok(minutes('solar_noon') > 695 && minutes('solar_noon') < 710)
  assert.ok(minutes('sunset') > 1040 && minutes('sunset') < 1065)
})

test('sunrise shifts with season and Chinese longitude, rather than fixed 06:00/12:00/18:00', () => {
  const summer = calculateSolarTimes(39.9, 116.41, 'Asia/Shanghai', new Date('2026-06-21T04:00:00Z'))
  const winter = calculateSolarTimes(39.9, 116.41, 'Asia/Shanghai', new Date('2026-12-21T04:00:00Z'))
  assert.ok(Date.parse(summer.sunset) - Date.parse(summer.sunrise) > 14 * 3600000)
  assert.ok(Date.parse(winter.sunset) - Date.parse(winter.sunrise) < 10 * 3600000)
  const west = calculateSolarTimes(43.83, 87.62, 'Asia/Shanghai', new Date('2026-06-21T04:00:00Z'))
  assert.ok(Date.parse(west.solar_noon) - Date.parse(summer.solar_noon) > 110 * 60000)
})

test('polar and invalid locations do not invent sunrise or sunset', () => {
  const polar = calculateSolarTimes(80, 15, 'Arctic/Longyearbyen', new Date('2026-06-21T04:00:00Z'))
  assert.equal(polar.sunrise, null)
  assert.equal(polar.sunset, null)
  assert.ok(polar.solar_noon)
  assert.equal(calculateSolarTimes(95, 0, 'UTC'), null)
  assert.equal(calculateSolarTimes(0, 181, 'UTC'), null)
  assert.equal(calculateSolarTimes(0, 0, 'invalid-timezone'), null)
})

test('date-line timezones put solar noon on the requested local date', () => {
  const times = calculateSolarTimes(1.87, -157.43, 'Pacific/Kiritimati', new Date('2026-03-20T12:00:00Z'))
  assert.equal(times.solar_date, '2026-03-21')
  assert.equal(dateAtZone(new Date(times.solar_noon), 'Pacific/Kiritimati'), '2026-03-21')
})

test('daily forecast selects the local date and reports UV as a daily maximum', () => {
  const raw = rawForecast('2026-10-03')
  raw.daily.time.unshift('2026-10-02')
  raw.daily.uv_index_max.unshift(1)
  raw.daily.temperature_2m_min.unshift(11)
  raw.daily.temperature_2m_max.unshift(14)
  const data = parseWeatherForecast(raw, place, new Date('2026-10-02T18:00:00Z'))
  assert.equal(data.forecast_date, '2026-10-03')
  assert.equal(data.uv_index, 5.6)
  assert.equal(data.uv_index_kind, 'daily_max')
  assert.equal(data.temperature_min, 18.2)
  assert.equal(data.temperature_max, 26.8)
})

test('missing, negative and null UV are unavailable, while zero is valid', () => {
  for (const uv of [null, undefined, '', -1]) {
    const raw = rawForecast('2026-10-03')
    raw.daily.uv_index_max = [uv]
    const data = parseWeatherForecast(raw, place, new Date('2026-10-03T04:00:00Z'))
    assert.equal(data.uv_index, null)
  }
  assert.equal(parseWeatherForecast(rawForecast('2026-10-03', 0), place, new Date('2026-10-03T04:00:00Z')).uv_index, 0)
  const data = parseWeatherForecast({ ...rawForecast('2026-10-02'), daily: {} }, place, new Date('2026-10-03T04:00:00Z'))
  assert.equal(data.uv_index, null)
  assert.equal(data.forecast_date, undefined)
})

test('stale disk weather still gets current solar times but never yesterday UV/temperature range', () => {
  const weather = weatherForToday({ ...current, solar_date: '2026-10-02', sunrise: '2026-10-01T22:00:00Z', uv_index: 9, temperature_min: 16, temperature_max: 30, forecast_date: '2026-10-02' }, '宁波', new Date('2026-10-02T18:00:00Z'))
  assert.equal(weather.solar_date, '2026-10-03')
  assert.equal(weather.timezone, 'Asia/Shanghai')
  assert.equal(weather.temperature, 26)
  assert.equal(weather.uv_index, null)
  assert.equal(weather.temperature_max, null)
  assert.equal(weather.is_day, false)
})

test('weather switches day/night using today solar boundaries even with cached day code', () => {
  const noon = weatherForToday(current, '宁波', new Date('2026-10-03T04:00:00Z'))
  const night = weatherForToday(current, '宁波', new Date('2026-10-03T15:00:00Z'))
  assert.equal(noon.is_day, true)
  assert.equal(night.is_day, false)
  const unknown = weatherForToday({ ...current, city: 'Unknown place' }, 'Unknown place')
  assert.equal(unknown.timezone, undefined)
  assert.equal(unknown.sunrise, undefined)
})

test('null upstream temperature is rejected instead of displaying false zero degrees', () => {
  assert.throws(() => parseOpenMeteoCurrent({ current: { temperature_2m: null, weather_code: 0 } }, '北京'), /数据不完整/)
  assert.throws(() => parseChinaWeather('var dataSK={"temp":null,"weather":"晴"};', '北京'), /数据不完整/)
  assert.equal(parseOpenMeteoCurrent({ current: { temperature_2m: 0, weather_code: 0 } }, '北京').temperature, 0)
})

test('China realtime returns without waiting for forecast, then concurrent readers share the supplement', async () => {
  let release
  let chinaCalls = 0, forecastCalls = 0
  const pending = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url) => {
    if (String(url).includes('weather.com.cn')) { chinaCalls++; return china('宁波') }
    forecastCalls++
    return pending
  }
  const first = await Promise.race([getWeather('宁波', 'china'), new Promise((_, reject) => setTimeout(() => reject(new Error('forecast blocked realtime')), 500).unref())])
  assert.equal(first.temperature, 26)
  assert.ok(first.sunrise)
  assert.equal(first.uv_index, null)
  await getWeather('宁波', 'china')
  assert.equal(chinaCalls, 1)
  assert.equal(forecastCalls, 1)
  release(new Response(JSON.stringify(rawForecast(dateAtZone(new Date(), 'Asia/Shanghai')))))
  await tick(); await tick()
  const enriched = await getWeather('宁波', 'china')
  assert.equal(enriched.uv_index, 5.6)
  assert.equal(enriched.forecast_provider, 'open-meteo')
  assert.equal(forecastCalls, 1)
})

test('failed optional forecast is throttled and preserves China realtime and solar times', async () => {
  let forecastCalls = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('weather.com.cn')) return china('杭州')
    forecastCalls++
    throw new Error('test offline')
  }
  const first = await getWeather('杭州', 'china')
  await tick()
  const second = await getWeather('杭州', 'china')
  assert.equal(first.temperature, 26)
  assert.equal(second.uv_index, null)
  assert.ok(second.sunrise)
  assert.equal(forecastCalls, 1)
})

test('fresh legacy disk caches gain solar context without refreshing realtime', async () => {
  const map = cacheRead('weather')?.value ?? {}
  cacheWrite('weather', { ...map, 'china::深圳': { at: Date.now(), data: { ...current, city: '深圳' } } })
  let realtimeCalls = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('weather.com.cn')) realtimeCalls++
    throw new Error('offline')
  }
  const result = await getWeather('深圳', 'china')
  assert.equal(realtimeCalls, 0)
  assert.equal(result.temperature, 26)
  assert.equal(result.timezone, 'Asia/Shanghai')
  assert.ok(result.solar_noon)
  await tick()
})

test('Open-Meteo gets current and daily detail in one request and keeps midnight dates consistent', async () => {
  let calls = 0
  const today = dateAtZone(new Date(), 'Asia/Shanghai')
  globalThis.fetch = async (url) => {
    calls++
    const query = new URL(String(url)).searchParams
    assert.match(query.get('current'), /temperature_2m/)
    assert.match(query.get('daily'), /uv_index_max/)
    assert.equal(query.get('timezone'), 'auto')
    return new Response(JSON.stringify({ ...rawForecast(today, 0), current: { temperature_2m: 18, weather_code: 0, is_day: 1, relative_humidity_2m: 63 } }))
  }
  const weather = await getWeather('上海', 'open-meteo')
  assert.equal(calls, 1)
  assert.equal(weather.provider, 'open-meteo')
  assert.equal(weather.forecast_date, today)
  assert.equal(weather.solar_date, today)
  assert.equal(weather.uv_index, 0)
  assert.ok(weather.solar_noon)
})
