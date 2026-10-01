/**
 * 服务器面板的聚合接口。
 *
 *   GET /api/servers   → 本机 + 所有探针节点的实时指标
 *
 * 这里只做「聚合、限时、缓存」，指标本身怎么采在 lib/sysinfo.ts 和探针里
 * （两边是独立实现，因为探针必须是零依赖单文件）。
 *
 * 为什么要在服务端聚合而不是让前端逐个节点去抓：
 *   · 探针令牌不能下发到浏览器
 *   · 前端直接抓内网探针会撞跨域
 *   · 多开几个页面就会把每台探针打成轮询靶子，这里统一加 3 秒缓存
 */
import crypto from 'node:crypto'
import { Hono } from 'hono'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { getSecrets, getSetting, putSetting } from '../db/schema.js'
import { collectMetrics, type ServerMetrics } from '../lib/sysinfo.js'
import { str } from '../lib/parse.js'
import { requireAuth } from '../middleware/auth.js'
import type {
  NodeRow,
  PanelCredential,
} from './nodes.js'
import {
  EMPTY_PANEL,
  MAX_NOTE_LEN,
  normalizePanel,
  normalizeTags,
  parsePanel,
  parseTags,
  serializePanel,
  serializeTags,
} from './nodes.js'
import type { AppEnv } from '../types.js'

export const serverRoutes = new Hono<AppEnv>()

/** 单台探针最多等 4 秒。面板是轮询的，一台掉线不能把整页拖住 */
const METRICS_TIMEOUT_MS = 4000

/**
 * 抓取结果缓存 3 秒。前端 5 秒轮询一次，缓存能吸收掉
 * 「多开几个标签页」「手动刷新和自动刷新撞一起」这类重复请求。
 */
const CACHE_TTL_MS = 3000

/**
 * 推模式节点的地址前缀。
 *
 * 推模式的机器在 NAT 后面，面板根本连不进去，所以地址栏不能是真实 URL。
 * 塞一个 `push://<agent_id>` 占住 `base_url`（它是 NOT NULL UNIQUE），
 * 既满足约束，又能让下面一眼认出「这台是推上来的」。
 */
const PUSH_PREFIX = 'push://'

/** 多久没收到上报就算离线。探针默认 10 秒推一次，30 秒能容两次丢包 */
const PUSH_STALE_MS = 30_000

/** 每台探针一把专属密钥，32 字节随机；base64url 之后 43 个字符，够短也好粘 */
function newKey(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** 只存哈希：服务端只需要「验」，不需要「取回」 */
function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

/** 定长比较，避免用 `===` 时被时序侧信道一位位试出密钥 */
function safeEqual(key: string, expectedHash: string): boolean {
  const a = Buffer.from(hashKey(key))
  const b = Buffer.from(expectedHash)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** 「3 分钟」这种人话，离线原因里用 */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return '从未'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.round(s / 60)} 分钟`
  return `${Math.round(s / 3600)} 小时`
}

type ServerEntry = {
  id: number | 'local'
  name: string
  kind: 'local' | 'agent'
  base_url: string
  online: boolean
  error: string | null
  metrics: ServerMetrics | null
  last_seen_at: number | null
  /** pushed = 探针主动上报；pulled = 面板去连它。前端据此显示不同文案 */
  mode: 'local' | 'pulled' | 'pushed'
  /** 推模式专用：管理员批准了没。未批准时面板会显示「批准」按钮 */
  approved: boolean
  /** 用户自己写的备注，服务器面板上显示在名字下面 */
  note: string | null
  /** 用户自己打的标签，用来分组和筛选 */
  tags: string[]
  /** 管理面板（宝塔之类）的入口与凭据 */
  bt: PanelCredential
}

type CachedEntry = { at: number; entry: ServerEntry }
const cache = new Map<number, CachedEntry>()

/** 节点实际使用的令牌：节点自己配了就用它的，否则回落到全局 agent_token */
function tokenFor(node: NodeRow): string {
  return node.token?.trim() || getSecrets().agentToken
}

/** 失败原因尽量说人话，前端直接显示 */
function describeFailure(status: number | null, message: string): string {
  if (status === 401) return '探针拒绝了令牌（401）：节点配置的 token 与探针的 AGENT_TOKEN 不一致'
  if (status === 403) return '探针拒绝了来源 IP（403）：检查探针的 AGENT_ALLOW_IPS 白名单'
  if (status === 404) return '探针版本过旧，没有 /api/metrics 接口，请更新服务器上的探针'
  return `连不上探针：${message}`
}

/**
 * 把 fetch 的底层错误码翻译成人话。
 * Node 只会给一句 `fetch failed`，真正的原因藏在 `err.cause.code` 里 ——
 * 直接把这句丢给用户等于没说。
 */
function explainNetworkError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } }
  if (e?.name === 'TimeoutError') return `探针 ${timeoutMs}ms 内没响应`

  switch (e?.cause?.code) {
    case 'ECONNREFUSED':
      return '连接被拒绝，那台机器上探针没在跑（或者端口不对）'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析不了，检查地址有没有写错'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return '网络不可达，当前网络访问不到这台机器'
    case 'ECONNRESET':
      return '连接被重置，中途断了'
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'HTTPS 证书有问题（探针默认是 http，检查地址里的协议）'
    default:
      return e?.cause?.code ?? e?.message ?? '未知错误'
  }
}

/** 探针返回的字段不一定可信，逐项收敛，缺项给安全默认值 */
function parseMetrics(payload: unknown): ServerMetrics | null {
  if (!payload || typeof payload !== 'object') return null
  const o = payload as Record<string, unknown>

  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const orNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

  const rawDisks = Array.isArray(o.disks) ? o.disks : []
  const disks = rawDisks
    .map((d) => {
      if (!d || typeof d !== 'object') return null
      const item = d as Record<string, unknown>
      const mount = typeof item.mount === 'string' ? item.mount : ''
      if (!mount) return null
      return { mount, total: n(item.total), used: n(item.used) }
    })
    .filter((d): d is { mount: string; total: number; used: number } => d !== null)

  const rawLoad = Array.isArray(o.load) ? o.load : null
  const load =
    rawLoad && rawLoad.length === 3 && rawLoad.every((v) => typeof v === 'number')
      ? ([rawLoad[0], rawLoad[1], rawLoad[2]] as [number, number, number])
      : null

  const rawIps = Array.isArray(o.lan_ips) ? o.lan_ips : []
  const lanIps = rawIps
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, 10)

  return {
    hostname: typeof o.hostname === 'string' ? o.hostname.slice(0, 120) : '',
    platform: typeof o.platform === 'string' ? o.platform : '',
    arch: typeof o.arch === 'string' ? o.arch : '',
    release: typeof o.release === 'string' ? o.release : '',
    cpu_model: typeof o.cpu_model === 'string' ? o.cpu_model.slice(0, 160) : '',
    cpu_cores: n(o.cpu_cores),
    cpu_usage: orNull(o.cpu_usage),
    load,
    mem_total: n(o.mem_total),
    mem_used: n(o.mem_used),
    swap_total: n(o.swap_total),
    swap_used: n(o.swap_used),
    uptime: n(o.uptime),
    disks,
    net_rx_rate: orNull(o.net_rx_rate),
    net_tx_rate: orNull(o.net_tx_rate),
    lan_ips: lanIps,
    public_ip: typeof o.public_ip === 'string' && o.public_ip ? o.public_ip : null,
    collected_at: n(o.collected_at) || Date.now(),
  }
}

/** 抓一台探针的指标。任何异常都收敛成 offline，不往外抛 */
async function fetchNodeMetrics(node: NodeRow): Promise<ServerEntry> {
  const base_mode: 'pulled' | 'pushed' = node.base_url?.startsWith(PUSH_PREFIX) ? 'pushed' : 'pulled'
  const base: Omit<ServerEntry, 'online' | 'error' | 'metrics'> = {
    id: node.id,
    name: node.name,
    kind: 'agent',
    base_url: node.base_url,
    last_seen_at: node.last_seen_at,
    mode: base_mode,
    // 拉模式节点是管理员手动建的，本身就是可信的，一律当作已批准；
    // 「批准」这套只对推模式（自己找上门来的探针）有意义
    approved: base_mode !== 'pushed' || node.approved === 1,
    note: node.note,
    tags: parseTags(node.tags),
    bt: parsePanel(node.bt_json),
  }

  // ── 推模式：指标是探针主动发过来的，不用去连它 ──
  if (base.mode === 'pushed') {
    if (node.enabled !== 1) {
      return { ...base, online: false, error: '这个节点已停用', metrics: null }
    }

    // 未批准：上报会被服务端拒收，所以这里连 report_json 都不用看
    if (node.approved !== 1) {
      return {
        ...base,
        online: false,
        error: node.agent_key_hash
          ? '等待批准 —— 这台探针还连不上，点右上角的「批准」开始接收数据'
          : '探针还没来领密钥（或者密钥被重置了），等它下次启动',
        metrics: null,
      }
    }

    let metrics: ServerMetrics | null = null
    try {
      metrics = node.report_json ? parseMetrics(JSON.parse(node.report_json)) : null
    } catch {
      metrics = null
    }

    if (!metrics) {
      return {
        ...base,
        online: false,
        error: '还没收到过上报 —— 检查那台机器上的探针有没有带 --server= 启动',
        metrics: null,
      }
    }

    const age = node.last_seen_at ? Date.now() - node.last_seen_at : Number.POSITIVE_INFINITY
    if (age > PUSH_STALE_MS) {
      return {
        ...base,
        online: false,
        error: `探针已停止上报（最后一次在 ${formatAge(age)}前），检查那台机器上的服务`,
        metrics: null,
      }
    }

    return { ...base, online: true, error: null, metrics }
  }

  if (!node.base_url?.trim()) {
    return { ...base, online: false, error: '还没填探针地址', metrics: null }
  }
  if (node.enabled !== 1) {
    return { ...base, online: false, error: '这个节点已停用', metrics: null }
  }

  const token = tokenFor(node)
  if (!token) {
    return { ...base, online: false, error: '缺少探针令牌，去「服务对接」里配置', metrics: null }
  }

  let status: number | null = null
  try {
    const res = await fetch(`${node.base_url.replace(/\/+$/, '')}/api/metrics`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
      headers: { accept: 'application/json', 'x-agent-token': token },
    })
    status = res.status
    if (!res.ok) {
      return { ...base, online: false, error: describeFailure(status, `HTTP ${status}`), metrics: null }
    }
    const metrics = parseMetrics(await res.json())
    if (!metrics) {
      return { ...base, online: false, error: '探针返回的指标格式不对', metrics: null }
    }
    return { ...base, online: true, error: null, metrics }
  } catch (err) {
    return {
      ...base,
      online: false,
      error: describeFailure(status, explainNetworkError(err, METRICS_TIMEOUT_MS)),
      metrics: null,
    }
  }
}

/** 命中缓存就直接返回，否则抓一次并写回 */
async function nodeEntry(node: NodeRow): Promise<ServerEntry> {
  const hit = cache.get(node.id)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entry

  const entry = await fetchNodeMetrics(node)
  cache.set(node.id, { at: Date.now(), entry })
  return entry
}

/** 节点被删掉后缓存里会留垃圾，顺手清掉 */
function pruneCache(aliveIds: Set<number>): void {
  for (const id of cache.keys()) {
    if (!aliveIds.has(id)) cache.delete(id)
  }
}

serverRoutes.get('/servers', requireAuth, async (c) => {
  const nodes = sql.all<NodeRow>('SELECT * FROM agent_nodes ORDER BY id ASC')
  pruneCache(new Set(nodes.map((n) => n.id)))

  const local: ServerEntry = {
    id: 'local',
    name: '本机',
    kind: 'local',
    base_url: '',
    online: true,
    error: null,
    metrics: null,
    last_seen_at: null,
    mode: 'local',
    approved: true,
    // 本机在 agent_nodes 里没有记录，备注和标签改存到 settings
    note: getSetting('local_note') || null,
    tags: parseTags(getSetting('local_tags')),
    bt: parsePanel(getSetting('local_bt')),
  }

  // 本机采集和远程抓取并行 —— 本机那次偶尔要等 200ms 做 CPU 二次采样，
  // 串行的话这几百毫秒会白白叠加在总耗时上
  const [localMetrics, nodeEntries] = await Promise.all([
    collectMetrics().catch(() => null),
    Promise.all(nodes.map((n) => nodeEntry(n))),
  ])

  if (localMetrics) {
    local.metrics = localMetrics
  } else {
    local.online = false
    local.error = '本机指标采集失败'
  }

  return c.json({
    servers: [local, ...nodeEntries],
    collected_at: Date.now(),
  })
})

/**
 * 改「本机」的备注与标签。
 *
 * 单独开一个接口而不是复用 `PUT /nodes/:id` —— 本机在 `agent_nodes` 里根本没有行，
 * 硬塞一行假记录会让「节点列表」和「探针发现」那些逻辑都要特殊处理。
 * 存进 settings 更干净：本来就是一个键值表，也不参与节点同步。
 */
serverRoutes.put('/servers/local', requireAuth, async (c) => {
  const body = await readJson<{ note?: unknown; tags?: unknown; bt?: unknown }>(c)

  if (body.note !== undefined) {
    const note = str(body.note, MAX_NOTE_LEN) || ''
    putSetting('local_note', note)
  }
  if (body.tags !== undefined) {
    putSetting('local_tags', serializeTags(normalizeTags(body.tags)) ?? '[]')
  }
  if (body.bt !== undefined) {
    putSetting('local_bt', serializePanel(normalizePanel(body.bt)) ?? '')
  }

  return c.json({
    note: getSetting('local_note') || null,
    tags: parseTags(getSetting('local_tags')),
    bt: parsePanel(getSetting('local_bt')),
  })
})

/**
 * 探针拿共享令牌换一把**专属密钥**（enrollment）。
 *
 * ── 为什么需要这一步 ──
 * 原来所有探针共用同一个 agent_token，服务端只认探针自报的 agent_id ——
 * 意味着**令牌一泄露就能冒充任意节点上报**。改成每台一把密钥之后，
 * 冒充需要先拿到那台的密钥，而不是全局的那一个。
 *
 * ── 为什么还要人工批准 ──
 * 共享令牌仍然能发起 enrollment。所以新密钥**默认不生效**：
 * 得管理员在服务器面板上点「批准」。这样即使令牌泄露，
 * 攻击者最多让面板上多出一条「待批准」，拿不到任何东西。
 *
 * ── 关键防线：已批准的节点不能靠这个接口换密钥 ──
 * 否则拿到共享令牌的人可以重新 enrollment 一把新密钥、顶掉已批准的节点，
 * 整套机制就白做了。要换密钥只能管理员在面板上「重置密钥」（会把节点打回待批准）。
 */
serverRoutes.post('/agent/enroll', async (c) => {
  const expected = getSecrets().agentToken
  const got = c.req.header('x-agent-token')?.trim() ?? ''
  if (!expected || got !== expected) {
    return c.json({ error: 'unauthorized', message: '探针令牌不对' }, 401)
  }

  const body = await readJson<{ agent_id?: unknown; name?: unknown; hostname?: unknown }>(c)
  const agentId = (str(body.agent_id, 120) ?? '').replace(/[^A-Za-z0-9_.:-]/g, '')
  if (!agentId) return c.json({ error: 'bad_request', message: '缺少 agent_id' }, 400)

  const existing = sql.get<NodeRow>('SELECT * FROM agent_nodes WHERE agent_id = ?', agentId)

  if (existing?.approved === 1) {
    return c.json(
      {
        error: 'already_approved',
        message:
          '这台已经批准过了。密钥不会通过这个接口重新下发 —— ' +
          '要换密钥，请在服务器面板上打开该节点、点「重置密钥」。',
      },
      409,
    )
  }

  const key = newKey()
  const hash = hashKey(key)
  const now = Date.now()

  if (existing) {
    // 还没批准，随便换 —— 此时这把密钥本来就没有任何权限
    sql.run('UPDATE agent_nodes SET agent_key_hash = ?, last_seen_at = ? WHERE id = ?', hash, now, existing.id)
    console.log(`[agent] 「${existing.name}」重新领取密钥（仍未批准）`)
    return c.json({ key, approved: false, id: existing.id })
  }

  const name = str(body.name, 60) || str(body.hostname, 60) || agentId
  const { lastInsertRowid } = sql.run(
    `INSERT INTO agent_nodes (name, base_url, token, enabled, created_at, agent_id, agent_key_hash, approved)
     VALUES (?, ?, NULL, 1, ?, ?, ?, 0)`,
    name,
    `${PUSH_PREFIX}${agentId}`,
    now,
    agentId,
    hash,
  )

  console.log(`[agent] 新探针请求接入：${name}（${agentId}）—— 等待在面板上批准`)
  return c.json({ key, approved: false, id: Number(lastInsertRowid) }, 201)
})

/**
 * 探针上报（推模式）。
 *
 * ── 认证 ──
 * 用**该探针自己的密钥**（`X-Agent-Key`），不再是共享令牌。
 * 密钥比对用 `timingSafeEqual`，避免时序侧信道把密钥一位位试出来。
 *
 * 三种拒绝要说清楚区别，否则用户对着日志没法排查：
 *   401 密钥不对 / 节点不存在
 *   403 密钥对但**还没批准**
 *   400 参数问题
 */
serverRoutes.post('/agent/report', async (c) => {
  const body = await readJson<{ agent_id?: unknown; metrics?: unknown }>(c)

  const agentId = (str(body.agent_id, 120) ?? '').replace(/[^A-Za-z0-9_.:-]/g, '')
  const key = c.req.header('x-agent-key')?.trim() ?? ''
  if (!agentId || !key) {
    return c.json({ error: 'bad_request', message: '缺少 agent_id 或 X-Agent-Key' }, 400)
  }

  const node = sql.get<NodeRow>('SELECT * FROM agent_nodes WHERE agent_id = ?', agentId)
  if (!node?.agent_key_hash || !safeEqual(key, node.agent_key_hash)) {
    return c.json({ error: 'unauthorized', message: '密钥不对 —— 该节点不存在，或者密钥已被重置' }, 401)
  }

  if (node.approved !== 1) {
    return c.json(
      {
        error: 'pending_approval',
        message: '这台探针还没被批准。去主程序的「服务器面板」里点一下「批准」即可开始接收数据。',
      },
      403,
    )
  }

  const metrics = parseMetrics(body.metrics)
  // parseMetrics 是**宽容**的（缺项一律给默认值），所以空对象也能过。
  // 这里加一道最低门槛：探针永远会带 hostname，没有就说明这不是一份指标。
  if (!metrics || !metrics.hostname) {
    return c.json({ error: 'bad_request', message: '指标格式不对（至少要有 hostname）' }, 400)
  }

  const now = Date.now()
  // 名字只在第一次登记时取探针报的。之后用户在面板里改过名就尊重用户的，
  // 否则每次上报都会把改名冲掉。
  sql.run(
    'UPDATE agent_nodes SET report_json = ?, last_seen_at = ? WHERE id = ?',
    JSON.stringify(metrics),
    now,
    node.id,
  )
  // 把抓取缓存清掉，否则面板最多 3 秒后才看到这次上报
  // （前端正好是 5 秒一刷，叠起来会有明显延迟感）
  cache.delete(node.id)

  return c.json({ ok: true, id: node.id })
})

/**
 * 重置某台探针的密钥（需要管理员登录）。
 *
 * 用途：探针换机器、重装系统、或者密钥文件丢了。
 * 会把节点打回**未批准**状态 —— 拿到新密钥的人仍然要管理员再点一次批准，
 * 所以这个操作本身不构成提权。
 */
serverRoutes.post('/nodes/:id/reset-key', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad_request' }, 400)

  const node = sql.get<NodeRow>('SELECT * FROM agent_nodes WHERE id = ?', id)
  if (!node) return c.json({ error: 'not_found' }, 404)
  if (!node.agent_id) {
    return c.json({ error: 'bad_request', message: '这是拉模式节点，没有密钥可重置' }, 400)
  }

  sql.run('UPDATE agent_nodes SET agent_key_hash = NULL, approved = 0 WHERE id = ?', id)
  cache.delete(id)
  return c.json({ ok: true, message: '已重置。探针下次启动会重新领取密钥，然后需要你在这里再批准一次。' })
})
