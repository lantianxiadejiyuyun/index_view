import { create } from 'zustand'
import { useApp } from './app.ts'

/**
 * 极简模式：整个首页只剩搜索框。
 *
 * 状态存在 localStorage 而不是服务端设置里 —— 这是**单台设备的专注模式**，
 * 手机上想清爽、桌面上想看到全部图标，是完全合理的用法，不该互相覆盖。
 * （主题那个偏好也是同样的理由存在本地的。）
 */

const KEY = 'hd.minimal'

function initial(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    // 隐私模式 / 禁用存储：当作没开过
    return false
  }
}

type MinimalState = {
  minimal: boolean
  setMinimal: (value: boolean) => void
}

export const useMinimal = create<MinimalState>((set) => ({
  minimal: initial(),

  setMinimal(value) {
    try {
      localStorage.setItem(KEY, value ? '1' : '0')
    } catch {
      // 存不进去也不影响本次使用
    }
    if (value) {
      // 进极简模式会把工具栏一起藏掉，而编辑模式的「完成」按钮在工具栏里。
      // 不顺手关掉的话，退出来会停在一个没有出口的编辑态。
      useApp.getState().setEditMode(false)
    }
    set({ minimal: value })
  },
}))
