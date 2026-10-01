import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { ChevronRight, FilePlus2, FileText, Folder, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import type { NoteNode } from '../../lib/types.ts'
import { formatTime, parentOf } from './paths.ts'

/**
 * 目录树。
 *
 * 后端 listTree 已经排好序（目录在前、文件在后、数字感知），这里再排一次是
 * 因为新建 / 移动后前端会拿返回结果就地更新，顺序不能靠后端的单次快照保证。
 * 排序结果用 useMemo 缓存，几百个条目也不会每次渲染都重排。
 */
function sortNodes(nodes: NoteNode[]): NoteNode[] {
  const byName = (a: NoteNode, b: NoteNode): number =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  const dirs = nodes.filter((n) => n.type === 'dir').sort(byName)
  const files = nodes.filter((n) => n.type === 'file').sort(byName)
  return [...dirs, ...files]
}

export type NoteTreeProps = {
  nodes: NoteNode[]
  selectedPath: string | null
  expanded: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
  onRename: (node: NoteNode) => void
  onDelete: (node: NoteNode) => void
  /** 在某个目录下新建笔记（预填该目录前缀） */
  onNewNoteIn: (dirPath: string) => void
  depth?: number
}

// ── 拖拽 ────────────────────────────────────────────────────────
//
// 交互按资源管理器 / VS Code 的直觉来：
//   · 拖到「文件夹」行 → 移动进这个文件夹
//   · 拖到「文件」行   → 移动进这个文件所在的目录（同级）
//   · 拖到空白处       → 移动到根目录
//
// 只做「移动」，不做同层排序：笔记树的顺序由后端 listTree 算（目录在前、
// 文件在后、数字感知的字典序），没有 sort_order 这类持久化字段 ——
// 拖出来的顺序存不住，做出来只会让用户以为保存了。
//
// ⚠️ 碰撞检测不能用 closestCenter：树容器面积远大于任何一行、中心点也远，
// 用它时容器会把真正的行挤掉。这里用 pointerWithin（光标真正压住谁），
// 命中的行里取面积最小的（= 最内层的那一行），一行都没命中才落到根容器。

type DragInfo = { path: string; name: string; type: 'file' | 'dir' }

export type NoteDragInfo = DragInfo

/** 根容器的落点 id；行落点用 `dropPath:` 前缀，两者不会撞 */
const ROOT_DROP_ID = 'notes-root'

/** 拖拽中的条目能不能落进 dir（`''` = 根目录） */
function canDropInto(info: DragInfo, dir: string): boolean {
  // 源本来就在这个目录里 —— 落下去等于什么都没发生
  if (parentOf(info.path) === dir) return false
  // 目录不能搬进自己或自己的子树，后端也会拒（400），先在界面上就不给落点
  if (info.type === 'dir' && (dir === info.path || dir.startsWith(`${info.path}/`))) return false
  return true
}

type TreeDndValue = {
  dragging: DragInfo | null
  /** 正在移动（请求飞行中）：期间不给再拖，避免连点打出一串请求 */
  busy: boolean
  /** 把这一行当落点时的目标目录；null = 落到这行上没有意义 */
  dropDirOf: (node: NoteNode) => string | null
}

const TreeDndContext = createContext<TreeDndValue>({
  dragging: null,
  busy: false,
  dropDirOf: () => null,
})

/** 一行的拖 / 放能力。行组件在递归里很深，能力从 context 里取 */
function useRowDnd(node: NoteNode) {
  const { dragging, busy, dropDirOf } = useContext(TreeDndContext)
  const dir = dropDirOf(node)

  const draggable = useDraggable({
    id: `dragPath:${node.path}`,
    data: { path: node.path, name: node.name, type: node.type } satisfies DragInfo,
    disabled: busy,
  })
  // ⚠️ 落点一律常驻注册，不用 disabled 动态开关。
  // dnd-kit 只把「启用中」的 droppable 纳入碰撞检测，而 enabled 是在拖拽开始
  // 那一帧才变成 true 的 —— 这一帧的时序很容易让刚启用的落点整个拖拽期间都测不到，
  // 表现就是「明明拖到空白处了却没有落点」。有效性改成在数据里标（dir 为 null
  // 就是无效），碰撞照常命中、由 onDragEnd 决定要不要真的落。
  const droppable = useDroppable({
    id: `dropPath:${node.path}`,
    data: { dir },
  })

  return {
    draggable,
    droppable,
    /** 这一行就是被拖起来的那一行 —— 淡化它，避免和落到自己身上混淆 */
    isSource: dragging?.path === node.path,
    /** 光标正压在这一行上，且这是一个有意义的落点 */
    highlight: droppable.isOver && dir !== null,
  }
}

export type NoteTreeDndProps = NoteTreeProps & {
  /** 落点有效时回调；dir 为 `''` 表示根目录 */
  onMove: (drag: DragInfo, dir: string) => void
  /** 正在移动的路径 */
  busyPath?: string | null
}

/**
 * 目录树 + 拖拽移动。
 *
 * 桌面用鼠标拖（6px 容差，和「点一下打开」共存）；触屏要长按 220ms 才起拖，
 * 否则在移动端抽屉里上下滑动会变成拖拽。键盘用户走不了拖拽 ——
 * 行尾的「重命名 / 移动」按钮可以直接填路径，那条路一直留着。
 */
export function NoteTreeDnd({
  onMove,
  busyPath = null,
  nodes,
  ...rest
}: NoteTreeDndProps) {
  const [dragging, setDragging] = useState<DragInfo | null>(null)
  const [overDir, setOverDir] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  )

  const ctx = useMemo<TreeDndValue>(
    () => ({
      dragging,
      busy: busyPath !== null,
      dropDirOf: (node) => {
        if (!dragging || node.path === dragging.path) return null
        const dir = node.type === 'dir' ? node.path : parentOf(node.path)
        return canDropInto(dragging, dir) ? dir : null
      },
    }),
    [dragging, busyPath],
  )

  // 空白处 = 根目录。同样常驻注册，「在根目录里的条目再拖到空白处」这种
  // 无效落点靠 canDropInto 判断，不靠开关 droppable。
  const rootValid = dragging !== null && canDropInto(dragging, '')

  function handleDragStart(event: DragStartEvent): void {
    const data = event.active.data.current as DragInfo | undefined
    if (data) setDragging(data)
  }

  function handleDragOver(event: DragOverEvent): void {
    const over = event.over
    if (!over) {
      setOverDir(null)
      return
    }
    if (over.id === ROOT_DROP_ID) {
      setOverDir(rootValid ? '' : null)
      return
    }
    const dir = (over.data.current as { dir?: string | null } | undefined)?.dir
    setOverDir(typeof dir === 'string' ? dir : null)
  }

  function handleDragEnd(event: DragEndEvent): void {
    const info = dragging
    setDragging(null)
    setOverDir(null)
    const over = event.over
    if (!info || !over) return

    // 落在「无效的行」上 = 什么都不做。这里不能退回根目录 ——
    // 用户瞄的是那一行，把条目丢到根目录是最糟的误解
    const dir =
      over.id === ROOT_DROP_ID ? '' : (over.data.current as { dir?: string | null } | undefined)?.dir
    if (typeof dir !== 'string' || !canDropInto(info, dir)) return
    onMove(info, dir)
  }

  const collisionDetection: CollisionDetection = (args) => {
    const within = pointerWithin(args)
    if (within.length === 0) return []

    let best: Collision | null = null
    let bestArea = Number.POSITIVE_INFINITY
    for (const hit of within) {
      if (hit.id === ROOT_DROP_ID) continue
      const rect = args.droppableRects.get(hit.id)
      const area = rect ? rect.width * rect.height : Number.POSITIVE_INFINITY
      if (area < bestArea) {
        bestArea = area
        best = hit
      }
    }
    if (best) return [best]
    return within.filter((hit) => hit.id === ROOT_DROP_ID)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDragging(null)
        setOverDir(null)
      }}
    >
      <TreeDndContext.Provider value={ctx}>
        <RootDropZone valid={rootValid} dragging={dragging}>
          <NoteTree nodes={nodes} {...rest} />
        </RootDropZone>
      </TreeDndContext.Provider>

      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="flex max-w-56 items-center gap-1.5 rounded-lg border border-line/15 bg-surface/95 px-2.5 py-1.5 text-[12px] text-fg shadow-lg backdrop-blur">
            {dragging.type === 'dir' ? (
              <Folder className="size-3.5 shrink-0 text-accent" aria-hidden />
            ) : (
              <FileText className="size-3.5 shrink-0 text-fg/45" aria-hidden />
            )}
            <span className="truncate">{dragging.name}</span>
            {overDir !== null && (
              <span className="shrink-0 text-fg/45">
                → {overDir === '' ? '根目录' : overDir}
              </span>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

/**
 * 「空白处 = 根目录」的落点区域。
 *
 * ⚠️ 必须单独做成组件、渲染在 <DndContext> **内部**。
 * useDroppable 是从 dnd-kit 的 InternalContext 里取注册入口的，而 InternalContext
 * 由 <DndContext> 提供 —— 在「渲染 DndContext 的那个组件」里调用 useDroppable，
 * 拿到的是默认的空上下文，注册会静默失败（落点根本不存在，拖过去没有任何反应）。
 * 这个坑实测踩过：行上的落点好好的，只有这块空白区域怎么拖都没反应。
 */
function RootDropZone({
  valid,
  dragging,
  children,
}: {
  valid: boolean
  dragging: DragInfo | null
  children: ReactNode
}) {
  const root = useDroppable({ id: ROOT_DROP_ID })

  return (
    <div
      ref={root.setNodeRef}
      className={[
        'flex min-h-full flex-col rounded-xl transition',
        root.isOver && valid ? 'bg-accent/10 ring-2 ring-inset ring-accent/50' : '',
      ].join(' ')}
    >
      {children}
      {/* 撑满剩下的高度：目录没铺满时下面那块空白也要能接住拖拽（= 根目录） */}
      <div className="min-h-8 flex-1" />
      {dragging && (
        <p className="shrink-0 px-2 pb-1 text-[10px] leading-relaxed text-fg/40">
          拖到文件夹上移进去，拖到空白处移到根目录
        </p>
      )}
    </div>
  )
}

export const NoteTree = memo(function NoteTree(props: NoteTreeProps) {
  const { nodes, depth = 0 } = props
  const sorted = useMemo(() => sortNodes(nodes), [nodes])

  if (sorted.length === 0) return null

  return (
    <ul className={depth === 0 ? 'space-y-px' : 'space-y-px'}>
      {sorted.map((node) =>
        node.type === 'dir' ? (
          <DirRow key={node.path} node={node} {...props} />
        ) : (
          <FileRow key={node.path} node={node} {...props} />
        ),
      )}
    </ul>
  )
})

/** 行尾的操作按钮：桌面 hover 才显形，移动端始终显示（没有 hover 可用） */
function RowActions({
  node,
  onRename,
  onDelete,
  onNewNoteIn,
}: {
  node: NoteNode
  onRename: (node: NoteNode) => void
  onDelete: (node: NoteNode) => void
  onNewNoteIn: (dirPath: string) => void
}) {
  const buttonClass =
    'rounded-md p-1 text-fg/45 transition hover:bg-line/15 hover:text-fg md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100'

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {node.type === 'dir' && (
        <button
          type="button"
          className={buttonClass}
          title={`在「${node.name}」下新建笔记`}
          aria-label={`在 ${node.name} 下新建笔记`}
          onClick={(e) => {
            e.stopPropagation()
            onNewNoteIn(node.path)
          }}
        >
          <FilePlus2 className="size-3.5" aria-hidden />
        </button>
      )}
      <button
        type="button"
        className={buttonClass}
        title="重命名 / 移动"
        aria-label={`重命名 ${node.name}`}
        onClick={(e) => {
          e.stopPropagation()
          onRename(node)
        }}
      >
        <Pencil className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        className={`${buttonClass} hover:bg-rose-500/25 hover:text-danger`}
        title={node.type === 'dir' ? '删除目录（含其中全部笔记）' : '删除'}
        aria-label={`删除 ${node.name}`}
        onClick={(e) => {
          e.stopPropagation()
          onDelete(node)
        }}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </button>
    </span>
  )
}

function DirRow({
  node,
  depth = 0,
  expanded,
  onToggleDir,
  ...rest
}: NoteTreeProps & { node: NoteNode }) {
  const open = expanded.has(node.path)
  const children = node.children ?? []
  const { draggable, droppable, isSource, highlight } = useRowDnd(node)

  return (
    <li>
      <div
        ref={(el) => {
          draggable.setNodeRef(el)
          droppable.setNodeRef(el)
        }}
        className={[
          'group flex items-center rounded-lg pr-1 text-fg/75 transition',
          isSource ? 'opacity-40' : 'hover:bg-line/10',
          highlight ? 'bg-accent/15 ring-2 ring-accent/60' : '',
        ].join(' ')}
        style={{ paddingLeft: depth * 12 }}
      >
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          aria-expanded={open}
          {...draggable.attributes}
          {...draggable.listeners}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 py-1.5 pr-1 text-left active:cursor-grabbing"
        >
          <ChevronRight
            className={`size-3.5 shrink-0 text-fg/40 transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
          {open ? (
            <FolderOpen className="size-4 shrink-0 text-accent" aria-hidden />
          ) : (
            <Folder className="size-4 shrink-0 text-accent/80" aria-hidden />
          )}
          <span className="truncate text-[13px] font-medium">{node.name}</span>
          {children.length > 0 && (
            <span className="ml-1 shrink-0 text-[10px] tabular-nums text-fg/30">
              {children.length}
            </span>
          )}
        </button>
        <RowActions node={node} {...rest} />
      </div>

      {open &&
        (children.length > 0 ? (
          <NoteTree {...rest} nodes={children} depth={depth + 1} expanded={expanded} onToggleDir={onToggleDir} />
        ) : (
          <p className="py-1 text-[11px] text-fg/30" style={{ paddingLeft: depth * 12 + 26 }}>
            空目录
          </p>
        ))}
    </li>
  )
}

function FileRow({
  node,
  depth = 0,
  selectedPath,
  onSelectFile,
  ...rest
}: NoteTreeProps & { node: NoteNode }) {
  const active = selectedPath === node.path
  const time = formatTime(node.mtime)
  const { draggable, droppable, isSource, highlight } = useRowDnd(node)

  return (
    <li>
      <div
        ref={(el) => {
          draggable.setNodeRef(el)
          droppable.setNodeRef(el)
        }}
        className={[
          'group flex items-center rounded-lg pr-1 transition',
          isSource && 'opacity-40',
          // 选中项用实心 brand 而不是半透明 tint：tint 在浅色主题下是浅蓝底，
          // 白字压上去读不出来
          active ? 'bg-brand-500 text-white' : 'text-fg/70 hover:bg-line/10 hover:text-fg',
          highlight ? 'ring-2 ring-accent/60' : '',
        ].join(' ')}
        style={{ paddingLeft: depth * 12 }}
      >
        <button
          type="button"
          onClick={() => onSelectFile(node.path)}
          title={node.path}
          {...draggable.attributes}
          {...draggable.listeners}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 py-1.5 pr-1 pl-[18px] text-left active:cursor-grabbing"
        >
          <FileText
            className={`size-3.5 shrink-0 ${active ? 'text-accent' : 'text-fg/35'}`}
            aria-hidden
          />
          <span className="truncate text-[13px]">{node.name}</span>
          {time && (
            <span className="ml-auto hidden shrink-0 pl-2 text-[10px] tabular-nums text-fg/30 sm:inline">
              {time}
            </span>
          )}
        </button>
        <RowActions node={node} {...rest} />
      </div>
    </li>
  )
}
