import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { sql } from './db.js'
import { parseSubscription, parseSubscriptionUsage } from './subscription-codec.js'
import type { SubscriptionRelayNode } from './subscription-types.js'

const ONLINE_MS = 90_000
const JOB_MS = 120_000
const MAX_CONTENT = 2 * 1024 * 1024
type Body = Record<string, unknown>
export type SubscriptionRelayIdentity = {
  id: number; name: string; agent_id: string | null; agent_key_hash: string | null
  enabled: number; approved: number; last_seen_at: number | null; relay_seen_at: number | null
}
type RelayNode = SubscriptionRelayIdentity
export type SubscriptionRelayJob = { id: string; url: string; expires_at: number }
export type SubscriptionRelayWakeup = { agentId: number; completedJobId?: string }
const wakeups = new Set<(event: SubscriptionRelayWakeup) => void>()
const socketPresence = new Map<number, { owner: object; keyHash: string; seenAt: number }>()
const pollPresence = new Map<number, { keyHash: string; seenAt: number }>()

export function onSubscriptionRelayWork(listener: (event: SubscriptionRelayWakeup) => void): () => void {
  wakeups.add(listener)
  return () => { wakeups.delete(listener) }
}
function wakeSubscriptionRelay(event: SubscriptionRelayWakeup): void {
  for (const listener of wakeups) listener(event)
}

export function subscriptionRelayIdentityValid(identity: SubscriptionRelayIdentity): boolean {
  const current = nodeRow(identity.id)
  return Boolean(current && current.agent_id === identity.agent_id && current.agent_key_hash === identity.agent_key_hash
    && current.enabled === 1 && current.approved === 1 && current.agent_key_hash)
}

export function touchSubscriptionRelaySocket(identity: SubscriptionRelayIdentity, owner: object, now = Date.now()): boolean {
  if (!subscriptionRelayIdentityValid(identity)) return false
  socketPresence.set(identity.id, { owner, keyHash: identity.agent_key_hash!, seenAt: now })
  sql.run('UPDATE agent_nodes SET relay_seen_at = ?, last_seen_at = ? WHERE id = ?', now, now, identity.id)
  return true
}
export function clearSubscriptionRelaySocket(agentId: number, owner: object): void {
  if (socketPresence.get(agentId)?.owner === owner) socketPresence.delete(agentId)
}
function hasRelaySocket(node: RelayNode, now = Date.now()): boolean {
  const presence = socketPresence.get(node.id)
  return Boolean(node.enabled === 1 && node.approved === 1 && presence
    && presence.keyHash === node.agent_key_hash && now - presence.seenAt <= 70_000)
}
type RelaySource = {
  id: number; user_id: number; fetch_agent_id: number | null; enabled: number; revision: number; fetch_revision: number
  refresh_interval_minutes: number; updated_at: number; url: string
}
type RelayJob = {
  id: string; source_id: number; agent_id: number; agent_key_hash: string
  source_revision: number; fetch_revision: number; state: 'queued' | 'leased'; created_at: number; expires_at: number
}

export class SubscriptionRelayError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 413 = 400) { super(message) }
}

export async function readRelayBody(c: Context): Promise<Body> {
  const limit = 4 * 1024 * 1024
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > limit) throw new SubscriptionRelayError('探针回传内容过大', 413)
  const reader = c.req.raw.body?.getReader()
  if (!reader) throw new SubscriptionRelayError('请求体无效')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new SubscriptionRelayError('探针回传内容过大', 413)
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body as Body
  } catch { throw new SubscriptionRelayError('请求体必须为 JSON 对象') }
}

function nodeRow(id: number): RelayNode | undefined {
  return sql.get<RelayNode>('SELECT id, name, agent_id, agent_key_hash, enabled, approved, last_seen_at, relay_seen_at FROM agent_nodes WHERE id = ?', id)
}
export function authenticateSubscriptionRelay(body: Body, key: string | undefined): RelayNode {
  if (typeof body.agent_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(body.agent_id) || !key || key.length > 512) {
    throw new SubscriptionRelayError('探针身份或专属密钥无效', 401)
  }
  const node = sql.get<RelayNode>('SELECT id, name, agent_id, agent_key_hash, enabled, approved, last_seen_at, relay_seen_at FROM agent_nodes WHERE agent_id = ?', body.agent_id)
  const actual = createHash('sha256').update(key.trim()).digest()
  const expected = node?.agent_key_hash && /^[a-f0-9]{64}$/i.test(node.agent_key_hash) ? Buffer.from(node.agent_key_hash, 'hex') : null
  if (!node || !expected || !timingSafeEqual(actual, expected)) throw new SubscriptionRelayError('探针专属密钥不正确或已重置', 401)
  if (node.approved !== 1 || node.enabled !== 1) throw new SubscriptionRelayError('探针尚未批准或已停用', 403)
  return node
}

export function listSubscriptionRelayNodes(now = Date.now()): SubscriptionRelayNode[] {
  return sql.all<RelayNode>('SELECT id, name, enabled, approved, agent_key_hash, last_seen_at, relay_seen_at FROM agent_nodes WHERE agent_id IS NOT NULL ORDER BY id').map((node) => {
    const connected = hasRelaySocket(node, now)
    const polled = pollPresence.get(node.id)
    const recentPoll = node.enabled === 1 && node.approved === 1 && polled?.keyHash === node.agent_key_hash && now - polled.seenAt <= ONLINE_MS
    return {
    id: node.id, name: node.name, enabled: node.enabled === 1, approved: node.approved === 1,
    online: node.last_seen_at !== null && now - node.last_seen_at <= ONLINE_MS,
    capable: node.relay_seen_at !== null, last_seen_at: node.last_seen_at,
    relay_transport: connected ? 'wss' : recentPoll ? 'https-poll' : null, relay_connected: connected,
  } })
}

export function validateSubscriptionRelay(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new SubscriptionRelayError('拉取探针 ID 无效')
  const node = nodeRow(value)
  if (!node?.agent_id || node.enabled !== 1 || node.approved !== 1 || !node.agent_key_hash) {
    throw new SubscriptionRelayError('请选择已批准并启用的推送型探针')
  }
  return value
}

export function subscriptionRelayState(sourceId: number, agentId: number | null): { name: string | null; status: 'idle' | 'queued' | 'fetching' } {
  if (agentId === null) return { name: null, status: 'idle' }
  const job = sql.get<{ state: string }>('SELECT state FROM subscription_fetch_jobs WHERE source_id = ?', sourceId)
  return { name: nodeRow(agentId)?.name ?? null, status: job?.state === 'queued' ? 'queued' : job?.state === 'leased' ? 'fetching' : 'idle' }
}

function failSource(row: RelaySource, message: string, now: number): void {
  sql.run(`UPDATE subscription_sources SET last_error = ?, next_fetch_at = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND fetch_revision = ?`, message,
    row.enabled ? now + row.refresh_interval_minutes * 60_000 : null, Math.max(now, row.updated_at + 1), row.id, row.revision, row.fetch_revision)
}

export function expireSubscriptionRelayJobs(now = Date.now()): void {
  const expired = sql.tx(() => {
    const jobs = sql.all<RelayJob>('SELECT * FROM subscription_fetch_jobs WHERE expires_at <= ? LIMIT 1000', now)
    for (const job of jobs) {
      const row = sql.get<RelaySource>('SELECT * FROM subscription_sources WHERE id = ?', job.source_id)
      if (row && row.revision === job.source_revision && row.fetch_revision === job.fetch_revision && row.fetch_agent_id === job.agent_id) {
        failSource(row, '探针未在时限内回传订阅，请检查探针是否在线', now)
      }
      sql.run('DELETE FROM subscription_fetch_jobs WHERE id = ?', job.id)
    }
    return jobs
  })
  for (const job of expired) wakeSubscriptionRelay({ agentId: job.agent_id, completedJobId: job.id })
}

export function queueSubscriptionRelay(row: RelaySource, now = Date.now()): void {
  if (row.fetch_agent_id === null) return
  expireSubscriptionRelayJobs(now)
  sql.tx(() => {
    if (sql.get('SELECT id FROM subscription_fetch_jobs WHERE source_id = ?', row.id)) return
    const claimed = sql.run(`UPDATE subscription_sources SET fetch_revision = fetch_revision + 1, last_attempt_at = ?, next_fetch_at = ?
      WHERE id = ? AND revision = ? AND fetch_revision = ? AND fetch_agent_id = ?`, now,
      row.enabled ? now + row.refresh_interval_minutes * 60_000 : null, row.id, row.revision, row.fetch_revision, row.fetch_agent_id)
    if (!claimed.changes) return
    const current = { ...row, fetch_revision: row.fetch_revision + 1 }
    const node = nodeRow(row.fetch_agent_id!)
    const error = !node ? '指定探针已删除，请重新选择拉取位置'
      : node.approved !== 1 || node.enabled !== 1 || !node.agent_key_hash ? '指定探针尚未批准、已停用或密钥已重置'
      : node.relay_seen_at === null ? '该探针尚不支持订阅回传，请更新并启动新版探针'
      : now - node.relay_seen_at > ONLINE_MS ? '订阅回传探针未在线，请检查探针连接'
      : null
    if (error || !node?.agent_key_hash) { failSource(current, error ?? '探针不可用', now); return }
    sql.run(`INSERT INTO subscription_fetch_jobs (id, source_id, agent_id, agent_key_hash, source_revision, fetch_revision, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`, randomBytes(24).toString('base64url'), row.id, row.fetch_agent_id,
      node.agent_key_hash, row.revision, current.fetch_revision, now, now + JOB_MS)
  })
  wakeSubscriptionRelay({ agentId: row.fetch_agent_id })
}

export function pollSubscriptionRelay(body: Body, key: string | undefined): { job: { id: string; url: string; expires_at: number } | null; server_time: number } {
  const node = authenticateSubscriptionRelay(body, key)
  if (body.version !== 1) throw new SubscriptionRelayError('不支持的订阅回传协议版本')
  const now = Date.now()
  pollPresence.set(node.id, { keyHash: node.agent_key_hash!, seenAt: now })
  sql.run('UPDATE agent_nodes SET relay_seen_at = ?, last_seen_at = ? WHERE id = ?', now, now, node.id)
  // A connected WSS executor owns task delivery for this node. Legacy polls
  // still count as heartbeats, but cannot create a second concurrent lease.
  const job = hasRelaySocket(node, now) ? null : claimSubscriptionRelayJob(node)
  return { job, server_time: now }
}

export function claimSubscriptionRelayJob(identity: SubscriptionRelayIdentity, replayLeased = false): SubscriptionRelayJob | null {
  if (!subscriptionRelayIdentityValid(identity)) throw new SubscriptionRelayError('探针授权已失效', 403)
  const now = Date.now()
  expireSubscriptionRelayJobs(now)
  return sql.tx(() => {
    const leased = sql.get<RelayJob>("SELECT * FROM subscription_fetch_jobs WHERE agent_id = ? AND state = 'leased'", identity.id)
    if (leased && !replayLeased) return null
    const jobs = leased ? [leased] : sql.all<RelayJob>("SELECT * FROM subscription_fetch_jobs WHERE agent_id = ? AND state = 'queued' ORDER BY created_at, id", identity.id)
    for (const job of jobs) {
      const row = sql.get<RelaySource>('SELECT * FROM subscription_sources WHERE id = ?', job.source_id)
      if (!row || row.fetch_agent_id !== identity.id || row.revision !== job.source_revision || row.fetch_revision !== job.fetch_revision || job.agent_key_hash !== identity.agent_key_hash) {
        sql.run('DELETE FROM subscription_fetch_jobs WHERE id = ?', job.id)
        continue
      }
      if (job.state === 'leased') return { id: job.id, url: row.url, expires_at: job.expires_at }
      const claim = sql.run("UPDATE subscription_fetch_jobs SET state = 'leased' WHERE id = ? AND state = 'queued' AND expires_at > ?", job.id, now)
      if (claim.changes) return { id: job.id, url: row.url, expires_at: job.expires_at }
    }
    return null
  })
}

export function subscriptionRelayLeaseIsCurrent(identity: SubscriptionRelayIdentity, jobId: string): boolean {
  return Boolean(sql.get(`SELECT 1 FROM subscription_fetch_jobs AS job
    JOIN subscription_sources AS source ON source.id = job.source_id
    WHERE job.id = ? AND job.agent_id = ? AND job.agent_key_hash = ? AND job.state = 'leased' AND job.expires_at > ?
      AND source.fetch_agent_id = job.agent_id AND source.revision = job.source_revision AND source.fetch_revision = job.fetch_revision`,
    jobId, identity.id, identity.agent_key_hash, Date.now()))
}

const ERROR_MESSAGES: Record<string, string> = {
  NETWORK_UNREACHABLE: '探针无法连接订阅服务器，请检查探针网络',
  CONNECTION_REFUSED: '订阅服务器拒绝了探针连接', CONNECTION_RESET: '订阅服务器重置了探针连接',
  TIMEOUT: '探针拉取订阅超时', DNS_ERROR: '探针无法解析订阅域名', TLS_ERROR: '探针与订阅服务器的 TLS 连接失败',
  HTTP_ERROR: '订阅服务器向探针返回了 HTTP 错误', TOO_LARGE: '探针获取的订阅超过 2 MiB 大小限制',
  INVALID_URL: '探针检测到无效的订阅地址', PRIVATE_ADDRESS: '探针拒绝访问私有或保留网络地址',
  FETCH_FAILED: '探针拉取订阅失败', UNSUPPORTED_ENCODING: '探针不支持订阅服务器的压缩格式',
}

export function acceptSubscriptionRelay(body: Body, key: string | undefined): { ok: true; accepted: boolean } {
  const node = authenticateSubscriptionRelay(body, key)
  if (typeof body.job_id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.job_id)) throw new SubscriptionRelayError('任务 ID 无效')
  const hasError = body.error_code !== undefined
  if (hasError && (typeof body.error_code !== 'string' || !Object.hasOwn(ERROR_MESSAGES, body.error_code))) throw new SubscriptionRelayError('探针错误码无效')
  if (body.http_status !== undefined && (typeof body.http_status !== 'number' || !Number.isInteger(body.http_status) || body.http_status < 100 || body.http_status > 599)) throw new SubscriptionRelayError('HTTP 状态码无效')
  if (body.subscription_userinfo !== undefined && body.subscription_userinfo !== null
    && (typeof body.subscription_userinfo !== 'string' || Buffer.byteLength(body.subscription_userinfo, 'utf8') > 1024 || /[\r\n]/.test(body.subscription_userinfo))) throw new SubscriptionRelayError('订阅用量信息无效')
  let content: string | null = null
  if (hasError) {
    if (body.content_base64 !== undefined) throw new SubscriptionRelayError('失败结果不能同时包含订阅内容')
  } else {
    if (typeof body.content_base64 !== 'string' || !body.content_base64.length || body.content_base64.length > Math.ceil(MAX_CONTENT / 3) * 4
      || body.content_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.content_base64)) throw new SubscriptionRelayError('订阅内容必须为有效 Base64，且解码后不超过 2 MiB')
    const bytes = Buffer.from(body.content_base64, 'base64')
    if (bytes.length > MAX_CONTENT || bytes.toString('base64') !== body.content_base64) throw new SubscriptionRelayError('订阅内容大小或 Base64 编码无效')
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new SubscriptionRelayError('订阅内容不是有效 UTF-8 文本') }
  }
  const accepted = sql.tx(() => {
    const job = sql.get<RelayJob>('SELECT * FROM subscription_fetch_jobs WHERE id = ? AND agent_id = ?', body.job_id as string, node.id)
    const now = Date.now()
    if (!job || job.state !== 'leased' || job.expires_at <= now || job.agent_key_hash !== node.agent_key_hash) return false
    const row = sql.get<RelaySource>('SELECT * FROM subscription_sources WHERE id = ?', job.source_id)
    if (!row || row.fetch_agent_id !== node.id || row.revision !== job.source_revision || row.fetch_revision !== job.fetch_revision) return false
    const finished = Math.max(now, row.updated_at + 1)
    if (hasError) failSource(row, ERROR_MESSAGES[body.error_code as string]!, finished)
    else {
      try {
        const parsed = parseSubscription(content!)
        if (!parsed.proxies.length) throw new Error()
        const usage = parseSubscriptionUsage(typeof body.subscription_userinfo === 'string' ? body.subscription_userinfo : null)
        sql.run(`UPDATE subscription_sources SET proxies_json = ?, proxy_count = ?, warnings_json = ?, usage_json = ?,
          last_success_at = ?, last_error = NULL, next_fetch_at = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND fetch_revision = ? AND fetch_agent_id = ?`,
          JSON.stringify(parsed.proxies), parsed.proxies.length, JSON.stringify(parsed.warnings), usage ? JSON.stringify(usage) : null,
          finished, row.enabled ? finished + row.refresh_interval_minutes * 60_000 : null, finished, row.id, job.source_revision, job.fetch_revision, node.id)
      } catch {
        // Probe bodies are untrusted. Even parser errors must not echo arbitrary
        // remote content or credentials into the management interface.
        failSource(row, '探针回传的订阅无法解析或没有可用节点，请检查上游订阅格式', finished)
      }
    }
    sql.run('DELETE FROM subscription_fetch_jobs WHERE id = ?', job.id)
    return true
  })
  // Even an obsolete task response means this authenticated executor finished
  // that task. Wake its connection after committing the result transaction.
  wakeSubscriptionRelay({ agentId: node.id, completedJobId: body.job_id })
  return { ok: true, accepted }
}
