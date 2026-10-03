import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sql } from './db.js'
import { openLingxiSecret, sealLingxiSecret } from './lingxi-secrets.js'
import { requestLingxi } from './lingxi-transport.js'

export const LINGXI_VAULT_SCHEMA = `
CREATE TABLE lingxi_vault_grants (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  grant_id TEXT NOT NULL,
  service_token_hash TEXT,
  service_token_expires_at INTEGER,
  snapshot_encrypted TEXT,
  snapshot_version INTEGER NOT NULL DEFAULT 0,
  source_version INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  authorized_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_lingxi_vault_token ON lingxi_vault_grants(service_token_hash);
CREATE TABLE lingxi_vault_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_lingxi_vault_audit_user ON lingxi_vault_audit(user_id, created_at);
`
export type LingxiVaultItem = {
  id: string; title: string; url: string; username: string; password: string; notes: string;
  createdAt: number; updatedAt: number;
}
export type VaultGrant = {
  user_id: number; enabled: number; grant_id: string; service_token_hash: string | null;
  service_token_expires_at: number | null; snapshot_encrypted: string | null;
  snapshot_version: number; source_version: number; item_count: number;
  authorized_at: number | null; updated_at: number;
}
export const hashVaultServiceToken = (token: string) => createHash('sha256').update(token).digest('hex')
export const readLingxiVaultGrant = (userId: number) => sql.get<VaultGrant>('SELECT * FROM lingxi_vault_grants WHERE user_id = ?', userId)
export const hasLingxiBinding = (userId: number) => Boolean(sql.get('SELECT user_id FROM lingxi_bindings WHERE user_id = ?', userId))

export function auditLingxiVault(userId: number, action: string, itemCount = 0) {
  // Deliberately no URLs, titles, usernames, passwords or request bodies in audit records.
  sql.run('INSERT INTO lingxi_vault_audit (user_id, action, item_count, created_at) VALUES (?, ?, ?, ?)', userId, action, itemCount, Date.now())
  sql.run('DELETE FROM lingxi_vault_audit WHERE user_id = ? AND id NOT IN (SELECT id FROM lingxi_vault_audit WHERE user_id = ? ORDER BY id DESC LIMIT 200)', userId, userId)
}

export function getLingxiVaultSettings(userId: number) {
  const grant = readLingxiVaultGrant(userId)
  const enabled = Boolean(grant?.enabled && hasLingxiBinding(userId))
  const source = sql.get<{ version: number }>('SELECT version FROM vaults WHERE user_id = ?', userId)
  return {
    enabled, grant_id: enabled ? grant!.grant_id : null,
    status: !enabled ? 'disabled' : grant?.snapshot_encrypted ? 'ready' : 'awaiting_extension',
    scope: 'all', can_decrypt: true, item_count: enabled ? grant?.item_count ?? 0 : 0,
    snapshot_version: grant?.snapshot_version ?? 0, source_version: grant?.source_version ?? 0,
    stale: Boolean(enabled && grant?.snapshot_encrypted && source?.version !== grant.source_version),
    authorized_at: enabled ? grant?.authorized_at ?? null : null, updated_at: grant?.updated_at ?? null,
    service_token_expires_at: enabled ? grant?.service_token_expires_at ?? null : null,
    service_connected: Boolean(enabled && grant?.service_token_expires_at && grant.service_token_expires_at > Date.now()),
    audit: sql.all<{ action: string; item_count: number; created_at: number }>(
      'SELECT action, item_count, created_at FROM lingxi_vault_audit WHERE user_id = ? ORDER BY id DESC LIMIT 10', userId),
  }
}

export function setLingxiVaultEnabled(userId: number, enabled: boolean) {
  if (!enabled) { revokeLingxiVault(userId, 'disabled'); return getLingxiVaultSettings(userId) }
  if (!hasLingxiBinding(userId)) throw new Error('请先连接灵犀账号')
  const existing = readLingxiVaultGrant(userId)
  if (!existing?.enabled) {
    sql.run(`INSERT INTO lingxi_vault_grants (user_id, enabled, grant_id, updated_at) VALUES (?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET enabled = 1, grant_id = excluded.grant_id, updated_at = excluded.updated_at`, userId, randomUUID(), Date.now())
    auditLingxiVault(userId, 'enabled')
  }
  return getLingxiVaultSettings(userId)
}

/** Switch-off and account changes invalidate grants and destroy the decryptable copy immediately. */
export function revokeLingxiVault(userId: number, reason = 'revoked'): void {
  sql.run(`UPDATE lingxi_vault_grants SET enabled = 0, grant_id = ?, service_token_hash = NULL,
    service_token_expires_at = NULL, snapshot_encrypted = NULL, snapshot_version = 0,
    source_version = 0, item_count = 0, authorized_at = NULL, updated_at = ? WHERE user_id = ?`, randomUUID(), Date.now(), userId)
  auditLingxiVault(userId, ['disabled', 'unbound', 'rebound'].includes(reason) ? reason : 'revoked')
}

export function validateLingxiVaultItems(value: unknown): LingxiVaultItem[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('密码条目格式无效或超过限制')
  const ids = new Set<string>()
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('密码条目格式无效')
    const item: Record<string, unknown> = {}
    for (const name of ['id', 'title', 'url', 'username', 'password', 'notes']) {
      const text = entry[name] ?? ''
      if (typeof text !== 'string' || text.length > (name === 'id' ? 200 : 100_000)) throw new Error('密码条目字段无效')
      item[name] = text
    }
    if (!item.id || ids.has(item.id as string)) throw new Error('密码条目 ID 无效或重复')
    ids.add(item.id as string)
    for (const name of ['createdAt', 'updatedAt']) {
      if (!Number.isSafeInteger(entry[name]) || entry[name] < 0) throw new Error('密码条目时间无效')
      item[name] = entry[name]
    }
    return item as LingxiVaultItem
  })
}

/** Token is exclusively for vault callback reads. It cannot authenticate navigation APIs. */
export function issueLingxiVaultServiceToken(userId: number) {
  const grant = readLingxiVaultGrant(userId)
  if (!grant?.enabled || !grant.snapshot_encrypted || !hasLingxiBinding(userId)) throw new Error('密码授权尚未就绪')
  const token = `lxv_${randomBytes(32).toString('base64url')}`
  const expires_at = Date.now() + 24 * 60 * 60_000
  sql.run('UPDATE lingxi_vault_grants SET service_token_hash = ?, service_token_expires_at = ? WHERE user_id = ?', hashVaultServiceToken(token), expires_at, userId)
  auditLingxiVault(userId, 'token_issued')
  return { token, expires_at, grant_id: grant.grant_id, scope: 'vault:read' as const }
}

export function encryptLingxiVaultSnapshot(userId: number, grantId: string, items: LingxiVaultItem[]) {
  return sealLingxiSecret(userId, 'vault-snapshot', JSON.stringify({ grant_id: grantId, items }))
}
export function decryptLingxiVaultSnapshot(grant: VaultGrant): LingxiVaultItem[] {
  if (!grant.enabled || !grant.snapshot_encrypted) throw new Error('密码读取未授权')
  const decoded = JSON.parse(openLingxiSecret(grant.user_id, 'vault-snapshot', grant.snapshot_encrypted))
  if (decoded.grant_id !== grant.grant_id) throw new Error('密码授权已变化')
  return validateLingxiVaultItems(decoded.items)
}

const registering = new Map<number, Promise<boolean>>()
let callbackAbort = new AbortController()
let schedulerStopping = false
export function registerLingxiVaultCallback(userId: number): Promise<boolean> {
  if (schedulerStopping) return Promise.resolve(false)
  const pending = registering.get(userId)
  if (pending) return pending
  const job = registerCallback(userId).finally(() => registering.delete(userId))
  registering.set(userId, job)
  return job
}
async function registerCallback(userId: number): Promise<boolean> {
  let url: URL
  try {
    url = new URL(process.env.NAVIGATION_PUBLIC_URL ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return false
  } catch { return false }
  const grant = readLingxiVaultGrant(userId)
  const binding = sql.get<{ base_url: string; api_token_encrypted: string }>('SELECT base_url, api_token_encrypted FROM lingxi_bindings WHERE user_id = ?', userId)
  if (!grant?.enabled || !grant.snapshot_encrypted || !binding) return false
  const service = issueLingxiVaultServiceToken(userId)
  try {
    const response = await requestLingxi(binding.base_url, openLingxiSecret(userId, 'api-token', binding.api_token_encrypted), {
      path: '/integrations/navigation-vault', method: 'PUT', body: {
        read_url: `${url.origin}/api/lingxi/vault/service/read`, read_token: service.token,
        expires_at: service.expires_at, scope: 'all', navigation_user_id: userId,
      }, signal: callbackAbort.signal,
    })
    await response.arrayBuffer()
    const current = readLingxiVaultGrant(userId)
    if (!current?.enabled || current.grant_id !== grant.grant_id) return false
    auditLingxiVault(userId, 'callback_registered')
    return true
  } catch {
    // Upstream exceptions might include echoed secrets. Persist only a fixed code.
    sql.run('UPDATE lingxi_vault_grants SET service_token_hash = NULL, service_token_expires_at = NULL WHERE user_id = ? AND grant_id = ? AND service_token_hash = ?', userId, grant.grant_id, hashVaultServiceToken(service.token))
    auditLingxiVault(userId, 'callback_failed')
    return false
  }
}
let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshRunning = false
export function startLingxiVaultRefreshScheduler() {
  if (refreshTimer) return stopLingxiVaultRefreshScheduler
  schedulerStopping = false
  callbackAbort = new AbortController()
  const refresh = async () => {
    if (refreshRunning) return
    refreshRunning = true
    try {
      const users = sql.all<{ user_id: number }>(`SELECT user_id FROM lingxi_vault_grants WHERE enabled = 1
        AND snapshot_encrypted IS NOT NULL AND (service_token_expires_at IS NULL OR service_token_expires_at < ?)`, Date.now() + 60 * 60_000)
      for (const user of users) {
        if (schedulerStopping) break
        await registerLingxiVaultCallback(user.user_id)
      }
    } finally { refreshRunning = false }
  }
  void refresh().catch(() => {})
  refreshTimer = setInterval(() => { void refresh().catch(() => {}) }, 5 * 60_000)
  refreshTimer.unref()
  return stopLingxiVaultRefreshScheduler
}
export async function stopLingxiVaultRefreshScheduler() {
  schedulerStopping = true
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  callbackAbort.abort()
  await Promise.allSettled([...registering.values()])
}
