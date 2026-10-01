/**
 * 每日一言 provider + 后台预取的池子。
 *
 * hitokoto 是个人站点最爱用的公共接口，但它完全免费、没有 SLA，
 * 历史上限流和 5xx 都不稀奇。而「每日一言」这玩意儿字面意义上就是装饰，
 * 为了它让首页报错是不可接受的——所以这里的硬性约定是：
 * **本模块永远不抛异常，最差返回内置语句。**
 * 降级时只在服务端 console.warn 记一笔，响应里不加任何标记（前端不关心来源）。
 *
 * ── 池子 ──
 * 每次请求都去调外部接口的话，首页那个组件会「先空一下再出现」。
 * 所以进程启动时**后台预取一池**（落盘保存），请求直接从池子里轮着拿：
 * 零延迟，而且每刷一次换一句。
 */

import { cacheRead, cacheWrite } from './widget-cache.js'

/** 外部接口超时 6 秒，与天气保持一致 */
const TIMEOUT_MS = 6000

/** 前端契约，字段名不可改 */
export type Hitokoto = {
  text: string
  source: string
  author: string
}

/** 兜底语句：外部接口不可用时从这里随机取一条，保证首页永远有字可看 */
const FALLBACK_QUOTES: readonly Hitokoto[] = [
  { text: '千里之行，始于足下。', source: '《老子》', author: '老子' },
  { text: '不积跬步，无以至千里；不积小流，无以成江海。', source: '《荀子·劝学》', author: '荀子' },
  { text: '锲而不舍，金石可镂。', source: '《荀子·劝学》', author: '荀子' },
  { text: '长风破浪会有时，直挂云帆济沧海。', source: '《行路难》', author: '李白' },
  { text: '会当凌绝顶，一览众山小。', source: '《望岳》', author: '杜甫' },
  { text: '山重水复疑无路，柳暗花明又一村。', source: '《游山西村》', author: '陆游' },
  { text: '纸上得来终觉浅，绝知此事要躬行。', source: '《冬夜读书示子聿》', author: '陆游' },
  { text: '博观而约取，厚积而薄发。', source: '《稼说送张琥》', author: '苏轼' },
  { text: '路漫漫其修远兮，吾将上下而求索。', source: '《离骚》', author: '屈原' },
  { text: '天行健，君子以自强不息。', source: '《周易·乾卦》', author: '' },
  { text: '有志者，事竟成。', source: '《后汉书·耿弇传》', author: '' },
  { text: '宝剑锋从磨砺出，梅花香自苦寒来。', source: '《警世贤文》', author: '' },
  { text: '九层之台，起于累土。', source: '《老子》', author: '老子' },
  { text: '问渠那得清如许？为有源头活水来。', source: '《观书有感》', author: '朱熹' },
  { text: '沉舟侧畔千帆过，病树前头万木春。', source: '《酬乐天扬州初逢席上见赠》', author: '刘禹锡' },
  { text: '海内存知己，天涯若比邻。', source: '《送杜少府之任蜀州》', author: '王勃' },
  { text: '但行好事，莫问前程。', source: '《增广贤文》', author: '' },
  { text: '苟日新，日日新，又日新。', source: '《礼记·大学》', author: '' },
  { text: '凡是过往，皆为序章。', source: '《暴风雨》', author: '威廉·莎士比亚' },
  { text: '愿你出走半生，归来仍是少年。', source: '网络佚名', author: '' },
]

/** 兜底的兜底：数组理论上不会为空，但类型上必须给一个确定值 */
const LAST_RESORT: Hitokoto = { text: '今天也要好好生活。', source: '内置', author: '' }

type Pool = { at: number; quotes: Hitokoto[] }

/** 落盘缓存的 key（见 lib/widget-cache.ts） */
const DISK_KEY = 'hitokoto'

/**
 * 池子目标大小。
 *
 * 原来是「取一句、缓存 30 分钟」—— 那么每次打开首页要么等一次外部请求，
 * 要么 30 分钟里看到的是同一句。改成**后台预取一池**：
 * 请求永远是从池子里拿（零延迟），而且每刷一次换一句。
 */
const POOL_TARGET = 12

/** 池子里少于这么多条就去后台补 */
const POOL_LOW = 4

/** 池子整体超过这么久没用上新数据就补一次（防止全是几个月前的老句子） */
const POOL_TTL_MS = 6 * 60 * 60 * 1000

/** 一次补多少条 */
const REFILL_BATCH = 6

const HITOKOTO_URL = 'https://v1.hitokoto.cn/?encode=json'

const UA = 'home-dashboard/0.1 (hitokoto widget)'

/** 随机取一条内置语句（不复用副本，避免调用方改动污染常量表） */
export function pickFallbackQuote(): Hitokoto {
  const index = Math.floor(Math.random() * FALLBACK_QUOTES.length)
  const picked = FALLBACK_QUOTES[index] ?? FALLBACK_QUOTES[0] ?? LAST_RESORT
  return { text: picked.text, source: picked.source, author: picked.author }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 把 hitokoto 的原始响应翻译成契约。
 * 单独导出便于脱离网络验证解析逻辑（from_who 为 null 时要变成空字符串）。
 */
export function parseHitokoto(raw: unknown): Hitokoto | null {
  const body = raw as { hitokoto?: unknown; from?: unknown; from_who?: unknown } | null | undefined
  const text = str(body?.hitokoto)
  if (!text) return null
  return {
    text,
    source: str(body?.from),
    // 作者经常为 null，前端要的是字符串，这里统一成空串
    author: str(body?.from_who),
  }
}

async function fetchRemote(): Promise<Hitokoto> {
  // 必须带一个随机参数。接口前面挂着 CDN，同一个 URL 会被缓存 ——
  // 实测并发取 6 条，6 条拿到的是**完全相同的一句**（池子里于是全是重复的）。
  const url = `${HITOKOTO_URL}&_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': UA, 'cache-control': 'no-cache' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const parsed = parseHitokoto(await res.json())
  if (!parsed) throw new Error('响应里没有 hitokoto 字段')
  return parsed
}

// ── 池子 ──────────────────────────────────────────────────────

/** 内存里的池子；首次访问时从落盘那份恢复 */
let pool: Hitokoto[] | null = null
/** 轮转游标：每请求一次往前走一格，这样连着刷不会老看到同一句 */
let cursor = 0
let refilling: Promise<void> | null = null
let poolAt = 0

function loadPool(): Hitokoto[] {
  if (pool) return pool
  const disk = cacheRead<Pool>(DISK_KEY)
  pool = Array.isArray(disk?.value?.quotes) ? disk.value.quotes : []
  poolAt = disk?.at ?? 0
  return pool
}

function savePool(): void {
  const quotes = pool ?? []
  if (quotes.length > 0) {
    poolAt = Date.now()
    cacheWrite(DISK_KEY, { at: poolAt, quotes })
  }
}

/**
 * 按正文去重后并入池子，最多留 POOL_TARGET 条。
 *
 * ⚠️ 去重要**同时覆盖池子里已有的和这一批内部的**：
 * 只跟已有的比，一批里若全是同一句（上游 CDN 缓存过就会这样），
 * 池子会被同一句话灌满，轮转就完全失效了 —— 实测踩过这个。
 */
function merge(quotes: Hitokoto[]): void {
  const current = loadPool()
  const seen = new Set(current.map((q) => q.text))
  const added: Hitokoto[] = []
  for (const q of quotes) {
    if (!q.text || seen.has(q.text)) continue
    seen.add(q.text)
    added.push(q)
  }
  if (added.length === 0) return
  pool = [...current, ...added].slice(-POOL_TARGET)
  savePool()
}

/**
 * 后台补池子。并发合并成一个 Promise —— 首页并发打开时不该打出一串请求。
 * **不抛异常**：补不上就继续用池子里剩下的（或者内置语句）。
 */
function refill(): Promise<void> {
  if (refilling) return refilling

  const task = (async () => {
    try {
      // 并发取几条：单条接口一次只给一句，串行取 6 条要 6 个来回
      const results = await Promise.allSettled(
        Array.from({ length: REFILL_BATCH }, () => fetchRemote()),
      )
      const ok = results
        .filter((r): r is PromiseFulfilledResult<Hitokoto> => r.status === 'fulfilled')
        .map((r) => r.value)

      if (ok.length > 0) merge(ok)
      else console.warn('[hitokoto] 补池子失败：这几条都没取到')
    } catch (err) {
      console.warn('[hitokoto] 补池子异常：', err instanceof Error ? err.message : err)
    }
  })()

  refilling = task
  const clear = () => {
    refilling = null
  }
  task.then(clear, clear)
  return task
}

/** 池子该不该补 */
function needsRefill(quotes: Hitokoto[]): boolean {
  if (quotes.length < POOL_LOW) return true
  return Date.now() - poolAt > POOL_TTL_MS
}

/**
 * 取每日一言。**永远不抛错、永远不等外部接口**（池子为空那次除外）。
 *
 * 池子非空时完全是本地操作，所以首页那个组件是瞬时出现的 —— 这正是
 * 「后台预加载，保证前端显示迅速」的做法。
 */
export async function getHitokoto(): Promise<Hitokoto> {
  const quotes = loadPool()

  if (quotes.length === 0) {
    // 冷启动且落盘也是空的：这一次只能等。取不到就用内置语句，保证有字可看
    await refill()
    const filled = loadPool()
    if (filled.length === 0) return pickFallbackQuote()
  }

  const list = loadPool()
  if (needsRefill(list)) void refill()

  // 池子里的内置语句也可能混在里面（以前降级时存下的），这里不特殊处理：
  // 它们本身就是可用的内容

  const picked = list[cursor % list.length]
  cursor += 1
  return picked ?? pickFallbackQuote()
}

/**
 * 启动时预热，把池子填上。
 * 只在池子空或该补的时候才发请求，别每次启动都打一轮。
 */
export function prewarmHitokoto(): void {
  if (needsRefill(loadPool())) void refill()
}
