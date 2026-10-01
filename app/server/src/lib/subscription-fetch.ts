import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type TcpNetConnectOpts } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 15_000
const forbidden = new BlockList()
const forbiddenV6 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) forbidden.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) forbiddenV6.addSubnet(address, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicSubscriptionAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !forbidden.check(address, 'ipv4')
  return family === 6 && globalV6.check(address, 'ipv6') && !forbiddenV6.check(address, 'ipv6')
}

/** URLs are credentials: never include an input URL in a thrown/logged error. */
export function validateSubscriptionUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('订阅地址无效或超过 4096 字符')
  }
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入完整的 HTTP 或 HTTPS 订阅地址') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('订阅地址仅支持 HTTP / HTTPS，不能包含用户信息或片段')
  }
  return url.href
}

type FetchResult = { text: string; subscription_userinfo: string | null }
type FetchOptions = { allowPrivate?: boolean; timeoutMs?: number; maxBytes?: number }
type RawResult = { status: number; headers: IncomingHttpHeaders; body: Buffer }

async function requestOnce(url: URL, signal: AbortSignal, allowPrivate: boolean, maxBytes: number): Promise<RawResult> {
  signal.throwIfAborted()
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
      const abort = () => reject(new Error('拉取超时'))
      signal.addEventListener('abort', abort, { once: true })
      lookup(hostname, { all: true, verbatim: true }).then(resolve, () => reject(new Error('无法解析订阅服务器域名')))
        .finally(() => signal.removeEventListener('abort', abort))
    })
  signal.throwIfAborted()
  if (!addresses.length || (!allowPrivate && addresses.some(({ address }) => !isPublicSubscriptionAddress(address)))) {
    throw new Error('订阅地址解析到内网或保留地址；如需自建内网源，请配置 SUBSCRIPTIONS_ALLOW_PRIVATE_NETWORK=true')
  }
  const pinned = addresses[0]!
  // Only connect to checked DNS results, retaining the URL's Host and TLS server
  // name. Let Node fall back between these addresses if one family/endpoint fails.
  // Redirects go through a fresh validation and DNS check.
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const requestOptions: RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily' | 'autoSelectFamilyAttemptTimeout'> = {
      signal,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses)
        else callback(null, pinned.address, pinned.family)
      },
      headers: {
        'user-agent': 'clash.meta',
        accept: 'application/yaml, text/yaml, text/plain, */*',
        'accept-encoding': 'gzip, deflate, br',
      },
      maxHeaderSize: 16 * 1024,
    }
    const req = request(url, requestOptions, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        resolve({ status, headers: res.headers, body: Buffer.alloc(0) })
        res.destroy()
        return
      }
      if (status !== 200) {
        reject(new Error(`上游返回 HTTP ${status}`))
        res.destroy()
        return
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        reject(new Error('订阅内容超过 2 MB 限制'))
        res.destroy()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          reject(new Error('订阅内容超过 2 MB 限制'))
          res.destroy()
        } else chunks.push(chunk)
      })
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', () => reject(new Error('订阅响应中断，请稍后重试')))
      res.on('aborted', () => reject(new Error('订阅响应中断，请稍后重试')))
    })
    req.on('error', (error: NodeJS.ErrnoException & { errors?: NodeJS.ErrnoException[] }) => {
      // Happy Eyeballs may wrap individual failures in AggregateError. Inspect
      // codes only: original messages can contain addresses or URL credentials.
      const codes = new Set([error.code, ...(error.errors ?? []).map((item) => item.code)])
      if (signal.aborted || codes.has('ETIMEDOUT') || codes.has('ERR_SOCKET_CONNECTION_TIMEOUT')) {
        reject(new Error('拉取超时，请检查服务器出口网络或稍后重试'))
      } else if ([...codes].some((code) => code?.includes('CERT') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
        reject(new Error('订阅服务器的 HTTPS 证书无效'))
      } else if (codes.has('ECONNRESET') || codes.has('EPIPE')) {
        reject(new Error('订阅服务器重置了连接，请检查地址协议或稍后重试'))
      } else if (codes.has('ECONNREFUSED')) {
        reject(new Error('订阅服务器拒绝连接，请检查端口及上游服务状态'))
      } else if (codes.has('ENETUNREACH') || codes.has('EHOSTUNREACH')) {
        reject(new Error('订阅服务器网络不可达，请检查服务器出口网络或 DNS 配置'))
      } else if ([...codes].some((code) => code?.startsWith('ERR_SSL_') || code?.startsWith('ERR_TLS_'))) {
        reject(new Error('HTTPS 握手失败，请检查地址协议与服务器 TLS 配置'))
      } else reject(new Error('无法连接订阅服务器，请检查地址和网络'))
    })
    req.end()
  })
}

export async function fetchSubscription(value: string, options: FetchOptions = {}): Promise<FetchResult> {
  const allowPrivate = options.allowPrivate ?? process.env.SUBSCRIPTIONS_ALLOW_PRIVATE_NETWORK === 'true'
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const signal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
  let url = new URL(validateSubscriptionUrl(value))
  const seen = new Set<string>()
  for (let hop = 0; hop <= 3; hop++) {
    if (seen.has(url.href)) throw new Error('订阅地址发生循环跳转')
    seen.add(url.href)
    const result = await requestOnce(url, signal, allowPrivate, maxBytes)
    if (result.status >= 300 && result.status < 400) {
      if (hop === 3 || !result.headers.location) throw new Error('订阅重定向次数过多或缺少跳转地址')
      let redirect: string
      try { redirect = new URL(result.headers.location, url).href }
      catch { throw new Error('订阅服务器返回了无效的跳转地址') }
      const next = new URL(validateSubscriptionUrl(redirect))
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('不允许订阅从 HTTPS 降级跳转到 HTTP')
      url = next
      continue
    }
    let body = result.body
    const encoding = String(result.headers['content-encoding'] ?? '').trim().toLowerCase()
    try {
      if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: maxBytes })
      else if (encoding === 'deflate') body = inflateSync(body, { maxOutputLength: maxBytes })
      else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: maxBytes })
      else if (encoding && encoding !== 'identity') throw new Error('encoding')
    } catch { throw new Error('订阅压缩格式无效或解压后超过 2 MB 限制') }
    if (body.length > maxBytes) throw new Error('订阅内容超过 2 MB 限制')
    const metadata = result.headers['subscription-userinfo']
    return { text: body.toString('utf8').replace(/^\uFEFF/, ''), subscription_userinfo: Array.isArray(metadata) ? metadata.join(';') : metadata ?? null }
  }
  throw new Error('订阅重定向次数过多')
}
