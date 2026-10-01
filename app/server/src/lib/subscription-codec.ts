import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { isAlias, isScalar, parseDocument, stringify, visit } from 'yaml'
import type { ParsedSubscription, ProxyNode, SubscriptionInput, SubscriptionOutput, SubscriptionRules, SubscriptionUsage } from './subscription-types.js'

// Share-URI mappings follow the originating implementations/specifications:
// https://shadowsocks.org/doc/sip002.html
// https://hysteria.network/docs/developers/URI-Scheme/
// https://github.com/XTLS/Xray-core/discussions/716
// https://github.com/2dust/v2rayN/tree/master/v2rayN/ServiceLib/Handler/Fmt
// Unknown connection parameters are never discarded to make a URI look valid.
const MAX_BYTES = 2 * 1024 * 1024
const MAX_PROXIES = 5000
const MAX_ITEMS = 150000
const CONTROL = /[\u0000-\u001f\u007f]/u
const BUILTINS = new Set(['PROXY', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'])
const OPTIONAL_UDP_PROTOCOLS = new Set(['ss', 'vmess', 'vless', 'trojan'])
class CodecError extends Error {}
function fail(message: string): never { throw new CodecError(message) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function textValue(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) fail('字符串参数无效')
  return value
}
function requiredText(value: unknown, max = 8192): string {
  const result = textValue(value, max)
  if (!result) fail('缺少必需参数')
  return result
}
function portValue(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) fail('端口无效')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('端口必须在 1–65535 之间')
  return port
}
function serverValue(value: unknown): string {
  const server = requiredText(value, 253)
  if (isIP(server)) return server
  const ascii = domainToASCII(server)
  if (!ascii || !/^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_.])?$/i.test(ascii) || ascii.includes('..')) fail('服务器地址无效')
  return server
}
function cloneTree(value: unknown): unknown {
  let count = 0
  const clone = (item: unknown, depth: number): unknown => {
    if (++count > MAX_ITEMS || depth > 24) fail('订阅结构过大或嵌套过深')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(child => clone(child, depth + 1))
    if (!record(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('订阅含不支持的数据类型')
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype', '<<'].includes(key)) fail('订阅不允许合并键或特殊对象键')
      result[key] = clone(child, depth + 1)
    }
    return result
  }
  return clone(value, 0)
}
function nodeValue(value: unknown, index: number): ProxyNode {
  if (!record(value)) fail('节点必须是对象')
  const type = requiredText(value.type, 32)
  if (!/^[a-z][a-z0-9-]*$/.test(type)) fail('协议类型无效')
  const name = value.name === undefined || value.name === '' ? `${type} ${index + 1}` : requiredText(value.name, 1024)
  if (['ss', 'ssr', 'trojan', 'anytls'].includes(type)) requiredText(value.password)
  if (['ss', 'ssr', 'vmess'].includes(type)) requiredText(value.cipher)
  if (['vmess', 'vless'].includes(type)) requiredText(value.uuid, 128)
  if (type === 'vmess' && (!Number.isInteger(value.alterId) || Number(value.alterId) < 0 || Number(value.alterId) > 65535)) fail('VMess alterId 无效或缺失')
  if (type === 'hysteria2') textValue(value.password)
  if (type === 'tuic') {
    if (value.token !== undefined) {
      requiredText(value.token)
      if (value.uuid !== undefined || value.password !== undefined) fail('TUIC v4/v5 认证参数不能混用')
    } else { requiredText(value.uuid, 128); requiredText(value.password) }
  }
  for (const key of ['udp', 'tls', 'skip-cert-verify']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('节点布尔参数无效')
  for (const key of ['ws-opts', 'grpc-opts', 'reality-opts', 'plugin-opts']) if (value[key] !== undefined && !record(value[key])) fail('节点选项必须是对象')
  return { ...value, name, type, server: serverValue(value.server), port: portValue(value.port) }
}
function warn(warnings: string[], index: number, error: unknown, verb = '读取'): void {
  if (warnings.length < 100) warnings.push(`第 ${index + 1} 个节点未${verb}：${error instanceof CodecError ? error.message : '格式或参数无效'}`)
  else if (warnings.length === 100) warnings.push('更多节点因相同限制被跳过；请检查原订阅。')
}
function decode64(value: string): string {
  const compact = value.replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) fail('Base64 编码无效')
  const bytes = Buffer.from(compact, 'base64url')
  if (bytes.toString('base64url') !== compact.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')) fail('Base64 编码无效')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('订阅必须使用 UTF-8 编码') }
}
function unescape(value: string): string {
  try { return decodeURIComponent(value) } catch { return fail('链接百分号编码无效') }
}
function allowKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some(key => !keys.has(key))) fail('含不能无损转换的参数，请使用 Clash/Mihomo YAML')
}
function bool(value: string): boolean {
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fail('布尔参数无效')
}
function alpn(value: string): string[] {
  const values = value.split(',')
  if (values.some(item => !item || CONTROL.test(item))) fail('ALPN 参数无效')
  return values
}
function uriParts(value: string, defaultPort?: number) {
  if (/%(?![0-9a-f]{2})/i.test(value) || /\s/.test(value)) fail('链接编码无效')
  let url: URL
  try { url = new URL(value) } catch { return fail('链接格式无效') }
  if (url.pathname && url.pathname !== '/') fail('链接路径不受支持')
  const query: Record<string, string> = {}
  for (const [key, val] of url.searchParams) {
    if (Object.hasOwn(query, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('链接含重复或无效参数')
    query[key] = textValue(val)
  }
  const authority = /^[^:]+:\/\/([^/?#]*)/.exec(value)?.[1] || ''
  const at = authority.lastIndexOf('@')
  return {
    url, query, server: serverValue(unescape(url.hostname.replace(/^\[|\]$/g, ''))),
    port: portValue(url.port || defaultPort), name: unescape(url.hash.slice(1)),
    auth: at < 0 ? '' : unescape(authority.slice(0, at)),
  }
}
function applyTransport(node: Record<string, unknown>, network: string, host?: string, path?: string, service?: string): void {
  if (network === 'tcp' || network === 'raw') {
    if (host || path || service) fail('TCP 伪装参数无法无损转换')
    return
  }
  if (network === 'ws') {
    if (service) fail('传输参数不匹配')
    node.network = 'ws'
    node['ws-opts'] = { path: path || '/', ...(host ? { headers: { Host: host } } : {}) }
  } else if (network === 'grpc') {
    if (host || path) fail('gRPC authority 或路径参数无法无损转换')
    node.network = 'grpc'
    node['grpc-opts'] = { 'grpc-service-name': service || '' }
  } else fail('暂不支持该传输方式，请使用 Clash/Mihomo YAML')
}
function applyTls(node: Record<string, unknown>, query: Record<string, string>, security: string): void {
  if (!['none', 'tls', 'reality'].includes(security)) fail('TLS 类型不受支持')
  if (security === 'none') {
    if (['sni', 'alpn', 'fp', 'pbk', 'sid', 'allowInsecure'].some(key => query[key] !== undefined)) fail('TLS 参数与安全类型不匹配')
    return
  }
  node.tls = true
  if (query.sni) node[node.type === 'trojan' ? 'sni' : 'servername'] = query.sni
  if (query.alpn) node.alpn = alpn(query.alpn)
  if (query.fp) node['client-fingerprint'] = query.fp
  if (query.allowInsecure !== undefined) node['skip-cert-verify'] = bool(query.allowInsecure)
  if (security === 'reality') {
    if (node.type !== 'vless') fail('该协议不支持所选 REALITY 配置')
    node['reality-opts'] = { 'public-key': requiredText(query.pbk), ...(query.sid !== undefined ? { 'short-id': query.sid } : {}) }
  } else if (query.pbk !== undefined || query.sid !== undefined) fail('REALITY 参数与安全类型不匹配')
}
function parseVmessJson(value: string): Record<string, unknown> {
  let data: unknown
  try { data = JSON.parse(decode64(value.slice(8))) } catch (error) { if (error instanceof CodecError) throw error; return fail('VMess JSON 格式无效') }
  if (!record(data)) fail('VMess JSON 格式无效')
  allowKeys(data, ['v', 'ps', 'add', 'port', 'id', 'aid', 'scy', 'net', 'type', 'host', 'path', 'tls', 'sni', 'alpn', 'fp', 'insecure'])
  if (data.v !== undefined && String(data.v) !== '2') fail('仅支持 VMess 分享格式 v2')
  const scalar = (key: string, fallback = '') => {
    if (data[key] === undefined) return fallback
    if (typeof data[key] !== 'string' && !(typeof data[key] === 'number' && ['v', 'port', 'aid', 'insecure'].includes(key))) fail('VMess 字段类型无效')
    return textValue(String(data[key]))
  }
  const network = scalar('net', 'tcp')
  if (!['', 'none', ...(network === 'grpc' ? ['gun'] : [])].includes(scalar('type'))) fail('VMess 传输伪装无法无损转换')
  const cipher = scalar('scy', 'auto') || 'auto'
  if (!['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'].includes(cipher)) fail('VMess 加密方式不受支持')
  const aid = Number(scalar('aid', '0'))
  if (!Number.isSafeInteger(aid) || aid < 0 || aid > 65535) fail('VMess alterId 无效')
  const node: Record<string, unknown> = { name: scalar('ps'), type: 'vmess', server: data.add, port: data.port, uuid: requiredText(data.id), alterId: aid, cipher }
  applyTransport(node, network, scalar('host'), network === 'grpc' ? '' : scalar('path'), network === 'grpc' ? scalar('path') : '')
  const query: Record<string, string> = {}
  for (const key of ['sni', 'alpn', 'fp']) if (scalar(key)) query[key] = scalar(key)
  if (data.insecure !== undefined && scalar('insecure') !== '') query.allowInsecure = scalar('insecure')
  const security = scalar('tls') || 'none'
  // The explicit false flag is emitted by clients even for unencrypted VMess.
  if (security === 'none' && query.allowInsecure !== undefined && !bool(query.allowInsecure)) delete query.allowInsecure
  applyTls(node, query, security)
  return node
}
function parseLink(value: string): Record<string, unknown> {
  const scheme = value.slice(0, value.indexOf(':')).toLowerCase()
  if (scheme === 'vmess' && !value.slice(8).includes('@')) return parseVmessJson(value)
  if (scheme === 'ss') {
    let normalized = value
    if (!value.slice(5).split('#')[0]!.includes('@')) {
      const hash = value.indexOf('#')
      const decoded = decode64(value.slice(5, hash < 0 ? undefined : hash))
      const at = decoded.lastIndexOf('@'), colon = decoded.indexOf(':')
      if (colon <= 0 || at <= colon) fail('Shadowsocks 认证格式无效')
      normalized = `ss://${encodeURIComponent(decoded.slice(0, colon))}:${encodeURIComponent(decoded.slice(colon + 1, at))}@${decoded.slice(at + 1)}${hash < 0 ? '' : value.slice(hash)}`
    }
    const part = uriParts(normalized)
    allowKeys(part.query, [])
    const rawAuth = part.url.password || part.auth.includes(':') ? part.auth : decode64(part.auth)
    const colon = rawAuth.indexOf(':')
    if (colon < 1) fail('Shadowsocks 认证格式无效')
    return { name: part.name, type: 'ss', server: part.server, port: part.port, cipher: rawAuth.slice(0, colon), password: requiredText(rawAuth.slice(colon + 1)) }
  }
  if (!['vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic'].includes(scheme)) fail('不支持该链接协议，请使用 Clash/Mihomo YAML')
  const type = scheme === 'hy2' ? 'hysteria2' : scheme
  const part = uriParts(value, ['hysteria2', 'trojan', 'tuic'].includes(type) ? 443 : undefined)
  const q = part.query
  const node: Record<string, unknown> = { name: part.name, type, server: part.server, port: part.port }
  if (type === 'hysteria2') {
    allowKeys(q, ['sni', 'insecure', 'obfs', 'obfs-password', 'pinSHA256'])
    node.password = part.auth
    if (q.sni) node.sni = q.sni
    if (q.insecure !== undefined) node['skip-cert-verify'] = bool(q.insecure)
    if (q.pinSHA256) node.fingerprint = q.pinSHA256
    if (q.obfs) {
      if (!['salamander', 'gecko'].includes(q.obfs)) fail('Hysteria2 混淆方式不受支持')
      node.obfs = q.obfs
      node['obfs-password'] = requiredText(q['obfs-password'])
    } else if (q['obfs-password'] !== undefined) fail('混淆密码缺少对应混淆方式')
    return node
  }
  if (type === 'tuic') {
    allowKeys(q, ['sni', 'alpn', 'allow_insecure', 'congestion_control'])
    const colon = part.auth.indexOf(':')
    if (colon < 1) fail('TUIC v5 需要 UUID 和密码')
    node.uuid = part.auth.slice(0, colon)
    node.password = requiredText(part.auth.slice(colon + 1))
    if (q.sni) node.sni = q.sni
    if (q.alpn) node.alpn = alpn(q.alpn)
    if (q.allow_insecure !== undefined) node['skip-cert-verify'] = bool(q.allow_insecure)
    if (q.congestion_control) {
      if (!['cubic', 'new_reno', 'bbr'].includes(q.congestion_control)) fail('TUIC 拥塞控制参数无效')
      node['congestion-controller'] = q.congestion_control
    }
    return node
  }
  allowKeys(q, ['encryption', 'security', 'sni', 'alpn', 'fp', 'pbk', 'sid', 'allowInsecure', 'flow', 'type', 'headerType', 'host', 'path', 'serviceName', 'mode'])
  node[type === 'trojan' ? 'password' : 'uuid'] = requiredText(part.auth)
  if (type !== 'trojan' && part.auth.includes(':')) fail('UUID 格式无效')
  if (type === 'vless' && q.encryption && q.encryption !== 'none') fail('VLESS 加密参数暂不支持链接转换')
  if (type === 'trojan' && (q.encryption !== undefined || q.flow !== undefined)) fail('Trojan 参数不匹配')
  if (type === 'vmess') {
    if (q.flow !== undefined) fail('VMess 不支持 flow 参数')
    const cipher = q.encryption || 'auto'
    if (!['auto', 'none', 'aes-128-gcm', 'chacha20-poly1305'].includes(cipher)) fail('VMess 加密方式不受支持')
    node.cipher = cipher
    node.alterId = 0
  }
  if (q.flow) {
    if (q.flow !== 'xtls-rprx-vision' || (q.type && !['tcp', 'raw'].includes(q.type))) fail('VLESS flow 参数不受支持')
    node.flow = q.flow
  }
  if (q.headerType && q.headerType !== 'none') fail('传输伪装参数无法无损转换')
  if (q.mode && (q.type !== 'grpc' || q.mode !== 'gun')) fail('传输模式无法无损转换')
  applyTransport(node, q.type || 'tcp', q.host, q.path, q.serviceName)
  const security = q.security || (type === 'trojan' ? 'tls' : 'none')
  if (type === 'trojan' && security !== 'tls') fail('Trojan 需要 TLS')
  if (q.flow && security !== 'tls' && security !== 'reality') fail('VLESS flow 需要 TLS 或 REALITY')
  applyTls(node, q, security)
  // Trojan is always TLS; its Mihomo schema does not need a tls flag.
  if (type === 'trojan') delete node.tls
  return node
}

export function parseSubscription(text: string): ParsedSubscription {
  if (typeof text !== 'string' || !text.trim()) fail('订阅内容为空')
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('订阅内容不能超过 2 MiB')
  let source = text.replace(/^\uFEFF/, '').trim()
  if (/^[A-Za-z0-9+/_=\s-]+$/.test(source)) source = decode64(source).trim()
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const warnings: string[] = []
  const proxies: ProxyNode[] = []
  if (lines.some(line => /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) && !/^\s*(?:proxies:|\{)/.test(source)) {
    if (lines.length > MAX_PROXIES) fail('订阅节点不能超过 5000 个')
    lines.forEach((line, index) => {
      try {
        const node = parseLink(line)
        // Share URIs describe protocol capabilities, not Mihomo's local UDP switch.
        // Mihomo defaults these four protocols to udp:false, so make URI support explicit.
        if (OPTIONAL_UDP_PROTOCOLS.has(String(node.type))) node.udp = true
        proxies.push(nodeValue(node, index))
      } catch (error) { warn(warnings, index, error) }
    })
  } else {
    let data: unknown
    try {
      const document = parseDocument(source, { schema: 'core', version: '1.2', customTags: [], resolveKnownTags: false, merge: false, stringKeys: true, uniqueKeys: true, prettyErrors: false, logLevel: 'silent' })
      if (document.errors.length || document.warnings.length) fail('订阅 YAML 格式无效或含不支持的标签')
      let count = 0
      visit(document, (_key, node, path) => {
        if (++count > MAX_ITEMS || path.length > 48) fail('订阅结构过大或嵌套过深')
        if (isAlias(node)) fail('订阅不支持 YAML alias；请使用展开后的节点列表')
        if (node && typeof node === 'object' && 'tag' in node && node.tag) fail('订阅不支持显式 YAML 标签')
        if (isScalar(node) && node.value === '<<' && _key === 'key') fail('订阅不支持 YAML 合并键')
      })
      data = cloneTree(document.toJS({ maxAliasCount: 0 }))
    } catch (error) {
      if (error instanceof CodecError) throw error
      fail('订阅 YAML 格式无效或结构过深')
    }
    if (!record(data) || !Array.isArray(data.proxies)) fail('订阅必须包含 proxies 节点列表；仅含远程 provider 的配置不受支持')
    if (data.proxies.length > MAX_PROXIES) fail('订阅节点不能超过 5000 个')
    data.proxies.forEach((item, index) => {
      try { proxies.push(nodeValue(item, index)) } catch (error) { warn(warnings, index, error) }
    })
    if (Object.keys(data).some(key => key !== 'proxies')) warnings.push('已提取节点；源配置的分组、路由、DNS 等全局设置不会继承，导出时使用封装配置。')
  }
  if (!proxies.length) fail('订阅中没有可用节点；请检查格式或改用 Clash/Mihomo YAML')
  return { proxies, warnings }
}

export function parseSubscriptionUsage(header: string | null): SubscriptionUsage | null {
  if (!header || header.length > 4096) return null
  const fields = new Map<string, number | null>()
  for (const item of header.split(';')) {
    const match = /^\s*(upload|download|total|expire)\s*=\s*(.*?)\s*$/i.exec(item)
    if (!match) continue
    const key = match[1]!.toLowerCase(), raw = match[2]!
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN
    fields.set(key, fields.has(key) || !Number.isSafeInteger(value) || (key === 'expire' && !Number.isSafeInteger(value * 1000)) ? null : value)
  }
  if (![...fields.values()].some(value => value !== null)) return null
  const expires = fields.get('expire') ?? null
  return { upload: fields.get('upload') ?? null, download: fields.get('download') ?? null, total: fields.get('total') ?? null, expires_at: expires === null ? null : expires * 1000 }
}

export function normalizeRoutingRule(value: string, index: number, last: number): string {
  const parts = value.split(',').map(item => item.trim())
  const type = parts[0]!.toUpperCase()
  const invalid = () => fail(`第 ${index + 1} 条路由规则无效；请检查类型、匹配值、策略和附加参数`)
  if (type === 'MATCH') {
    if (parts.length !== 2 || index !== last || !['PROXY', 'DIRECT', 'REJECT'].includes(parts[1]!)) return invalid()
    return `MATCH,${parts[1]}`
  }
  if (parts.length < 3 || parts.length > 4 || !['PROXY', 'DIRECT', 'REJECT'].includes(parts[2]!)) return invalid()
  const match = parts[1]!
  if (!match || CONTROL.test(match)) return invalid()
  const cidr = ['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR'].includes(type)
  if (parts.length === 4 && (!['IP-CIDR', 'IP-CIDR6', 'GEOIP', 'IP-ASN'].includes(type) || parts[3] !== 'no-resolve')) return invalid()
  if (cidr) {
    const [ip, prefix, extra] = match.split('/')
    const family = isIP(ip || '')
    if (extra !== undefined || !family || prefix === undefined || !/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) return invalid()
    if ((type === 'IP-CIDR' && family !== 4) || (type === 'IP-CIDR6' && family !== 6)) return invalid()
  } else if (['DST-PORT', 'SRC-PORT', 'IN-PORT'].includes(type)) {
    for (const range of match.split('/')) {
      const nums = range.split('-')
      if (nums.length > 2 || nums.some(item => !/^\d+$/.test(item) || Number(item) < 1 || Number(item) > 65535) || Number(nums[0]) > Number(nums[1] ?? nums[0])) return invalid()
    }
  } else if (['DOMAIN', 'DOMAIN-SUFFIX'].includes(type)) {
    try { serverValue(match) } catch { return invalid() }
    if (isIP(match)) return invalid()
  } else if (['GEOIP', 'SRC-GEOIP'].includes(type)) {
    if (!/^(?:[a-z]{2}|LAN)$/i.test(match)) return invalid()
  } else if (['IP-ASN', 'SRC-IP-ASN'].includes(type)) {
    if (!/^\d+$/.test(match) || Number(match) < 1 || Number(match) > 4294967295) return invalid()
  } else if (type === 'NETWORK') {
    if (!['tcp', 'udp'].includes(match.toLowerCase())) return invalid()
    parts[1] = match.toLowerCase()
  } else if (!['DOMAIN-KEYWORD', 'PROCESS-NAME', 'PROCESS-PATH'].includes(type)) return invalid()
  parts[0] = type
  return parts.join(',')
}
export function normalizeSubscriptionRules(input: unknown): SubscriptionRules {
  if (input === undefined) input = {}
  if (!record(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('封装规则必须是对象')
  const allowed = new Set(['include', 'exclude', 'protocols', 'name_prefix', 'prepend_source', 'append_source', 'deduplicate', 'rules'])
  if (Object.keys(input).some(key => !allowed.has(key))) fail('封装规则含未知字段')
  const list = (key: string, fallback: string[], max: number): string[] => {
    const value = input[key]
    if (value === undefined) return [...fallback]
    if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000 || CONTROL.test(item))) fail(`封装规则 ${key} 必须是有效字符串数组`)
    const trimmed = (value as string[]).map(item => item.trim())
    return key === 'rules' ? trimmed : [...new Set(trimmed)]
  }
  const flag = (key: string, fallback: boolean): boolean => {
    if (input[key] === undefined) return fallback
    if (typeof input[key] !== 'boolean') fail(`封装规则 ${key} 必须是布尔值`)
    return input[key] as boolean
  }
  const protocols = list('protocols', [], 64).map(item => item.toLowerCase() === 'hy2' ? 'hysteria2' : item.toLowerCase())
  if (protocols.some(item => !/^[a-z][a-z0-9-]{0,31}$/.test(item))) fail('协议筛选值无效')
  const rules = list('rules', ['MATCH,PROXY'], 1000)
  if (!rules.length || !/^MATCH,/i.test(rules.at(-1)!)) fail('路由规则必须以 MATCH,PROXY、MATCH,DIRECT 或 MATCH,REJECT 结尾')
  const prependSource = flag('prepend_source', false)
  const appendSource = flag('append_source', false)
  if (prependSource && appendSource) fail('来源名称不能同时前置和后置，请只选择一种位置')
  return {
    include: list('include', [], 100), exclude: list('exclude', [], 100), protocols: [...new Set(protocols)],
    name_prefix: input.name_prefix === undefined ? '' : textValue(input.name_prefix, 100),
    prepend_source: prependSource, append_source: appendSource, deduplicate: flag('deduplicate', true),
    rules: rules.map((rule, index) => normalizeRoutingRule(rule, index, rules.length - 1)),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function endpoint(node: ProxyNode): string { return `${isIP(node.server) === 6 ? '[' + node.server + ']' : node.server}:${node.port}` }
function stringField(node: Record<string, unknown>, key: string): string | undefined { return node[key] === undefined ? undefined : textValue(node[key]) }
function alpnField(node: ProxyNode): string | undefined {
  if (node.alpn === undefined) return undefined
  if (!Array.isArray(node.alpn) || !node.alpn.length || node.alpn.some(item => typeof item !== 'string' || !item || item.includes(',') || CONTROL.test(item))) fail('ALPN 参数无法无损转换')
  return node.alpn.join(',')
}
function booleanField(node: ProxyNode, key: string): string | undefined {
  if (node[key] === undefined) return undefined
  if (typeof node[key] !== 'boolean') fail('布尔参数无效')
  return node[key] ? '1' : '0'
}
function toLink(node: ProxyNode): string {
  const basic = ['name', 'type', 'server', 'port', 'udp']
  // UDP is intrinsic in these protocols. Explicitly disabling it is a client option with no share-URI equivalent.
  if (node.udp !== undefined && node.udp !== true) fail('UDP 开关无法无损转换，请使用 Clash/Mihomo YAML')
  const suffix = '#' + encodeURIComponent(node.name)
  if (node.type === 'ss') {
    allowKeys(node, [...basic, 'cipher', 'password'])
    const cipher = requiredText(node.cipher), password = requiredText(node.password)
    const auth = cipher.startsWith('2022-') ? `${encodeURIComponent(cipher)}:${encodeURIComponent(password)}` : Buffer.from(`${cipher}:${password}`).toString('base64url')
    return `ss://${auth}@${endpoint(node)}${suffix}`
  }
  const q = new URLSearchParams()
  const put = (key: string, value: string | undefined) => { if (value !== undefined) q.set(key, value) }
  let auth: string
  if (node.type === 'hysteria2') {
    allowKeys(node, [...basic, 'password', 'sni', 'skip-cert-verify', 'fingerprint', 'obfs', 'obfs-password'])
    auth = encodeURIComponent(textValue(node.password))
    put('sni', stringField(node, 'sni')); put('insecure', booleanField(node, 'skip-cert-verify')); put('pinSHA256', stringField(node, 'fingerprint'))
    if (node.obfs !== undefined) {
      if (node.obfs !== 'salamander' && node.obfs !== 'gecko') fail('Hysteria2 混淆方式不受支持')
      put('obfs', node.obfs); put('obfs-password', requiredText(node['obfs-password']))
    } else if (node['obfs-password'] !== undefined) fail('混淆参数不完整')
  } else if (node.type === 'tuic') {
    allowKeys(node, [...basic, 'uuid', 'password', 'sni', 'alpn', 'skip-cert-verify', 'congestion-controller'])
    auth = `${encodeURIComponent(requiredText(node.uuid))}:${encodeURIComponent(requiredText(node.password))}`
    put('sni', stringField(node, 'sni')); put('alpn', alpnField(node)); put('allow_insecure', booleanField(node, 'skip-cert-verify'))
    if (node['congestion-controller'] !== undefined && !['cubic', 'new_reno', 'bbr'].includes(String(node['congestion-controller']))) fail('TUIC 拥塞控制参数无效')
    put('congestion_control', stringField(node, 'congestion-controller'))
  } else if (['vmess', 'vless', 'trojan'].includes(node.type)) {
    const fields = node.type === 'vmess' ? ['uuid', 'alterId', 'cipher', 'servername'] : node.type === 'vless' ? ['uuid', 'flow', 'servername', 'reality-opts'] : ['password', 'sni']
    allowKeys(node, [...basic, ...fields, 'tls', 'skip-cert-verify', 'alpn', 'client-fingerprint', 'network', 'ws-opts', 'grpc-opts'])
    if (node.tls !== undefined && typeof node.tls !== 'boolean') fail('TLS 开关无效')
    if (node.type === 'trojan' && node.tls === false) fail('Trojan 需要 TLS')
    const security = node['reality-opts'] ? 'reality' : node.tls || node.type === 'trojan' ? 'tls' : 'none'
    const servername = stringField(node, node.type === 'trojan' ? 'sni' : 'servername')
    const alpns = alpnField(node), fingerprint = stringField(node, 'client-fingerprint'), insecure = booleanField(node, 'skip-cert-verify')
    if (security === 'none' && [servername, alpns, fingerprint, insecure].some(item => item !== undefined)) fail('TLS 参数与安全类型不匹配')
    let host: string | undefined, path: string | undefined, service: string | undefined
    const network = node.network === undefined ? 'tcp' : textValue(node.network)
    if (network === 'ws') {
      if (node['grpc-opts'] !== undefined) fail('传输参数不匹配')
      const opts = node['ws-opts'] ?? {}
      if (!record(opts)) fail('WebSocket 参数无效')
      allowKeys(opts, ['path', 'headers'])
      path = stringField(opts, 'path') || '/'
      if (opts.headers !== undefined) {
        if (!record(opts.headers)) fail('WebSocket headers 无效')
        allowKeys(opts.headers, ['Host'])
        host = stringField(opts.headers, 'Host')
      }
    } else if (network === 'grpc') {
      if (node['ws-opts'] !== undefined) fail('传输参数不匹配')
      const opts = node['grpc-opts'] ?? {}
      if (!record(opts)) fail('gRPC 参数无效')
      allowKeys(opts, ['grpc-service-name'])
      service = stringField(opts, 'grpc-service-name') || ''
    } else if (network !== 'tcp' || node['ws-opts'] !== undefined || node['grpc-opts'] !== undefined) fail('传输参数无法无损转换，请使用 Clash/Mihomo YAML')
    if (node.type === 'vmess') {
      const cipher = requiredText(node.cipher), aid = node.alterId ?? 0
      if (!['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'].includes(cipher) || !Number.isInteger(aid) || Number(aid) < 0 || Number(aid) > 65535) fail('VMess 参数无效')
      return 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: node.name, add: node.server, port: String(node.port), id: requiredText(node.uuid), aid: String(aid), scy: cipher, net: network, type: 'none', host: host || '', path: service ?? path ?? '', tls: security === 'none' ? '' : security, ...(servername !== undefined ? { sni: servername } : {}), ...(alpns !== undefined ? { alpn: alpns } : {}), ...(fingerprint !== undefined ? { fp: fingerprint } : {}), ...(insecure !== undefined ? { insecure } : {}) })).toString('base64')
    }
    auth = encodeURIComponent(requiredText(node[node.type === 'trojan' ? 'password' : 'uuid']))
    put('security', security); put('sni', servername); put('alpn', alpns); put('fp', fingerprint); put('allowInsecure', insecure)
    if (node.type === 'vless') {
      put('encryption', 'none')
      if (node.flow !== undefined) {
        if (node.flow !== 'xtls-rprx-vision' || security === 'none' || network !== 'tcp') fail('VLESS flow 参数无效')
        put('flow', node.flow)
      }
      if (node['reality-opts'] !== undefined) {
        const reality = node['reality-opts']
        if (!record(reality) || node.tls !== true) fail('REALITY 参数无效')
        allowKeys(reality, ['public-key', 'short-id'])
        put('pbk', requiredText(reality['public-key'])); put('sid', stringField(reality, 'short-id'))
      }
    }
    put('type', network); put('host', host); put('path', path); put('serviceName', service)
  } else fail('该协议暂不支持通用链接导出，请使用 Clash/Mihomo YAML')
  return `${node.type}://${auth}@${endpoint(node)}${q.size ? '?' + q.toString() : ''}${suffix}`
}

export function buildSubscriptionOutput(inputs: SubscriptionInput[], rules: SubscriptionRules, format: 'clash' | 'links' | 'base64'): SubscriptionOutput {
  const settings = normalizeSubscriptionRules(rules)
  if (!['clash', 'links', 'base64'].includes(format)) fail('导出格式不受支持')
  if (!Array.isArray(inputs) || inputs.length > 100) fail('订阅来源数量无效')
  const warnings: string[] = []
  type Entry = { node: ProxyNode; source: number; original: string; removed: boolean }
  const entries: Entry[] = []
  const names = new Set(BUILTINS)
  const maps = new Map<number, Map<string, Entry | null>>()
  const unique = new Map<string, Entry>()
  let total = 0
  let totalBytes = 0
  for (const [source, input] of inputs.entries()) {
    if (!record(input) || !Array.isArray(input.proxies)) fail('订阅来源节点无效')
    const sourceName = textValue(input.name, 100)
    const map = new Map<string, Entry | null>()
    maps.set(source, map)
    for (const raw of input.proxies) {
      if (++total > MAX_PROXIES) fail('合并节点不能超过 5000 个')
      const node = nodeValue(cloneTree(raw), total - 1)
      totalBytes += Buffer.byteLength(JSON.stringify(node), 'utf8')
      if (totalBytes > MAX_BYTES * 4) fail('合并节点内容不能超过 8 MiB，请缩小来源范围')
      const name = node.name
      if ((settings.include.length && !settings.include.some(word => name.toLowerCase().includes(word.toLowerCase()))) || settings.exclude.some(word => name.toLowerCase().includes(word.toLowerCase())) || (settings.protocols.length && !settings.protocols.includes(node.type))) continue
      const { name: _name, ...fields } = node
      // A dialer reference is source-local; otherwise equal nodes in different sources may route differently.
      const identity = canonical(fields) + (node['dialer-proxy'] === undefined || node['dialer-proxy'] === 'DIRECT' ? '' : `@${source}`)
      let entry = settings.deduplicate ? unique.get(identity) : undefined
      if (!entry) {
        const base = (settings.prepend_source ? `[${sourceName}] ` : '') + settings.name_prefix + name + (settings.append_source ? ` [${sourceName}]` : '')
        if (base.length > 1000) fail('节点名称加上前缀和来源后过长，请缩短名称或前缀')
        let candidate = base, suffix = 2
        while (names.has(candidate)) candidate = `${base} (${suffix++})`
        names.add(candidate)
        node.name = candidate
        entry = { node, source, original: name, removed: false }
        unique.set(identity, entry)
        entries.push(entry)
      }
      if (map.has(name) && map.get(name) !== entry) map.set(name, null)
      else if (!map.has(name)) map.set(name, entry)
    }
  }
  const dependencies = new Map<Entry, Entry>()
  for (const [index, entry] of entries.entries()) {
    const dialer = entry.node['dialer-proxy']
    if (dialer === undefined || dialer === 'DIRECT') continue
    const target = typeof dialer === 'string' ? maps.get(entry.source)?.get(dialer) : undefined
    if (!target || target === entry) {
      entry.removed = true
      warn(warnings, index, new CodecError('链式代理引用缺失、重复或循环，无法保持原连接行为'), '导出')
    } else dependencies.set(entry, target)
  }
  // Reject cycles and chains that lead to a missing/filtered node before rewriting names.
  const resolved = new Set<Entry>()
  for (const [index, entry] of entries.entries()) {
    const path = new Set<Entry>()
    let current: Entry | undefined = entry
    while (current && !resolved.has(current) && !path.has(current) && !current.removed) { path.add(current); current = dependencies.get(current) }
    if (current && (current.removed || path.has(current))) {
      for (const item of path) item.removed = true
      if (path.size) warn(warnings, index, new CodecError('链式代理引用无法使用'), '导出')
    }
    for (const item of path) resolved.add(item)
  }
  for (const [entry, target] of dependencies) if (!entry.removed) entry.node['dialer-proxy'] = target.node.name
  const proxies = entries.filter(entry => !entry.removed).map(entry => entry.node)
  if (!proxies.length) fail('筛选后没有可导出的节点')
  if (format === 'clash') {
    const content = stringify({ 'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'info', proxies, 'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: [...proxies.map(node => node.name), 'DIRECT'] }], rules: settings.rules }, { lineWidth: 0, aliasDuplicateObjects: false })
    return { content, content_type: 'text/yaml; charset=utf-8', proxy_count: proxies.length, warnings }
  }
  const links: string[] = []
  let implicitUdp = false
  proxies.forEach((node, index) => {
    try {
      links.push(toLink(node))
      if (OPTIONAL_UDP_PROTOCOLS.has(node.type) && node.udp === undefined) implicitUdp = true
    } catch (error) { warn(warnings, index, error, '导出') }
  })
  if (!links.length) fail('没有可无损导出为通用链接的节点，请使用 Clash/Mihomo YAML')
  if (implicitUdp) warnings.push('部分节点未显式设置 UDP；通用链接不携带客户端 UDP 开关，重新导入时默认启用 UDP。需要保持 Mihomo 默认关闭行为时请使用 YAML。')
  if (settings.rules.length !== 1 || settings.rules[0] !== 'MATCH,PROXY') warnings.push('通用链接仅包含节点；路由规则只能通过 Clash/Mihomo YAML 导出。')
  const content = links.join('\n') + '\n'
  return { content: format === 'base64' ? Buffer.from(content).toString('base64') : content, content_type: 'text/plain; charset=utf-8', proxy_count: links.length, warnings }
}
