/**
 * 本机指标采集 —— 在主服务进程里直接采，不走网络。
 *
 * 服务器面板里「本机」是唯一不需要探针的一台：既然主服务就跑在这台机器上，
 * 没必要再开一个探针端口绕一圈。但它的输出必须和探针给出的**完全同构**，
 * 否则前端得为同一张卡片写两套取值逻辑。
 *
 * ⚠️ 探针（`agent/node/index.mjs`）是「零依赖单文件」，不能 import 本文件，
 * 所以那边有一份等价实现。**这份重复是刻意为之**：探针要能直接丢到服务器上
 * `node index.mjs` 就跑，不能依赖主程序的构建产物。两份都写了互相指认的注释，
 * 改采集口径时请同步修改 —— 字段名和单位必须完全一致，前端只认一套。
 */
import fs from 'node:fs'
import os from 'node:os'
import { statfs } from 'node:fs/promises'

/**
 * 首次调用没有上一次快照时，等这么久再采一次。
 * 宁可让第一个请求慢 200ms，也不要先返回 null 让前端白等一个刷新周期。
 */
const FIRST_SAMPLE_DELAY_MS = 200

/**
 * 两次采样的最小间隔。低于它就复用上次结果：
 * 差分窗口太短时，一个时钟 tick 的抖动就能把使用率刷成 0% 或 100%，
 * 面板 5 秒轮询一次虽然不会踩到，但多开页面 / 手动刷新会。
 */
const MIN_SAMPLE_INTERVAL_MS = 100

/** 磁盘最多列这么多条：面板详情区放不下更多，也没人看 */
const MAX_DISKS = 5

/**
 * 算「真实磁盘」的文件系统类型白名单。
 * 不筛的话 tmpfs / proc / cgroup 这些会把面板塞满，而且容量对用户毫无意义。
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
 * overlay 的设备名就叫 `overlay`，zfs 是池名 —— 它们不是块设备，但确实是存储。
 */
const NON_DEVICE_FS = new Set(['overlay', 'zfs'])

/** 单个挂载点的容量，单位为字节 */
export type ServerDisk = {
  mount: string
  total: number
  used: number
}

/** 前端契约，字段名不可改（探针必须返回同样的键） */
export type ServerMetrics = {
  hostname: string
  platform: string
  arch: string
  release: string
  cpu_model: string
  cpu_cores: number
  cpu_usage: number | null
  load: [number, number, number] | null
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  uptime: number
  disks: ServerDisk[]
  net_rx_rate: number | null
  net_tx_rate: number | null
  /** 全部非内部 IPv4 */
  lan_ips: string[]
  /** 走外部接口查到的公网 IP；查不到为 null */
  public_ip: string | null
  collected_at: number
}

// ── CPU 差分 ────────────────────────────────────────────────────

type CpuSnapshot = { at: number; idle: number; total: number }

/** 上一次的 CPU 累计值快照；null 表示本进程还没采过 */
let lastCpu: CpuSnapshot | null = null
/** 上一次算出的使用率，供「间隔过短」时复用 */
let lastCpuUsage: number | null = null

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** times 里每一项都是开机以来的累计 jiffies，差分才是「这一段的占用」 */
function readCpuSnapshot(): CpuSnapshot {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { at: Date.now(), idle, total }
}

/** 保留一位小数：前端进度条显示用，多给的精度只会让人怀疑数据来源 */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

async function sampleCpuUsage(): Promise<number | null> {
  if (lastCpu === null) {
    // 没有基准就没法差分：先记一次，等一小会儿再采，让第一次请求就有真值
    lastCpu = readCpuSnapshot()
    await delay(FIRST_SAMPLE_DELAY_MS)
  }

  if (Date.now() - lastCpu.at < MIN_SAMPLE_INTERVAL_MS) {
    // 有缓存就复用，且刻意不更新 lastCpu：保住更长的差分窗口，下次算出来反而更稳
    if (lastCpuUsage !== null) return lastCpuUsage
    // 没有缓存说明是并发的第一个请求捡到了别人刚建好的基准，
    // 窗口只有几毫秒，算出来必然是 0% 或 100% 这种噪声，宁可再等一拍
    await delay(FIRST_SAMPLE_DELAY_MS)
  }

  const now = readCpuSnapshot()
  const idleDelta = now.idle - lastCpu.idle
  const totalDelta = now.total - lastCpu.total
  lastCpu = now

  // 极端情况下（容器里 cpus() 为空、时钟回拨）总增量可能非正，此时别硬算
  if (totalDelta <= 0) return lastCpuUsage
  const used = 1 - idleDelta / totalDelta
  lastCpuUsage = round1(Math.min(100, Math.max(0, used * 100)))
  return lastCpuUsage
}

// ── 内存 / 交换分区 ─────────────────────────────────────────────

/** 从 /proc/meminfo 里取某个字段的 kB 值；取不到返回 null */
function readMeminfoKb(text: string, key: string): number | null {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
  return m?.[1] ? Number(m[1]) : null
}

/**
 * 交换分区只有 Linux 能读到（/proc/meminfo）。
 * 其它平台返回 0 而不是 null：契约里它是 number，
 * 而且「没有交换分区」和「用不了 0 字节」对用户是一回事。
 */
function readSwap(): { total: number; used: number } {
  if (process.platform !== 'linux') return { total: 0, used: 0 }
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const totalKb = readMeminfoKb(text, 'SwapTotal')
    const freeKb = readMeminfoKb(text, 'SwapFree')
    if (totalKb === null || freeKb === null) return { total: 0, used: 0 }
    const total = totalKb * 1024
    return { total, used: Math.max(0, total - freeKb * 1024) }
  } catch {
    // 读不到（受限容器 / 非标准内核）就当没有交换分区，不能因此让整次采集失败
    return { total: 0, used: 0 }
  }
}

// ── 磁盘 ────────────────────────────────────────────────────────

/** /proc/mounts 里的空格是转义过的（`\040`），不还原出来 statfs 会找不到路径 */
function decodeMountPath(raw: string): string {
  return raw.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\')
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
function listLinuxMounts(): string[] {
  let text: string
  try {
    text = fs.readFileSync('/proc/mounts', 'utf8')
  } catch {
    return []
  }

  const seen = new Set<string>()
  const mounts: string[] = []
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
  return mounts.slice(0, MAX_DISKS)
}

/**
 * 发现要展示的挂载点。只挑「用户心目中那块盘」，不做全盘遍历：
 * 这个列表直接进面板，多一条 tmpfs 就少一格版面。
 */
function listMounts(): string[] {
  const platform = process.platform
  if (platform === 'darwin') return ['/']
  if (platform === 'win32') {
    // SystemDrive 形如 `C:`，statfs 要的是 `C:\`
    const drive = (process.env.SystemDrive ?? 'C:').replace(/\\+$/, '')
    return [`${drive}\\`]
  }
  const found = listLinuxMounts()
  // 一个都没挑出来（受限容器、非标准挂载表）时退回根目录：
  // 面板上有一格比空着强，而 `/` 总是有的
  return found.length > 0 ? found : ['/']
}

async function collectDisks(): Promise<ServerDisk[]> {
  const disks: ServerDisk[] = []
  for (const mount of listMounts()) {
    try {
      const st = await statfs(mount)
      const total = st.bsize * st.blocks
      // 用 bfree 而不是 bavail：bavail 扣掉了 root 保留块，
      // 拿它算已用量会凭空多出一截「其实没被占用」的空间
      const used = st.bsize * (st.blocks - st.bfree)
      if (!Number.isFinite(total) || total <= 0) continue
      disks.push({ mount, total, used: Math.max(0, used) })
    } catch {
      // 单个挂载点读不到（权限、已卸载、网络盘掉线）就跳过这一条，
      // 整台机器的指标不能因为一块盘而全军覆没
      continue
    }
  }
  return disks
}

// ── 网络差分 ────────────────────────────────────────────────────

type NetSnapshot = { at: number; rx: number; tx: number }

let lastNet: NetSnapshot | null = null

/**
 * 累加所有非 lo 接口的收发字节数。
 * lo 是回环，主服务自己和自己的流量不该算进「这台机器的网速」。
 */
function readNetTotals(): NetSnapshot | null {
  if (process.platform !== 'linux') return null
  let text: string
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

/**
 * 首次没有快照时返回 null —— 这里**不**再等 200ms：
 * CPU 那次等待已经让请求慢了一拍，为了网速再来一次不划算，
 * 反正面板 5 秒轮询一次，第二个周期就有数了。
 */
function sampleNetRates(): { rx: number | null; tx: number | null } {
  const now = readNetTotals()
  if (!now) return { rx: null, tx: null }
  const prev = lastNet
  lastNet = now
  if (!prev) return { rx: null, tx: null }

  const seconds = (now.at - prev.at) / 1000
  // 计数器因网卡重置而回退时，差值会是负数，钳到 0 而不是报个荒唐的速率
  if (seconds <= 0) return { rx: null, tx: null }
  return {
    rx: Math.max(0, Math.round((now.rx - prev.rx) / seconds)),
    tx: Math.max(0, Math.round((now.tx - prev.tx) / seconds)),
  }
}

// ── 网络地址 ────────────────────────────────────────────────────

/** 全部非内部 IPv4。面板上用来显示「这台机器在内网的哪个地址」 */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

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

type PublicIpCache = { at: number; ip: string | null; ttl: number }
let publicIpCache: PublicIpCache | null = null
let publicIpInflight: Promise<void> | null = null

/** 从各种花里胡哨的返回里抠出 IPv4 */
function extractIpv4(text: string): string | null {
  const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(text)
  if (!m?.[1]) return null
  const parts = m[1].split('.').map(Number)
  if (parts.some((n) => n < 0 || n > 255)) return null
  return m[1]
}

async function fetchPublicIp(): Promise<string | null> {
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
 * 取公网 IP。**绝不让调用方等**：缓存过期时先在后台刷新，本次仍返回旧值（或 null）。
 * 面板是每 5 秒轮询一次指标接口的，为了一个公网 IP 挂住 4 秒不划算。
 */
function publicIp(): string | null {
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

// ── 汇总 ────────────────────────────────────────────────────────

/**
 * 采集本机指标。**本函数不抛异常**：面板少一格数据可以接受，
 * 整台机器因为一条读不到的信息变红不可接受。
 */
export async function collectMetrics(): Promise<ServerMetrics> {
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
    cpu_model: cpus[0]?.model.trim() ?? '',
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
    lan_ips: lanAddresses(),
    public_ip: publicIp(),
    collected_at: Date.now(),
  }
}

/** loadavg 的类型是 number[]，契约要的是定长三元组；顺手抹掉浮点尾巴 */
function toLoadTriple(values: number[]): [number, number, number] {
  const at = (i: number) => Math.round((values[i] ?? 0) * 100) / 100
  return [at(0), at(1), at(2)]
}
