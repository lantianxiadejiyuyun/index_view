import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, Navigate } from 'react-router-dom'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { Check, Command, Folder as FolderIcon, FolderPlus, Grip, Home, LayoutGrid, Loader2, LogIn, MessageCircle, Maximize2, Moon, NotebookPen, Pencil, Plus, Rss, Settings2, Sun, Trash2, X } from 'lucide-react'
import { api, errorMessage } from '../lib/api.ts'
import { canvasDropPosition, desktopOccupants, dropPosition, freePosition, parseDesktopLayout, widgetResizeError, type DesktopItem, type DesktopLayout, type DesktopViewport, type PlacedItem } from '../lib/desktop-layout.ts'
import { widgetLabels, widgetSize, type WidgetDimensions } from '../lib/desktop-widgets.ts'
import { folderResizeError } from '../lib/grid-folder-layout.ts'
import { planGridSiteRestore } from '../lib/grid-site-layout.ts'
import { desktopSettingsItems, visibleDesktopWidgetNames } from '../lib/desktop-settings-layout.ts'
import { DesktopWidgetSizeDialog } from '../components/DesktopWidgetSizeDialog.tsx'
import { resolveLink, openResolved } from '../lib/link.ts'
import type { Folder, Site } from '../lib/types.ts'
import { useTheme } from '../lib/useTheme.ts'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { Clock } from '../components/Clock.tsx'
import { FolderSiteIcon } from '../components/FolderCard.tsx'
import { DesktopCalendar } from '../components/DesktopCalendar.tsx'
import { LingxiCalendarWidget, LingxiScheduleWidget, LingxiDeadlineWidget, LingxiChatWidget } from '../components/lingxi/LingxiWidgets.tsx'
import { FolderEditorModal } from '../components/FolderEditor.tsx'
import { SiteEditorModal } from '../components/SiteEditor.tsx'
import { SiteCard } from '../components/SiteCard.tsx'
import { SearchBar } from '../components/SearchBar.tsx'
import { HitokotoWidget, WeatherWidget, WorkbenchWidget } from '../components/Widgets.tsx'
import { Modal, btnGhost } from '../components/Modal.tsx'
import { BulkSiteDeleteModal } from '../components/BulkSiteDelete.tsx'
import { Toolbar } from '../components/Toolbar.tsx'
import { NavigationAiOrganizer } from '../components/NavigationAiOrganizer.tsx'
import './desktop.css'
import '../components/desktop-widget-sizes.css'

type Content = { kind: 'site'; site: Site } | { kind: 'folder'; folder: Folder } | { kind: 'widget'; widget: string }
type Item = DesktopItem & Content
type SiteEditor = { site: Site | null; folderId: number | null }
type DragMotion = Pick<DragEndEvent, 'active' | 'over' | 'delta' | 'activatorEvent'>

function DesktopTile({ item, position, cellWidth, gap, rowHeight, editing, disabled, onResize, children }: { item: Item; position: PlacedItem; cellWidth: number; gap: number; rowHeight: number; editing: boolean; disabled: boolean; onResize: () => void; children: ReactNode }) {
  const drag = useDraggable({ id: item.id, data: { kind: item.kind }, disabled: disabled || !editing })
  const drop = useDroppable({ id: `drop:${item.id}`, data: item.kind === 'folder' ? { folderId: item.folder.id } : {}, disabled: item.kind !== 'folder' || disabled })
  return <div ref={node => { drag.setNodeRef(node); drop.setNodeRef(node) }} className={`free-desktop-tile desktop-${item.kind === 'widget' ? 'widget-tile' : item.kind}${drag.isDragging ? ' is-dragging' : ''}${drop.isOver ? ' is-drop-target' : ''}`} data-desktop-item={item.id}
    style={{ left: position.col * (cellWidth + gap), top: position.row * (rowHeight + gap), width: item.width * (cellWidth + gap) - gap, height: item.height * (rowHeight + gap) - gap } as CSSProperties}>
    {editing && <button type="button" {...drag.attributes} {...drag.listeners} aria-label={`拖动${item.kind === 'folder' ? '文件夹 ' + item.folder.name : item.kind === 'site' ? '图标 ' + item.site.title : '组件 ' + widgetLabels[item.widget]}`} className="desktop-drag-handle" disabled={disabled}><Grip size={15} aria-hidden /></button>}
    {editing && item.kind === 'widget' && <button type="button" className="desktop-resize-handle" aria-label={`调整${widgetLabels[item.widget]}尺寸`} title="调整组件尺寸" disabled={disabled} onClick={onResize}><Maximize2 size={14} aria-hidden /><span>{item.width} × {item.height}</span></button>}
    <div className="desktop-tile-content" {...(item.kind !== 'widget' && editing ? { ...drag.attributes, ...drag.listeners, style: { touchAction: 'none' }, role: undefined, tabIndex: undefined } : {})}>{children}</div>
  </div>
}

function FolderMember({ site, editing, busy, onOpen, onEdit, onDetach }: { site: Site; editing: boolean; busy: boolean; onOpen: () => void; onEdit: () => void; onDetach: () => void }) {
  const drag = useDraggable({ id: `site:${site.id}`, data: { kind: 'site', fromFolder: true }, disabled: !editing || busy })
  return <div ref={drag.setNodeRef} className={`desktop-member${drag.isDragging ? ' is-dragging' : ''}`}>
    <button type="button" className="desktop-app" {...(editing ? { ...drag.attributes, ...drag.listeners, style: { touchAction: 'none' } } : {})} aria-label={editing ? `拖动图标 ${site.title}` : site.title} onClick={editing ? undefined : onOpen}><FolderSiteIcon site={site} /><span>{site.title}</span></button>
    {editing && <div className="desktop-member-actions"><button type="button" disabled={busy} onClick={onEdit}>编辑</button><button type="button" disabled={busy} onClick={onDetach}>移出文件夹</button></div>}
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
    <header><FolderIcon size={19} aria-hidden /><strong>{folder.name}</strong><span>{sites.length} 个图标</span><button type="button" className="desktop-window-close" onClick={onClose} disabled={busy} aria-label="关闭文件夹"><X size={18} /></button></header>
    <div className="desktop-folder-toolbar"><span>{editing ? '拖出窗口可放回画布，拖到其他文件夹可转移' : '你的收藏，随手可达'}</span>{editing && <><button type="button" disabled={busy} onClick={onEditFolder}><Settings2 size={14} />管理</button><button type="button" disabled={busy} onClick={onAdd}><Plus size={14} />添加</button></>}</div>
    <div className="desktop-folder-members">{sites.map(site => <FolderMember key={site.id} site={site} editing={editing} busy={busy} onOpen={() => onOpen(site)} onEdit={() => onEditSite(site)} onDetach={() => onDetach(site)} />)}{!sites.length && <p className="desktop-folder-empty">文件夹还是空的。进入编辑后，把图标拖到这里。</p>}</div>
  </div>, document.body)
}

function DesktopFolderPreview({ folder, sites, width, height, editing, onOpen, onEdit }: { folder: Folder; sites: Site[]; width: number; height: number; editing: boolean; onOpen: () => void; onEdit: () => void }) {
  const previewColumns = width === 1 ? 2 : Math.min(width + 1, 6)
  const limit = Math.min(24, previewColumns * (height === 1 ? 2 : Math.min(height + 1, 4)))
  const visible = sites.slice(0, sites.length > limit ? limit - 1 : limit)
  return <div className="desktop-folder-unit" data-columns={width} data-rows={height} style={{ '--folder-accent': folder.color || 'rgb(var(--accent-rgb))', '--preview-columns': previewColumns } as CSSProperties}>
    <button type="button" className="desktop-folder-preview" onClick={onOpen} aria-label={`打开文件夹 ${folder.name}，${sites.length} 个图标`} title={`${folder.name} · ${sites.length} 个图标`}>
      <span className="desktop-folder-miniicons" aria-hidden>{visible.map(site => <FolderSiteIcon key={site.id} site={site} />)}{sites.length > visible.length && <span className="desktop-folder-more">+{sites.length - visible.length}</span>}{!sites.length && <FolderIcon className="desktop-folder-empty-icon" />}</span>
    </button>
    <span className="desktop-tile-caption">{folder.name}</span>
    {editing && <button type="button" className="desktop-folder-config" aria-label={`设置文件夹 ${folder.name}`} title="设置名称、尺寸和内容" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onEdit() }}><Settings2 size={14} /></button>}
  </div>
}

function placeVisibleItems(items: DesktopItem[], layout: DesktopLayout, view: DesktopViewport) {
  const ids = new Set(items.map(item => item.id))
  return desktopOccupants(items, layout, view).filter(item => ids.has(item.id))
}


export function DesktopPage({ mode = 'desktop' }: { mode?: 'desktop' | 'home' }) {
  const isHome = mode === 'home'
  const layoutKey = isHome ? 'home_layout' : 'desktop_layout'
  const { sites, folders, categories, settings, rawSettings, user, canEdit, needsLogin, editMode, setEditMode, saveSettings, setTheme, netMode, registerClick } = useApp()
  const dark = useTheme(settings.theme)
  const [layout, setLayout] = useState(() => parseDesktopLayout(rawSettings[layoutKey]))
  const [boardWidth, setBoardWidth] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dropPreview, setDropPreview] = useState<PlacedItem | null>(null)
  const liveDrag = useRef<DragMotion | null>(null)
  const lastDropPreview = useRef<PlacedItem | null>(null)
  const resolveDropPreview = useRef<() => PlacedItem | null>(() => null)
  const [openFolderId, setOpenFolderId] = useState<number | null>(null)
  const [siteEditor, setSiteEditor] = useState<SiteEditor | null>(null)
  const [folderEditor, setFolderEditor] = useState<{ folder: Folder | null } | null>(null)
  const [sizingWidget, setSizingWidget] = useState<string | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [organizerOpen, setOrganizerOpen] = useState(false)
  const board = useRef<HTMLDivElement | null>(null)
  const dragPreview = useRef<HTMLDivElement | null>(null)
  const keyboardSteps = useRef({ col: 0, row: 0 })
  const [now, setNow] = useState(new Date())
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(timer) }, [])
  useEffect(() => { setLayout(parseDesktopLayout(rawSettings[layoutKey])) }, [rawSettings[layoutKey], layoutKey])
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
  const gap = isHome ? (view === 'wide' ? { sm: 12, md: 18, lg: 24 } : { sm: 8, md: 12, lg: 16 })[settings.grid_gap] : view === 'wide' ? 18 : 12
  const rowHeight = view === 'wide' ? (isHome ? { sm: 92, md: 104, lg: 120 }[settings.card_size] : 104) : 92
  // Each canvas/viewport must freeze its own initial positions before editing.
  useEffect(() => { setEditMode(false); setSizingWidget(null); setOpenFolderId(null) }, [mode, view, setEditMode])
  const cellWidth = Math.max(1, (boardWidth - (columns - 1) * gap) / columns)
  const editing = canEdit && editMode
  const folder = folders.find(f => f.id === openFolderId) ?? null
  const items = useMemo<Item[]>(() => {
    const result: Item[] = []
    const widget = (name: string) => result.push({ id: `widget:${name}`, kind: 'widget', widget: name, ...widgetSize(name, view, layout[view][`widget:${name}`]) })
    if (isHome || settings.desktop_header_mode === 'widgets') {
      if (settings.show_clock) widget('clock')
      widget('search')
    }
    if (settings.show_calendar) widget('calendar')
    if (settings.show_weather) widget('weather')
    if (settings.show_hitokoto) widget('quote')
    if (settings.show_workbench) widget('workbench')
    const folderIds = new Set(folders.map(f => f.id))
    for (const f of [...folders].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) result.push({ id: `folder:${f.id}`, kind: 'folder', folder: f, width: Math.min(columns, Math.max(1, f.columns)), height: Math.max(1, f.rows) })
    for (const site of [...sites].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) if (!site.folder_id || !folderIds.has(site.folder_id)) result.push({ id: `site:${site.id}`, kind: 'site', site, width: 1, height: 1 })
    // New integrations claim remaining space after existing icons, including
    // before the user has entered edit mode and saved their initial layout.
    if (user) {
      if (settings.show_lingxi_calendar) widget('lingxi-calendar')
      if (settings.show_lingxi_schedule) widget('lingxi-schedule')
      if (settings.show_lingxi_deadline) widget('lingxi-deadline')
      if (settings.show_lingxi_chat) widget('lingxi-chat')
    }
    return result
  }, [isHome, sites, folders, view, columns, layout, user, settings.desktop_header_mode, settings.show_calendar, settings.show_clock, settings.show_weather, settings.show_hitokoto, settings.show_workbench, settings.show_lingxi_calendar, settings.show_lingxi_schedule, settings.show_lingxi_deadline, settings.show_lingxi_chat])
  // Hidden widgets leave usable space while their last position and size remain saved.
  const placed = useMemo(() => placeVisibleItems(items, layout, view), [items, layout, view, columns])
  const occupied = useMemo(() => desktopOccupants(items, layout, view), [items, layout, view])
  const sizingItem = placed.find(item => item.id === `widget:${sizingWidget}`)
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
  resolveDropPreview.current = () => liveDrag.current ? canvasTarget(liveDrag.current) : null
  useEffect(() => {
    if (!activeId) return
    let frame: number
    const update = () => {
      // Measure the drawn overlay after layout, including scrolling while the
      // pointer stays still. Only a changed grid target needs a React update.
      const next = resolveDropPreview.current()
      const previous = lastDropPreview.current
      if (next?.id !== previous?.id || next?.col !== previous?.col || next?.row !== previous?.row || next?.width !== previous?.width || next?.height !== previous?.height) {
        lastDropPreview.current = next
        setDropPreview(next)
      }
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [activeId])

  function keepLayout(value: DesktopLayout) {
    setLayout(value)
    useApp.setState(state => ({ rawSettings: { ...state.rawSettings, [layoutKey]: JSON.stringify(value) } }))
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
    const state = useApp.getState()
    // Shared folders can change both modes: preserve every already-used canvas,
    // but only initialize the canvas the user is currently editing.
    for (const scope of ['desktop', 'home'] as const) {
      const saved = parseDesktopLayout(state.rawSettings[`${scope}_layout`])
      for (const viewport of ['wide', 'compact'] as const) {
        const active = scope === mode && viewport === view
        if (!active && !Object.keys(saved[viewport]).length) continue
        const current = active ? placed : desktopOccupants(desktopSettingsItems(visibleDesktopWidgetNames(state.settings, !!state.user, scope), state.folders, state.sites, saved, viewport), saved, viewport)
        const missing = current.filter(p => !saved[viewport][p.id]).map(({ id, col, row, width, height }) => ({ id, col, row, ...(id.startsWith('widget:') ? { width, height } : {}) }))
        for (let offset = 0; offset < missing.length; offset += 500) {
          const result = await api<{ layout: DesktopLayout }>('/api/desktop/layout', { method: 'PATCH', body: JSON.stringify({ scope, viewport, placements: missing.slice(offset, offset + 500) }) })
          if (scope === mode) keepLayout(result.layout)
          else useApp.setState(value => ({ rawSettings: { ...value.rawSettings, [`${scope}_layout`]: JSON.stringify(result.layout) } }))
        }
      }
    }
  }
  async function changeWidgets(key: string, value: boolean | string) {
    if (isHome) await freezeInitialPositions()
    await saveSettings({ [key]: value })
  }
  function resizeWidget(size: WidgetDimensions) {
    if (!sizingItem) return
    const error = widgetResizeError(sizingItem, size, occupied, columns)
    if (error) { toast.error(error); return }
    void run(async () => {
      await freezeInitialPositions()
      const result = await api<{ layout: DesktopLayout }>('/api/desktop/layout', { method: 'PATCH', body: JSON.stringify({ scope: mode, viewport: view, placements: [{ id: sizingItem.id, col: sizingItem.col, row: sizingItem.row, ...size }] }) })
      keepLayout(result.layout)
      setSizingWidget(null)
      toast.success(`已调整为 ${size.width} × ${size.height} 格`)
    })
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
    const position = target ?? freePosition({ id: `site:${site.id}`, width: 1, height: 1 }, { col: 0, row: 0 }, occupied, columns)
    if (folderId === null && site.folder_id) {
      const state = useApp.getState()
      const plan = planGridSiteRestore({ ...state, scope: mode, viewport: view, target: position, site, authenticated: !!state.user })
      for (const batch of [...plan.freeze, ...plan.restore]) {
        for (let offset = 0; offset < batch.placements.length; offset += 500) {
          const result = await api<{ layout: DesktopLayout }>('/api/desktop/layout', { method: 'PATCH', body: JSON.stringify({ scope: batch.scope, viewport: batch.viewport, placements: batch.placements.slice(offset, offset + 500) }) })
          if (batch.scope === mode) keepLayout(result.layout)
          else useApp.setState(current => ({ rawSettings: { ...current.rawSettings, [`${batch.scope}_layout`]: JSON.stringify(result.layout) } }))
        }
      }
    }
    const result = await api<{ layout: DesktopLayout; sites: Site[] }>('/api/desktop/move', { method: 'POST', body: JSON.stringify({ scope: mode, site_id: site.id, folder_id: folderId, viewport: view, position }) })
    keepLayout(result.layout); useApp.setState({ sites: result.sites })
    toast.success(folderId === null ? (isHome ? '已放回首页' : '已放回桌面') : '已移入文件夹')
  }
  // Shared by the live frame and the final drop, so the white outline is
  // exactly where the item will be saved, with the same collision checks.
  function canvasTarget(event: DragMotion): PlacedItem | null {
    if (event.over?.id !== 'desktop-surface') return null
    const id = String(event.active.id)
    const rootItem = items.find(item => item.id === id)
    const site = rootItem ? undefined : sites.find(s => `site:${s.id}` === id)
    const item = rootItem ?? (site?.folder_id ? { id, width: 1, height: 1 } : null)
    if (!item) return null
    const origin = placed.find(p => p.id === id)
    const preview = dragPreview.current?.getBoundingClientRect() ?? event.active.rect.current.translated
    const canvas = board.current?.getBoundingClientRect()
    const position = event.activatorEvent.type === 'keydown' && origin
      ? dropPosition(item, origin, { x: keyboardSteps.current.col * (cellWidth + gap), y: keyboardSteps.current.row * (rowHeight + gap) }, cellWidth, rowHeight, gap, occupied, columns)
      : preview && canvas
      ? canvasDropPosition(item, preview, canvas, cellWidth, rowHeight, gap, occupied, columns)
      : origin ? dropPosition(item, origin, event.delta, cellWidth, rowHeight, gap, occupied, columns) : null
    return position ? { id, width: item.width, height: item.height, ...position } : null
  }
  function clearDrag() {
    liveDrag.current = null
    lastDropPreview.current = null
    setDropPreview(null)
    setActiveId(null)
  }
  function trackDrag(event: DragMotion) { liveDrag.current = event }
  function endDrag(event: DragEndEvent) {
    const target = canvasTarget(event)
    clearDrag()
    const { active, over } = event
    if (!over || busyRef.current) return
    const id = String(active.id)
    const site = id.startsWith('site:') ? sites.find(s => `site:${s.id}` === id) : undefined
    if (over.data.current?.folderId && site) {
      if (site.folder_id !== over.data.current.folderId) void run(() => moveSite(site, Number(over.data.current!.folderId)))
      return
    }
    if (over.id !== 'desktop-surface') return
    if (!target) { toast.error('这里已有组件，已保留原位'); return }
    const { col, row } = target
    if (!items.some(item => item.id === id) && site?.folder_id) {
      void run(() => moveSite(site, null, { col, row })); return
    }
    void run(async () => {
      await freezeInitialPositions()
      const result = await api<{ layout: DesktopLayout }>('/api/desktop/layout', { method: 'PATCH', body: JSON.stringify({ scope: mode, viewport: view, placements: [{ id, col, row }] }) })
      keepLayout(result.layout)
    })
  }

  const activeItem = items.find(i => i.id === activeId)
  const activeSite = sites.find(s => `site:${s.id}` === activeId)
  const componentPreview = activeItem && activeItem.kind !== 'site'
  const previewSize = componentPreview ? { width: activeItem.width * (cellWidth + gap) - gap, height: activeItem.height * (rowHeight + gap) - gap } : undefined
  const looseGroups = categories.filter(c => sites.some(s => s.category_id === c.id && !s.folder_id)).length
  const dockSites = useMemo(() => [...sites].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).slice(0, 6), [sites])
  const renderWidget = (name: string) => {
    if (name === 'lingxi-calendar') return <LingxiCalendarWidget compact />
    if (name === 'lingxi-schedule') return <LingxiScheduleWidget compact />
    if (name === 'lingxi-deadline') return <LingxiDeadlineWidget compact />
    if (name === 'lingxi-chat') return <LingxiChatWidget compact />
    return name === 'clock' ? <Clock /> : name === 'search' ? <SearchBar /> : name === 'calendar' ? <DesktopCalendar now={now} /> : name === 'weather' ? <><WeatherWidget /><span className="desktop-widget-fallback">天气会在连接成功后显示</span></> : name === 'quote' ? <><HitokotoWidget /><span className="desktop-widget-fallback">给今天留一点灵感</span></> : <WorkbenchWidget />
  }
  function addSite() { void run(async () => { await freezeInitialPositions(); setSiteEditor({ site: null, folderId: null }) }) }
  function addFolder() { void run(async () => { await freezeInitialPositions(); setFolderEditor({ folder: null }) }) }
  function editFolder(value: Folder) { void run(async () => { await freezeInitialPositions(); setOpenFolderId(null); setFolderEditor({ folder: value }) }) }

  if (needsLogin) return <Navigate to="/login" replace />
  return <DndContext sensors={sensors} collisionDetection={collision} onDragStart={event => { keyboardSteps.current = { col: 0, row: 0 }; liveDrag.current = { ...event, over: null, delta: { x: 0, y: 0 } }; setActiveId(String(event.active.id)) }} onDragMove={trackDrag} onDragOver={trackDrag} onDragCancel={clearDrag} onDragEnd={endDrag}>
    <div className={`free-desktop${isHome ? ' home-shell free-home' : ''}${editing ? ' desktop-editing' : ''}`} data-layout-scope={mode}>
      {isHome && <Toolbar onAddSite={addSite} onAddFolder={addFolder} onToggleEdit={toggleEditing} onBulkDelete={openBulkDelete} onLayoutOptions={() => setOptionsOpen(true)} layoutBusy={busy} onOrganize={() => void run(async () => { await freezeInitialPositions(); setOrganizerOpen(true) })} />}
      {!isHome && <><nav className="desktop-sidebar" aria-label="桌面导航">
        <Link to="/desktop" className="desktop-sidebar-brand" title={settings.site_title} aria-label={settings.site_title}><Command size={24} /><span>{settings.site_title}</span></Link>
        <div className="desktop-sidebar-links">
          <Link to="/desktop" className="is-active" aria-current="page" title="桌面"><Home /><span>桌面</span></Link>
          <Link to="/navigation" title="导航主页"><LayoutGrid /><span>导航</span></Link>
          <Link to="/notes" title="笔记"><NotebookPen /><span>笔记</span></Link>
          {user && <Link to="/lingxi" title="灵犀工作区"><MessageCircle /><span>灵犀</span></Link>}
          {canEdit && <><Link to="/subscriptions" title="订阅中心"><Rss /><span>订阅</span></Link><button type="button" disabled={busy} onClick={addSite} title="添加图标" aria-label="添加图标"><Plus /><span>添加图标</span></button><button type="button" disabled={busy} onClick={addFolder} title="新建文件夹" aria-label="新建文件夹"><FolderPlus /><span>新建文件夹</span></button></>}
        </div>
        <div className="desktop-sidebar-bottom">{canEdit ? <Link to="/settings/appearance" title="外观设置"><Settings2 /><span>设置</span></Link> : <Link to="/login" title="登录"><LogIn /><span>登录</span></Link>}</div>
      </nav>
      <header className="desktop-top-actions">
        {canEdit && <>{editing && <button type="button" disabled={busy} onClick={openBulkDelete} title="批量删除图标" aria-label="批量删除图标"><Trash2 size={17} /><span>批量删除</span></button>}<button type="button" disabled={busy} onClick={toggleEditing} title={editing ? '完成布局' : '编辑桌面'} aria-label={editing ? '完成布局' : '编辑桌面'}>{busy ? <Loader2 size={17} className="animate-spin" /> : editing ? <Check size={17} /> : <Pencil size={17} />}<span>{editing ? '完成' : '编辑'}</span></button></>}
        <button type="button" title={dark ? '切换到浅色' : '切换到深色'} aria-label={dark ? '切换到浅色' : '切换到深色'} onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
        {canEdit && <button type="button" disabled={busy} onClick={() => setOptionsOpen(true)} title="桌面选项" aria-label="桌面选项"><Settings2 size={17} /></button>}
      </header></>}
      <main className={`desktop-workspace${isHome ? ' home-canvas-workspace' : ''}`} aria-label={settings.site_title}>
        {!isHome && settings.desktop_header_mode === 'hero' && <div className="desktop-hero">{settings.show_clock && <Clock />}<SearchBar /></div>}
        {editing && <p className="desktop-edit-hint"><Grip size={15} />拖到空白网格保存，点击尺寸按钮调整大小</p>}
        <DesktopSurface label={isHome ? '首页自由布局画布' : '自由桌面画布'} boardRef={board} height={boardHeight} editing={editing} columns={columns} cellWidth={cellWidth} gap={gap} rowHeight={rowHeight}>
          {activeId && dropPreview && <div className="desktop-drop-preview" aria-hidden="true" data-drop-col={dropPreview.col} data-drop-row={dropPreview.row} style={{ left: dropPreview.col * (cellWidth + gap), top: dropPreview.row * (rowHeight + gap), width: dropPreview.width * (cellWidth + gap) - gap, height: dropPreview.height * (rowHeight + gap) - gap }}><span>松开放置</span></div>}
          {boardWidth > 0 && items.map(item => <DesktopTile key={item.id} item={item} position={placed.find(p => p.id === item.id)!} cellWidth={cellWidth} gap={gap} rowHeight={rowHeight} editing={editing} disabled={busy} onResize={() => { if (item.kind === 'widget') { setOpenFolderId(null); setSizingWidget(item.widget) } }}>
            {item.kind === 'widget' ? <div className="desktop-widget-unit"><div className={`desktop-widget desktop-widget-${item.widget}`} data-widget-width={item.width} data-widget-height={item.height}>{renderWidget(item.widget)}</div><span className="desktop-tile-caption">{widgetLabels[item.widget]}</span></div> : item.kind === 'folder' ? <DesktopFolderPreview folder={item.folder} sites={sites.filter(s => s.folder_id === item.folder.id).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)} width={item.width} height={item.height} editing={editing} onOpen={() => setOpenFolderId(item.folder.id)} onEdit={() => editFolder(item.folder)} /> : isHome ? <SiteCard site={item.site} editMode={editing} size={settings.card_size} netMode={netMode} hideActions onOpen={() => openSite(item.site)} onEdit={() => setSiteEditor({ site: item.site, folderId: item.site.folder_id ?? null })} onDelete={() => setSiteEditor({ site: item.site, folderId: item.site.folder_id ?? null })} /> : <button type="button" className="desktop-app" onClick={() => editing ? setSiteEditor({ site: item.site, folderId: item.site.folder_id ?? null }) : openSite(item.site)} title={item.site.description || item.site.title}><FolderSiteIcon site={item.site} /><span>{item.site.title}</span></button>}
          </DesktopTile>)}
        </DesktopSurface>
      </main>
      {!isHome && <nav className="desktop-dock" aria-label="快捷图标">{dockSites.map(site => <button key={site.id} type="button" className="desktop-dock-site" onClick={() => openSite(site)} title={site.title} aria-label={`打开 ${site.title}`}><FolderSiteIcon site={site} /><span>{site.title}</span></button>)}<Link to="/navigation" className="desktop-dock-more" title="所有图标" aria-label="所有图标"><LayoutGrid /><span>所有图标</span></Link></nav>}
      {isHome && editing && <nav className="home-canvas-editbar glass glass-pop" aria-label="首页编辑操作"><button type="button" disabled={busy} onClick={addSite}><Plus size={20} />加图标</button><button type="button" disabled={busy} onClick={addFolder}><FolderPlus size={20} />文件夹</button><button type="button" disabled={busy} onClick={() => setOptionsOpen(true)}><Settings2 size={20} />组件</button><button type="button" disabled={busy} onClick={toggleEditing}><Check size={20} />完成</button></nav>}
    </div>
    {folder && <DesktopFolderWindow folder={folder} sites={sites.filter(s => s.folder_id === folder.id).sort((a, b) => a.sort_order - b.sort_order)} editing={editing} busy={busy} onClose={() => setOpenFolderId(null)} onOpen={openSite} onEditSite={site => { setOpenFolderId(null); setSiteEditor({ site, folderId: folder.id }) }} onEditFolder={() => editFolder(folder)} onAdd={() => { setOpenFolderId(null); setSiteEditor({ site: null, folderId: folder.id }) }} onDetach={site => void run(() => moveSite(site, null))} />}
    {siteEditor && <SiteEditorModal open foldersOnly site={siteEditor.site} defaultCategoryId={siteEditor.site?.category_id ?? null} defaultFolderId={siteEditor.folderId} onClose={() => setSiteEditor(null)} />}
    {folderEditor && <FolderEditorModal open foldersOnly validateSize={(folderId, columns, rows) => folderResizeError({ ...useApp.getState(), folderId, columns, rows })} folder={folderEditor.folder} defaultCategoryId={null} onClose={() => setFolderEditor(null)} />}
    {canEdit && <BulkSiteDeleteModal open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} />}
    {isHome && canEdit && user && <NavigationAiOrganizer open={organizerOpen} onClose={() => setOrganizerOpen(false)} />}
    {sizingWidget && sizingItem && <DesktopWidgetSizeDialog key={`${view}:${sizingWidget}`} name={sizingWidget} viewport={view} item={sizingItem} occupied={occupied} busy={busy} onClose={() => setSizingWidget(null)} onApply={resizeWidget} />}
    <Modal open={optionsOpen} title={isHome ? '首页布局选项' : '桌面选项'} onClose={() => !busy && setOptionsOpen(false)}>
      <div className="desktop-options"><p>电脑和手机分别保存位置与尺寸。拖放吸附网格，目标有组件时保留原位，不自动排列或挪动其他组件。隐藏组件会释放空间；重新显示时优先回到原位，被占用则仅将恢复的组件放到空位。聚焦把手后按空格开始或结束，方向键移动。</p>
        {([['show_clock', '时钟'], ['show_calendar', '日历'], ['show_weather', '天气'], ['show_hitokoto', '每日一句'], ['show_workbench', '工作台'], ['show_lingxi_calendar', '灵犀日历'], ['show_lingxi_schedule', '日程与待办'], ['show_lingxi_deadline', '截止倒计时'], ['show_lingxi_chat', '灵犀 AI 聊天']] as const).map(([key, label]) => <label key={key}>{label}<input type="checkbox" checked={settings[key]} disabled={busy} onChange={event => { const checked = event.target.checked; void run(() => changeWidgets(key, checked)) }} /></label>)}
        <div className="desktop-widget-size-list"><strong>组件尺寸</strong><p>每个组件提供小号、标准和大号；也可在编辑时点击组件左上角的尺寸按钮。</p>{items.filter(item => item.kind === 'widget').map(item => <button type="button" key={item.id} disabled={busy} onClick={() => { if (item.kind === 'widget') { setOpenFolderId(null); setOptionsOpen(false); setSizingWidget(item.widget) } }}><span>{item.kind === 'widget' ? widgetLabels[item.widget] : ''}</span><span>{item.width} × {item.height} 格 <Maximize2 size={14} /></span></button>)}{!isHome && settings.desktop_header_mode === 'hero' && <p>将下方「时钟与搜索」设为「可拖动组件」后，也能调整它们的尺寸。</p>}</div>
        <Link to="/settings/lingxi" className={btnGhost}>管理灵犀账号与密码读取权限</Link>
        {!isHome && <label>时钟与搜索<select aria-label="时钟与搜索位置" value={settings.desktop_header_mode} disabled={busy} onChange={event => { const mode = event.target.value; void run(() => changeWidgets('desktop_header_mode', mode)) }}><option value="hero">居中置顶</option><option value="widgets">可拖动组件</option></select></label>}
        <button type="button" className={btnGhost} disabled={busy || settings.home_mode === (isHome ? 'navigation' : 'desktop')} onClick={() => void run(async () => { await saveSettings({ home_mode: isHome ? 'navigation' : 'desktop' }); toast.success(isHome ? '已将普通导航设为首页' : '已将自由桌面设为首页') })}>{isHome ? (settings.home_mode === 'navigation' ? '当前默认首页：普通导航' : '将普通导航设为首页') : (settings.home_mode === 'desktop' ? '当前默认首页：自由桌面' : '将自由桌面设为首页')}</button>
        {looseGroups > 0 && <div className="desktop-collect"><strong>用文件夹收纳已有图标</strong><p>将 {looseGroups} 个原分组的散落图标分别收纳到同名文件夹。已有文件夹保持原样，删除新文件夹可把图标放回桌面。</p><button type="button" className={btnGhost} disabled={busy} onClick={() => void run(async () => { await freezeInitialPositions(); const result = await api<{ created: number; sites: Site[]; folders: Folder[] }>('/api/desktop/collect-groups', { method: 'POST' }); useApp.setState({ sites: result.sites, folders: result.folders }); toast.success(`已收纳到 ${result.created} 个文件夹`) })}>按原分组收纳为文件夹</button></div>}
      </div>
    </Modal>
    {createPortal(<DragOverlay dropAnimation={null} transition="none" zIndex={90}>{activeId && <div ref={dragPreview} className={`desktop-drag-preview${componentPreview ? ' is-component' : ''}`} style={previewSize}>{activeSite ? <><FolderSiteIcon site={activeSite} /><span>{activeSite.title}</span></> : <div className="desktop-drag-badge"><Grip size={24} /><span>{activeItem?.kind === 'folder' ? activeItem.folder.name : activeItem?.kind === 'widget' ? widgetLabels[activeItem.widget] : '移动'}</span>{componentPreview && <small>{activeItem.width} × {activeItem.height} 格</small>}</div>}</div>}</DragOverlay>, document.body)}
  </DndContext>
}

// This child lives inside DndContext so the canvas is a registered drop target.
function DesktopSurface({ label, boardRef, height, editing, columns, cellWidth, gap, rowHeight, children }: { label: string; boardRef: React.RefObject<HTMLDivElement | null>; height: number; editing: boolean; columns: number; cellWidth: number; gap: number; rowHeight: number; children: ReactNode }) {
  const drop = useDroppable({ id: 'desktop-surface' })
  return <div ref={node => { boardRef.current = node; drop.setNodeRef(node) }} className="desktop-surface" aria-label={label} style={{ height, '--desktop-cell': `${cellWidth + gap}px`, '--desktop-row': `${rowHeight + gap}px`, '--desktop-columns': columns } as CSSProperties} data-editing={editing || undefined}>{children}</div>
}
