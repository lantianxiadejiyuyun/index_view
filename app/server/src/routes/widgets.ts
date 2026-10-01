/**
 * 小组件：天气 / 每日一言。
 *
 * 契约（前端依赖，勿改字段名）：
 *
 *   GET /api/widgets/weather?city=北京
 *     → { city, temperature, apparent_temperature, weather_code, description,
 *         humidity, wind_speed, is_day, updated_at, provider }
 *   GET /api/widgets/hitokoto
 *     → { text, source, author }
 *
 * 两个接口都**不挂 requireAuth**：首页游客也要能看到小组件。
 *
 * 分工：本文件只做「读设置 → 调 lib → 把错误翻译成 HTTP」，
 * 取数、缓存、降级一律在 lib/weather.ts 与 lib/hitokoto.ts 里，
 * 这样换天气源（PLAN §12：天气接口需要 Key 或有额度限制）时不必动路由。
 *
 * 错误策略：天气失败返回结构化错误（404 城市没找到 / 502 上游挂了），
 * 前端据此隐藏小组件而不是显示报错；每日一言则永远返回 200（最差是内置语句）。
 */
import { Hono } from 'hono'
import { getSetting } from '../db/schema.js'
import { getHitokoto } from '../lib/hitokoto.js'
import { DEFAULT_WEATHER_CITY, WeatherError, getWeather } from '../lib/weather.js'
import type { AppEnv } from '../types.js'

export const widgetRoutes = new Hono<AppEnv>()

/** 城市名限长：避免有人塞超长字符串把我们当代理去打上游 */
const MAX_CITY_LEN = 40

widgetRoutes.get('/widgets/weather', async (c) => {
  // 优先级：查询参数 → 设置项 weather_city → 默认城市
  const queryCity = (c.req.query('city') ?? '').trim().slice(0, MAX_CITY_LEN)
  const settingCity = (getSetting('weather_city') ?? '').trim().slice(0, MAX_CITY_LEN)
  const city = queryCity || settingCity || DEFAULT_WEATHER_CITY

  // provider 由设置项决定；未实现的名字在 lib 里回落 open-meteo，不会报错
  const provider = getSetting('weather_provider')

  try {
    const data = await getWeather(city, provider)
    // ⚠️ 这里**不能**发 `public, max-age=...`。
    // 宝塔给反代站点默认开了 proxy_cache，nginx 只缓存带可缓存头的响应 ——
    // 之前发的 `public, max-age=300` 让天气和一言被 nginx 缓存了 5 分钟，
    // 一言的「每刷一次换一句」直接失效（实测：直连应用 5 次拿到 5 条不同的，
    // 走 nginx 永远是同一句）。
    // 真正的缓存已经在服务端做了（3 小时 + 后台刷新），响应本身是毫秒级的，
    // 不需要任何中间层再缓存一遍。
    return c.json(data, 200, { 'Cache-Control': 'no-store' })
  } catch (err) {
    if (err instanceof WeatherError) {
      if (err.code === 'city_not_found') {
        return c.json({ error: 'city_not_found', message: err.message }, 404)
      }
      console.warn(`[widgets] 天气获取失败：${err.message}`)
      return c.json({ error: 'upstream_failed', message: err.message }, 502)
    }
    // 兜底：lib 里没预料到的异常也不能把 500 HTML 甩给前端
    console.error('[widgets] 天气接口未预期异常', err)
    return c.json({ error: 'upstream_failed', message: '天气服务暂时不可用，请稍后再试' }, 502)
  }
})

widgetRoutes.get('/widgets/hitokoto', async (c) => {
  // getHitokoto() 内部保证不抛错（外部接口挂了就返回内置语句并在服务端 warn），
  // 而且是从后台预取好的池子里轮着拿 —— 本地操作，毫秒级
  const data = await getHitokoto()
  // no-store 见上面天气那段注释：发了可缓存头就会被宝塔的 nginx 缓存住，
  // 而这个接口的意义就是「每次打开换一句」
  return c.json(data, 200, { 'Cache-Control': 'no-store' })
})
