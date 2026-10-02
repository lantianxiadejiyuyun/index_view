import { useSyncExternalStore } from 'react'
import type { ThemePref } from './settings.ts'

const QUERY = '(prefers-color-scheme: dark)'

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** 工具栏图标、壁纸和页面使用相同的实时系统主题状态。 */
export function useTheme(pref: ThemePref): boolean {
  const systemDark = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false)
  return pref === 'dark' || (pref === 'auto' && systemDark)
}
