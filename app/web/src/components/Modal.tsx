import type { ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'
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

// Only the top dialog handles keys; background scrolling stays locked until all dialogs close.
const openDialogs: HTMLDivElement[] = []
let previousBodyOverflow = ''

export function Modal({ open, title, onClose, children, footer, size = 'md' }: ModalProps) {
  const dialog = useRef<HTMLDivElement | null>(null)
  const close = useRef(onClose)
  const titleId = useId()
  const wasOpen = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  // Capture before React mounts any autoFocus fields inside the newly opened dialog.
  if (open && !wasOpen.current) {
    returnFocus.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  wasOpen.current = open

  useEffect(() => { close.current = onClose }, [onClose])

  useEffect(() => {
    const element = dialog.current
    if (!open || !element) return
    const trigger = returnFocus.current
    if (openDialogs.length === 0) {
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    openDialogs.push(element)
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')).filter((item) => item.tabIndex >= 0 && item.getClientRects().length > 0)
    const onKey = (event: KeyboardEvent) => {
      if (openDialogs.at(-1) !== element) return
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0], last = elements.at(-1)
      if (!first || !last) { event.preventDefault(); element.focus({ preventScroll: true }); return }
      if (!element.contains(document.activeElement) || document.activeElement === element || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    // Preserve explicit autoFocus fields; other dialogs focus their container without opening a keyboard.
    if (!element.contains(document.activeElement)) element.focus({ preventScroll: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const wasTop = openDialogs.at(-1) === element
      const index = openDialogs.indexOf(element)
      if (index >= 0) openDialogs.splice(index, 1)
      if (openDialogs.length === 0) document.body.style.overflow = previousBodyOverflow
      if (wasTop) {
        const top = openDialogs.at(-1)
        if (trigger?.isConnected && (!top || top.contains(trigger))) trigger.focus({ preventScroll: true })
        else top?.focus({ preventScroll: true })
      }
    }
  }, [open])

  if (!open) return null

  return (
    <div className="shared-modal fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={[
          'glass glass-pop animate-rise relative z-10 flex w-full min-w-0 flex-col overflow-hidden outline-none',
          size === 'editor' ? 'h-[calc(100dvh-env(safe-area-inset-top))] max-h-[calc(100dvh-env(safe-area-inset-top))] sm:h-[94dvh] sm:max-h-[94dvh]' : 'max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] sm:max-h-[92dvh]',
          'rounded-t-3xl sm:rounded-3xl',
          SIZES[size],
        ].join(' ')}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line/10 px-4 py-3 sm:px-5 sm:py-4">
          <h2 id={titleId} className="min-w-0 text-base font-semibold text-fg [overflow-wrap:anywhere]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl text-fg/60 transition hover:bg-line/15 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            aria-label="关闭"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [overflow-wrap:anywhere] ${size === 'editor' ? '' : 'px-4 py-4 sm:px-5'} ${footer ? '' : 'pb-[calc(1rem+env(safe-area-inset-bottom))]'}`}>{children}</div>

        {footer && (
          <div className="shared-modal-footer flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line/10 px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-5 sm:pt-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/** 表单控件统一样式，避免每个弹窗重复写一长串 class */
export const fieldClass =
  'min-h-11 w-full min-w-0 rounded-xl border border-line/15 bg-line/10 px-3 py-2.5 text-sm text-fg outline-none transition placeholder:text-fg/40 focus:border-accent/60 focus:bg-line/15 focus:ring-2 focus:ring-accent/20'

export const labelClass = 'mb-1.5 block text-xs font-medium text-fg/70'

export const btnPrimary =
  'min-h-11 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50'

export const btnGhost =
  'min-h-11 rounded-xl border border-line/15 px-4 py-2.5 text-sm font-medium text-fg/80 transition hover:bg-line/10 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'

export const btnDanger =
  'min-h-11 rounded-xl border border-rose-400/30 bg-rose-500/15 px-4 py-2.5 text-sm font-medium text-danger transition hover:bg-rose-500/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
