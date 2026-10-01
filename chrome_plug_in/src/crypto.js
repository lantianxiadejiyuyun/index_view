/**
 * 所有加解密都在这里，全部走 WebCrypto（浏览器原生，无第三方库 → 商店「无远程代码」要求天然满足）。
 *
 *   主密码 ──PBKDF2-SHA256(600k 次, salt)──▶ vaultKey（AES-GCM-256）
 *
 * 两点刻意的设计：
 *   · **主密码与 vaultKey 都不上传**，服务器只拿到密文 —— 服务端自己也解不开。
 *   · 服务器鉴权走的是**主站账号**（见 src/sync.js），与这把钥匙无关；
 *     所以主站账号泄露、库被拖走，没有主密码依然解不开任何一条密码。
 */

/** 新建保险库时用的 KDF 参数；老文件里的参数优先（向后兼容的迁移路径） */
export const DEFAULT_KDF = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: null }

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Uint8Array ↔ base64（存 JSON 用，别存 ArrayBuffer） */
export const b64 = {
  encode(bytes) {
    let s = ''
    const view = new Uint8Array(bytes)
    for (let i = 0; i < view.length; i += 1) s += String.fromCharCode(view[i])
    return btoa(s)
  },
  decode(text) {
    const raw = atob(text)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
    return out
  },
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function validateKdf(kdf) {
  if (kdf?.name !== DEFAULT_KDF.name || !Number.isInteger(kdf.iterations)
    || kdf.iterations < 100_000 || kdf.iterations > 5_000_000) {
    throw new Error('保险库的密钥派生参数不受支持')
  }
  const salt = decodeBase64(kdf.salt)
  if (salt.length < 16 || salt.length > 64) throw new Error('保险库盐值无效')
  return kdf
}

export function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('保险库密文编码无效')
  return b64.decode(value)
}

async function pbkdf2Bits(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    256,
  )
}

/**
 * 主密码 → vaultKey。
 *
 * vaultKey 是 **extractable: false** 的 CryptoKey：就算拿到这个对象也导不出原始字节，
 * 只能用它加解密，天然少一条泄露路径。
 *
 * 服务器鉴权走的是**主站账号**（见 src/sync.js），跟这把钥匙完全无关 ——
 * 所以即使主站账号被盗、库被拖走，没有主密码还是解不开任何一条密码。
 */
export async function deriveKeys(password, kdf) {
  validateKdf(kdf)
  if (typeof password !== 'string' || !password.length || password.length > 4096) {
    throw new Error('请输入主密码（最多 4096 字符）')
  }
  const salt = b64.decode(kdf.salt)
  const iterations = kdf.iterations
  const masterBits = await pbkdf2Bits(password, salt, iterations)
  return {
    vaultKey: await crypto.subtle.importKey('raw', masterBits, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]),
  }
}

/** 加密一个对象 → { iv, data }（都 base64） */
export async function encryptJson(key, value) {
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(value)),
  )
  return { iv: b64.encode(iv), data: b64.encode(ct) }
}

/** 解密；密钥不对时 AES-GCM 会抛错 —— 主密码校验就靠这个性质 */
export async function decryptJson(key, box) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64.decode(box.iv) },
    key,
    b64.decode(box.data),
  )
  return JSON.parse(dec.decode(pt))
}

/** 生成一个随机主密码/口令候选（用于「我懒得想」的场景） */
export function randomPassphrase(words = 4) {
  const list = [
    'apple', 'brisk', 'cabin', 'delta', 'eagle', 'flame', 'grape', 'house',
    'ivory', 'jolly', 'kite', 'lemon', 'mango', 'noble', 'ocean', 'piano',
    'quartz', 'river', 'solar', 'tiger', 'unity', 'vivid', 'wheat', 'xenon',
    'yacht', 'zebra',
  ]
  const pick = () => list[Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] % list.length)]
  const parts = Array.from({ length: words }, pick)
  const num = crypto.getRandomValues(new Uint32Array(1))[0] % 100
  return `${parts.join('-')}-${num}`
}
