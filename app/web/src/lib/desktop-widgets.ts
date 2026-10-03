export type WidgetDimensions = { width: number; height: number }
export type WidgetSizePreset = WidgetDimensions & { label: string }

export const widgetLabels: Record<string, string> = {
  clock: '时钟', search: '搜索', weather: '天气', quote: '每日一句', workbench: '工作台', calendar: '日历',
  'lingxi-calendar': '灵犀日历', 'lingxi-schedule': '日程与待办', 'lingxi-deadline': '截止倒计时', 'lingxi-chat': '灵犀 AI',
}

type Sizes = [number, number][]
const catalog: Record<string, { wide: Sizes; compact: Sizes }> = {
  clock: { wide: [[2, 1], [3, 2], [4, 2]], compact: [[2, 1], [4, 2], [4, 3]] },
  search: { wide: [[3, 1], [5, 1], [8, 1]], compact: [[2, 1], [4, 1], [4, 2]] },
  weather: { wide: [[2, 1], [4, 2], [5, 2]], compact: [[2, 1], [4, 2], [4, 3]] },
  quote: { wide: [[3, 1], [5, 1], [5, 2]], compact: [[2, 2], [4, 1], [4, 2]] },
  workbench: { wide: [[2, 1], [3, 1], [4, 2]], compact: [[2, 1], [4, 1], [4, 2]] },
  calendar: { wide: [[3, 2], [4, 2], [5, 3]], compact: [[3, 2], [4, 2], [4, 3]] },
  'lingxi-calendar': { wide: [[3, 3], [4, 4], [6, 5]], compact: [[3, 3], [4, 4], [4, 5]] },
  'lingxi-schedule': { wide: [[3, 3], [4, 4], [6, 5]], compact: [[3, 3], [4, 4], [4, 5]] },
  'lingxi-deadline': { wide: [[2, 2], [3, 2], [4, 3]], compact: [[2, 2], [4, 2], [4, 3]] },
  'lingxi-chat': { wide: [[4, 3], [5, 4], [7, 5]], compact: [[3, 3], [4, 4], [4, 5]] },
}

export function widgetSizePresets(name: string, viewport: 'wide' | 'compact'): WidgetSizePreset[] {
  return (catalog[name]?.[viewport] ?? []).map(([width, height], index) => ({ width: width!, height: height!, label: ['小号', '标准', '大号'][index]! }))
}

export function validWidgetSize(size: Partial<WidgetDimensions> | undefined, columns: number): size is WidgetDimensions {
  return !!size && Number.isInteger(size.width) && size.width! >= 1 && size.width! <= columns && Number.isInteger(size.height) && size.height! >= 1 && size.height! <= 6
}

/** The middle preset matches existing layouts, including full-width mobile widgets. */
export function widgetSize(name: string, viewport: 'wide' | 'compact', saved?: Partial<WidgetDimensions>): WidgetDimensions {
  if (validWidgetSize(saved, viewport === 'wide' ? 12 : 4)) return { width: saved.width, height: saved.height }
  const preset = widgetSizePresets(name, viewport)[1]
  return preset ? { width: preset.width, height: preset.height } : { width: 1, height: 1 }
}
