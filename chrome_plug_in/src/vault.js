/** Vault model and validated, versioned encrypted files. No Chrome APIs. */
import { DEFAULT_KDF, b64, decodeBase64, decryptJson, deriveKeys, encryptJson, randomBytes, validateKdf } from './crypto.js'
import { normalizeItemUrl } from './match.js'
import { normalizeServer } from './sync.js'

const VERIFIER = 'hd-pm/vault/v1'
const MAX_FILE_BYTES = 1024 * 1024
export const FILE_VERSION = 1

export class BadPasswordError extends Error {
  constructor() { super('主密码不正确'); this.name = 'BadPasswordError' }
}
export class NoVaultError extends Error {
  constructor() { super('还没有创建保险库'); this.name = 'NoVaultError' }
}
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback

export function validateFile(file) {
  if (!object(file) || file.v !== FILE_VERSION) throw new Error('不支持的保险库格式或版本')
  if (new TextEncoder().encode(JSON.stringify(file)).length > MAX_FILE_BYTES) throw new Error('保险库密文超过 1 MB')
  validateKdf(file.kdf)
  for (const box of [file.verifier, file.payload]) {
    if (!object(box) || decodeBase64(box.iv).length !== 12 || decodeBase64(box.data).length < 16) {
      throw new Error('保险库密文结构无效')
    }
  }
  return file
}

export function emptyVault() {
  return { v: FILE_VERSION, items: [], updatedAt: Date.now() }
}

export function normalizeItem(item, { freshId = false } = {}) {
  if (!object(item)) throw new Error('密码条目必须是对象')
  const fields = {}
  for (const name of ['title', 'url', 'username', 'password', 'notes']) {
    const value = item[name] ?? ''
    if (typeof value !== 'string' || value.length > 100_000) throw new Error(`条目 ${name} 必须是有效文本`)
    fields[name] = value
  }
  fields.title = fields.title.trim()
  fields.url = normalizeItemUrl(fields.url)
  if (!fields.title && !fields.url) throw new Error('标题和网址至少填一个')
  if (item.id !== undefined && (typeof item.id !== 'string' || !item.id || item.id.length > 200)) {
    throw new Error('条目 ID 无效')
  }
  const now = Date.now()
  return {
    id: freshId ? crypto.randomUUID() : item.id ?? crypto.randomUUID(),
    ...fields,
    createdAt: timestamp(item.createdAt, now),
    updatedAt: timestamp(item.updatedAt, now),
  }
}

export function validateVault(vault) {
  if (!object(vault) || vault.v !== FILE_VERSION || !Array.isArray(vault.items) || vault.items.length > 10_000) {
    throw new Error('保险库内容格式无效')
  }
  const items = vault.items.map((item) => normalizeItem(item))
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('保险库包含重复的条目 ID')
  const next = { v: FILE_VERSION, items, updatedAt: timestamp(vault.updatedAt, Date.now()) }
  if (vault.account != null) {
    const account = vault.account
    const server = normalizeServer(account.base)
    if (!object(account) || !server.ok || !server.base || typeof account.user !== 'string'
      || !account.user.trim() || typeof account.password !== 'string' || !account.password) {
      throw new Error('保险库服务器账号格式无效')
    }
    next.account = { base: server.base, user: account.user.trim(), password: account.password }
  }
  return next
}

export async function createFile(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('主密码至少 8 位')
  const kdf = { name: DEFAULT_KDF.name, iterations: DEFAULT_KDF.iterations, salt: b64.encode(randomBytes(16)) }
  const { vaultKey } = await deriveKeys(password, kdf)
  const vault = emptyVault()
  const file = {
    v: FILE_VERSION, kdf,
    verifier: await encryptJson(vaultKey, VERIFIER),
    payload: await encryptJson(vaultKey, vault),
    updatedAt: vault.updatedAt,
  }
  return { file, vault, vaultKey }
}

export async function unlockWithKey(file, vaultKey) {
  validateFile(file)
  let verifier
  try { verifier = await decryptJson(vaultKey, file.verifier) } catch { throw new BadPasswordError() }
  if (verifier !== VERIFIER) throw new BadPasswordError()
  return { vault: validateVault(await decryptJson(vaultKey, file.payload)), vaultKey }
}

export async function unlockFile(file, password) {
  if (!file) throw new NoVaultError()
  validateFile(file)
  const { vaultKey } = await deriveKeys(password, file.kdf)
  return unlockWithKey(file, vaultKey)
}

export async function sealFile(file, vault, vaultKey) {
  const next = { ...validateVault(vault), updatedAt: Date.now() }
  const payload = await encryptJson(vaultKey, next)
  const result = { ...file, payload, updatedAt: next.updatedAt }
  validateFile(result)
  return { file: result, vault: next }
}

export async function rekeyFile(file, vault, newPassword) {
  const created = await createFile(newPassword)
  const sealed = await sealFile(created.file, vault, created.vaultKey)
  return { ...sealed, vaultKey: created.vaultKey }
}

export function newItem(patch = {}) {
  const now = Date.now()
  return { id: crypto.randomUUID(), title: '', url: '', username: '', password: '', notes: '', createdAt: now, updatedAt: now, ...patch }
}

export function findItem(vault, id) {
  return vault.items.find((item) => item.id === id) ?? null
}

export function upsertItem(vault, item) {
  const previous = vault.items.find((entry) => entry.id === item?.id)
  const next = normalizeItem({ ...previous, ...item, updatedAt: Date.now() })
  const items = previous
    ? vault.items.map((entry) => entry.id === next.id ? next : entry)
    : [...vault.items, next]
  return { ...vault, items }
}

export function removeItem(vault, id) {
  return { ...vault, items: vault.items.filter((item) => item.id !== id) }
}

export function exportEncrypted(file) {
  if (!file) throw new NoVaultError()
  validateFile(file)
  return JSON.stringify({ app: 'hd-pm', kind: 'encrypted-vault', file }, null, 2)
}

export function exportPlain(vault) {
  return JSON.stringify({ app: 'hd-pm', kind: 'plain-vault', exportedAt: new Date().toISOString(), items: vault.items }, null, 2)
}

export function parseImport(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 4 * MAX_FILE_BYTES) {
    throw new Error('导入文件过大（最多 4 MB）')
  }
  let data
  try { data = JSON.parse(text) } catch { throw new Error('不是合法的 JSON 文件') }
  if (data?.app !== 'hd-pm') throw new Error('不是本扩展的保险库导出文件')
  if (data.kind === 'encrypted-vault') return { kind: 'encrypted', file: validateFile(data.file) }
  if (data.kind === 'plain-vault' && Array.isArray(data.items) && data.items.length <= 10_000) {
    // Plain imports are appended; new IDs prevent overwriting or duplicating existing IDs.
    return { kind: 'plain', items: data.items.map((item) => normalizeItem(item, { freshId: true })) }
  }
  throw new Error('认不出这个文件（既不是密文保险库，也不是明文导出）')
}
