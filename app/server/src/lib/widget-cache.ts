import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'

/**
 * 小组件的落盘缓存。
 *
 * ── 为什么不能只用内存 ──
 * 天气和一言都靠外部接口。线上那台偶尔会连不上（见 lib/cities.ts 里那段说明），
 * 如果只放内存，一重启缓存就没了，首页立刻空一块。
 * 落盘之后最差也能拿上一次的数据顶上 —— 显示三小时前的温度和「暂时取不到」，
 * 前者对用户有用得多。
 *
 * 写入做了合并：同一轮里连着写多次只会落一次盘。
 */

const FILE = path.join(DATA_DIR, 'widget-cache.json')

type Entry = { at: number; value: unknown }
type Store = Record<string, Entry>

let store: Store | null = null
let flushTimer: NodeJS.Timeout | null = null

function load(): Store {
  if (store) return store
  try {
    const raw = fs.readFileSync(FILE, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    store = parsed && typeof parsed === 'object' ? (parsed as Store) : {}
  } catch {
    // 文件不存在、被删了、内容坏了 —— 一律当成空缓存，不该因此起不来
    store = {}
  }
  return store
}

/** 合并写入：拖 200ms 再落盘，短时间内的多次写只产生一次 IO */
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      fs.writeFileSync(FILE, JSON.stringify(store ?? {}))
    } catch (err) {
      console.warn('[widget-cache] 写入失败：', err instanceof Error ? err.message : err)
    }
  }, 200)
  // 别让这个定时器把进程吊着不退出
  flushTimer.unref?.()
}

export function cacheRead<T>(key: string): { at: number; value: T } | null {
  const entry = load()[key]
  if (!entry || typeof entry.at !== 'number') return null
  return { at: entry.at, value: entry.value as T }
}

export function cacheWrite<T>(key: string, value: T): void {
  load()[key] = { at: Date.now(), value }
  scheduleFlush()
}

/** 等落盘完成（只有自检脚本和退出钩子需要） */
export function cacheFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    fs.writeFileSync(FILE, JSON.stringify(store ?? {}))
  } catch {
    /* 忽略 */
  }
}
