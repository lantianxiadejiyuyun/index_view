import { useRef, useState } from 'react'
import { Bookmark, ChevronDown, ChevronRight, Loader2, Trash2, TriangleAlert, Upload } from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import { useApp } from '../../store/app.ts'
import { toast } from '../../store/toast.ts'
import { btnDanger, btnGhost, btnPrimary } from '../Modal.tsx'
import { BulkSiteDeleteModal } from '../BulkSiteDelete.tsx'
import { LoginRequired, Note, Segmented } from './controls.tsx'
import { SettingsSection } from './Section.tsx'

type BookmarkItem = {
  title: string
  url: string
  icon_url?: string | null
}

type BookmarkGroup = {
  name: string
  count: number
  sites: BookmarkItem[]
}

type BookmarkPreview = {
  categories: BookmarkGroup[]
  total: number
}

type ImportMode = 'merge' | 'replace'

const MODE_OPTIONS: { value: ImportMode; label: string }[] = [
  { value: 'merge', label: '合并（保留现有）' },
  { value: 'replace', label: '替换（清空后导入）' },
]

export function BookmarkSection() {
  const canEdit = useApp((s) => s.canEdit)
  const siteCount = useApp((s) => s.sites.length)
  const fileRef = useRef<HTMLInputElement>(null)
  const operation = useRef(false)

  const [preview, setPreview] = useState<BookmarkPreview | null>(null)
  const [fileName, setFileName] = useState('')
  const [mode, setMode] = useState<ImportMode>('merge')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [parsing, setParsing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteMode, setDeleteMode] = useState<'selected' | 'all' | null>(null)
  const disabled = parsing || committing || deleteMode !== null

  function reset() {
    setPreview(null)
    setFileName('')
    setExpanded(null)
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function previewFile(selected: File) {
    if (operation.current || deleteMode !== null) return
    operation.current = true
    setParsing(true)
    setError(null)
    setPreview(null)
    try {
      const body = new FormData()
      body.append('file', selected)
      // preview 只在服务端解析，不写库；确认后才会走 commit
      const res = await api<BookmarkPreview>('/api/import/bookmarks/preview', {
        method: 'POST',
        body,
      })
      setPreview(res)
      setFileName(selected.name)
      toast.success(`解析到 ${res.total} 个书签`)
    } catch (err) {
      setError(errorMessage(err, '解析失败'))
      toast.error(errorMessage(err, '解析失败'))
    } finally {
      operation.current = false
      setParsing(false)
      // 清空 input，同一个文件改完再选也能重新触发 change
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function commit() {
    if (!preview || operation.current || deleteMode !== null) return

    if (mode === 'replace') {
      const ok = window.confirm(
        '「替换」会先删除现有的全部分组和图标，再导入书签内容。\n\n这个操作不可撤销，确定继续吗？',
      )
      if (!ok) return
    }

    operation.current = true
    setCommitting(true)
    try {
      const res = await api<{ ok: boolean; categories: number; sites: number }>(
        '/api/import/bookmarks/commit',
        { method: 'POST', body: JSON.stringify({ categories: preview.categories, mode }) },
      )
      await useApp.getState().bootstrap()
      toast.success(`已导入 ${res.categories} 个分组、${res.sites} 个图标`)
      reset()
    } catch (err) {
      toast.error(errorMessage(err, '导入失败'))
    } finally {
      operation.current = false
      setCommitting(false)
    }
  }

  return (
    <SettingsSection
      id="bookmarks"
      description="导入浏览器书签，或批量清理导航图标"
    >
      {!canEdit ? (
        <LoginRequired>书签导入与图标清理需要管理员登录后才能使用</LoginRequired>
      ) : (
        <>
          <Note tone="info" icon={Bookmark}>
            在浏览器里导出书签（Chrome：书签管理器 → 右上角 ⋮ → 导出书签），
            选那个 <span className="font-mono">bookmarks.html</span> 即可，
            分组结构会原样保留。
          </Note>

          <input
            ref={fileRef}
            type="file"
            disabled={disabled}
            accept="text/html,.html,.htm"
            className="hidden"
            onChange={(e) => {
              const selected = e.target.files?.[0]
              if (selected) void previewFile(selected)
            }}
          />
          <button
            type="button"
            className={`${btnGhost} flex w-full items-center justify-center gap-1.5 sm:w-auto`}
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            {parsing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Upload className="size-3.5" aria-hidden />
            )}
            {parsing ? '解析中…' : '选择 bookmarks.html'}
          </button>

          {error && <Note tone="danger">{error}</Note>}

          {preview && (
            <div className="animate-pop space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line/10 bg-line/10 px-3 py-2.5 text-[11px] text-fg/60">
                <span className="truncate text-fg/80">{fileName}</span>
                <span>分组 {preview.categories.length} 个</span>
                <span>书签 {preview.total} 个</span>
              </div>

              <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
                {preview.categories.map((group, index) => {
                  const open = expanded === index
                  return (
                    <li key={`${group.name}-${index}`} className="rounded-xl border border-line/10 bg-line/5">
                      <button
                        type="button"
                        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : index)}
                      >
                        {open ? (
                          <ChevronDown className="size-4 shrink-0 text-fg/45" aria-hidden />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-fg/45" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm text-fg/85">
                          {group.name}
                        </span>
                        <span className="shrink-0 text-[11px] text-fg/45">{group.count} 个</span>
                      </button>

                      {open && (
                        <ul className="space-y-1 border-t border-line/10 px-3 py-2">
                          {group.sites.map((site, siteIndex) => (
                            <li key={`${site.url}-${siteIndex}`} className="min-w-0">
                              <p className="truncate text-xs text-fg/75">{site.title}</p>
                              <p className="truncate font-mono text-[10px] text-fg/40">{site.url}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>

              <fieldset disabled={disabled}><Segmented label="导入方式" value={mode} options={MODE_OPTIONS} onChange={setMode} /></fieldset>

              {mode === 'replace' && (
                <Note tone="danger" icon={TriangleAlert}>
                  「替换」会<strong className="font-semibold">先清空现有全部分组与图标</strong>
                  ，再导入这些书签，且无法撤销。
                </Note>
              )}

              <div className="flex justify-end gap-2">
                <button type="button" className={btnGhost} disabled={disabled} onClick={reset}>
                  取消
                </button>
                <button
                  type="button"
                  className={`${btnPrimary} flex items-center gap-1.5`}
                  disabled={disabled}
                  onClick={() => void commit()}
                >
                  {committing && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                  确认导入 {preview.total} 个
                </button>
              </div>
            </div>
          )}
          <div className="space-y-3 border-t border-line/15 pt-5">
            <div>
              <h3 className="text-sm font-semibold text-fg">清理图标</h3>
              <p className="mt-1 text-xs leading-relaxed text-fg/55">当前共有 {siteCount} 个图标。删除图标会保留文件夹、分组、壁纸和其他设置。</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" className={btnGhost} disabled={disabled || siteCount === 0} onClick={() => { if (!operation.current) setDeleteMode('selected') }}>批量选择删除</button>
              <button type="button" className={`${btnDanger} inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50`} disabled={disabled || siteCount === 0} onClick={() => { if (!operation.current) setDeleteMode('all') }}><Trash2 className="size-4" aria-hidden />删除所有图标</button>
            </div>
            <p className="text-xs leading-relaxed text-fg/50">删除前会展示清单并要求确认；删除所有图标还需输入确认文字。此操作无法撤销，可先导出数据备份。</p>
          </div>
          <BulkSiteDeleteModal open={deleteMode !== null} all={deleteMode === 'all'} onClose={() => setDeleteMode(null)} />
        </>
      )}
    </SettingsSection>
  )
}
