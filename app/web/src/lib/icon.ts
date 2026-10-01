/** 图标相关的纯展示逻辑：首字母兜底与配色。 */

export function initialOf(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return '?'
  const first = Array.from(trimmed)[0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

/** 稳定哈希，保证同一个标题每次拿到的颜色一致 */
function hash(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * 按标题生成一组渐变色，用于没有图标时的首字母底色。
 * 饱和度与明度固定，保证深浅色主题下白字都清晰。
 */
export function letterGradient(seed: string): string {
  const h = hash(seed) % 360
  const h2 = (h + 38) % 360
  return `linear-gradient(135deg, hsl(${h} 68% 52%), hsl(${h2} 70% 42%))`
}

/** 标题里带 emoji 的情况，直接把它当图标更贴切 */
export function emojiOf(title: string): string | null {
  const first = Array.from(title.trim())[0]
  if (!first) return null
  return /\p{Extended_Pictographic}/u.test(first) ? first : null
}
