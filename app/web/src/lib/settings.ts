/**
 * 设置项的读取与归一化。
 *
 * 后端把 settings 一律存成字符串（键值表，灵活且不用迁移），
 * 这里集中做类型转换，让组件里拿到的都是干净的类型。
 */

import { normalizeAppearancePreset, type AppearancePresetId } from './appearance-presets'

export type WallpaperType = 'gradient' | 'color' | 'image' | 'url' | 'video'
export type ThemePref = 'auto' | 'light' | 'dark'
export type CardSize = 'sm' | 'md' | 'lg'
export type GapSize = 'sm' | 'md' | 'lg'
export type GlassLevel = 'none' | 'sm' | 'md' | 'lg'

/**
 * 压在壁纸上的文字用黑字还是白字。
 * auto = 按壁纸明暗采样自动选；black / white = 强制固定，不看壁纸。
 */
export type TextTone = 'auto' | 'black' | 'white'

export const TEXT_TONE_OPTIONS = ['auto', 'black', 'white'] as const

/** 当前主题该用哪套壁纸 */
export function activeWallpaper(
  settings: Pick<
    AppSettings,
    'wallpaper_light_type' | 'wallpaper_light_value' | 'wallpaper_dark_type' | 'wallpaper_dark_value'
  >,
  isDark: boolean,
): { type: WallpaperType; value: string } {
  return isDark
    ? { type: settings.wallpaper_dark_type, value: settings.wallpaper_dark_value }
    : { type: settings.wallpaper_light_type, value: settings.wallpaper_light_value }
}

export type AppSettings = {
  site_title: string
  site_subtitle: string
  search_engine: string
  custom_engines: string
  // 壁纸分两套：切主题时自动换，不用手工改
  wallpaper_light_type: WallpaperType
  wallpaper_light_value: string
  wallpaper_dark_type: WallpaperType
  wallpaper_dark_value: string
  wallpaper_blur: number
  wallpaper_dim: number
  theme: ThemePref
  appearance_preset: AppearancePresetId
  card_size: CardSize
  grid_gap: GapSize
  glass: GlassLevel
  show_clock: boolean
  show_greeting: boolean
  show_weather: boolean
  show_hitokoto: boolean
  /** 首页上那颗进「工作台」的入口小组件 */
  show_workbench: boolean
  // 三处压在壁纸上的文字各自的颜色偏好
  tone_clock: TextTone
  tone_heading: TextTone
  tone_page_title: TextTone
  weather_city: string
  /** 'china'（中国天气网，默认）或 'open-meteo' */
  weather_provider: string
  open_in_new_tab: boolean
  agent_ports: string
  public_view: boolean
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return value !== 'false' && value !== '0'
}

function toNum(value: string | undefined, fallback: number, min = 0, max = 100): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function normalizeSettings(raw: Record<string, string> | undefined): AppSettings {
  const s = raw ?? {}
  return {
    site_title: s.site_title || '我的导航',
    site_subtitle: s.site_subtitle || '',
    search_engine: s.search_engine || 'bing',
    custom_engines: s.custom_engines || '[]',
    // 老库可能只有 wallpaper_type / wallpaper_value（拆成两套之前的），
    // 这两个新键没值时兜底读老键，保证升级后壁纸不会凭空消失
    wallpaper_light_type: pick(
      s.wallpaper_light_type ?? s.wallpaper_type,
      ['gradient', 'color', 'image', 'url', 'video'] as const,
      'gradient',
    ),
    wallpaper_light_value: s.wallpaper_light_value ?? s.wallpaper_value ?? 'paper',
    wallpaper_dark_type: pick(
      s.wallpaper_dark_type ?? s.wallpaper_type,
      ['gradient', 'color', 'image', 'url', 'video'] as const,
      'gradient',
    ),
    wallpaper_dark_value: s.wallpaper_dark_value ?? s.wallpaper_value ?? 'aurora',
    wallpaper_blur: toNum(s.wallpaper_blur, 0, 0, 40),
    wallpaper_dim: toNum(s.wallpaper_dim, 28, 0, 85),
    theme: pick(s.theme, ['auto', 'light', 'dark'] as const, 'auto'),
    appearance_preset: normalizeAppearancePreset(s.appearance_preset),
    card_size: pick(s.card_size, ['sm', 'md', 'lg'] as const, 'md'),
    grid_gap: pick(s.grid_gap, ['sm', 'md', 'lg'] as const, 'md'),
    glass: pick(s.glass, ['none', 'sm', 'md', 'lg'] as const, 'md'),
    show_clock: toBool(s.show_clock, true),
    show_greeting: toBool(s.show_greeting, true),
    show_weather: toBool(s.show_weather, true),
    show_hitokoto: toBool(s.show_hitokoto, true),
    show_workbench: toBool(s.show_workbench, true),
    tone_clock: pick(s.tone_clock, TEXT_TONE_OPTIONS, 'auto'),
    tone_heading: pick(s.tone_heading, TEXT_TONE_OPTIONS, 'auto'),
    tone_page_title: pick(s.tone_page_title, TEXT_TONE_OPTIONS, 'auto'),
    weather_city: s.weather_city || '',
    weather_provider: s.weather_provider || 'china',
    open_in_new_tab: toBool(s.open_in_new_tab, true),
    agent_ports: s.agent_ports || '9201',
    public_view: toBool(s.public_view, true),
  }
}

export function parseCustomEngines(raw: string): SearchEngine[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is SearchEngine => Boolean(e) && typeof e.id === 'string' && typeof e.url === 'string')
      .slice(0, 20)
  } catch {
    return []
  }
}

export type SearchEngine = {
  id: string
  name: string
  /** 用 %s 占位查询词 */
  url: string
  /** 触发前缀，比如 g 表示输入 "g xxx" 强制走 Google */
  keyword?: string
}

export const BUILTIN_ENGINES: SearchEngine[] = [
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', keyword: 'b' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', keyword: 'g' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=%s', keyword: 'bd' },
  { id: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', keyword: 'd' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/search?q=%s', keyword: 'gh' },
  { id: 'bili', name: 'Bilibili', url: 'https://search.bilibili.com/all?keyword=%s', keyword: 'bl' },
]

export function allEngines(settings: AppSettings): SearchEngine[] {
  const custom = parseCustomEngines(settings.custom_engines)
  // 自定义引擎放前面：用户自己加的显然更常用
  return [...custom, ...BUILTIN_ENGINES]
}

export function findEngine(settings: AppSettings, id: string): SearchEngine {
  const engines = allEngines(settings)
  return engines.find((e) => e.id === id) ?? BUILTIN_ENGINES[0]!
}

/** 玻璃强度映射到 CSS 变量，none 时干脆去掉模糊以省性能 */
export const GLASS_PRESETS: Record<GlassLevel, { blur: number; alpha: number }> = {
  none: { blur: 0, alpha: 0.86 },
  sm: { blur: 8, alpha: 0.7 },
  md: { blur: 16, alpha: 0.6 },
  lg: { blur: 26, alpha: 0.5 },
}

/**
 * 卡片尺寸预设。
 * width 是图标的固定宽度 —— 图标用「居中自适应换行」排布而不是固定列数的网格，
 * 这样收藏只有两三个时整组会居中，不会挤在左边、右边空一大片。
 */
export const CARD_PRESETS: Record<
  CardSize,
  { icon: number; pad: number; label: string; width: number }
> = {
  sm: { icon: 40, pad: 10, label: 'text-xs', width: 92 },
  md: { icon: 52, pad: 14, label: 'text-sm', width: 112 },
  lg: { icon: 64, pad: 18, label: 'text-base', width: 136 },
}

export const GAP_PRESETS: Record<GapSize, string> = {
  sm: '0.75rem',
  md: '1.25rem',
  lg: '1.75rem',
}
