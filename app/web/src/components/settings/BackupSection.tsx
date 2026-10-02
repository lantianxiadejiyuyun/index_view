import { useRef, useState } from 'react'
import {
  Database,
  Download,
  FileJson,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import { useApp } from '../../store/app.ts'
import { toast } from '../../store/toast.ts'
import { btnGhost, btnPrimary } from '../Modal.tsx'
import { LoginRequired, Note, Segmented } from './controls.tsx'
import { SettingsSection } from './Section.tsx'

type BackupFile = {
  exported_at?: string
  version?: number
  settings?: Record<string, string>
  categories?: unknown[]
  folders?: unknown[]
  sites?: unknown[]
}

type ImportMode = 'merge' | 'replace'

const MODE_OPTIONS: { value: ImportMode; label: string }[] = [
  { value: 'merge', label: '合并（保留现有）' },
  { value: 'replace', label: '替换（清空后导入）' },
]

/** 文件名里的时间戳：本地时区，肉眼能对上「刚才导的那份」 */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function BackupSection() {
  const canEdit = useApp((s) => s.canEdit)
  const fileRef = useRef<HTMLInputElement>(null)

  const [exporting, setExporting] = useState(false)
  const [file, setFile] = useState<{ name: string; data: BackupFile } | null>(null)
  const [mode, setMode] = useState<ImportMode>('merge')
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  async function exportBackup() {
    setExporting(true)
    try {
      // /api/export 带 Content-Disposition，但它同时需要 Authorization 头，
      // 直接用 window.location 跳过去会 401，所以先把数据取回来再在前端造 Blob 下载
      const data = await api<unknown>('/api/export')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `home-dashboard-${stamp()}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      // 立刻 revoke 会让部分浏览器中断下载，等下载启动后再释放
      window.setTimeout(() => URL.revokeObjectURL(url), 5000)
      toast.success('备份已导出')
    } catch (err) {
      toast.error(errorMessage(err, '导出失败'))
    } finally {
      setExporting(false)
    }
  }

  async function pickFile(selected: File) {
    setError(null)
    setFile(null)
    try {
      const value: unknown = JSON.parse(await selected.text())
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        setError('文件内容不是有效的导航备份')
        return
      }
      const parsed = value as BackupFile
      const collections = [parsed.categories, parsed.folders, parsed.sites]
      if (!collections.some(Array.isArray)) {
        setError('文件里没有 categories、folders 或 sites，看起来不是本站导出的备份')
        return
      }
      if (collections.some((items) => items !== undefined && !Array.isArray(items))) {
        setError('备份中的分组、文件夹和图标列表必须是数组')
        return
      }
      setFile({ name: selected.name, data: parsed })
    } catch {
      setError('这个文件不是合法的 JSON')
    }
  }

  async function runImport() {
    if (!file || importing) return

    if (mode === 'replace') {
      const ok = window.confirm(
        '「替换」会先删除现有的全部分组、文件夹和图标，再写入备份里的内容。\n\n这个操作不可撤销，确定继续吗？',
      )
      if (!ok) return
    }

    setImporting(true)
    try {
      await api('/api/import', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          settings: file.data.settings ?? {},
          categories: file.data.categories ?? [],
          folders: file.data.folders ?? [],
          sites: file.data.sites ?? [],
        }),
      })
      // 服务端已经改完库，本地这份 store 还是旧的，必须重新拉一次
      await useApp.getState().bootstrap()
      toast.success(mode === 'replace' ? '已替换导入' : '已合并导入')
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
    } catch (err) {
      toast.error(errorMessage(err, '导入失败'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <SettingsSection id="backup" description="导出或导入全部设置、分组、文件夹与图标">
      {!canEdit ? (
        <LoginRequired>备份与恢复需要管理员登录后才能使用</LoginRequired>
      ) : (
        <>
          <div className="flex flex-col gap-2 rounded-xl border border-line/10 bg-line/5 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm text-fg/90">
                <Download className="size-3.5" aria-hidden />
                导出备份
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-fg/45">
                包含设置、分组、文件夹尺寸与图标收纳关系（不含密码和探针令牌），保存为 JSON 文件。
              </p>
            </div>
            <button
              type="button"
              className={`${btnPrimary} flex shrink-0 items-center justify-center gap-1.5`}
              disabled={exporting}
              onClick={() => void exportBackup()}
            >
              {exporting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Download className="size-3.5" aria-hidden />
              )}
              导出 JSON
            </button>
          </div>

          <div className="space-y-3 rounded-xl border border-line/10 bg-line/5 p-3">
            <p className="flex items-center gap-1.5 text-sm text-fg/90">
              <Upload className="size-3.5" aria-hidden />
              导入备份
            </p>

            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              disabled={importing}
              onChange={(e) => {
                const selected = e.target.files?.[0]
                if (selected) void pickFile(selected)
              }}
            />
            <button
              type="button"
              className={`${btnGhost} flex w-full items-center justify-center gap-1.5 sm:w-auto`}
              disabled={importing}
              onClick={() => fileRef.current?.click()}
            >
              <FileJson className="size-3.5" aria-hidden />
              选择备份文件
            </button>

            {error && <Note tone="danger">{error}</Note>}

            {file && (
              <div className="animate-pop space-y-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line/10 bg-line/10 px-3 py-2.5 text-[11px] text-fg/60">
                  <span className="flex items-center gap-1.5 text-fg/80">
                    <Database className="size-3.5" aria-hidden />
                    {file.name}
                  </span>
                  <span>分组 {file.data.categories?.length ?? 0} 个</span>
                  <span>文件夹 {file.data.folders?.length ?? 0} 个</span>
                  <span>图标 {file.data.sites?.length ?? 0} 个</span>
                  {file.data.exported_at && <span>导出于 {file.data.exported_at}</span>}
                </div>

                <fieldset disabled={importing}>
                <Segmented
                  label="导入方式"
                  value={mode}
                  options={MODE_OPTIONS}
                  onChange={setMode}
                />
                </fieldset>

                {mode === 'replace' ? (
                  <Note tone="danger" icon={TriangleAlert}>
                    「替换」会<strong className="font-semibold">先清空现有全部分组、文件夹与图标</strong>
                    ，再写入这份备份，且无法撤销。导入前建议先导出一份当前数据。
                  </Note>
                ) : (
                  <Note tone="info" icon={RefreshCw}>
                    「合并」会把备份里的分组、文件夹与图标追加到现有数据后面，保留收纳关系，已存在的内容不会被删除。
                  </Note>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={importing}
                    onClick={() => {
                      setFile(null)
                      if (fileRef.current) fileRef.current.value = ''
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className={`${btnPrimary} flex items-center gap-1.5`}
                    disabled={importing}
                    onClick={() => void runImport()}
                  >
                    {importing && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                    开始导入
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  )
}
