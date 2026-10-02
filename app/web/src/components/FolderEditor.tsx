import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Check, Folder as FolderIcon, Loader2, Search, Trash2 } from 'lucide-react'
import type { Folder } from '../lib/types.ts'
import { errorMessage } from '../lib/api.ts'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { FolderSiteIcon } from './FolderCard.tsx'
import { Modal, btnGhost, btnPrimary, fieldClass, labelClass } from './Modal.tsx'

type Props = { open: boolean; folder: Folder | null; defaultCategoryId: number | null; onClose: () => void }
const SIZES = [{ columns: 1, rows: 1 }, { columns: 2, rows: 1 }, { columns: 2, rows: 2 }, { columns: 3, rows: 2 }, { columns: 4, rows: 2 }]
const COLORS = ['#0284c7', '#6366f1', '#8b5cf6', '#db2777', '#ea580c', '#ca8a04', '#16a34a', '#0d9488']

export function FolderEditorModal({ open, folder, defaultCategoryId, onClose }: Props) {
  const categories = useApp((state) => state.categories)
  const folders = useApp((state) => state.folders)
  const sites = useApp((state) => state.sites)
  const createFolder = useApp((state) => state.createFolder)
  const updateFolder = useApp((state) => state.updateFolder)
  const deleteFolder = useApp((state) => state.deleteFolder)
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [columns, setColumns] = useState(2)
  const [rows, setRows] = useState(2)
  const [color, setColor] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(folder?.name ?? '')
    const category = folder ? folder.category_id : defaultCategoryId
    setCategoryId(category === null ? '' : String(category))
    setColumns(folder?.columns ?? 2)
    setRows(folder?.rows ?? 2)
    setColor(folder?.color ?? '')
    setSelected(new Set(folder ? useApp.getState().sites.filter((site) => site.folder_id === folder.id).map((site) => site.id) : []))
    setQuery('')
  }, [open, folder, defaultCategoryId])

  const visibleSites = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return sites.filter((site) => !needle || `${site.title} ${site.description ?? ''} ${site.url_public ?? ''} ${site.url_lan ?? ''}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(b.folder_id === folder?.id) - Number(a.folder_id === folder?.id) || a.sort_order - b.sort_order || a.id - b.id)
  }, [sites, query, folder?.id])

  function toggle(id: number) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit() {
    if (saving) return
    if (!name.trim()) { toast.error('请填写文件夹名称'); return }
    const payload = { name: name.trim(), category_id: categoryId ? Number(categoryId) : null, columns, rows, color: color || null, site_ids: [...selected] }
    setSaving(true)
    try {
      if (folder) await updateFolder(folder.id, payload)
      else await createFolder(payload)
      toast.success(folder ? '文件夹已保存' : '文件夹已创建')
      onClose()
    } catch (error) { toast.error(errorMessage(error, '保存文件夹失败')) }
    finally { setSaving(false) }
  }

  async function remove() {
    if (!folder || saving || !window.confirm(`删除文件夹「${folder.name}」？里面的图标会移回当前分组，不会删除图标。`)) return
    setSaving(true)
    try { await deleteFolder(folder.id); toast.success('文件夹已移除，图标已保留'); onClose() }
    catch (error) { toast.error(errorMessage(error, '删除文件夹失败')) }
    finally { setSaving(false) }
  }

  return (
    <Modal open={open} title={folder ? '编辑文件夹' : '新建文件夹'} size="wide" onClose={() => { if (!saving) onClose() }} footer={
      <>
        {folder && <button type="button" className="mr-auto min-h-11 rounded-xl px-2 text-sm text-danger disabled:opacity-50" onClick={() => void remove()} disabled={saving}><Trash2 size={14} className="mr-1 inline" aria-hidden />删除文件夹</button>}
        <button type="button" className={btnGhost} onClick={onClose} disabled={saving}>取消</button>
        <button type="button" className={btnPrimary} onClick={() => void submit()} disabled={saving}>{saving && <Loader2 size={14} className="mr-1.5 inline animate-spin" aria-hidden />}{folder ? '保存文件夹' : '创建文件夹'}</button>
      </>
    }>
      <div className="folder-editor">
        <div className="folder-editor-intro" style={{ '--folder-accent': color || 'rgb(var(--accent-rgb))' } as CSSProperties}>
          <span className="folder-editor-emblem"><FolderIcon size={28} aria-hidden /></span>
          <div><strong>{name.trim() || '把常用放在一起'}</strong><p>{columns} × {rows} 尺寸 · 已选 {selected.size} 个图标</p></div>
          <span className="folder-size-visual" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }} aria-hidden>{Array.from({ length: columns * rows }, (_, index) => <i key={index} />)}</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label htmlFor="folder-name" className={labelClass}>文件夹名称</label><input id="folder-name" className={fieldClass} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="例如：每日工作、影音娱乐" autoFocus disabled={saving} /></div>
          <div><label htmlFor="folder-category" className={labelClass}>所属分组</label><select id="folder-category" className={fieldClass} value={categoryId} onChange={(event) => setCategoryId(event.target.value)} disabled={saving}><option value="">未分组</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>
        </div>
        <fieldset disabled={saving}>
          <legend className={labelClass}>文件夹尺寸</legend>
          <div className="folder-size-presets">
            {SIZES.map((size) => <button key={`${size.columns}-${size.rows}`} type="button" className="folder-size-preset" aria-pressed={columns === size.columns && rows === size.rows} onClick={() => { setColumns(size.columns); setRows(size.rows) }}><span className="folder-size-diagram" style={{ gridTemplateColumns: `repeat(${size.columns}, 1fr)` }} aria-hidden>{Array.from({ length: size.columns * size.rows }, (_, index) => <i key={index} />)}</span><span>{size.columns} × {size.rows}</span></button>)}
          </div>
          <div className="folder-custom-size">
            <label htmlFor="folder-columns">自定义宽度<select id="folder-columns" className={fieldClass} value={columns} onChange={(event) => setColumns(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option value={value} key={value}>{value} 列</option>)}</select></label>
            <label htmlFor="folder-rows">自定义高度<select id="folder-rows" className={fieldClass} value={rows} onChange={(event) => setRows(Number(event.target.value))}>{[1, 2, 3].map((value) => <option value={value} key={value}>{value} 行</option>)}</select></label>
          </div>
          <p className="folder-field-note">以首页图标格子为单位，手机端保留 4 列布局；点击文件夹可查看全部内容。</p>
        </fieldset>
        <fieldset disabled={saving}>
          <legend className={labelClass}>点缀颜色</legend>
          <div className="folder-color-options">
            <button type="button" className="folder-color-auto" aria-pressed={!color} onClick={() => setColor('')}>跟随主题</button>
            {COLORS.map((value) => <button key={value} type="button" className="folder-color-swatch" style={{ background: value }} aria-label={`颜色 ${value}`} aria-pressed={color === value} onClick={() => setColor(value)}>{color === value && <Check size={15} aria-hidden />}</button>)}
            <label className="folder-custom-color" title="自定义颜色"><input type="color" aria-label="自定义文件夹颜色" value={color || '#0284c7'} onChange={(event) => setColor(event.target.value)} /><span>自选</span></label>
          </div>
        </fieldset>
        <fieldset disabled={saving}>
          <legend className={labelClass}>收纳图标 <span className="text-fg/40">· 已选 {selected.size} 个</span></legend>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-fg/40" aria-hidden /><input type="search" className={`${fieldClass} pl-9`} aria-label="搜索可收纳的图标" placeholder="搜索名称或地址" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="folder-selection-toolbar"><span>{visibleSites.length} 个可选图标</span><button type="button" onClick={() => setSelected((previous) => new Set([...previous, ...visibleSites.map((site) => site.id)]))} disabled={!visibleSites.length}>选择搜索结果</button><button type="button" onClick={() => setSelected(new Set())} disabled={!selected.size}>清空选择</button></div>
          <div className="folder-members" role="group" aria-label="文件夹图标选择">
            {visibleSites.map((site) => {
              const currentFolder = folders.find((item) => item.id === site.folder_id)
              const category = categories.find((item) => item.id === site.category_id)
              return <label className="folder-member" key={site.id} data-selected={selected.has(site.id)}><input type="checkbox" checked={selected.has(site.id)} onChange={() => toggle(site.id)} /><FolderSiteIcon site={site} /><span><strong>{site.title}</strong><small>{currentFolder ? `文件夹：${currentFolder.name}` : category?.name || '未分组'}{currentFolder && currentFolder.id !== folder?.id && selected.has(site.id) ? ' · 将移入' : ''}</small></span></label>
            })}
            {!visibleSites.length && <p className="folder-members-empty">{sites.length ? '没有匹配的图标' : '还没有图标，可先创建文件夹，再添加内容。'}</p>}
          </div>
          <p className="folder-field-note">选中的图标会移入此文件夹并跟随所属分组。取消勾选的原有图标会移回分组。</p>
        </fieldset>
      </div>
    </Modal>
  )
}
