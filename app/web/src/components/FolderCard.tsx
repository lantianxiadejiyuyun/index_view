import { useEffect, useState, type CSSProperties } from 'react'
import { ChevronRight, Folder as FolderIcon, Settings2 } from 'lucide-react'
import { faviconUrl } from '../lib/api.ts'
import { emojiOf, initialOf, letterGradient } from '../lib/icon.ts'
import { luminance } from '../lib/visual.ts'
import type { Folder, Site } from '../lib/types.ts'

type Props = {
  folder: Folder
  sites: Site[]
  editMode: boolean
  onOpen: () => void
  onEdit: () => void
  isOver?: boolean
  /** Visible grid span; the saved width is retained when the viewport is narrower. */
  displayColumns?: number
}

/** A small icon shared by folder previews and the folder membership picker. */
export function FolderSiteIcon({ site }: { site: Site }) {
  const custom = site.icon_url?.trim()
  const src = custom || faviconUrl(site)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const emoji = emojiOf(site.title)
  if (emoji && !custom) return <span className="folder-site-icon folder-site-emoji" aria-hidden>{emoji}</span>
  if (src && !failed) {
    return <img className="folder-site-icon folder-site-image" src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
  }
  const text = site.icon_text?.trim() || initialOf(site.title)
  return (
    <span
      className="folder-site-icon folder-site-letter"
      style={{
        background: site.color || letterGradient(site.title),
        color: site.color && luminance(site.color) > 0.55 ? '#0f172a' : '#fff',
        fontSize: `calc(var(--folder-icon-size, 32px) * ${Math.min(0.46, 0.86 / Array.from(text).length)})`,
      }}
      aria-hidden
    >{text}</span>
  )
}

export function FolderCard({ folder, sites, editMode, onOpen, onEdit, isOver = false, displayColumns }: Props) {
  const configuredColumns = Number.isSafeInteger(folder.columns) && folder.columns > 0 ? folder.columns : 1
  const visibleColumns = displayColumns ?? configuredColumns
  const columns = Number.isSafeInteger(visibleColumns) && visibleColumns > 0 ? Math.min(visibleColumns, configuredColumns) : configuredColumns
  const rows = Number.isSafeInteger(folder.rows) && folder.rows > 0 ? folder.rows : 1
  const previewColumns = columns === 1 ? 2 : rows === 1 ? Math.min(columns * 2, 6) : Math.min(columns + 1, 6)
  // Size is unrestricted, but rendering the preview must stay constant-cost.
  const limit = Math.min(24, previewColumns * (rows === 1 && columns > 1 ? 1 : Math.min(rows + 1, 4)))
  const overflow = sites.length > limit
  const visible = sites.slice(0, overflow ? limit - 1 : limit)
  const accent = folder.color || 'rgb(var(--accent-rgb))'

  return (
    <div
      className={`folder-card${editMode ? ' folder-card-editing' : ''}${isOver ? ' folder-card-over' : ''}`}
      data-columns={columns}
      data-rows={rows}
      data-configured-columns={configuredColumns}
      style={{ '--folder-accent': accent, '--folder-preview-columns': previewColumns } as CSSProperties}
    >
      <button
        type="button"
        className="folder-card-button glass"
        onClick={onOpen}
        aria-label={`打开文件夹 ${folder.name}，${sites.length} 个图标`}
        title={`${folder.name} · ${sites.length} 个图标`}
      >
        <span className="folder-card-heading">
          <FolderIcon className="folder-card-symbol" size={16} aria-hidden />
          <span className="folder-card-title">{folder.name}</span>
        </span>
        {sites.length > 0 ? (
          <span className="folder-card-preview" aria-hidden>
            {visible.map((site) => (
              <span className="folder-preview-item" key={site.id}>
                <FolderSiteIcon site={site} />
                {rows > 1 && columns > 1 && <span className="folder-preview-title">{site.title}</span>}
              </span>
            ))}
            {overflow && <span className="folder-preview-item"><span className="folder-preview-more">+{sites.length - visible.length}</span></span>}
          </span>
        ) : (
          <span className="folder-card-empty" aria-hidden><FolderIcon /><span>空文件夹</span></span>
        )}
        <span className="folder-card-footer"><span>{isOver ? '松开移入' : `${sites.length} 个图标`}</span><ChevronRight size={12} aria-hidden /></span>
      </button>
      {editMode && (
        <button
          type="button"
          className="folder-card-settings"
          aria-label={`设置文件夹 ${folder.name}`}
          title="设置名称、尺寸和内容"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onEdit() }}
        ><Settings2 size={14} aria-hidden /></button>
      )}
    </div>
  )
}
