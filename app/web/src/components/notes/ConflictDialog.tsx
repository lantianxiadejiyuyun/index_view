import { Loader2 } from 'lucide-react'
import { Modal, btnDanger, btnGhost, btnPrimary } from '../Modal.tsx'
import type { NoteConflict } from './notes-api.ts'
import { formatTime } from './paths.ts'

/**
 * 保存冲突的处置弹窗。
 *
 * 笔记目录可能同时被 VS Code / Typora / 网盘同步改着，后端检测到 mtime 不一致
 * 就返回 409 而不是静默覆盖。这里必须让用户明确选一边：
 * 要么把磁盘版本读回来（丢掉自己刚写的），要么明确表示「就用我的覆盖」。
 * 任何自动选择都会吃掉某一方的改动，所以没有默认动作。
 */
export function ConflictDialog({
  conflict,
  onLoadDisk,
  onOverwrite,
  onCancel,
  busy = false,
}: {
  conflict: NoteConflict | null
  onLoadDisk: () => void
  onOverwrite: () => void
  onCancel: () => void
  busy?: boolean
}) {
  const open = conflict !== null
  const diskPreview = conflict ? conflict.diskContent.slice(0, 1200) : ''
  const diskTruncated = conflict ? conflict.diskContent.length > diskPreview.length : false

  return (
    <Modal
      open={open}
      title={conflict?.missing ? '文件已被外部删除' : '文件已被外部修改'}
      size="wide"
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onCancel} disabled={busy}>
            先不处理
          </button>
          <button type="button" className={btnPrimary} onClick={onLoadDisk} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            放弃我的修改，加载磁盘版本
          </button>
          <button type="button" className={btnDanger} onClick={onOverwrite} disabled={busy}>
            用我的版本覆盖
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm leading-relaxed text-fg/85">
          {conflict?.missing
            ? '保存时发现磁盘上这个文件已经不在了（可能被外部编辑器删除或重命名）。'
            : '保存时发现磁盘上的内容和你打开时不一样（可能被 VS Code / Typora / 网盘同步改过）。'}
        </p>

        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded-xl border border-line/12 bg-line/5 px-3 py-2">
            <p className="text-fg/50">你手上的版本</p>
            <p className="mt-1 text-fg/80">
              {conflict?.missing ? '（本地编辑中，尚未落盘）' : '正在编辑，尚未保存'}
            </p>
          </div>
          <div className="rounded-xl border border-line/12 bg-line/5 px-3 py-2">
            <p className="text-fg/50">磁盘上的版本</p>
            <p className="mt-1 text-fg/80">
              {conflict?.missing
                ? '已不存在'
                : `修改时间 ${formatTime(conflict?.mtime) || '未知'} · ${conflict?.diskContent.length ?? 0} 字`}
            </p>
          </div>
        </div>

        {!conflict?.missing && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg/70">磁盘上的内容（只读预览）</p>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line/12 bg-line/10 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg/70">
              {diskPreview || '（空文件）'}
              {diskTruncated ? '\n…（已截断）' : ''}
            </pre>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-fg/45">
          「用我的版本覆盖」会丢弃磁盘上的改动且不可撤销；「加载磁盘版本」会丢弃你当前未保存的编辑。
        </p>
      </div>
    </Modal>
  )
}
