import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useApp } from '../store/app.ts'

/**
 * 受保护路由的守卫：没登录就**整页都不渲染**。
 *
 * 之前是每个页面各写一份「去登录」的空壳 —— 标题、PageShell、图标都还在，
 * 只是内容换成一句提示。那有两个问题：
 *
 *   1. 未登录的人仍然看到了页面框架，等于告诉他「这里有笔记 / 有照片墙 / 有服务器面板」
 *   2. 五份几乎一样的代码，改一处漏四处
 *
 * 现在统一在这里挡掉，页面组件根本不会被挂载（连带它们的取数 effect 也不会跑）。
 *
 * 跳转时把当前地址塞进 state，登录完能回到原来想去的地方。
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useApp((s) => s.status)
  const user = useApp((s) => s.user)
  const location = useLocation()

  // 会话状态还没确定时不能放行，也不能跳登录 ——
  // 这一刻 user 还是 null，直接跳会把「已登录、只是刚刷新了页面」的人误踢出去。
  // 正常流程下 App 已经挡在更外层了，这里是兜底。
  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="glass flex items-center gap-2 rounded-2xl px-5 py-3 text-xs text-fg/70">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          正在确认登录状态…
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />
    )
  }

  return <>{children}</>
}
