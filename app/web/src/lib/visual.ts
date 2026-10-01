/**
 * 壁纸与主题相关的视觉计算。
 *
 * 抽出来是因为有两处要用同一套逻辑：App 用来设置全局 CSS 变量，
 * 设置页的外观预览面板用来渲染缩略图。两边算法必须一致，
 * 否则预览和真实效果会对不上。
 */
import { findPreset } from './wallpapers.ts'

export type Tone = 'light' | 'dark'

/** 解析出「当前实际是不是深色」，auto 时跟随系统 */
export function resolveDark(pref: string): boolean {
  if (pref === 'dark') return true
  if (pref === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 十六进制颜色转相对亮度 */
export function luminance(hex: string): number {
  const m = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  let h = m[1] ?? ''
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export type WallpaperSpec = {
  type: string
  value: string
  /** 0–85 的压暗百分比 */
  dim: number
  /**
   * 采样用的地址，缺省就用 value。
   *
   * 图片壁纸判断明暗要真的读像素，而原图可能有七八 MB —— 为了判断深浅去解它
   * 很不划算。传缩略图（几十 KB）进来，结果几乎一样，快得多。
   * 缩略图读不到时由调用方回退到 value。
   */
  sampleSrc?: string
}

/**
 * 判断壁纸本身的明暗。
 *
 * 渐变和纯色是确定的，直接算。**图片壁纸必须真的去采样像素** ——
 * 早先这里只是「跟随主题」，等于没判断：主题是浅色时，换一张暗色照片就会
 * 深字压暗底、完全读不出来。采样是异步的，结果由调用方通过 analyzed 传进来；
 * 拿不到（还在加载、跨域读不了像素）时才退回跟随主题。
 */
export function wallpaperTone(
  spec: WallpaperSpec,
  isDark: boolean,
  analyzed?: Tone | null,
): Tone {
  if (spec.type === 'gradient') return findPreset(spec.value).tone
  if (spec.type === 'color') return luminance(spec.value) > 0.55 ? 'light' : 'dark'
  return analyzed ?? (isDark ? 'dark' : 'light')
}

/**
 * 算壁纸色罩强度，以及「压完色罩之后背景实际是明是暗」。
 *
 * 色罩只有一个方向：**压暗**。明暗两边都用它，只是强度不同 ——
 * 让背景和卡片拉开明度差，产生层次。
 *
 *  · 深色主题 + 浅色壁纸 → 必须压暗。否则背景落在中灰，深色卡片压上去
 *    几乎同明度，整页糊成一片灰泥（这是实测踩到的）。浅色壁纸通常是大面积
 *    纯色，压暗后就是干净的深色底，不损失什么。
 *
 *  · 浅色主题 → 也要**轻微压暗**，让背景比白色卡片暗一档。
 *    这里第一版做错过：把用户的 wallpaper_dim 当成「提亮」用在浅色主题上，
 *    结果本来就浅的壁纸被推得更白，背景和卡片只差几个色阶，整页像褪色的复印件。
 *    浅色模式下背景本来就该是浅灰、卡片才是白，这个明度差就是层次感的来源。
 *
 *  · 浅色主题 + 深色壁纸 → 只压一点点（壁纸本来就暗，不需要帮忙），
 *    保留壁纸的层次；卡片是白玻璃，压在深色壁纸上正好。
 *
 * 返回的 effectiveTone 写到 <html data-wp-tone>，决定直接压在壁纸上的
 * 文字（时钟、问候语）是白还是黑。
 */
export function computeScrims(
  spec: WallpaperSpec,
  isDark: boolean,
  analyzed?: Tone | null,
): { scrim: number; effectiveTone: Tone } {
  const base = Math.min(0.85, Math.max(0, spec.dim / 100))
  const tone = wallpaperTone(spec, isDark, analyzed)

  if (isDark) {
    const conflicts = tone === 'light'
    return {
      scrim: conflicts ? Math.min(0.92, base + 0.46) : base,
      // 压暗之后背景就是暗的，壁纸上的文字要跟着转白
      effectiveTone: conflicts ? 'dark' : tone,
    }
  }

  // 浅色主题：只取用户设定的一小部分做压暗，够拉开与白色卡片的差距就行。
  // 压太狠会把浅色壁纸变脏。
  return {
    scrim: Math.min(0.3, base * 0.35),
    // 壁纸本身是浅色 → 压完还是浅色底 → 用深字；壁纸是深色 → 仍旧用白字
    effectiveTone: tone,
  }
}

// ── 图片壁纸的明暗采样 ────────────────────────────────────────

/**
 * 采样画布。宽度固定，高度按视口宽高比换算 —— 必须和真实视口同比例，
 * 否则 background-size: cover 的裁切几何对不上，采到的区域和屏幕上
 * 文字实际压着的区域会有偏差。
 */
const SAMPLE_W = 96

/** 把画布切成多少格。格子越细，「文字压在哪块上」判断得越准 */
const GRID_COLS = 12
const GRID_ROWS = 6

/**
 * 全局兜底判定只看这块区域：上方 45% 高度、横向中间 70%。
 * 这对应时钟所在的位置 —— 它是页面上最大最显眼的文字。
 */
const TOP_REGION = { x: 0.15, y: 0, w: 0.7, h: 0.45 }

/**
 * 采样区平均亮度超过这个值就判定为浅色底（用深字），否则用白字。
 *
 * 这个值不是拍脑袋定的：把「深字对比度 = 白字对比度」的临界点解出来就是它。
 * 用 WCAG 的对比度公式（深字 #0f172a 的相对亮度约 0.008，白字 1.0）：
 *   白字：(1.0 + 0.05) / (Y + 0.05)
 *   深字：(Y + 0.05) / (0.008 + 0.05)
 * 两者相等时 Y ≈ 0.197；再把这个相对亮度换算回本文件用的 sRGB 亮度
 * （那些格子存的是 0.2126R' + 0.7152G' + 0.0722B'，没有做 gamma 线性化），
 * 就得到 0.48 左右。
 *
 * 调低它 → 更多区域判为浅色底 → 更多深字；调高则相反。
 */
const LIGHT_THRESHOLD = 0.48

/** 壁纸的亮度网格，坐标已经归一化到视口空间 */
export type ToneGrid = {
  cols: number
  rows: number
  /** 行优先，长度 cols*rows，值域 0–1 */
  cells: number[]
  /** 视口尺寸，用于把元素的 rect 映射到格子 */
  vw: number
  vh: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // 同源图（/uploads/*）不受影响；外部图带这个头才有机会通过 CORS
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

/** 把若干格子的亮度取平均；没有任何格子时返回 null */
function averageCells(grid: ToneGrid, r0: number, r1: number, c0: number, c1: number): number | null {
  let sum = 0
  let n = 0
  for (let r = Math.max(0, r0); r < Math.min(grid.rows, r1); r += 1) {
    for (let c = Math.max(0, c0); c < Math.min(grid.cols, c1); c += 1) {
      sum += grid.cells[r * grid.cols + c] ?? 0
      n += 1
    }
  }
  return n === 0 ? null : sum / n
}

/** 网格里某块区域的平均亮度，区域用 0–1 的归一化坐标给 */
function regionLuma(grid: ToneGrid, x: number, y: number, w: number, h: number): number | null {
  return averageCells(
    grid,
    Math.floor(y * grid.rows),
    Math.ceil((y + h) * grid.rows),
    Math.floor(x * grid.cols),
    Math.ceil((x + w) * grid.cols),
  )
}

/**
 * 采样图片壁纸，返回亮度网格和「顶部区域」的兜底判定。
 *
 * 为什么要返回整个网格而不是一个数：壁纸常常上半亮、下半暗（天空 + 地面就是典型），
 * 用单一判定必然顾此失彼 —— 实测过一张上亮下暗的图，只采顶部会让下半页的分组标题
 * 变成深字压深底、完全看不见；采整图又会反过来让时钟变成白字压亮底。
 * 所以除了兜底值，还要把网格留给各组元素去查自己那一块。
 *
 * 拿不到像素时返回 null：图片没加载好，或跨域图污染了画布（getImageData 抛 SecurityError）。
 */
export async function analyzeWallpaper(src: string): Promise<{ grid: ToneGrid; tone: Tone } | null> {
  if (!src) return null
  try {
    const img = await loadImage(src)
    if (!img.naturalWidth || !img.naturalHeight) return null

    const vw = Math.max(1, window.innerWidth)
    const vh = Math.max(1, window.innerHeight)
    const sampleH = Math.max(GRID_ROWS * 2, Math.round((SAMPLE_W * vh) / vw))

    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_W
    canvas.height = sampleH
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    // 复刻 background-size: cover 的裁切：按较大的一边缩放，居中溢出
    const scale = Math.max(SAMPLE_W / img.naturalWidth, sampleH / img.naturalHeight)
    const dw = img.naturalWidth * scale
    const dh = img.naturalHeight * scale
    ctx.drawImage(img, (SAMPLE_W - dw) / 2, (sampleH - dh) / 2, dw, dh)

    let data: Uint8ClampedArray
    try {
      data = ctx.getImageData(0, 0, SAMPLE_W, sampleH).data
    } catch {
      // 跨域图片会污染画布，读像素直接抛错
      return null
    }

    const cellW = SAMPLE_W / GRID_COLS
    const cellH = sampleH / GRID_ROWS
    const cells: number[] = []

    for (let r = 0; r < GRID_ROWS; r += 1) {
      for (let c = 0; c < GRID_COLS; c += 1) {
        const x0 = Math.floor(c * cellW)
        const y0 = Math.floor(r * cellH)
        const x1 = Math.min(SAMPLE_W, Math.ceil((c + 1) * cellW))
        const y1 = Math.min(sampleH, Math.ceil((r + 1) * cellH))

        let sum = 0
        let n = 0
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const i = (y * SAMPLE_W + x) * 4
            const a = data[i + 3] ?? 255
            if (a === 0) continue
            // 用感知亮度权重（不线性化，跟人眼对"明暗"的直觉更接近）
            sum += (0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0)) / 255
            n += 1
          }
        }
        cells.push(n === 0 ? 0 : sum / n)
      }
    }

    const grid: ToneGrid = { cols: GRID_COLS, rows: GRID_ROWS, cells, vw, vh }
    const top = regionLuma(grid, TOP_REGION.x, TOP_REGION.y, TOP_REGION.w, TOP_REGION.h) ?? 0
    return { grid, tone: top > LIGHT_THRESHOLD ? 'light' : 'dark' }
  } catch {
    return null
  }
}

/**
 * 把「用户的固定偏好」和「自动采样结果」合成最终的文字明暗。
 *
 * pref 为 black / white 时不看壁纸，一律用指定的颜色 ——
 * 给的是"文字颜色"，所以要把黑映射成 light 底（深字），别搞反。
 */
export function resolveTextTone(
  pref: 'auto' | 'black' | 'white',
  auto: Tone | null,
): Tone | null {
  if (pref === 'black') return 'light'
  if (pref === 'white') return 'dark'
  return auto
}

/**
 * 查某个元素「压在壁纸的哪块上」，据此判断该用深字还是白字。
 *
 * 元素完全在视口之外（滚动到看不见了）时返回 null，由调用方沿用兜底判定。
 */
export function toneAtElement(grid: ToneGrid, rect: DOMRect): Tone | null {
  if (rect.bottom <= 0 || rect.top >= grid.vh) return null
  if (rect.right <= 0 || rect.left >= grid.vw) return null

  const c0 = Math.floor((rect.left / grid.vw) * grid.cols)
  const c1 = Math.ceil((rect.right / grid.vw) * grid.cols)
  const r0 = Math.floor((Math.max(0, rect.top) / grid.vh) * grid.rows)
  const r1 = Math.ceil((Math.min(grid.vh, rect.bottom) / grid.vh) * grid.rows)

  const luma = averageCells(grid, r0, r1, c0, c1)
  if (luma === null) return null
  return luma > LIGHT_THRESHOLD ? 'light' : 'dark'
}
