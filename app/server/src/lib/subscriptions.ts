import { randomBytes } from 'node:crypto'
import { sql } from './db.js'
import { fetchSubscription, validateSubscriptionUrl } from './subscription-fetch.js'
import { buildSubscriptionOutput, normalizeSubscriptionRules, parseSubscription, parseSubscriptionUsage } from './subscription-codec.js'
import type { ProxyNode, SubscriptionOutput, SubscriptionProfile, SubscriptionRules, SubscriptionSource, SubscriptionUsage } from './subscription-types.js'
import { expireSubscriptionRelayJobs, queueSubscriptionRelay, subscriptionRelayState, validateSubscriptionRelay } from './subscription-relay.js'

export type SubscriptionFormat = 'clash' | 'links' | 'base64'
type Body = Record<string, unknown>
type SourceRow = {
  id: number; user_id: number; name: string; url: string; note: string; enabled: number
  refresh_interval_minutes: number; revision: number; fetch_revision: number
  proxy_count: number; proxies_json: string; warnings_json: string; usage_json: string | null
  last_attempt_at: number | null; last_success_at: number | null; next_fetch_at: number | null
  last_error: string | null; created_at: number; updated_at: number
  fetch_agent_id: number | null
}
type SourceMetadataRow = Omit<SourceRow, 'proxies_json' | 'revision' | 'fetch_revision'>
type ProfileRow = {
  id: number; user_id: number; name: string; note: string; source_ids_json: string; rules_json: string
  token: string; enabled: number; created_at: number; updated_at: number
}

export class SubscriptionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503 = 400) { super(message) }
}

const inflight = new Map<string, Promise<void>>()
const slots: Array<() => void> = []
let running = 0
let schedulerTick: Promise<void> | null = null
const keyOf = (userId: number, id: number) => `${userId}:${id}`
const changedAt = (previous: number) => Math.max(Date.now(), previous + 1)

function text(value: unknown, field: string, max: number, optional = false): string {
  if (value === undefined && optional) return ''
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw new SubscriptionError(`${field}${optional ? '' : '不能为空且'}最多 ${max} 个字符`)
  }
  return value.trim()
}
function enabled(value: unknown, fallback = true): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new SubscriptionError('enabled 必须是布尔值')
  return value
}
function interval(value: unknown, fallback = 60): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 5 || value > 10080) {
    throw new SubscriptionError('刷新间隔必须为 5 到 10080 分钟的整数')
  }
  return value
}
function sourceUrl(value: unknown): string {
  const raw = text(value, '订阅地址', 4096)
  try { return validateSubscriptionUrl(raw) }
  catch (err) { throw new SubscriptionError(err instanceof Error ? err.message : '订阅地址无效') }
}
function rules(value: unknown): SubscriptionRules {
  try { return normalizeSubscriptionRules(value) }
  catch (err) { throw new SubscriptionError(err instanceof Error ? err.message : '订阅规则无效') }
}
function sourceRow(userId: number, id: number): SourceRow {
  const row = sql.get<SourceRow>('SELECT * FROM subscription_sources WHERE user_id = ? AND id = ?', userId, id)
  if (!row) throw new SubscriptionError('订阅源不存在', 404)
  return row
}
function profileRow(userId: number, id: number): ProfileRow {
  const row = sql.get<ProfileRow>('SELECT * FROM subscription_profiles WHERE user_id = ? AND id = ?', userId, id)
  if (!row) throw new SubscriptionError('订阅配置不存在', 404)
  return row
}
function sourceView(row: SourceMetadataRow): SubscriptionSource {
  const relay = subscriptionRelayState(row.id, row.fetch_agent_id)
  const fetchStatus = row.fetch_agent_id === null && inflight.has(keyOf(row.user_id, row.id)) ? 'fetching' : relay.status
  return {
    id: row.id, name: row.name, url: row.url, note: row.note, enabled: Boolean(row.enabled),
    refresh_interval_minutes: row.refresh_interval_minutes,
    last_attempt_at: row.last_attempt_at, last_success_at: row.last_success_at,
    next_fetch_at: row.next_fetch_at, last_error: row.last_error,
    proxy_count: row.proxy_count,
    usage: row.usage_json ? JSON.parse(row.usage_json) as SubscriptionUsage : null,
    warnings: JSON.parse(row.warnings_json) as string[], fetching: fetchStatus !== 'idle',
    fetch_agent_id: row.fetch_agent_id, fetch_agent_name: relay.name, fetch_status: fetchStatus,
    created_at: row.created_at, updated_at: row.updated_at,
  }
}
function profileView(row: ProfileRow): SubscriptionProfile {
  return {
    id: row.id, name: row.name, note: row.note, source_ids: JSON.parse(row.source_ids_json) as number[],
    rules: normalizeSubscriptionRules(JSON.parse(row.rules_json)), token: row.token, enabled: Boolean(row.enabled),
    created_at: row.created_at, updated_at: row.updated_at,
  }
}
function selectedSources(userId: number, value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new SubscriptionError('source_ids 必须为订阅源 ID 数组（最多 1000 项）')
  }
  const ids = [...new Set(value)] as number[]
  const owned = new Set(sql.all<{ id: number }>('SELECT id FROM subscription_sources WHERE user_id = ?', userId).map((row) => row.id))
  if (ids.some((id) => !owned.has(id))) throw new SubscriptionError('包含不存在或无权访问的订阅源')
  return ids
}

export function listSubscriptionSources(userId: number): SubscriptionSource[] {
  // List polling needs metadata only, not every source's potentially large node cache.
  return sql.all<SourceMetadataRow>(`SELECT id, user_id, name, url, note, enabled, refresh_interval_minutes,
    proxy_count, warnings_json, usage_json, last_attempt_at, last_success_at, next_fetch_at,
    last_error, created_at, updated_at, fetch_agent_id FROM subscription_sources WHERE user_id = ? ORDER BY id DESC`, userId).map(sourceView)
}
export function listSubscriptionProfiles(userId: number): SubscriptionProfile[] {
  return sql.all<ProfileRow>('SELECT * FROM subscription_profiles WHERE user_id = ? ORDER BY id DESC', userId).map(profileView)
}
export function createSubscriptionSource(userId: number, body: Body): SubscriptionSource {
  const name = text(body.name, '名称', 100)
  const url = sourceUrl(body.url)
  const note = text(body.note, '备注', 2000, true)
  const active = enabled(body.enabled)
  const minutes = interval(body.refresh_interval_minutes)
  const agentId = validateSubscriptionRelay(body.fetch_agent_id)
  const now = Date.now()
  const result = sql.run(`INSERT INTO subscription_sources
    (user_id, name, url, note, enabled, refresh_interval_minutes, next_fetch_at, created_at, updated_at, fetch_agent_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM subscription_sources WHERE user_id = ?) < 100`,
    userId, name, url, note, Number(active), minutes, active ? now : null, now, now, agentId, userId)
  if (!result.changes) throw new SubscriptionError('每个账号最多保存 100 个订阅源', 409)
  return sourceView(sourceRow(userId, result.lastInsertRowid))
}
export function updateSubscriptionSource(userId: number, id: number, body: Body): SubscriptionSource {
  const row = sourceRow(userId, id)
  const name = body.name === undefined ? row.name : text(body.name, '名称', 100)
  const url = body.url === undefined ? row.url : sourceUrl(body.url)
  const note = body.note === undefined ? row.note : text(body.note, '备注', 2000, true)
  const active = enabled(body.enabled, Boolean(row.enabled))
  const minutes = interval(body.refresh_interval_minutes, row.refresh_interval_minutes)
  // Saving a full source form must still allow pausing or annotating a missing
  // or disabled relay. Only a newly selected relay needs selection validation;
  // actual task dispatch always checks its current authorization separately.
  const agentId = body.fetch_agent_id === undefined || body.fetch_agent_id === row.fetch_agent_id
    ? row.fetch_agent_id : validateSubscriptionRelay(body.fetch_agent_id)
  const urlChanged = url !== row.url
  const now = changedAt(row.updated_at)
  const next = !active ? null : urlChanged || agentId !== row.fetch_agent_id || !row.enabled || inflight.has(keyOf(userId, id)) || subscriptionRelayState(id, row.fetch_agent_id).status !== 'idle'
    ? now : minutes !== row.refresh_interval_minutes ? Date.now() + minutes * 60_000 : row.next_fetch_at ?? now
  // Configuration revision is independent of timestamps and refreshes, so even
  // two edits within one millisecond invalidate an old HTTP response.
  sql.tx(() => {
    sql.run(`UPDATE subscription_sources SET name = ?, url = ?, note = ?, enabled = ?, fetch_agent_id = ?,
      refresh_interval_minutes = ?, next_fetch_at = ?, revision = revision + 1, updated_at = ?,
      proxies_json = ?, proxy_count = ?, warnings_json = ?, usage_json = ?, last_success_at = ?, last_error = ?, last_attempt_at = ?
      WHERE user_id = ? AND id = ?`, name, url, note, Number(active), agentId, minutes, next, now,
      urlChanged ? '[]' : row.proxies_json, urlChanged ? 0 : row.proxy_count, urlChanged ? '[]' : row.warnings_json,
      urlChanged ? null : row.usage_json, urlChanged ? null : row.last_success_at,
      urlChanged ? null : row.last_error, urlChanged ? null : row.last_attempt_at, userId, id)
    sql.run('DELETE FROM subscription_fetch_jobs WHERE source_id = ?', id)
  })
  return sourceView(sourceRow(userId, id))
}
export function deleteSubscriptionSource(userId: number, id: number): void {
  sourceRow(userId, id)
  sql.tx(() => {
    const profiles = sql.all<ProfileRow>('SELECT * FROM subscription_profiles WHERE user_id = ?', userId)
    for (const profile of profiles) {
      const ids = JSON.parse(profile.source_ids_json) as number[]
      if (ids.includes(id)) sql.run('UPDATE subscription_profiles SET source_ids_json = ?, updated_at = ? WHERE user_id = ? AND id = ?',
        JSON.stringify(ids.filter((sourceId) => sourceId !== id)), changedAt(profile.updated_at), userId, profile.id)
    }
    sql.run('DELETE FROM subscription_sources WHERE user_id = ? AND id = ?', userId, id)
  })
}

export function createSubscriptionProfile(userId: number, body: Body): SubscriptionProfile {
  const name = text(body.name, '名称', 100)
  const note = text(body.note, '备注', 2000, true)
  const ids = selectedSources(userId, body.source_ids ?? [])
  const normalized = rules(body.rules)
  const active = enabled(body.enabled)
  const now = Date.now()
  const result = sql.run(`INSERT INTO subscription_profiles
    (user_id, name, note, source_ids_json, rules_json, token, enabled, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM subscription_profiles WHERE user_id = ?) < 100`,
    userId, name, note, JSON.stringify(ids), JSON.stringify(normalized),
    randomBytes(32).toString('base64url'), Number(active), now, now, userId)
  if (!result.changes) throw new SubscriptionError('每个账号最多保存 100 个订阅配置', 409)
  return profileView(profileRow(userId, result.lastInsertRowid))
}
export function updateSubscriptionProfile(userId: number, id: number, body: Body): SubscriptionProfile {
  const row = profileRow(userId, id)
  const name = body.name === undefined ? row.name : text(body.name, '名称', 100)
  const note = body.note === undefined ? row.note : text(body.note, '备注', 2000, true)
  const ids = body.source_ids === undefined ? JSON.parse(row.source_ids_json) as number[] : selectedSources(userId, body.source_ids)
  const normalized = body.rules === undefined ? JSON.parse(row.rules_json) as SubscriptionRules : rules(body.rules)
  const active = enabled(body.enabled, Boolean(row.enabled))
  sql.run(`UPDATE subscription_profiles SET name = ?, note = ?, source_ids_json = ?, rules_json = ?, enabled = ?, updated_at = ?
    WHERE user_id = ? AND id = ?`, name, note, JSON.stringify(ids), JSON.stringify(normalized), Number(active), changedAt(row.updated_at), userId, id)
  return profileView(profileRow(userId, id))
}
export function deleteSubscriptionProfile(userId: number, id: number): void {
  profileRow(userId, id)
  sql.run('DELETE FROM subscription_profiles WHERE user_id = ? AND id = ?', userId, id)
}
export function rotateSubscriptionToken(userId: number, id: number): SubscriptionProfile {
  const row = profileRow(userId, id)
  sql.run('UPDATE subscription_profiles SET token = ?, updated_at = ? WHERE user_id = ? AND id = ?',
    randomBytes(32).toString('base64url'), changedAt(row.updated_at), userId, id)
  return profileView(profileRow(userId, id))
}

async function withFetchSlot(task: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    if (running < 3) { running++; resolve() }
    else slots.push(resolve)
  })
  try { await task() }
  finally {
    const next = slots.shift()
    if (next) next()
    else running--
  }
}

type RefreshOptions = { dueAt?: number; enabledOnly?: boolean; shouldContinue?: () => boolean }
function refreshOne(userId: number, id: number, options: RefreshOptions = {}): Promise<void> {
  const relayRow = sql.get<SourceRow>('SELECT * FROM subscription_sources WHERE user_id = ? AND id = ?', userId, id)
  if (relayRow && relayRow.fetch_agent_id !== null) {
    if ((!options.shouldContinue || options.shouldContinue()) && (!options.enabledOnly || relayRow.enabled)
      && (options.dueAt === undefined || (relayRow.enabled && relayRow.next_fetch_at !== null && relayRow.next_fetch_at <= options.dueAt))) {
      queueSubscriptionRelay(relayRow)
    }
    return Promise.resolve()
  }
  const key = keyOf(userId, id)
  const existing = inflight.get(key)
  if (existing) return existing
  const task = withFetchSlot(async () => {
    if (options.shouldContinue && !options.shouldContinue()) return
    const row = sql.get<SourceRow>('SELECT * FROM subscription_sources WHERE user_id = ? AND id = ?', userId, id)
    if (!row || (options.enabledOnly && !row.enabled)
      || (options.dueAt !== undefined && (!row.enabled || row.next_fetch_at === null || row.next_fetch_at > options.dueAt))) return
    if (row.fetch_agent_id !== null) { queueSubscriptionRelay(row); return }
    const now = Date.now()
    const claimed = sql.run(`UPDATE subscription_sources SET fetch_revision = fetch_revision + 1,
      last_attempt_at = ?, next_fetch_at = ? WHERE user_id = ? AND id = ? AND revision = ? AND fetch_revision = ?`,
      now, row.enabled ? now + row.refresh_interval_minutes * 60_000 : null, userId, id, row.revision, row.fetch_revision)
    if (!claimed.changes) return
    const requestRevision = row.fetch_revision + 1
    try {
      const fetched = await fetchSubscription(row.url)
      if (options.shouldContinue && !options.shouldContinue()) return
      const parsed = parseSubscription(fetched.text)
      if (!parsed.proxies.length) throw new Error('订阅中没有可用节点')
      const usage = parseSubscriptionUsage(fetched.subscription_userinfo)
      const finished = changedAt(row.updated_at)
      sql.run(`UPDATE subscription_sources SET proxies_json = ?, proxy_count = ?, warnings_json = ?, usage_json = ?,
        last_success_at = ?, last_error = NULL, next_fetch_at = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND revision = ? AND fetch_revision = ?`,
        JSON.stringify(parsed.proxies), parsed.proxies.length, JSON.stringify(parsed.warnings), usage ? JSON.stringify(usage) : null,
        finished, row.enabled ? finished + row.refresh_interval_minutes * 60_000 : null, finished,
        userId, id, row.revision, requestRevision)
    } catch (err) {
      if (options.shouldContinue && !options.shouldContinue()) return
      const finished = changedAt(row.updated_at)
      const message = (err instanceof Error ? err.message : '拉取订阅失败').slice(0, 1000)
      // An unsuccessful attempt updates scheduling/error metadata only. Previously
      // parsed nodes remain available to clients until a valid replacement arrives.
      sql.run(`UPDATE subscription_sources SET last_error = ?, next_fetch_at = ?, updated_at = ?
        WHERE user_id = ? AND id = ? AND revision = ? AND fetch_revision = ?`,
        message, row.enabled ? finished + row.refresh_interval_minutes * 60_000 : null, finished,
        userId, id, row.revision, requestRevision)
    }
  }).finally(() => { inflight.delete(key) })
  inflight.set(key, task)
  return task
}

export async function refreshSubscriptionSource(userId: number, id: number): Promise<SubscriptionSource> {
  sourceRow(userId, id)
  await refreshOne(userId, id)
  return sourceView(sourceRow(userId, id))
}
export async function refreshSubscriptionSources(userId: number): Promise<SubscriptionSource[]> {
  const sources = sql.all<{ id: number }>('SELECT id FROM subscription_sources WHERE user_id = ? AND enabled = 1', userId)
  await Promise.all(sources.map(({ id }) => refreshOne(userId, id, { enabledOnly: true })))
  return listSubscriptionSources(userId)
}

export async function runSubscriptionSchedulerTick(now = Date.now(), shouldContinue: () => boolean = () => true): Promise<void> {
  if (schedulerTick) return schedulerTick
  if (!shouldContinue()) return Promise.resolve()
  expireSubscriptionRelayJobs(now)
  const sources = sql.all<{ id: number; user_id: number }>(`SELECT id, user_id FROM subscription_sources
    WHERE enabled = 1 AND next_fetch_at IS NOT NULL AND next_fetch_at <= ? ORDER BY next_fetch_at, id LIMIT 100`, now)
  const tick = Promise.all(sources.map(({ id, user_id }) => refreshOne(user_id, id, { dueAt: now, shouldContinue })))
    .then(() => {}).finally(() => { if (schedulerTick === tick) schedulerTick = null })
  schedulerTick = tick
  return tick
}
export function startSubscriptionScheduler(): () => void {
  let stopped = false
  const tick = () => { void runSubscriptionSchedulerTick(Date.now(), () => !stopped).catch(() => {
    if (!stopped) console.error('[subscriptions] 定时刷新失败，将在下一轮重试')
  }) }
  const timer = setInterval(tick, 10_000)
  timer.unref()
  tick()
  return () => { stopped = true; clearInterval(timer) }
}

export function subscriptionFormat(value: unknown): SubscriptionFormat {
  if (value === undefined || value === 'clash') return 'clash'
  if (value === 'links' || value === 'base64') return value
  throw new SubscriptionError('不支持的订阅格式')
}
function outputFor(row: ProfileRow, format: SubscriptionFormat): SubscriptionOutput {
  const profile = profileView(row)
  const selected = profile.source_ids.length
    ? sql.all<SourceRow>(`SELECT * FROM subscription_sources WHERE user_id = ? AND id IN (${profile.source_ids.map(() => '?').join(',')})`, row.user_id, ...profile.source_ids)
    : []
  const sources = new Map(selected.map((source) => [source.id, source]))
  const warnings: string[] = []
  const inputs = profile.source_ids.flatMap((id) => {
    const source = sources.get(id)
    if (source) {
      if (source.last_success_at === null) warnings.push(`${source.name}：尚未获取到可用节点，请先刷新订阅源`)
      else if (source.last_error) warnings.push(`${source.name}：最近刷新失败，正在使用上次成功获取的缓存`)
      for (const warning of JSON.parse(source.warnings_json) as string[]) warnings.push(`${source.name}：${warning}`)
    }
    return source ? [{ id: source.id, name: source.name, proxies: JSON.parse(source.proxies_json) as ProxyNode[] }] : []
  })
  if (!inputs.some((input) => input.proxies.length > 0)) {
    return {
      content: '', content_type: format === 'clash' ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8',
      proxy_count: 0, warnings: warnings.length ? warnings : ['没有选择可用订阅源，请先添加并刷新订阅源'],
    }
  }
  try {
    const output = buildSubscriptionOutput(inputs, profile.rules, format)
    return { ...output, warnings: [...new Set([...warnings, ...output.warnings])] }
  }
  catch (err) { throw new SubscriptionError(err instanceof Error ? err.message : '订阅生成失败', 409) }
}
export function previewSubscriptionProfile(userId: number, id: number, format: SubscriptionFormat): SubscriptionOutput {
  return outputFor(profileRow(userId, id), format)
}
export function subscriptionFeed(token: string, format: SubscriptionFormat): SubscriptionOutput & { subscription_userinfo?: string } {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SubscriptionError('订阅链接不存在或已停用', 404)
  const row = sql.get<ProfileRow>('SELECT * FROM subscription_profiles WHERE token = ? AND enabled = 1', token)
  if (!row) throw new SubscriptionError('订阅链接不存在或已停用', 404)
  // Deliberately reads persisted cache only. Anonymous feed requests cannot
  // perform source fetching, change scheduling, or supply a destination URL.
  const output = outputFor(row, format)
  if (!output.proxy_count) throw new SubscriptionError('订阅尚无可用缓存，请管理员先刷新订阅源', 503)
  // Quotas cannot be meaningfully merged across providers. For exactly one
  // configured source, forward only known, validated numeric cache metadata.
  const ids = JSON.parse(row.source_ids_json) as number[]
  const metadata = ids.length === 1
    ? sql.get<{ usage_json: string | null }>('SELECT usage_json FROM subscription_sources WHERE user_id = ? AND id = ?', row.user_id, ids[0]!)
    : null
  const usage = metadata?.usage_json ? JSON.parse(metadata.usage_json) as SubscriptionUsage : null
  const fields: string[] = []
  if (usage) {
    for (const field of ['upload', 'download', 'total'] as const) {
      const value = usage[field]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) fields.push(`${field}=${value}`)
    }
    if (typeof usage.expires_at === 'number' && Number.isSafeInteger(usage.expires_at) && usage.expires_at >= 0) {
      fields.push(`expire=${Math.floor(usage.expires_at / 1000)}`)
    }
  }
  return fields.length ? { ...output, subscription_userinfo: fields.join('; ') } : output
}
