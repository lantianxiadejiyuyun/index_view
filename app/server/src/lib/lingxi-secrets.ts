import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { getSecrets } from '../db/schema.js'

function context(userId: number, purpose: string): Buffer {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[a-z][a-z0-9:_-]{0,100}$/.test(purpose)) throw new Error('Invalid Lingxi secret context')
  return Buffer.from(`home-dashboard:lingxi:${userId}:${purpose}:v1`)
}
function key(): Buffer {
  const secret = getSecrets().jwtSecret
  if (!secret) throw new Error('Server secret is not initialized')
  return Buffer.from(hkdfSync('sha256', secret, 'home-dashboard', 'lingxi-integration-v1', 32))
}
/** A separate purpose and user-bound AAD prevent moving ciphertext between accounts or uses. */
export function sealLingxiSecret(userId: number, purpose: string, value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(context(userId, purpose))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}
export function openLingxiSecret(userId: number, purpose: string, value: string): string {
  const [version, iv, tag, encrypted, extra] = value.split('.')
  if (version !== 'v1' || !iv || !tag || !encrypted || extra !== undefined || Buffer.from(iv, 'base64url').length !== 12 || Buffer.from(tag, 'base64url').length !== 16) throw new Error('Invalid encrypted Lingxi secret')
  const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
  cipher.setAAD(context(userId, purpose))
  cipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64url')), cipher.final()]).toString('utf8')
}
