import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useToast } from '../store/toast.ts'

const ICONS = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const

const TONES = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-info',
} as const

export function Toaster() {
  const toasts = useToast((s) => s.toasts)
  const dismiss = useToast((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind]
        return (
          <div
            key={t.id}
            role="status"
            className="glass glass-pop animate-pop pointer-events-auto flex max-w-md items-start gap-2.5 rounded-xl px-4 py-3 text-sm text-fg"
          >
            <Icon className={`mt-0.5 size-4 shrink-0 ${TONES[t.kind]}`} aria-hidden />
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-mr-1 shrink-0 rounded-md p-1 text-fg/50 transition hover:bg-line/15 hover:text-fg"
              aria-label="关闭提示"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}
