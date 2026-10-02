import { useRef, useState } from 'react'
import { ImagePlus, Loader2, Type, Upload } from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import {
  CARD_PRESETS,
  GAP_PRESETS,
  type CardSize,
  type GapSize,
  type GlassLevel,
  type TextTone,
  type ThemePref,
  type WallpaperType,
} from '../../lib/settings.ts'
import { GRADIENT_PRESETS, wallpaperStyle } from '../../lib/wallpapers.ts'
import { computeScrims, resolveDark } from '../../lib/visual.ts'
import { useWallpaperTone } from '../../lib/useWallpaperTone.ts'
import { useApp } from '../../store/app.ts'
import { toast } from '../../store/toast.ts'
import { btnGhost } from '../Modal.tsx'
import {
  FieldBlock,
  Note,
  Segmented,
  SettingTextField,
  SliderField,
  useDebouncedCommit,
  useDraftValue,
} from './controls.tsx'
import { SettingsSection } from './Section.tsx'
import { useSettingsSave } from './saver.tsx'

/**
 * 纯色壁纸的快捷色板。
 * 深浅都有 —— 背景会自动压暗/提亮到与主题匹配，并自动切换文字黑白，
 * 所以不再需要「只能用深色系」这种限制。
 */
const COLOR_PRESETS = [
  '#0b1020',
  '#111827',
  '#1e1b4b',
  '#0c4a6e',
  '#064e3b',
  '#450a0a',
  '#3b0764',
  '#e2e8f0',
  '#fef3c7',
  '#dbeafe',
]

const WALLPAPER_TYPES: { value: WallpaperType; label: string }[] = [
  { value: 'gradient', label: '渐变' },
  { value: 'color', label: '纯色' },
  { value: 'image', label: '本地上传' },
  { value: 'url', label: '图片链接' },
]

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const CARD_SIZES: { value: CardSize; label: string }[] = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '中' },
  { value: 'lg', label: '大' },
]

const GAPS: { value: GapSize; label: string }[] = [
  { value: 'sm', label: '紧凑' },
  { value: 'md', label: '适中' },
  { value: 'lg', label: '宽松' },
]

const GLASS_LEVELS: { value: GlassLevel; label: string }[] = [
  { value: 'none', label: '关闭' },
  { value: 'sm', label: '弱' },
  { value: 'md', label: '中' },
  { value: 'lg', label: '强' },
]

const TONE_OPTIONS: { value: TextTone; label: string; title?: string }[] = [
  { value: 'auto', label: '自动', title: '读取壁纸对应位置的明暗来决定' },
  { value: 'black', label: '黑', title: '不管壁纸，一律用深色字' },
  { value: 'white', label: '白', title: '不管壁纸，一律用白色字' },
]

type WallpaperSlot = 'light' | 'dark'

const WALLPAPER_SLOTS: { value: WallpaperSlot; label: string }[] = [
  { value: 'light', label: '浅色主题' },
  { value: 'dark', label: '深色主题' },
]

/**
 * 切换壁纸类型时，给新类型挑一个能用的值。
 * 不这么做的话，从「渐变 aurora」切到「图片链接」会把 aurora 当成 URL，
 * 壁纸直接变成空白，看起来像坏了。
 */
function valueForType(type: WallpaperType, current: string): string {
  switch (type) {
    case 'gradient':
      return GRADIENT_PRESETS.some((p) => p.id === current) ? current : 'aurora'
    case 'color':
      return /^#[0-9a-fA-F]{6}$/.test(current) ? current : '#0b1020'
    case 'url':
      return /^https?:\/\//i.test(current) ? current : ''
    case 'image':
      return /^(?:\/uploads\/|https?:)/i.test(current) ? current : ''
  }
}

/** 所见即所得的壁纸预览：毛玻璃、卡片尺寸、间距都在这一块里同时体现出来 */
function AppearancePreview({
  type,
  value,
  blur,
  dim,
  cardSize,
  gap,
  isDark,
}: {
  type: WallpaperType
  value: string
  blur: number
  dim: number
  cardSize: CardSize
  gap: GapSize
  /** 这一套属于深色还是浅色主题 —— 决定色罩怎么算 */
  isDark: boolean
}) {
  const style = wallpaperStyle(type, value, blur)
  const card = CARD_PRESETS[cardSize]
  const empty = !value && (type === 'image' || type === 'url')

  // 预览必须和真实首页用同一套算法（含图片壁纸的明暗采样），
  // 否则会出现「预览好看、保存后变样」。
  // 注意用的是**这一套**的明暗，而不是当前主题的 —— 不然在浅色主题下
  // 编辑深色那套壁纸时，预览会按浅色的规则压暗，和实际效果对不上。
  const imgTone = useWallpaperTone({ type, value, dim })
  const { scrim } = computeScrims({ type, value, dim }, isDark, imgTone)

  return (
    <div className="relative h-36 overflow-hidden rounded-2xl border border-line/10 sm:h-44">
      <div className="absolute inset-0" style={style} />
      <div
        className="wallpaper-scrim absolute inset-0"
        style={{ ['--scrim' as string]: String(scrim) }}
      />

      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ gap: GAP_PRESETS[gap] }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="glass rounded-2xl"
            style={{ width: card.icon, height: card.icon }}
            aria-hidden
          />
        ))}
      </div>

      <span className="absolute bottom-2 left-3 text-[10px] text-fg/50">壁纸与卡片效果预览</span>
      {empty && (
        <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-xs text-fg/70">
          还没有选择图片
        </span>
      )}
    </div>
  )
}

export function AppearanceSection() {
  const settings = useApp((s) => s.settings)
  const setTheme = useApp((s) => s.setTheme)
  const { save, readOnly } = useSettingsSave()

  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * 正在编辑哪一套壁纸。
   *
   * 壁纸分浅色/深色两套，但**不并排摆两个编辑器** —— 那样设置页会长一倍，
   * 而且大部分时候用户只想改当前这套。所以给一个切换器，下面还是原来那套控件。
   * 切主题时自动换壁纸，但用户想提前配另一套也随时能切过来改。
   */
  const [slot, setSlot] = useState<WallpaperSlot>(() =>
    resolveDark(settings.theme) ? 'dark' : 'light',
  )

  // 每种壁纸类型各记一份上次的值，**按套分开记**：
  // 浅色那套切走再切回来，不该捡到深色那套挑的预设
  const memory = useRef<Record<WallpaperSlot, Partial<Record<WallpaperType, string>>>>({
    light: {},
    dark: {},
  })

  const blur = useDraftValue(settings.wallpaper_blur)
  const dim = useDraftValue(settings.wallpaper_dim)
  // 滑杆拖一次会触发几十次 change，必须防抖，否则接口会被打爆
  const commitBlur = useDebouncedCommit<[number]>((v) => void save({ wallpaper_blur: v }), 300)
  const commitDim = useDebouncedCommit<[number]>((v) => void save({ wallpaper_dim: v }), 300)

  const typeKey = slot === 'dark' ? 'wallpaper_dark_type' : 'wallpaper_light_type'
  const valueKey = slot === 'dark' ? 'wallpaper_dark_value' : 'wallpaper_light_value'
  const type = slot === 'dark' ? settings.wallpaper_dark_type : settings.wallpaper_light_type
  const value = slot === 'dark' ? settings.wallpaper_dark_value : settings.wallpaper_light_value

  function changeType(next: WallpaperType) {
    if (next === type) return
    memory.current[slot][type] = value
    const remembered = memory.current[slot][next]
    void save({
      [typeKey]: next,
      [valueKey]: remembered ?? valueForType(next, value),
    })
  }

  async function uploadWallpaper(file: File) {
    setUploading(true)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await api<{ url: string }>('/api/upload', { method: 'POST', body })
      memory.current[slot].image = res.url
      await save({ [typeKey]: 'image', [valueKey]: res.url })
      toast.success('壁纸已上传')
    } catch (err) {
      toast.error(errorMessage(err, '上传失败'))
    } finally {
      setUploading(false)
      // 清空 input，否则选同一个文件不会再触发 change
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const colorValue = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#0b1020'

  return (
    <SettingsSection id="appearance" description="主题、壁纸、卡片与毛玻璃强度">
      <AppearancePreview
        type={type}
        value={value}
        blur={blur.draft}
        dim={dim.draft}
        cardSize={settings.card_size}
        gap={settings.grid_gap}
        isDark={slot === 'dark'}
      />

      <Segmented
        label="主题"
        value={settings.theme}
        options={THEMES}
        onChange={setTheme}
        deviceLocal
        hint="仅保存在当前浏览器，切换深浅色不会影响其它设备。壁纸和其它外观配置仍可同步。"
      />

      {/* 壁纸分两套。这里选的是「现在编辑哪一套」，不是「现在用哪一套」——
          用哪一套由主题自动决定（浅色主题用浅色那套）。 */}
      <Segmented
        label="正在编辑哪套壁纸"
        value={slot}
        options={WALLPAPER_SLOTS}
        onChange={(next) => setSlot(next)}
        hint={
          settings.theme === 'auto'
            ? '主题设为「跟随系统」时，系统切深浅色，壁纸也跟着换。两套都配好即可。'
            : `当前主题是「${settings.theme === 'dark' ? '深色' : '浅色'}」，首页用的是${
                slot === (settings.theme === 'dark' ? 'dark' : 'light') ? '这一套' : '另一套'
              }。`
        }
      />

      <Segmented label="壁纸类型" value={type} options={WALLPAPER_TYPES} onChange={changeType} />

      {type === 'gradient' && (
        <FieldBlock label="渐变预设" hint="全部由 CSS 渐变生成，零请求、任意分辨率都不糊">
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {GRADIENT_PRESETS.map((preset) => {
              const active = preset.id === value
              return (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.name}
                  aria-pressed={active}
                  disabled={readOnly}
                  onClick={() => void save({ [valueKey]: preset.id })}
                  className={[
                    'flex flex-col items-center gap-1 rounded-xl p-1 transition disabled:cursor-not-allowed disabled:opacity-50',
                    active ? 'bg-line/15 ring-2 ring-brand-400' : 'hover:bg-line/10',
                  ].join(' ')}
                >
                  <span
                    className="h-9 w-full rounded-lg border border-line/15"
                    style={{ backgroundImage: preset.css }}
                  />
                  <span className="text-[10px] text-fg/70">{preset.name}</span>
                </button>
              )
            })}
          </div>
        </FieldBlock>
      )}

      {type === 'color' && (
        <FieldBlock label="壁纸颜色" hint="深浅都能用：背景会自动适配，保证文字始终可读">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              aria-label="自定义颜色"
              className="h-11 w-16 cursor-pointer rounded-xl border border-line/15 bg-line/10 p-1 disabled:cursor-not-allowed disabled:opacity-50"
              value={colorValue}
              disabled={readOnly}
              onChange={(e) => void save({ [valueKey]: e.target.value })}
            />
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                aria-label={`颜色 ${c}`}
                disabled={readOnly}
                onClick={() => void save({ [valueKey]: c })}
                className={[
                  'size-9 rounded-xl border border-line/15 transition disabled:cursor-not-allowed disabled:opacity-50',
                  c.toLowerCase() === value.toLowerCase() ? 'ring-2 ring-brand-400' : '',
                ].join(' ')}
                style={{ background: c }}
              />
            ))}
          </div>
        </FieldBlock>
      )}

      {type === 'image' && (
        <FieldBlock
          label="本地图片"
          hint="支持 PNG / JPG / WebP / GIF / SVG / ICO，单张最大 5MB；上传后存在服务器上，换设备也能看到"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void uploadWallpaper(file)
              }}
            />
            <button
              type="button"
              className={btnGhost}
              disabled={uploading || readOnly}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />
              ) : (
                <Upload className="mr-1.5 inline size-3.5" aria-hidden />
              )}
              {uploading ? '上传中…' : '选择图片'}
            </button>
            {value ? (
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg/50">
                {value}
              </span>
            ) : (
              <span className="text-[11px] text-fg/40">还没有上传</span>
            )}
          </div>
        </FieldBlock>
      )}

      {type === 'url' && (
        <SettingTextField
          id="set-wallpaper-url"
          label="图片链接"
          value={value}
          onSave={(next) => void save({ [valueKey]: next })}
          placeholder="https://example.com/wallpaper.jpg"
          inputMode="url"
          mono
          hint="外链图片可能因跨域或防盗链加载失败，本地上传更稳"
          trailing={
            <span className="flex items-center gap-1 text-[11px] text-fg/40">
              <ImagePlus className="size-3.5" aria-hidden />
              直接粘贴图片地址
            </span>
          }
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <SliderField
          id="set-wallpaper-blur"
          label="壁纸模糊"
          value={blur.draft}
          min={0}
          max={40}
          format={(v) => `${v}px`}
          onFocus={blur.onFocus}
          onBlur={blur.onBlur}
          onChange={(v) => {
            blur.setDraft(v)
            commitBlur.schedule(v)
          }}
          hint="数值越大越柔和，也越吃 GPU"
        />
        <SliderField
          id="set-wallpaper-dim"
          label="壁纸压暗"
          value={dim.draft}
          min={0}
          max={85}
          format={(v) => `${v}%`}
          onFocus={dim.onFocus}
          onBlur={dim.onBlur}
          onChange={(v) => {
            dim.setDraft(v)
            commitDim.schedule(v)
          }}
          hint="压暗后白色文字更容易看清"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Segmented
          label="卡片大小"
          value={settings.card_size}
          options={CARD_SIZES}
          onChange={(next) => void save({ card_size: next })}
        />
        <Segmented
          label="网格间距"
          value={settings.grid_gap}
          options={GAPS}
          onChange={(next) => void save({ grid_gap: next })}
        />
      </div>

      <Segmented
        label="毛玻璃强度"
        value={settings.glass}
        options={GLASS_LEVELS}
        onChange={(next) => void save({ glass: next })}
      />
      {settings.glass === 'none' && (
        <Note tone="warn" icon={ImagePlus}>
          关闭毛玻璃后卡片变成不透明底色，壁纸透不出来，但滚动会更顺滑（低配设备建议如此）。
        </Note>
      )}

      {/* 壁纸上的文字颜色。三处直接压在壁纸上的文字各自可选：
          「自动」会读壁纸在那一块的明暗 —— 壁纸上下差别大时，每处是分别判断的。 */}
      <div className="rounded-2xl border border-line/10 bg-line/[0.04] p-4">
        <div className="mb-3.5 flex items-start gap-2.5">
          <Type className="mt-0.5 size-4 shrink-0 text-fg/45" aria-hidden />
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-fg">壁纸上的文字颜色</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-fg/50">
              这三处文字直接压在壁纸上，默认按壁纸在<b className="font-medium text-fg/70">那一块</b>
              的明暗自动选黑或白 —— 壁纸上半亮、下半暗时，每处是分别判断的。
              也可以在这里固定成黑或白。
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Segmented
            label="时钟区"
            value={settings.tone_clock}
            options={TONE_OPTIONS}
            onChange={(next) => void save({ tone_clock: next })}
          />
          <Segmented
            label="分组标题"
            value={settings.tone_heading}
            options={TONE_OPTIONS}
            onChange={(next) => void save({ tone_heading: next })}
          />
          <Segmented
            label="子页面标题"
            value={settings.tone_page_title}
            options={TONE_OPTIONS}
            onChange={(next) => void save({ tone_page_title: next })}
          />
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-fg/40">
        上面这些改动保存后立刻生效，回首页即可看到效果。
      </p>
    </SettingsSection>
  )
}
