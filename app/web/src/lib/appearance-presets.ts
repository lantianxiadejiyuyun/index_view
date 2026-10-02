/** 完整外观预设。深浅色选择仍由每台设备保管，预设仅决定两种模式的样式。 */
export const APPEARANCE_PRESET_IDS = ['classic', 'desktop', 'minimal', 'paper', 'terminal'] as const

export type AppearancePresetId = (typeof APPEARANCE_PRESET_IDS)[number]

export type AppearancePreset = {
  id: AppearancePresetId
  name: string
  description: string
  tag: string
  colors: { background: string; surface: string; accent: string; text: string }
}

export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  {
    id: 'classic', name: '经典玻璃', tag: '经典',
    description: '通透玻璃卡片与柔和渐变，保留熟悉的导航体验。',
    colors: { background: '#e2e8f0', surface: '#f8fafc', accent: '#6366f1', text: '#0f172a' },
  },
  {
    id: 'desktop', name: '云端桌面', tag: '仿桌面',
    description: '桌面窗口、应用图标与底部程序坞，打开属于你的云端桌面。',
    colors: { background: '#0c4a6e', surface: '#e0f2fe', accent: '#38bdf8', text: '#0c4a6e' },
  },
  {
    id: 'minimal', name: '简约留白', tag: '极简',
    description: '干净留白、利落线条和轻量卡片，让常用内容更清晰。',
    colors: { background: '#f8fafc', surface: '#ffffff', accent: '#475569', text: '#0f172a' },
  },
  {
    id: 'paper', name: '奶油手账', tag: '温暖',
    description: '温暖纸感、手账标签与柔和阴影，给导航留一点生活气息。',
    colors: { background: '#f4ead8', surface: '#fffaf0', accent: '#a56a43', text: '#574434' },
  },
  {
    id: 'terminal', name: '深空终端', tag: '科技',
    description: '终端线框、等宽细节与绿色强调，浅色模式也保持清晰。',
    colors: { background: '#071714', surface: '#102620', accent: '#4ade80', text: '#c8f5dc' },
  },
]

export function normalizeAppearancePreset(value: unknown): AppearancePresetId {
  return typeof value === 'string' && (APPEARANCE_PRESET_IDS as readonly string[]).includes(value)
    ? value as AppearancePresetId
    : 'classic'
}

const PRESET_SETTINGS: Record<AppearancePresetId, {
  cardSize: string; gap: string; glass: string; light: string; dark: string; dim: string
}> = {
  classic: { cardSize: 'md', gap: 'md', glass: 'md', light: 'paper', dark: 'aurora', dim: '28' },
  desktop: { cardSize: 'md', gap: 'md', glass: 'lg', light: 'cloud-day', dark: 'cloud-night', dim: '14' },
  minimal: { cardSize: 'md', gap: 'lg', glass: 'none', light: 'paper', dark: 'midnight', dim: '0' },
  paper: { cardSize: 'md', gap: 'md', glass: 'none', light: 'linen-day', dark: 'linen-night', dim: '0' },
  terminal: { cardSize: 'sm', gap: 'md', glass: 'sm', light: 'terminal-day', dark: 'terminal-night', dim: '12' },
}

/** 每次返回独立的字符串补丁；保留壁纸时连模糊、遮罩设置也不修改。 */
export function appearancePresetPatch(
  id: AppearancePresetId,
  { preserveWallpaper }: { preserveWallpaper: boolean },
): Record<string, string> {
  const selected = normalizeAppearancePreset(id)
  const preset = PRESET_SETTINGS[selected]
  const patch: Record<string, string> = {
    appearance_preset: selected,
    card_size: preset.cardSize,
    grid_gap: preset.gap,
    glass: preset.glass,
    tone_clock: 'auto',
    tone_heading: 'auto',
    tone_page_title: 'auto',
  }
  if (!preserveWallpaper) {
    Object.assign(patch, {
      wallpaper_light_type: 'gradient',
      wallpaper_light_value: preset.light,
      wallpaper_dark_type: 'gradient',
      wallpaper_dark_value: preset.dark,
      wallpaper_blur: '0',
      wallpaper_dim: preset.dim,
    })
  }
  return patch
}
