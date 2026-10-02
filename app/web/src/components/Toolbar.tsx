import { useState } from 'react'
import {
  Activity,
  Check,
  FolderPlus,
  Images,
  LogIn,
  LogOut,
  Minimize2,
  Moon,
  PanelsTopLeft,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  Rss,
  Server,
  Settings,
  Sun,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useApp } from '../store/app.ts'
import { useMinimal } from '../store/minimal.ts'
import { toast } from '../store/toast.ts'
import { useTheme } from '../lib/useTheme.ts'
import { Modal } from './Modal.tsx'

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
    >
      {children}
    </button>
  )
}

export function Toolbar({ onAddSite, onAddCategory }: { onAddSite: () => void; onAddCategory: () => void }) {
  const canEdit = useApp((s) => s.canEdit)
  const editMode = useApp((s) => s.editMode)
  const setEditMode = useApp((s) => s.setEditMode)
  const user = useApp((s) => s.user)
  const settings = useApp((s) => s.settings)
  const setTheme = useApp((s) => s.setTheme)
  const logout = useApp((s) => s.logout)
  const setMinimal = useMinimal((s) => s.setMinimal)

  const [busy, setBusy] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const isDark = useTheme(settings.theme)

  function toggleTheme() {
    setTheme(isDark ? 'light' : 'dark')
  }

  async function handleLogout() {
    setBusy(true)
    try {
      await logout()
      toast.success('已退出登录')
    } catch {
      toast.error('退出失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="home-toolbar flex items-center justify-end gap-2 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:gap-3 sm:px-5 sm:pt-[calc(1.25rem+env(safe-area-inset-top))]">
      {settings.appearance_preset === 'desktop' && <div className="desktop-brand"><PanelsTopLeft size={19} aria-hidden /><span>{settings.site_title || '我的桌面'}</span><span className="desktop-brand-note">个人空间</span></div>}
      <nav aria-label="手机快捷操作" className="glass grid w-full grid-flow-col auto-cols-fr gap-1 rounded-2xl p-1 sm:hidden">
        {canEdit && <button type="button" aria-label={editMode ? '完成编辑' : '编辑首页'} onClick={() => setEditMode(!editMode)} className={`flex min-h-12 items-center justify-center gap-1.5 rounded-xl text-xs font-medium ${editMode ? 'bg-emerald-500/85 text-white' : 'text-fg/80 active:bg-line/15'}`}>{editMode ? <Check className="size-4" aria-hidden /> : <Pencil className="size-4" aria-hidden />}{editMode ? '完成' : '编辑'}</button>}
        <button type="button" aria-label={isDark ? '切换到浅色' : '切换到深色'} onClick={toggleTheme} className="flex min-h-12 items-center justify-center gap-1.5 rounded-xl text-xs font-medium text-fg/80 active:bg-line/15">{isDark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}{isDark ? '浅色' : '深色'}</button>
        {user && <Link to="/subscriptions" aria-label="订阅中心" className="flex min-h-12 items-center justify-center gap-1.5 rounded-xl text-xs font-medium text-fg/80 active:bg-line/15"><Rss className="size-4" aria-hidden />订阅</Link>}
        <button type="button" aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen(true)} className="flex min-h-12 items-center justify-center gap-1.5 rounded-xl text-xs font-medium text-fg/80 active:bg-line/15"><MoreHorizontal className="size-4" aria-hidden />更多</button>
      </nav>
      <div role="navigation" aria-label={settings.appearance_preset === 'desktop' ? '桌面 Dock' : '快捷操作'} className="desktop-toolbar glass hidden flex-wrap items-center justify-end gap-1 rounded-2xl p-1 sm:flex">
        {canEdit && (
          <>
            <button
              type="button"
              onClick={() => setEditMode(!editMode)}
              className={[
                'flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium transition sm:px-3',
                editMode
                  ? 'bg-emerald-500/85 text-white'
                  : 'text-fg/80 hover:bg-line/15 hover:text-fg',
              ].join(' ')}
            >
              {editMode ? (
                <>
                  <Check className="size-4" aria-hidden />
                  <span className="hidden sm:inline">完成</span>
                </>
              ) : (
                <>
                  <Pencil className="size-4" aria-hidden />
                  <span className="hidden sm:inline">编辑</span>
                </>
              )}
            </button>

            {editMode && (
              <>
                <IconButton label="添加图标" onClick={onAddSite}>
                  <Plus className="size-4" aria-hidden />
                </IconButton>
                <IconButton label="添加分组" onClick={onAddCategory}>
                  <FolderPlus className="size-4" aria-hidden />
                </IconButton>
              </>
            )}
          </>
        )}

        <IconButton label={isDark ? '切换到浅色' : '切换到深色'} onClick={() => void toggleTheme()}>
          {isDark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
        </IconButton>

        {/* 极简模式：整页只留搜索框。放在主题旁边 —— 两个都是「怎么显示」的开关，
            和后面那排跳转链接不是一类 */}
        <IconButton label="极简模式（只留搜索框）" onClick={() => setMinimal(true)}>
          <Minimize2 className="size-4" aria-hidden />
        </IconButton>

        <Link
          to="/notes"
          title="笔记"
          aria-label="笔记"
          className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
        >
          <NotebookPen className="size-4" aria-hidden />
        </Link>

        <Link
          to="/photos"
          title="照片墙"
          aria-label="照片墙"
          className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
        >
          <Images className="size-4" aria-hidden />
        </Link>

        <Link
          to="/services"
          title="服务对接"
          aria-label="服务对接"
          className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
        >
          <Server className="size-4" aria-hidden />
        </Link>

        <Link
          to="/servers"
          title="服务器面板"
          aria-label="服务器面板"
          className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
        >
          <Activity className="size-4" aria-hidden />
        </Link>

        {user && <Link to="/subscriptions" title="订阅中心" aria-label="订阅中心" className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"><Rss className="size-4" aria-hidden /></Link>}

        <Link
          to="/settings"
          title="设置"
          aria-label="设置"
          className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
        >
          <Settings className="size-4" aria-hidden />
        </Link>

        {user ? (
          <IconButton label={`退出登录（${user.username}）`} onClick={() => void handleLogout()}>
            <LogOut className={`size-4 ${busy ? 'opacity-40' : ''}`} aria-hidden />
          </IconButton>
        ) : (
          <Link
            to="/login"
            title="登录"
            aria-label="登录"
            className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
          >
            <LogIn className="size-4" aria-hidden />
          </Link>
        )}
      </div>
      <Modal open={moreOpen} title="更多功能" onClose={() => setMoreOpen(false)} size="sm">
        <nav aria-label="更多功能" className="grid grid-cols-2 gap-2">
          {[
            { to: '/notes', label: '笔记', icon: NotebookPen },
            { to: '/photos', label: '照片墙', icon: Images },
            { to: '/services', label: '服务对接', icon: Server },
            { to: '/servers', label: '服务器面板', icon: Activity },
            { to: '/settings', label: '设置', icon: Settings },
          ].map(({ to, label, icon: Icon }) => <Link key={to} to={to} onClick={() => setMoreOpen(false)} className="flex min-h-16 items-center gap-3 rounded-2xl border border-line/10 bg-line/5 px-4 text-sm text-fg/85 transition active:bg-line/15"><Icon className="size-5 shrink-0 text-accent" aria-hidden />{label}</Link>)}
          <button type="button" onClick={() => { setMoreOpen(false); setMinimal(true) }} className="flex min-h-16 items-center gap-3 rounded-2xl border border-line/10 bg-line/5 px-4 text-sm text-fg/85 active:bg-line/15"><Minimize2 className="size-5 shrink-0 text-accent" aria-hidden />极简模式</button>
        </nav>
        {user ? <button type="button" disabled={busy} onClick={() => { setMoreOpen(false); void handleLogout() }} className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-line/15 text-sm text-fg/65 disabled:opacity-50"><LogOut className="size-4 shrink-0" aria-hidden /><span className="truncate">退出登录（{user.username}）</span></button> : <Link to="/login" onClick={() => setMoreOpen(false)} className="mt-4 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-brand-500 text-sm text-white"><LogIn className="size-4" aria-hidden />登录</Link>}
      </Modal>
    </div>
  )
}
