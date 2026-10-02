/** Ciphertext-only synchronization with the user's configured dashboard server. */
export class SyncError extends Error {
  constructor(message, { status = 0, code = '', data = null } = {}) {
    super(message)
    this.name = 'SyncError'
    this.status = status
    this.code = code
    this.data = data
  }
}

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.endsWith('.local')) return true
  if (/^(fc|fd)[\da-f]{2}:/.test(h) || /^fe[89ab][\da-f]:/.test(h)) return true
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false
  const octets = h.split('.').map(Number)
  if (octets.some((value) => value > 255)) return false
  return octets[0] === 127 || octets[0] === 10
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
}

export function normalizeServer(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { ok: false, error: '请填写服务器地址' }
  if (/\s/.test(text)) return { ok: false, error: '服务器地址不能包含空格' }
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text)
  let url
  try { url = new URL(hasScheme ? text : `https://${text}`) } catch {
    return { ok: false, error: '地址看不懂，检查一下有没有写错' }
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return { ok: false, error: '请输入 http/https 服务器地址，不含账号、查询参数或片段' }
  }
  if (!hasScheme && isPrivateHost(url.hostname)) url.protocol = 'http:'
  const insecure = url.protocol === 'http:'
  if (insecure && !isPrivateHost(url.hostname)) {
    return { ok: false, error: '公网地址必须用 https，密码数据不能明文过网' }
  }
  return { ok: true, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, insecure }
}

async function call(base, path, { method = 'GET', token, body, timeoutMs = 10000 } = {}) {
  const server = normalizeServer(base)
  if (!server.ok) throw new SyncError(server.error, { code: 'invalid_server' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${server.base}${path}`, {
      method, signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch {
      throw new SyncError('服务器未返回有效 JSON', { status: res.status, code: 'invalid_response' })
    }
    if (!res.ok) {
      throw new SyncError(typeof data?.message === 'string' ? data.message : `服务器返回 ${res.status}`, {
        status: res.status, code: data?.error || String(res.status), data,
      })
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SyncError('服务器响应格式无效', { code: 'invalid_response' })
    }
    return data
  } catch (err) {
    if (err instanceof SyncError) throw err
    throw new SyncError(err?.name === 'AbortError' ? '连服务器超时' : '连不上服务器（地址 / 端口 / 网络或重定向）', { code: 'network' })
  } finally {
    clearTimeout(timer)
  }
}

export async function testConnection(base) {
  const data = await call(base, '/api/health', { timeoutMs: 6000 })
  if (data.ok !== true) throw new SyncError('服务器健康检查未通过', { code: 'invalid_response' })
  return { ok: true, service: typeof data.service === 'string' ? data.service : '' }
}

export async function login(base, username, password, previousToken) {
  const data = await call(base, '/api/auth/login', {
    method: 'POST', token: previousToken, body: { username, password, client: 'extension' },
  })
  if (typeof data.access_token !== 'string' || !data.access_token) throw new SyncError('服务器没返回有效 access_token', { code: 'invalid_response' })
  return { token: data.access_token, user: data.user ?? null }
}

function validVersion(version) {
  return Number.isSafeInteger(version) && version >= 0
}

export async function pull(base, token) {
  const data = await call(base, '/api/vault', { token })
  if (!validVersion(data.version) || (data.blob !== null && typeof data.blob !== 'string')
    || (data.version > 0 && !data.blob) || (data.version === 0 && data.blob !== null)) {
    throw new SyncError('服务器保险库格式无效', { code: 'invalid_response' })
  }
  return { version: data.version, blob: data.blob, updatedAt: data.updated_at ?? null }
}

export async function push(base, token, baseVersion, blob) {
  if (!validVersion(baseVersion)) throw new SyncError('本机同步版本无效', { code: 'invalid_version' })
  if (typeof blob !== 'string' || !blob || new TextEncoder().encode(blob).length > 1024 * 1024) {
    throw new SyncError('保险库密文无效或超过 1 MB', { code: 'invalid_blob' })
  }
  const data = await call(base, '/api/vault', {
    method: 'PUT', token, body: { base_version: baseVersion, blob }, timeoutMs: 20000,
  })
  if (!validVersion(data.version) || data.version !== baseVersion + 1) {
    throw new SyncError('服务器没有确认正确的同步版本，请重新拉取检查', { code: 'invalid_response' })
  }
  return { version: data.version }
}
