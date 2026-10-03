import { desktopOccupants, restoreDesktopWidgets, type DesktopItem, type DesktopLayout, type DesktopPosition, type DesktopViewport } from './desktop-layout.ts'
import { widgetSize } from './desktop-widgets.ts'
import type { AppSettings } from './settings.ts'
import type { Folder, Site } from './types.ts'

export type DesktopSettingsPlacement = DesktopPosition & { id: string }
export type DesktopSettingsScope = 'desktop' | 'home'
export type DesktopSettingsBatch = { viewport: DesktopViewport; placements: DesktopSettingsPlacement[] }
export type DesktopSettingsLayoutPlan = {
  freeze: DesktopSettingsBatch[]
  restore: DesktopSettingsBatch[]
  relocated: { id: string; viewport: DesktopViewport }[]
}

/** Match DesktopPage's actual widget visibility, including its non-canvas hero. */
export function visibleDesktopWidgetNames(settings: AppSettings, authenticated: boolean, scope: DesktopSettingsScope = 'desktop'): string[] {
  const names: string[] = []
  if (scope === 'home' || settings.desktop_header_mode === 'widgets') {
    if (settings.show_clock) names.push('clock')
    names.push('search')
  }
  if (settings.show_calendar) names.push('calendar')
  if (settings.show_weather) names.push('weather')
  if (settings.show_hitokoto) names.push('quote')
  if (settings.show_workbench) names.push('workbench')
  if (authenticated) {
    if (settings.show_lingxi_calendar) names.push('lingxi-calendar')
    if (settings.show_lingxi_schedule) names.push('lingxi-schedule')
    if (settings.show_lingxi_deadline) names.push('lingxi-deadline')
    if (settings.show_lingxi_chat) names.push('lingxi-chat')
  }
  return names
}

/** Keep the same initial placement order as DesktopPage on either viewport. */
export function desktopSettingsItems(names: string[], folders: Folder[], sites: Site[], layout: DesktopLayout, viewport: DesktopViewport): DesktopItem[] {
  const columns = viewport === 'wide' ? 12 : 4
  const widget = (name: string): DesktopItem => ({ id: `widget:${name}`, ...widgetSize(name, viewport, layout[viewport][`widget:${name}`]) })
  const items = names.filter(name => !name.startsWith('lingxi-')).map(widget)
  const folderIds = new Set(folders.map(folder => folder.id))
  for (const folder of [...folders].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) {
    items.push({ id: `folder:${folder.id}`, width: Math.min(columns, Math.max(1, folder.columns)), height: Math.max(1, folder.rows) })
  }
  for (const site of [...sites].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) {
    if (!site.folder_id || !folderIds.has(site.folder_id)) items.push({ id: `site:${site.id}`, width: 1, height: 1 })
  }
  items.push(...names.filter(name => name.startsWith('lingxi-')).map(widget))
  return items
}

/** Plan both layouts before writing anything; only newly visible widgets may move. */
export function planDesktopSettingsLayout(input: {
  before: AppSettings; after: AppSettings; authenticated: boolean
  folders: Folder[]; sites: Site[]; layout: DesktopLayout; scope?: DesktopSettingsScope
}): DesktopSettingsLayoutPlan | null {
  const { before, after, authenticated, folders, sites, layout, scope = 'desktop' } = input
  const previous = visibleDesktopWidgetNames(before, authenticated, scope)
  const next = visibleDesktopWidgetNames(after, authenticated, scope)
  if (previous.join('|') === next.join('|')) return null
  const previousIds = new Set(previous)
  const nextIds = new Set(next.map(name => `widget:${name}`))
  const added = next.filter(name => !previousIds.has(name))
  const plan: DesktopSettingsLayoutPlan = { freeze: [], restore: [], relocated: [] }
  for (const viewport of ['wide', 'compact'] as const) {
    // Do not pre-initialize a never-arranged home from an unrelated settings page.
    // Its on-page toggles freeze the currently drawn initial layout before saving.
    if (scope === 'home' && Object.keys(layout[viewport]).length === 0) continue
    const items = desktopSettingsItems(previous, folders, sites, layout, viewport)
    const current = desktopOccupants(items, layout, viewport)
    const missing = current.filter(item => !layout[viewport][item.id]).map(({ id, col, row, width, height }) => ({
      id, col, row, ...(id.startsWith('widget:') ? { width, height } : {}),
    }))
    if (missing.length) plan.freeze.push({ viewport, placements: missing })
    // A widget hidden by the same patch must release its space before restorations.
    const remaining = current.filter(item => !item.id.startsWith('widget:') || nextIds.has(item.id))
    const restored = restoreDesktopWidgets(remaining, added, layout, viewport)
    if (restored.length) plan.restore.push({ viewport, placements: restored })
    for (const item of restored) {
      const saved = layout[viewport][item.id]
      if (saved && (saved.col !== item.col || saved.row !== item.row)) plan.relocated.push({ id: item.id, viewport })
    }
  }
  return plan.freeze.length || plan.restore.length ? plan : null
}
