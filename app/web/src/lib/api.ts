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
  if (err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(err.message)) {
    return '无法连接服务器，请检查网络后重试'
  }
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string' && err) return err
  return fallback
}

const TRANSIENT_STATUSES = new Set([502, 503, 504])

function networkError(err: unknown, signal?: AbortSignal | null): never {
  signal?.throwIfAborted()
  if (err instanceof TypeError) {
    throw new ApiError(0, { error: 'network_error', message: '无法连接服务器，请检查网络后重试' })
  }
  throw err
}

/** 等待共享操作时，只取消当前调用，不中断其他请求正在使用的会话刷新。 */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** 只有读取请求可以在短暂断网或网关重启时重试一次，写入结果未知时不能重放。 */
async function fetchResponse(path: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const canRetry = method === 'GET' || method === 'HEAD'
  for (let attempt = 0; ; attempt += 1) {
    init.signal?.throwIfAborted()
    try {
      const res = await fetch(path, init)
      init.signal?.throwIfAborted()
      if (!canRetry || attempt > 0 || !TRANSIENT_STATUSES.has(res.status)) return res
      await res.body?.cancel().catch(() => {})
    } catch (err) {
      init.signal?.throwIfAborted()
      if (!canRetry || attempt > 0 || !(err instanceof TypeError)) networkError(err, init.signal)
    }
    await withAbort(new Promise<void>((resolve) => setTimeout(resolve, 250)), init.signal)
  }
}

async function responseError(res: Response): Promise<ApiError> {
  const raw: unknown = await res.json().catch(() => null)
  const body: ApiErrorBody = {}
  if (raw && typeof raw === 'object') {
    const fields = raw as Record<string, unknown>
    if (typeof fields.error === 'string') body.error = fields.error
    if (typeof fields.message === 'string') body.message = fields.message
  }
  if (!body.message && res.status >= 500) body.message = '服务器暂时不可用，请稍后重试'
  return new ApiError(res.status, body)
}

function invalidResponse(): ApiError {
  return new ApiError(0, { error: 'invalid_response', message: '服务器返回了无效数据，请稍后重试' })
}

/** 刷新会话；并发调用只会真正打一次接口 */
export function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise

  const version = tokenVersion
  refreshPromise = (async () => {
    try {
      const res = await fetchResponse('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      })
      // 刷新期间发生登录或退出时，迟到的刷新响应不能覆盖新会话。
      if (version !== tokenVersion) return accessToken !== null
      if (res.status === 401) return false
      if (!res.ok) throw await responseError(res)
      const data: unknown = await res.json().catch(() => { throw invalidResponse() })
      if (version !== tokenVersion) return accessToken !== null
      if (!data || typeof data !== 'object' || !('access_token' in data)
        || typeof data.access_token !== 'string' || !data.access_token) throw invalidResponse()
      setAccessToken(data.access_token)
      return true
    } catch (err) {
      if (version !== tokenVersion) return accessToken !== null
      // 断网、5xx 和无效响应均不能证明会话已失效。
      throw err
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

  const res = await fetchResponse(path, { ...init, headers, credentials: 'include', signal })

  if (res.status === 401 && retry) {
    signal?.throwIfAborted()
    // 有些旧请求的 401 会在其他请求完成刷新后才返回，直接使用新 token 重试即可。
    const ok = requestTokenVersion !== tokenVersion
      ? accessToken !== null
      : await withAbort(refreshSession(), signal)
    signal?.throwIfAborted()
    if (ok) return api<T>(path, init, { ...options, retry: false })
    if (requestTokenVersion === tokenVersion) emitExpired()
  }

  if (!res.ok) {
    const err = await responseError(res)
    signal?.throwIfAborted()
    throw err
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }

  let text: string
  try {
    text = await res.text()
  } catch (err) {
    networkError(err, signal)
  }
  signal?.throwIfAborted()
  try {
    return (text ? JSON.parse(text) : undefined) as T
  } catch {
    throw invalidResponse()
  }
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
