/**
 * 内网探针（agent）对接路由。
 *
 * 契约（前端依赖，勿改字段名）：
 *
 *   GET  /api/nodes                  → { nodes: NodeRow[] }
 *   POST /api/nodes/discover         body { host?: string, ports?: number[] }
 *                                    → { found: DiscoveredNode[] }
 *   POST /api/nodes                  body { name, base_url, token? } → { node: NodeRow }
 *   PUT  /api/nodes/:id              body { name?, base_url?, token?, enabled? } → { node: NodeRow }
 *   DELETE /api/nodes/:id            → { ok: true }
 *   GET  /api/nodes/:id/services     → { services: ServiceInfo[], checked_at, sources }
 *   POST /api/nodes/:id/sync         body { create?: boolean }
 *                                    → { matched, created, services }
 *
 *   NodeRow = { id, name, base_url, token, services_json, last_seen_at, enabled, created_at }
 *   ServiceInfo = {
 *     name, port, scheme, path?, url_lan, healthy, latency_ms?, process?, source?
 *   }
 *
 * 设计要点（为什么这么写）：
 *   - 探针的 /api/info 刻意不鉴权，所以「发现」这一步才能在内网裸跑；
 *     真正敏感的端口清单走 /api/services，必须带 X-Agent-Token。
 *   - 发现阶段的 host 默认从请求的 Host / X-Forwarded-Host 推导：用户用内网 IP
 *     打开首页，服务端自然就知道该去扫哪个 IP，不用手动填。
 *   - url_lan 的 host 取自 base_url（探针所在机器），端口取服务自己的端口——
 *     两者混用是最容易写错的地方，统一由 withUrlLan() 负责。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getSecrets, getSetting } from '../db/schema.js'
import { readJson } from '../lib/body.js'
import { fromBool, sql } from '../lib/db.js'
import { boolish, num, str } from '../lib/parse.js'
import { guessServiceName } from '../lib/ports.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export const nodeRoutes = new Hono<AppEnv>()

// ── 类型（与前端约定，勿改字段名）────────────────────────────────

export type NodeRow = {
  id: number
  name: string
  base_url: string
  token: string | null
  services_json: string | null
  last_seen_at: number | null
  enabled: number
  created_at: number
  /** 自由备注，服务器面板上显示 */
  note: string | null
  /** JSON 数组字符串，用 parseTags 读 */
  tags: string | null
  /** 管理面板入口的 JSON，用 parsePanel 读 */
  bt_json: string | null
  /** 推模式：探针自报的稳定标识；拉模式为 null */
  agent_id: string | null
  /** 推模式：最近一次上报的指标原文 */
  report_json: string | null
  /** 推模式：该探针密钥的哈希。服务端只验不取回 */
  agent_key_hash: string | null
  /** 推模式：管理员批准了没。未批准时上报一律拒收 */
  approved: number
}

/** 探针返回的单个服务，与 ServiceInfo 的差别只是没有服务端才能算出的 url_lan */
export type AgentService = {
  name: string
  port: number
  scheme: 'http' | 'https'
  path?: string
  healthy: boolean | null
  latency_ms: number | null
  process: string | null
  source: 'scan' | 'config'
}

export type ServiceInfo = AgentService & { url_lan: string }

/** 发现结果比 NodeRow 多两个可选字段：令牌不对时前端要能给出提示 */
export type DiscoveredNode = NodeRow & { error?: string; message?: string }

type AgentInfo = {
  name?: string
  hostname?: string
  version?: string
  agent_port?: number
  lan_ips?: string[]
  platform?: string
  uptime?: number
}

// ── 常量 ────────────────────────────────────────────────────────

/** 发现阶段只探一个 /api/info，1.5 秒足够；不能让一次扫描把请求拖住 */
const INFO_TIMEOUT_MS = 1500
/** 拉服务列表要等探针扫端口，给宽一点 */
const SERVICES_TIMEOUT_MS = 5000
/** 发现时顺手验证令牌，失败也不影响入库，所以不必等太久 */
const PROBE_TIMEOUT_MS = 3000
/** 候选端口上限，防止前端传一个巨大的数组把服务端拖死 */
const MAX_CANDIDATE_PORTS = 64
const DEFAULT_AGENT_PORT = 9201

/** 标签上限。再多卡片上放不下，筛选也失去意义了 */
const MAX_TAGS = 10
const MAX_TAG_LEN = 24
/** 备注上限；servers.ts 改「本机」备注时也要用同一个值 */
export const MAX_NOTE_LEN = 500

// ── 工具 ────────────────────────────────────────────────────────

/**
 * 规范化标签，接受数组或逗号分隔的字符串。
 *
 * 逗号同时认中英文（`，` 和 `,`）—— 中文输入法下打出来的就是全角逗号，
 * 只认半角的话用户会以为自己没输对。
 * 顺带做去空白、截断、忽略大小写去重（保留先出现的那个写法）。
 */
export function normalizeTags(input: unknown): string[] {
  let raw: unknown[] = []
  if (Array.isArray(input)) raw = input
  else if (typeof input === 'string') raw = input.split(/[,，]/)

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_TAG_LEN)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** 空数组存 null 而不是 '[]'，库里少一堆无意义的空值 */
export function serializeTags(tags: string[]): string | null {
  return tags.length > 0 ? JSON.stringify(tags) : null
}

/** 从库里读出来的 tags 可能脏（手改过库、旧版本），解析失败一律当空 */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    return normalizeTags(JSON.parse(raw))
  } catch {
    return []
  }
}

// ── 管理面板入口（宝塔之类）────────────────────────────────────

/**
 * 一台服务器的管理面板凭据。
 *
 * ⚠️ 密码是**明文存在自己的 SQLite 里**的，和 agent_token / jwt_secret 一样。
 * 这个库本来就在你自己的机器上，但界面上默认打码、点开才显示，
 * 导出数据时也要留意别把它发给别人。
 */
export type PanelCredential = {
  url: string
  user: string
  pass: string
  note: string
}

export const EMPTY_PANEL: PanelCredential = { url: '', user: '', pass: '', note: '' }

const MAX_BT_URL = 500
const MAX_BT_USER = 120
const MAX_BT_PASS = 200
const MAX_BT_NOTE = 300

export function normalizePanel(input: unknown): PanelCredential {
  if (!input || typeof input !== 'object') return { ...EMPTY_PANEL }
  const o = input as Record<string, unknown>
  return {
    url: str(o.url, MAX_BT_URL) ?? '',
    user: str(o.user, MAX_BT_USER) ?? '',
    // 密码**不 trim**：前后空格可能就是密码的一部分
    pass: typeof o.pass === 'string' ? o.pass.slice(0, MAX_BT_PASS) : '',
    note: str(o.note, MAX_BT_NOTE) ?? '',
  }
}

/** 四项全空就存 null，库里少一堆 '{"url":"",...}' */
export function serializePanel(p: PanelCredential): string | null {
  const empty = !p.url && !p.user && !p.pass && !p.note
  return empty ? null : JSON.stringify(p)
}

export function parsePanel(raw: string | null | undefined): PanelCredential {
  if (!raw) return { ...EMPTY_PANEL }
  try {
    return normalizePanel(JSON.parse(raw))
  } catch {
    return { ...EMPTY_PANEL }
  }
}

/** IPv6 要加方括号才能拼进 URL；hostname 已经是 `[::1]` 形式时不要重复加 */
function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** 服务路径统一成 `/xxx`，缺省 `/` */
function servicePath(raw: string | undefined): string {
  if (!raw) return '/'
  return raw.startsWith('/') ? raw : `/${raw}`
}

/**
 * 从请求里推导服务器 IP。
 * 用内网 IP 打开首页时，Host 头就是这个 IP，于是 discover 不传 host 也能扫对机器。
 */
function hostFromRequest(c: Context<AppEnv>): string {
  const candidates = [c.req.header('x-forwarded-host'), c.req.header('host')]
  for (const raw of candidates) {
    if (!raw) continue
    // X-Forwarded-Host 可能是逗号分隔的多级代理链，取第一跳
    const first = raw.split(',')[0] ?? ''
    const host = normalizeHost(first)
    if (host) return host
  }
  return '127.0.0.1'
}

/** 把 `http://1.2.3.4:9200/` / `[::1]:9200` 这类输入收敛成纯主机名 */
function normalizeHost(input: string | null): string | null {
  if (!input) return null
  let v = input.trim()
  if (!v) return null
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  v = v.split('/')[0] ?? ''
  if (!v) return null
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    return end === -1 ? null : v.slice(1, end)
  }
  const colon = v.indexOf(':')
  if (colon !== -1) v = v.slice(0, colon)
  if (!v) return null
  // 0.0.0.0 / localhost 不是可连接地址，回落回环
  if (v === '0.0.0.0' || v === '::' || v === 'localhost') return '127.0.0.1'
  return v
}

/** 收敛 base_url：必须有 http(s) 协议、去掉结尾斜杠，保证 UNIQUE 约束下比较一致 */
function normalizeBaseUrl(input: unknown): string | null {
  const raw = str(input, 500)
  if (!raw) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/**
 * 候选端口：入参 → 设置项 agent_ports（逗号分隔）→ 默认 9201。
 * 去重并封顶，避免有人传 1..65535 让服务端去扫全网段。
 */
function resolveCandidatePorts(input: unknown): number[] {
  const picked = new Set<number>()

  const add = (v: unknown): void => {
    const n = num(v)
    if (n !== null && n > 0 && n <= 65535) picked.add(n)
  }

  if (Array.isArray(input)) input.forEach(add)
  if (picked.size === 0) {
    for (const part of (getSetting('agent_ports') ?? '').split(',')) add(part.trim())
  }
  if (picked.size === 0) picked.add(DEFAULT_AGENT_PORT)

  return [...picked].slice(0, MAX_CANDIDATE_PORTS)
}

/** 只有真的像探针的 /api/info 才认，避免把随便一个 HTTP 服务登记成节点 */
function isAgentInfo(v: unknown): v is AgentInfo {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.agent_port === 'number' &&
    o.agent_port > 0 &&
    (typeof o.name === 'string' || typeof o.hostname === 'string')
  )
}

type FetchResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number | null; message: string }

/**
 * 请求探针并解析 JSON。
 * 一律带 AbortSignal 超时：探针是内网设备，关机/掉线时 fetch 会挂很久，
 * 不设超时会把首页的请求一起拖死（和 favicon 代理同样的考虑）。
 */
async function fetchAgentJson(url: string, token: string, timeoutMs: number): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/json',
        ...(token ? { 'x-agent-token': token } : {}),
      },
    })
    if (!res.ok) {
      return { ok: false, status: res.status, message: `探针返回 HTTP ${res.status}` }
    }
    return { ok: true, data: (await res.json()) as unknown }
  } catch (err) {
    const e = err as Error
    const message = e.name === 'TimeoutError' ? `探针 ${timeoutMs}ms 内未响应` : e.message
    return { ok: false, status: null, message }
  }
}

/** 把探针的响应体收敛成 AgentService[]，任何脏数据都跳过而不是抛错 */
function parseAgentServices(payload: unknown): AgentService[] {
  if (!payload || typeof payload !== 'object') return []
  const list = (payload as { services?: unknown }).services
  if (!Array.isArray(list)) return []

  const out: AgentService[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const port = num(o.port)
    if (port === null || port <= 0 || port > 65535) continue
    const name = str(o.name, 80) ?? guessServiceName(port)
    const path = str(o.path, 300)
    out.push({
      name,
      port,
      scheme: o.scheme === 'https' ? 'https' : 'http',
      ...(path ? { path } : {}),
      healthy: typeof o.healthy === 'boolean' ? o.healthy : null,
      latency_ms: num(o.latency_ms),
      process: str(o.process, 80),
      source: o.source === 'config' ? 'config' : 'scan',
    })
  }
  return out
}

/**
 * services_json 落库的是字符串，读出来必须能扛住脏数据：
 * 解析失败返回空数组，绝不因为一条坏记录让整个接口 500。
 */
function safeParseServices(json: string | null | undefined): AgentService[] {
  if (!json) return []
  try {
    return parseAgentServices({ services: JSON.parse(json) as unknown })
  } catch {
    return []
  }
}

/** 探针响应里的 sources，非法值一律丢掉 */
function parseSources(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as { sources?: unknown }).sources
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/**
 * 给每个服务补 url_lan。
 * host 必须取自 base_url（探针所在机器），端口必须用服务自己的 port——
 * base_url 里的端口是探针的端口，混用会拼出完全错误的地址。
 */
function withUrlLan(services: AgentService[], baseUrl: string): ServiceInfo[] {
  let host = '127.0.0.1'
  try {
    host = new URL(baseUrl).hostname
  } catch {
    /* base_url 入库时已校验过，这里只是兜底 */
  }
  return services.map((s) => ({
    ...s,
    url_lan: `${s.scheme}://${formatHost(host)}:${s.port}${servicePath(s.path)}`,
  }))
}

function findNode(rawId: string | undefined): NodeRow | undefined {
  const id = Number(rawId)
  if (!Number.isFinite(id)) return undefined
  return sql.get<NodeRow>('SELECT * FROM agent_nodes WHERE id = ?', id)
}

/**
 * 节点实际使用的令牌：节点自己配了就用它的，否则回落到全局 agent_token。
 * 单管理员自部署场景下两者通常就是同一个值，回落能让「发现完直接就能用」。
 */
function tokenFor(node: NodeRow): string {
  return node.token?.trim() || getSecrets().agentToken
}

/** 失败原因尽量说人话，前端可以直接弹给用户看 */
function describeFailure(res: { status: number | null; message: string }): string {
  if (res.status === 401) {
    return '探针拒绝了令牌（HTTP 401）：节点里保存的 token 与探针的 AGENT_TOKEN 不一致，请重新填写。'
  }
  if (res.status === 403) {
    return '探针拒绝了本次来源 IP（HTTP 403）：请检查探针的 AGENT_ALLOW_IPS 白名单是否包含本机内网 IP。'
  }
  return `无法连接探针：${res.message}`
}

/** 从标题取首字符做兜底图标（与 sites.ts 的行为保持一致） */
function initialOf(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return '?'
  const first = Array.from(trimmed)[0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

/** 新建站点时的标题：探针给的是「端口 12345」这种兜底名就换回内置映射表的名字 */
function titleFor(svc: AgentService): string {
  const generic = /^端口\s*\d+$/.test(svc.name.trim())
  const name = generic ? guessServiceName(svc.port) : svc.name
  return (name.trim() || guessServiceName(svc.port)).slice(0, 80)
}

/** 完整地址比较用的键：协议 + 主机 + 端口 + 去掉结尾斜杠的路径 */
function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.hostname.toLowerCase()}:${u.port || defaultPort(u.protocol)}${path}`
  } catch {
    return null
  }
}

/** 主机 + 端口比较用的键，忽略路径（站点自定义了子路径时仍能匹配上） */
function hostPortKey(raw: string): string | null {
  try {
    const u = new URL(raw)
    return `${u.hostname.toLowerCase()}:${u.port || defaultPort(u.protocol)}`
  } catch {
    return null
  }
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80'
}

// ── 节点 CRUD ───────────────────────────────────────────────────

/**
 * 列表里额外带一个 `services` 字段（services_json 安全解析后的数组），
 * 前端不用自己解析 JSON 也不会被脏数据搞崩；NodeRow 原有字段一个没动。
 */
nodeRoutes.get('/nodes', requireAuth, (c) => {
  const rows = sql.all<NodeRow>('SELECT * FROM agent_nodes ORDER BY id ASC')
  return c.json({
    // ⚠️ 这里必须走 toNodeResponse，**不能**直接 `...r` 展开：
    // 那样会把 `agent_key_hash` 原样发给前端（实测出现过），
    // 而且 approved 还是 0/1 数字、tags 还是 JSON 字符串。
    // tags 在库里是 JSON 字符串，toNodeResponse 会解析成数组再给前端。
    nodes: rows.map((r) => ({
      ...toNodeResponse(r),
      services: safeParseServices(r.services_json),
    })),
  })
})

/**
 * 内网自动发现：对候选端口并发请求 /api/info（不需要令牌），命中就入库。
 * 这就是「内网自动获取服务器和对应端口」的入口。
 */
nodeRoutes.post('/nodes/discover', requireAuth, async (c) => {
  const body = await readJson<{ host?: unknown; ports?: unknown }>(c)

  const host = normalizeHost(str(body.host, 200)) ?? hostFromRequest(c)
  const ports = resolveCandidatePorts(body.ports)

  const hits = (
    await Promise.all(
      ports.map(async (port) => {
        const baseUrl = `http://${formatHost(host)}:${port}`
        const res = await fetchAgentJson(`${baseUrl}/api/info`, '', INFO_TIMEOUT_MS)
        if (!res.ok || !isAgentInfo(res.data)) return null
        return { baseUrl, info: res.data }
      }),
    )
  ).filter((v): v is { baseUrl: string; info: AgentInfo } => v !== null)

  // 逐个入库。首次发现时顺手用全局 agent_token 试一次 /api/services：
  // 通了就把清单一起缓存下来（省一次往返），不通也不影响节点入库，
  // 只在返回里加一个 error 说明，让前端提示用户去补令牌。
  const found = (
    await Promise.all(
      hits.map(async (hit): Promise<DiscoveredNode | null> => {
        const existing = sql.get<NodeRow>('SELECT * FROM agent_nodes WHERE base_url = ?', hit.baseUrl)
        if (existing) {
          const touched = Date.now()
          sql.run('UPDATE agent_nodes SET last_seen_at = ? WHERE id = ?', touched, existing.id)
          return { ...existing, last_seen_at: touched }
        }

        const now = Date.now()
        const globalToken = getSecrets().agentToken
        const { lastInsertRowid } = sql.run(
          `INSERT INTO agent_nodes (name, base_url, token, services_json, last_seen_at, enabled, created_at)
           VALUES (?, ?, ?, NULL, ?, 1, ?)`,
          str(hit.info.name, 60) ?? str(hit.info.hostname, 60) ?? `探针 ${hit.baseUrl}`,
          hit.baseUrl,
          globalToken || null,
          now,
          now,
        )
        const created = sql.get<NodeRow>('SELECT * FROM agent_nodes WHERE id = ?', lastInsertRowid)
        if (!created) return null

        const probe = await fetchAgentJson(
          `${hit.baseUrl}/api/services`,
          globalToken,
          PROBE_TIMEOUT_MS,
        )
        if (!probe.ok) {
          return {
            ...created,
            error: probe.status === 401 ? 'agent_unauthorized' : 'agent_unreachable',
            message: describeFailure(probe),
          }
        }

        const services = parseAgentServices(probe.data)
        const touched = Date.now()
        sql.run(
          'UPDATE agent_nodes SET services_json = ?, last_seen_at = ? WHERE id = ?',
          JSON.stringify(services),
          touched,
          created.id,
        )
        return { ...created, services_json: JSON.stringify(services), last_seen_at: touched }
      }),
    )
  ).filter((v): v is DiscoveredNode => v !== null)

  return c.json({ found })
})

/** 手动新增节点（探针在外网/跨网段，自动发现够不着时用） */
nodeRoutes.post('/nodes', requireAuth, async (c) => {
  const body = await readJson<{
    name?: unknown
    base_url?: unknown
    url?: unknown
    token?: unknown
    enabled?: unknown
  }>(c)

  const name = str(body.name, 60)
  if (!name) return c.json({ error: 'bad_request', message: '节点名称不能为空' }, 400)

  const baseUrl = normalizeBaseUrl(body.base_url ?? body.url)
  if (!baseUrl) {
    return c.json({ error: 'bad_request', message: 'base_url 必须是合法的 http/https 地址' }, 400)
  }
  if (sql.get('SELECT id FROM agent_nodes WHERE base_url = ?', baseUrl)) {
    return c.json({ error: 'conflict', message: '该地址的探针节点已存在' }, 409)
  }

  const now = Date.now()
  const { lastInsertRowid } = sql.run(
    `INSERT INTO agent_nodes (name, base_url, token, services_json, last_seen_at, enabled, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
    name,
    baseUrl,
    str(body.token, 200) ?? (getSecrets().agentToken || null),
    fromBool(body.enabled === undefined ? true : boolish(body.enabled)),
    now,
  )
  const node = sql.get<NodeRow>('SELECT * FROM agent_nodes WHERE id = ?', lastInsertRowid)
  return c.json({ node: toNodeResponse(node) }, 201)
})

nodeRoutes.put('/nodes/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'bad_request' }, 400)

  const existing = findNode(c.req.param('id'))
  if (!existing) return c.json({ error: 'not_found', message: '探针节点不存在' }, 404)

  const body = await readJson<{
    name?: unknown
    base_url?: unknown
    token?: unknown
    enabled?: unknown
    note?: unknown
    tags?: unknown
    bt?: unknown
    approved?: unknown
  }>(c)

  const name = body.name === undefined ? existing.name : str(body.name, 60)
  if (!name) return c.json({ error: 'bad_request', message: '节点名称不能为空' }, 400)

  // 注释和标签都是可选的：没传就保持原样，传空字符串/空数组表示清掉
  const note = body.note === undefined ? existing.note : str(body.note, MAX_NOTE_LEN) || null
  const tags = body.tags === undefined ? existing.tags : serializeTags(normalizeTags(body.tags))
  const bt = body.bt === undefined ? existing.bt_json : serializePanel(normalizePanel(body.bt))
  // 批准 / 取消批准推模式探针。拉模式节点没有这个意义，但也无害
  const approved = body.approved === undefined ? existing.approved : fromBool(boolish(body.approved))

  let baseUrl = existing.base_url
  if (body.base_url !== undefined) {
    const next = normalizeBaseUrl(body.base_url)
    if (!next) {
      return c.json({ error: 'bad_request', message: 'base_url 必须是合法的 http/https 地址' }, 400)
    }
    const dup = sql.get<{ id: number }>(
      'SELECT id FROM agent_nodes WHERE base_url = ? AND id <> ?',
      next,
      id,
    )
    if (dup) return c.json({ error: 'conflict', message: '该地址的探针节点已存在' }, 409)
    baseUrl = next
  }

  // 地址变了，之前缓存的清单就是别人的数据了，直接清掉等下次拉取
  const baseChanged = baseUrl !== existing.base_url

  sql.run(
    `UPDATE agent_nodes
        SET name = ?, base_url = ?, token = ?, enabled = ?, services_json = ?,
            note = ?, tags = ?, bt_json = ?, approved = ?
      WHERE id = ?`,
    name,
    baseUrl,
    body.token === undefined ? existing.token : str(body.token, 200),
    body.enabled === undefined ? existing.enabled : fromBool(boolish(body.enabled)),
    baseChanged ? null : existing.services_json,
    note,
    tags,
    bt,
    approved,
    id,
  )

  return c.json({
    node: toNodeResponse(sql.get<NodeRow>('SELECT * FROM agent_nodes WHERE id = ?', id)),
  })
})

/**
 * 统一的节点响应形状：把库里的 tags JSON 字符串解析成数组再给前端。
 * GET /nodes 一直是这么做的，但 POST / PUT 早先直接返回了原始行 ——
 * 同一个字段在不同接口里一个是数组、一个是字符串，前端迟早会踩到。
 */
function toNodeResponse(row: NodeRow | undefined) {
  if (!row) return row
  // agent_key_hash 是敏感字段，**绝不能**出现在给前端的响应里 ——
  // 前端只需要知道「有没有密钥」，不需要哈希本身
  const { agent_key_hash, ...rest } = row
  return {
    ...rest,
    tags: parseTags(row.tags),
    bt: parsePanel(row.bt_json),
    approved: row.approved === 1,
    has_key: Boolean(agent_key_hash),
  }
}

nodeRoutes.delete('/nodes/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'bad_request' }, 400)
  sql.run('DELETE FROM agent_nodes WHERE id = ?', id)
  return c.json({ ok: true })
})

// ── 服务列表 / 同步入库 ─────────────────────────────────────────

nodeRoutes.get('/nodes/:id/services', requireAuth, async (c) => {
  const node = findNode(c.req.param('id'))
  if (!node) return c.json({ error: 'not_found', message: '探针节点不存在' }, 404)

  const res = await fetchAgentJson(
    `${node.base_url}/api/services`,
    tokenFor(node),
    SERVICES_TIMEOUT_MS,
  )
  if (!res.ok) {
    return c.json({ error: 'agent_unreachable', message: describeFailure(res) }, 502)
  }

  const services = parseAgentServices(res.data)
  const checkedAt = Date.now()
  sql.run(
    'UPDATE agent_nodes SET services_json = ?, last_seen_at = ? WHERE id = ?',
    JSON.stringify(services),
    checkedAt,
    node.id,
  )

  return c.json({
    services: withUrlLan(services, node.base_url),
    checked_at: checkedAt,
    sources: parseSources(res.data),
  })
})

/**
 * 把探针扫到的服务对回站点表：
 *   1. url_lan 完全相同（去掉结尾斜杠后）→ 最可信
 *   2. host + 端口相同 → 站点自定义了子路径也能认出来
 * 只有 create=true 才会往「未分组」里塞新站点——默认不动用户的首页。
 */
nodeRoutes.post('/nodes/:id/sync', requireAuth, async (c) => {
  const node = findNode(c.req.param('id'))
  if (!node) return c.json({ error: 'not_found', message: '探针节点不存在' }, 404)

  const body = await readJson<{ create?: unknown }>(c)
  const create = boolish(body.create)

  const res = await fetchAgentJson(
    `${node.base_url}/api/services`,
    tokenFor(node),
    SERVICES_TIMEOUT_MS,
  )
  if (!res.ok) {
    return c.json({ error: 'agent_unreachable', message: describeFailure(res) }, 502)
  }

  const agentServices = parseAgentServices(res.data)
  const services = withUrlLan(agentServices, node.base_url)
  const now = Date.now()
  sql.run(
    'UPDATE agent_nodes SET services_json = ?, last_seen_at = ? WHERE id = ?',
    JSON.stringify(agentServices),
    now,
    node.id,
  )

  const sites = sql.all<{ id: number; url_lan: string | null }>(
    'SELECT id, url_lan FROM sites WHERE url_lan IS NOT NULL',
  )
  const byUrl = new Map<string, number>()
  const byHostPort = new Map<string, number>()
  for (const site of sites) {
    const key = urlKey(site.url_lan ?? '')
    if (key && !byUrl.has(key)) byUrl.set(key, site.id)
    const hp = hostPortKey(site.url_lan ?? '')
    if (hp && !byHostPort.has(hp)) byHostPort.set(hp, site.id)
  }

  const maxOrder =
    sql.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM sites WHERE category_id IS NULL')
      ?.m ?? -1

  let matched = 0
  let created = 0
  let order = maxOrder
  const touchedSites = new Set<number>()

  sql.tx(() => {
    for (const svc of services) {
      const exactKey = urlKey(svc.url_lan)
      const hpKey = hostPortKey(svc.url_lan)
      const exactId = exactKey ? byUrl.get(exactKey) : undefined
      const matchId = exactId ?? (hpKey ? byHostPort.get(hpKey) : undefined)

      if (matchId !== undefined) {
        // 同一个站点只补全一次；重复命中直接跳过，绝不能因此多建一个重复图标
        if (touchedSites.has(matchId)) continue
        touchedSites.add(matchId)
        // 精确命中就用规范地址；只是 host+端口命中时保留站点原有的路径，
        // 不要把用户手填的 /admin 覆盖成 /
        const existingLan = sql.get<{ url_lan: string | null }>(
          'SELECT url_lan FROM sites WHERE id = ?',
          matchId,
        )?.url_lan
        const lan = exactId !== undefined || !existingLan ? svc.url_lan : existingLan
        sql.run(
          `UPDATE sites SET url_lan = ?, lan_port = ?, link_mode = 'auto', updated_at = ?
            WHERE id = ?`,
          lan,
          svc.port,
          now,
          matchId,
        )
        matched += 1
        continue
      }

      if (!create) continue

      order += 1
      const title = titleFor(svc)
      sql.run(
        `INSERT INTO sites (category_id, title, description, url_public, url_lan, lan_port,
                            link_mode, icon_url, icon_text, color, source, sort_order,
                            created_at, updated_at)
         VALUES (NULL, ?, NULL, NULL, ?, ?, 'auto', NULL, ?, NULL, 'agent', ?, ?, ?)`,
        title,
        svc.url_lan,
        svc.port,
        initialOf(title),
        order,
        now,
        now,
      )
      created += 1
    }
  })

  return c.json({ matched, created, services })
})
