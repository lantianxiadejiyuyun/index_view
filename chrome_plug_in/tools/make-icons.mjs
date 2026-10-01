/**
 * 生成扩展图标（16/32/48/128），不引任何第三方库。
 *
 *   node tools/make-icons.mjs
 *
 * 自己写 PNG 编码器：PNG = 签名 + IHDR + IDAT(zlib deflate) + IEND，
 * 每行前面加一个 filter 字节（0 = 不用滤波）。node:zlib 的 deflateSync 就够。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'icons')

// ── PNG ──────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 画图标：圆角方块 + 一把锁 ────────────────────────────────

const BG = [79, 124, 255] // #4f7cff
const FG = [255, 255, 255]

/** 带抗锯齿的覆盖率：返回 0–1 */
function coverage(px, py, x0, y0, x1, y1, radius) {
  // 圆角矩形：先按四个角做距离场近似
  const cx = Math.min(Math.max(px, x0 + radius), x1 - radius)
  const cy = Math.min(Math.max(py, y0 + radius), y1 - radius)
  const d = Math.hypot(px - cx, py - cy)
  if (px < x0 - 1 || px > x1 + 1 || py < y0 - 1 || py > y1 + 1) return 0
  if (px >= x0 + radius && px <= x1 - radius) return 1
  if (py >= y0 + radius && py <= y1 - radius) return 1
  return Math.max(0, Math.min(1, radius - d + 0.5))
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4)
  const s = size / 32 // 以 32×32 为设计基准

  // 锁：body 10×8，shackle 半径 3
  const body = { x0: 10 * s, y0: 15 * s, x1: 22 * s, y1: 24 * s, r: 2 * s }
  const ringCx = 16 * s
  const ringCy = 15 * s
  const ringR = 4.2 * s
  const ringW = 1.8 * s

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5
      const py = y + 0.5

      const bgA = coverage(px, py, 0.5 * s, 0.5 * s, 31.5 * s, 31.5 * s, 7 * s)
      let fgA = coverage(px, py, body.x0, body.y0, body.x1, body.y1, body.r)

      // 锁梁：圆环的上半部分
      const dist = Math.hypot(px - ringCx, py - ringCy)
      if (py <= ringCy) {
        const ringA = Math.max(0, Math.min(1, ringW / 2 + 0.5 - Math.abs(dist - ringR)))
        fgA = Math.max(fgA, ringA)
      }
      // 锁孔
      const hole = Math.hypot(px - 16 * s, py - 19 * s) - 1.5 * s
      if (hole < 0) fgA = Math.max(0, fgA - Math.max(0, Math.min(1, -hole + 0.5)))

      const a = bgA
      const mix = (bg, fg) => Math.round(bg * (1 - fgA) + fg * fgA)
      const i = (y * size + x) * 4
      buf[i] = mix(BG[0], FG[0])
      buf[i + 1] = mix(BG[1], FG[1])
      buf[i + 2] = mix(BG[2], FG[2])
      buf[i + 3] = Math.round(a * 255 * (fgA > 0 ? 1 : 1))
    }
  }
  return encodePng(size, size, buf)
}

fs.mkdirSync(OUT, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT, `icon${size}.png`)
  fs.writeFileSync(file, render(size))
  console.log(`✓ ${path.relative(process.cwd(), file)}  ${size}×${size}`)
}
