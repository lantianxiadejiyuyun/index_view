#!/usr/bin/env node
/**
 * 内网探针 agent —— 单文件、零依赖，`node agent/node/index.mjs` 直接跑。
 *
 * 它做的事：
 *   1. 告诉主程序「这台机器上开了哪些端口、哪些是活的」，
 *      让首页能在内网环境下自动补全 url_lan / lan_port，不用手动填；
 *   2. 上报本机指标（CPU / 内存 / 磁盘 / 网速），供服务器面板的探针卡片使用。
 *   3. 推模式下领取服务器分配的订阅拉取任务，将内容和用量信息回传服务器。
 *
 * ── 两种上报方式 ──
 *   · **拉模式（默认）**：探针开个 HTTP 口，主程序来拉。
 *     要求主程序和探针在同一网络里。
 *   · **推模式（--server=）**：探针主动连出去，按固定间隔把指标 POST 给主程序。
 *     主程序在公网、探针在内网（NAT 后面）时只能用这个 —— 公网那台
 *     根本没有路由进来。加了 `--server=` 就是推模式，本机的 HTTP 口照样开着，
 *     两种方式可以同时用。
 *
 * 安全前提（很重要）：
 *   1. 默认只绑定内网网卡，不绑 0.0.0.0，也不建议暴露到公网；
 *   2. /api/services 必须带 X-Agent-Token，定长比较防时序侧信道；
 *   3. /api/info 刻意不鉴权（首页要靠它做自动发现），因此**只返回主机级
 *      非敏感信息**，绝不能带服务列表、环境变量、路径；
 *   4. 可选 AGENT_ALLOW_IPS 来源 IP 白名单。
 *
 * 只用 Node 内置模块，不引入 package.json，不改一行就能拷到任何机器上跑。
 */
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lookup as subscriptionLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

const VERSION = '1.2.0'
const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── 常见端口 → 服务名 ────────────────────────────────────────────
// 与服务端 app/server/src/lib/ports.ts 保持一致（探针不能 import TS，只能各存一份）

const HTTP = 'http'
const HTTPS = 'https'

/** @type {Record<number, { name: string, scheme?: 'http'|'https' }>} */
const SERVICE_MAP = {
  21: { name: 'FTP' },
  22: { name: 'SSH' },
  23: { name: 'Telnet' },
  25: { name: 'SMTP' },
  53: { name: 'DNS' },
  80: { name: 'Web (HTTP)', scheme: HTTP },
  110: { name: 'POP3' },
  111: { name: 'rpcbind' },
  135: { name: 'Windows RPC' },
  139: { name: 'SMB (NetBIOS)' },
  143: { name: 'IMAP' },
  161: { name: 'SNMP' },
  389: { name: 'LDAP' },
  443: { name: 'Web (HTTPS)', scheme: HTTPS },
  445: { name: 'SMB 文件共享' },
  465: { name: 'SMTPS' },
  514: { name: 'Syslog' },
  587: { name: 'SMTP (提交)' },
  631: { name: 'CUPS 打印服务', scheme: HTTP },
  873: { name: 'rsync' },
  993: { name: 'IMAPS' },
  995: { name: 'POP3S' },
  1080: { name: '代理 (SOCKS)' },
  1433: { name: 'SQL Server' },
  1521: { name: 'Oracle' },
  1883: { name: 'MQTT' },
  2049: { name: 'NFS' },
  2181: { name: 'ZooKeeper' },
  2375: { name: 'Docker API', scheme: HTTP },
  2376: { name: 'Docker API (TLS)', scheme: HTTPS },
  3000: { name: 'Node 应用', scheme: HTTP },
  3001: { name: 'Node 应用', scheme: HTTP },
  3002: { name: 'Node 应用', scheme: HTTP },
  3003: { name: 'Node 应用', scheme: HTTP },
  3128: { name: '代理 (HTTP)' },
  3306: { name: 'MySQL' },
  3389: { name: '远程桌面 (RDP)' },
  4369: { name: 'Erlang EPMD' },
  5000: { name: 'Synology DSM / Web 应用', scheme: HTTP },
  5001: { name: 'Synology DSM (HTTPS)', scheme: HTTPS },
  5044: { name: 'Logstash Beats' },
  5173: { name: 'Vite 开发服务器', scheme: HTTP },
  5432: { name: 'PostgreSQL' },
  5601: { name: 'Kibana', scheme: HTTP },
  5672: { name: 'RabbitMQ' },
  5900: { name: 'VNC' },
  5984: { name: 'CouchDB', scheme: HTTP },
  6379: { name: 'Redis' },
  6443: { name: 'Kubernetes API', scheme: HTTPS },
  7000: { name: 'Cassandra' },
  8000: { name: 'Web 应用', scheme: HTTP },
  8006: { name: 'Proxmox VE', scheme: HTTPS },
  8080: { name: 'Web 应用 (HTTP)', scheme: HTTP },
  8081: { name: 'Web 应用 (HTTP)', scheme: HTTP },
  8086: { name: 'InfluxDB', scheme: HTTP },
  8088: { name: 'Web 应用 (HTTP)', scheme: HTTP },
  8090: { name: 'Web 应用 (HTTP)', scheme: HTTP },
  8123: { name: 'Home Assistant', scheme: HTTP },
  8161: { name: 'ActiveMQ 控制台', scheme: HTTP },
  8200: { name: 'Vault', scheme: HTTP },
  8388: { name: '代理 (Shadowsocks)' },
  8443: { name: 'Web 应用 (HTTPS)', scheme: HTTPS },
  8500: { name: 'Consul', scheme: HTTP },
  8848: { name: 'Nacos', scheme: HTTP },
  8888: { name: 'Web 应用 / Jupyter', scheme: HTTP },
  9000: { name: 'Web 应用 / Portainer', scheme: HTTP },
  9001: { name: 'Web 应用 / Portainer (HTTPS)', scheme: HTTPS },
  9090: { name: 'Prometheus / Cockpit', scheme: HTTP },
  9091: { name: 'Transmission', scheme: HTTP },
  9092: { name: 'Kafka' },
  9200: { name: 'Elasticsearch / Web 服务', scheme: HTTP },
  9300: { name: 'Elasticsearch (节点通信)' },
  9418: { name: 'Git 协议' },
  9443: { name: 'Web 应用 (HTTPS)', scheme: HTTPS },
  11211: { name: 'Memcached' },
  11434: { name: 'Ollama', scheme: HTTP },
  15672: { name: 'RabbitMQ 管理台', scheme: HTTP },
  16379: { name: 'Redis (集群总线)' },
  25565: { name: 'Minecraft 服务器' },
  27017: { name: 'MongoDB' },
  32400: { name: 'Plex Media Server', scheme: HTTP },
  50000: { name: 'Jenkins Agent' },
}

/** 命中不了映射表时的兜底名字，前端直接显示这个字符串 */
function guessServiceName(port) {
  const hit = SERVICE_MAP[port]
  return hit ? hit.name : `端口 ${port}`
}

/** 端口推断协议；null = 不像 HTTP 服务（healthy 用 null 表示「不适用」） */
function guessScheme(port) {
  return SERVICE_MAP[port]?.scheme ?? null
}

// ── 命令行参数 ──────────────────────────────────────────────────

const HELP = `内网探针 agent v${VERSION} —— 零依赖单文件，扫描本机监听端口供首页自动发现

用法：
  node index.mjs --token=<令牌> [选项]

必填（二选一）：
  --token=<令牌>          探针令牌，也可以用环境变量 AGENT_TOKEN
                          （在主程序「设置 → 探针令牌」里获取）

选项：
  --server=<地址>         【推模式】主程序地址，例如 https://nav.example.com
                          或 http://192.168.1.10:9200。给了它就按间隔主动上报，
                          不用主程序来连（NAT 后面的机器必须用这个）
  --interval=<秒>         上报间隔，默认 10 秒（等价环境变量 AGENT_INTERVAL）
  --key=<路径>            专属密钥的存放位置，默认探针同目录的 agent-key
  --port=<端口>           监听端口，默认 9201（等价环境变量 PORT）
  --host=<地址>           绑定地址，默认自动挑选第一个内网 IPv4
                          显式写 --host=0.0.0.0 会监听所有网卡（不建议长期使用）
  --config=<路径>         服务清单 JSON，默认读同目录下的 services.json
  --name=<名称>           显示名，默认取主机名（等价环境变量 AGENT_NAME）
  --probe-all             对**所有**扫到的端口都做一次 HTTP 探活（默认只探常见 Web 端口）
  --print-config          打印一份可直接使用的服务清单示例后退出
  -h, --help              显示本帮助

环境变量：
  AGENT_TOKEN             同 --token
  AGENT_SERVER            同 --server
  AGENT_INTERVAL          同 --interval
  AGENT_KEY_FILE          同 --key
  AGENT_ALLOW_IPS         来源 IP 白名单，逗号分隔；设置后只放行这些 IP
  AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK
                          设为 true 才允许订阅任务访问内网 / 保留地址，默认 false
  AGENT_NAME              同 --name
  AGENT_DISK_MOUNTS       手工指定要上报的盘：「路径」或「路径=显示名」，逗号分隔。
                          容器里跑必须用它 —— 否则报上去的是容器的挂载表
                          （/、/data、…/overlay2/<hash>/merged），名字没法看，
                          而且好几项其实是同一块盘。例：/host/vol1=数据盘
  HOST / PORT             同 --host / --port

示例：
  node index.mjs --token=abcd1234 --port=9201
  node index.mjs --token=abcd1234 --server=https://nav.example.com --interval=10
  node index.mjs --token=abcd1234 --config=/etc/agent/services.json --probe-all

安全提示：探针会暴露「这台机器开了哪些端口」，请只在可信内网使用，
不要把端口映射到公网。推模式是探针往外连，不需要开任何入站端口。`

const CONFIG_SAMPLE = `{
  "services": [
    { "name": "我的博客", "port": 8080, "scheme": "http", "path": "/", "health_path": "/" },
    { "name": "NAS 面板", "port": 5001, "scheme": "https", "path": "/" },
    { "name": "内部 Wiki", "port": 3000, "scheme": "http", "path": "/wiki", "health_path": "/wiki/health" }
  ]
}`

/** 手写解析而不是用 parseArgs：要同时支持 --k=v 与 --k v，还要给出中文报错 */
function parseArgs(argv) {
  const flags = new Set()
  const values = new Map()
  const list = argv.slice(2)
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]
    if (!arg.startsWith('-')) continue
    const body = arg.replace(/^--?/, '')
    const eq = body.indexOf('=')
    if (eq !== -1) {
      values.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    // 只有「看起来该带值」的参数才吃掉下一个词，避免 --probe-all xxx 误吞
    const next = list[i + 1]
    if (VALUE_KEYS.has(body) && next !== undefined && !next.startsWith('-')) {
      values.set(body, next)
      i += 1
      continue
    }
    flags.add(body)
  }
  return { flags, values }
}

const VALUE_KEYS = new Set(['token', 'port', 'host', 'config', 'name', 'server', 'interval', 'key'])

const { flags, values } = parseArgs(process.argv)

if (flags.has('h') || flags.has('help')) {
  console.log(HELP)
  process.exit(0)
}
if (flags.has('print-config')) {
  console.log('// 保存为 services.json，放在探针同目录，或用 --config=<路径> 指定')
  console.log(CONFIG_SAMPLE)
  process.exit(0)
}

function pickValue(cliKey, envKey) {
  const v = values.get(cliKey) ?? process.env[envKey]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

// ── 基础配置 ────────────────────────────────────────────────────

const AGENT_TOKEN = pickValue('token', 'AGENT_TOKEN')
if (!AGENT_TOKEN) {
  console.error('')
  console.error('[agent] ✗ 缺少探针令牌，无法启动。')
  console.error('')
  console.error('  令牌是必填的：它决定谁能读取本机的端口清单。请二选一：')
  console.error('    1) 命令行传入： node index.mjs --token=<令牌>')
  console.error('    2) 环境变量：   AGENT_TOKEN=<令牌> node index.mjs')
  console.error('')
  console.error('  令牌获取方式：登录主程序 → 设置页 → 「探针令牌」（或 GET /api/agent-token）。')
  console.error('')
  process.exit(1)
}

const AGENT_NAME = pickValue('name', 'AGENT_NAME') ?? os.hostname()
const PORT = toPort(pickValue('port', 'PORT')) ?? 9201
const CONFIG_PATH = pickValue('config', 'AGENT_CONFIG') ?? path.join(HERE, 'services.json')
const PROBE_ALL = flags.has('probe-all')
const ALLOW_IPS = (process.env.AGENT_ALLOW_IPS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const TOKEN_HINT = `${AGENT_TOKEN.slice(0, 8)}...`

// ── 推模式配置 ──────────────────────────────────────────────────

/** 主程序地址；没给就是纯拉模式 */
const REPORT_TO = (pickValue('server', 'AGENT_SERVER') ?? '').replace(/\/+$/, '')

/** 上报间隔，秒。下限 5 秒：再密也没意义，指标本身就是十几秒一档的 */
const REPORT_INTERVAL_S = (() => {
  const raw = pickValue('interval', 'AGENT_INTERVAL')
  if (raw === null) return 10
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 5) return 10
  return Math.min(3600, Math.round(n))
})()

/** 单次上报的超时。给得比间隔短，免得请求堆积 */
const REPORT_TIMEOUT_MS = 8000

if (REPORT_TO && !/^https?:\/\//i.test(REPORT_TO)) {
  console.error('')
  console.error(`[agent] ✗ --server 要以 http:// 或 https:// 开头，现在给的是「${REPORT_TO}」`)
  console.error('')
  process.exit(1)
}

/**
 * 探针的稳定标识：主程序靠它在多次上报之间认出「还是那台机器」。
 *
 * 优先用 /etc/machine-id（Linux 上重装系统才会变），其它平台退到主机名。
 * 再哈希一次是为了：① 地址里只出现安全字符；② 不把主机名直接暴露在
 * push:// 地址和日志里。
 */
const AGENT_ID = (() => {
  let raw = ''
  try {
    raw = fs.readFileSync('/etc/machine-id', 'utf8').trim()
  } catch {
    // Windows / macOS 没有这个文件
  }
  if (!raw) raw = `${os.hostname()}|${process.platform}|${process.arch}`
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
})()

const VIRTUAL_HINT =
  /(vethernet|wsl|virtual|vmware|vbox|hyper-?v|loopback|docker|tailscale|zerotier|radmin|tap|tun|npcap|bluetooth)/i

const BIND_OVERRIDE = pickValue('host', 'HOST')
const BIND_HOST = BIND_OVERRIDE ?? pickBindHost()

function toPort(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** 全部非内部 IPv4，/api/info 与启动日志共用 */
function lanIps() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

/**
 * 默认绑定地址：第一个内网 IPv4。
 *
 * 但 os.networkInterfaces() 的枚举顺序在各平台上不可控，Windows 上
 * Hyper-V / WSL / VMware 的虚拟网卡经常排在真实网卡前面，绑上去等于白绑。
 * 所以这里打个分：名字像虚拟网卡的降权，典型家庭/办公内网段升权，
 * 同分时保持系统枚举顺序。
 */
function pickBindHost() {
  const candidates = []
  let index = 0
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      const addr = ni.address
      let score = 0
      if (VIRTUAL_HINT.test(name)) score -= 50
      if (/^192\.168\./.test(addr)) score += 30
      else if (/^10\./.test(addr)) score += 25
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) score += 20
      else if (/^169\.254\./.test(addr)) score -= 40 // APIPA，基本不可用
      candidates.push({ addr, score, index: index++ })
    }
  }
  if (candidates.length === 0) return '127.0.0.1'
  candidates.sort((a, b) => b.score - a.score || a.index - b.index)
  return candidates[0].addr
}

// ── 端口扫描 ────────────────────────────────────────────────────

/**
 * execFile（不是 exec）+ 超时：命令不存在或卡住都不能拖垮探针。
 *
 * 被超时杀掉时 stdout 里往往已经有**部分**输出，比空手而归有用，
 * 所以这里把 ok 和 stdout 分开返回，由调用方决定要不要将就用。
 */
function execFileAsync(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          resolve({ ok: !err || err.killed === true, stdout: String(stdout ?? '') })
        },
      )
    } catch {
      resolve({ ok: false, stdout: '' })
    }
  })
}

/** 从 `0.0.0.0:80` / `[::]:135` / `*:3000` 里抠出端口 */
function portFromAddr(addr) {
  if (!addr) return null
  const s = String(addr)
  const idx = s.lastIndexOf(':')
  if (idx === -1) return null
  const n = Number(s.slice(idx + 1))
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** 从同上格式里抠出 IPv4 监听地址；通配/ IPv6 一律返回 null，交给 127.0.0.1 兜底 */
function hostFromAddr(addr) {
  if (!addr) return null
  const s = String(addr)
  const idx = s.lastIndexOf(':')
  if (idx <= 0) return null
  const h = s.slice(0, idx)
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : null
}

/**
 * Linux：优先 `ss -ltnp`（能顺带拿到进程名），失败退化到 /proc/net/tcp。
 * 返回 Map<端口, { process, address }>；整体不可用时返回 null 让上层降级。
 */
async function scanLinux() {
  // 被超时截断的 ss 输出往往也有用，所以不苛求退出码，只看有没有 LISTEN 行
  const { stdout } = await execFileAsync('ss', ['-ltnp'])
  if (/LISTEN/i.test(stdout)) {
    const ports = new Map()
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t || !/^LISTEN/i.test(t)) continue
      const cols = t.split(/\s+/)
      // State Recv-Q Send-Q Local:Port Peer:Port [users:((...))]
      const port = portFromAddr(cols[3])
      if (port === null) continue
      const proc = /\(\("([^"]+)"/.exec(cols.slice(5).join(' '))?.[1] ?? null
      addPort(ports, port, proc, hostFromAddr(cols[3]))
    }
    if (ports.size > 0) return { method: 'ss -ltnp', ports }
  }

  // 退化方案：直接读 procfs。十六进制端口 + 状态 0A = LISTEN
  const ports = new Map()
  let readable = false
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    readable = true
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 4 || cols[3] !== '0A') continue
      const hex = cols[1]?.split(':')[1]
      if (!hex) continue
      const port = parseInt(hex, 16)
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        addPort(ports, port, null, null)
      }
    }
  }
  return readable ? { method: '/proc/net/tcp', ports } : null
}

let warnedTasklist = false

/** Windows：`netstat -ano`，再用 tasklist 把 PID 翻成进程名 */
async function scanWindows() {
  // 两条命令并发跑：串行时 tasklist 冷启动慢会直接把 /api/services 拖过 5 秒
  const [netstat, pidNames] = await Promise.all([
    execFileAsync('netstat', ['-ano']),
    processNameMap(),
  ])
  if (!netstat.stdout) return null
  if (pidNames.size === 0 && !warnedTasklist) {
    warnedTasklist = true
    console.warn('[agent] tasklist 未取到进程名（不影响端口扫描），process 字段会是 null')
  }

  const ports = new Map()
  for (const line of netstat.stdout.split('\n')) {
    const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line)
    if (!m) continue
    const port = portFromAddr(m[1])
    if (port === null) continue
    addPort(ports, port, pidNames.get(Number(m[2])) ?? null, hostFromAddr(m[1]))
  }
  return { method: 'netstat -ano', ports }
}

/** tasklist 的 CSV 输出形如 `"node.exe","1234","Console","1","30,000 K"` */
async function processNameMap() {
  // 给短一点的超时：拿不到进程名只是少一点信息，不能拖慢整个扫描
  const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], 3500)
  const map = new Map()
  for (const line of stdout.split('\n')) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim())
    if (m) map.set(Number(m[2]), m[1])
  }
  return map
}

/** macOS：`lsof -iTCP -sTCP:LISTEN -P -n` */
async function scanMac() {
  const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'])
  if (!stdout) return null
  const ports = new Map()
  for (const line of stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    // 最后一列通常是 "(LISTEN)"，NAME 在它前面
    let tail = cols[cols.length - 1]
    if (!tail || tail.startsWith('(')) tail = cols[cols.length - 2]
    const port = portFromAddr(tail)
    if (port === null) continue
    addPort(ports, port, cols[0] ?? null, hostFromAddr(tail))
  }
  return { method: 'lsof', ports }
}

/** 同一个端口可能被 0.0.0.0 和 127.0.0.1 各监听一次，保留更具体的那个地址 */
function addPort(ports, port, processName, address) {
  const prev = ports.get(port)
  if (!prev) {
    ports.set(port, { process: processName ?? null, address: address ?? null })
    return
  }
  if (!prev.process && processName) prev.process = processName
  if (!prev.address && address) prev.address = address
}

/**
 * 扫描本机监听端口。按平台分派，任一方案不可用就优雅降级
 * （例如受限容器里连 netstat 都没有 → 返回空表，靠 services.json 清单兜底）。
 */
async function scanListeningPorts() {
  const platform = process.platform
  try {
    if (platform === 'linux') {
      const r = await scanLinux()
      if (r) return r
    } else if (platform === 'win32') {
      const r = await scanWindows()
      if (r) return r
    } else {
      const r = await scanMac()
      if (r) return r
    }
  } catch (err) {
    console.warn(`[agent] 端口扫描异常，已降级：${err.message}`)
  }
  return { method: null, ports: new Map() }
}

// ── 服务清单（services.json）─────────────────────────────────────

/** 把用户写的路径统一成 `/xxx` 形式，非法值返回 null */
function normalizePath(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v) return null
  return v.startsWith('/') ? v : `/${v}`
}

/**
 * 读清单。文件不存在**不是错误**——纯扫描模式本来就是一等公民。
 * 只有「文件在但解析失败」才告警，因为那通常是用户写错了 JSON。
 */
function loadConfig() {
  let text
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[agent] 清单读取失败，已忽略：${err.message}`)
    }
    return null
  }

  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    console.warn(`[agent] 清单 JSON 解析失败，已忽略（纯扫描模式）：${err.message}`)
    return null
  }

  const list = Array.isArray(data) ? data : Array.isArray(data?.services) ? data.services : []
  const services = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const port = Number(item.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.warn(`[agent] 清单条目端口非法，已跳过：${JSON.stringify(item.name ?? item.port)}`)
      continue
    }
    const scheme = item.scheme === 'https' ? HTTPS : HTTP
    const rawName = typeof item.name === 'string' ? item.name.trim() : ''
    const p = normalizePath(item.path)
    services.push({
      name: (rawName || guessServiceName(port)).slice(0, 80),
      port,
      scheme,
      path: p,
      healthPath: normalizePath(item.health_path) ?? p ?? '/',
    })
  }
  return { services }
}

// ── HTTP 探活 ───────────────────────────────────────────────────

/**
 * 探一次活。用 node:http(s) 而不是 fetch，是为了能对自签证书的
 * 内网设备（群晖、路由器面板）设 rejectUnauthorized: false。
 * 只要拿到响应头就算活；连不上/超时就是 false。
 */
function probeHttp(port, scheme, host, probePath) {
  return new Promise((resolve) => {
    const mod = scheme === HTTPS ? https : http
    const started = Date.now()
    let settled = false
    const done = (healthy) => {
      if (settled) return
      settled = true
      resolve({ healthy, latency_ms: healthy ? Date.now() - started : null })
    }

    const req = mod.request(
      {
        host: host || '127.0.0.1',
        port,
        path: probePath || '/',
        method: 'GET',
        timeout: 1500,
        rejectUnauthorized: false,
        headers: {
          'user-agent': `home-dashboard-agent/${VERSION}`,
          accept: '*/*',
          connection: 'close',
        },
      },
      (res) => {
        res.destroy()
        done(true)
      },
    )
    req.on('timeout', () => {
      req.destroy()
      done(false)
    })
    req.on('error', () => done(false))
    req.end()
  })
}

/** 并发上限控制：20 个端口串行探活会拖到 30 秒，这里压到 8 路并发 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workerCount = Math.min(limit, items.length)
  const workers = []
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const i = cursor
          cursor += 1
          if (i >= items.length) return
          results[i] = await fn(items[i], i)
        }
      })(),
    )
  }
  await Promise.all(workers)
  return results
}

// ── 组装服务列表 ────────────────────────────────────────────────

let cache = { at: 0, payload: null }
const CACHE_TTL_MS = 3000 // 首页连点两次不必重复扫，3 秒足够新鲜

async function buildServices() {
  const now = Date.now()
  if (cache.payload && now - cache.at < CACHE_TTL_MS) return cache.payload

  const sources = []
  const scan = await scanListeningPorts()
  if (scan.method) sources.push('scan')

  const config = loadConfig()
  const configEntries = config?.services ?? []
  if (configEntries.length > 0) sources.push('config')

  // 清单为准：同名或同端口的扫描结果直接丢掉，避免一条服务出现两次
  const configPorts = new Set(configEntries.map((s) => s.port))
  const configNames = new Set(configEntries.map((s) => s.name))

  const services = configEntries.map((s) => ({
    name: s.name,
    port: s.port,
    scheme: s.scheme,
    ...(s.path ? { path: s.path } : {}),
    healthy: null,
    latency_ms: null,
    process: null,
    source: 'config',
    _probePath: s.healthPath,
    // 服务可能只绑了某个内网 IP，能扫到就按它的监听地址探，否则退回回环
    _host: scan.ports.get(s.port)?.address ?? '127.0.0.1',
  }))

  for (const [port, meta] of [...scan.ports.entries()].sort((a, b) => a[0] - b[0])) {
    if (port === PORT) continue // 探针自己的端口不算「服务」
    const name = guessServiceName(port)
    if (configPorts.has(port) || configNames.has(name)) continue
    services.push({
      name,
      port,
      scheme: guessScheme(port) ?? HTTP,
      healthy: null,
      latency_ms: null,
      process: meta.process ?? null,
      source: 'scan',
      _probePath: '/',
      _host: meta.address ?? '127.0.0.1',
    })
  }

  // 只探「已知是 HTTP 类」的端口；--probe-all 时全探。
  // 非 HTTP 端口 healthy 保持 null（不适用 ≠ 失败），前端据此不显示红点。
  const targets = services.filter(
    (s) => s.source === 'config' || PROBE_ALL || guessScheme(s.port) !== null,
  )
  const probed = await mapLimit(targets, 8, (s) =>
    probeHttp(s.port, s.scheme, s._host, s._probePath),
  )
  targets.forEach((s, i) => {
    const r = probed[i]
    if (!r) return
    s.healthy = r.healthy
    s.latency_ms = r.latency_ms
  })

  const payload = {
    services: services.map(({ _probePath, _host, ...rest }) => rest),
    scanned_at: Date.now(),
    sources,
  }
  cache = { at: now, payload }
  return payload
}

// ── 服务器指标采集 ──────────────────────────────────────────────
//
// ⚠ 口径必须和服务端 app/server/src/lib/sysinfo.ts 完全一致（字段名、单位、null 语义），
// 否则前端的「本机」卡片和探针卡片会呈现出两套数据。那边是 TS，探针不能 import，
// **这份重复是刻意为之**：探针的价值就在于「拷一个文件到任何机器就能跑」，
// 一旦为了复用而引入依赖或构建步骤，这个价值就没了。
// 改动采集口径时请两处同步修改。

/** 首次没有上一次 CPU 快照时等这么久再采，让第一次请求就有真值 */
const METRICS_FIRST_DELAY_MS = 200

/** 两次采样间隔低于它就复用上次结果，避免被连续请求刷成抖动 */
const METRICS_MIN_INTERVAL_MS = 100

/** 磁盘最多列这么多条 */
const METRICS_MAX_DISKS = 5

/**
 * 算「真实磁盘」的文件系统白名单，tmpfs / proc / cgroup 之类不算。
 *
 * `overlay` 必须留着：用 Docker 部署时容器根分区就是它。
 * 早先漏了它，结果容器里一块盘都识别不出来。
 */
const REAL_FS_TYPES = new Set([
  'ext2',
  'ext3',
  'ext4',
  'xfs',
  'btrfs',
  'zfs',
  'f2fs',
  'vfat',
  'exfat',
  'ntfs',
  'overlay',
])

/**
 * 不用 `/dev/xxx` 表示的文件系统。
 * overlay 的设备名就叫 `overlay`，zfs 是池名 —— 不是块设备，但确实是存储。
 */
const NON_DEVICE_FS = new Set(['overlay', 'zfs'])

/** 上一次的 CPU 累计值快照 + 上一次算出的使用率 */
let cpuSnapshot = null
let cpuUsageCache = null

/** 上一次的网络累计字节数快照 */
let netSnapshot = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 保留一位小数，和主服务那份保持一致 */
function round1(value) {
  return Math.round(value * 10) / 10
}

/** times 是开机以来的累计 jiffies，只有差分才代表「这一段」的占用 */
function readCpuSnapshot() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { at: Date.now(), idle, total }
}

async function sampleCpuUsage() {
  if (cpuSnapshot === null) {
    // 没有基准就没法差分：先记一次，等一小会儿再采
    cpuSnapshot = readCpuSnapshot()
    await sleep(METRICS_FIRST_DELAY_MS)
  }

  if (Date.now() - cpuSnapshot.at < METRICS_MIN_INTERVAL_MS) {
    // 有缓存就复用，且刻意不覆盖 cpuSnapshot：保住更长的差分窗口，下次算出来更稳
    if (cpuUsageCache !== null) return cpuUsageCache
    // 没有缓存说明是并发的第一个请求捡到了别人刚建好的基准，
    // 窗口只有几毫秒，算出来必然是 0% 或 100% 这种噪声，宁可再等一拍
    await sleep(METRICS_FIRST_DELAY_MS)
  }

  const now = readCpuSnapshot()
  const idleDelta = now.idle - cpuSnapshot.idle
  const totalDelta = now.total - cpuSnapshot.total
  cpuSnapshot = now

  // cpus() 为空或时钟回拨时总增量可能非正，此时别硬算
  if (totalDelta <= 0) return cpuUsageCache
  const used = 1 - idleDelta / totalDelta
  cpuUsageCache = round1(Math.min(100, Math.max(0, used * 100)))
  return cpuUsageCache
}

/** 从 /proc/meminfo 取某个字段的 kB 值，取不到返回 null */
function readMeminfoKb(text, key) {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
  return m && m[1] ? Number(m[1]) : null
}

/** 交换分区只有 Linux 能读；其它平台返回 0（契约里是 number，不是 null） */
function readSwap() {
  if (process.platform !== 'linux') return { total: 0, used: 0 }
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const totalKb = readMeminfoKb(text, 'SwapTotal')
    const freeKb = readMeminfoKb(text, 'SwapFree')
    if (totalKb === null || freeKb === null) return { total: 0, used: 0 }
    const total = totalKb * 1024
    return { total, used: Math.max(0, total - freeKb * 1024) }
  } catch {
    return { total: 0, used: 0 }
  }
}

/** /proc/mounts 里的空格是 `\040` 转义过的，不还原 statfs 会找不到路径 */
function decodeMountPath(raw) {
  return raw
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\')
}

/**
 * Linux：挑出「用户心目中那几块盘」。
 *
 * 两个必须做的过滤，都是实测踩出来的（在 Docker 容器里跑才暴露）：
 *
 *  1. **挂载点必须是目录**。Docker 会把 `/etc/resolv.conf`、`/etc/hostname`
 *     这类文件绑进容器，它们在 `/proc/mounts` 里长得和设备挂载一模一样 ——
 *     甚至带着 `/dev/sde` 这种设备名。只看设备名的话，一个配置文件会被当成一块磁盘
 *     （实测就是这样，面板上第一块盘显示的是 `/etc/resolv.conf`）。
 *  2. **overlay 要算数**。容器根分区是 overlay，设备名不是 `/dev/xxx`，
 *     按设备名过滤会把它一起扔掉，于是容器里一块盘都剩不下。
 */
function listLinuxMounts() {
  let text
  try {
    text = fs.readFileSync('/proc/mounts', 'utf8')
  } catch {
    return []
  }

  const seen = new Set()
  const mounts = []
  for (const line of text.split('\n')) {
    const cols = line.split(' ')
    const device = cols[0]
    const mount = cols[1]
    const type = cols[2]
    if (!device || !mount || !type) continue
    if (!REAL_FS_TYPES.has(type)) continue
    if (!device.startsWith('/dev/') && !NON_DEVICE_FS.has(type)) continue

    const target = decodeMountPath(mount)
    try {
      if (!fs.statSync(target).isDirectory()) continue
    } catch {
      continue
    }

    // 同一块设备常挂到多个路径，按设备名去重，只留第一个
    const key = NON_DEVICE_FS.has(type) ? `${type}:${target}` : device
    if (seen.has(key)) continue
    seen.add(key)
    mounts.push(target)
  }

  // `/` 排最前：它是用户最关心的那块盘，而 /proc/mounts 的顺序并不保证
  mounts.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : 0))
  return mounts.slice(0, METRICS_MAX_DISKS)
}

/** 要展示的挂载点：只挑用户心目中「那块盘」，不做全盘遍历 */
function listMounts() {
  if (process.platform === 'darwin') return ['/']
  if (process.platform === 'win32') {
    // SystemDrive 形如 `C:`，statfs 要的是 `C:\`
    const drive = (process.env.SystemDrive || 'C:').replace(/\\+$/, '')
    return [`${drive}\\`]
  }
  const found = listLinuxMounts()
  // 一个都没挑出来（受限容器、非标准挂载表）时退回根目录：
  // 面板上有一格比空着强，而 `/` 总是有的
  return found.length > 0 ? found : ['/']
}

/**
 * 手工指定要上报的盘：`路径` 或 `路径=显示名`，逗号分隔（环境变量 `AGENT_DISK_MOUNTS`）。
 *
 * **容器里跑必须用它**，否则报上去的是容器的挂载表：`/`（容器自己的 overlay）、
 * `/data`（密钥卷）、甚至 `…/overlay2/<hash>/merged` 这种别人的容器目录 ——
 * 名字没法看，而且好几项其实是同一块盘。只读绑进来的宿主机盘才是想报的那块。
 */
const DISK_OVERRIDE = (process.env.AGENT_DISK_MOUNTS ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const eq = item.indexOf('=')
    return eq === -1
      ? { path: item, label: item }
      : { path: item.slice(0, eq).trim(), label: item.slice(eq + 1).trim() }
  })
  .filter((item) => item.path !== '')

async function collectDisks() {
  // 手工指定的优先，且**完全替代**自动挑选（不是追加）：
  // 容器里自动挑出来的全是容器路径，混在一起只会更乱
  const targets =
    DISK_OVERRIDE.length > 0
      ? DISK_OVERRIDE
      : listMounts().map((mount) => ({ path: mount, label: mount }))

  const disks = []
  for (const { path: mount, label } of targets) {
    try {
      const st = await fs.promises.statfs(mount)
      const total = st.bsize * st.blocks
      // 用 bfree 而不是 bavail：bavail 扣掉了 root 保留块，
      // 拿它算已用量会凭空多出一截其实没被占用的空间
      const used = st.bsize * (st.blocks - st.bfree)
      if (!Number.isFinite(total) || total <= 0) continue
      disks.push({ mount: label, total, used: Math.max(0, used) })
    } catch {
      // 单个挂载点读不到就跳过这一条，整台机器不能因为一块盘全军覆没
      continue
    }
  }
  return disks
}

/** 累加所有非 lo 接口的收发字节；lo 是回环，不该算进这台机器的网速 */
function readNetTotals() {
  if (process.platform !== 'linux') return null
  let text
  try {
    text = fs.readFileSync('/proc/net/dev', 'utf8')
  } catch {
    return null
  }

  let rx = 0
  let tx = 0
  let found = false
  for (const line of text.split('\n')) {
    const sep = line.indexOf(':')
    if (sep === -1) continue // 表头行
    const name = line.slice(0, sep).trim()
    if (!name || name === 'lo') continue
    const cols = line.slice(sep + 1).trim().split(/\s+/)
    // receive: bytes packets errs drop fifo frame compressed multicast
    // transmit: bytes packets errs drop fifo colls carrier compressed
    const rxBytes = Number(cols[0])
    const txBytes = Number(cols[8])
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    rx += rxBytes
    tx += txBytes
    found = true
  }
  return found ? { at: Date.now(), rx, tx } : null
}

/** 首次没有快照时返回 null，**不**再等 200ms：CPU 那次等待已经够了 */
function sampleNetRates() {
  const now = readNetTotals()
  if (!now) return { rx: null, tx: null }
  const prev = netSnapshot
  netSnapshot = now
  if (!prev) return { rx: null, tx: null }

  const seconds = (now.at - prev.at) / 1000
  // 网卡重置会让计数器回退，负数速率没意义，钳到 0
  if (seconds <= 0) return { rx: null, tx: null }
  return {
    rx: Math.max(0, Math.round((now.rx - prev.rx) / seconds)),
    tx: Math.max(0, Math.round((now.tx - prev.tx) / seconds)),
  }
}

/** loadavg 的类型是数组，契约要定长三元组；顺手抹掉浮点尾巴 */
function toLoadTriple(values) {
  const at = (i) => Math.round((values[i] ?? 0) * 100) / 100
  return [at(0), at(1), at(2)]
}

// ── 公网 IP ─────────────────────────────────────────────────────

/**
 * 查公网 IP 的候选接口，按顺序试到第一个能用为止。
 * 全是纯文本返回，挑国内也能稳定访问的；任何一家挂了都不至于没有结果。
 */
const PUBLIC_IP_ENDPOINTS = [
  'https://myip.ipip.net',
  'https://ip.3322.net',
  'https://ifconfig.me/ip',
  'https://api.ipify.org',
]

/** 成功缓存 30 分钟；失败只缓存 3 分钟，早点重试 */
const PUBLIC_IP_TTL_MS = 30 * 60 * 1000
const PUBLIC_IP_FAIL_TTL_MS = 3 * 60 * 1000

let publicIpCache = null // { at, ip, ttl }
let publicIpInflight = null

/** 从各种花里胡哨的返回里抠出 IPv4 */
function extractIpv4(text) {
  const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(text || '')
  if (!m) return null
  const parts = m[1].split('.').map(Number)
  if (parts.some((n) => n < 0 || n > 255)) return null
  return m[1]
}

async function fetchPublicIp() {
  for (const url of PUBLIC_IP_ENDPOINTS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) continue
      const ip = extractIpv4(await res.text())
      if (ip) return ip
    } catch {
      // 这家不通就试下一家
    }
  }
  return null
}

/**
 * 取公网 IP。**绝不让调用方等**：缓存过期时先在后台刷新，
 * 本次仍返回旧值（或 null）。指标接口是每 5 秒被轮询的，
 * 为了一个公网 IP 挂住 4 秒不划算。
 */
function publicIp() {
  if (publicIpCache && Date.now() - publicIpCache.at < publicIpCache.ttl) {
    return publicIpCache.ip
  }

  if (!publicIpInflight) {
    publicIpInflight = fetchPublicIp()
      .then((ip) => {
        publicIpCache = {
          at: Date.now(),
          ip,
          ttl: ip ? PUBLIC_IP_TTL_MS : PUBLIC_IP_FAIL_TTL_MS,
        }
      })
      .catch(() => {
        publicIpCache = { at: Date.now(), ip: null, ttl: PUBLIC_IP_FAIL_TTL_MS }
      })
      .finally(() => {
        publicIpInflight = null
      })
  }

  return publicIpCache ? publicIpCache.ip : null
}

/**
 * 采集本机指标。字段名和 app/server/src/lib/sysinfo.ts 的 ServerMetrics 一一对应。
 * 本函数不抛异常：探针少报一项可以接受，整个接口 500 不可接受。
 */
async function collectMetrics() {
  const cpus = os.cpus()
  const cpuUsage = await sampleCpuUsage()
  const net = sampleNetRates()
  const swap = readSwap()
  const disks = await collectDisks()
  const memTotal = os.totalmem()

  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: os.arch(),
    release: os.release(),
    cpu_model: cpus[0] ? cpus[0].model.trim() : '',
    cpu_cores: cpus.length,
    cpu_usage: cpuUsage,
    // Windows 上 os.loadavg() 恒为 [0,0,0]，那是「不支持」而不是「没负载」
    load: process.platform === 'win32' ? null : toLoadTriple(os.loadavg()),
    mem_total: memTotal,
    mem_used: Math.max(0, memTotal - os.freemem()),
    swap_total: swap.total,
    swap_used: swap.used,
    uptime: os.uptime(),
    disks,
    net_rx_rate: net.rx,
    net_tx_rate: net.tx,
    // 内网 IP 直接用 /api/info 那份；公网 IP 走外部接口、有缓存
    lan_ips: lanIps(),
    public_ip: publicIp(),
    collected_at: Date.now(),
  }
}

// ── 推模式：主动上报 ────────────────────────────────────────────

/** 这把专属密钥存哪。放在探针旁边；权限 600，只有 root/本人读得到 */
const KEY_PATH = pickValue('key', 'AGENT_KEY_FILE') ?? path.join(HERE, 'agent-key')

function loadKey() {
  try {
    const k = fs.readFileSync(KEY_PATH, 'utf8').trim()
    return k || null
  } catch {
    return null
  }
}

function saveKey(key) {
  try {
    fs.writeFileSync(KEY_PATH, key, { mode: 0o600 })
    return true
  } catch (err) {
    console.warn(`[agent] 密钥写入失败（${KEY_PATH}）：${err instanceof Error ? err.message : err}`)
    return false
  }
}

/** 「还没被批准」不是错误，是一种正常状态，日志语气要不一样 */
class PendingApproval extends Error {}

/**
 * 拿共享令牌换一把专属密钥。
 *
 * 服务端只在**未批准**的节点上会下发密钥 —— 已批准的节点换密钥必须管理员
 * 在面板上点「重置密钥」。这是防止「令牌泄露 → 顶掉已批准节点」的关键。
 */
async function enroll() {
  const res = await fetch(`${REPORT_TO}/api/agent/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': AGENT_TOKEN },
    body: JSON.stringify({ agent_id: AGENT_ID, name: AGENT_NAME, hostname: os.hostname() }),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    redirect: 'error',
  })

  const body = await res.json().catch(() => ({}))

  if (res.status === 409) {
    throw new Error(
      '服务端说这台已经批准过了，但本地没有密钥。' +
        '请管理员在服务器面板上点该节点的「重置密钥」，然后重启本探针。',
    )
  }
  if (!res.ok || typeof body.key !== 'string' || !body.key) {
    throw new Error(body.message || `领取密钥失败：HTTP ${res.status}`)
  }

  return { key: body.key, approved: Boolean(body.approved) }
}

let AGENT_KEY = loadKey()
let reportOk = false
let reportFails = 0
let pendingLogged = false
let subscriptionApproved = false

async function reportOnce() {
  if (!AGENT_KEY) {
    const { key, approved } = await enroll()
    AGENT_KEY = key
    subscriptionInvalidateAuthorization()
    const saved = saveKey(key)
    console.log(`  ✓ 已领取专属密钥 ${key.slice(0, 6)}…${saved ? `（已存到 ${KEY_PATH}）` : '（⚠ 没能存盘，重启会重新领取）'}`)
    if (!approved) {
      console.log('  ⏳ 等待批准：登录主程序 →「服务器面板」→ 找到这台 → 点「批准」')
      console.log('')
    }
  }

  const metrics = await collectMetrics()
  const reportKey = AGENT_KEY
  const res = await fetch(`${REPORT_TO}/api/agent/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-key': reportKey },
    body: JSON.stringify({ agent_id: AGENT_ID, metrics }),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    redirect: 'error',
  })

  if (res.status === 401) {
    if (reportKey !== AGENT_KEY) return
    // 密钥被重置了（或服务端换了库）—— 把本地那份清掉，下一轮自动重新领
    AGENT_KEY = null
    subscriptionInvalidateAuthorization()
    try {
      fs.rmSync(KEY_PATH, { force: true })
    } catch {
      /* 删不掉就算了，反正内存里已经清空 */
    }
    pendingLogged = false
    throw new Error('密钥已失效（可能被管理员重置），下一轮会自动重新领取')
  }

  if (res.status === 403) {
    if (reportKey === AGENT_KEY) subscriptionInvalidateAuthorization()
    const body = await res.json().catch(() => ({}))
    throw new PendingApproval(body.message || '还没被批准')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? ` ${text.slice(0, 120)}` : ''}`)
  }
  if (reportKey === AGENT_KEY) subscriptionApproved = true
}

/**
 * 定时上报。
 *
 * 失败时**只是重试**，不做退避 —— 间隔本来就只有 10 秒，
 * 网络恢复后应当尽快接上。日志做了收敛：头两次说清楚，之后每 30 次
 * （约 5 分钟）才提一次，免得主程序没起来时把 journal 刷爆。
 */
function startReporter() {
  const tick = async () => {
    try {
      await reportOnce()
      if (!reportOk) {
        reportOk = true
        console.log(`  ✓ 已连上主程序，之后每 ${REPORT_INTERVAL_S} 秒上报一次`)
        console.log('')
      } else if (reportFails > 0 && !pendingLogged) {
        console.log(`[agent] 上报已恢复（之前失败 ${reportFails} 次）`)
      }
      reportFails = 0
      pendingLogged = false
    } catch (err) {
      reportFails += 1

      // 「等批准」是正常状态，不是故障：说一次就够，别每 10 秒刷一遍
      if (err instanceof PendingApproval) {
        if (!pendingLogged) {
          pendingLogged = true
          console.log(`[agent] ⏳ 仍在等待批准（${err.message}）`)
        }
        return
      }

      if (reportFails <= 2 || reportFails % 30 === 0) {
        const first = reportFails === 1
        console.warn(`[agent] 上报失败（第 ${reportFails} 次）：${err instanceof Error ? err.message : err}`)
        if (first) {
          console.warn(`        目标 ${REPORT_TO}`)
          console.warn('        检查地址是否可达、共享令牌是否正确（设置 → 探针令牌）')
        }
      }
    }
  }

  void tick()
  setInterval(tick, REPORT_INTERVAL_S * 1000)
}

// ── 订阅代拉：保持单文件部署，仅处理已批准服务端分配的任务 ────────────
const SUBSCRIPTION_MAX_BYTES = 2 * 1024 * 1024
const SUBSCRIPTION_ERROR_CODES = new Set([
  'NETWORK_UNREACHABLE', 'CONNECTION_REFUSED', 'CONNECTION_RESET', 'TIMEOUT',
  'DNS_ERROR', 'TLS_ERROR', 'HTTP_ERROR', 'TOO_LARGE', 'INVALID_URL',
  'PRIVATE_ADDRESS', 'FETCH_FAILED', 'UNSUPPORTED_ENCODING',
])
const subscriptionForbiddenV4 = new BlockList()
const subscriptionForbiddenV6 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) subscriptionForbiddenV4.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) subscriptionForbiddenV6.addSubnet(address, prefix, 'ipv6')
const subscriptionGlobalV6 = new BlockList()
subscriptionGlobalV6.addSubnet('2000::', 3, 'ipv6')

function isPublicSubscriptionAddress(address) {
  const family = isIP(address)
  if (family === 4) return !subscriptionForbiddenV4.check(address, 'ipv4')
  return family === 6 && subscriptionGlobalV6.check(address, 'ipv6') && !subscriptionForbiddenV6.check(address, 'ipv6')
}

// Only these fixed codes leave the worker. Native errors may contain credentials.
function subscriptionError(code, status) {
  const error = new Error(code)
  error.code = code
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.http_status = status
  return error
}

function subscriptionErrorCode(error, signal) {
  if (signal?.aborted) return 'TIMEOUT'
  if (SUBSCRIPTION_ERROR_CODES.has(error?.code)) return error.code
  const codes = new Set([error?.code, ...(Array.isArray(error?.errors) ? error.errors.map((item) => item?.code) : [])])
  if (codes.has('ETIMEDOUT') || codes.has('ERR_SOCKET_CONNECTION_TIMEOUT')) return 'TIMEOUT'
  if ([...codes].some((code) => typeof code === 'string' && (code.includes('CERT') || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'))) return 'TLS_ERROR'
  if (codes.has('ECONNRESET') || codes.has('EPIPE')) return 'CONNECTION_RESET'
  if (codes.has('ECONNREFUSED')) return 'CONNECTION_REFUSED'
  if (codes.has('ENETUNREACH') || codes.has('EHOSTUNREACH')) return 'NETWORK_UNREACHABLE'
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) return 'DNS_ERROR'
  return 'FETCH_FAILED'
}

function subscriptionUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw subscriptionError('INVALID_URL')
  let url
  try { url = new URL(value.trim()) } catch { throw subscriptionError('INVALID_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw subscriptionError('INVALID_URL')
  return url
}

async function subscriptionRequest(url, signal, allowPrivate, maxBytes) {
  signal.throwIfAborted()
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  const addresses = family ? [{ address: hostname, family }] : await new Promise((resolve, reject) => {
    const abort = () => reject(subscriptionError('TIMEOUT'))
    signal.addEventListener('abort', abort, { once: true })
    subscriptionLookup(hostname, { all: true, verbatim: true }).then(resolve, () => reject(subscriptionError('DNS_ERROR')))
      .finally(() => signal.removeEventListener('abort', abort))
  })
  signal.throwIfAborted()
  if (!addresses.length) throw subscriptionError('DNS_ERROR')
  if (!allowPrivate && addresses.some(({ address }) => !isPublicSubscriptionAddress(address))) throw subscriptionError('PRIVATE_ADDRESS')
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? https.request : http.request
    const req = request(url, {
      signal,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      // Pin all validated DNS results while keeping the original Host / SNI.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      },
      rejectUnauthorized: true,
      headers: {
        'user-agent': 'clash.meta',
        accept: 'application/yaml, text/yaml, text/plain, */*',
        'accept-encoding': 'gzip, deflate, br',
      },
      maxHeaderSize: 16 * 1024,
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        resolve({ status, headers: res.headers, body: Buffer.alloc(0) })
        res.destroy()
        return
      }
      if (status !== 200) {
        reject(subscriptionError('HTTP_ERROR', status))
        res.destroy()
        return
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        reject(subscriptionError('TOO_LARGE'))
        res.destroy()
        return
      }
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          reject(subscriptionError('TOO_LARGE'))
          res.destroy()
        } else chunks.push(chunk)
      })
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', () => reject(subscriptionError(signal.aborted ? 'TIMEOUT' : 'CONNECTION_RESET')))
      res.on('aborted', () => reject(subscriptionError(signal.aborted ? 'TIMEOUT' : 'CONNECTION_RESET')))
    })
    req.on('error', (error) => reject(subscriptionError(subscriptionErrorCode(error, signal))))
    req.end()
  })
}

async function fetchAgentSubscription(value, options = {}) {
  const allowPrivate = options.allowPrivate ?? process.env.AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK === 'true'
  const maxBytes = options.maxBytes ?? SUBSCRIPTION_MAX_BYTES
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  let url = subscriptionUrl(value)
  const seen = new Set()
  try {
    for (let hop = 0; hop <= 3; hop++) {
      if (seen.has(url.href)) throw subscriptionError('INVALID_URL')
      seen.add(url.href)
      const result = await subscriptionRequest(url, signal, allowPrivate, maxBytes)
      if (result.status >= 300 && result.status < 400) {
        if (hop === 3 || !result.headers.location) throw subscriptionError('INVALID_URL')
        let next
        try { next = subscriptionUrl(new URL(result.headers.location, url).href) }
        catch { throw subscriptionError('INVALID_URL') }
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw subscriptionError('INVALID_URL')
        url = next
        continue
      }
      let body = result.body
      const encoding = String(result.headers['content-encoding'] ?? '').trim().toLowerCase()
      try {
        if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: maxBytes })
        else if (encoding === 'deflate') body = inflateSync(body, { maxOutputLength: maxBytes })
        else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: maxBytes })
        else if (encoding && encoding !== 'identity') throw subscriptionError('UNSUPPORTED_ENCODING')
      } catch (error) {
        throw subscriptionError(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'TOO_LARGE' : 'UNSUPPORTED_ENCODING')
      }
      signal.throwIfAborted()
      if (body.length > maxBytes) throw subscriptionError('TOO_LARGE')
      const rawMetadata = result.headers['subscription-userinfo']
      const metadata = Array.isArray(rawMetadata) ? rawMetadata.join(';') : rawMetadata
      return {
        content_base64: body.toString('base64'),
        subscription_userinfo: typeof metadata === 'string' && metadata.length <= 1024 ? metadata : null,
      }
    }
    throw subscriptionError('INVALID_URL')
  } catch (error) {
    throw subscriptionError(subscriptionErrorCode(error, signal), error?.http_status)
  }
}

let subscriptionBusy = false
let subscriptionPending = null
let subscriptionQueued = null
let subscriptionTimer = null
let subscriptionConnection = null
let subscriptionReconnectAt = 0
let subscriptionReconnectAttempt = 0
let subscriptionEpoch = 0
let subscriptionFetchController = null
let subscriptionAuthController = new AbortController()
let subscriptionIdentityKey = AGENT_KEY
const subscriptionSeen = new Map()
const subscriptionShutdown = new AbortController()

function subscriptionWsUrl(value) {
  const url = subscriptionUrl(value)
  if (url.search) throw subscriptionError('INVALID_URL')
  if (url.protocol === 'https:' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw subscriptionError('TLS_ERROR')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/agent/subscriptions/ws`
  return url.href
}

function subscriptionDisconnect(connection = subscriptionConnection, code = 1000) {
  if (!connection || connection !== subscriptionConnection) return
  subscriptionConnection = null
  clearTimeout(connection.handshakeTimer)
  if (connection.ready && Date.now() - connection.readyAt >= 60_000) subscriptionReconnectAttempt = 0
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(subscriptionReconnectAttempt++, 5) * (0.75 + Math.random() * 0.5))
  subscriptionReconnectAt = Date.now() + delay
  // The browser-compatible WebSocket API only allows 1000 or 3000..4999 here.
  try { connection.socket.close(code >= 3000 ? code : 1000) } catch { /* no raw errors or addresses */ }
}

function subscriptionInvalidateAuthorization() {
  subscriptionApproved = false
  subscriptionEpoch++
  subscriptionAuthController.abort()
  subscriptionAuthController = new AbortController()
  subscriptionFetchController?.abort()
  subscriptionPending = null
  subscriptionQueued = null
  subscriptionIdentityKey = AGENT_KEY
  subscriptionDisconnect()
}

function subscriptionSendFrame(connection, frame) {
  if (connection !== subscriptionConnection || connection.socket.readyState !== WebSocket.OPEN) return false
  try { connection.socket.send(JSON.stringify(frame)); return true }
  catch { subscriptionDisconnect(connection); return false }
}

function subscriptionReceiveJob(connection, message) {
  const job = message.job
  const now = Date.now()
  const remaining = job?.expires_at - message.server_time
  if (!job || typeof job.id !== 'string' || !job.id.trim() || job.id.length > 128 || typeof job.url !== 'string' || job.url.length > 4096 ||
      !Number.isSafeInteger(job.expires_at) || !Number.isSafeInteger(message.server_time) || message.server_time <= 0 || remaining <= 0 || remaining > 120_000) return false
  // Reconnecting can replay a leased job. ACK receipt again without fetching it
  // twice, including while its previous HTTPS result is awaiting a retry.
  if (subscriptionSeen.has(job.id) || subscriptionQueued?.id === job.id) {
    return subscriptionSendFrame(connection, { type: 'ack', job_id: job.id })
  }
  // A source edit can invalidate a running job and immediately dispatch another.
  // Reserve exactly one queued slot; never acknowledge a job that was dropped.
  if (subscriptionQueued) return false
  subscriptionQueued = { id: job.id, url: job.url, expires_at: now + remaining, key: connection.key, epoch: subscriptionEpoch }
  if (!subscriptionSendFrame(connection, { type: 'ack', job_id: job.id })) return false
  void subscriptionTick()
  return true
}

function subscriptionConnect() {
  if (subscriptionConnection || !subscriptionApproved || !AGENT_KEY || subscriptionShutdown.signal.aborted) return
  let socket
  try { socket = new WebSocket(subscriptionWsUrl(REPORT_TO)) }
  catch { subscriptionReconnectAt = Date.now() + 30_000; return }
  socket.binaryType = 'arraybuffer'
  const connection = { socket, key: AGENT_KEY, ready: false, readyAt: 0, lastReceivedAt: Date.now(), lastPingAt: 0, handshakeTimer: null }
  subscriptionConnection = connection
  connection.handshakeTimer = setTimeout(() => subscriptionDisconnect(connection), 5000)
  socket.addEventListener('open', () => {
    if (connection !== subscriptionConnection || connection.key !== AGENT_KEY || !subscriptionApproved) return
    subscriptionSendFrame(connection, { type: 'auth', version: 1, agent_id: AGENT_ID, key: connection.key })
  })
  socket.addEventListener('message', (event) => {
    if (connection !== subscriptionConnection || connection.key !== AGENT_KEY || !subscriptionApproved) return
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 8192) { subscriptionDisconnect(connection, 1009); return }
    let message
    try { message = JSON.parse(event.data) } catch { subscriptionDisconnect(connection, 1002); return }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { subscriptionDisconnect(connection, 1002); return }
    if (!connection.ready) {
      if (message.type !== 'ready' || message.version !== 1 || message.heartbeat_ms !== 25_000 || !Number.isSafeInteger(message.server_time) || message.server_time <= 0) { subscriptionDisconnect(connection, 1002); return }
      connection.ready = true
      connection.readyAt = Date.now()
      connection.lastPingAt = Date.now()
      clearTimeout(connection.handshakeTimer)
    } else if (message.type === 'job') {
      if (!subscriptionReceiveJob(connection, message)) { subscriptionDisconnect(connection, 1002); return }
    } else if (message.type !== 'pong' || !Number.isSafeInteger(message.server_time) || message.server_time <= 0) {
      subscriptionDisconnect(connection, 1002)
      return
    }
    connection.lastReceivedAt = Date.now()
  })
  socket.addEventListener('close', (event) => {
    if (connection !== subscriptionConnection) return
    if ([1008, 4001, 4003, 4401, 4403].includes(event.code)) subscriptionInvalidateAuthorization()
    else subscriptionDisconnect(connection)
  })
  socket.addEventListener('error', () => subscriptionDisconnect(connection))
}

async function subscriptionControl(endpoint, body, key) {
  if (/^https:/i.test(REPORT_TO) && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw subscriptionError('TLS_ERROR')
  const res = await fetch(`${REPORT_TO}/api/agent/subscriptions/${endpoint}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-agent-key': key },
    body: JSON.stringify({ agent_id: AGENT_ID, ...body }),
    signal: AbortSignal.any([AbortSignal.timeout(10_000), subscriptionShutdown.signal, subscriptionAuthController.signal]),
  })
  // Read bounded JSON; control endpoints never need subscription body responses.
  if (!res.ok) { await res.body?.cancel(); return { status: res.status, body: null } }
  const chunks = []
  let size = 0
  for await (const chunk of res.body ?? []) {
    size += chunk.length
    if (size > 16 * 1024) throw subscriptionError('TOO_LARGE')
    chunks.push(chunk)
  }
  return { status: res.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
}

async function subscriptionSendPending() {
  const pending = subscriptionPending
  if (!pending) return
  if (pending.expires_at <= Date.now() || pending.key !== AGENT_KEY || !subscriptionApproved || pending.attempts >= 4) {
    subscriptionPending = null
    return
  }
  if (pending.retry_at > Date.now()) return
  pending.attempts++
  pending.retry_at = Date.now() + Math.min(20_000, 5000 * 2 ** (pending.attempts - 1))
  const response = await subscriptionControl('result', pending.result, pending.key)
  if (pending !== subscriptionPending || pending.key !== AGENT_KEY) return
  if (response.status === 401 || response.status === 403) subscriptionInvalidateAuthorization()
  if ([400, 401, 403, 404, 409, 410, 413].includes(response.status) || (response.status >= 200 && response.status < 300 && response.body?.ok === true)) {
    subscriptionPending = null
  }
}

async function subscriptionTick() {
  if (subscriptionIdentityKey !== AGENT_KEY) subscriptionInvalidateAuthorization()
  if (subscriptionPending && (subscriptionPending.expires_at <= Date.now() || subscriptionPending.key !== AGENT_KEY || !subscriptionApproved)) subscriptionPending = null
  if (subscriptionQueued && (subscriptionQueued.expires_at <= Date.now() || subscriptionQueued.key !== AGENT_KEY || !subscriptionApproved)) subscriptionQueued = null
  if (subscriptionShutdown.signal.aborted || !REPORT_TO || !AGENT_KEY || !subscriptionApproved) return
  for (const [id, expiry] of subscriptionSeen) if (expiry <= Date.now()) subscriptionSeen.delete(id)
  if (!subscriptionConnection && Date.now() >= subscriptionReconnectAt) subscriptionConnect()
  const connection = subscriptionConnection
  if (connection?.ready) {
    if (Date.now() - connection.lastReceivedAt >= 50_000) subscriptionDisconnect(connection)
    else if (Date.now() - connection.lastPingAt >= 25_000) {
      connection.lastPingAt = Date.now()
      subscriptionSendFrame(connection, { type: 'ping' })
    }
    if (Date.now() - connection.readyAt >= 60_000) subscriptionReconnectAttempt = 0
  }
  if (subscriptionBusy) return
  subscriptionBusy = true
  try {
    if (subscriptionPending) { await subscriptionSendPending(); return }
    const job = subscriptionQueued
    if (!job) return
    subscriptionQueued = null
    const key = job.key
    const epoch = subscriptionEpoch
    const deadline = job.expires_at
    subscriptionSeen.set(job.id, deadline)
    while (subscriptionSeen.size > 128) subscriptionSeen.delete(subscriptionSeen.keys().next().value)
    const controller = new AbortController()
    subscriptionFetchController = controller
    let result
    try {
      result = await fetchAgentSubscription(job.url, {
        timeoutMs: Math.max(1, Math.min(15_000, deadline - Date.now())),
        signal: AbortSignal.any([subscriptionShutdown.signal, controller.signal]),
      })
    } catch (error) {
      result = { error_code: subscriptionErrorCode(error) }
      if (result.error_code === 'HTTP_ERROR' && Number.isInteger(error.http_status)) result.http_status = error.http_status
    }
    if (epoch !== subscriptionEpoch || key !== AGENT_KEY || !subscriptionApproved || controller.signal.aborted) return
    subscriptionPending = { key, expires_at: deadline, attempts: 0, retry_at: 0, result: { job_id: job.id, ...result } }
    await subscriptionSendPending()
  } catch {
    // No URL, body, raw error or authentication material is printed to logs.
    // A failed result stays in memory for bounded retries, without re-fetching.
  } finally { subscriptionFetchController = null; subscriptionBusy = false }
}

function startSubscriptionWorker() {
  subscriptionTimer = setInterval(() => { void subscriptionTick() }, 1000)
}

function stopSubscriptionWorker() {
  clearInterval(subscriptionTimer)
  subscriptionShutdown.abort()
  subscriptionFetchController?.abort()
  subscriptionPending = null
  subscriptionQueued = null
  subscriptionDisconnect()
}

// ── HTTP 服务 ───────────────────────────────────────────────────

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    // 首页在某些部署下会直接从浏览器访问探针做发现，放开 CORS 才走得通。
    // 探针本来就只监听内网，这里不引入额外的公网暴露面。
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'X-Agent-Token, Content-Type',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '600',
  })
  res.end(text)
}

/** 定长比较。长度不等必须先挡掉，否则 timingSafeEqual 会直接抛错 */
function tokenMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(AGENT_TOKEN)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** 把 ::ffff:127.0.0.1 这类 IPv4-mapped 地址还原成 127.0.0.1 */
function normalizeIp(ip) {
  if (!ip) return ''
  const v = String(ip)
  return v.startsWith('::ffff:') ? v.slice(7) : v
}

function ipAllowed(remoteIp) {
  if (ALLOW_IPS.length === 0) return true
  return ALLOW_IPS.includes(normalizeIp(remoteIp))
}

async function handle(req, res) {
  const remoteIp = normalizeIp(req.socket?.remoteAddress ?? '')
  let pathname = '/'
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    pathname = '/'
  }
  const method = req.method ?? 'GET'

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'X-Agent-Token, Content-Type',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '600',
    })
    res.end()
    return
  }

  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed', message: '只支持 GET' })
    return
  }

  // 存活探针永远放行：白名单写错了也要能看出进程活着
  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (!ipAllowed(remoteIp)) {
    sendJson(res, 403, {
      error: 'forbidden',
      message: `来源 IP ${remoteIp || '未知'} 不在 AGENT_ALLOW_IPS 白名单内`,
    })
    return
  }

  // ⚠ 刻意不鉴权：首页要靠它做内网自动发现。
  // 所以这里返回的字段必须是不敏感的（绝不含服务列表 / 环境变量 / 文件路径）。
  if (pathname === '/api/info') {
    sendJson(res, 200, {
      name: AGENT_NAME,
      hostname: os.hostname(),
      version: VERSION,
      agent_port: PORT,
      lan_ips: lanIps(),
      platform: process.platform,
      uptime: Math.floor(process.uptime()),
    })
    return
  }

  if (pathname === '/api/services') {
    if (!tokenMatches(req.headers['x-agent-token'])) {
      sendJson(res, 401, {
        error: 'unauthorized',
        message: '缺少或错误的 X-Agent-Token（令牌取自主程序设置页）',
      })
      return
    }
    const payload = await buildServices()
    sendJson(res, 200, payload)
    return
  }

  if (pathname === '/api/metrics') {
    if (!tokenMatches(req.headers['x-agent-token'])) {
      sendJson(res, 401, {
        error: 'unauthorized',
        message: '缺少或错误的 X-Agent-Token（令牌取自主程序设置页）',
      })
      return
    }
    sendJson(res, 200, await collectMetrics())
    return
  }

  sendJson(res, 404, {
    error: 'not_found',
    message: '可用接口：GET /healthz、GET /api/info、GET /api/services、GET /api/metrics',
  })
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[agent] 处理请求异常：', err)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: '探针内部错误' })
    else res.end()
  })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[agent] ✗ 端口 ${PORT} 已被占用，请用 --port=<其它端口> 换一个。`)
  } else {
    console.error(`[agent] ✗ 启动失败：${err.message}`)
  }
  process.exit(1)
})

server.listen(PORT, BIND_HOST, () => {
  const lan = lanIps()
  const sameAsLan = lan.includes(BIND_HOST)
  const config = loadConfig()
  const configCount = config?.services.length ?? 0

  console.log('')
  console.log(`  ┌──────────────────────────────────────────────┐`)
  console.log(`  │  内网探针 agent v${VERSION.padEnd(28)}│`)
  console.log(`  └──────────────────────────────────────────────┘`)
  console.log(`  监听      http://${BIND_HOST}:${PORT}`)
  if (BIND_HOST === '0.0.0.0' || BIND_HOST === '::') {
    console.log('  ⚠ 已绑定所有网卡（0.0.0.0），仅建议临时排障时使用')
  } else if (sameAsLan || BIND_HOST === '127.0.0.1') {
    console.log('  ✓ 仅内网监听：未绑定 0.0.0.0，公网无法直连本探针')
  } else {
    console.log('  ⚠ 当前绑定地址不是本机内网 IP，请确认这是你要的网卡')
  }
  console.log(`  内网 IP   ${lan.length ? lan.join(', ') : '（未发现非内部 IPv4）'}`)
  console.log(`  Token     ${TOKEN_HINT}`)
  console.log(
    `  清单      ${
      configCount > 0 ? `${CONFIG_PATH}（${configCount} 条，已启用）` : '未启用（纯端口扫描模式）'
    }`,
  )
  console.log(`  IP 白名单 ${ALLOW_IPS.length ? ALLOW_IPS.join(', ') : '未启用'}`)
  console.log(`  探活范围  ${PROBE_ALL ? '全部端口' : '仅常见 Web 端口'}`)
  console.log(
    `  上报方式  ${
      REPORT_TO ? `推模式 → ${REPORT_TO}（每 ${REPORT_INTERVAL_S} 秒）` : '拉模式（等主程序来连）'
    }`,
  )
  console.log('')
  console.log(`  自检： curl -H "X-Agent-Token: ${TOKEN_HINT}" http://${BIND_HOST}:${PORT}/api/services`)
  console.log('')

  if (REPORT_TO) {
    startReporter()
    startSubscriptionWorker()
  }
})

let closing = false
function shutdown(signal) {
  if (closing) return
  closing = true
  stopSubscriptionWorker()
  console.log(`\n[agent] 收到 ${signal}，正在关闭…`)
  server.close(() => process.exit(0))
  // 兜底：3 秒后强制退出，避免被 keep-alive 连接挂住
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
