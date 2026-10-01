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
  const saveSettings = useApp((s) => s.saveSettings)
  const logout = useApp((s) => s.logout)
  const setMinimal = useMinimal((s) => s.setMinimal)

  const [busy, setBusy] = useState(false)

  const isDark =
    settings.theme === 'dark' ||
    (settings.theme === 'auto' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)

  async function toggleTheme() {
    try {
      await saveSettings({ theme: isDark ? 'light' : 'dark' })
    } catch {
      toast.error('主题切换失败')
    }
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
    <div className="flex items-center justify-end gap-2 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:gap-3 sm:px-5 sm:pt-[calc(1.25rem+env(safe-area-inset-top))]">
      <div className="glass flex flex-wrap items-center justify-end gap-0.5 rounded-2xl p-1 sm:gap-1">
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
    </div>
  )
}
