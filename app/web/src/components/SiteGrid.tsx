import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { errorMessage } from '../lib/api.ts'
import { resolveLink, openResolved } from '../lib/link.ts'
import { readableToneStyle, useReadableTone } from '../lib/useWallpaperTone.ts'
import { CARD_PRESETS, GAP_PRESETS, type CardSize } from '../lib/settings.ts'
import type { Category, Folder, Site } from '../lib/types.ts'
import { useApp, type ReorderItem } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { SiteCard } from './SiteCard.tsx'
import { FolderCard } from './FolderCard.tsx'
import { FolderContentsModal } from './FolderContents.tsx'

const UNGROUPED = 'ungrouped'

function containerId(categoryId: number | null): string {
  return categoryId === null ? UNGROUPED : `cat-${categoryId}`
}

function parseContainerId(id: string): number | null {
  if (id === UNGROUPED) return null
  const n = Number(id.replace('cat-', ''))
  return Number.isFinite(n) ? n : null
}

type Group = {
  category: Category | null
  sites: Site[]
  folders: Folder[]
  totalSites: number
}

type Props = {
  onEditSite: (site: Site, categoryId: number | null) => void
  onAddSite: (categoryId: number | null, folderId?: number | null) => void
  onEditFolder: (folder: Folder) => void
}

function FolderDropCard({ folder, sites, editMode, onOpen, onEdit, gridColumns }: {
  folder: Folder; sites: Site[]; editMode: boolean; onOpen: () => void; onEdit: () => void; gridColumns: number
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-${folder.id}`, data: { type: 'folder', folderId: folder.id, categoryId: folder.category_id }, disabled: !editMode,
  })
  const displayColumns = Math.min(folder.columns, gridColumns)
  return <div ref={setNodeRef} className="folder-grid-item" style={{ gridColumn: `span ${displayColumns}`, gridRow: `span ${folder.rows}` }}>
    <FolderCard folder={folder} sites={sites} editMode={editMode} onOpen={onOpen} onEdit={onEdit} isOver={isOver} displayColumns={displayColumns} />
  </div>
}

function SortableCard({
  site,
  categoryId,
  editMode,
  cardSize,
  netMode,
  onOpen,
  onEdit,
  onDelete,
}: {
  site: Site
  categoryId: number | null
  editMode: boolean
  cardSize: CardSize
  netMode: 'lan' | 'public'
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `site-${site.id}`,
    data: { type: 'site', siteId: site.id, categoryId },
    disabled: !editMode,
  })

  return (
    <div
      ref={setNodeRef}
      className="site-grid-item"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // 编辑模式下禁掉浏览器手势，否则触摸拖拽会变成滚页面
        touchAction: editMode ? 'none' : undefined,
        '--site-desktop-width': `${CARD_PRESETS[cardSize].width}px`,
      } as CSSProperties}
      {...(editMode ? attributes : {})}
      {...(editMode ? listeners : {})}
    >
      <SiteCard
        site={site}
        editMode={editMode}
        size={cardSize}
        netMode={netMode}
        onOpen={onOpen}
        onEdit={onEdit}
        onDelete={onDelete}
        dragging={isDragging}
      />
    </div>
  )
}

function CategorySection({
  group,
  editMode,
  cardSize,
  gap,
  netMode,
  onEditSite,
  onAddSite,
  onRenameCategory,
  onDeleteCategory,
  onOpenSite,
  onOpenFolder,
  onEditFolder,
  allSites,
}: {
  group: Group
  editMode: boolean
  cardSize: CardSize
  gap: string
  netMode: 'lan' | 'public'
  onEditSite: (site: Site, categoryId: number | null) => void
  onAddSite: (categoryId: number | null) => void
  onRenameCategory: (category: Category) => void
  onDeleteCategory: (category: Category) => void
  onOpenSite: (site: Site) => void
  onOpenFolder: (folder: Folder) => void
  onEditFolder: (folder: Folder) => void
  allSites: Site[]
}) {
  const categoryId = group.category?.id ?? null
  const { setNodeRef, isOver } = useDroppable({
    id: containerId(categoryId),
    data: { type: 'container', categoryId },
  })

  const ids = group.sites.map((s) => `site-${s.id}`)
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridColumns, setGridColumns] = useState(4)
  const hasFolders = group.folders.length > 0

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid || !hasFolders) return
    const measure = () => {
      const gapPixels = Number.parseFloat(getComputedStyle(grid).columnGap) || 0
      const columns = window.matchMedia('(max-width: 639px)').matches
        ? 4
        : Math.max(1, Math.floor((grid.clientWidth + gapPixels) / (CARD_PRESETS[cardSize].width + gapPixels)))
      setGridColumns((previous) => previous === columns ? previous : columns)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [cardSize, gap, hasFolders, editMode])

  // 分组标题也压在壁纸上，而且是页面中下部的小字 —— 它必须自己判断，
  // 因为壁纸上亮下暗时，兜底的「顶部判定」在这里恰好是反的
  const headingTonePref = useApp((s) => s.settings.tone_heading)
  const headingRef = useRef<HTMLDivElement>(null)
  const headingTone = useReadableTone(headingRef, headingTonePref)

  return (
    <section>
      {(group.category || editMode) && (
        <div
          ref={headingRef}
          style={readableToneStyle(headingTone)}
          className="site-category-heading mb-3.5 flex items-center justify-center gap-2"
        >
          {/* 一道短强调条，给每个分组一个视觉锚点；纯文字标题在深色底上太安静了 */}
          <span
            className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent shadow-[0_0_10px_rgb(var(--accent-rgb)/0.7)]"
            aria-hidden
          />
          <h2 className="text-shadow-soft text-sm font-semibold tracking-wide text-wp/90 sm:text-base">
            {group.category?.name ?? '未分组'}
            <span className="ml-2 text-xs font-normal text-wp/70">
              {group.totalSites || ''}
            </span>
          </h2>

          {editMode && group.category && (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => onRenameCategory(group.category!)}
                className="rounded-lg p-1 text-fg/50 transition hover:bg-line/15 hover:text-fg"
                aria-label={`重命名分组 ${group.category.name}`}
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => onDeleteCategory(group.category!)}
                className="rounded-lg p-1 text-fg/50 transition hover:bg-rose-500/20 hover:text-rose-500"
                aria-label={`删除分组 ${group.category.name}`}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          )}
        </div>
      )}

      <div
        ref={setNodeRef}
        className={[
          'site-grid-dropzone rounded-2xl transition-colors',
          // 拖动悬停时给个明确的落点提示
          isOver && editMode ? 'bg-line/10 ring-2 ring-dashed ring-line/35' : '',
          editMode && group.sites.length === 0 && group.folders.length === 0 ? 'ring-1 ring-dashed ring-line/20' : '',
        ].join(' ')}
        style={editMode ? { padding: '0.5rem var(--site-grid-edit-inset, 0.5rem)' } : undefined}
      >
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          {/* 手机固定四列；桌面仍按卡片大小居中换行。 */}
          <div ref={gridRef} className={`site-grid ${hasFolders ? 'site-grid-with-folders' : ''}`} style={{ '--site-grid-gap': gap, '--folder-grid-columns': gridColumns, '--folder-cell-width': `${CARD_PRESETS[cardSize].width}px` } as CSSProperties}>
            {group.folders.map((folder) => <FolderDropCard key={`folder-${folder.id}`} folder={folder} sites={allSites.filter((site) => site.folder_id === folder.id)} editMode={editMode} gridColumns={gridColumns} onOpen={() => onOpenFolder(folder)} onEdit={() => onEditFolder(folder)} />)}
            {group.sites.map((site) => (
              <SortableCard
                key={site.id}
                site={site}
                categoryId={categoryId}
                editMode={editMode}
                cardSize={cardSize}
                netMode={netMode}
                onOpen={() => onOpenSite(site)}
                onEdit={() => onEditSite(site, categoryId)}
                onDelete={() => void handleDelete(site)}
              />
            ))}

            {editMode && (
              <button
                type="button"
                onClick={() => onAddSite(categoryId)}
                style={{ '--site-desktop-width': `${CARD_PRESETS[cardSize].width}px` } as CSSProperties}
                className="site-grid-item site-card-add glass flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-[1.35rem] border border-dashed border-line/25 text-fg/55 transition hover:border-line/50 hover:text-fg"
              >
                <Plus className="size-5" aria-hidden />
                <span className="text-xs">添加</span>
              </button>
            )}
          </div>
        </SortableContext>

        {editMode && group.sites.length === 0 && group.folders.length === 0 && !group.category && (
          <p className="py-3 text-center text-xs text-fg/45">把图标拖到这里可以移出分组</p>
        )}
      </div>
    </section>
  )
}

async function handleDelete(site: Site): Promise<void> {
  if (!window.confirm(`确定删除「${site.title}」吗？`)) return
  try {
    await useApp.getState().deleteSite(site.id)
    toast.success('已删除')
  } catch (err) {
    toast.error(errorMessage(err, '删除失败'))
  }
}

export function SiteGrid({ onEditSite, onAddSite, onEditFolder }: Props) {
  const categories = useApp((s) => s.categories)
  const sites = useApp((s) => s.sites)
  const folders = useApp((s) => s.folders)
  const editMode = useApp((s) => s.editMode)
  const cardSize = useApp((s) => s.settings.card_size)
  const gridGap = useApp((s) => s.settings.grid_gap)
  const openInNewTab = useApp((s) => s.settings.open_in_new_tab)
  const netMode = useApp((s) => s.netMode)
  const reorderSites = useApp((s) => s.reorderSites)
  const registerClick = useApp((s) => s.registerClick)

  const [activeSite, setActiveSite] = useState<Site | null>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [openFolderId, setOpenFolderId] = useState<number | null>(null)
  const openFolder = folders.find((folder) => folder.id === openFolderId) ?? null

  const groups = useMemo<Group[]>(() => {
    const sorted = [...sites].sort((a, b) => a.sort_order - b.sort_order)
    const folderIds = new Set(folders.map((folder) => folder.id))
    const atRoot = (site: Site) => !site.folder_id || !folderIds.has(site.folder_id)
    const result: Group[] = categories
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((category) => ({
        category,
        sites: sorted.filter((s) => s.category_id === category.id && atRoot(s)),
        folders: folders.filter((f) => f.category_id === category.id).sort((a, b) => a.sort_order - b.sort_order),
        totalSites: sorted.filter((s) => s.category_id === category.id).length,
      }))

    const ungrouped = sorted.filter((s) => s.category_id === null && atRoot(s))
    const ungroupedFolders = folders.filter((f) => f.category_id === null).sort((a, b) => a.sort_order - b.sort_order)
    // 编辑模式下即使没有未分组图标也要显示，不然没法把图标拖出去
    if (ungrouped.length > 0 || ungroupedFolders.length > 0 || editMode) {
      result.push({ category: null, sites: ungrouped, folders: ungroupedFolders, totalSites: sorted.filter((s) => s.category_id === null).length })
    }
    // Keep empty groups editable without leaving blank headings on the desktop.
    return editMode ? result : result.filter((group) => group.sites.length > 0 || group.folders.length > 0)
  }, [categories, sites, folders, editMode])

  const sensors = useSensors(
    // 8px 容差：让「点击打开」和「拖拽排序」能共存
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function openSite(site: Site) {
    const link = resolveLink(site, netMode)
    if (!link) {
      toast.error('这个图标还没有配置地址')
      return
    }
    registerClick(site.id)
    openResolved(link, openInNewTab)
  }

  function handleDragStart(event: DragStartEvent) {
    const site = sites.find((s) => `site-${s.id}` === String(event.active.id))
    setActiveSite(site ?? null)
    setDragWidth(event.active.rect.current.initial?.width ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveSite(null)
    setDragWidth(null)
    const { active, over } = event
    if (!over) return

    const activeSiteId = Number(String(active.id).replace('site-', ''))
    const moved = sites.find((s) => s.id === activeSiteId)
    if (!moved) return
    if (over.data.current?.type === 'folder') {
      const folderId = Number(over.data.current.folderId)
      void useApp.getState().updateSite(moved.id, { folder_id: folderId }).then(() => toast.success('已移入文件夹')).catch((err) => toast.error(errorMessage(err, '移动失败')))
      return
    }

    // 先按「原顺序」把当前分组结构复制一份，再在上面做移动计算
    const sorted = [...sites].sort((a, b) => a.sort_order - b.sort_order)
    const buckets = new Map<string, Site[]>()
    for (const g of groups) {
      buckets.set(containerId(g.category?.id ?? null), [...g.sites])
    }

    const fromKey =
      [...buckets.entries()].find(([, list]) => list.some((s) => s.id === activeSiteId))?.[0] ??
      containerId(moved.category_id)

    const overId = String(over.id)
    const overData = over.data.current as
      | { type?: string; categoryId?: number | null; siteId?: number }
      | undefined

    let toKey: string
    let insertAt: number

    if (overData?.type === 'container') {
      toKey = containerId(overData.categoryId ?? null)
      insertAt = buckets.get(toKey)?.length ?? 0
    } else {
      const overSiteId = Number(overId.replace('site-', ''))
      const overSite = sorted.find((s) => s.id === overSiteId)
      if (!overSite) return
      const found = [...buckets.entries()].find(([, list]) => list.some((s) => s.id === overSiteId))
      if (!found) return
      toKey = found[0]
      insertAt = found[1].findIndex((s) => s.id === overSiteId)
    }

    const fromList = buckets.get(fromKey)
    if (!fromList) return
    const fromIndex = fromList.findIndex((s) => s.id === activeSiteId)
    if (fromIndex === -1) return

    // 同一个容器内、且落点就是自己 → 什么都没发生
    if (fromKey === toKey && fromIndex === insertAt) return

    const [removed] = fromList.splice(fromIndex, 1)
    if (!removed) return

    const toList = buckets.get(toKey) ?? []
    // 同容器中使用目标原下标，向后移动一格也能实际换位。
    toList.splice(insertAt, 0, removed)
    buckets.set(toKey, toList)

    // 拍平成全量顺序提交：低负载下这比增量 diff 简单可靠得多
    const items: ReorderItem[] = []
    for (const [key, list] of buckets) {
      if (list.length === 0) continue
      const categoryId = parseContainerId(key)
      list.forEach((site, index) => {
        items.push({ id: site.id, category_id: categoryId, sort_order: index })
      })
    }

    void reorderSites(items).catch(() => toast.error('排序保存失败，已还原'))
  }

  const gap = GAP_PRESETS[gridGap]

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        const foldersUnderPointer = pointerWithin(args).filter((hit) => String(hit.id).startsWith('folder-'))
        return foldersUnderPointer.length ? foldersUnderPointer : closestCenter(args)
      }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => { setActiveSite(null); setDragWidth(null) }}
    >
      {/* space-y 统一分组间距，最后一个分组不会像用 mb-* 那样多出一截尾部空白 ——
          内容做垂直居中时，那截空白会把整块往上顶 */}
      <div className="space-y-6 sm:space-y-8">
        {groups.map((group) => (
          <CategorySection
            key={group.category?.id ?? 'ungrouped'}
            group={group}
            editMode={editMode}
            cardSize={cardSize}
            gap={gap}
            netMode={netMode}
            onEditSite={onEditSite}
            onAddSite={onAddSite}
            onOpenSite={openSite}
            onOpenFolder={(folder) => setOpenFolderId(folder.id)}
            onEditFolder={onEditFolder}
            allSites={sites}
            onRenameCategory={(category) => void renameCategory(category)}
            onDeleteCategory={(category) => void deleteCategory(category)}
          />
        ))}

        {groups.length === 0 && !editMode && (
          <p className="site-grid-empty text-shadow-soft py-16 text-center text-sm text-wp/80">
            还没有任何图标。登录后点右上角「编辑」开始添加。
          </p>
        )}
      </div>

      {createPortal(<FolderContentsModal
        open={!!openFolder}
        folder={openFolder}
        sites={sites.filter((site) => site.folder_id === openFolderId).sort((a, b) => a.sort_order - b.sort_order)}
        onClose={() => setOpenFolderId(null)}
        onOpenSite={openSite}
        onEditSite={(site, categoryId) => { setOpenFolderId(null); onEditSite(site, categoryId) }}
        onAddSite={(categoryId, folderId) => { setOpenFolderId(null); onAddSite(categoryId, folderId) }}
        onEditFolder={() => { if (openFolder) { setOpenFolderId(null); onEditFolder(openFolder) } }}
      />, document.body)}

      {createPortal(<DragOverlay dropAnimation={null}>
        {activeSite ? (
          <div className="rotate-3 opacity-90" style={{ width: dragWidth ?? CARD_PRESETS[cardSize].width }}>
            <SiteCard
              site={activeSite}
              editMode={false}
              size={cardSize}
              netMode={netMode}
              onOpen={() => undefined}
              onEdit={() => undefined}
              onDelete={() => undefined}
            />
          </div>
        ) : null}
      </DragOverlay>, document.body)}
    </DndContext>
  )
}

async function renameCategory(category: Category): Promise<void> {
  const name = window.prompt('分组名称', category.name)
  if (name === null) return
  const trimmed = name.trim()
  if (!trimmed || trimmed === category.name) return
  try {
    await useApp.getState().updateCategory(category.id, { name: trimmed })
    toast.success('已重命名')
  } catch (err) {
    toast.error(errorMessage(err, '重命名失败'))
  }
}

async function deleteCategory(category: Category): Promise<void> {
  const count = useApp.getState().sites.filter((s) => s.category_id === category.id).length
  const message =
    count > 0
      ? `删除分组「${category.name}」？\n\n确定 = 连同其中 ${count} 个图标一起删除\n取消 = 我另外选`
      : `删除分组「${category.name}」？`

  if (!window.confirm(message)) return
  // 有图标时再问一次，避免手滑把整个分组连图标一起删掉
  const mode =
    count > 0 && window.confirm('要保留这些图标（移到「未分组」）吗？\n\n确定 = 保留图标\n取消 = 一并删除')
      ? 'detach'
      : 'delete'

  try {
    await useApp.getState().deleteCategory(category.id, mode)
    toast.success(mode === 'detach' ? '分组已删除，图标已移至未分组' : '分组及图标已删除')
  } catch (err) {
    toast.error(errorMessage(err, '删除失败'))
  }
}
