/** Build a source-only ZIP without copying local data or deleting existing paths.
 * Optional literal redactions: SANITIZE_RULES=/absolute/path/to/private-rules.json
 * Rules: { replacements: [{ find: "private value", replace: "example value" }], forbidden: ["private value"] }
 * Keep private rules outside Git; .sanitize.local.json is ignored by this project.
 */
import fs from 'node:fs'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const INCLUDE = [
  'README.md', '脱敏说明.md', 'PLAN.md', 'package.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'Dockerfile', 'docker-compose.yml', '.env.example',
  '.dockerignore', '.gitignore', 'app', 'agent', 'chrome_plug_in', 'scripts', 'tests',
]
const EXCLUDED_DIRS = new Set([
  '.git', '.tmp', 'node_modules', '.pnpm-store', '.venv', '__pycache__', '.idea', '.vscode',
])
const EXCLUDED_PATHS = new Set([
  'data', 'notes', 'uploads', 'backups', 'coverage', 'app/server/data',
  'app/server/dist', 'app/web/dist', 'agent/data', 'agent/backups',
])
const RULES_PATH = process.env.SANITIZE_RULES ? fs.realpathSync(path.resolve(process.env.SANITIZE_RULES)) : null
const config = RULES_PATH ? JSON.parse(fs.readFileSync(RULES_PATH, 'utf8')) : {}
const replacements = config.replacements ?? []
const forbidden = config.forbidden ?? []
if (!Array.isArray(replacements) || !Array.isArray(forbidden)
  || replacements.some((rule) => !rule || typeof rule.find !== 'string' || !rule.find || typeof rule.replace !== 'string')
  || forbidden.some((value) => typeof value !== 'string' || !value)) {
  throw new Error('Invalid local sanitization rules: use literal replacement and forbidden arrays')
}

function shouldSkip(relative, absolute) {
  const parts = relative.split(/[\\/]/)
  const name = parts.at(-1)
  if (parts.some((part) => EXCLUDED_DIRS.has(part.toLowerCase()))) return true
  const normalized = parts.join('/').toLowerCase()
  if ([...EXCLUDED_PATHS].some((entry) => normalized === entry || normalized.startsWith(`${entry}/`))) return true
  if (RULES_PATH && absolute === RULES_PATH) return true
  if (/^\.env(?:\..*)?$/i.test(name) && !/^\.env(?:\..*)?\.example$/i.test(name)) return true
  return /^(?:agent-key(?:\..*)?|services\.json|\.sanitize\.local\.json)$/i.test(name)
    || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(name)
    || /\.(?:key|pem|p12|pfx|zip|tar|gz|tgz|7z|log|bak|tsbuildinfo)$/i.test(name)
    || /\.backup(?:[.-].*)?$/i.test(name)
}
function textFile(file) {
  return /\.(?:md|ts|tsx|js|mjs|json|yml|yaml|html|css|sh|bat|example|txt|svg|ps1|py|toml)$/i.test(file)
    || ['.gitignore', '.dockerignore', 'Dockerfile'].includes(path.basename(file))
}
function prepareText(buffer, relative) {
  let text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  for (const { find, replace } of replacements) text = text.split(find).join(replace)
  if (forbidden.some((value) => text.includes(value))) throw new Error(`Local forbidden value remains in ${relative}`)
  if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{10,}/.test(text)) {
    throw new Error(`Credential marker detected in ${relative}`)
  }
  return Buffer.from(text, 'utf8')
}

const files = []
let totalBytes = 0
function collect(relative) {
  const absolute = path.resolve(ROOT, relative)
  if (!absolute.startsWith(`${ROOT}${path.sep}`)) throw new Error('Source path escaped the project')
  if (shouldSkip(relative, absolute)) return
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links must be reviewed before publishing: ${relative}`)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute).sort()) collect(path.join(relative, entry))
  } else if (stat.isFile()) {
    if (stat.size > 32 * 1024 * 1024) throw new Error(`Unexpectedly large source file: ${relative}`)
    const raw = fs.readFileSync(absolute)
    const content = textFile(relative) ? prepareText(raw, relative) : raw
    totalBytes += content.length
    if (totalBytes > 256 * 1024 * 1024) throw new Error('Source export exceeds 256 MiB; inspect local files first')
    files.push({ name: relative.replaceAll(path.sep, '/'), content })
  }
}
for (const entry of INCLUDE) if (fs.existsSync(path.join(ROOT, entry))) collect(entry)

// Small ZIP writer using built-in Node APIs; UTF-8 file names and deflate only.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function buildZip(entries) {
  if (entries.length > 65535) throw new Error('Too many source files for ZIP32')
  const local = [], central = []
  let offset = 0, centralSize = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    if (name.length > 65535) throw new Error('Source file name is too long')
    const compressed = deflateRawSync(entry.content)
    const crc = crc32(entry.content)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8)
    header.writeUInt16LE(0x0021, 12) // 1980-01-01, stable archive timestamp.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(entry.content.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, compressed)
    const index = Buffer.alloc(46)
    index.writeUInt32LE(0x02014b50, 0); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6)
    index.writeUInt16LE(0x0800, 8); index.writeUInt16LE(8, 10); index.writeUInt16LE(0x0021, 14)
    index.writeUInt32LE(crc, 16); index.writeUInt32LE(compressed.length, 20)
    index.writeUInt32LE(entry.content.length, 24); index.writeUInt16LE(name.length, 28)
    index.writeUInt32LE(offset, 42)
    central.push(index, name); centralSize += index.length + name.length
    offset += header.length + name.length + compressed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

const tempRoot = path.join(ROOT, '.tmp')
fs.mkdirSync(tempRoot, { recursive: true })
if (fs.realpathSync(tempRoot) !== tempRoot) throw new Error('Export directory must not be a symlink')
const outputDir = fs.mkdtempSync(path.join(tempRoot, 'source-export-'))
const archive = path.join(outputDir, 'home-dashboard-source.zip')
fs.writeFileSync(archive, buildZip(files), { flag: 'wx' })
console.log(`Created ${path.relative(ROOT, archive)} (${files.length} files)`)
console.log('Source and examples only. Review deployment values before publishing; use private local rules for additional redaction.')
