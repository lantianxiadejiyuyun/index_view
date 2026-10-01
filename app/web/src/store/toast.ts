/** 极简 toast。自部署个人页不需要引入一整个通知库。 */
import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'info'

export type Toast = {
  id: number
  kind: ToastKind
  message: string
}

type ToastState = {
  toasts: Toast[]
  push: (message: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
}

let seq = 0

export const useToast = create<ToastState>()((set) => ({
  toasts: [],

  push(message, kind = 'info') {
    const id = ++seq
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, kind === 'error' ? 6000 : 3000)
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

/** 组件外也能弹提示的快捷方法 */
export const toast = {
  success: (m: string) => useToast.getState().push(m, 'success'),
  error: (m: string) => useToast.getState().push(m, 'error'),
  info: (m: string) => useToast.getState().push(m, 'info'),
}
