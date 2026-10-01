/**
 * 请求体字段的解析与校验助手。
 *
 * 这些函数原本在 sites / nodes / import 三个路由里各写了一份，
 * 而且**行为不一致**：sites 的 num 会把 `true` 当成 1（Number(true) === 1），
 * nodes 的则会拒掉布尔值。合并到这里时统一取了更严格的那一套 ——
 * 布尔值不该被默默当成端口号存进数据库。
 */

/** 取非空字符串并截断；不是字符串或去空白后为空都返回 null */
export function str(input: unknown, max = 500): string | null {
  if (typeof input !== 'string') return null
  const v = input.trim()
  if (!v) return null
  return v.slice(0, max)
}

/**
 * 取整数。空值、空串、布尔值一律当「没传」返回 null，
 * 其余能转成有限数字的取整。
 */
export function num(input: unknown): number | null {
  if (input === null || input === undefined || input === '' || typeof input === 'boolean') {
    return null
  }
  const n = Number(input)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** 宽松的真值判断，兼容 JSON 的 true、数字 1、字符串 "1" / "true" */
export function boolish(input: unknown): boolean {
  return input === true || input === 1 || input === '1' || input === 'true'
}

/** 从标题里取一个首字母，作为图标抓取失败时的兜底显示 */
export function initialOf(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return '?'
  const first = Array.from(trimmed)[0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}
