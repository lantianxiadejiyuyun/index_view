/**
 * 裸机启动器（跨平台，零依赖）。
 *
 *   node scripts/start.mjs
 *
 * 为什么逻辑放在 Node 里而不是直接写 .bat / .sh：
 * cmd.exe 按系统 OEM 代码页读取批处理文件，UTF-8 的中文注释会被拆成乱码字节，
 * 直接变成「不是内部或外部命令」之类的报错，脚本根本跑不起来。
 * 把逻辑交给 Node，既只有一份实现，中文输出也正常。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const isWin = process.platform === 'win32'
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm'

function log(msg) {
  console.log(msg)
}

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

// ── Node 版本检查 ────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 5)) {
  die(
    `Node 版本过低（当前 v${process.versions.node}），需要 >= 22.5。\n` +
      '  内置的 node:sqlite 是这个版本才有的，程序依赖它做数据库。',
  )
}

// ── 构建产物检查 ─────────────────────────────────────────────
const BUNDLE = path.join(ROOT, 'app', 'server', 'dist', 'bundle.mjs')
const INDEX = path.join(ROOT, 'app', 'web', 'dist', 'index.html')

const needBuild = !fs.existsSync(BUNDLE) || !fs.existsSync(INDEX)
const skipBuild = process.env.SKIP_BUILD === '1'

if (needBuild && !skipBuild) {
  log('==> 检测到还没有构建产物，开始构建')

  const has = spawnSync(pnpm, ['--version'], { stdio: 'ignore', shell: isWin })
  if (has.status !== 0) {
    die(
      '需要 pnpm 来构建，但没有找到。\n' +
        '  装一个：npm i -g pnpm\n' +
        '  或者把已经构建好的 app/server/dist 与 app/web/dist 一起拷过来，再设 SKIP_BUILD=1 启动。',
    )
  }

  const run = (args, label) => {
    log(`==> ${label}`)
    const r = spawnSync(pnpm, args, { cwd: ROOT, stdio: 'inherit', shell: isWin })
    if (r.status !== 0) die(`${label} 失败`)
  }

  run(['install', '--frozen-lockfile'], '安装依赖')
  run(['-F', 'web', 'build'], '构建前端')
  run(['build:bundle'], '打包后端')
} else if (needBuild && skipBuild) {
  log('⚠ 构建产物不存在，但 SKIP_BUILD=1，直接尝试启动（多半会失败）')
}

// ── 启动 ─────────────────────────────────────────────────────
const port = process.env.PORT ?? '9200'

if (!fs.existsSync(BUNDLE)) {
  die(`找不到 ${path.relative(ROOT, BUNDLE)}。先跑一次不带 SKIP_BUILD 的启动来构建。`)
}

log(`==> 启动服务（端口 ${port}，数据目录 ${process.env.DATA_DIR ?? 'app/server/data'}）`)

const child = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', BUNDLE],
  { cwd: ROOT, stdio: 'inherit', env: process.env },
)

// 把中断信号透传给子进程，否则 Ctrl+C 只会杀掉启动器，服务变成孤儿进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill(sig)
  })
}

child.on('exit', (code, signal) => {
  process.exit(signal ? 0 : (code ?? 0))
})
