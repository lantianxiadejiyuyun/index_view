/**
 * 密码哈希：只用 Node 内置 crypto 的 scrypt，零依赖、无原生编译。
 * 存储格式：scrypt$N$r$p$salt(base64url)$hash(base64url)
 */
import crypto from 'node:crypto'

const N = 16384 // CPU/内存成本
const R = 8
const P = 1
const KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P })
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const n = Number(parts[1])
    const r = Number(parts[2])
    const p = Number(parts[3])
    const salt = Buffer.from(parts[4]!, 'base64url')
    const expected = Buffer.from(parts[5]!, 'base64url')
    const actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p })
    // 定长比较，避免时序侧信道
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/** refresh token 是高熵随机串，用 sha256 存哈希即可，不需要 scrypt */
export function newRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url')
  return { raw, hash: sha256(raw) }
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}
