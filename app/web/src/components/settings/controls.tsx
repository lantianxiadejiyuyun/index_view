/**
 * 设置页共用的表单控件。
 *
 * 全部复用 Modal.tsx 导出的 fieldClass / labelClass / btn* 常量，
 * 保证设置页和编辑弹窗是同一套质感，改一处全局生效。
 *
 * 控件一律是「受控 + 立刻上报」的哑组件：草稿、防抖、落库策略留给各分区决定，
 * 这样滑杆的实时预览、输入框的失焦保存这些差异不会把控件本身撑复杂。
 */
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LockKeyhole, LogIn } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { btnPrimary, fieldClass, labelClass } from '../Modal.tsx'
import { useSettingsSave } from './saver.tsx'

/** 输入类控件的统一外观；禁用态在只读（未登录）时才会用到 */
export const inputClass = `${fieldClass} disabled:cursor-not-allowed disabled:opacity-50`

// ── 通用小工具 ────────────────────────────────────────────────

/**
 * 高频改动的落库节流：本地立即反馈，停顿 delay 毫秒后才真正打接口。
 *
 * 为什么不用「每次 change 都存」：拖一次滑杆会打出几十个 PUT，
 * 而设置接口是整表读写的，那样既费流量又会让「已保存」提示疯狂闪烁。
 */
export function useDebouncedCommit<A extends unknown[]>(fn: (...args: A) => void, delay = 300) {
  const timer = useRef<number | null>(null)
  const argsRef = useRef<A | null>(null)
  const fnRef = useRef(fn)

  useEffect(() => {
    fnRef.current = fn
  })

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    argsRef.current = null
  }, [])

  /** 立刻把待提交的值发出去（失焦、点按钮时用） */
  const flush = useCallback(() => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
    const args = argsRef.current
    argsRef.current = null
    if (args) fnRef.current(...args)
  }, [])

  const schedule = useCallback(
    (...args: A) => {
      argsRef.current = args
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        argsRef.current = null
        fnRef.current(...args)
      }, delay)
    },
    [delay],
  )

  // 卸载时把还没落库的改动冲出去，别让用户刚拖完就跳走的操作凭空消失
  useEffect(() => flush, [flush])

  return { schedule, flush, cancel }
}

/**
 * 表单草稿。聚焦期间不跟外部值同步 —— 否则把站点标题清空时，
 * 归一化补上的默认值会立刻把输入框顶回去，看起来像「删不掉」。
 */
export function useDraftValue<T>(value: T) {
  const [draft, setDraft] = useState(value)
  const editing = useRef(false)

  useEffect(() => {
    if (!editing.current) setDraft(value)
  }, [value])

  return {
    draft,
    setDraft,
    onFocus: () => {
      editing.current = true
    },
    onBlur: () => {
      editing.current = false
    },
  }
}

// ── 布局 ──────────────────────────────────────────────────────

/** 竖排表单块：标题 / 控件 / 说明。窄屏单列，宽屏由分区自己决定是否两列 */
export function FieldBlock({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-relaxed text-fg/45">{hint}</p>}
    </div>
  )
}

const NOTE_TONES = {
  info: 'border-sky-400/25 bg-sky-500/10 text-info',
  warn: 'border-amber-400/25 bg-amber-500/10 text-warn',
  danger: 'border-rose-400/25 bg-rose-500/10 text-danger',
} as const

/** 说明块。危险操作（replace 导入、轮换令牌）一律用它把后果写在按钮旁边 */
export function Note({
  tone = 'info',
  icon: Icon,
  children,
}: {
  tone?: keyof typeof NOTE_TONES
  icon?: LucideIcon
  children: ReactNode
}) {
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[11px] leading-relaxed ${NOTE_TONES[tone]}`}
    >
      {Icon && <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** 只读（未登录）时给出明确的下一步，而不是让控件静默失效 */
export function LoginRequired({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line/10 bg-line/5 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm text-fg/85">{children}</p>
          <p className="mt-0.5 text-xs text-fg/50">这部分内容只对管理员开放。</p>
        </div>
      </div>
      <Link to="/login" className={`${btnPrimary} flex shrink-0 items-center gap-1.5`}>
        <LogIn className="size-3.5" aria-hidden />
        去登录
      </Link>
    </div>
  )
}

// ── 控件 ──────────────────────────────────────────────────────

type TextFieldProps = {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  onFocus?: () => void
  onBlur?: () => void
  hint?: ReactNode
  placeholder?: string
  maxLength?: number
  inputMode?: 'text' | 'url' | 'numeric' | 'decimal'
  /** 取值紧凑的输入（端口、前缀）用等宽字体更好读 */
  mono?: boolean
  /** 输入框右侧的附加按钮（例如「测试」） */
  trailing?: ReactNode
}

export function TextField({
  id,
  label,
  value,
  onChange,
  onFocus,
  onBlur,
  hint,
  placeholder,
  maxLength,
  inputMode,
  mono = false,
  trailing,
}: TextFieldProps) {
  const { readOnly } = useSettingsSave()

  const input = (
    <input
      id={id}
      className={`${inputClass} ${mono ? 'font-mono' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
      onBlur={onBlur}
      placeholder={placeholder}
      maxLength={maxLength}
      inputMode={inputMode}
      disabled={readOnly}
      spellCheck={false}
      autoComplete="off"
    />
  )

  return (
    <FieldBlock label={label} htmlFor={id} hint={hint}>
      {trailing ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">{input}</div>
          <div className="shrink-0">{trailing}</div>
        </div>
      ) : (
        input
      )}
    </FieldBlock>
  )
}

/** 文本设置项：自带草稿、400ms 防抖、失焦立即落库 */
export function SettingTextField({
  id,
  label,
  value,
  onSave,
  hint,
  placeholder,
  maxLength,
  inputMode,
  mono,
  normalize,
  trailing,
}: {
  id: string
  label: string
  value: string
  onSave: (next: string) => void
  hint?: ReactNode
  placeholder?: string
  maxLength?: number
  inputMode?: 'text' | 'url' | 'numeric' | 'decimal'
  mono?: boolean
  /** 失焦时规整草稿（例如端口列表去空格去重） */
  normalize?: (raw: string) => string
  trailing?: ReactNode
}) {
  const draft = useDraftValue(value)
  const commit = useDebouncedCommit<[string]>(onSave, 400)
  const savedRef = useRef(value)

  useEffect(() => {
    savedRef.current = value
  }, [value])

  return (
    <TextField
      id={id}
      label={label}
      value={draft.draft}
      onChange={(next) => {
        draft.setDraft(next)
        commit.schedule(next)
      }}
      onFocus={draft.onFocus}
      onBlur={() => {
        draft.onBlur()
        // 失焦就落库：等防抖会把「输完立刻切页」的改动丢掉
        commit.cancel()
        const next = normalize ? normalize(draft.draft) : draft.draft
        if (next !== draft.draft) draft.setDraft(next)
        if (next !== savedRef.current) onSave(next)
      }}
      hint={hint}
      placeholder={placeholder}
      maxLength={maxLength}
      inputMode={inputMode}
      mono={mono}
      trailing={trailing}
    />
  )
}

/** 滑杆。整条 44px 高，手机上拇指按得准 */
export function SliderField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onFocus,
  onBlur,
  format,
  hint,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (next: number) => void
  onFocus?: () => void
  onBlur?: () => void
  format?: (value: number) => string
  hint?: ReactNode
}) {
  const { readOnly } = useSettingsSave()

  return (
    <FieldBlock label={label} htmlFor={id} hint={hint}>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          className="h-11 min-w-0 flex-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          style={{ accentColor: 'var(--color-brand-500)' }}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onFocus={onFocus}
          onBlur={onBlur}
          disabled={readOnly}
        />
        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-fg/70">
          {format ? format(value) : value}
        </span>
      </div>
    </FieldBlock>
  )
}

/** 开关。整行都是点击区，满足移动端 44px 触摸目标 */
export function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
}) {
  const { readOnly } = useSettingsSave()

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={readOnly}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 w-full items-center justify-between gap-4 rounded-xl border border-line/10 bg-line/5 px-3 py-2 text-left transition hover:bg-line/10 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="min-w-0">
        <span className="block text-sm text-fg/90">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-fg/45">{hint}</span>}
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          checked ? 'bg-brand-500' : 'bg-line/20'
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-line shadow transition-all ${
            checked ? 'left-[1.375rem]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}

/** 分段选择。选项少（2–4 个）且需要一眼看全时比下拉框好用 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  deviceLocal = false,
}: {
  label: string
  value: T
  options: { value: T; label: string; icon?: LucideIcon; title?: string }[]
  onChange: (next: T) => void
  hint?: ReactNode
  /** 本地显示偏好无须管理员权限；其它共享设置仍由 readOnly 控制。 */
  deviceLocal?: boolean
}) {
  const { readOnly } = useSettingsSave()

  return (
    <FieldBlock label={label} hint={hint}>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt.value === value
          const Icon = opt.icon
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={opt.title}
              disabled={readOnly && !deviceLocal}
              onClick={() => onChange(opt.value)}
              className={[
                'flex min-h-11 min-w-[4.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
                active
                  ? 'bg-brand-500 text-white shadow-lg'
                  : 'bg-line/10 text-fg/70 hover:bg-line/20 hover:text-fg',
              ].join(' ')}
            >
              {Icon && <Icon className="size-3.5" aria-hidden />}
              {opt.label}
            </button>
          )
        })}
      </div>
    </FieldBlock>
  )
}
