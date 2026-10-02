import { sql } from './db.js'

export interface FolderRow {
  id: number
  name: string
  category_id: number | null
  columns: number
  rows: number
  color: string | null
  sort_order: number
}

export class NavigationInputError extends Error {}

export function referenceId(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null
  const id = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(id) || id < 1) throw new NavigationInputError(`${label}无效`)
  return id
}

export function categoryReference(value: unknown): number | null {
  const id = referenceId(value, '分组 ID')
  if (id !== null && !sql.get('SELECT id FROM categories WHERE id = ?', id)) {
    throw new NavigationInputError('分组不存在，请刷新后重试')
  }
  return id
}

export function folderDimensions(columns: unknown, rows: unknown): { columns: number; rows: number } {
  if (typeof columns !== 'number' || !Number.isSafeInteger(columns) || columns < 1 ||
      typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 1) {
    throw new NavigationInputError('文件夹列数和行数必须为有效的正整数')
  }
  return { columns, rows }
}

export function folderColor(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) {
    throw new NavigationInputError('文件夹颜色必须为六位十六进制颜色')
  }
  return value
}

/** A folder's group is authoritative; a direct group move unwraps its member. */
export function siteLocation(
  body: Record<string, unknown>,
  existing?: { category_id: unknown; folder_id: unknown },
): { categoryId: number | null; folderId: number | null } {
  const categoryId = categoryReference(body.category_id === undefined ? existing?.category_id : body.category_id)
  const folderId = referenceId(body.folder_id === undefined ? existing?.folder_id : body.folder_id, '文件夹 ID')
  if (folderId === null) return { categoryId, folderId }
  const folder = sql.get<FolderRow>('SELECT * FROM folders WHERE id = ?', folderId)
  if (!folder) throw new NavigationInputError('文件夹不存在，请刷新后重试')
  if (body.folder_id === undefined && body.category_id !== undefined && categoryId !== folder.category_id) {
    return { categoryId, folderId: null }
  }
  return { categoryId: folder.category_id, folderId }
}

export function allSites() {
  return sql.all(`SELECT id, category_id, folder_id, title, description, url_public, url_lan, lan_port,
    link_mode, icon_url, icon_text, color, source, sort_order, clicks
    FROM sites ORDER BY sort_order, id`)
}

export function allFolders(): FolderRow[] {
  return sql.all<FolderRow>('SELECT id, name, category_id, columns, rows, color, sort_order FROM folders ORDER BY sort_order, id')
}
