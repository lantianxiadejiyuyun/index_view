/**
 * 双链路解析：决定一个图标点击后到底走公网地址还是内网地址。
 *
 * 策略（与 PLAN.md §6.2 一致）：
 *  1. 条目上显式指定 link_mode 就听它的
 *  2. auto 时按「当前访问入口」判断：内网打开优先走内网地址
 *  3. 后台批量探活做兜底：内网地址不通就回落到公网
 *
 * 探活是**异步预热**的，绝不放在点击路径上 —— 否则每次点击都要等
 * 1.5 秒超时，体验会明显变差。点击时只读缓存，读不到就用静态判断兜底。
 */
import { probeReachable, type NetMode } from './net.ts'
import type { Site } from './types.ts'

export type LinkKind = NetMode

export type ResolvedLink = {
  url: string
  kind: LinkKind
  /** 是不是在探活失败后从内网回落到了公网 */
  fallback: boolean
}

/** site.id → 探活后确认可用的链路 */
const reachability = new Map<number, LinkKind>()
/** site.id → 正在探活 */
const inflight = new Map<number, Promise<void>>()

export function clearLinkCache(): void {
  reachability.clear()
  inflight.clear()
}

/** 同步解析，点击路径专用，保证零延迟 */
export function resolveLink(site: Site, mode: LinkKind): ResolvedLink | null {
  const lan = site.url_lan?.trim() || null
  const pub = site.url_public?.trim() || null

  if (!lan && !pub) return null
  if (!lan) return { url: pub!, kind: 'public', fallback: false }
  if (!pub) return { url: lan, kind: 'lan', fallback: false }

  // 1) 条目显式指定
  if (site.link_mode === 'public') {
    return { url: pub, kind: 'public', fallback: false }
  }
  if (site.link_mode === 'lan') {
    return { url: lan, kind: 'lan', fallback: false }
  }

  // 2) auto：内网入口优先内网地址
  if (mode === 'public') {
    return { url: pub, kind: 'public', fallback: false }
  }

  // 3) auto + 内网入口：看探活结果，没有结果就先乐观走内网
  const known = reachability.get(site.id)
  if (known === 'public') {
    return { url: pub, kind: 'public', fallback: true }
  }
  return { url: lan, kind: 'lan', fallback: false }
}

const CONCURRENCY = 6
const PROBE_TIMEOUT = 1200

/**
 * 后台预热：只探「内网模式下确实需要做选择」的条目。
 * 公网地址不需要探（在外面探内网必然不通，没有意义）。
 */
export function prewarmLinks(sites: Site[], mode: LinkKind): void {
  if (mode !== 'lan') return

  const targets = sites.filter(
    (s) => s.link_mode === 'auto' && s.url_lan && s.url_public && !reachability.has(s.id),
  )
  if (targets.length === 0) return

  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const site = targets[cursor++]
      if (!site) return
      const lan = site.url_lan
      if (!lan) continue

      const ok = await probeReachable(lan, PROBE_TIMEOUT)
      reachability.set(site.id, ok ? 'lan' : 'public')
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () =>
    worker().catch(() => undefined),
  )
  // 不 await：纯粹是给后续点击加速用的，失败也无所谓
  void Promise.all(workers)
}

export function openResolved(link: ResolvedLink, newTab: boolean): void {
  if (newTab) {
    window.open(link.url, '_blank', 'noopener,noreferrer')
  } else {
    window.location.href = link.url
  }
}
