import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  Link2,
  Loader2,
  Sparkles,
  Trash2,
  Upload as UploadIcon,
  Wallpaper as WallpaperIcon,
  X,
} from 'lucide-react'
import { PageShell } from '../components/PageShell.tsx'
import { LoadingOverlay } from '../components/LoadingOverlay.tsx'
import { makeDerivatives } from '../lib/image.ts'
import { btnGhost, btnPrimary } from '../components/Modal.tsx'
import { api, errorMessage } from '../lib/api.ts'
import type { UploadItem } from '../lib/types.ts'
import { useApp } from '../store/app.ts'
import { beginLoading, endLoading, updateLoading } from '../store/loading.ts'
import { toast } from '../store/toast.ts'

const PAGE_SIZE = 200

/**
 * 小于这个体积的图片默认不展示。
 * 图标 favicon 通常只有 1–4KB，混在照片里会是一堆看不清的小点；
 * 照片和壁纸基本都远大于此。用户可以一键切换成「显示全部」。
 */
const SMALL_IMAGE_BYTES = 20 * 1024

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 展示用名字。旧数据没存原文件名，而磁盘上是随机哈希（muc7dhz5-6ad6…），
 * 显示出来纯属噪音，所以那种情况返回空字符串，由调用方改成显示时间。
 */
function displayName(item: UploadItem): string {
  return item.original_name?.trim() ?? ''
}

/** 下载时的文件名：没有原名就退回磁盘上的名字，至少是个合法文件名 */
function downloadName(item: UploadItem): string {
  return item.original_name?.trim() || item.filename
}

/**
 * 灯箱里该加载哪张「大图」。
 *
 * 正常情况下是原图 —— 画质最好。但 **HEIC/HEIF（苹果默认拍照格式）只有
 * Safari 系能解**，Chrome / Firefox 拿到会显示破图，所以这种就换成派生图。
 * 派生图是浏览器端从 HEIC 转出来的，任何浏览器都能显示。
 */
function lightboxSrc(item: UploadItem): string {
  const original = `/uploads/${item.filename}`
  if (/heic|heif/i.test(item.mime)) return item.large_url ?? item.thumb_url ?? original
  return original
}

export function PhotosPage() {
  const saveSettings = useApp((s) => s.saveSettings)

  const [items, setItems] = useState<UploadItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(0)
  const [showSmall, setShowSmall] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [viewer, setViewer] = useState<number | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await api<{ uploads: UploadItem[]; total: number }>(
        `/api/uploads?limit=${PAGE_SIZE}`,
      )
      setItems(res.uploads)
      setTotal(res.total)
    } catch (err) {
      toast.error(errorMessage(err, '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(
    () => (showSmall ? items : items.filter((i) => i.size >= SMALL_IMAGE_BYTES)),
    [items, showSmall],
  )
  const hiddenCount = items.length - visible.length

  // ── 上传 ────────────────────────────────────────────────────

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setUploading(files.length)
      // 多张照片要传一会儿，盖个遮罩比只在角上转圈更明确
      beginLoading(files.length > 1 ? `正在处理 ${files.length} 张…` : '正在处理…')
      try {
        // 派生图在浏览器生成（服务端不做图片处理，见 lib/image.ts 的说明）。
        // 生成和上传都**逐张来**：一次几十张的 canvas 解码会把内存打满，
        // 而且逐张能顺带报进度。
        const body = new FormData()
        for (const [index, f] of files.entries()) {
          if (files.length > 1) {
            updateLoading(`正在处理第 ${index + 1}/${files.length} 张…`)
          }
          body.append('file', f)
          const derived = await makeDerivatives(f)
          // 原图始终按 file 顺序提交。派生图明确携带原图序号，
          // GIF、解码失败或小图跳过某项时，后面的预览也不会配到前一张。
          if (derived.thumb) body.append(`thumb_${index}`, derived.thumb, 'thumb.webp')
          if (derived.large) body.append(`large_${index}`, derived.large, 'large.webp')
        }

        updateLoading(files.length > 1 ? `正在上传 ${files.length} 张…` : '正在上传…')
        const res = await api<{ uploaded: UploadItem[]; failed?: Array<{ name: string; message: string }> }>(
          '/api/upload',
          { method: 'POST', body },
        )
        const ok = res.uploaded?.length ?? 0
        if (ok > 0) toast.success(`已上传 ${ok} 张`)
        const failed = res.failed ?? []
        if (failed.length > 0) {
          toast.error(`${failed.length} 张未上传：${failed[0]?.name}（${failed[0]?.message}）`)
        }
        await load()
      } catch (err) {
        toast.error(errorMessage(err, '上传失败'))
      } finally {
        setUploading(0)
        endLoading()
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [load],
  )

  async function remove(item: UploadItem) {
    try {
      await api(`/api/uploads/${encodeURIComponent(item.filename)}`, { method: 'DELETE' })
      setItems((list) => list.filter((i) => i.filename !== item.filename))
      setTotal((t) => Math.max(0, t - 1))
      setViewer(null)
      toast.success('已删除')
    } catch (err) {
      toast.error(errorMessage(err, '删除失败'))
    }
  }

  async function useAsWallpaper(item: UploadItem) {
    try {
      // 两套壁纸都设成这张图：用户点「设为壁纸」的意图是「就用它」，
      // 不该因为后来切了深浅色主题又变回别的
      const url = `/uploads/${item.filename}`
      await saveSettings({
        wallpaper_light_type: 'image',
        wallpaper_light_value: url,
        wallpaper_dark_type: 'image',
        wallpaper_dark_value: url,
      })
      toast.success('已设为壁纸，回首页看看')
    } catch (err) {
      toast.error(errorMessage(err, '设置失败'))
    }
  }

  async function copyLink(item: UploadItem) {
    const url = `${window.location.origin}/uploads/${item.filename}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success('链接已复制')
    } catch {
      toast.info(url)
    }
  }

  // 灯箱的键盘操作
  useEffect(() => {
    if (viewer === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewer(null)
      if (e.key === 'ArrowLeft') setViewer((v) => (v === null ? v : Math.max(0, v - 1)))
      if (e.key === 'ArrowRight')
        setViewer((v) => (v === null ? v : Math.min(visible.length - 1, v + 1)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer, visible.length])

  const current = viewer === null ? null : visible[viewer]

  // 还没有缩略图的图（这个功能上线前传的，或用 API 直传的）
  const missingThumbs = items.filter((i) => !i.thumb_url)

  /**
   * 给已有图片补缩略图。
   *
   * 派生图是浏览器端算的（服务端不做图片处理），所以老图要补就得
   * 「取回原图 → 浏览器缩 → 传回派生图」。逐张来，单张失败不影响其余。
   */
  async function backfillThumbs() {
    const targets = missingThumbs
    if (targets.length === 0) return

    beginLoading(`正在处理 0/${targets.length}…`)
    let ok = 0
    try {
      for (const [index, item] of targets.entries()) {
        updateLoading(`正在处理 ${index + 1}/${targets.length}…`)
        try {
          const res = await fetch(`/uploads/${item.filename}`)
          if (!res.ok) continue
          const blob = await res.blob()
          const derived = await makeDerivatives(new File([blob], item.filename, { type: blob.type }))
          if (!derived.thumb && !derived.large) continue

          const body = new FormData()
          if (derived.thumb) body.append('thumb', derived.thumb, 'thumb.webp')
          if (derived.large) body.append('large', derived.large, 'large.webp')
          await api(`/api/uploads/${encodeURIComponent(item.filename)}/derived`, {
            method: 'POST',
            body,
          })
          ok += 1
        } catch {
          // 单张失败就跳过，最后统一报数量
        }
      }
      toast.success(ok > 0 ? `已为 ${ok} 张生成缩略图` : '没有可处理的图片')
      await load()
    } finally {
      endLoading()
    }
  }

  return (
    <PageShell
      title="照片墙"
      description={`共 ${total} 张 · 保留原图，不限制像素尺寸；单张文件默认最大 20MB`}
      wide
      actions={
        <div className="flex items-center gap-2">
          {/* 只在确实有旧图缺缩略图时出现，平时不占地方 */}
          {missingThumbs.length > 0 && (
            <button
              type="button"
              onClick={() => void backfillThumbs()}
              className={btnGhost}
              title="这些图是在缩略图功能上线前传的，现在还在用原图。点一下当场补上。"
            >
              <Sparkles className="mr-1.5 inline size-3.5" aria-hidden />
              补齐缩略图（{missingThumbs.length}）
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowSmall((v) => !v)}
            className={btnGhost}
            title={
              hiddenCount > 0
                ? `当前隐藏了 ${hiddenCount} 张小图（多为 favicon）`
                : '没有更小的图片'
            }
          >
            {showSmall ? '隐藏小图' : `显示全部${hiddenCount > 0 ? `（+${hiddenCount}）` : ''}`}
          </button>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading > 0}
            className={btnPrimary}
          >
            {uploading > 0 ? (
              <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />
            ) : (
              <UploadIcon className="mr-1.5 inline size-3.5" aria-hidden />
            )}
            上传图片
          </button>
        </div>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => void uploadFiles(Array.from(e.target.files ?? []))}
      />

      {/* 只有「首次读取、还什么都没显示」时才盖遮罩；
          已经有图之后的刷新属于后台行为，再盖一层就是闪烁了 */}
      <LoadingOverlay open={loading && items.length === 0} text="正在读取照片…" />

      {/* 整块区域都是拖放目标。外层保持一定高度、负责接住拖拽，
          里层的玻璃面板按内容收缩 —— 否则只有一两张图时面板会被撑得很高、
          图缩在一个角上，显得空。 */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void uploadFiles(Array.from(e.dataTransfer.files))
        }}
        className={[
          'min-h-[50vh] rounded-3xl transition',
          dragging ? 'bg-accent/5 ring-2 ring-accent/60' : '',
        ].join(' ')}
      >
        {/* 画廊必须有自己的承载面：用户很可能把某张照片设成了壁纸，
            图片直接浮在照片背景上会两层糊在一起、分不清哪个是内容 */}
        <div className="glass rounded-3xl p-3 sm:p-4">
        {dragging && (
          <p className="mb-3 rounded-2xl bg-accent/10 py-2 text-center text-xs text-accent">
            松手即可上传
          </p>
        )}

        {loading ? (
          <p className="py-24 text-center text-xs text-fg/50">加载中…</p>
        ) : visible.length === 0 ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center gap-3 rounded-2xl border border-dashed border-line/25 px-6 py-24 text-center transition hover:border-accent/50"
          >
            <ImageIcon className="size-8 text-fg/45" aria-hidden />
            <span className="text-sm text-fg/80">
              {items.length > 0 && !showSmall
                ? '当前只显示了较大的图片，点右上角「显示全部」看看'
                : '还没有上传过图片'}
            </span>
            <span className="text-xs text-fg/50">
              点击选择文件，或直接拖入图片。支持多选，保留原图，不限制像素尺寸；单张文件默认最大 20MB。
            </span>
          </button>
        ) : (
          /* CSS 多列做瀑布流：保留原始宽高比，也不需要在服务端存图片尺寸 */
          <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5">
            {visible.map((item, index) => (
              <figure
                key={item.filename}
                className="group relative mb-3 break-inside-avoid overflow-hidden rounded-2xl ring-1 ring-line/10 transition duration-300 hover:ring-accent/40"
              >
                <button
                  type="button"
                  onClick={() => setViewer(index)}
                  className="block w-full cursor-zoom-in"
                  aria-label={`查看 ${displayName(item) || '图片'}`}
                >
                  <img
                    // 网格里一律用缩略图（≤480px，几十 KB）。
                    // 没有派生图的老数据才退回原图 —— 那些可能好几 MB，正是要避免的。
                    //
                    // 这里**不用 srcSet**：w 描述符要写真实像素宽度，
                    // 而接口没有返回尺寸，猜一个会让浏览器选错图（甚至选了原图）。
                    // 480px 的图放在手机上约 180px、桌面上约 280px 的格子里都够清晰，
                    // 按设备分流放到灯箱去做（那里才是真正会拉原图的地方）。
                    src={item.thumb_url ?? item.large_url ?? `/uploads/${item.filename}`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="block w-full bg-line/5 transition duration-500 group-hover:scale-[1.03]"
                  />
                </button>

                {/* 悬停时浮出的信息条与操作 */}
                <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-3 opacity-0 transition group-hover:opacity-100">
                  <span className="min-w-0 text-[11px] leading-tight text-white/90">
                    <span className="block truncate">{formatTime(item.created_at)}</span>
                    <span className="block text-white/60">{humanSize(item.size)}</span>
                  </span>

                  <span className="pointer-events-auto flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => void useAsWallpaper(item)}
                      title="设为壁纸"
                      aria-label="设为壁纸"
                      className="rounded-lg bg-white/15 p-1.5 text-white backdrop-blur transition hover:bg-white/30"
                    >
                      <WallpaperIcon className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(item)}
                      title="删除"
                      aria-label="删除"
                      className="rounded-lg bg-white/15 p-1.5 text-white backdrop-blur transition hover:bg-rose-500/80"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* ── 灯箱 ── */}
      {current && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-3 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] text-white/85">
            <span className="text-xs">
              {(viewer ?? 0) + 1} / {visible.length}
            </span>
            <button
              type="button"
              onClick={() => setViewer(null)}
              className="rounded-xl p-2 transition hover:bg-white/15"
              aria-label="关闭"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 py-3">
            {(viewer ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setViewer((v) => Math.max(0, (v ?? 0) - 1))}
                className="absolute left-3 z-10 rounded-full bg-white/10 p-2.5 text-white backdrop-blur transition hover:bg-white/25"
                aria-label="上一张"
              >
                <ChevronLeft className="size-5" aria-hidden />
              </button>
            )}

            {/* 灯箱分两步：
                1. 先把缩略图铺成背景占位 —— 它已经在缓存里，瞬间就出现，
                   不会对着黑屏等
                2. 大图按**设备宽度**选：手机屏幕小、又常是流量，给中等图；
                   桌面端才拉原图。加载完自然盖在占位上面。
                picture + media 是显式指定，不像 srcSet 那样依赖宽度猜得准不准。 */}
            <div
              className="pointer-events-none absolute inset-0 bg-center bg-no-repeat"
              style={{
                backgroundImage: `url("${current.thumb_url ?? current.large_url ?? `/uploads/${current.filename}`}")`,
                backgroundSize: 'contain',
              }}
            />
            <picture className="contents">
              <source
                media="(max-width: 640px)"
                srcSet={current.large_url ?? current.thumb_url ?? undefined}
              />
              <img
                src={lightboxSrc(current)}
                alt=""
                // z-[1] 压在占位层上面（占位是 absolute，不定位的元素会被它盖住），
                // 又低于左右切换按钮的 z-10
                className="relative z-[1] max-h-[calc(100dvh-7rem)] max-w-full rounded-xl object-contain"
              />
            </picture>

            {(viewer ?? 0) < visible.length - 1 && (
              <button
                type="button"
                onClick={() => setViewer((v) => Math.min(visible.length - 1, (v ?? 0) + 1))}
                className="absolute right-3 z-10 rounded-full bg-white/10 p-2.5 text-white backdrop-blur transition hover:bg-white/25"
                aria-label="下一张"
              >
                <ChevronRight className="size-5" aria-hidden />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <span className="min-w-0 text-[11px] text-white/60">
              <span className="block truncate">
                {displayName(current) || formatTime(current.created_at)}
              </span>
              <span>
                {displayName(current)
                  ? `${formatTime(current.created_at)} · ${humanSize(current.size)}`
                  : humanSize(current.size)}
              </span>
            </span>

            <span className="flex flex-wrap gap-2">
              <a
                href={`/uploads/${current.filename}`}
                download={downloadName(current)}
                className="flex items-center gap-1.5 rounded-xl border border-white/20 px-3 py-2 text-xs text-white/85 transition hover:bg-white/10"
              >
                <Download className="size-3.5" aria-hidden />
                下载
              </a>
              <button
                type="button"
                onClick={() => void copyLink(current)}
                className="flex items-center gap-1.5 rounded-xl border border-white/20 px-3 py-2 text-xs text-white/85 transition hover:bg-white/10"
              >
                <Link2 className="size-3.5" aria-hidden />
                复制链接
              </button>
              <button
                type="button"
                onClick={() => void useAsWallpaper(current)}
                className="flex items-center gap-1.5 rounded-xl border border-white/20 px-3 py-2 text-xs text-white/85 transition hover:bg-white/10"
              >
                <WallpaperIcon className="size-3.5" aria-hidden />
                设为壁纸
              </button>
              <button
                type="button"
                onClick={() => void remove(current)}
                className="flex items-center gap-1.5 rounded-xl border border-rose-400/40 bg-rose-500/20 px-3 py-2 text-xs text-rose-100 transition hover:bg-rose-500/35"
              >
                <Trash2 className="size-3.5" aria-hidden />
                删除
              </button>
            </span>
          </div>
        </div>
      )}
    </PageShell>
  )
}
