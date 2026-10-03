/**
 * 天气 provider 抽象 + 内存缓存。
 *
 * 天气是典型的「随时会变」的外部依赖：免费接口可能挂、可能限流、也可能哪天
 * 开始要 Key（PLAN §12 风险表正是这么写的）。所以这里把两件事拆开：
 *   - 「怎么取数」→ WeatherProvider 接口，换源只需新增一个实现；
 *   - 「怎么缓存 / 怎么合并并发」→ 本文件统一的 getWeather()。
 * 路由层只认 getWeather(city, providerName)，不关心背后是谁。
 *
 * 实况优先走中国天气网，支持 Open-Meteo 回退；后者同时提供独立缓存的
 * UV 日峰值与最高/最低温度。日出、太阳正午、日落按城市坐标本地估算。
 */

import { lookupCityCode } from './city-codes.js'
import { lookupCity } from './cities.js'
import { cacheRead, cacheWrite } from './widget-cache.js'
import { calculateSolarTimes, dateAtZone, validTimeZone } from './weather-solar.js'

/** 外部接口超时 6 秒：天气是给人看的小组件，宁可先不显示也别把首页挂着 */
const TIMEOUT_MS = 6000

/**
 * 天气缓存 3 小时。
 *
 * 之前是 10 分钟，但**每次过期都要用户等一次外部请求** —— 首页上那个组件
 * 会有明显的「先空一下再出现」。改成 3 小时后，绝大多数访问都是直接命中缓存；
 * 而且配合下面的「先返回旧的、后台再刷新」，刷新永远不会卡住用户。
 * open-meteo 的实况本来就是十几分钟一档，3 小时对「今天穿什么」这个用途足够。
 */
const CACHE_TTL_MS = 3 * 60 * 60 * 1000

/** 落盘缓存的 key（见 lib/widget-cache.ts） */
const DISK_KEY_WEATHER = 'weather'
const DISK_KEY_GEOCODE = 'geocode'

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

/**
 * 中国天气网的实况接口。**免 Key、国内直连**。
 *
 * 实测从国内服务器 19ms 返回（open-meteo 要 877ms，因为要绕到德国），
 * 而且不受「某个国外主机被阻断」的影响 —— 这正是引入它的原因。
 *
 * 返回的不是纯 JSON，是 `var dataSK={...};`，要先剥掉前缀。
 * 编码是 UTF-8（虽然 Content-Type 没写 charset），直接按文本读即可。
 */
const CHINA_WEATHER_URL = 'http://d1.weather.com.cn/sk_2d'

/** 这个接口要求带 Referer，否则返回 403 */
const CHINA_REFERER = 'http://www.weather.com.cn/'

const UA = 'home-dashboard/0.1 (weather widget)'

/** 查询参数、设置项都为空时的兜底城市 */
export const DEFAULT_WEATHER_CITY = '北京'

/** 默认（也是当前唯一）的 provider 名字，会原样出现在响应的 provider 字段里 */
export const DEFAULT_PROVIDER_NAME = 'open-meteo'

/** 国内 provider 的名字 */
export const CHINA_PROVIDER_NAME = 'china'

/** 设置项为空时用哪个。默认走国内的：免 Key、快 40 倍、不受墙影响 */
export const PREFERRED_PROVIDER_NAME = CHINA_PROVIDER_NAME

/** 前端契约，字段名不可改 */
export type WeatherData = {
  city: string
  temperature: number
  apparent_temperature: number
  weather_code: number
  description: string
  humidity: number
  wind_speed: number
  is_day: boolean
  updated_at: string
  provider: string
  latitude?: number
  longitude?: number
  timezone?: string
  solar_date?: string
  sunrise?: string | null
  solar_noon?: string | null
  sunset?: string | null
  solar_source?: 'calculated'
  /** Open-Meteo's forecast daily maximum, never a current UV measurement. */
  uv_index?: number | null
  uv_index_kind?: 'daily_max'
  temperature_min?: number | null
  temperature_max?: number | null
  forecast_date?: string
  forecast_provider?: 'open-meteo'
}

export type WeatherErrorCode = 'city_not_found' | 'upstream_failed'

/**
 * 天气错误分两类，路由据此映射成 404 / 502。
 * 用专门的错误类型而不是返回 null，是为了让「城市没找到」和「上游挂了」
 * 在调用链上不会被混为一谈。
 */
export class WeatherError extends Error {
  readonly code: WeatherErrorCode

  constructor(code: WeatherErrorCode, message: string) {
    super(message)
    this.name = 'WeatherError'
    this.code = code
  }
}

// ── WMO weather_code → 中文描述 ────────────────────────────────
// open-meteo 只给数字码，前端要的是人话。这张表按 WMO Code Table 4677
// 逐条写全，查不到的一律「未知」，保证前端永远拿到一个非空字符串。
const WMO_TEXT: Record<number, string> = {
  0: '晴',
  1: '基本晴',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '中毛毛雨',
  55: '大毛毛雨',
  56: '轻度冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '轻度冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '中阵雨',
  82: '大阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '雷阵雨伴冰雹',
}

/** weather_code → 中文描述；未知码返回「未知」而不是抛错 */
export function describeWeather(code: number): string {
  return WMO_TEXT[code] ?? '未知'
}

// ── provider 抽象 ─────────────────────────────────────────────

export interface WeatherProvider {
  readonly name: string
  /** 取数失败时抛 WeatherError，其它异常视为 upstream_failed */
  fetchWeather(city: string): Promise<WeatherData>
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim()) || typeof v === 'boolean') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

type OpenMeteoCurrent = {
  temperature_2m?: unknown
  relative_humidity_2m?: unknown
  apparent_temperature?: unknown
  is_day?: unknown
  weather_code?: unknown
  wind_speed_10m?: unknown
}

/**
 * 把 open-meteo 的 current 段翻译成前端契约。
 * 单独导出是为了能脱离网络直接做单元验证（解析逻辑的正确性不该依赖外网）。
 */
export function parseOpenMeteoCurrent(raw: unknown, city: string): WeatherData {
  const current = (raw as { current?: OpenMeteoCurrent } | null | undefined)?.current
  const temperature = num(current?.temperature_2m)
  const weatherCode = num(current?.weather_code)

  // 温度和天气码缺了就没法展示，直接认作上游数据不完整
  if (temperature === null || weatherCode === null) {
    throw new WeatherError('upstream_failed', '天气服务返回的数据不完整')
  }

  return {
    city,
    temperature: round1(temperature),
    // 体感温度缺失时退化成气温，总比显示 0 度强
    apparent_temperature: round1(num(current?.apparent_temperature) ?? temperature),
    weather_code: weatherCode,
    description: describeWeather(weatherCode),
    humidity: Math.round(num(current?.relative_humidity_2m) ?? 0),
    wind_speed: round1(num(current?.wind_speed_10m) ?? 0),
    is_day: (num(current?.is_day) ?? 1) === 1,
    updated_at: new Date().toISOString(),
    provider: DEFAULT_PROVIDER_NAME,
  }
}

/** 统一的取 JSON：超时 / DNS 失败 / 非 2xx / 非 JSON 都收敛成 upstream_failed */
async function requestJson(url: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': UA },
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new WeatherError(
      'upstream_failed',
      timedOut ? `天气服务响应超时（${TIMEOUT_MS / 1000} 秒）` : '无法连接天气服务，请检查服务器网络',
    )
  }

  if (!res.ok) {
    throw new WeatherError('upstream_failed', `天气服务返回 HTTP ${res.status}`)
  }

  try {
    return await res.json()
  } catch {
    throw new WeatherError('upstream_failed', '天气服务返回的不是合法 JSON')
  }
}

type GeocodeHit = { name?: unknown; latitude?: unknown; longitude?: unknown; timezone?: unknown }
type Place = { name: string; latitude: number; longitude: number; timezone?: string }

/**
 * 城市名 → 经纬度。三级查找，越靠前越省事：
 *
 *   1. **内置表**（lib/cities.ts）—— 零网络。常用城市全走这条；
 *      geocoding 那个主机从国内连不上（见那个文件的说明），所以这一步是线上能不能用的关键
 *   2. **落盘缓存** —— 以前在线解析成功过的城市，重启后仍然有效
 *   3. **在线 geocoding** —— 只对表里没有的生僻城市生效；解析成功就记下来
 */
async function geocode(city: string): Promise<Place> {
  const builtin = lookupCity(city)
  if (builtin) return builtin

  const cached = cacheRead<Record<string, Place>>(DISK_KEY_GEOCODE)?.value
  const key = city.trim().toLowerCase()
  const remembered = cached?.[key]
  if (remembered) return remembered

  const url = `${GEOCODING_URL}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`
  const json = (await requestJson(url)) as { results?: GeocodeHit[] } | null
  const hit = json?.results?.[0]

  const latitude = num(hit?.latitude)
  const longitude = num(hit?.longitude)
  if (!hit || latitude === null || longitude === null) {
    throw new WeatherError('city_not_found', `没有找到城市：${city}`)
  }

  // 用上游返回的规范名（例如输入拼音也能回成中文名），拿不到就用用户输入
  const name = typeof hit.name === 'string' && hit.name.trim() ? hit.name.trim() : city
  const place: Place = { name, latitude, longitude, ...(validTimeZone(hit.timezone) ? { timezone: hit.timezone } : {}) }

  // 记下来，下次这个城市就不用再联网解析了
  cacheWrite(DISK_KEY_GEOCODE, { ...(cached ?? {}), [key]: place })
  return place
}

const openMeteoProvider: WeatherProvider = {
  name: DEFAULT_PROVIDER_NAME,

  async fetchWeather(city: string): Promise<WeatherData> {
    const place = await geocode(city)

    const query = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current:
        'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
      daily: 'uv_index_max,temperature_2m_max,temperature_2m_min',
      forecast_days: '2',
      timezone: 'auto',
    })

    const raw = await requestJson(`${FORECAST_URL}?${query}`)
    return { ...parseOpenMeteoCurrent(raw, place.name), ...parseWeatherForecast(raw, place) }
  },
}

type ForecastData = Pick<WeatherData, 'latitude' | 'longitude' | 'timezone' | 'uv_index' | 'uv_index_kind' | 'temperature_min' | 'temperature_max' | 'forecast_date' | 'forecast_provider'>

/** Only select the requested city's local day; null upstream values stay unavailable. */
export function parseWeatherForecast(raw: unknown, place: Place, now = new Date()): ForecastData {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const timezone = validTimeZone(source.timezone) ? source.timezone : validTimeZone(place.timezone) ? place.timezone : undefined
  const latitude = num(source.latitude) ?? place.latitude
  const longitude = num(source.longitude) ?? place.longitude
  const result: ForecastData = { latitude, longitude, ...(timezone ? { timezone } : {}), uv_index: null, uv_index_kind: 'daily_max', temperature_min: null, temperature_max: null }
  if (!timezone) return result
  const daily = source.daily && typeof source.daily === 'object' ? source.daily as Record<string, unknown> : {}
  const today = dateAtZone(now, timezone)
  const index = Array.isArray(daily.time) ? daily.time.indexOf(today) : -1
  if (index < 0) return result
  const value = (key: string) => Array.isArray(daily[key]) ? num(daily[key][index]) : null
  const uv = value('uv_index_max')
  return { ...result, uv_index: uv !== null && uv >= 0 ? round1(uv) : null, temperature_min: value('temperature_2m_min'), temperature_max: value('temperature_2m_max'), forecast_date: today, forecast_provider: 'open-meteo' }
}

/** Refresh solar times even when temperature comes from an old disk cache. */
export function weatherForToday(data: WeatherData, city = data.city, now = new Date()): WeatherData {
  const builtin = lookupCity(data.city) ?? lookupCity(city)
  const domestic = !!lookupCityCode(data.city) || !!lookupCityCode(city)
  const latitude = num(data.latitude) ?? (domestic ? builtin?.latitude : undefined)
  const longitude = num(data.longitude) ?? (domestic ? builtin?.longitude : undefined)
  const timezone = validTimeZone(data.timezone) ? data.timezone : domestic ? 'Asia/Shanghai' : undefined
  const context = { ...data, ...(latitude !== undefined ? { latitude } : {}), ...(longitude !== undefined ? { longitude } : {}), ...(timezone ? { timezone } : {}) }
  const solar = latitude !== undefined && longitude !== undefined && timezone ? calculateSolarTimes(latitude, longitude, timezone, now) : null
  const today = timezone ? dateAtZone(now, timezone) : null
  const isDay = solar?.sunrise && solar.sunset ? now.getTime() >= Date.parse(solar.sunrise) && now.getTime() < Date.parse(solar.sunset) : data.is_day
  return {
    ...context, ...(solar ?? {}), is_day: isDay,
    ...(data.forecast_date && data.forecast_date === today ? {} : { uv_index: null, uv_index_kind: 'daily_max' as const, temperature_min: null, temperature_max: null, forecast_date: undefined, forecast_provider: undefined }),
  }
}

// UV and high/low temperature use a separate optional forecast. In particular, an
// unreachable international endpoint must never block China's realtime provider.
const FORECAST_DISK_KEY = 'weather-forecast-v1'
const FORECAST_RETRY_MS = 15 * 60 * 1000
type ForecastEntry = { at: number; data: ForecastData }
const forecastCache = new Map<string, ForecastEntry>()
const forecastInflight = new Map<string, Promise<void>>()
const forecastAttempts = new Map<string, number>()

function forecastSnapshot(key: string): ForecastEntry | undefined {
  return forecastCache.get(key) ?? cacheRead<Record<string, ForecastEntry>>(FORECAST_DISK_KEY)?.value?.[key]
}

function rememberForecast(key: string, data: ForecastData): void {
  const entry = { at: Date.now(), data }
  forecastCache.set(key, entry)
  cacheWrite(FORECAST_DISK_KEY, { ...(cacheRead<Record<string, ForecastEntry>>(FORECAST_DISK_KEY)?.value ?? {}), [key]: entry })
}

function requestForecast(key: string, city: string, weather: WeatherData): void {
  const entry = forecastSnapshot(key)
  const today = validTimeZone(entry?.data.timezone) ? dateAtZone(new Date(), entry.data.timezone) : undefined
  if (entry && today && Date.now() - entry.at < CACHE_TTL_MS && entry.data.forecast_date === today) return
  if (forecastInflight.has(key) || Date.now() - (forecastAttempts.get(key) ?? 0) < FORECAST_RETRY_MS) return
  forecastAttempts.set(key, Date.now())
  const task = (async () => {
    const coordinates = num(weather.latitude) !== null && num(weather.longitude) !== null
      ? { name: weather.city, latitude: weather.latitude!, longitude: weather.longitude!, timezone: weather.timezone }
      : await geocode(city)
    const query = new URLSearchParams({ latitude: String(coordinates.latitude), longitude: String(coordinates.longitude), timezone: coordinates.timezone ?? 'auto', forecast_days: '2', daily: 'uv_index_max,temperature_2m_max,temperature_2m_min' })
    const forecast = parseWeatherForecast(await requestJson(`${FORECAST_URL}?${query}`), coordinates)
    rememberForecast(key, forecast)
  })().catch(() => {
    // Optional data remains null; temperature, city and offline solar times survive.
  })
  forecastInflight.set(key, task)
  void task.finally(() => forecastInflight.delete(key))
}

function enrichWeather(key: string, city: string, data: WeatherData): WeatherData {
  if (data.provider === DEFAULT_PROVIDER_NAME && data.forecast_date && validTimeZone(data.timezone) && data.forecast_date === dateAtZone(new Date(), data.timezone)) {
    return weatherForToday(data, city)
  }
  const forecast = forecastSnapshot(key)?.data
  const weather = weatherForToday({ ...data, ...(forecast ?? {}) }, city)
  requestForecast(key, city, weather)
  return weather
}

// ── 中国天气网 ────────────────────────────────────────────────

/**
 * 中国天气网的天气码 → WMO 码。
 *
 * 前端那套图标是按 WMO 码写的，国内这套是另一张表，
 * 所以在这里翻译一次，前端不用知道背后换过源。
 * 表见中国气象局的《天气现象编码》，这里只映射到前端认得的那几个 WMO 值。
 */
const CN_WMO: Record<string, number> = {
  '00': 0, // 晴
  '01': 2, // 多云
  '02': 3, // 阴
  '03': 80, // 阵雨
  '04': 95, // 雷阵雨
  '05': 96, // 雷阵雨伴有冰雹
  '06': 71, // 雨夹雪（前端没有对应码，按雪显示）
  '07': 61, // 小雨
  '08': 63, // 中雨
  '09': 65, // 大雨
  '10': 65, // 暴雨
  '11': 65, // 大暴雨
  '12': 65, // 特大暴雨
  '13': 85, // 阵雪
  '14': 71, // 小雪
  '15': 73, // 中雪
  '16': 75, // 大雪
  '17': 75, // 暴雪
  '18': 45, // 雾
  '19': 66, // 冻雨
  '20': 45, // 沙尘暴（没有更贴切的图标，用雾）
  '21': 63, // 小到中雨
  '22': 65, // 中到大雨
  '23': 65, // 大到暴雨
  '24': 65, // 暴雨到大暴雨
  '25': 65, // 大暴雨到特大暴雨
  '26': 73, // 小到中雪
  '27': 75, // 中到大雪
  '28': 75, // 大到暴雪
  '29': 45, // 浮尘
  '30': 45, // 扬沙
  '31': 45, // 强沙尘暴
  '53': 45, // 霾
}

/** 单位里带出来的数字，例如 "7km/h" → 7、"61%" → 61 */
function leadingNumber(v: unknown): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(String(v ?? ''))
  return m ? Number(m[0]) : null
}

type ChinaRaw = {
  cityname?: unknown
  temp?: unknown
  SD?: unknown
  wse?: unknown
  weather?: unknown
  weathercode?: unknown
  time?: unknown
}

/**
 * 把中国天气网的响应当成一段 JS 文本解析。
 *
 * 单独导出是为了能脱离网络做单元验证 —— 这段剥前缀 + 取字段的逻辑
 * 才是最容易写错的地方（响应不是合法 JSON，直接 JSON.parse 会炸）。
 */
export function parseChinaWeather(raw: string, fallbackName: string): WeatherData {
  // 形如：var dataSK={"nameen":...};
  const json = /\{[\s\S]*\}/.exec(raw)?.[0]
  if (!json) throw new WeatherError('upstream_failed', '天气服务返回的内容无法解析')

  let data: ChinaRaw
  try {
    data = JSON.parse(json) as ChinaRaw
  } catch {
    throw new WeatherError('upstream_failed', '天气服务返回的不是合法数据')
  }

  const temperature = num(data.temp)
  const text = typeof data.weather === 'string' ? data.weather.trim() : ''
  if (temperature === null || !text) {
    throw new WeatherError('upstream_failed', '天气服务返回的数据不完整')
  }

  // weathercode 形如 "d02" / "n18"：字母表示白天(d)还是夜间(n)，数字是天气码
  const code = typeof data.weathercode === 'string' ? data.weathercode.trim() : ''
  const isDay = code ? code[0] !== 'n' : true
  const numeric = code.replace(/^[a-z]/i, '').padStart(2, '0')
  // 表里没有的码就按「多云」处理，别让图标空着
  const wmo = CN_WMO[numeric] ?? 2

  const name = typeof data.cityname === 'string' && data.cityname.trim() ? data.cityname.trim() : fallbackName

  return {
    city: name,
    temperature: round1(temperature),
    // 国内接口不给体感温度，退回气温（和 open-meteo 缺字段时的处理一致）
    apparent_temperature: round1(temperature),
    weather_code: wmo,
    description: text,
    humidity: Math.round(leadingNumber(data.SD) ?? 0),
    wind_speed: round1(leadingNumber(data.wse) ?? 0),
    is_day: isDay,
    updated_at: new Date().toISOString(),
    provider: CHINA_PROVIDER_NAME,
  }
}

/** 取纯文本（中国天气网返回的是 `var dataSK={...}`，不是 JSON） */
async function requestText(url: string, referer?: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: '*/*',
        'user-agent': UA,
        ...(referer ? { referer } : {}),
      },
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new WeatherError(
      'upstream_failed',
      timedOut ? `天气服务响应超时（${TIMEOUT_MS / 1000} 秒）` : '无法连接天气服务，请检查服务器网络',
    )
  }

  if (!res.ok) throw new WeatherError('upstream_failed', `天气服务返回 HTTP ${res.status}`)
  return await res.text()
}

const chinaProvider: WeatherProvider = {
  name: CHINA_PROVIDER_NAME,

  async fetchWeather(city: string): Promise<WeatherData> {
    const code = lookupCityCode(city)

    // 表里没有的城市交给 open-meteo —— 它按经纬度查，能覆盖任意地方。
    // 有了内置表（359 个城市）这条分支很少走到，但用生僻地名的人不该直接报错。
    if (!code) return openMeteoProvider.fetchWeather(city)

    try {
      return parseChinaWeather(await requestText(`${CHINA_WEATHER_URL}/${code}.html`, CHINA_REFERER), city)
    } catch (err) {
      // 国内接口偶尔抽风（或哪天改了协议）时退回 open-meteo，
      // 别让首页那个组件直接空掉。两边的缓存是分开的，不会互相污染。
      console.warn(
        `[weather] 中国天气网取「${city}」失败，改试 open-meteo：`,
        err instanceof Error ? err.message : err,
      )
      return openMeteoProvider.fetchWeather(city)
    }
  },
}

/** 已注册的 provider；将来加源只需往这里塞一个实现 */
const PROVIDERS = new Map<string, WeatherProvider>([
  [chinaProvider.name, chinaProvider],
  [openMeteoProvider.name, openMeteoProvider],
])

// 只对每个陌生名字 warn 一次，避免设置项写错后刷屏
const warnedProviders = new Set<string>()

/**
 * 解析 provider 名，未实现/为空时用国内那个。
 *
 * 默认换成国内的原因：open-meteo 要绕到德国（实测 877ms），而且它的
 * geocoding 主机从国内根本连不上；中国天气网 19ms 且不受墙影响。
 * 设置里显式写了 open-meteo 就尊重设置。
 */
export function resolveProvider(name?: string | null): WeatherProvider {
  const wanted = (name ?? '').trim().toLowerCase()
  const found = PROVIDERS.get(wanted)
  if (found) return found

  if (wanted && !warnedProviders.has(wanted)) {
    warnedProviders.add(wanted)
    console.warn(`[weather] 未实现的 provider「${wanted}」，已回落到 ${PREFERRED_PROVIDER_NAME}`)
  }

  const fallback = PROVIDERS.get(PREFERRED_PROVIDER_NAME)
  if (!fallback) throw new WeatherError('upstream_failed', '天气 provider 未注册')
  return fallback
}

// ── 缓存 ──────────────────────────────────────────────────────

type CacheEntry = { at: number; data: WeatherData }

const cache = new Map<string, CacheEntry>()
/** 同一 key 正在进行的请求：多个并发调用共用同一个 Promise，外部接口只打一次 */
const inflight = new Map<string, Promise<WeatherData>>()

/** 落盘那份（多个城市共用一条记录） */
function readDiskMap(): Record<string, CacheEntry> {
  return cacheRead<Record<string, CacheEntry>>(DISK_KEY_WEATHER)?.value ?? {}
}

function writeDisk(key: string, entry: CacheEntry): void {
  cacheWrite(DISK_KEY_WEATHER, { ...readDiskMap(), [key]: entry })
}

/**
 * 缓存 key 一律带上 provider 名。
 *
 * 早先是「默认 provider 就不加前缀」，但默认值后来从 open-meteo 换成了国内源 ——
 * 那样老缓存会被新源读到，显示的还是上一个源的数据。带上名字就没这个歧义了。
 */
function cacheKey(city: string, providerName: string): string {
  return `${providerName}::${city}`
}

/**
 * 真正去打一次外部接口。并发去重，成功写回内存 + 落盘。
 * 失败不写缓存 —— 上游恢复后应当立刻能自愈。
 */
function refresh(key: string, city: string, provider: WeatherProvider): Promise<WeatherData> {
  const running = inflight.get(key)
  if (running) return running

  const task = provider.fetchWeather(city).then((data) => {
    const entry = { at: Date.now(), data }
    cache.set(key, entry)
    writeDisk(key, entry)
    return data
  })

  inflight.set(key, task)
  // 两个分支都要清掉，否则失败一次会把后来的请求永远挂在这个已 reject 的 Promise 上
  const clear = () => inflight.delete(key)
  task.then(clear, clear)

  return task
}

/**
 * 取天气。
 *
 * 三种情况：
 *   1. 有缓存且没过期 → 直接返回，**零外部请求**
 *   2. 有缓存但过期了 → **立刻返回旧值**，同时在后台刷新
 *      （这是关键：刷新不再让用户等，首页那个组件也不会「先空一下」）
 *   3. 完全没缓存 → 只能等这一次（首次启动、或换了个从没查过的城市）
 */
export async function getWeather(city: string, providerName?: string | null): Promise<WeatherData> {
  const provider = resolveProvider(providerName)
  const key = cacheKey(city, provider.name)

  const fresh = cache.get(key) ?? readDiskMap()[key]

  if (fresh) {
    if (Date.now() - fresh.at < CACHE_TTL_MS) return enrichWeather(key, city, fresh.data)

    // 过期：先给旧的，后台去换新的。失败也无所谓，下次请求还会再试
    refresh(key, city, provider).catch((err: unknown) => {
      console.warn(
        `[weather] 后台刷新「${city}」失败，继续用 ${Math.round((Date.now() - fresh.at) / 60000)} 分钟前的数据：`,
        err instanceof Error ? err.message : err,
      )
    })
    return enrichWeather(key, city, fresh.data)
  }

  return enrichWeather(key, city, await refresh(key, city, provider))
}

/**
 * 后台预热：启动时和定时任务调用。
 *
 * 「先返回旧的、后台刷新」只在**已经有过一次成功**之后才成立；
 * 实例刚起来、或者刚换了城市时，第一个访问的人仍然要等。
 * 所以进程启动后主动查一次，把缓存填上。
 */
export function prewarmWeather(city: string, providerName?: string | null): void {
  const provider = resolveProvider(providerName)
  const key = cacheKey(city, provider.name)
  const fresh = cache.get(key) ?? readDiskMap()[key]
  if (fresh && Date.now() - fresh.at < CACHE_TTL_MS) {
    enrichWeather(key, city, fresh.data)
    return
  }

  refresh(key, city, provider).then((data) => enrichWeather(key, city, data)).catch((err: unknown) => {
    console.warn('[weather] 预热失败：', err instanceof Error ? err.message : err)
  })
}
