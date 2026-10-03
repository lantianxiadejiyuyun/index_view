import { lazy, Suspense, useEffect } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import { ArrowRight, ChevronRight, Loader2 } from 'lucide-react'
import { PageShell } from '../components/PageShell.tsx'
import { SETTINGS_SECTIONS, SettingsNavAside, SettingsNavBar, settingsPath, type SettingsSectionId } from '../components/settings/Section.tsx'
import { SaveStatusChip, SettingsSaveProvider } from '../components/settings/saver.tsx'

// Loading a page only mounts that feature, including its requests and effects.
const PAGES = {
  site: lazy(() => import('../components/settings/SiteInfoSection.tsx').then(m => ({ default: m.SiteInfoSection }))),
  appearance: lazy(() => import('../components/settings/AppearanceSection.tsx').then(m => ({ default: m.AppearanceSection }))),
  search: lazy(() => import('../components/settings/SearchSection.tsx').then(m => ({ default: m.SearchSection }))),
  widgets: lazy(() => import('../components/settings/WidgetSection.tsx').then(m => ({ default: m.WidgetSection }))),
  behavior: lazy(() => import('../components/settings/BehaviorSection.tsx').then(m => ({ default: m.BehaviorSection }))),
  ai: lazy(() => import('../components/settings/AISection.tsx').then(m => ({ default: m.AISection }))),
  lingxi: lazy(() => import('../components/settings/LingxiSection.tsx').then(m => ({ default: m.LingxiSection }))),
  account: lazy(() => import('../components/settings/AccountSection.tsx').then(m => ({ default: m.AccountSection }))),
  backup: lazy(() => import('../components/settings/BackupSection.tsx').then(m => ({ default: m.BackupSection }))),
  bookmarks: lazy(() => import('../components/settings/BookmarkSection.tsx').then(m => ({ default: m.BookmarkSection }))),
} satisfies Record<SettingsSectionId, unknown>

export function SettingsPage() {
  const { sectionId } = useParams()
  const location = useLocation()
  const section = SETTINGS_SECTIONS.find(item => item.id === sectionId)
  const legacy = !sectionId && SETTINGS_SECTIONS.find(item => `#${item.id}` === location.hash)
  const Feature = section ? PAGES[section.id] : null
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }) }, [location.pathname])
  if (legacy) return <Navigate to={settingsPath(legacy.id)} replace />

  return <SettingsSaveProvider readOnly={false}>
    <PageShell title={section ? `设置 · ${section.title}` : '设置'} description={section?.description ?? '按功能管理外观、AI 接口、账号与数据'} wide actions={section && ['site', 'appearance', 'search', 'widgets', 'behavior'].includes(section.id) ? <SaveStatusChip /> : undefined}>
      <div className="grid gap-5 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start">
        <SettingsNavAside />
        <div className="min-w-0 space-y-5">
          <SettingsNavBar />
          {section && <nav aria-label="当前位置" className="hidden items-center gap-2 text-xs text-fg/65 lg:flex"><Link to="/settings" className="rounded-lg px-2 py-1 hover:bg-line/10">设置总览</Link><ChevronRight className="size-3" aria-hidden /><span aria-current="page">{section.title}</span></nav>}
          {Feature ? <Suspense fallback={<div role="status" className="glass flex items-center gap-2 rounded-2xl p-6 text-sm text-fg/65"><Loader2 className="size-4 animate-spin" aria-hidden />正在加载设置…</div>}><Feature /></Suspense> : sectionId ? <div className="glass rounded-2xl p-6 text-sm text-fg"><h2 className="font-semibold">没有找到这个设置页面</h2><Link to="/settings" className="mt-3 inline-flex min-h-11 items-center text-accent">返回设置总览</Link></div> : <SettingsOverview />}
        </div>
      </div>
    </PageShell>
  </SettingsSaveProvider>
}

function SettingsOverview() {
  return <div className="space-y-6">
    <div className="glass rounded-2xl p-5 sm:p-6"><h2 className="text-lg font-semibold text-fg">让导航站更适合你</h2><p className="mt-2 text-sm leading-relaxed text-fg/60">选择要调整的功能，进入独立页面。每个页面只展示相关设置，手机上也能轻松找到。</p></div>
    {[...new Set(SETTINGS_SECTIONS.map(section => section.group))].map(group => <section key={group} aria-label={group}>
      <h2 className="mb-3 px-1 text-xs font-semibold tracking-wide text-fg/65">{group}</h2>
      <div className="grid gap-3 sm:grid-cols-2">{SETTINGS_SECTIONS.filter(section => section.group === group).map(section => {
        const Icon = section.icon
        return <Link key={section.id} to={settingsPath(section.id)} className="glass group flex min-w-0 items-start gap-3 rounded-2xl border border-line/10 p-4 transition hover:border-brand-500/40 hover:bg-brand-500/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 sm:p-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-accent"><Icon className="size-5" aria-hidden /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-fg">{section.title}</span><span className="mt-1 block text-xs leading-relaxed text-fg/55">{section.description}</span></span>
          <ArrowRight className="mt-3 size-4 shrink-0 text-fg/35 transition group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
        </Link>
      })}</div>
    </section>)}
  </div>
}
