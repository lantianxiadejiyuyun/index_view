import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Modal, btnDanger, btnGhost, btnPrimary, fieldClass, labelClass } from '../Modal.tsx'

/**
 * 一个带输入框的弹窗，用来做「新建笔记 / 新建文件夹 / 重命名」。
 *
 * 不用 window.prompt：移动端上 prompt 是被浏览器降级处理的，输入长路径很难受，
 * 也没法做路径预填和校验提示。
 */
export function PromptDialog({
  open,
  title,
  label,
  hint,
  initialValue,
  placeholder,
  confirmText = '确定',
  busy = false,
  onCancel,
  onSubmit,
}: {
  open: boolean
  title: string
  label: string
  hint?: string
  initialValue: string
  placeholder?: string
  confirmText?: string
  busy?: boolean
  onCancel: () => void
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  // 每次打开都用最新的预填值重置，避免残留上一次的输入
  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    // 聚焦放到下一帧：弹窗是动画进场的，立刻 focus 会把动画顶掉
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [open, initialValue])

  return (
    <Modal
      open={open}
      title={title}
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || value.trim() === ''}
            onClick={() => onSubmit(value)}
          >
            {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            {confirmText}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && value.trim() !== '') onSubmit(value)
        }}
      >
        <label className={labelClass} htmlFor="note-prompt-input">
          {label}
        </label>
        <input
          id="note-prompt-input"
          ref={inputRef}
          className={fieldClass}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {hint && <p className="mt-2 text-[11px] leading-relaxed text-fg/45">{hint}</p>}
        {/* 表单里放一个隐藏提交按钮，手机软键盘的「前往」键就能直接提交 */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
      </form>
    </Modal>
  )
}

/**
 * 危险操作确认框。
 *
 * 「二次确认」由调用方再叠一层（删除目录时先问「要删目录吗」，
 * 再问「确认递归删除」），因为两种确认的措辞和后果不一样。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmText = '删除',
  busy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  message: string
  detail?: string
  confirmText?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      size="sm"
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className={btnDanger} onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            {confirmText}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-fg/85">{message}</p>
      {detail && (
        <p className="mt-3 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-danger">
          {detail}
        </p>
      )}
    </Modal>
  )
}
