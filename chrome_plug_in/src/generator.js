/**
 * 密码生成器 + 强度估算。取样用 crypto.getRandomValues + 拒绝采样，
 * 保证每个字符等概率（`% 字符集长度` 直接取模会有偏）。
 */

const CLASSES = {
  lower: 'abcdefghijkmnopqrstuvwxyz', // 去掉 l
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', // 去掉 I O
  digit: '23456789', // 去掉 0 1
  symbol: '!@#$%^&*()-_=+[]{};:,.?',
}

const AMBIGUOUS_FULL = { lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', digit: '0123456789' }

/** 0–2^32 的均匀随机整数 */
function randomInt(max) {
  const limit = Math.floor(0x1_0000_0000 / max) * max
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % max
  }
}

function pick(str) {
  return str[randomInt(str.length)]
}

export function generatePassword({
  length = 20,
  lower = true,
  upper = true,
  digit = true,
  symbol = true,
  avoidAmbiguous = true,
} = {}) {
  const sets = []
  if (lower) sets.push(avoidAmbiguous ? CLASSES.lower : AMBIGUOUS_FULL.lower)
  if (upper) sets.push(avoidAmbiguous ? CLASSES.upper : AMBIGUOUS_FULL.upper)
  if (digit) sets.push(avoidAmbiguous ? CLASSES.digit : AMBIGUOUS_FULL.digit)
  if (symbol) sets.push(CLASSES.symbol)
  if (sets.length === 0) sets.push(CLASSES.lower)

  const all = sets.join('')
  const requested = Number(length)
  const size = Math.min(256, Math.max(Number.isFinite(requested) ? Math.floor(requested) : 20, sets.length, 4))
  const chars = []

  // 每一类先各来一个，避免「勾了符号却一个符号都没随机到」
  for (const set of sets) chars.push(pick(set))
  while (chars.length < size) chars.push(pick(all))

  // 洗牌（Fisher–Yates，随机源同上）
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/**
 * 粗略强度：只用于界面提示，不是严谨的熵计算。
 * 估算方式：字符集大小 ^ 长度 取对数，再按「是否像人编的」扣分。
 */
export function passwordStrength(password) {
  const pw = String(password ?? '')
  if (!pw) return { score: 0, label: '空', bits: 0 }

  let pool = 0
  if (/[a-z]/.test(pw)) pool += 26
  if (/[A-Z]/.test(pw)) pool += 26
  if (/\d/.test(pw)) pool += 10
  if (/[^A-Za-z0-9]/.test(pw)) pool += 24
  let bits = pw.length * Math.log2(Math.max(pool, 2))

  // 明显的偷懒模式扣分
  if (/^(.)\1+$/.test(pw)) bits = Math.min(bits, 10)
  if (/^(0123|1234|abcd|qwer|password|admin)/i.test(pw)) bits = Math.min(bits, 20)
  if (/^\d+$/.test(pw)) bits = Math.min(bits, pw.length * 3.32)

  const score = bits >= 90 ? 4 : bits >= 70 ? 3 : bits >= 50 ? 2 : bits >= 30 ? 1 : 0
  return { score, label: ['很弱', '弱', '一般', '强', '很强'][score], bits: Math.round(bits) }
}
