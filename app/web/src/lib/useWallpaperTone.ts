import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import {
  analyzeWallpaper,
  resolveTextTone,
  toneAtElement,
  type Tone,
  type ToneGrid,
  type WallpaperSpec,
} from './visual.ts'

/**
 * 图片壁纸的明暗采样。
 *
 * 分两层：
 *   · useWallpaperTone —— 全页兜底判定（看顶部区域，对应时钟所在位置）
 *   · useReadableTone  —— 某个元素查「自己压在壁纸的哪一块上」，各自判定
 *
 * 为什么需要第二层：壁纸常常上半亮、下半暗（天空 + 地面就是典型），
 * 单一判定必然顾此失彼 —— 实测过一张上亮下暗的图，只采顶部会让下半页的
 * 分组标题变成深字压深底、完全看不见。所以把采样得到的亮度网格留着，
 * 让每个压在壁纸上的元素自己去查。
 */

/** 同一张图只采一次：切主题、调模糊/压暗都会重建 spec，但 URL 没变就没必要重读像素 */
const cache = new Map<string, { grid: ToneGrid; tone: Tone } | null>()

/** 当前生效的亮度网格，供各元素查询自己那一块 */
let currentGrid: ToneGrid | null = null
const gridListeners = new Set<() => void>()

function publishGrid(grid: ToneGrid | null): void {
  currentGrid = grid
  for (const notify of gridListeners) notify()
}

export function useWallpaperTone(spec: WallpaperSpec): Tone | null {
  const needsSample = spec.type === 'image' || spec.type === 'url'
  // 优先采缩略图：小几十 KB，比几 MB 的原图快得多，明暗结论几乎一样
  const primary = needsSample ? (spec.sampleSrc ?? spec.value) : ''
  const fallback = needsSample && spec.sampleSrc && spec.sampleSrc !== spec.value ? spec.value : ''
  // 缓存的 key 要包含两者，否则换了缩略图但原图没变时会命中旧结果
  const src = primary ? `${primary}|${fallback}` : ''

  const [tone, setTone] = useState<Tone | null>(() => (src ? (cache.get(src)?.tone ?? null) : null))

  useEffect(() => {
    if (!src) {
      setTone(null)
      publishGrid(null)
      return
    }

    const hit = cache.get(src)
    if (hit) {
      setTone(hit.tone)
      publishGrid(hit.grid)
      return
    }

    // 换了图先把上一张的结果清掉，避免旧结论短暂套用在新图上
    setTone(null)
    publishGrid(null)

    let alive = true
    void (async () => {
      // 缩略图读不到（老图没补、或者上传时生成失败）就退回原图 ——
      // 慢一点也得把明暗判对，否则深色照片上会出现深字压深底
      let result = primary ? await analyzeWallpaper(primary) : null
      if (!result && fallback) result = await analyzeWallpaper(fallback)
      if (!alive) return
      cache.set(src, result)
      if (result) {
        setTone(result.tone)
        publishGrid(result.grid)
      }
    })()

    return () => {
      alive = false
    }
  }, [src, primary, fallback])

  return tone
}

/**
 * 查这个元素该用深字还是白字。
 *
 * pref 是用户在设置里为这一处选的偏好：
 *   · auto  —— 按采样结果走（默认）
 *   · black —— 强制深字，不管壁纸
 *   · white —— 强制白字
 * 强制时即使元素滚出视口、或壁纸是渐变（没有网格可查）也照样生效。
 */
export function useReadableTone(
  ref: RefObject<HTMLElement | null>,
  pref: 'auto' | 'black' | 'white' = 'auto',
): Tone | null {
  const [tone, setTone] = useState<Tone | null>(null)

  useEffect(() => {
    let raf = 0
    let timer = 0

    const measure = () => {
      const el = ref.current
      if (!el || !currentGrid) {
        setTone(null)
        return
      }
      setTone(toneAtElement(currentGrid, el.getBoundingClientRect()))
    }

    // 用 rAF 合并同一帧内的多次触发（滚动会连续触发）
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }

    measure()
    // 首屏之后小组件、图标才陆续撑开布局，稍后再量一次更准
    timer = window.setTimeout(schedule, 600)

    gridListeners.add(schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, { passive: true })

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      gridListeners.delete(schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
    }
  }, [ref])

  return resolveTextTone(pref, tone)
}

/**
 * 两种明暗下的文字描边：白字配深阴影、深字配浅阴影，都是为了让字从背景里"浮"出来。
 * 方向搞反的话（深字配深阴影）会把字糊进背景，越看越虚 —— 这是实测踩过的。
 */
const SHADOW_DARK_TEXT = '0 1px 3px rgb(255 255 255 / 0.9), 0 0 10px rgb(255 255 255 / 0.5)'
const SHADOW_LIGHT_TEXT = '0 2px 12px rgb(0 0 0 / 0.5)'

/**
 * 把判定结果变成一段内联样式，让元素内部的 `text-wp` 用上自己的局部颜色与描边。
 *
 * ⚠ 这里必须**同时覆盖三个变量**，只覆盖 `--wp-rgb` 是不生效的：
 * Tailwind 为每个透明度变体生成了两条规则，后面那条（真正生效的）长这样
 *   .text-wp\/90 { color: color-mix(in oklab, var(--color-wp) 90%, transparent) }
 * 它走的是 `var(--color-wp)`，而 `--color-wp` 在 `:root` 上就已经被解析成定值，
 * 子元素改 `--wp-rgb` 影响不到它。另一条规则用的是 `rgb(var(--wp-rgb))`，
 * 所以两个都设上才覆盖得全。`--wp-shadow` 则决定描边方向。
 * （这是本项目第二次踩 CSS 变量间接引用的坑，第一次是主题切换那回。）
 */
export function readableToneStyle(tone: Tone | null): CSSProperties | undefined {
  if (!tone) return undefined
  const channels = tone === 'light' ? '15 23 42' : '255 255 255'
  return {
    '--wp-rgb': channels,
    '--color-wp': `rgb(${channels})`,
    '--wp-shadow': tone === 'light' ? SHADOW_DARK_TEXT : SHADOW_LIGHT_TEXT,
  } as CSSProperties
}
