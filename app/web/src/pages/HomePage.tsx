import { useCallback, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Check, FolderPlus, Group, LayoutGrid, Minimize2, Plus, Sparkles } from 'lucide-react'
import { Clock } from '../components/Clock.tsx'
import { CategoryEditorModal } from '../components/CategoryEditor.tsx'
import { SearchBar } from '../components/SearchBar.tsx'
import { SiteEditorModal } from '../components/SiteEditor.tsx'
import { SiteGrid } from '../components/SiteGrid.tsx'
import { FolderEditorModal } from '../components/FolderEditor.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { NavigationAiOrganizer } from '../components/NavigationAiOrganizer.tsx'
import { WidgetRow } from '../components/Widgets.tsx'
import { useApp } from '../store/app.ts'
import { useMinimal } from '../store/minimal.ts'
import type { Category, Folder, Site } from '../lib/types.ts'

type SiteEditorState = {
  open: boolean
  site: Site | null
  categoryId: number | null
  folderId?: number | null
}

type CategoryEditorState = {
  open: boolean
  category: Category | null
}

/** 移动端的底部操作条：桌面有 hover 和右上角工具栏，手机需要更顺手的入口 */
function MobileEditBar({
  onAddSite,
  onAddCategory,
  onAddFolder,
  onOrganize,
}: {
  onAddSite: () => void
  onAddCategory: () => void
  onAddFolder: () => void
  onOrganize?: () => void
}) {
  const setEditMode = useApp((s) => s.setEditMode)

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:hidden">
      <div className="glass glass-pop flex items-center justify-around rounded-2xl px-2 py-2">
        <button
          type="button"
          onClick={onAddSite}
          className="flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-fg/85 transition active:bg-line/15"
        >
          <Plus className="size-5" aria-hidden />
          <span className="text-[11px]">加图标</span>
        </button>

        <button
          type="button"
          onClick={onAddCategory}
          className="flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-fg/85 transition active:bg-line/15"
        >
          <Group className="size-5" aria-hidden />
          <span className="text-[11px]">加分组</span>
        </button>

        <button type="button" onClick={onAddFolder} className="flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-fg/85 transition active:bg-line/15">
          <FolderPlus className="size-5" aria-hidden /><span className="text-[11px]">加文件夹</span>
        </button>

        {onOrganize && <button type="button" onClick={onOrganize} className="flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-brand-500 transition active:bg-line/15">
          <Sparkles className="size-5" aria-hidden /><span className="text-[11px]">AI 整理</span>
        </button>}

        <button
          type="button"
          onClick={() => setEditMode(false)}
          className="flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-success transition active:bg-line/15"
        >
          <Check className="size-5" aria-hidden />
          <span className="text-[11px]">完成</span>
        </button>
      </div>
    </div>
  )
}

export function HomePage({ navigationOnly = false }: { navigationOnly?: boolean }) {
  const needsLogin = useApp((s) => s.needsLogin)
  const editMode = useApp((s) => s.editMode)
  const canEdit = useApp((s) => s.canEdit)
  const user = useApp((s) => s.user)
  const appearance = useApp((s) => s.settings.appearance_preset)
  const homeMode = useApp((s) => s.settings.home_mode)
  const minimal = useMinimal((s) => s.minimal)
  const setMinimal = useMinimal((s) => s.setMinimal)

  const [siteEditor, setSiteEditor] = useState<SiteEditorState>({
    open: false,
    site: null,
    categoryId: null,
  })
  const [categoryEditor, setCategoryEditor] = useState<CategoryEditorState>({
    open: false,
    category: null,
  })
  const [folderEditor, setFolderEditor] = useState<{ open: boolean; folder: Folder | null }>({ open: false, folder: null })
  const [organizerOpen, setOrganizerOpen] = useState(false)

  const openAddSite = useCallback((categoryId: number | null, folderId?: number | null) => {
    setSiteEditor({ open: true, site: null, categoryId, folderId })
  }, [])

  const openEditSite = useCallback((site: Site, categoryId: number | null) => {
    setSiteEditor({ open: true, site, categoryId })
  }, [])

  if (needsLogin) return <Navigate to="/login" replace />
  if (!navigationOnly && homeMode === 'desktop') return <Navigate to="/desktop" replace />

  // 极简模式：整页只有搜索框。
  // 工具栏、时钟、小组件、图标墙一律不渲染 —— 不是用 CSS 藏起来，
  // 是根本不挂载，省掉那些组件自己的取数和网络请求。
  if (minimal) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center px-4">
        <div className="w-full max-w-xl animate-rise">
          <SearchBar />
        </div>

        {/* 这个模式下没有任何工具栏，这颗按钮是唯一的出口 ——
            固定在底部、永远可见，别让它被内容顶出视口 */}
        <button
          type="button"
          onClick={() => setMinimal(false)}
          className="glass glass-pop fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl px-4 py-2.5 text-xs font-medium text-fg/75 transition hover:text-fg"
        >
          <Minimize2 className="size-3.5" aria-hidden />
          退出极简模式
        </button>
      </div>
    )
  }

  return (
    <div className="home-shell flex min-h-dvh flex-col" data-editing={editMode || undefined}>
      <Toolbar
        onAddSite={() => openAddSite(null)}
        onAddCategory={() => setCategoryEditor({ open: true, category: null })}
        onAddFolder={() => setFolderEditor({ open: true, folder: null })}
        onOrganize={() => setOrganizerOpen(true)}
      />

      <main
        className={[
          'home-main mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pt-5 sm:px-6 sm:pt-8',
          // 编辑模式时手机上有一条悬浮操作条压在最底部，只有那时才需要额外的底部留白。
          // 平时也留这么多的话，内容因为做了垂直居中会被整体顶得偏上。
          editMode
            ? 'pb-[calc(7rem+env(safe-area-inset-bottom))] sm:pb-8'
            : 'pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:pb-8',
        ].join(' ')}
      >
        {/* my-auto：内容不多时整体垂直居中，构图不会顶着上方、底下空一大片；
            图标变多页面变长时 auto 外边距自然归零，照常滚动 */}
        <div className="home-content my-auto w-full">
          <div className="home-overview">
            <Clock />
            <SearchBar />
            <WidgetRow />
          </div>
          <div className="home-apps">
            {appearance === 'desktop' && (
              <div className="desktop-window-bar">
                <span className="desktop-window-lights" aria-hidden="true"><i /><i /><i /></span>
                <span><LayoutGrid size={15} aria-hidden />我的应用</span>
                <span className="desktop-window-caption">{editMode ? '编辑桌面' : '工作与生活，随手可达'}</span>
              </div>
            )}
            {appearance === 'terminal' && <p className="terminal-ready"><span aria-hidden="true">●</span> 导航已就绪 <span aria-hidden="true">/ READY</span></p>}
            <SiteGrid onEditSite={openEditSite} onAddSite={openAddSite} onEditFolder={(folder) => setFolderEditor({ open: true, folder })} />
          </div>
        </div>
      </main>

      {editMode && (
        <MobileEditBar
          onAddSite={() => openAddSite(null)}
          onAddCategory={() => setCategoryEditor({ open: true, category: null })}
          onAddFolder={() => setFolderEditor({ open: true, folder: null })}
          onOrganize={canEdit && user ? () => setOrganizerOpen(true) : undefined}
        />
      )}

      <SiteEditorModal
        open={siteEditor.open}
        site={siteEditor.site}
        defaultCategoryId={siteEditor.categoryId}
        defaultFolderId={siteEditor.folderId}
        onClose={() => setSiteEditor({ open: false, site: null, categoryId: null })}
      />

      <CategoryEditorModal
        open={categoryEditor.open}
        category={categoryEditor.category}
        onClose={() => setCategoryEditor({ open: false, category: null })}
      />
      <FolderEditorModal open={folderEditor.open} folder={folderEditor.folder} defaultCategoryId={folderEditor.folder?.category_id ?? null} onClose={() => setFolderEditor({ open: false, folder: null })} />
      {canEdit && user && <NavigationAiOrganizer open={organizerOpen} onClose={() => setOrganizerOpen(false)} />}
    </div>
  )
}
