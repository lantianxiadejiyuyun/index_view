import { desktopOccupants, freePosition, overlaps, parseDesktopLayout, vacantDropPosition, type DesktopItem, type DesktopPosition, type DesktopViewport, type PlacedItem } from './desktop-layout.ts'
import { desktopSettingsItems, visibleDesktopWidgetNames, type DesktopSettingsPlacement, type DesktopSettingsScope } from './desktop-settings-layout.ts'
import type { AppSettings } from './settings.ts'
import type { Folder, Site } from './types.ts'

export type GridSiteRestoreBatch = {
  scope: DesktopSettingsScope
  viewport: DesktopViewport
  placements: DesktopSettingsPlacement[]
}
export type GridSiteRestorePlan = { freeze: GridSiteRestoreBatch[]; restore: GridSiteRestoreBatch[] }

function restoredPosition(item: DesktopItem, saved: DesktopPosition | undefined, current: PlacedItem[], columns: number): DesktopPosition {
  let position = (saved && vacantDropPosition(item, saved, current, columns))
    || freePosition(item, saved ?? { col: 0, row: 0 }, current, columns)
  // The shared search starts at the old row. At the final row, try earlier
  // space as well before declaring a pathological imported canvas full.
  if (current.some(other => overlaps({ ...item, ...position }, other))) {
    position = freePosition(item, { col: 0, row: 0 }, current, columns)
  }
  if (current.some(other => overlaps({ ...item, ...position }, other))) {
    throw new Error('页面没有足够空位，请先腾出空间再移出图标')
  }
  return position
}

function unsavedPlacements(current: PlacedItem[], saved: Record<string, DesktopPosition>): DesktopSettingsPlacement[] {
  return current.filter(item => !saved[item.id]).map(({ id, col, row, width, height }) => ({
    id, col, row, ...(id.startsWith('widget:') ? { width, height } : {}),
  }))
}

/** Plan every affected canvas before a folder member becomes visible on all of them.
 * Apply all freeze batches, then restore batches, before moving the site out of its folder.
 * Only the restored site may choose a new position; existing tiles remain where drawn.
 */
export function planGridSiteRestore(input: {
  scope: DesktopSettingsScope; viewport: DesktopViewport; target: DesktopPosition
  site: Site; settings: AppSettings; authenticated: boolean
  sites: Site[]; folders: Folder[]; rawSettings: Record<string, string>
}): GridSiteRestorePlan {
  const { scope: activeScope, viewport: activeViewport, target, site, settings, authenticated, folders, rawSettings } = input
  const plan: GridSiteRestorePlan = { freeze: [], restore: [] }
  const restored: DesktopItem = { id: `site:${site.id}`, width: 1, height: 1 }
  // Exclude the restoring member explicitly, even if its old folder was deleted.
  const remainingSites = input.sites.filter(item => item.id !== site.id)
  for (const scope of ['desktop', 'home'] as const) {
    const layout = parseDesktopLayout(rawSettings[`${scope}_layout`])
    const names = visibleDesktopWidgetNames(settings, authenticated, scope)
    for (const viewport of ['wide', 'compact'] as const) {
      const active = scope === activeScope && viewport === activeViewport
      if (!active && Object.keys(layout[viewport]).length === 0) continue
      const columns = viewport === 'wide' ? 12 : 4
      const current = desktopOccupants(desktopSettingsItems(names, folders, remainingSites, layout, viewport), layout, viewport)
      const missing = unsavedPlacements(current, layout[viewport])
      if (missing.length) plan.freeze.push({ scope, viewport, placements: missing })

      let position: DesktopPosition
      if (active) {
        // A confirmed drop must never silently snap to a different cell.
        if (!Number.isInteger(target.col) || target.col < 0 || target.col >= columns || !Number.isInteger(target.row) || target.row < 0 || target.row > 10000) {
          throw new Error('放置位置无效，请重新选择空位')
        }
        const available = vacantDropPosition(restored, target, current, columns)
        if (!available) throw new Error('放置位置已被占用，请重新选择空位')
        position = available
      } else {
        position = restoredPosition(restored, layout[viewport][restored.id], current, columns)
      }
      plan.restore.push({ scope, viewport, placements: [{ id: restored.id, col: position.col, row: position.row }] })
    }
  }
  return plan
}

/** Restore members released by folder/site editing without initializing unused canvases. */
export function planGridCollectionRestore(input: {
  settings: AppSettings; authenticated: boolean; rawSettings: Record<string, string>
  beforeSites: Site[]; beforeFolders: Folder[]; sites: Site[]; folders: Folder[]
}): GridSiteRestorePlan {
  const { settings, authenticated, rawSettings, beforeSites, beforeFolders, sites, folders } = input
  const plan: GridSiteRestorePlan = { freeze: [], restore: [] }
  const previousSites = new Map(beforeSites.map(site => [site.id, site]))
  const previousFolders = new Set(beforeFolders.map(folder => folder.id))
  const nextFolders = new Set(folders.map(folder => folder.id))
  const restoredSites = sites.filter(site => {
    const oldFolder = previousSites.get(site.id)?.folder_id
    return oldFolder != null && previousFolders.has(oldFolder) && (site.folder_id == null || !nextFolders.has(site.folder_id))
  }).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
  if (!restoredSites.length) return plan
  const restoredIds = new Set(restoredSites.map(site => site.id))
  const remainingSites = sites.filter(site => !restoredIds.has(site.id))
  for (const scope of ['desktop', 'home'] as const) {
    const layout = parseDesktopLayout(rawSettings[`${scope}_layout`])
    const names = visibleDesktopWidgetNames(settings, authenticated, scope)
    for (const viewport of ['wide', 'compact'] as const) {
      if (Object.keys(layout[viewport]).length === 0) continue
      const columns = viewport === 'wide' ? 12 : 4
      const before = desktopOccupants(desktopSettingsItems(names, beforeFolders, beforeSites, layout, viewport), layout, viewport)
      // Reuse the drawn positions before deleting folders. Recomputing the initial
      // positions after deletion would pull unsaved neighbouring icons into the gap.
      const frozen = { ...layout[viewport] }
      for (const { id, col, row } of before) frozen[id] = { ...frozen[id], col, row }
      const current = desktopOccupants(desktopSettingsItems(names, folders, remainingSites, layout, viewport), { ...layout, [viewport]: frozen }, viewport)
      const missing = unsavedPlacements(current, layout[viewport])
      if (missing.length) plan.freeze.push({ scope, viewport, placements: missing })

      const candidates = restoredSites.map(site => ({ id: `site:${site.id}`, width: 1, height: 1 }))
      const positions = new Map<string, DesktopPosition>()
      // Reserve every still-vacant old position before allocating replacement
      // cells, so an earlier conflicting member cannot take a later member's home.
      for (const item of candidates) {
        const saved = layout[viewport][item.id]
        const position = saved && vacantDropPosition(item, saved, current, columns)
        if (!position) continue
        positions.set(item.id, position)
        current.push({ ...item, ...position })
      }
      for (const item of candidates) {
        if (positions.has(item.id)) continue
        const position = restoredPosition(item, layout[viewport][item.id], current, columns)
        positions.set(item.id, position)
        current.push({ ...item, ...position })
      }
      plan.restore.push({ scope, viewport, placements: candidates.map(({ id }) => ({ id, ...positions.get(id)! })) })
    }
  }
  return plan
}
