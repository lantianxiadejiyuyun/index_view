import { desktopOccupants, overlaps, parseDesktopLayout } from './desktop-layout.ts'
import { desktopSettingsItems, visibleDesktopWidgetNames } from './desktop-settings-layout.ts'
import type { AppSettings } from './settings.ts'
import type { Folder, SessionUser, Site } from './types.ts'

/** Validate a shared folder size against every initialized grid without changing any position. */
export function folderResizeError(input: {
  folderId: number; columns: number; rows: number
  settings: AppSettings; user: SessionUser | null
  sites: Site[]; folders: Folder[]; rawSettings: Record<string, string>
}): string | null {
  const { folderId, columns, rows, settings, user, sites, folders, rawSettings } = input
  if (!Number.isSafeInteger(columns) || columns < 1 || !Number.isSafeInteger(rows) || rows < 1) {
    return '文件夹尺寸必须是可精确表示的大于 0 的整数。'
  }
  const folder = folders.find(item => item.id === folderId)
  if (!folder) return '文件夹已不存在，请关闭编辑窗口后重试。'
  if (columns === folder.columns && rows === folder.rows) return null

  for (const scope of ['home', 'desktop'] as const) {
    const layout = parseDesktopLayout(rawSettings[`${scope}_layout`])
    const names = visibleDesktopWidgetNames(settings, Boolean(user), scope)
    for (const viewport of ['wide', 'compact'] as const) {
      // A never-arranged viewport may derive its initial layout from the new size.
      if (Object.keys(layout[viewport]).length === 0) continue
      const gridColumns = viewport === 'wide' ? 12 : 4
      const items = desktopSettingsItems(names, folders, sites, layout, viewport)
      const occupied = desktopOccupants(items, layout, viewport)
      const current = occupied.find(item => item.id === `folder:${folderId}`)
      if (!current) continue
      const width = Math.min(gridColumns, columns)
      const height = rows
      // Shrinking adds no occupied cells and can repair a historical overlap.
      if (width <= current.width && height <= current.height) continue
      const where = `${scope === 'home' ? '普通首页' : '桌面'}的${viewport === 'wide' ? '电脑' : '手机'}布局`
      if (current.col + width > gridColumns) {
        return `这个尺寸会超出${where}的右边界，请先将文件夹向左移动。`
      }
      // Old layouts can contain a column that the current width temporarily clamps.
      // Narrowing reveals that saved column again, so check the actual rendered result.
      const saved = layout[viewport][current.id]
      const col = saved ? Math.min(saved.col, gridColumns - width) : current.col
      const resized = { ...current, col, width, height }
      if (occupied.some(item => item.id !== current.id && overlaps(resized, item))) {
        return `这个尺寸会与${where}的其他图标、文件夹或组件重叠，请先腾出空间。`
      }
    }
  }
  return null
}
