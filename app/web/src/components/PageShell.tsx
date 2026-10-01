import { useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { readableToneStyle, useReadableTone } from '../lib/useWallpaperTone.ts'
import { useApp } from '../store/app.ts'

/** 子页面（笔记 / 设置）共用的外壳：顶部返回 + 标题，内容区限宽居中 */
export function PageShell({
  title,
  description,
  actions,
  children,
  wide = false,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  wide?: boolean
}) {
  // 页头标题也压在壁纸上，同样按自己所在的区域判断明暗（可被设置项强制覆盖）
  const titleTonePref = useApp((s) => s.settings.tone_page_title)
  const titleRef = useRef<HTMLDivElement>(null)
  const titleTone = useReadableTone(titleRef, titleTonePref)

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 pt-[calc(1rem+env(safe-area-inset-top))] sm:px-6 sm:pt-[calc(1.5rem+env(safe-area-inset-top))]">
        <div className={`mx-auto flex items-center gap-3 ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}>
          <Link
            to="/"
            className="glass flex size-9 shrink-0 items-center justify-center rounded-xl text-fg/80 transition hover:text-fg"
            aria-label="返回首页"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>

          <div ref={titleRef} style={readableToneStyle(titleTone)} className="min-w-0 flex-1">
            {/* 标题直接压在壁纸上，用 wp（跟随壁纸明暗）而不是 fg（跟随主题） */}
            <h1 className="text-shadow-soft truncate text-base font-semibold text-wp">{title}</h1>
            {description && (
              <p className="text-shadow-soft truncate text-xs text-wp/80">{description}</p>
            )}
          </div>

          {actions}
        </div>
      </header>

      <main
        className={`mx-auto w-full flex-1 px-4 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 sm:pb-8 ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}
      >
        {children}
      </main>
    </div>
  )
}
