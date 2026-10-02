import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type TcpNetConnectOpts } from 'node:net'
import { isPublicSubscriptionAddress } from './subscription-fetch.js'

export class SubscriptionAiError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 413 | 429 | 502 | 503 = 400) { super(message) }
}
export function normalizeAiBaseUrl(value: unknown, allowPrivate = process.env.AI_ALLOW_PRIVATE_NETWORK === 'true'): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new SubscriptionAiError('请输入有效的 AI 接口地址')
  let url: URL
  try { url = new URL(value) } catch { throw new SubscriptionAiError('AI 接口地址必须是完整的 HTTPS 地址') }
  if (!url.hostname || url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) {
    throw new SubscriptionAiError('AI 接口地址不能包含账号、查询参数或片段')
  }
  if (url.protocol !== 'https:' && !allowPrivate) throw new SubscriptionAiError('AI 接口必须使用 HTTPS；自建服务可配置 AI_ALLOW_PRIVATE_NETWORK=true')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!allowPrivate && isIP(hostname) && !isPublicSubscriptionAddress(hostname)) throw new SubscriptionAiError('AI 接口不能使用内网或保留地址')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '')
  return url.href.replace(/\/+$/, '')
}

export type AiTransportOptions = { allowPrivate?: boolean; timeoutMs?: number; maxBytes?: number }
/** DNS is validated and pinned; bearer credentials are never forwarded to redirects. */
export async function requestAiCompletion(baseUrl: string, apiKey: string, body: Record<string, unknown>, options: AiTransportOptions = {}): Promise<unknown> {
  const allowPrivate = options.allowPrivate ?? process.env.AI_ALLOW_PRIVATE_NETWORK === 'true'
  const url = new URL(normalizeAiBaseUrl(baseUrl, allowPrivate) + '/chat/completions')
  const maxBytes = options.maxBytes ?? 512 * 1024
  const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  const addresses = family ? [{ address: hostname, family }] : await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new SubscriptionAiError('AI 请求超时，请稍后重试', 502))
    signal.addEventListener('abort', abort, { once: true })
    lookup(hostname, { all: true, verbatim: true }).then(resolve, () => reject(new SubscriptionAiError('无法解析 AI 接口域名', 502)))
      .finally(() => signal.removeEventListener('abort', abort))
  })
  if (signal.aborted) throw new SubscriptionAiError('AI 请求超时，请稍后重试', 502)
  if (!addresses.length || (!allowPrivate && addresses.some(item => !isPublicSubscriptionAddress(item.address)))) {
    throw new SubscriptionAiError('AI 接口解析到内网或保留地址；自建服务需配置 AI_ALLOW_PRIVATE_NETWORK=true')
  }
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const requestOptions: RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily' | 'autoSelectFamilyAttemptTimeout'> = {
      method: 'POST', signal, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250,
      lookup: (_hostname, opts, callback) => opts.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family),
      maxHeaderSize: 16 * 1024,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json',
        'Accept-Encoding': 'identity', 'Content-Length': payload.byteLength, 'User-Agent': 'HomeDashboard-AI-Routing/1' },
    }
    const req = request(url, requestOptions, res => {
      const status = res.statusCode ?? 0
      const fail = (message: string, code: 400 | 429 | 502 = 502) => {
        reject(new SubscriptionAiError(message, code)); res.destroy()
      }
      if (status >= 300 && status < 400) return fail('AI 接口返回重定向，请直接填写最终接口地址')
      if (status === 401 || status === 403) return fail('AI 接口拒绝认证，请检查 API Key 和权限', 400)
      if (status === 429) return fail('AI 接口额度不足或请求过于频繁，请稍后重试', 429)
      if (status < 200 || status >= 300) return fail(`AI 接口返回 HTTP ${status}，请检查模型和接口配置`)
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') return fail('AI 接口返回了不支持的压缩响应')
      if (Number(res.headers['content-length']) > maxBytes) return fail('AI 响应过大，请缩小规则需求后重试')
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) fail('AI 响应过大，请缩小规则需求后重试')
        else chunks.push(chunk)
      })
      res.on('error', () => reject(new SubscriptionAiError('AI 响应中断，请稍后重试', 502)))
      res.on('aborted', () => reject(new SubscriptionAiError('AI 响应中断，请稍后重试', 502)))
      res.on('end', () => {
        try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) }
        catch { reject(new SubscriptionAiError('AI 接口未返回有效 JSON，请检查是否为 Chat Completions 兼容接口', 502)) }
      })
    })
    req.on('error', () => reject(new SubscriptionAiError(signal.aborted ? 'AI 请求超时，请稍后重试' : '无法连接 AI 接口，请检查网络、地址和 HTTPS 证书', 502)))
    req.end(payload)
  })
}
