/** 内置壁纸预设。全部用 CSS 渐变，零网络请求、零体积、任意分辨率都不糊。 */

export type WallpaperPreset = {
  id: string
  name: string
  css: string
  /** 深色还是浅色基调，用来决定在它上面默认用哪套文字色 */
  tone: 'dark' | 'light'
}

export const GRADIENT_PRESETS: WallpaperPreset[] = [
  {
    id: 'aurora',
    name: '极光',
    tone: 'dark',
    css: 'radial-gradient(120% 100% at 12% 8%, #1e3a8a 0%, transparent 55%), radial-gradient(100% 90% at 88% 12%, #0e7490 0%, transparent 50%), radial-gradient(120% 120% at 50% 100%, #4c1d95 0%, transparent 60%), linear-gradient(160deg, #070b1a 0%, #0b1020 50%, #05070f 100%)',
  },
  {
    id: 'midnight',
    name: '午夜',
    tone: 'dark',
    css: 'radial-gradient(100% 80% at 20% 0%, #1e293b 0%, transparent 60%), radial-gradient(90% 90% at 85% 100%, #172554 0%, transparent 55%), linear-gradient(180deg, #0a0f1c 0%, #060911 100%)',
  },
  {
    id: 'sunset',
    name: '晚霞',
    tone: 'dark',
    css: 'radial-gradient(110% 90% at 15% 100%, #b91c1c 0%, transparent 55%), radial-gradient(100% 80% at 85% 10%, #7c2d12 0%, transparent 50%), radial-gradient(120% 100% at 50% 50%, #581c87 0%, transparent 65%), linear-gradient(160deg, #1a0b1e 0%, #2a0f1a 100%)',
  },
  {
    id: 'ocean',
    name: '深海',
    tone: 'dark',
    css: 'radial-gradient(110% 90% at 50% -10%, #0891b2 0%, transparent 55%), radial-gradient(100% 100% at 10% 100%, #0c4a6e 0%, transparent 60%), linear-gradient(180deg, #041420 0%, #020a12 100%)',
  },
  {
    id: 'forest',
    name: '林间',
    tone: 'dark',
    css: 'radial-gradient(110% 90% at 80% 0%, #15803d 0%, transparent 55%), radial-gradient(100% 100% at 10% 90%, #064e3b 0%, transparent 60%), linear-gradient(170deg, #04140d 0%, #020a07 100%)',
  },
  {
    id: 'sakura',
    name: '樱',
    tone: 'light',
    css: 'radial-gradient(110% 90% at 20% 10%, #fecdd3 0%, transparent 55%), radial-gradient(100% 100% at 85% 85%, #ddd6fe 0%, transparent 55%), linear-gradient(160deg, #fff1f2 0%, #f5f3ff 100%)',
  },
  {
    id: 'paper',
    name: '素白',
    tone: 'light',
    css: 'radial-gradient(100% 80% at 50% 0%, #ffffff 0%, transparent 60%), linear-gradient(180deg, #f1f5f9 0%, #e2e8f0 100%)',
  },
  {
    id: 'mono',
    name: '石墨',
    tone: 'dark',
    css: 'radial-gradient(100% 80% at 30% 0%, #27272a 0%, transparent 60%), linear-gradient(180deg, #18181b 0%, #09090b 100%)',
  },
]

export function findPreset(id: string): WallpaperPreset {
  return GRADIENT_PRESETS.find((p) => p.id === id) ?? GRADIENT_PRESETS[0]!
}

/**
 * 把「本站上传的图」的地址换算成派生图地址。
 *
 * 派生图在服务端有一个**与编码格式无关**的稳定地址
 * （`/uploads/derived/<名字>.thumb`，不带扩展名）—— Safari 的派生图是 JPEG、
 * Chrome 的是 WebP，前端不该关心，服务端会按实际存在的文件发正确的 Content-Type。
 *
 * 外链、渐变、纯色这些没有派生图，返回 null。
 */
export function derivedUrl(value: string, kind: 'thumb' | 'large'): string | null {
  // 排除 /uploads/derived/... 自己，避免二次换算
  const m = /^\/uploads\/(?!derived\/)([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/.exec(value)
  return m?.[1] ? `/uploads/derived/${m[1]}.${kind}` : null
}

export type WallpaperStyle = {
  backgroundColor?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  backgroundRepeat?: string
  filter?: string
  transform?: string
}

/** 把设置翻译成实际的内联样式 */
export function wallpaperStyle(type: string, value: string, blurPx: number): WallpaperStyle {
  const style: WallpaperStyle = {}
  if (blurPx > 0) {
    style.filter = `blur(${blurPx}px)`
    // 模糊会让边缘露出底色，稍微放大一点盖住
    style.transform = `scale(${1 + blurPx / 120})`
  }

  switch (type) {
    case 'color':
      style.backgroundColor = value || '#0b1020'
      return style
    case 'image':
    case 'url':
      style.backgroundImage = `url("${value}")`
      style.backgroundSize = 'cover'
      style.backgroundPosition = 'center'
      style.backgroundRepeat = 'no-repeat'
      return style
    case 'gradient':
    default:
      style.backgroundImage = findPreset(value).css
      return style
  }
}
