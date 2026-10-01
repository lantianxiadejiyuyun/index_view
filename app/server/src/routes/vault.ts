/**
 * 密码管理器扩展的**密文保险库**接口。
 *
 * 契约（扩展侧 `src/sync.js` 依赖，勿改字段名）：
 *
 *   GET  /api/vault                        → { version, blob, updated_at }
 *   PUT  /api/vault   { base_version, blob } → { version } | 409 冲突
 *
 * 鉴权沿用主站账号：扩展先调 `/api/auth/login` 拿 access token，再带 Bearer 调这里
 * （账号密码由用户在扩展里填，加密后存在本机保险库里，服务端只见到哈希）。
 *
 * ── 服务端为什么解不开 ──
 * blob 是扩展用**主密码派生的 vaultKey**（AES-GCM）在本地加密出来的，
 * 主密码与 vaultKey 都不上传。服务端只是个「放着密文的柜子」：
 * 就算库被拖走，拿到的也只有密文。这是「不主动收集数据」的技术保证 ——
 * 不是靠承诺，是**收不到明文**。
 *
 * 所以这里刻意不做任何「解密 / 校验内容」的事：只做大小限制与 JSON 形状检查，
 * 免得把「服务端能看到什么」这件事悄悄扩大。
 */
import { Hono } from 'hono'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export const vaultRoutes = new Hono<AppEnv>()

// 包括 401 和 409 的响应都禁止缓存，避免代理复用其他账号的保险库响应。
vaultRoutes.use('/vault', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

/** 密文上限。20 条密码约 10 KB，1 MB 够放几千条，同时挡住「拿它当网盘」 */
const MAX_BLOB_BYTES = 1024 * 1024

type PutBody = { base_version?: unknown; blob?: unknown }

type VaultRow = {
  user_id: number
  version: number
  blob: string | null
  updated_at: number | null
  created_at: number
}

function readVault(userId: number): VaultRow | undefined {
  return sql.get<VaultRow>('SELECT * FROM vaults WHERE user_id = ?', userId)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function base64Bytes(value: unknown): number {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1
  return Buffer.from(value, 'base64').length
}

function isCipherBox(value: unknown): boolean {
  return isObject(value) && base64Bytes(value.iv) === 12 && base64Bytes(value.data) >= 16
}

/** 只验证公开的 v1 加密信封元数据；不派生密钥、不解密保险库。 */
function isVaultEnvelope(value: unknown): boolean {
  if (!isObject(value) || value.v !== 1 || !isObject(value.kdf)) return false
  const kdf = value.kdf
  const saltBytes = base64Bytes(kdf.salt)
  return kdf.name === 'PBKDF2-SHA256'
    && typeof kdf.iterations === 'number'
    && Number.isSafeInteger(kdf.iterations)
    && kdf.iterations >= 100_000 && kdf.iterations <= 5_000_000
    && saltBytes >= 16 && saltBytes <= 64
    && isCipherBox(value.verifier) && isCipherBox(value.payload)
}

vaultRoutes.get('/vault', requireAuth, (c) => {
  const user = c.get('user')
  const row = readVault(user.id)
  return c.json({
    version: row?.version ?? 0,
    blob: row?.blob ?? null,
    updated_at: row?.updated_at ?? null,
  })
})

vaultRoutes.put('/vault', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await readJson<PutBody>(c)

  if (typeof body.base_version !== 'number' || !Number.isSafeInteger(body.base_version)
    || body.base_version < 0) {
    return c.json({ error: 'bad_request', message: 'base_version 必须是非负安全整数' }, 400)
  }
  if (typeof body.blob !== 'string' || body.blob === '') {
    return c.json({ error: 'bad_request', message: 'blob 必须是非空字符串' }, 400)
  }
  if (Buffer.byteLength(body.blob, 'utf8') > MAX_BLOB_BYTES) {
    return c.json(
      { error: 'too_large', message: `密文超过 ${Math.round(MAX_BLOB_BYTES / 1024)} KB，拒绝保存` },
      413,
    )
  }
  try {
    if (!isVaultEnvelope(JSON.parse(body.blob))) throw new Error('shape')
  } catch {
    return c.json({ error: 'bad_request', message: 'blob 必须是保险库密文（JSON 对象）' }, 400)
  }

  const baseVersion = body.base_version
  const now = Date.now()
  // 条件与写入在同一条 SQLite 语句里执行；多进程同时同步时也只有一个写入者成功。
  // 首次同步仅允许 base_version=0，已有的空记录同样通过版本条件更新。
  const result = baseVersion === 0
    ? sql.run(
      `INSERT INTO vaults (user_id, version, blob, updated_at, created_at) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET version = 1, blob = excluded.blob, updated_at = excluded.updated_at
       WHERE vaults.version = 0`,
      user.id, body.blob, now, now,
    )
    : sql.run(
      `UPDATE vaults SET version = version + 1, blob = ?, updated_at = ?
       WHERE user_id = ? AND version = ? AND version < ?`,
      body.blob, now, user.id, baseVersion, Number.MAX_SAFE_INTEGER,
    )

  // 乐观并发：客户端拿的版本和库里对不上 → 让用户自己选，不静默覆盖
  if (result.changes === 0) {
    const existing = readVault(user.id)
    return c.json(
      {
        error: 'conflict',
        message: '服务器上的保险库已经变过了',
        version: existing?.version ?? 0,
        blob: existing?.blob ?? null,
        updated_at: existing?.updated_at ?? null,
      },
      409,
    )
  }

  return c.json({ ok: true, version: baseVersion + 1, updated_at: now })
})
