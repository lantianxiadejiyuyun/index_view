/**
 * 备份脚本（跨平台，零依赖）。
 *
 *   node scripts/backup.mjs [--out=./backups] [--with-notes] [--keep=10]
 *
 * 为什么不用「直接复制 app.db」：数据库开了 WAL 模式，
 * 正在写入时单独复制主库文件会丢掉还在 WAL 里的最新事务，备份出来是坏的。
 * 这里用 SQLite 官方的 VACUUM INTO，由数据库自己保证一致性快照。
 *
 * 笔记默认只在它位于数据目录内时才一起备份 —— 如果 NOTES_DIR 指向了网盘，
 * 那本来就有另一套同步机制，再复制一份既慢又没意义（加 --with-notes 可强制包含）。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

// 复用主程序的目录解析规则，避免两边算出不同的路径
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR ?? 'app/server/data')
const NOTES_DIR = path.resolve(ROOT, process.env.NOTES_DIR ?? path.join(DATA_DIR, 'notes'))
const DB_FILE = path.join(DATA_DIR, 'app.db')
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')

const outRoot = path.resolve(ROOT, arg('out', 'backups'))
const keep = Number(arg('keep', '10'))
const withNotes = hasFlag('with-notes')

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += fs.statSync(p).size
  }
  return total
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0
  fs.mkdirSync(to, { recursive: true })
  let n = 0
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) n += copyDir(src, dst)
    else if (entry.isFile()) {
      fs.copyFileSync(src, dst)
      n += 1
    }
  }
  return n
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`找不到数据库：${DB_FILE}`)
    console.error('如果服务还没启动过，先启动一次让它初始化。')
    process.exit(1)
  }

  const target = path.join(outRoot, `backup-${stamp()}`)
  fs.mkdirSync(target, { recursive: true })

  // 1) 数据库一致性快照
  const dbOut = path.join(target, 'app.db')
  const db = new DatabaseSync(DB_FILE, { readOnly: true })
  try {
    // VACUUM INTO 会生成一个已经整理过的、自洽的副本
    db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  console.log(`✓ 数据库   ${human(fs.statSync(dbOut).size)}`)

  // 2) 上传的图标与壁纸
  const uploads = copyDir(UPLOAD_DIR, path.join(target, 'uploads'))
  console.log(`✓ 上传文件 ${uploads} 个`)

  // 3) 笔记
  const notesInsideData = NOTES_DIR.startsWith(DATA_DIR + path.sep)
  if (withNotes || notesInsideData) {
    const notes = copyDir(NOTES_DIR, path.join(target, 'notes'))
    console.log(
      `✓ 笔记     ${notes} 个${notesInsideData ? '' : '（--with-notes 强制包含）'}`,
    )
  } else {
    console.log(
      `- 笔记     跳过（位于数据目录之外：${NOTES_DIR}）\n` +
        `           它应该在别处有自己的同步方案；要强制包含请加 --with-notes`,
    )
  }

  // 4) 清理旧备份
  if (keep > 0 && fs.existsSync(outRoot)) {
    const all = fs
      .readdirSync(outRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('backup-'))
      .map((d) => d.name)
      .sort()
    const stale = all.slice(0, Math.max(0, all.length - keep))
    for (const name of stale) {
      fs.rmSync(path.join(outRoot, name), { recursive: true, force: true })
      console.log(`- 清理旧备份 ${name}`)
    }
  }

  console.log(`\n备份完成：${target}`)
  console.log(`总大小 ${human(dirSize(target))}`)
  console.log('\n恢复方法：停掉服务，用备份里的 app.db / uploads / notes 覆盖回数据目录，再启动。')
}

main()
