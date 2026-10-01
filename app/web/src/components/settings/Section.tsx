/**
 * 设置分区的外壳与导航。
 *
 * 分区元数据集中在这里，是为了让「左侧导航」和「实际渲染的分区」永远同源 ——
 * 加一个分区只要往 SETTINGS_SECTIONS 里加一行，导航与锚点自动跟上。
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Bookmark,
  Database,
  Info,
  LayoutGrid,
  MousePointerClick,
  Palette,
  Search,
  ShieldCheck,
} from 'lucide-react'

export type SettingsSectionMeta = {
  id: string
  title: string
  icon: LucideIcon
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: 'site', title: '站点信息', icon: Info },
  { id: 'appearance', title: '外观', icon: Palette },
  { id: 'search', title: '搜索', icon: Search },
  { id: 'widgets', title: '小组件', icon: LayoutGrid },
  { id: 'behavior', title: '行为', icon: MousePointerClick },
  { id: 'account', title: '账号与安全', icon: ShieldCheck },
  { id: 'backup', title: '数据备份', icon: Database },
  { id: 'bookmarks', title: '书签导入', icon: Bookmark },
]

/** 数组字面量是稳定的，滚动监听可以直接拿它当依赖，不必每次渲染新建 */
const SECTION_IDS: string[] = SETTINGS_SECTIONS.map((s) => s.id)

/** 标题与图标从 SETTINGS_SECTIONS 里取，导航和卡片不可能对不上 */
export function SettingsSection({
  id,
  description,
  children,
}: {
  id: string
  description?: string
  children: ReactNode
}) {
  const meta = SETTINGS_SECTIONS.find((s) => s.id === id)
  const Icon = meta?.icon ?? Info
  const title = meta?.title ?? id

  return (
    <section
      id={id}
      // scroll-mt 给锚点跳转留出顶部呼吸位，否则标题会贴着视口顶端
      className="glass animate-rise scroll-mt-6 rounded-2xl p-4 sm:p-5"
    >
      <header className="mb-4 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-line/10 text-accent">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg sm:text-base">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-fg/50">{description}</p>}
        </div>
      </header>

      <div className="space-y-4">{children}</div>
    </section>
  )
}

/**
 * 高亮当前分区。
 * 取「可见比例最大」的那个而不是「第一个可见的」：长分区（外观）占满屏幕时
 * 短分区（站点信息）其实已经滚过去了，按第一个可见会一直卡在旧分区上。
 */
function useActiveSection(): string {
  const [active, setActive] = useState(SECTION_IDS[0] ?? '')

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return

    const nodes: HTMLElement[] = []
    for (const id of SECTION_IDS) {
      const el = document.getElementById(id)
      if (el) nodes.push(el)
    }
    if (nodes.length === 0) return

    const ratios = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0)
        }
        let best = ''
        let bestRatio = 0
        for (const [id, ratio] of ratios) {
          if (ratio > bestRatio) {
            best = id
            bestRatio = ratio
          }
        }
        if (best) setActive(best)
      },
      { threshold: [0, 0.1, 0.3, 0.6], rootMargin: '-64px 0px -35% 0px' },
    )

    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return active
}

const ITEM_BASE =
  'flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-xs font-medium transition'

/** 桌面端左侧竖排导航 */
export function SettingsNavAside() {
  const active = useActiveSection()

  return (
    <nav aria-label="设置分区" className="hidden lg:sticky lg:top-6 lg:block">
      <ul className="glass rounded-2xl p-2">
        {SETTINGS_SECTIONS.map((section) => {
          const Icon = section.icon
          const on = section.id === active
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={on ? 'true' : undefined}
                className={`${ITEM_BASE} ${
                  on ? 'bg-brand-500 text-white shadow-lg' : 'text-fg/70 hover:bg-line/10 hover:text-fg'
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{section.title}</span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * 移动端分区导航。
 * 外面套一层 overflow-x-auto：横向滚动条落在容器内部，不会把整个文档撑宽。
 */
export function SettingsNavBar() {
  const active = useActiveSection()

  return (
    <nav
      aria-label="设置分区"
      className="-mx-4 overflow-x-auto px-4 pb-0.5 sm:-mx-6 sm:px-6 lg:hidden"
    >
      <div className="flex w-max gap-2">
        {SETTINGS_SECTIONS.map((section) => {
          const Icon = section.icon
          const on = section.id === active
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              aria-current={on ? 'true' : undefined}
              className={`${ITEM_BASE} border ${
                on
                  ? 'border-brand-400/40 bg-brand-500/90 text-white'
                  : 'glass border-line/10 text-fg/75'
              }`}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="whitespace-nowrap">{section.title}</span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}
