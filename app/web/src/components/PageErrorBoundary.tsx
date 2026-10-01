import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

/** 分包下载失败时保留可操作的提示，重新加载可获取部署后的最新资源地址。 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center text-wp">
        <TriangleAlert className="size-8 text-warn" aria-hidden />
        <h1 className="text-lg font-semibold">页面暂时无法打开</h1>
        <p className="text-sm text-wp/70">请重新加载页面后再试。</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-xl bg-line/15 px-4 py-2 text-sm transition hover:bg-line/25"
        >
          重新加载
        </button>
      </div>
    )
  }
}
