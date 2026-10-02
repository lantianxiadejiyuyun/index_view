import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

type ModalProps = {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** 宽一点的表单用 wide */
  size?: 'sm' | 'md' | 'wide' | 'editor'
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  wide: 'max-w-3xl',
  editor: 'max-w-6xl',
} as const

export function Modal({ open, title, onClose, children, footer, size = 'md' }: ModalProps) {
  const dialog = useRef<HTMLDivElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)

  useEffect(() => {
    if (!open || size !== 'editor') return
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => element.getClientRects().length > 0)
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0], last = elements.at(-1)
      if (!first || !last) { event.preventDefault(); dialog.current?.focus(); return }
      if (!dialog.current?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    if (!dialog.current?.contains(document.activeElement)) (focusable()[0] ?? dialog.current)?.focus()
    window.addEventListener('keydown', onTab)
    return () => {
      window.removeEventListener('keydown', onTab)
      if (returnFocus.current?.isConnected) returnFocus.current.focus()
    }
  }, [open, size])
  // Esc 关闭 + 打开期间锁住背景滚动，否则移动端会「弹窗后面的页面在滚」
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div
        ref={dialog}
        tabIndex={size === 'editor' ? -1 : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={[
          'glass glass-pop animate-rise relative z-10 flex w-full flex-col overflow-hidden',
          size === 'editor' ? 'h-[calc(100dvh-env(safe-area-inset-top))] max-h-[calc(100dvh-env(safe-area-inset-top))] sm:h-[94dvh] sm:max-h-[94dvh]' : 'max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] sm:max-h-[92dvh]',
          'rounded-t-3xl sm:rounded-3xl',
          SIZES[size],
        ].join(' ')}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line/10 px-4 py-3 sm:px-5 sm:py-4">
          <h2 className="min-w-0 break-words text-base font-semibold text-fg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl text-fg/60 transition hover:bg-line/15 hover:text-fg"
            aria-label="关闭"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${size === 'editor' ? '' : 'px-4 py-4 sm:px-5'} ${footer ? '' : 'pb-[calc(1rem+env(safe-area-inset-bottom))]'}`}>{children}</div>

        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line/10 px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-5 sm:pt-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/** 表单控件统一样式，避免每个弹窗重复写一长串 class */
export const fieldClass =
  'min-h-11 w-full min-w-0 rounded-xl border border-line/15 bg-line/10 px-3 py-2.5 text-sm text-fg outline-none transition placeholder:text-fg/40 focus:border-line/40 focus:bg-line/15'

export const labelClass = 'mb-1.5 block text-xs font-medium text-fg/70'

export const btnPrimary =
  'min-h-11 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50'

export const btnGhost =
  'min-h-11 rounded-xl border border-line/15 px-4 py-2.5 text-sm font-medium text-fg/80 transition hover:bg-line/10 hover:text-fg disabled:opacity-50'

export const btnDanger =
  'min-h-11 rounded-xl border border-rose-400/30 bg-rose-500/15 px-4 py-2.5 text-sm font-medium text-danger transition hover:bg-rose-500/25'
