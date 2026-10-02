import type { ThemePref } from './settings.ts'

/** 与 index.html 首屏防闪烁脚本共用；这个偏好只属于当前浏览器。 */
export const DEVICE_THEME_KEY = 'hd.theme'

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'auto' || value === 'light' || value === 'dark'
}

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

/** 存储被禁用时仍在当前页面保留选择，不让后续服务端响应覆盖它。 */
export function createDeviceTheme(getStorage: () => ThemeStorage | undefined) {
  let preference: ThemePref | null = null
  try {
    const cached = getStorage()?.getItem(DEVICE_THEME_KEY)
    if (isThemePref(cached)) preference = cached
  } catch { /* 隐私模式可能禁止读取存储 */ }

  function set(value: ThemePref, persist = true): ThemePref {
    preference = value
    if (persist) {
      try { getStorage()?.setItem(DEVICE_THEME_KEY, value) } catch { /* 本次使用仍然生效 */ }
    }
    return value
  }

  return {
    current: () => preference,
    set,
    /** 仅没有本地偏好的旧浏览器继承一次历史设置。 */
    initialize(legacyValue: unknown): ThemePref {
      if (preference !== null) return preference
      return set(isThemePref(legacyValue) ? legacyValue : 'auto')
    },
  }
}

export const deviceTheme = createDeviceTheme(() => globalThis.localStorage)
