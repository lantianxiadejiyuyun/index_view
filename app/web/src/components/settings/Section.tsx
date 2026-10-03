import type { ReactNode } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Bookmark, Database, Info, LayoutGrid, MessageCircle, MousePointerClick, Palette, Search, Settings, ShieldCheck, Sparkles } from 'lucide-react'

/** One catalog powers the overview, navigation, and each settings page heading. */
export const SETTINGS_SECTIONS = [
  { id: 'site', title: '站点信息', icon: Info, group: '日常体验', description: '设置导航站名称与首页问候语' },
  { id: 'appearance', title: '外观', icon: Palette, group: '日常体验', description: '内置主题、深浅色、动态壁纸与卡片样式' },
  { id: 'search', title: '搜索', icon: Search, group: '日常体验', description: '默认搜索引擎、自定义引擎与快捷前缀' },
  { id: 'widgets', title: '小组件', icon: LayoutGrid, group: '日常体验', description: '时钟、天气、一言与首页组件' },
  { id: 'behavior', title: '交互与访问', icon: MousePointerClick, group: '日常体验', description: '链接打开方式、访客权限与探针端口' },
  { id: 'ai', title: 'AI 配置', icon: Sparkles, group: '智能与安全', description: '首页图标整理与路由助手的 AI 服务、密钥及连接测试' },
  { id: 'lingxi', title: '灵犀联动', icon: MessageCircle, group: '智能与安全', description: '连接灵犀账号、日程与聊天组件、插件密码读取授权' },
  { id: 'account', title: '账号与安全', icon: ShieldCheck, group: '智能与安全', description: '登录设备、账号密码与探针令牌' },
  { id: 'backup', title: '数据备份', icon: Database, group: '数据管理', description: '导出导航数据，或从备份文件恢复' },
  { id: 'bookmarks', title: '书签与图标', icon: Bookmark, group: '数据管理', description: '导入浏览器书签，批量删除或清空图标' },
] as const

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id']
export const settingsPath = (id: SettingsSectionId) => `/settings/${id}`

export function SettingsSection({ id, description, children }: { id: string; description?: string; children: ReactNode }) {
  const meta = SETTINGS_SECTIONS.find(section => section.id === id)
  const Icon = meta?.icon ?? Info
  return <section id={id} aria-labelledby={`settings-${id}-heading`} className="glass min-w-0 animate-rise rounded-2xl p-4 sm:p-5">
    <header className="mb-5 flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-accent"><Icon className="size-4" aria-hidden /></span>
      <div className="min-w-0"><h2 id={`settings-${id}-heading`} className="text-sm font-semibold text-fg sm:text-base">{meta?.title ?? id}</h2>{description && <p className="mt-1 text-xs leading-relaxed text-fg/55">{description}</p>}</div>
    </header>
    <div className="min-w-0 space-y-4">{children}</div>
  </section>
}

const itemClass = ({ isActive }: { isActive: boolean }) => `flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-xs font-medium transition ${isActive ? 'bg-brand-500 text-white shadow-sm' : 'text-fg/70 hover:bg-line/10 hover:text-fg'}`

export function SettingsNavAside() {
  return <nav aria-label="设置导航" className="hidden lg:sticky lg:top-6 lg:block">
    <div className="glass rounded-2xl p-2">
      <NavLink to="/settings" end className={itemClass}><Settings className="size-4 shrink-0" aria-hidden />设置总览</NavLink>
      {[...new Set(SETTINGS_SECTIONS.map(section => section.group))].map(group => <div key={group} className="mt-3">
        <p className="px-3 pb-1 text-[10px] font-medium tracking-wider text-fg/45">{group}</p>
        <ul>{SETTINGS_SECTIONS.filter(section => section.group === group).map(section => {
          const Icon = section.icon
          return <li key={section.id}><NavLink to={settingsPath(section.id)} className={itemClass}><Icon className="size-4 shrink-0" aria-hidden /><span>{section.title}</span></NavLink></li>
        })}</ul>
      </div>)}
    </div>
  </nav>
}

/** A compact page selector keeps all settings reachable on narrow screens. */
export function SettingsNavBar() {
  const { sectionId } = useParams()
  const navigate = useNavigate()
  const current = SETTINGS_SECTIONS.some(section => section.id === sectionId) ? sectionId : ''
  return <nav aria-label="手机设置导航" className="flex min-w-0 items-center gap-2 lg:hidden">
    {current && <Link to="/settings" className="glass flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs text-fg/75"><ArrowLeft className="size-3.5" aria-hidden />总览</Link>}
    <label htmlFor="settings-page-select" className="sr-only">选择设置页面</label>
    <select id="settings-page-select" value={current} onChange={event => navigate(event.target.value ? `/settings/${event.target.value}` : '/settings')} className="glass min-h-11 min-w-0 flex-1 rounded-xl border border-line/15 px-3 text-sm text-fg">
      <option value="">设置总览</option>
      {SETTINGS_SECTIONS.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}
    </select>
  </nav>
}
