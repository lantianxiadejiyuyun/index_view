import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type TcpNetConnectOpts } from 'node:net'
import { isPublicSubscriptionAddress } from './subscription-fetch.js'

export class LingxiError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 502 | 503 | 504 = 400, readonly code = 'lingxi_error') { super(message) }
}
export function normalizeLingxiBaseUrl(value: unknown, allowPrivate = process.env.LINGXI_ALLOW_PRIVATE_NETWORK === 'true'): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new LingxiError('请输入有效的灵犀服务地址')
  let url: URL
  try { url = new URL(value) } catch { throw new LingxiError('灵犀地址必须是完整的 HTTPS 地址') }
  if (!url.hostname || url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new LingxiError('灵犀地址不能包含账号、查询参数或片段')
  if (url.protocol !== 'https:' && !allowPrivate) throw new LingxiError('灵犀服务必须使用 HTTPS')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!allowPrivate && isIP(hostname) && !isPublicSubscriptionAddress(hostname)) throw new LingxiError('灵犀服务不能使用内网或保留地址')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/i, '')
  if (/%|\/\//.test(url.pathname)) throw new LingxiError('灵犀地址路径无效')
  return url.href.replace(/\/+$/, '')
}

export type LingxiRequest = {
  path: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; query?: Record<string, string>
  body?: Record<string, unknown>; stream?: boolean; signal?: AbortSignal; vaultGrantHash?: string
}
type Options = { allowPrivate?: boolean; timeoutMs?: number; maxBytes?: number }
const endpoints = [
  /^\/me$/, /^\/events(?:\/[1-9]\d*|\/occurrences)?$/, /^\/tasks(?:\/[1-9]\d*)?$/,
  /^\/conversations(?:\/[1-9]\d*(?:\/messages)?)?$/,
  /^\/integrations\/navigation-vault(?:\/items|\/reveal)?$/,
]
export function validateLingxiPath(path: string): void {
  if (!endpoints.some(pattern => pattern.test(path))) throw new LingxiError('不支持的灵犀接口')
}
export async function lingxiAddresses(hostname: string, allowPrivate: boolean, signal: AbortSignal): Promise<LookupAddress[]> {
  signal.throwIfAborted()
  const family = isIP(hostname)
  const addresses = family ? [{ address: hostname, family }] : await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new LingxiError('灵犀连接超时，请稍后重试', 504))
    signal.addEventListener('abort', abort, { once: true })
    lookup(hostname, { all: true, verbatim: true }).then(resolve, () => reject(new LingxiError('无法解析灵犀服务域名', 502)))
      .finally(() => signal.removeEventListener('abort', abort))
  })
  signal.throwIfAborted()
  if (!addresses.length || (!allowPrivate && addresses.some(item => !isPublicSubscriptionAddress(item.address)))) throw new LingxiError('灵犀域名解析到内网或保留地址', 400)
  return addresses
}
function readResponse(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    res.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) { reject(new LingxiError('灵犀返回内容过大', 502)); res.destroy() }
      else chunks.push(chunk)
    })
    res.on('end', () => resolve(Buffer.concat(chunks, size)))
    const fail = () => reject(new LingxiError('灵犀响应中断，请稍后重试', 502))
    res.on('aborted', fail); res.on('error', fail)
  })
}
function upstreamError(status: number, bytes: Buffer, token: string): LingxiError {
  if (status === 401 || status === 403) return new LingxiError('灵犀授权已失效或权限不足，请重新绑定账号', 403, 'lingxi_auth_required')
  if (status === 404) return new LingxiError('灵犀接口或内容不存在，请确认服务已升级并支持导航联动', 404)
  if (status === 429) return new LingxiError('灵犀请求过于频繁，请稍后重试', 429)
  let message = `灵犀服务返回 HTTP ${status}`
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    const candidate = value.message ?? (typeof value.error === 'string' ? value.error : value.error?.message)
    if (typeof candidate === 'string' && candidate.trim()) message = candidate.replaceAll(token, '[已隐藏]').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500)
  } catch { /* Never expose an HTML error page or the credential-bearing URL. */ }
  return new LingxiError(message, status === 400 || status === 409 || status === 413 ? status : 502)
}
/** Fixed endpoints, pinned DNS and no redirects keep the saved credential on its bound origin. */
export async function requestLingxi(baseUrl: string, token: string, input: LingxiRequest, options: Options = {}): Promise<Response> {
  validateLingxiPath(input.path)
  const vaultRead = /^\/integrations\/navigation-vault\/(?:items|reveal)$/.test(input.path)
  if (input.vaultGrantHash !== undefined && (!vaultRead || typeof input.vaultGrantHash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.vaultGrantHash))) throw new LingxiError('密码授权来源校验无效')
  if (vaultRead && !input.vaultGrantHash) throw new LingxiError('密码读取服务尚未完成登记，请稍后重试', 409, 'lingxi_vault_service_not_ready')
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new LingxiError('保存的灵犀 Token 无效，请重新绑定', 503)
  const allowPrivate = options.allowPrivate ?? process.env.LINGXI_ALLOW_PRIVATE_NETWORK === 'true'
  const url = new URL(normalizeLingxiBaseUrl(baseUrl, allowPrivate) + '/api/v1' + input.path)
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value)
  const maxBytes = options.maxBytes ?? (input.stream ? 4 * 1024 * 1024 : 2 * 1024 * 1024)
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? (input.stream ? 180_000 : 30_000)), ...(input.signal ? [input.signal] : [])])
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: LookupAddress[]
  try { addresses = await lingxiAddresses(hostname, allowPrivate, signal) }
  catch (error) { if (error instanceof LingxiError) throw error; throw new LingxiError('灵犀连接超时或已取消', 504) }
  const payload = input.body ? Buffer.from(JSON.stringify(input.body)) : undefined
  if (payload && payload.byteLength > 64 * 1024) throw new LingxiError('灵犀请求内容过大', 413)
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const requestOptions: RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily' | 'autoSelectFamilyAttemptTimeout'> = {
      method: input.method ?? 'GET', signal, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250,
      lookup: (_host, opts, callback) => opts.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family),
      maxHeaderSize: 16 * 1024,
      headers: { Authorization: `Bearer ${token}`, Accept: input.stream ? 'text/event-stream' : 'application/json',
        'Accept-Encoding': 'identity', 'User-Agent': 'HomeDashboard-Lingxi/1',
        ...(input.vaultGrantHash ? { 'X-Navigation-Vault-Grant': input.vaultGrantHash.toLowerCase() } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength } : {}) },
    }
    const req = request(url, requestOptions, async res => {
      const status = res.statusCode ?? 0
      try {
        if (status >= 300 && status < 400) throw new LingxiError('灵犀服务返回重定向，请填写最终服务地址', 502)
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw new LingxiError('灵犀返回了不支持的压缩响应', 502)
        if (Number(res.headers['content-length']) > maxBytes) throw new LingxiError('灵犀返回内容过大', 502)
        if (status < 200 || status >= 300) throw upstreamError(status, await readResponse(res, Math.min(maxBytes, 64 * 1024)), token)
        if (status === 204) { res.resume(); resolve(new Response(null, { status: 204 })); return }
        const contentType = res.headers['content-type'] ?? ''
        if (input.stream) {
          if (!/^text\/event-stream(?:;|$)/i.test(contentType)) throw new LingxiError('灵犀未返回聊天事件流', 502)
          const iterator = res[Symbol.asyncIterator](); let size = 0
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await iterator.next()
                if (chunk.done) { controller.close(); return }
                size += chunk.value.byteLength
                if (size > maxBytes) throw new LingxiError('灵犀聊天响应过大', 502)
                controller.enqueue(new Uint8Array(chunk.value))
              } catch { res.destroy(); controller.error(new LingxiError(signal.aborted ? '灵犀聊天超时或已取消' : '灵犀聊天响应中断', 502)) }
            },
            cancel() { res.destroy(); req.destroy() },
          })
          resolve(new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } }))
        } else {
          if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(contentType)) throw new LingxiError('灵犀未返回有效 JSON，请检查接口版本', 502)
          const bytes = await readResponse(res, maxBytes)
          try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new LingxiError('灵犀返回了无效 JSON', 502) }
          resolve(new Response(bytes, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }))
        }
      } catch (error) { res.destroy(); reject(error) }
    })
    req.on('error', () => reject(new LingxiError(signal.aborted ? '灵犀请求超时或已取消' : '无法连接灵犀服务，请检查地址、网络和 HTTPS 证书', signal.aborted ? 504 : 502)))
    req.end(payload)
  })
}
