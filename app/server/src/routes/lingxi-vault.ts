import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../types.js'
import { requireAuth } from '../middleware/auth.js'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import {
  auditLingxiVault, decryptLingxiVaultSnapshot, encryptLingxiVaultSnapshot,
  getLingxiVaultSettings, hasLingxiBinding, hashVaultServiceToken, readLingxiVaultGrant,
  registerLingxiVaultCallback, setLingxiVaultEnabled, validateLingxiVaultItems, type VaultGrant,
} from '../lib/lingxi-vault.js'

export const lingxiVaultRoutes = new Hono<AppEnv>()
lingxiVaultRoutes.use('/lingxi/vault/*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  await next()
})
lingxiVaultRoutes.use('/lingxi/vault/*', bodyLimit({ maxSize: 2 * 1024 * 1024,
  onError: (c) => c.json({ error: 'too_large', message: '密码授权数据超过 2 MB' }, 413) }))
lingxiVaultRoutes.get('/lingxi/vault/settings', requireAuth, (c) => c.json(getLingxiVaultSettings(c.get('user').id)))
lingxiVaultRoutes.put('/lingxi/vault/settings', requireAuth, async (c) => {
  const body = await readJson(c)
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'bad_request', message: 'enabled 必须是布尔值' }, 400)
  if (body.enabled && !hasLingxiBinding(c.get('user').id)) return c.json({ error: 'not_bound', message: '请先连接灵犀账号' }, 409)
  return c.json(setLingxiVaultEnabled(c.get('user').id, body.enabled))
})
lingxiVaultRoutes.post('/lingxi/vault/snapshot', requireAuth, async (c) => {
  const userId = c.get('user').id
  const body = await readJson(c)
  const grant = readLingxiVaultGrant(userId)
  if (!grant?.enabled || !hasLingxiBinding(userId)) return c.json({ error: 'grant_disabled', message: '后台未开启密码读取授权' }, 403)
  if (body.grant_id !== grant.grant_id) return c.json({ error: 'grant_changed', message: '密码授权已变化，请重新确认' }, 409)
  if (!grant.authorized_at && body.consent !== true) return c.json({ error: 'consent_required', message: '请先在插件中确认授权' }, 403)
  if (!Number.isSafeInteger(body.base_version) || (body.base_version as number) < 0
    || !Number.isSafeInteger(body.source_version) || (body.source_version as number) < 1) {
    return c.json({ error: 'bad_request', message: '密码版本无效' }, 400)
  }
  let items
  try { items = validateLingxiVaultItems(body.items) } catch { return c.json({ error: 'bad_request', message: '密码条目格式无效' }, 400) }
  const source = sql.get<{ version: number }>('SELECT version FROM vaults WHERE user_id = ?', userId)
  if (source?.version !== body.source_version || grant.snapshot_version !== body.base_version) {
    return c.json({ error: 'snapshot_conflict', message: '密码库版本已变化，请先完成密文同步', version: grant.snapshot_version }, 409)
  }
  const encrypted = encryptLingxiVaultSnapshot(userId, grant.grant_id, items)
  const now = Date.now()
  const changed = sql.run(`UPDATE lingxi_vault_grants SET snapshot_encrypted = ?, snapshot_version = snapshot_version + 1,
    source_version = ?, item_count = ?, authorized_at = COALESCE(authorized_at, ?), updated_at = ?
    WHERE user_id = ? AND enabled = 1 AND grant_id = ? AND snapshot_version = ?
    AND EXISTS (SELECT 1 FROM vaults WHERE user_id = ? AND version = ?)`,
  encrypted, body.source_version as number, items.length, now, now, userId, grant.grant_id, body.base_version as number, userId, body.source_version as number)
  if (!changed.changes) return c.json({ error: 'snapshot_conflict', message: '密码授权或版本已变化，请重新确认' }, 409)
  auditLingxiVault(userId, grant.authorized_at ? 'snapshot_updated' : 'extension_authorized', items.length)
  if (!grant.service_token_expires_at || grant.service_token_expires_at < Date.now() + 60 * 60_000) {
    await registerLingxiVaultCallback(userId)
  }
  return c.json(getLingxiVaultSettings(userId))
})

// Only the scoped opaque service token works here; a navigation access token does not.
lingxiVaultRoutes.post('/lingxi/vault/service/read', async (c) => {
  const token = c.req.header('Authorization')?.match(/^Bearer (lxv_[A-Za-z0-9_-]{43})$/)?.[1]
  if (!token) return c.json({ error: 'unauthorized', message: '密码服务凭据无效' }, 401)
  // Read the body before permission checks. Revocation during a slow request body
  // must take effect before any decrypted data leaves this process.
  const body = await readJson(c)
  if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.length > 1000 || body.ids.some((id) => typeof id !== 'string' || id.length > 200))) {
    return c.json({ error: 'bad_request', message: 'ids 格式无效' }, 400)
  }
  const grant = sql.get<VaultGrant>('SELECT * FROM lingxi_vault_grants WHERE service_token_hash = ?', hashVaultServiceToken(token))
  if (!grant?.enabled || !grant.snapshot_encrypted || !grant.service_token_expires_at
    || grant.service_token_expires_at <= Date.now() || !hasLingxiBinding(grant.user_id)) {
    return c.json({ error: 'unauthorized', message: '密码读取授权已失效' }, 401)
  }
  const source = sql.get<{ version: number }>('SELECT version FROM vaults WHERE user_id = ?', grant.user_id)
  if (source?.version !== grant.source_version) return c.json({ error: 'snapshot_stale', message: '密码副本待更新，请在插件中同步' }, 409)
  try {
    const all = decryptLingxiVaultSnapshot(grant)
    const ids = body.ids === undefined ? null : new Set(body.ids as string[])
    const items = ids ? all.filter((item) => ids.has(item.id)) : all
    auditLingxiVault(grant.user_id, 'read', items.length)
    return c.json({ items, snapshot_version: grant.snapshot_version, source_version: grant.source_version, updated_at: grant.updated_at })
  } catch {
    auditLingxiVault(grant.user_id, 'decrypt_failed')
    return c.json({ error: 'decrypt_failed', message: '密码副本无法解密，请在插件中重新授权同步' }, 503)
  }
})
