/**
 * 设置页的「改完立刻保存」基础设施。
 *
 * 为什么用 Context 而不是每个控件自己 try/catch：
 * 设置项有二十多个，逐项弹 toast 会变成噪音轰炸。这里把写入收敛到一处，
 * 失败统一 toast + 页头红点，成功则只在页头闪一下「已保存」，
 * 控件本身保持无状态，改动它们不会牵动保存策略。
 */
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, TriangleAlert } from 'lucide-react'
import { useApp } from '../../store/app.ts'
import { toast } from '../../store/toast.ts'
import { errorMessage } from '../../lib/api.ts'

export type SettingsPatch = Record<string, string | number | boolean>

type SettingsSaveValue = {
  /** 未登录：控件一律禁用，且不再尝试写接口（避免弹一堆 401） */
  readOnly: boolean
  saving: boolean
  error: string | null
  /** 最近一次成功保存的时间戳；0 表示本次进入页面还没保存过 */
  savedAt: number
  save: (patch: SettingsPatch) => Promise<boolean>
}

const SettingsSaveContext = createContext<SettingsSaveValue | null>(null)

export function SettingsSaveProvider({
  readOnly,
  children,
}: {
  readOnly: boolean
  children: ReactNode
}) {
  const saveSettings = useApp((s) => s.saveSettings)

  // 用计数而不是布尔：滑杆和输入框可能同时在飞，任一未落地都该显示「保存中」
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)

  const save = useCallback(
    async (patch: SettingsPatch) => {
      setPending((n) => n + 1)
      try {
        await saveSettings(patch)
        setError(null)
        setSavedAt(Date.now())
        return true
      } catch (err) {
        const message = errorMessage(err, '保存失败')
        setError(message)
        toast.error(message)
        return false
      } finally {
        setPending((n) => n - 1)
      }
    },
    [saveSettings],
  )

  const value = useMemo<SettingsSaveValue>(
    () => ({ readOnly, saving: pending > 0, error, savedAt, save }),
    [readOnly, pending, error, savedAt, save],
  )

  return <SettingsSaveContext.Provider value={value}>{children}</SettingsSaveContext.Provider>
}

export function useSettingsSave(): SettingsSaveValue {
  const ctx = useContext(SettingsSaveContext)
  if (!ctx) throw new Error('useSettingsSave 必须在 SettingsSaveProvider 内使用')
  return ctx
}

/** 页头的轻量反馈：静默保存，但用户需要知道「刚才那下到底存住了没有」 */
export function SaveStatusChip() {
  const { saving, error, savedAt, readOnly } = useSettingsSave()
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (!savedAt) return
    setFlash(true)
    const timer = window.setTimeout(() => setFlash(false), 1800)
    return () => window.clearTimeout(timer)
  }, [savedAt])

  if (readOnly) return null

  const base = 'glass flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium'

  if (saving) {
    return (
      <div className={`${base} text-fg/75`}>
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        保存中…
      </div>
    )
  }

  if (error) {
    return (
      <div className={`${base} text-danger`} title={error}>
        <TriangleAlert className="size-3.5" aria-hidden />
        保存失败
      </div>
    )
  }

  if (!flash) return null

  return (
    <div className={`${base} animate-pop text-success`}>
      <Check className="size-3.5" aria-hidden />
      已保存
    </div>
  )
}
