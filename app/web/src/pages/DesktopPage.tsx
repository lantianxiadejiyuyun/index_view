import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, Navigate } from 'react-router-dom'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { Check, Command, FolderPlus, Grip, LayoutGrid, Loader2, LogIn, Moon, NotebookPen, Pencil, Plus, Rss, Settings2, Sun, Trash2, X } from 'lucide-react'
import { api, errorMessage } from '../lib/api.ts'
import { arrangeDesktop, canvasDropPosition, dropPosition, freePosition, parseDesktopLayout, type DesktopItem, type DesktopLayout, type DesktopViewport, type PlacedItem } from '../lib/desktop-layout.ts'
import { resolveLink, openResolved } from '../lib/link.ts'
import type { Folder, Site } from '../lib/types.ts'
import { useTheme } from '../lib/useTheme.ts'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { Clock } from '../components/Clock.tsx'
import { FolderCard, FolderSiteIcon } from '../components/FolderCard.tsx'
import { FolderEditorModal } from '../components/FolderEditor.tsx'
import { SiteEditorModal } from '../components/SiteEditor.tsx'
import { SearchBar } from '../components/SearchBar.tsx'
import { HitokotoWidget, WeatherWidget, WorkbenchWidget } from '../components/Widgets.tsx'
import { Modal, btnGhost } from '../components/Modal.tsx'
import { BulkSiteDeleteModal } from '../components/BulkSiteDelete.tsx'
import './desktop.css'

type Content = { kind: 'site'; site: Site } | { kind: 'folder'; folder: Folder } | { kind: 'widget'; widget: string }
type Item = DesktopItem & Content
type SiteEditor = { site: Site | null; folderId: number | null }

function DesktopTile({ item, position, cellWidth, gap, rowHeight, editing, disabled, children }: { item: Item; position: PlacedItem; cellWidth: number; gap: number; rowHeight: number; editing: boolean; disabled: boolean; children: ReactNode }) {
  const drag = useDraggable({ id: item.id, data: { kind: item.kind }, disabled: disabled || !editing })
  const drop = useDroppable({ id: `drop:${item.id}`, data: item.kind === 'folder' ? { folderId: item.folder.id } : {}, disabled: item.kind !== 'folder' || disabled })
  return <div ref={node => { drag.setNodeRef(node); drop.setNodeRef(node) }} className={`free-desktop-tile desktop-${item.kind === 'widget' ? 'widget-tile' : item.kind}${drag.isDragging ? ' is-dragging' : ''}${drop.isOver ? ' is-drop-target' : ''}`} data-desktop-item={item.id}
    style={{ left: position.col * (cellWidth + gap), top: position.row * (rowHeight + gap), width: item.width * (cellWidth + gap) - gap, height: item.height * (rowHeight + gap) - gap } as CSSProperties}>
    {editing && <button type="button" {...drag.attributes} {...drag.listeners} aria-label={`拖动${item.kind === 'folder' ? '文件夹 ' + item.folder.name : item.kind === 'site' ? '图标 ' + item.site.title : '组件 ' + widgetLabels[item.widget]}`} className="desktop-drag-handle" disabled={disabled}><Grip size={15} aria-hidden /></button>}
    <div className="desktop-tile-content" {...(item.kind !== 'widget' && editing ? { ...drag.attributes, ...drag.listeners, style: { touchAction: 'none' }, role: undefined, tabIndex: undefined } : {})}>{children}</div>
  </div>
}

function FolderMember({ site, editing, busy, onOpen, onEdit, onDetach }: { site: Site; editing: boolean; busy: boolean; onOpen: () => void; onEdit: () => void; onDetach: () => void }) {
  const drag = useDraggable({ id: `site:${site.id}`, data: { kind: 'site', fromFolder: true }, disabled: !editing || busy })
  return <div ref={drag.setNodeRef} className={`desktop-member${drag.isDragging ? ' is-dragging' : ''}`}>
    <button type="button" className="desktop-app" {...(editing ? { ...drag.attributes, ...drag.listeners, style: { touchAction: 'none' } } : {})} aria-label={editing ? `拖动图标 ${site.title}` : site.title} onClick={editing ? undefined : onOpen}><FolderSiteIcon site={site} /><span>{site.title}</span></button>
    {editing && <div className="desktop-member-actions"><button type="button" disabled={busy} onClick={onEdit}>编辑</button><button type="button" disabled={busy} onClick={onDetach}>移到桌面</button></div>}
  </div>
}

function DesktopFolderWindow({ folder, sites, editing, busy, onClose, onOpen, onEditSite, onEditFolder, onAdd, onDetach }: { folder: Folder; sites: Site[]; editing: boolean; busy: boolean; onClose: () => void; onOpen: (site: Site) => void; onEditSite: (site: Site) => void; onEditFolder: () => void; onAdd: () => void; onDetach: (site: Site) => void }) {
  const drop = useDroppable({ id: 'desktop-folder-window', data: { folderId: folder.id }, disabled: busy })
  const ref = useRef<HTMLDivElement | null>(null)
  const closing = useRef({ busy, onClose })
  closing.current = { busy, onClose }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && !closing.current.busy) closing.current.onClose() }
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('keydown', escape); previous?.isConnected && previous.focus() }
  }, [folder.id])
  return createPortal(<div ref={node => { ref.current = node; drop.setNodeRef(node) }} role="dialog" aria-label={`文件夹 ${folder.name}`} aria-modal="false" tabIndex={-1} className={`desktop-folder-window${drop.isOver ? ' is-drop-target' : ''}`}>
    <header><button type="button" className="desktop-window-close" onClick={onClose} disabled={busy} aria-label="关闭文件夹"><X size={13} /></button><span className="desktop-window-dots" aria-hidden><i /><i /></span><strong>{folder.name}</strong><span>{sites.length} 个图标</span></header>
    <div className="desktop-folder-toolbar"><span>{editing ? '拖出窗口可放回桌面，拖到其他文件夹可转移' : '你的收藏，随手可达'}</span>{editing && <><button type="button" disabled={busy} onClick={onEditFolder}><Settings2 size={14} />管理</button><button type="button" disabled={busy} onClick={onAdd}><Plus size={14} />添加</button></>}</div>
    <div className="desktop-folder-members">{sites.map(site => <FolderMember key={site.id} site={site} editing={editing} busy={busy} onOpen={() => onOpen(site)} onEdit={() => onEditSite(site)} onDetach={() => onDetach(site)} />)}{!sites.length && <p className="desktop-folder-empty">文件夹还是空的。编辑桌面后，把图标拖到这里。</p>}</div>
  </div>, document.body)
}

const widgetLabels: Record<string, string> = { clock: '时钟', search: '搜索', weather: '天气', quote: '每日一句', workbench: '工作台' }

export function DesktopPage() {
  const { sites, folders, categories, settings, rawSettings, canEdit, needsLogin, editMode, setEditMode, saveSettings, setTheme, netMode, registerClick } = useApp()
  const dark = useTheme(settings.theme)
  const [layout, setLayout] = useState(() => parseDesktopLayout(rawSettings.desktop_layout))
  const [boardWidth, setBoardWidth] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [openFolderId, setOpenFolderId] = useState<number | null>(null)
  const [siteEditor, setSiteEditor] = useState<SiteEditor | null>(null)
  const [folderEditor, setFolderEditor] = useState<{ folder: Folder | null } | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const board = useRef<HTMLDivElement | null>(null)
  const dragPreview = useRef<HTMLDivElement | null>(null)
  const keyboardSteps = useRef({ col: 0, row: 0 })
  const [now, setNow] = useState(new Date())
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(timer) }, [])
  useEffect(() => { setLayout(parseDesktopLayout(rawSettings.desktop_layout)) }, [rawSettings.desktop_layout])
  useLayoutEffect(() => {
    if (!board.current) return
    const element = board.current
    const update = () => setBoardWidth(element.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [needsLogin])
  const view: DesktopViewport = boardWidth >= 900 ? 'wide' : 'compact'
  const columns = view === 'wide' ? 12 : 4
  const gap = view === 'wide' ? 18 : 12
  const rowHeight = view === 'wide' ? 104 : 92
  const cellWidth = Math.max(1, (boardWidth - (columns - 1) * gap) / columns)
  const editing = canEdit && editMode
  const folder = folders.find(f => f.id === openFolderId) ?? null
  const items = useMemo<Item[]>(() => {
    const result: Item[] = []
    const widget = (name: string, wideWidth: number, height: number) => result.push({ id: `widget:${name}`, kind: 'widget', widget: name, width: view === 'wide' ? wideWidth : 4, height })
    if (settings.show_clock) widget('clock', 3, 2)
    widget('search', 5, 1)
    if (settings.show_weather) widget('weather', 4, 2)
    if (settings.show_hitokoto) widget('quote', 5, 1)
    if (settings.show_workbench) widget('workbench', 3, 1)
    const folderIds = new Set(folders.map(f => f.id))
    for (const f of [...folders].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) result.push({ id: `folder:${f.id}`, kind: 'folder', folder: f, width: Math.min(columns, Math.max(1, f.columns)), height: Math.min(6, Math.max(1, f.rows)) })
    for (const site of [...sites].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) if (!site.folder_id || !folderIds.has(site.folder_id)) result.push({ id: `site:${site.id}`, kind: 'site', site, width: 1, height: 1 })
    return result
  }, [sites, folders, view, columns, settings.show_clock, settings.show_weather, settings.show_hitokoto, settings.show_workbench])
  const placed = useMemo(() => arrangeDesktop(items, layout[view], columns), [items, layout, view, columns])
  const boardHeight = Math.max(580, ...placed.map(p => (p.row + p.height) * (rowHeight + gap))) + (editing ? rowHeight * 3 : 0)
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
    const direction = { ArrowRight: [cellWidth + gap, 0], ArrowLeft: [-cellWidth - gap, 0], ArrowDown: [0, rowHeight + gap], ArrowUp: [0, -rowHeight - gap] }[event.code]
    if (direction) {
      keyboardSteps.current.col += Math.sign(direction[0]!)
      keyboardSteps.current.row += Math.sign(direction[1]!)
      event.preventDefault()
      return { x: currentCoordinates.x + direction[0]!, y: currentCoordinates.y + direction[1]! }
    }
    return undefined
  }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, scrollBehavior: 'auto' }))
  const collision: CollisionDetection = args => {
    const point = args.pointerCoordinates ?? { x: args.collisionRect.left + args.collisionRect.width / 2, y: args.collisionRect.top + args.collisionRect.height / 2 }
    const activeSite = String(args.active.id).startsWith('site:')
    const hits = args.droppableContainers.filter(container => {
      const rect = args.droppableRects.get(container.id)
      if (!rect || point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return false
      return container.id === 'desktop-surface' || (activeSite && container.data.current?.folderId)
    })
    return hits.sort((a, b) => Number(b.id === 'desktop-folder-window') - Number(a.id === 'desktop-folder-window') || Number(a.id === 'desktop-surface') - Number(b.id === 'desktop-surface')).map(hit => ({ id: hit.id }))
  }

  function keepLayout(value: DesktopLayout) {
    setLayout(value)
    useApp.setState(state => ({ rawSettings: { ...state.rawSettings, desktop_layout: JSON.stringify(value) } }))
  }
  async function run(operation: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try { await operation() } catch (error) { toast.error(errorMessage(error, '操作失败，请重试')) }
    finally { busyRef.current = false; setBusy(false) }
  }
  function openSite(site: Site) {
    const link = resolveLink(site, netMode)
    if (!link) { toast.error('这个图标还没有配置地址'); return }
    registerClick(site.id); openResolved(link, settings.open_in_new_tab)
  }
  async function freezeInitialPositions() {
    const missing = placed.filter(p => !layout[view][p.id]).map(({ id, col, row }) => ({ id, col, row }))
    // Preserve empty space after an icon is moved into a folder or deleted.
    for (let offset = 0; offset < missing.length; offset += 500) {
      const result = await api<{ layout: DesktopLayout }>('/api/desktop/layout', { method: 'PATCH', body: JSON.stringify({ viewport: view, placements: missing.slice(offset, offset + 500) }) })
      keepLayout(result.layout)
    }
  }
  function openBulkDelete() {
    void run(async () => { await freezeInitialPositions(); setOpenFolderId(null); setBulkDeleteOpen(true) })
  }
  function toggleEditing() {
    if (editing) { setEditMode(false); return }
    void run(async () => { await freezeInitialPositions(); setEditMode(true) })
  }
  async function moveSite(site: Site, folderId: number | null, target?: { col: number; row: number }) {
    await freezeInitialPositions()
    const position = target ?? freePosition({ id: `site:${site.id}`, width: 1, height: 1 }, { col: 0, row: 0 }, placed, columns)
    const result = await api<{ layout: DesktopLayout; sites: Site[] }>('/api/desktop/move', { method: 'POST', body: JSON.stringify({ site_id: site.id, folder_id: folderId, viewport: view, position }) })
    keepLayout(result.layout); useApp.setState({ sites: result.sites })
    toast.success(folderId === null ? '已放回桌面' : '已移入文件夹')
  }
  function endDrag(event: DragEndEvent) {
    const previewRect = dragPreview.current?.getBoundingClientRect()
    setActiveId(null)
    const { active, over, delta } = event
    if (!over || busyRef.current) return
    const id = String(active.id)
    const site = id.startsWith('site:') ? sites.find(s => `site:${s.id}` === id) : undefined
    if (over.data.current?.folderId && site) {
      if (site.folder_id !== over.data.current.folderId) void run(() => moveSite(site, Number(over.data.current!.folderId)))
      return
    }
    if (over.id !== 'desktop-surface') return
    const item = items.find(i => i.id === id)
    let target: { col: number; row: number } | null
    if (!item && site?.folder_id) {
      const rect = previewRect ?? active.rect.current.translated
      const area = board.current?.getBoundingClientRect()
      if (!rect || !area) return
      target = canvasDropPosition({ id, width: 1, height: 1 }, rect, area, cellWidth, rowHeight, gap, placed, columns)
      if (!target) { toast.error('这里已有组件，请选择空白网格'); return }
      const destination = target
      void run(() => moveSite(site, null, destination)); return
    }
    if (!item) return
    const translated = previewRect ?? active.rect.current.translated
    const canvas = board.current?.getBoundingClientRect()
    target = event.activatorEvent.type === 'keydown'
      ? dropPosition(item, placed.find(p => p.id === id)!, { x: keyboardSteps.current.col * (cellWidth + gap), y: keyboardSteps.current.row * (rowHeight + gap) }, cellWidth, rowHeight, gap, placed, columns)
      : translated && canvas
      ? canvasDropPosition(item, translated, canvas, cellWidth, rowHeight, gap, placed, columns)
      : dropPosition(item, placed.find(p => p.id === id)!, delta, cellWidth, rowHeight, gap, placed, columns)
    if (!target) { toast.error('这里已有组件，已保留原位'); return }
    const destination = target
    void run(async () => {
      await freezeInitialPositions()
      const result = await api<{ layout: DesktopLayout }>('/api/desktop/layout', { method: 'PATCH', body: JSON.stringify({ viewport: view, placements: [{ id, col: destination.col, row: destination.row }] }) })
      keepLayout(result.layout)
    })
  }

  const activeItem = items.find(i => i.id === activeId)
  const activeSite = sites.find(s => `site:${s.id}` === activeId)
  const looseGroups = categories.filter(c => sites.some(s => s.category_id === c.id && !s.folder_id)).length
  const renderWidget = (name: string) => name === 'clock' ? <Clock /> : name === 'search' ? <SearchBar /> : name === 'weather' ? <><div className="desktop-widget-caption">WEATHER / 天气</div><WeatherWidget /><span className="desktop-widget-fallback">天气会在连接成功后显示</span></> : name === 'quote' ? <><HitokotoWidget /><span className="desktop-widget-fallback">给今天留一点灵感</span></> : <WorkbenchWidget />

  if (needsLogin) return <Navigate to="/login" replace />
  return <DndContext sensors={sensors} collisionDetection={collision} onDragStart={event => { keyboardSteps.current = { col: 0, row: 0 }; setActiveId(String(event.active.id)) }} onDragCancel={() => setActiveId(null)} onDragEnd={endDrag}>
    <div className={`free-desktop${editing ? ' desktop-editing' : ''}`}>
      <header className="desktop-menubar"><div><Command size={18} aria-hidden /><strong>{settings.site_title}</strong><span className="desktop-mode-label">自由桌面</span></div><div><button type="button" aria-label={dark ? '切换到浅色' : '切换到深色'} onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>{canEdit && <button type="button" disabled={busy} onClick={() => setOptionsOpen(true)} aria-label="桌面选项"><Settings2 size={16} /></button>}<time>{now.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })} <span>{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></time></div></header>
      <main className="desktop-workspace">
        <div className="desktop-workspace-heading"><div><span className="desktop-eyebrow">YOUR SPACE, YOUR PACE</span><h1>{editing ? '让一切各就其位' : '今天，从这里开始'}</h1><p>{editing ? '拖到空白网格即可保存，已有组件保持原位。' : `${sites.length} 个收藏 · ${folders.length} 个文件夹 · 按自己的节奏工作`}</p></div>{canEdit && <div className="desktop-heading-actions">{editing && <button type="button" className="desktop-edit-toggle" disabled={busy} onClick={openBulkDelete}><Trash2 size={16} />批量删除</button>}<button type="button" className="desktop-edit-toggle" disabled={busy} onClick={toggleEditing}>{busy ? <Loader2 size={16} className="animate-spin" /> : editing ? <Check size={16} /> : <Pencil size={16} />}{editing ? '完成布局' : '编辑桌面'}</button></div>}</div>
        <DesktopSurface boardRef={board} height={boardHeight} editing={editing} columns={columns} cellWidth={cellWidth} gap={gap} rowHeight={rowHeight}>
          {boardWidth > 0 && items.map(item => <DesktopTile key={item.id} item={item} position={placed.find(p => p.id === item.id)!} cellWidth={cellWidth} gap={gap} rowHeight={rowHeight} editing={editing} disabled={busy}>
            {item.kind === 'widget' ? <div className={`desktop-widget desktop-widget-${item.widget}`}>{renderWidget(item.widget)}</div> : item.kind === 'folder' ? <FolderCard folder={item.folder} sites={sites.filter(s => s.folder_id === item.folder.id)} editMode={editing} onOpen={() => setOpenFolderId(item.folder.id)} onEdit={() => setFolderEditor({ folder: item.folder })} displayColumns={item.width} /> : <button type="button" className="desktop-app" onClick={() => editing ? setSiteEditor({ site: item.site, folderId: item.site.folder_id ?? null }) : openSite(item.site)} title={item.site.title}><FolderSiteIcon site={item.site} /><span>{item.site.title}</span></button>}
          </DesktopTile>)}
        </DesktopSurface>
      </main>
      <nav className="desktop-dock" aria-label="桌面 Dock"><Link to="/navigation" title="导航主页" aria-label="导航主页"><LayoutGrid /><span>导航</span></Link><Link to="/notes" title="笔记"><NotebookPen /><span>笔记</span></Link>{canEdit && <><button type="button" disabled={busy} onClick={() => setSiteEditor({ site: null, folderId: null })} title="添加图标"><Plus /><span>图标</span></button><button type="button" disabled={busy} onClick={() => void run(async () => { await freezeInitialPositions(); setFolderEditor({ folder: null }) })} title="新建文件夹"><FolderPlus /><span>文件夹</span></button><Link to="/subscriptions" title="订阅中心"><Rss /><span>订阅</span></Link><Link to="/settings/appearance" title="外观设置"><Settings2 /><span>设置</span></Link></>}{!canEdit && <Link to="/login"><LogIn /><span>登录</span></Link>}</nav>
    </div>
    {folder && <DesktopFolderWindow folder={folder} sites={sites.filter(s => s.folder_id === folder.id).sort((a, b) => a.sort_order - b.sort_order)} editing={editing} busy={busy} onClose={() => setOpenFolderId(null)} onOpen={openSite} onEditSite={site => { setOpenFolderId(null); setSiteEditor({ site, folderId: folder.id }) }} onEditFolder={() => { setOpenFolderId(null); setFolderEditor({ folder }) }} onAdd={() => { setOpenFolderId(null); setSiteEditor({ site: null, folderId: folder.id }) }} onDetach={site => void run(() => moveSite(site, null))} />}
    {siteEditor && <SiteEditorModal open foldersOnly site={siteEditor.site} defaultCategoryId={siteEditor.site?.category_id ?? null} defaultFolderId={siteEditor.folderId} onClose={() => setSiteEditor(null)} />}
    {folderEditor && <FolderEditorModal open foldersOnly folder={folderEditor.folder} defaultCategoryId={null} onClose={() => setFolderEditor(null)} />}
    {canEdit && <BulkSiteDeleteModal open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} />}
    <Modal open={optionsOpen} title="桌面选项" onClose={() => !busy && setOptionsOpen(false)}>
      <div className="desktop-options"><p>电脑和手机分别保存位置。拖放吸附网格，目标有组件时保留原位，不自动排列或挪动其他组件。聚焦把手后按空格开始或结束，方向键移动。</p>
        {([['show_clock', '时钟'], ['show_weather', '天气'], ['show_hitokoto', '每日一句'], ['show_workbench', '工作台']] as const).map(([key, label]) => <label key={key}>{label}<input type="checkbox" checked={settings[key]} disabled={busy} onChange={event => void run(() => saveSettings({ [key]: event.target.checked }))} /></label>)}
        <button type="button" className={btnGhost} disabled={busy || settings.home_mode === 'desktop'} onClick={() => void run(async () => { await saveSettings({ home_mode: 'desktop' }); toast.success('已将自由桌面设为首页') })}>{settings.home_mode === 'desktop' ? '当前默认首页：自由桌面' : '将自由桌面设为首页'}</button>
        {looseGroups > 0 && <div className="desktop-collect"><strong>用文件夹收纳已有图标</strong><p>将 {looseGroups} 个原分组的散落图标分别收纳到同名文件夹。已有文件夹保持原样，删除新文件夹可把图标放回桌面。</p><button type="button" className={btnGhost} disabled={busy} onClick={() => void run(async () => { await freezeInitialPositions(); const result = await api<{ created: number; sites: Site[]; folders: Folder[] }>('/api/desktop/collect-groups', { method: 'POST' }); useApp.setState({ sites: result.sites, folders: result.folders }); toast.success(`已收纳到 ${result.created} 个文件夹`) })}>按原分组收纳为文件夹</button></div>}
      </div>
    </Modal>
    {createPortal(<DragOverlay dropAnimation={null} transition="none" zIndex={90}>{activeId && <div ref={dragPreview} className="desktop-drag-preview">{activeSite ? <><FolderSiteIcon site={activeSite} /><span>{activeSite.title}</span></> : <><Grip size={28} /><span>{activeItem?.kind === 'folder' ? activeItem.folder.name : activeItem?.kind === 'widget' ? widgetLabels[activeItem.widget] : '移动'}</span></>}</div>}</DragOverlay>, document.body)}
  </DndContext>
}

// This child lives inside DndContext so the canvas is a registered drop target.
function DesktopSurface({ boardRef, height, editing, columns, cellWidth, gap, rowHeight, children }: { boardRef: React.RefObject<HTMLDivElement | null>; height: number; editing: boolean; columns: number; cellWidth: number; gap: number; rowHeight: number; children: ReactNode }) {
  const drop = useDroppable({ id: 'desktop-surface' })
  return <div ref={node => { boardRef.current = node; drop.setNodeRef(node) }} className="desktop-surface" aria-label="自由桌面画布" style={{ height, '--desktop-cell': `${cellWidth + gap}px`, '--desktop-row': `${rowHeight + gap}px`, '--desktop-columns': columns } as CSSProperties} data-editing={editing || undefined}>{children}</div>
}
