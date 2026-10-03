import { validWidgetSize, widgetSize, type WidgetDimensions } from './desktop-widgets.ts'

export type DesktopViewport = 'wide' | 'compact'
export type DesktopPosition = { col: number; row: number; width?: number; height?: number }
export type DesktopLayout = { version: 1; wide: Record<string, DesktopPosition>; compact: Record<string, DesktopPosition> }
export type DesktopItem = { id: string; width: number; height: number }
export type PlacedItem = DesktopItem & DesktopPosition
export const emptyDesktopLayout = (): DesktopLayout => ({ version: 1, wide: {}, compact: {} })

export function parseDesktopLayout(raw?: string): DesktopLayout {
  const result = emptyDesktopLayout()
  try {
    const value = JSON.parse(raw ?? '{}')
    for (const view of ['wide', 'compact'] as const) {
      for (const [id, entry] of Object.entries(value[view] ?? {})) {
        if (!/^(?:site:[1-9]\d*|folder:[1-9]\d*|widget:(?:clock|search|weather|quote|workbench|calendar|lingxi-calendar|lingxi-schedule|lingxi-deadline|lingxi-chat))$/.test(id)) continue
        const p = entry as DesktopPosition
        if (p && Number.isInteger(p.col) && p.col >= 0 && p.col < (view === 'wide' ? 12 : 4) && Number.isInteger(p.row) && p.row >= 0 && p.row <= 10000) {
          result[view][id] = { col: p.col, row: p.row, ...(id.startsWith('widget:') && validWidgetSize(p, view === 'wide' ? 12 : 4) ? { width: p.width, height: p.height } : {}) }
        }
      }
    }
  } catch { /* Older backups have no desktop layout. */ }
  return result
}

export function overlaps(a: PlacedItem, b: PlacedItem): boolean {
  return a.col < b.col + b.width && a.col + a.width > b.col && a.row < b.row + b.height && a.row + a.height > b.row
}

/** Only drawn tiles occupy the canvas. Hidden widgets retain preferences, not invisible obstacles. */
export function desktopOccupants(items: DesktopItem[], layout: DesktopLayout, view: DesktopViewport): PlacedItem[] {
  return arrangeDesktop(items, layout[view], view === 'wide' ? 12 : 4)
}

/** Restore only the requested widgets, keeping every currently visible tile fixed. */
export function restoreDesktopWidgets(current: PlacedItem[], names: string[], layout: DesktopLayout, view: DesktopViewport): PlacedItem[] {
  const occupied = [...current]
  const candidates = [...new Set(names)].flatMap(name => {
    const id = `widget:${name}`
    return occupied.some(item => item.id === id) ? [] : [{ id, ...widgetSize(name, view, layout[view][id]) }]
  })
  const columns = view === 'wide' ? 12 : 4
  const restored = new Map<string, PlacedItem>()
  // Claim vacant saved positions first so one relocated widget cannot steal
  // another widget's still-available home (e.g. restoring clock and search together).
  for (const item of candidates) {
    const saved = layout[view][item.id]
    const position = saved && vacantDropPosition(item, saved, occupied, columns)
    if (!position) continue
    const placed = { ...item, ...position }
    occupied.push(placed)
    restored.set(item.id, placed)
  }
  for (const item of candidates) {
    if (restored.has(item.id)) continue
    const position = freePosition(item, layout[view][item.id] ?? { col: 0, row: 0 }, occupied, columns)
    const placed = { ...item, ...position }
    if (occupied.some(other => overlaps(placed, other))) throw new Error('桌面没有足够空位，请先腾出空间再显示组件')
    occupied.push(placed)
    restored.set(item.id, placed)
  }
  return candidates.map(item => restored.get(item.id)!)
}

/** Resizing stays anchored; it never snaps sideways or rearranges neighbouring tiles. */
export function widgetResizeError(item: PlacedItem, size: WidgetDimensions, occupied: PlacedItem[], columns: number): string | null {
  if (!validWidgetSize(size, columns)) return '组件尺寸无效'
  if (item.col + size.width > columns) return '超出桌面边缘，请先将组件向左移动'
  if (occupied.some(other => other.id !== item.id && overlaps({ ...item, ...size }, other))) return '空间已被占用，请先移动组件腾出空间'
  return null
}

/** Find a free cell without shifting other components; explicit blank space is retained. */
export function freePosition(item: DesktopItem, target: DesktopPosition, occupied: PlacedItem[], columns: number): DesktopPosition {
  const col = Math.max(0, Math.min(columns - item.width, Math.round(target.col)))
  const row = Math.max(0, Math.min(10000, Math.round(target.row)))
  const fits = (c: number, r: number) => !occupied.some(other => overlaps({ ...item, col: c, row: r }, other))
  if (fits(col, row)) return { col, row }
  for (let r = row; r <= 10000; r++) for (let c = 0; c <= columns - item.width; c++) if (fits(c, r)) return { col: c, row: r }
  // Overflow can only occur for pathological imported dimensions; keep the item reachable.
  return { col: 0, row: 10000 }
}

export function arrangeDesktop(items: DesktopItem[], positions: Record<string, DesktopPosition>, columns: number): PlacedItem[] {
  const placed: PlacedItem[] = []
  const ordered = [...items.filter(item => positions[item.id]), ...items.filter(item => !positions[item.id])]
  // Saved placements belong to the user. Resizing or moving another tile must not reorder them.
  for (const item of ordered) placed.push({ ...item, ...(positions[item.id] ? clampPosition(item, positions[item.id]!, columns) : freePosition(item, { col: 0, row: 0 }, placed, columns)) })
  return items.map(item => placed.find(p => p.id === item.id)!)
}

function clampPosition(item: DesktopItem, target: DesktopPosition, columns: number): DesktopPosition {
  return { col: Math.max(0, Math.min(columns - item.width, Math.round(target.col))), row: Math.max(0, Math.min(10000, Math.round(target.row))) }
}

export function vacantDropPosition(item: DesktopItem, target: DesktopPosition, occupied: PlacedItem[], columns: number): DesktopPosition | null {
  const position = clampPosition(item, target, columns)
  return occupied.some(other => other.id !== item.id && overlaps({ ...item, ...position }, other)) ? null : position
}

export function dropPosition(item: DesktopItem, origin: DesktopPosition, delta: { x: number; y: number }, cellWidth: number, rowHeight: number, gap: number, occupied: PlacedItem[], columns: number): DesktopPosition | null {
  return vacantDropPosition(item, { col: origin.col + delta.x / (cellWidth + gap), row: origin.row + delta.y / (rowHeight + gap) }, occupied, columns)
}

export function canvasDropPosition(item: DesktopItem, preview: { left: number; top: number }, canvas: { left: number; top: number }, cellWidth: number, rowHeight: number, gap: number, occupied: PlacedItem[], columns: number): DesktopPosition | null {
  return vacantDropPosition(item, { col: (preview.left - canvas.left) / (cellWidth + gap), row: (preview.top - canvas.top) / (rowHeight + gap) }, occupied, columns)
}
