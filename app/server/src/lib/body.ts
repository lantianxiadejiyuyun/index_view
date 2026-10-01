import type { Context } from 'hono'

/**
 * 安全读取 JSON 请求体。
 *
 * 前端传了畸形 JSON、Content-Type 不对、或者干脆是空 body 时，
 * 统一退化成空对象交给上层做字段校验，而不是抛 500 让用户看到堆栈。
 */
export async function readJson<T extends Record<string, unknown> = Record<string, unknown>>(
  c: Context,
): Promise<T> {
  try {
    const body = await c.req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as T
    return {} as T
  } catch {
    return {} as T
  }
}
