/**
 * 网络环境判断与内网可达性探测。
 *
 * 「公网 / 内网双链路」的第一步就是判断用户现在是从哪个入口打开首页的：
 * 用 192.168.x.x 打开 → 大概率在内网；用域名打开 → 大概率在外面。
 */

const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local
  /^127\./,
]

const PRIVATE_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.intranet', '.corp']

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost') return true
  if (PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return true
  if (PRIVATE_V4.some((re) => re.test(h))) return true
  // IPv6 里的 ULA(fc00::/7) 与 link-local(fe80::/8) 同属内网
  if (h.includes(':')) {
    return /^f[cd]/.test(h) || h.startsWith('fe80')
  }
  return false
}

export type NetMode = 'lan' | 'public'

export function currentNetMode(): NetMode {
  return isPrivateHost(window.location.hostname) ? 'lan' : 'public'
}

/**
 * 探测一个地址在网络层是否可达。
 *
 * 用 `mode: 'no-cors'` 绕开 CORS：拿到的虽然是 opaque 响应、读不到状态码，
 * 但**网络层不可达时 fetch 会直接 reject**，这正好够当存活探针用。
 * 注意自签证书的 https 内网服务会被判为不可达，这是这个方案的已知取舍。
 */
export async function probeReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch(url, {
      mode: 'no-cors',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return true
  } catch {
    return false
  }
}

/** 从当前访问地址推导出服务器 IP，用于内网探针自动发现 */
export function currentServerHost(): string {
  return window.location.hostname
}
