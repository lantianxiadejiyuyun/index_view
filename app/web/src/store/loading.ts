import { create } from 'zustand'

/**
 * 全局加载遮罩的开关。
 *
 * 用**计数器**而不是布尔值：并发的异步操作各自 push/pop，
 * 最后一个结束才真正关掉遮罩 —— 布尔值会被先结束的那个提前关掉。
 *
 * 组件外也能调用：`beginLoading('保存中…')` / `endLoading()`。
 */
type LoadingState = {
  count: number
  text: string
  begin: (text?: string) => void
  end: () => void
  reset: () => void
}

export const useLoading = create<LoadingState>()((set) => ({
  count: 0,
  text: '正在加载…',

  begin(text) {
    set((s) => ({ count: s.count + 1, text: text ?? s.text }))
  },

  end() {
    set((s) => ({ count: Math.max(0, s.count - 1) }))
  },

  /** 兜底：出异常时把所有计数清零，避免遮罩卡住下不来 */
  reset() {
    set({ count: 0 })
  },
}))

export function beginLoading(text?: string): void {
  useLoading.getState().begin(text)
}

export function endLoading(): void {
  useLoading.getState().end()
}

/**
 * 包一段异步操作：自动 push/pop，异常也不会把遮罩留在屏幕上。
 *
 *   await withLoading('正在保存…', () => api('/api/settings', ...))
 */
export async function withLoading<T>(text: string, fn: () => Promise<T>): Promise<T> {
  beginLoading(text)
  try {
    return await fn()
  } finally {
    endLoading()
  }
}
