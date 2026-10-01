/**
 * API 客户端。
 *
 * access token 只放在模块作用域的内存里 —— 不落 localStorage，
 * 这样即使页面被注入脚本也没法直接把长期凭证偷走。
 * refresh token 在 HttpOnly Cookie 里，JS 读不到。
 *
 * 会话过期时用「静默刷新 + 重放原请求」处理：单飞（single-flight）保证
 * 并发的一堆 401 只会触发一次刷新。
 */
import type { ApiErrorBody } from './types.ts'

let accessToken: string | null = null
let refreshPromise: Promise<boolean> | null = null
let tokenVersion = 0
let expiredVersion = -1

/** 会话彻底失效时要通知外面跳登录页，用订阅而不是硬跳转 */
type Listener = () => void
const expiredListeners = new Set<Listener>()

export function onSessionExpired(fn: Listener): () => void {
  expiredListeners.add(fn)
  return () => expiredListeners.delete(fn)
}

function emitExpired(): void {
  // 同一批失败请求只通知一次，避免多个 bootstrap 相互覆盖登录状态。
  if (expiredVersion === tokenVersion) return
  expiredVersion = tokenVersion
  for (const fn of expiredListeners) fn()
}

export function setAccessToken(token: string | null): void {
  accessToken = token
  tokenVersion += 1
}

export class ApiError extends Error {
  status: number
  code: string
  body: ApiErrorBody

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || '请求失败')
    this.name = 'ApiError'
    this.status = status
    this.code = body.error ?? 'unknown'
    this.body = body
  }
}

/**
 * 从任意异常里取一句能直接给用户看的中文提示。
 *
 * 后端所有错误响应都是 `{ error, message }`，ApiError 的 message 已经是
 * 后端写好的中文，直接用；其它异常（网络断开、代码 bug）才退到兜底文案。
 * 这个三元表达式原本在 33 处各写了一遍。
 */
export function errorMessage(err: unknown, fallback = '操作失败'): string {
  if (err instanceof ApiError) return err.message || fallback
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string' && err) return err
  return fallback
}

/** 刷新会话；并发调用只会真正打一次接口 */
export function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise

  const version = tokenVersion
  refreshPromise = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      })
      // 刷新期间发生登录或退出时，迟到的刷新响应不能覆盖新会话。
      if (version !== tokenVersion) return accessToken !== null
      if (!res.ok) return false
      const data = (await res.json()) as { access_token?: string }
      if (version !== tokenVersion) return accessToken !== null
      if (typeof data.access_token !== 'string' || !data.access_token) return false
      setAccessToken(data.access_token)
      return true
    } catch {
      return version !== tokenVersion && accessToken !== null
    }
  })().finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

export type ApiOptions = {
  /** 401 时是否尝试静默刷新并重放。登录接口本身要关掉 */
  retry?: boolean
  signal?: AbortSignal
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  options: ApiOptions = {},
): Promise<T> {
  const { retry = true } = options
  const signal = options.signal ?? init.signal ?? undefined
  signal?.throwIfAborted()
  const requestTokenVersion = tokenVersion

  const headers = new Headers(init.headers)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  // FormData 必须让浏览器自己带 boundary，手写 Content-Type 会破坏上传
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(path, { ...init, headers, credentials: 'include', signal })

  if (res.status === 401 && retry) {
    signal?.throwIfAborted()
    // 有些旧请求的 401 会在其他请求完成刷新后才返回，直接使用新 token 重试即可。
    const ok = requestTokenVersion !== tokenVersion
      ? accessToken !== null
      : await refreshSession()
    signal?.throwIfAborted()
    if (ok) return api<T>(path, init, { ...options, retry: false })
    if (requestTokenVersion === tokenVersion) emitExpired()
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiErrorBody
    throw new ApiError(res.status, body)
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }

  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const jsonBody = (data: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(data),
})

/** 把 favicon 代理地址拼出来，交给 <img src> 用 */
export function faviconUrl(site: { url_public?: string | null; url_lan?: string | null }): string | null {
  const target = site.url_public || site.url_lan
  if (!target) return null
  return `/api/favicon?url=${encodeURIComponent(target)}`
}
