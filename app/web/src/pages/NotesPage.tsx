import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Columns2,
  Eye,
  FilePlus2,
  FolderPlus,
  Loader2,
  NotebookPen,
  PanelLeft,
  Pencil,
  RefreshCw,
  Save,
  Search,
  X,
} from 'lucide-react'
import { PageShell } from '../components/PageShell.tsx'
import { ConflictDialog } from '../components/notes/ConflictDialog.tsx'
import { ConfirmDialog, PromptDialog } from '../components/notes/Dialogs.tsx'
import { MarkdownPreview } from '../components/notes/MarkdownPreview.tsx'
import { MdEditor } from '../components/notes/MdEditor.tsx'
import { NoteTreeDnd, type NoteDragInfo } from '../components/notes/NoteTree.tsx'
import { SearchDialog } from '../components/notes/SearchDialog.tsx'
import {
  NoteConflictError,
  createNoteDir,
  createNoteFile,
  deleteNote,
  describeError,
  fetchTree,
  moveNote,
  readNoteFile,
  saveNoteFile,
  type NoteConflict,
} from '../components/notes/notes-api.ts'
import {
  ancestorsOf,
  baseName,
  ensureMarkdownExt,
  formatTime,
  normalizeRelPath,
} from '../components/notes/paths.ts'
import type { NoteNode } from '../lib/types.ts'
import { toast } from '../store/toast.ts'

/** 新建笔记时预填的模板：给个能直接上手的骨架，比空白页友好 */
const NEW_NOTE_TEMPLATE = `# 未命名笔记

在这里记录点什么。

- [ ] 待办一
- [ ] 待办二

> 笔记就是一个 \`.md\` 文件，可以用 VS Code / Typora 直接编辑，也能随网盘同步。
`

type ViewMode = 'edit' | 'split' | 'preview'

const MODES: { id: ViewMode; label: string; Icon: typeof Pencil }[] = [
  { id: 'edit', label: '编辑', Icon: Pencil },
  { id: 'split', label: '分栏', Icon: Columns2 },
  { id: 'preview', label: '预览', Icon: Eye },
]

type PromptState = {
  kind: 'new-note' | 'new-dir' | 'rename'
  /** 新建时的预填路径；重命名时是被操作节点的完整路径 */
  initial: string
  /** 重命名 / 移动时的目标节点 */
  node: NoteNode | null
}

/** 深度优先找第一篇笔记，用于进页面时自动打开 */
function firstFilePath(nodes: NoteNode[]): string | null {
  for (const node of nodes) {
    if (node.type === 'file') return node.path
    if (node.children) {
      const inner = firstFilePath(node.children)
      if (inner) return inner
    }
  }
  return null
}

function pathExistsInTree(nodes: NoteNode[], path: string): boolean {
  for (const node of nodes) {
    if (node.path === path) return true
    if (node.children && pathExistsInTree(node.children, path)) return true
  }
  return false
}

/** 文件 / 目录被移动或删除后，把「当前选中的路径」跟着搬到新位置 */
function remapPath(current: string | null, from: string, to: string | null): string | null {
  if (current === null) return null
  if (current === from) return to
  if (current.startsWith(`${from}/`)) {
    return to === null ? null : `${to}${current.slice(from.length)}`
  }
  return current
}

export function NotesPage() {

  // ── 目录树 ──────────────────────────────────────────────────
  const [tree, setTree] = useState<NoteNode[]>([])
  const [root, setRoot] = useState('')
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  // ── 当前文件 ────────────────────────────────────────────────
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [mtime, setMtime] = useState<number | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // ── 界面状态 ────────────────────────────────────────────────
  const [mode, setMode] = useState<ViewMode>(() =>
    // 手机上分栏会把两边都挤成一条缝，默认直接进编辑
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
      ? 'split'
      : 'edit',
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<NoteNode | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [movingPath, setMovingPath] = useState<string | null>(null)
  const [conflict, setConflict] = useState<NoteConflict | null>(null)

  const dirty = content !== savedContent
  const selectedExists = selected === null || pathExistsInTree(tree, selected)

  /**
   * 最新状态的镜像。
   * 编辑器回调、全局快捷键、事件监听都拿不到最新闭包，与其到处传依赖，
   * 不如让它们统一读这个 ref（在每次渲染后同步）。
   */
  const live = useRef({
    content: '',
    saved: '',
    mtime: null as number | null,
    selected: null as string | null,
    dirty: false,
  })
  useEffect(() => {
    live.current = { content, saved: savedContent, mtime, selected, dirty }
  })

  const savingRef = useRef(false)
  const loadSeq = useRef(0)
  const autoOpened = useRef(false)

  // 会话恢复不在这里做：store 的 bootstrap() 已经会用 refresh Cookie 把登录态捞回来
  // （见 store/app.ts 里 silentRestoreTried 那段）。App 在渲染路由之前就等它完成了，
  // 所以走到本组件时 canEdit 已经是最终值，不需要再自己探测一次。

  // ── 目录树读写 ──────────────────────────────────────────────

  const refreshTree = useCallback(async (): Promise<NoteNode[] | null> => {
    try {
      const res = await fetchTree()
      setTree(res.tree)
      setRoot(res.root)
      setTreeError(null)
      return res.tree
    } catch (err) {
      setTreeError(describeError(err, '读取笔记目录失败'))
      return null
    } finally {
      setTreeLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshTree()
  }, [refreshTree])

  // ── 打开文件 ────────────────────────────────────────────────

  const loadFile = useCallback(async (path: string, force = false): Promise<void> => {
    if (!force && path === live.current.selected) return
    // 未保存的改动绝不能因为点了一下别的文件就消失
    if (!force && live.current.dirty && !window.confirm('当前笔记有未保存的修改，放弃并打开另一篇吗？')) {
      return
    }

    const seq = ++loadSeq.current
    setFileLoading(true)
    try {
      const res = await readNoteFile(path)
      // 期间又点了别的文件：丢弃这次结果，避免旧请求把新内容盖掉
      if (seq !== loadSeq.current) return
      setSelected(res.path)
      setContent(res.content)
      setSavedContent(res.content)
      setMtime(res.mtime)
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const dir of ancestorsOf(res.path)) next.add(dir)
        return next
      })
      setDrawerOpen(false)
    } catch (err) {
      if (seq === loadSeq.current) toast.error(describeError(err, '打不开这篇笔记'))
    } finally {
      if (seq === loadSeq.current) setFileLoading(false)
    }
  }, [])

  // 首次拿到目录树时自动打开第一篇，省得进来对着空编辑器发呆
  useEffect(() => {
    if (autoOpened.current || tree.length === 0) return
    const first = firstFilePath(tree)
    if (!first) return
    autoOpened.current = true
    void loadFile(first)
  }, [tree, loadFile])

  // ── 保存 ────────────────────────────────────────────────────

  const handleSave = useCallback(async (force = false): Promise<void> => {
    const { selected: path, content: text, saved, mtime: base } = live.current
    if (!path || savingRef.current) return
    // 没改动就不打后端（Ctrl+S 连按时尤其明显）
    if (!force && text === saved) return

    savingRef.current = true
    setSaving(true)
    try {
      const res = await saveNoteFile(path, text, force ? null : base)
      setMtime(res.mtime)
      // 只把「刚存下去的这一版」记为已保存：保存期间用户可能又敲了字
      setSavedContent(text)
      toast.success('已保存')
    } catch (err) {
      if (err instanceof NoteConflictError) {
        setConflict(err.info)
      } else {
        toast.error(describeError(err, '保存失败'))
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [])

  function resolveConflictByLoadingDisk(): void {
    if (!conflict) return
    setContent(conflict.diskContent)
    setSavedContent(conflict.diskContent)
    setMtime(conflict.missing ? null : conflict.mtime)
    setConflict(null)
    toast.info(conflict.missing ? '磁盘上已没有这个文件，内容已清空' : '已加载磁盘上的版本')
  }

  function resolveConflictByOverwrite(): void {
    setConflict(null)
    void handleSave(true)
  }

  // Ctrl/Cmd+S：编辑器里有焦点时 CodeMirror 自己处理（会 preventDefault），
  // 这里兜住「焦点在预览区 / 工具栏」的情况
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
      if (e.defaultPrevented) return
      e.preventDefault()
      void handleSave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave])

  // 刷新 / 关标签时提醒
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // PageShell 的返回按钮是普通 <Link>，BrowserRouter 下没有 useBlocker 可用，
  // 于是脏状态下在捕获阶段拦一次站内跳转 —— 未保存的内容不能悄悄丢
  useEffect(() => {
    if (!dirty) return
    const onClick = (e: MouseEvent): void => {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null
      const href = anchor?.getAttribute('href')
      if (!href || href.startsWith('http') || href.startsWith('#')) return
      if (href.startsWith('/notes')) return
      if (!window.confirm('当前笔记有未保存的修改，确定离开吗？')) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty])

  // ── 文件操作 ────────────────────────────────────────────────

  function openPrompt(next: PromptState): void {
    // 新建 / 重命名都会把编辑器带走，先把未保存的改动问清楚
    if (next.kind !== 'rename' && dirty && !window.confirm('当前笔记有未保存的修改，仍要继续吗？')) return
    setPrompt(next)
  }

  async function submitPrompt(raw: string): Promise<void> {
    const current = prompt
    if (!current) return

    const normalized = normalizeRelPath(raw)
    if (!normalized.ok) {
      toast.error(normalized.error)
      return
    }

    setDialogBusy(true)
    try {
      if (current.kind === 'new-note') {
        // 允许直接输 `工作/周会`，后端会自动建父目录
        const path = ensureMarkdownExt(normalized.path)
        await createNoteFile(path, NEW_NOTE_TEMPLATE)
        await refreshTree()
        setPrompt(null)
        await loadFile(path, true)
        toast.success('已创建笔记')
      } else if (current.kind === 'new-dir') {
        await createNoteDir(normalized.path)
        await refreshTree()
        setExpanded((prev) => new Set([...prev, ...ancestorsOf(`${normalized.path}/x`), normalized.path]))
        setPrompt(null)
        toast.success('已创建文件夹')
      } else {
        const node = current.node
        if (!node) return
        const target = node.type === 'file' ? ensureMarkdownExt(normalized.path) : normalized.path
        if (target === node.path) {
          setPrompt(null)
          return
        }
        await moveNote(node.path, target)
        await refreshTree()
        // 重命名不改 mtime，所以打开着的文件继续用原 mtime 保存也不会误报冲突
        setSelected((prev) => remapPath(prev, node.path, target))
        setExpanded((prev) => new Set([...prev, ...ancestorsOf(target)]))
        setPrompt(null)
        toast.success('已移动')
      }
    } catch (err) {
      toast.error(describeError(err, '操作失败'))
    } finally {
      setDialogBusy(false)
    }
  }

  async function performDelete(): Promise<void> {
    const node = pendingDelete
    if (!node) return
    // 目录删除是递归的，且 /api/notes/file 的 DELETE 不区分文件与目录，必须再问一次
    if (node.type === 'dir') {
      const again = window.confirm(
        `再次确认：递归删除「${node.name}」及其中的全部内容？\n\n此操作不可撤销。`,
      )
      if (!again) return
    }

    setDeleting(true)
    try {
      await deleteNote(node.path)
      const current = live.current.selected
      if (current !== null && (current === node.path || current.startsWith(`${node.path}/`))) {
        setSelected(null)
        setContent('')
        setSavedContent('')
        setMtime(null)
      }
      setPendingDelete(null)
      await refreshTree()
      toast.success('已删除')
    } catch (err) {
      toast.error(describeError(err, '删除失败'))
    } finally {
      setDeleting(false)
    }
  }

  /**
   * 目录树拖拽移动。
   *
   * 落点（目标目录）由 NoteTreeDnd 判定，这里只负责落地：目标目录 + 原文件名。
   * 重名会被后端 409 拒掉，把它的原话透出来就行 —— 笔记是纯文件，
   * 静默覆盖掉别人正在写的东西没法撤销，所以不做「覆盖」这条路。
   */
  const handleMoveNode = useCallback(
    async (drag: NoteDragInfo, dir: string): Promise<void> => {
      const target = dir === '' ? drag.name : `${dir}/${drag.name}`
      if (target === drag.path) return

      setMovingPath(drag.path)
      try {
        await moveNote(drag.path, target)
        await refreshTree()
        // 打开着的文件若在被搬动的子树里，选中路径跟着搬，编辑中的内容不会丢
        setSelected((prev) => remapPath(prev, drag.path, target))
        setExpanded((prev) => {
          const next = new Set<string>()
          for (const path of prev) {
            const moved = remapPath(path, drag.path, target)
            if (moved !== null) next.add(moved)
          }
          // 目标目录要展开，否则用户看不出东西搬到哪去了
          for (const ancestor of ancestorsOf(target)) next.add(ancestor)
          if (dir !== '') next.add(dir)
          return next
        })
        toast.success(dir === '' ? `已移到根目录：${drag.name}` : `已移到「${dir}」`)
      } catch (err) {
        toast.error(describeError(err, '移动失败'))
      } finally {
        setMovingPath(null)
      }
    },
    [refreshTree],
  )

  /** 从磁盘重新读一遍：外部编辑器（VS Code / Typora / 网盘）改完就用它拉回来 */
  async function reloadFromDisk(): Promise<void> {
    await refreshTree()
    const path = live.current.selected
    if (!path) {
      toast.success('目录已刷新')
      return
    }
    if (live.current.dirty && !window.confirm('当前有未保存的修改，重新加载会丢掉它们。继续吗？')) return
    await loadFile(path, true)
    toast.success('已从磁盘重新加载')
  }

  const toggleDir = useCallback((path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // 移动端抽屉的 Esc 关闭
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  // 分栏模式：编辑器滚动比例推给预览区（尽力而为的同步滚动）
  const previewRef = useRef<HTMLDivElement>(null)
  const syncFrame = useRef(0)
  const handleScrollRatio = useCallback((ratio: number): void => {
    if (syncFrame.current !== 0) return
    syncFrame.current = requestAnimationFrame(() => {
      syncFrame.current = 0
      const el = previewRef.current
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = max > 0 ? ratio * max : 0
    })
  }, [])
  useEffect(() => {
    return () => {
      if (syncFrame.current !== 0) cancelAnimationFrame(syncFrame.current)
    }
  }, [])

  const treeStatusText = treeError
    ? null
    : treeLoading && tree.length === 0
      ? null
      : `${tree.length} 个顶层条目`

  const fileHint = !selectedExists
    ? '磁盘上已找不到这个文件，保存会重新创建它'
    : dirty
      ? '已修改，未保存 · Ctrl/Cmd+S 保存'
      : mtime
        ? `已保存 · ${formatTime(mtime)} · ${content.length} 字`
        : '尚未写入磁盘'

  /** 侧栏 / 抽屉共用的目录内容，避免两处各写一遍 */
  const treeBody = (
    <>
      {treeLoading && tree.length === 0 && (
        <div className="space-y-1.5 p-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-6 animate-pulse rounded-lg bg-line/8" />
          ))}
        </div>
      )}

      {!treeLoading && treeError && (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <p className="text-xs leading-relaxed text-danger">{treeError}</p>
          <button
            type="button"
            onClick={() => void refreshTree()}
            className="rounded-xl border border-line/15 px-3 py-1.5 text-xs text-fg/80 transition hover:bg-line/10"
          >
            重试
          </button>
        </div>
      )}

      {!treeLoading && !treeError && tree.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <NotebookPen className="size-6 text-fg/25" aria-hidden />
          <p className="text-xs text-fg/60">这里还没有任何笔记</p>
          <p className="text-[11px] leading-relaxed text-fg/35">
            直接写几个 <code className="font-mono">.md</code> 文件也可以，
            刷新一下就会出现在这里。
          </p>
          <button
            type="button"
            onClick={() => openPrompt({ kind: 'new-note', initial: '未命名.md', node: null })}
            className="mt-1 rounded-xl bg-brand-500 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-brand-600"
          >
            创建第一篇笔记
          </button>
        </div>
      )}

      {tree.length > 0 && (
        <NoteTreeDnd
          nodes={tree}
          selectedPath={selected}
          expanded={expanded}
          onToggleDir={toggleDir}
          onSelectFile={(path) => void loadFile(path)}
          onRename={(node) => openPrompt({ kind: 'rename', initial: node.path, node })}
          onDelete={(node) => setPendingDelete(node)}
          onNewNoteIn={(dir) => openPrompt({ kind: 'new-note', initial: `${dir}/未命名.md`, node: null })}
          onMove={(drag, dir) => void handleMoveNode(drag, dir)}
          busyPath={movingPath}
        />
      )}
    </>
  )

  const sidebarHeader = (
    <div className="flex shrink-0 items-center gap-1 border-b border-line/10 px-2 py-2">
      <span className="min-w-0 flex-1 truncate px-1 text-[11px] font-medium tracking-wide text-fg/45">
        {treeStatusText ?? '笔记目录'}
      </span>
      <button
        type="button"
        title="新建笔记"
        aria-label="新建笔记"
        onClick={() => openPrompt({ kind: 'new-note', initial: '未命名.md', node: null })}
        className="rounded-lg p-1.5 text-fg/60 transition hover:bg-line/15 hover:text-fg"
      >
        <FilePlus2 className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        title="新建文件夹"
        aria-label="新建文件夹"
        onClick={() => openPrompt({ kind: 'new-dir', initial: '新文件夹', node: null })}
        className="rounded-lg p-1.5 text-fg/60 transition hover:bg-line/15 hover:text-fg"
      >
        <FolderPlus className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        title="从磁盘刷新目录"
        aria-label="从磁盘刷新目录"
        onClick={() => void reloadFromDisk()}
        className="rounded-lg p-1.5 text-fg/60 transition hover:bg-line/15 hover:text-fg"
      >
        <RefreshCw className={`size-3.5 ${treeLoading ? 'animate-spin' : ''}`} aria-hidden />
      </button>
    </div>
  )

  return (
    <PageShell
      title="笔记"
      description={root ? `Markdown 文件夹 · ${root}` : 'Markdown 文件，独立文件夹存储'}
      wide
      actions={
        <div className="glass flex items-center gap-0.5 rounded-2xl p-1">
          <button
            type="button"
            title="新建笔记"
            aria-label="新建笔记"
            onClick={() => openPrompt({ kind: 'new-note', initial: '未命名.md', node: null })}
            className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
          >
            <FilePlus2 className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            title="新建文件夹"
            aria-label="新建文件夹"
            onClick={() => openPrompt({ kind: 'new-dir', initial: '新文件夹', node: null })}
            className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
          >
            <FolderPlus className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            title="搜索笔记"
            aria-label="搜索笔记"
            onClick={() => setSearchOpen(true)}
            className="rounded-xl p-2 text-fg/75 transition hover:bg-line/15 hover:text-fg"
          >
            <Search className="size-4" aria-hidden />
          </button>
        </div>
      }
    >
      {/* 固定高度的工具型布局：左树右编辑器各自内部滚动，整页不出现滚动条。
          预留的 7rem 是 PageShell 头部 + main 上下内边距的合计，改 PageShell 时要同步调 */}
      <div className="flex h-[calc(100dvh-7rem)] min-h-[20rem] gap-3">
        {/* 桌面端固定侧栏 */}
        <aside className="glass hidden w-64 shrink-0 flex-col overflow-hidden rounded-2xl md:flex">
          {sidebarHeader}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5">{treeBody}</div>
          <div className="shrink-0 border-t border-line/10 px-3 py-2">
            <p className="truncate text-[10px] text-fg/30" title={root}>
              {root || '（未配置目录）'}
            </p>
          </div>
        </aside>

        {/* 编辑区 */}
        <section className="glass relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-line/10 px-1.5 py-1.5 sm:px-3 sm:py-2">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="打开目录"
              className="rounded-lg p-2 text-fg/70 transition hover:bg-line/15 hover:text-fg md:hidden"
            >
              <PanelLeft className="size-4" aria-hidden />
            </button>

            <div className="min-w-0 flex-1">
              {selected ? (
                <>
                  <p className="flex items-center gap-1.5 text-xs font-medium text-fg/90">
                    {dirty && (
                      <span className="size-1.5 shrink-0 rounded-full bg-amber-300" aria-label="有未保存的修改" />
                    )}
                    <span className="truncate" title={selected}>
                      {selected}
                    </span>
                  </p>
                  <p className={`truncate text-[10px] ${selectedExists ? 'text-fg/40' : 'text-warn/80'}`}>
                    {fileHint}
                  </p>
                </>
              ) : (
                <p className="truncate px-1 text-xs text-fg/45">未选择笔记</p>
              )}
            </div>

            {selected && (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
                className={[
                  'flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium transition',
                  dirty
                    ? 'bg-brand-500 text-white hover:bg-brand-600'
                    : 'text-fg/45 hover:bg-line/10',
                ].join(' ')}
              >
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Save className="size-3.5" aria-hidden />
                )}
                <span className="hidden sm:inline">{dirty ? '保存' : '已保存'}</span>
              </button>
            )}

            <div className="flex shrink-0 items-center gap-0.5 rounded-xl bg-line/10 p-0.5">
              {MODES.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  title={label}
                  aria-label={`${label}模式`}
                  aria-pressed={mode === id}
                  onClick={() => setMode(id)}
                  className={[
                    'flex items-center gap-1 rounded-[10px] px-2 py-1.5 text-[11px] transition',
                    mode === id ? 'bg-line/20 text-fg' : 'text-fg/55 hover:text-fg',
                  ].join(' ')}
                >
                  <Icon className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
          </div>

          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              {(mode === 'edit' || mode === 'split') && (
                <div
                  className={`min-h-0 min-w-0 flex-1 ${
                    mode === 'split' ? 'border-b border-line/10 md:border-b-0 md:border-r' : ''
                  }`}
                >
                  <MdEditor
                    // 换文件就换一个编辑器实例：撤销历史跟着文件走，不会串
                    key={selected}
                    value={content}
                    onChange={setContent}
                    onSave={() => void handleSave()}
                    onScrollRatio={mode === 'split' ? handleScrollRatio : undefined}
                  />
                </div>
              )}

              {(mode === 'preview' || mode === 'split') && (
                <MarkdownPreview
                  content={content}
                  containerRef={previewRef}
                  className="min-h-0 min-w-0 flex-1"
                />
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <NotebookPen className="size-7 text-fg/20" aria-hidden />
              <p className="text-sm text-fg/70">还没有打开任何笔记</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => openPrompt({ kind: 'new-note', initial: '未命名.md', node: null })}
                  className="rounded-xl bg-brand-500 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-brand-600"
                >
                  新建笔记
                </button>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="rounded-xl border border-line/15 px-3.5 py-2 text-xs text-fg/80 transition hover:bg-line/10 md:hidden"
                >
                  打开目录
                </button>
              </div>
              {tree.length > 0 && (
                <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-fg/35">
                  左侧目录里有 {tree.length} 个顶层条目，点一下就能打开。
                </p>
              )}
            </div>
          )}

          {fileLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/35 backdrop-blur-[1px]">
              <Loader2 className="size-5 animate-spin text-fg/70" aria-hidden />
            </div>
          )}
        </section>
      </div>

      {/* 移动端目录抽屉 */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div className="note-drawer absolute inset-y-0 left-0 flex w-[82vw] max-w-xs flex-col border-r border-line/10 bg-surface/95 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
            <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-1">
              <p className="text-sm font-semibold text-fg">笔记目录</p>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭目录"
                className="rounded-lg p-1.5 text-fg/60 transition hover:bg-line/15 hover:text-fg"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            {sidebarHeader}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5">{treeBody}</div>
            <div className="shrink-0 border-t border-line/10 px-3 py-2">
              <p className="truncate text-[10px] text-fg/30" title={root}>
                {root || '（未配置目录）'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 抽屉滑入动画：index.css 不在本次改动范围内，就近写一小段 keyframes */}
      <style>{`
        @keyframes note-drawer-in { from { transform: translateX(-100%); } to { transform: none; } }
        .note-drawer { animation: note-drawer-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both; }
        @media (prefers-reduced-motion: reduce) { .note-drawer { animation: none; } }
      `}</style>

      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPick={(path) => {
          setSearchOpen(false)
          void loadFile(path)
        }}
      />

      <PromptDialog
        open={prompt !== null}
        title={
          prompt?.kind === 'new-note'
            ? '新建笔记'
            : prompt?.kind === 'new-dir'
              ? '新建文件夹'
              : '重命名 / 移动'
        }
        label={
          prompt?.kind === 'new-note'
            ? '文件路径'
            : prompt?.kind === 'new-dir'
              ? '文件夹路径'
              : '新的完整路径'
        }
        hint={
          prompt?.kind === 'new-note'
            ? `可以带上子目录，例如「工作/周会.md」，父目录会自动创建。不写扩展名会自动补 .md。`
            : prompt?.kind === 'new-dir'
              ? '可以带多级，例如「工作/2026」。'
              : '改成别的目录就是移动，例如「归档/旧笔记.md」。'
        }
        initialValue={prompt?.initial ?? ''}
        confirmText={prompt?.kind === 'rename' ? '确定' : '创建'}
        busy={dialogBusy}
        onCancel={() => setPrompt(null)}
        onSubmit={(value) => void submitPrompt(value)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.type === 'dir' ? '删除目录' : '删除笔记'}
        message={
          pendingDelete?.type === 'dir'
            ? `确定删除目录「${pendingDelete?.name}」吗？`
            : `确定删除「${pendingDelete ? baseName(pendingDelete.path) : ''}」吗？`
        }
        detail={
          pendingDelete?.type === 'dir'
            ? '目录会被递归删除，其中的所有笔记和子目录将一并消失，且无法撤销。'
            : '这个 .md 文件会从磁盘上删除，无法撤销。'
        }
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void performDelete()}
      />

      <ConflictDialog
        conflict={conflict}
        busy={saving}
        onCancel={() => setConflict(null)}
        onLoadDisk={resolveConflictByLoadingDisk}
        onOverwrite={resolveConflictByOverwrite}
      />
    </PageShell>
  )
}
