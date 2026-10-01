import type { ReactNode } from 'react'

/**
 * 全屏加载遮罩。
 *
 * 半透明毛玻璃铺满视口，中间一张玻璃卡片 —— 这样不管底下是照片壁纸还是纯色，
 * 遮罩都能把注意力压到中间，也不会像纯黑遮罩那样把壁纸整个盖掉。
 *
 * 什么时候该用：**首次进入**某页、或某个操作会长时间无反馈时。
 * 每次刷新列表、每次点小按钮都盖一层反而烦人，那类场景用局部 loading 就好。
 */
export function LoadingOverlay({
  open,
  text = '正在加载…',
  hint,
  children,
}: {
  open: boolean
  text?: string
  hint?: string
  children?: ReactNode
}) {
  if (!open) return null

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-md"
    >
      <div className="glass glass-pop animate-pop flex min-w-[13rem] flex-col items-center gap-3 rounded-3xl px-8 py-7 text-center">
        {/* 双层圆环：底环是中性色，上面转的是品牌色，比默认的转圈图标精致一些 */}
        <span className="relative flex size-11 items-center justify-center" aria-hidden>
          <span className="absolute inset-0 rounded-full border-2 border-line/15" />
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-accent" />
        </span>

        <span className="text-sm font-medium text-fg">{text}</span>
        {hint && <span className="-mt-1 text-xs text-fg/55">{hint}</span>}
        {children}
      </div>
    </div>
  )
}
