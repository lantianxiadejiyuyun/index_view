import { useEffect, useId, useRef, useState } from 'react'
import { Check, Loader2, RotateCcw, Sparkles } from 'lucide-react'
import {
  APPEARANCE_PRESETS,
  appearancePresetPatch,
  type AppearancePresetId,
} from '../../lib/appearance-presets.ts'
import type { AppSettings } from '../../lib/settings.ts'
import { useApp } from '../../store/app.ts'
import { btnGhost, btnPrimary } from '../Modal.tsx'
import { useSettingsSave, type SettingsPatch } from './saver.tsx'
import './AppearancePresets.css'

/** Static, decorative previews keep the selector lightweight on phones. */
function PresetThumbnail({ id }: { id: AppearancePresetId }) {
  return (
    <span className={`appearance-preset-scene appearance-preset-scene--${id}`} aria-hidden="true">
      <span className="appearance-preset-scene__bar">
        <i /><i /><i />
        <span>{id === 'terminal' ? '~/start' : '我的空间'}</span>
      </span>
      <span className="appearance-preset-scene__clock">{id === 'terminal' ? '> 09:41' : '09:41'}</span>
      <span className="appearance-preset-scene__search"><i /><span /></span>
      <span className="appearance-preset-scene__apps">
        {[0, 1, 2, 3].map((item) => (
          <span className="appearance-preset-scene__app" key={item}><i /><b /></span>
        ))}
      </span>
      <span className="appearance-preset-scene__dock"><i /><i /><i /><i /></span>
    </span>
  )
}

function previousValues(settings: AppSettings, patch: SettingsPatch): SettingsPatch {
  const previous: SettingsPatch = {}
  for (const key of Object.keys(patch)) {
    // The device-local light/dark preference must never enter a preset or undo request.
    if (key === 'theme') continue
    const value = settings[key as keyof AppSettings]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      previous[key] = value
    }
  }
  return previous
}

export function AppearancePresets({
  disabled = false,
  beforeApply,
  onApplyingChange,
}: {
  disabled?: boolean
  beforeApply?: () => void
  onApplyingChange?: (applying: boolean) => void
}) {
  const settings = useApp((s) => s.settings)
  const { save, readOnly, saving } = useSettingsSave()
  const [selected, setSelected] = useState<AppearancePresetId>(settings.appearance_preset)
  const [preserveWallpaper, setPreserveWallpaper] = useState(true)
  const [action, setAction] = useState<'apply' | 'restore' | null>(null)
  const [previous, setPrevious] = useState<SettingsPatch | null>(null)
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null)
  const inFlight = useRef(false)
  const id = useId()
  const unavailable = disabled || readOnly || saving || action !== null
  const preset = APPEARANCE_PRESETS.find((item) => item.id === selected) ?? APPEARANCE_PRESETS[0]!

  useEffect(() => setSelected(settings.appearance_preset), [settings.appearance_preset])

  async function apply(restore = false) {
    if (unavailable || inFlight.current || (restore && !previous)) return
    const patch = restore ? previous! : appearancePresetPatch(selected, { preserveWallpaper })
    const snapshot = previousValues(settings, patch)
    inFlight.current = true
    setAction(restore ? 'restore' : 'apply')
    setFeedback(null)
    beforeApply?.()
    onApplyingChange?.(true)
    try {
      const saved = await save(patch)
      if (!saved) {
        setFeedback({ error: true, message: restore ? '恢复失败，原来的外观仍可重试恢复。' : '主题未保存成功，请重试。' })
        return
      }
      setPrevious(restore ? null : snapshot)
      const savedPreset = APPEARANCE_PRESETS.find((item) => item.id === patch.appearance_preset)
      if (savedPreset) setSelected(savedPreset.id)
      setFeedback({
        error: false,
        message: restore
          ? '已恢复上一次外观。'
          : `已应用「${preset.name}」${preserveWallpaper ? '，保留现有壁纸。' : '及推荐壁纸。'}`,
      })
    } finally {
      inFlight.current = false
      setAction(null)
      onApplyingChange?.(false)
    }
  }

  return (
    <div className="appearance-presets">
      <fieldset disabled={unavailable} className="min-w-0">
        <legend className="mb-1 flex items-center gap-2 text-sm font-semibold text-fg">
          <Sparkles className="size-4 text-accent" aria-hidden />
          内置主题
        </legend>
        <p className="mb-3 text-xs leading-relaxed text-fg/55">
          先选择喜欢的风格，再应用整套外观。每套均适配手机与深浅色模式。
        </p>
        <div className="appearance-presets__grid">
          {APPEARANCE_PRESETS.map((item) => {
            const active = item.id === settings.appearance_preset
            return (
              <label className="appearance-preset" key={item.id}>
                <input
                  type="radio"
                  name={`${id}-appearance-preset`}
                  value={item.id}
                  checked={item.id === selected}
                  onChange={() => { setSelected(item.id); setFeedback(null) }}
                  aria-labelledby={`${id}-${item.id}-name`}
                  aria-describedby={`${id}-${item.id}-description`}
                  className="appearance-preset__input"
                />
                <span className="appearance-preset__body">
                  <PresetThumbnail id={item.id} />
                  <span className="appearance-preset__name" id={`${id}-${item.id}-name`}>
                    {item.name}
                    <Check className="appearance-preset__check" aria-hidden />
                  </span>
                  <span className="appearance-preset__description" id={`${id}-${item.id}-description`}>{item.description}</span>
                  <span className={`appearance-preset__tag ${active ? 'appearance-preset__tag--active' : ''}`}>
                    {active ? '当前风格' : item.tag}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border border-line/10 bg-line/[0.035] p-3 text-xs text-fg/80">
          <input
            type="checkbox"
            checked={preserveWallpaper}
            onChange={(event) => setPreserveWallpaper(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-brand-500"
          />
          <span className="min-w-0">
            <span className="font-medium">保留现有壁纸</span>
            <span className="mt-1 block leading-relaxed text-fg/55">只切换界面风格；取消勾选可一并应用推荐壁纸。</span>
          </span>
        </label>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={`${btnPrimary} inline-flex items-center justify-center gap-2`} disabled={unavailable} onClick={() => void apply()}>
          {action === 'apply' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
          {action === 'apply' ? '应用中…' : '应用主题'}
        </button>
        {previous && (
          <button type="button" className={`${btnGhost} inline-flex items-center justify-center gap-2`} disabled={unavailable} onClick={() => void apply(true)}>
            {action === 'restore' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
            {action === 'restore' ? '恢复中…' : '恢复上一次外观'}
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-fg/50">{readOnly ? '登录后可应用主题。' : `已选择：${preset.name}。外观可同步，深浅色仍只保存在本机。`}</p>
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`mt-2 text-xs leading-relaxed ${feedback.error ? 'text-danger' : 'text-success'}`}>{feedback.message}</p>}
    </div>
  )
}
