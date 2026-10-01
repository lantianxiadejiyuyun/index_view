import { api } from './api.ts'

export type SubscriptionUsage = {
  upload: number | null
  download: number | null
  total: number | null
  expires_at: number | null
}

export type SubscriptionSource = {
  id: number
  name: string
  url: string
  note: string
  enabled: boolean
  refresh_interval_minutes: number
  last_attempt_at: number | null
  last_success_at: number | null
  next_fetch_at: number | null
  last_error: string | null
  proxy_count: number
  usage: SubscriptionUsage | null
  warnings: string[]
  fetching: boolean
  fetch_agent_id: number | null
  fetch_agent_name: string | null
  fetch_status: 'idle' | 'queued' | 'fetching'
  created_at: number
  updated_at: number
}

export type SubscriptionRules = {
  include: string[]
  exclude: string[]
  protocols: string[]
  name_prefix: string
  prepend_source: boolean
  append_source: boolean
  deduplicate: boolean
  rules: string[]
}

export type SubscriptionProfile = {
  id: number
  name: string
  note: string
  source_ids: number[]
  rules: SubscriptionRules
  token: string
  enabled: boolean
  created_at: number
  updated_at: number
}

export type SubscriptionOutput = {
  content: string
  content_type: string
  proxy_count: number
  warnings: string[]
}

export type SubscriptionSnapshot = {
  sources: SubscriptionSource[]
  profiles: SubscriptionProfile[]
  relay_nodes: SubscriptionRelayNode[]
  server_time: number
}
export type SubscriptionRelayNode = {
  id: number
  name: string
  enabled: boolean
  approved: boolean
  online: boolean
  capable: boolean
  last_seen_at: number | null
  relay_transport?: 'wss' | 'https-poll' | null
  relay_connected?: boolean
}
export type SourceInput = Pick<SubscriptionSource, 'name' | 'url' | 'note' | 'enabled' | 'refresh_interval_minutes' | 'fetch_agent_id'>
export type ProfileInput = Pick<SubscriptionProfile, 'name' | 'note' | 'source_ids' | 'rules' | 'enabled'>
export type SubscriptionFormat = 'clash' | 'links' | 'base64'
export type SourceNamePosition = 'prepend' | 'append' | 'none'
export const RULE_IMPORT_MAX_BYTES = 1024 * 1024
export const RULE_IMPORT_POLICIES = ['PROXY', 'DIRECT', 'REJECT'] as const
export type RuleImportPolicy = typeof RULE_IMPORT_POLICIES[number]
export type RuleImportInput = { content: string; policy_map?: Record<string, RuleImportPolicy>; default_policy?: RuleImportPolicy }
export type RuleImportResult = {
  format: 'clash' | 'list' | 'payload' | 'text' | 'unknown'
  rules: string[]
  diagnostics: { level: 'error' | 'warning' | 'info'; code: string; message: string; line?: number; column?: number }[]
  policies: { name: string; target: RuleImportPolicy; count: number }[]
  total: number
  imported: number
  can_apply: boolean
}

export const OUTPUT_FORMATS: { value: SubscriptionFormat; label: string; extension: string }[] = [
  { value: 'clash', label: 'Clash / Mihomo YAML', extension: 'yaml' },
  { value: 'links', label: '通用链接列表', extension: 'txt' },
  { value: 'base64', label: 'Base64 链接列表', extension: 'txt' },
]

export const SUBSCRIPTION_PROTOCOLS = [
  'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2',
  'tuic', 'socks5', 'http', 'wireguard', 'snell', 'anytls',
] as const

const ROOT = '/api/subscriptions'
const write = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

export const subscriptions = {
  list: (signal?: AbortSignal) => api<SubscriptionSnapshot>(ROOT, {}, { signal }),
  importRules: (input: RuleImportInput, signal?: AbortSignal) =>
    api<RuleImportResult>(`${ROOT}/rules/import`, write('POST', input), { signal }),
  saveSource: (id: number | null, input: SourceInput, signal?: AbortSignal) =>
    api<{ source: SubscriptionSource }>(`${ROOT}/sources${id === null ? '' : `/${id}`}`, write(id === null ? 'POST' : 'PUT', input), { signal }),
  removeSource: (id: number, signal?: AbortSignal) =>
    api<{ ok: boolean }>(`${ROOT}/sources/${id}`, write('DELETE'), { signal }),
  refreshSource: (id: number, signal?: AbortSignal) =>
    api<{ source: SubscriptionSource }>(`${ROOT}/sources/${id}/refresh`, write('POST'), { signal }),
  refreshAll: (signal?: AbortSignal) =>
    api<{ sources: SubscriptionSource[] }>(`${ROOT}/refresh`, write('POST'), { signal }),
  saveProfile: (id: number | null, input: ProfileInput, signal?: AbortSignal) =>
    api<{ profile: SubscriptionProfile }>(`${ROOT}/profiles${id === null ? '' : `/${id}`}`, write(id === null ? 'POST' : 'PUT', input), { signal }),
  removeProfile: (id: number, signal?: AbortSignal) =>
    api<{ ok: boolean }>(`${ROOT}/profiles/${id}`, write('DELETE'), { signal }),
  rotateToken: (id: number, signal?: AbortSignal) =>
    api<{ profile: SubscriptionProfile }>(`${ROOT}/profiles/${id}/rotate-token`, write('POST'), { signal }),
  preview: (id: number, format: SubscriptionFormat, signal?: AbortSignal) =>
    api<SubscriptionOutput>(`${ROOT}/profiles/${id}/preview?format=${format}`, {}, { signal }),
}

export function ruleImportFileError(file: { name: string; size: number }): string | null {
  if (!/\.(?:ya?ml|txt)$/i.test(file.name)) return '请选择 .yaml、.yml 或 .txt 文件'
  return file.size > RULE_IMPORT_MAX_BYTES ? '规则文件不能超过 1 MiB' : null
}

export function ruleImportContentError(content: string): string | null {
  if (!content.trim()) return '请先选择文件或粘贴规则内容'
  return new TextEncoder().encode(content).byteLength > RULE_IMPORT_MAX_BYTES ? '规则内容不能超过 1 MiB' : null
}

export function canApplyImportedRules(output: RuleImportResult): boolean {
  return output.can_apply && output.rules.length > 0 && !output.diagnostics.some((item) => item.level === 'error')
}

export function sourceInput(source: SubscriptionSource): SourceInput {
  return { name: source.name, url: source.url, note: source.note, enabled: source.enabled, refresh_interval_minutes: source.refresh_interval_minutes, fetch_agent_id: source.fetch_agent_id ?? null }
}

export function sourceFetchMethod(source: SubscriptionSource): string {
  return source.fetch_agent_id == null ? '服务器直接拉取' : `探针 · ${source.fetch_agent_name || `#${source.fetch_agent_id}`}`
}

export function sourceFetchProgress(source: SubscriptionSource): string | null {
  if (source.fetch_status === 'queued') return '等待探针接收'
  if (source.fetch_status === 'fetching' || source.fetching) return source.fetch_agent_id == null ? '正在拉取…' : '探针正在拉取'
  return null
}

export function sourceRefreshFeedback(source: SubscriptionSource): { kind: 'info' | 'error' | 'success'; message: string } {
  if (sourceFetchProgress(source)) {
    return { kind: 'info', message: source.fetch_agent_id == null ? `正在拉取「${source.name}」，请等待结果` : `已交给探针拉取「${source.name}」，等待回传结果` }
  }
  if (source.last_error) return { kind: 'error', message: '拉取失败，请查看订阅源上的错误提示' }
  return { kind: 'success', message: `已更新「${source.name}」的缓存` }
}

export function relayNodeLabel(node: SubscriptionRelayNode): string {
  const state = [!node.approved && '未批准', !node.enabled && '已停用', !node.capable && '需要升级', !node.online && '节点心跳过期', node.capable && relayTransportLabel(node)].filter(Boolean)
  return `${node.name}（${state.join(' · ')}）`
}

export function relayTransportLabel(node: SubscriptionRelayNode): string {
  if (!node.approved || !node.enabled) return '订阅通道不可用'
  if (node.relay_transport === 'wss') return node.relay_connected === true ? 'WSS 已连接' : 'WSS 待连接'
  if (node.relay_transport === 'https-poll') return '旧版 HTTPS 轮询'
  if (node.relay_transport === null) return '待连接'
  return '订阅通道状态未知'
}

export function relayNodeHint(node: SubscriptionRelayNode): string {
  if (!node.approved || !node.enabled) return '当前探针未批准或已停用，无法接收拉取任务。请重新选择可用探针。'
  if (!node.capable) return '此探针需要升级程序以支持订阅拉取。升级并连接后，请重新拉取，或等待下次定时尝试。'
  const metrics = node.online ? '' : '节点心跳最近未更新，请检查探针运行状态。'
  if (node.relay_transport === 'wss' && node.relay_connected === true) return `${metrics}服务器通过 WSS 下发任务；探针获取订阅后通过 HTTPS 回传缓存。`
  if (node.relay_transport === 'wss' || node.relay_transport === null) return `${metrics}订阅任务通道尚未连接，探针会自动重连。连接后请重新拉取，或等待下次定时尝试；该状态与指标上报独立。`
  if (node.relay_transport === 'https-poll') return `${metrics}当前通过旧版 HTTPS 轮询领取任务，结果仍通过 HTTPS 回传。升级至新版探针后可使用 WSS 下发任务。`
  return `${metrics}服务器尚未提供订阅通道状态。任务由所选探针获取内容和流量信息，再回传服务器缓存。`
}

export function profileInput(profile: SubscriptionProfile): ProfileInput {
  return { name: profile.name, note: profile.note, source_ids: profile.source_ids, rules: { ...profile.rules, ...sourceNameRuleFields(sourceNamePosition(profile.rules)) }, enabled: profile.enabled }
}

export function sourceNamePosition(rules: Partial<Pick<SubscriptionRules, 'prepend_source' | 'append_source'>> | null): SourceNamePosition {
  if (rules === null) return 'prepend'
  if (rules.prepend_source === true) return 'prepend'
  return rules.append_source === true ? 'append' : 'none'
}

export function sourceNameRuleFields(position: SourceNamePosition): Pick<SubscriptionRules, 'prepend_source' | 'append_source'> {
  return { prepend_source: position === 'prepend', append_source: position === 'append' }
}

export function sourceNameExample(sourceName: string, prefix: string, position: SourceNamePosition): string {
  const nodeName = `${prefix}香港01`
  if (position === 'prepend') return `[${sourceName}] ${nodeName}`
  return position === 'append' ? `${nodeName} [${sourceName}]` : nodeName
}

export function splitLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
}

export function splitRoutingRules(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function subscriptionFeedUrl(token: string, format: SubscriptionFormat, origin = window.location.origin): string {
  return new URL(`${ROOT}/feed/${encodeURIComponent(token)}?format=${format}`, origin).href
}

export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '未提供'
  if (value === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const index = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1))
  const scaled = value / 1024 ** index
  return `${scaled.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${units[index]}`
}

export function usageSummary(usage: SubscriptionUsage | null) {
  const valid = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value >= 0
  const upload = usage?.upload
  const download = usage?.download
  const total = usage?.total
  const sum = valid(upload) && valid(download) ? upload + download : null
  const used = valid(sum) ? sum : null
  const unlimited = total === 0
  const remaining = valid(total) && total > 0 && used !== null ? Math.max(0, total - used) : null
  return {
    used: formatBytes(used),
    total: unlimited ? '不限流量' : formatBytes(total),
    remaining: unlimited ? '不限流量' : formatBytes(remaining),
    ratio: valid(total) && total > 0 && used !== null ? Math.min(1, used / total) : null,
    exhausted: valid(total) && total > 0 && used !== null && used >= total,
  }
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  const rest = seconds % 60
  return `${days ? `${days} 天 ` : ''}${[hours, minutes, rest].map((n) => String(n).padStart(2, '0')).join(':')}`
}

export function formatExpiry(expiresAt: number | null | undefined, now: number): { text: string; state: 'missing' | 'unlimited' | 'active' | 'expired' } {
  if (expiresAt == null || !Number.isFinite(expiresAt) || expiresAt < 0) return { text: '未提供到期信息', state: 'missing' }
  if (expiresAt === 0) return { text: '长期有效', state: 'unlimited' }
  if (expiresAt <= now) return { text: '已到期', state: 'expired' }
  return { text: `剩余 ${formatDuration(expiresAt - now)}`, state: 'active' }
}

export function formatTimestamp(value: number | null | undefined, empty = '尚无记录'): string {
  if (value == null || !Number.isFinite(value)) return empty
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : empty
}

export function formatNextRefresh(source: SubscriptionSource, now: number): string {
  const progress = sourceFetchProgress(source)
  if (progress) return progress
  if (!source.enabled) return '已暂停定时拉取'
  if (source.next_fetch_at === null) return '等待服务器调度'
  return source.next_fetch_at <= now ? '即将拉取' : `${formatDuration(source.next_fetch_at - now)} 后`
}
