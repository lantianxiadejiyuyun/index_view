import { useState, type CSSProperties } from 'react'
import { Folder as FolderIcon, FolderOutput, Pencil, Plus, Settings2 } from 'lucide-react'
import type { Folder, Site } from '../lib/types.ts'
import { errorMessage } from '../lib/api.ts'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { Modal, btnGhost, btnPrimary } from './Modal.tsx'
import { SiteCard } from './SiteCard.tsx'

type Props = {
  open: boolean
  folder: Folder | null
  sites: Site[]
  onClose: () => void
  onOpenSite: (site: Site) => void
  onEditSite: (site: Site, categoryId: number | null) => void
  onAddSite: (categoryId: number | null, folderId?: number) => void
  onEditFolder: () => void
}

export function FolderContentsModal({ open, folder, sites, onClose, onOpenSite, onEditSite, onAddSite, onEditFolder }: Props) {
  const editMode = useApp((state) => state.editMode)
  const cardSize = useApp((state) => state.settings.card_size)
  const netMode = useApp((state) => state.netMode)
  const updateSite = useApp((state) => state.updateSite)
  const [removing, setRemoving] = useState<number | null>(null)
  if (!folder) return null

  async function detach(site: Site) {
    if (removing !== null) return
    setRemoving(site.id)
    try { await updateSite(site.id, { folder_id: null }); toast.success(`「${site.title}」已移回分组`) }
    catch (error) { toast.error(errorMessage(error, '移出文件夹失败')) }
    finally { setRemoving(null) }
  }

  return (
    <Modal open={open} title={folder.name} onClose={onClose} size="wide" footer={editMode ? <><button className={`${btnGhost} mr-auto`} type="button" onClick={() => { onClose(); onEditFolder() }}><Settings2 size={14} className="mr-1.5 inline" aria-hidden />管理文件夹</button><button className={btnPrimary} type="button" onClick={() => { onClose(); onAddSite(folder.category_id, folder.id) }}><Plus size={15} className="mr-1 inline" aria-hidden />添加图标</button></> : undefined}>
      <div className="folder-contents-summary" style={{ '--folder-accent': folder.color || 'rgb(var(--accent-rgb))' } as CSSProperties}><FolderIcon size={18} aria-hidden /><span>{sites.length} 个图标</span><span>{editMode ? '编辑内容，或将图标移回分组' : '常用内容，触手可及'}</span></div>
      {sites.length > 0 ? <div className="folder-contents-grid">{sites.map((site) => <div className="folder-contents-item" key={site.id}>
        <SiteCard site={site} size={cardSize} netMode={netMode} editMode={false} onOpen={() => onOpenSite(site)} onEdit={() => { onClose(); onEditSite(site, site.category_id) }} onDelete={() => void detach(site)} />
        {editMode && <div className="folder-contents-actions"><button type="button" aria-label={`编辑 ${site.title}`} title="编辑图标" onClick={() => { onClose(); onEditSite(site, site.category_id) }}><Pencil size={14} aria-hidden /><span>编辑</span></button><button type="button" disabled={removing !== null} aria-label={`将 ${site.title} 移出文件夹`} title="移回分组，保留图标" onClick={() => void detach(site)}><FolderOutput size={14} aria-hidden /><span>{removing === site.id ? '移出中' : '移出'}</span></button></div>}
      </div>)}</div> : <div className="folder-contents-empty"><FolderIcon size={44} strokeWidth={1.3} aria-hidden /><strong>文件夹还是空的</strong><p>{editMode ? '添加新图标，或在「管理文件夹」中选择已有图标。' : '这里收纳的图标会显示在此处。'}</p></div>}
    </Modal>
  )
}
