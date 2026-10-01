/**
 * 把扩展文件夹打成一个 zip（Chrome 商店上传 / 分发都用它）。
 *
 * 不引第三方压缩库：zip 的格式就是「本地头 + 数据」+「中央目录」+「目录结束记录」，
 * 用 node:zlib 的 deflateRaw 就能写出标准的压缩 zip。
 *
 *   node scripts/pack-extension.mjs                       打包 chrome_plug_in/
 *   node scripts/pack-extension.mjs out/my-ext.zip        指定输出路径
 *   node scripts/pack-extension.mjs out/my-ext.zip 源目录  指定源目录
 *
 * 注意 zip 里**直接就是 manifest.json**（不能多套一层目录），Chrome 商店要求如此。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 扩展的源目录：默认 chrome_plug_in（密码管理器那个），换项目时用第二个参数指定
const SRC_DIR = process.argv[3] ?? 'chrome_plug_in'
const SRC = path.resolve(ROOT, SRC_DIR)

// ── crc32 ───────────────────────────────────────────────────

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

/** 把 JS 的 Date 转成 DOS 时间/日期（zip 用的老格式） */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time: time & 0xffff, date: day & 0xffff }
}

// ── 收集文件 ─────────────────────────────────────────────────

function walk(dir, base = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'tools', 'tests'].includes(entry.name)) continue
    if (entry.isSymbolicLink()) throw new Error(`扩展目录不能包含符号链接：${entry.name}`)
    const rel = base ? `${base}/${entry.name}` : entry.name
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(abs, rel))
    else out.push({ rel, abs })
  }
  return out
}

function buildZip(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const data = fs.readFileSync(file.abs)
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    // 压不下去就别压了，省得 zip 比原文件还大
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const name = Buffer.from(file.rel, 'utf8')
    const { time, date } = dosDateTime(fs.statSync(file.abs).mtime)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // 需要的版本
    local.writeUInt16LE(0x0800, 6) // 文件名是 UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, name, body)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4) // 制作版本
    dir.writeUInt16LE(20, 6) // 需要的版本
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(0, 38) // 外部属性
    dir.writeUInt32LE(offset, 42)

    central.push(dir, name)
    offset += local.length + name.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...chunks, centralBuf, end])
}

/** Validate bundled locale catalogs before writing an archive; keep manifest tokens in the ZIP. */
function validateLocales(manifest, files) {
  const messagePattern = /__MSG_([A-Za-z0-9_@]+?)__/g
  const references = new Set()
  const collectMessages = (value) => {
    if (typeof value === 'string') {
      for (const [, key] of value.matchAll(messagePattern)) references.add(key)
    } else if (Array.isArray(value)) value.forEach(collectMessages)
    else if (value && typeof value === 'object') Object.values(value).forEach(collectMessages)
  }
  collectMessages(manifest)

  const localeRoot = path.join(SRC, '_locales')
  const locales = fs.existsSync(localeRoot)
    ? fs.readdirSync(localeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name)
    : []
  if (!manifest.default_locale && (locales.length || references.size)) {
    throw new Error('扩展使用了 _locales 或 __MSG_*__，但 manifest 缺少 default_locale')
  }
  if (!manifest.default_locale) return manifest.name
  if (typeof manifest.default_locale !== 'string' || !locales.includes(manifest.default_locale)) {
    throw new Error(`找不到 default_locale 对应的语言目录：${String(manifest.default_locale)}`)
  }

  const present = new Set(files.map((file) => file.rel))
  const catalogs = new Map()
  for (const locale of locales) {
    const relative = `_locales/${locale}/messages.json`
    if (!present.has(relative)) throw new Error(`语言目录缺少 messages.json：${relative}`)
    let catalog
    try { catalog = JSON.parse(fs.readFileSync(path.join(SRC, relative), 'utf8')) }
    catch (err) { throw new Error(`${relative} 不是合法 JSON：${err.message}`) }
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      throw new Error(`${relative} 必须是消息对象`)
    }
    for (const [key, entry] of Object.entries(catalog)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.message !== 'string') {
        throw new Error(`${relative} 的 ${key} 缺少字符串 message`)
      }
    }
    const missing = [...references].filter((key) => !Object.hasOwn(catalog, key) || !catalog[key].message.trim())
    if (missing.length) throw new Error(`${relative} 缺少 manifest 引用的消息或译文为空：${missing.join(', ')}`)
    catalogs.set(locale, catalog)
  }
  const defaults = catalogs.get(manifest.default_locale)
  return typeof manifest.name === 'string'
    ? manifest.name.replace(messagePattern, (_token, key) => defaults[key].message)
    : manifest.name
}

// ── 主流程 ───────────────────────────────────────────────────

if (!fs.existsSync(path.join(SRC, 'manifest.json'))) {
  console.error(`找不到 ${SRC_DIR}/manifest.json`)
  console.error('（用第二个参数指定源目录，例如：node scripts/pack-extension.mjs out/x.zip 别的目录）')
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'))
} catch (err) {
  console.error('manifest.json 不是合法 JSON：', err.message)
  process.exit(1)
}

// 清单里引用的文件必须都在，否则装上去才发现少文件
const refs = new Set()
const collect = (v) => {
  if (typeof v === 'string') {
    if (/\.(html|js|png|css)$/.test(v)) refs.add(v)
  } else if (Array.isArray(v)) v.forEach(collect)
  else if (v && typeof v === 'object') Object.values(v).forEach(collect)
}
collect(manifest)

const files = walk(SRC)
let displayName
try { displayName = validateLocales(manifest, files) }
catch (err) {
  console.error('扩展本地化校验失败：', err.message)
  process.exit(1)
}
const present = new Set(files.map((f) => f.rel))
const missing = [...refs].filter((r) => !present.has(r))
if (missing.length > 0) {
  console.error('manifest 引用了不存在的文件：', missing.join(', '))
  process.exit(1)
}

// 文档和开发工具不属于浏览器运行文件；先检查语法，避免打出装不上/无法启动的包。
const packed = files.filter((f) => !/\.(md|map|zip)$/i.test(f.rel)).sort((a, b) => a.rel.localeCompare(b.rel))
for (const file of packed) {
  if (/\.(m?js)$/.test(file.rel)) execFileSync(process.execPath, ['--check', file.abs], { stdio: 'pipe' })
  if (/\.html$/.test(file.rel)) {
    const html = fs.readFileSync(file.abs, 'utf8')
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css|png))"/g)) {
      const absolute = path.resolve(path.dirname(file.abs), ref)
      const relative = path.relative(SRC, absolute).split(path.sep).join('/')
      if (!packed.some((item) => item.rel === relative)) throw new Error(`${file.rel} 引用了未打包的文件：${ref}`)
    }
  }
}

const outArg = process.argv[2]
const out = outArg
  ? path.resolve(process.cwd(), outArg)
  : path.join(ROOT, `${SRC_DIR}-${manifest.version}.zip`)

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, buildZip(packed))

const size = fs.statSync(out).size
console.log(`扩展：${displayName} v${manifest.version}`)
console.log(`打包 ${packed.length} 个文件：`)
for (const f of packed) console.log(`  ${f.rel}`)
console.log(`\n→ ${path.relative(ROOT, out)}  (${(size / 1024).toFixed(1)} KB)`)
