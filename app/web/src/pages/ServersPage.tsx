import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  HardDrive,
  KeyRound,
  Loader2,
  Network,
  Pencil,
  PanelTop,
  RefreshCw,
  Server,
  ShieldQuestion,
  Tag,
  TriangleAlert,
} from 'lucide-react'
import { PageShell } from '../components/PageShell.tsx'
import { CredentialRow } from '../components/CredentialRow.tsx'
import { Modal, btnGhost, btnPrimary, fieldClass, labelClass } from '../components/Modal.tsx'
import { api, errorMessage } from '../lib/api.ts'
import type { PanelCredential, ServerEntry, ServerMetrics, ServersResponse } from '../lib/types.ts'
import { toast } from '../store/toast.ts'

/** 面板的刷新节奏。服务端对每个节点有 3 秒缓存，5 秒一轮不会把探针打爆 */
const REFRESH_MS = 5000

type LoadMode = 'initial' | 'manual' | 'auto'

/** 语义色 token 的三档用量。不写死颜色，深浅主题各自取自己那套值 */
type Tone = 'success' | 'warn' | 'danger'

const TONE_BAR: Record<Tone, string> = {
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
}

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
}

/** < 70% 绿、70–89% 琥珀、≥ 90% 红 */
/** 完整的地址串，给 title 用（卡片上那一行会被截断） */
function addressTitle(m: ServerMetrics): string {
  const parts: string[] = []
  if (m.public_ip) parts.push(`公网 ${m.public_ip}`)
  if (m.lan_ips.length > 0) parts.push(`内网 ${m.lan_ips.join('、')}`)
  return parts.join('\n')
}

function usageTone(percent: number): Tone {
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return 'success'
}

/** 字节格式化：B / KB / MB / GB / TB，一律保留一位小数 */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, bytes)
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(1)} ${units[i]}`
}

/** 速率：字节格式 + /s。采不到（非 Linux）时是 —，不能显示成 0 */
function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '—'
  return `${formatBytes(bytesPerSec)}/s`
}

function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '—'
  return `${percent.toFixed(1)}%`
}

/** 运行时长说人话：「3 天 5 小时」「12 小时 30 分钟」「47 分钟」「12 秒」 */
function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  if (minutes > 0) return `${minutes} 分钟`
  return `${total} 秒`
}

function formatLoad(load: [number, number, number] | null, platform: string): string {
  if (!load) return platform === 'win32' ? 'Windows 不提供负载数据' : '—'
  return load.map((n) => n.toFixed(2)).join(' / ')
}

/** 时刻（HH:MM:SS）。采集时间/最后刷新用得到秒，只看时分看不出还在不在刷 */
function formatClock(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const PLATFORM_LABELS: Record<string, string> = {
  linux: 'Linux',
  win32: 'Windows',
  darwin: 'macOS',
  freebsd: 'FreeBSD',
}

function platformLabel(platform: string): string {
  if (!platform) return '未知系统'
  return PLATFORM_LABELS[platform] ?? platform
}

/** 已用占比。总量为 0（例如没有交换分区）时没有意义，返回 null 让调用方显示 — */
function ratio(used: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, (used / total) * 100))
}

/** 一条指标：标签 / 数值 / 进度条。数值为 null 时只留空槽，不画长度 */
function MetricRow({
  icon,
  label,
  percent,
  detail,
}: {
  icon: ReactNode
  label: string
  percent: number | null
  detail: string
}) {
  const tone = percent === null ? null : usageTone(percent)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 text-fg/60">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        <span className={`shrink-0 tabular-nums ${tone ? TONE_TEXT[tone] : 'text-fg/40'}`}>
          {detail}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line/15">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${tone ? TONE_BAR[tone] : ''}`}
          style={{ width: `${percent === null ? 0 : percent}%` }}
        />
      </div>
    </div>
  )
}

/** 展开区里的一行「标签：值」 */
function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] text-fg/50">{label}</span>
      <span className="min-w-0 truncate text-right text-[11px] text-fg/85">{value}</span>
    </div>
  )
}

/** 这台的「管理面板」有没有填过内容 */
function hasPanel(bt: PanelCredential): boolean {
  return Boolean(bt.url || bt.user || bt.pass || bt.note)
}

function ServerCard({
  entry,
  expanded,
  onToggle,
  onEdit,
  onApprove,
}: {
  entry: ServerEntry
  expanded: boolean
  onToggle: () => void
  onEdit?: () => void
  onApprove?: () => void
}) {
  const m = entry.metrics
  const offline = !entry.online || !m
  // 推模式且没批准：这台探针还连不上，卡片上要给一个「批准」按钮
  const pending = entry.mode === 'pushed' && !entry.approved

  const memPercent = m ? ratio(m.mem_used, m.mem_total) : null
  const firstDisk = m && m.disks.length > 0 ? m.disks[0] : null
  const diskPercent = firstDisk ? ratio(firstDisk.used, firstDisk.total) : null

  // 有指标或配了管理面板，就值得展开。离线时面板凭据照样能看 ——
  // 服务器挂了正是最需要翻面板密码的时候
  const canExpand = Boolean(m) || hasPanel(entry.bt)

  return (
    <section
      className={[
        // min-w-0：栅格项默认 min-width:auto，不放宽的话卡片会按内容撑出列宽
        'glass min-w-0 rounded-2xl p-4 transition sm:p-5',
        // 离线整卡降低存在感：压在壁纸上的玻璃本来就有底色，
        // 再叠一层灰会让字读不出来，所以只压不透明度、不改前景色
        offline ? 'opacity-75' : '',
      ].join(' ')}
    >
      {/* ── 卡头 ── */}
      {/* 手机上这块必须能换行：右侧「系统 · 内核 · 架构」是 shrink-0 的一行，
          和左边挤在一行会把卡片的最小宽度撑到 460px 以上，
          于是整个布局视口被浏览器放大到 484px，右边一整条被切掉（实测过） */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-44">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`size-2 shrink-0 rounded-full ${offline ? 'bg-danger' : 'bg-success'}`}
              aria-hidden
            />
            <h2 className="truncate text-sm font-semibold text-fg">{entry.name}</h2>
            <span className="shrink-0 rounded-md bg-line/15 px-1.5 py-0.5 text-[10px] text-fg/60">
              {entry.kind === 'local' ? '本机' : '探针'}
            </span>
            {pending && (
              <span className="shrink-0 rounded-md bg-warn/20 px-1.5 py-0.5 text-[10px] font-medium text-warn">
                待批准
              </span>
            )}
            <span className={`shrink-0 text-[10px] ${offline ? 'text-danger' : 'text-success'}`}>
              {offline ? '离线' : '在线'}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-fg/50">
            {m?.hostname || entry.base_url || '—'}
          </p>

          {/* 地址直接露在卡片上：多机环境下「这台到底是哪个 IP」是最常查的信息，
              藏进详情里每次都要点开 */}
          {m && (m.public_ip || m.lan_ips.length > 0) && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-fg/45" title={addressTitle(m)}>
              {m.public_ip && <span>公网 {m.public_ip}</span>}
              {m.public_ip && m.lan_ips.length > 0 && <span className="text-fg/25"> · </span>}
              {m.lan_ips.length > 0 && <span>内网 {m.lan_ips.join('、')}</span>}
            </p>
          )}

          {/* 标签跟在名字下面：它是这台机器的「身份」，不是指标 */}
          {entry.tags.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {entry.tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-md bg-accent/12 px-1.5 py-0.5 text-[10px] text-accent"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}

          {/* 备注可能写好几行，最多显示两行，完整内容靠 title 悬浮看 */}
          {entry.note && (
            <p
              title={entry.note}
              className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-fg/60"
            >
              {entry.note}
            </p>
          )}
        </div>

        <div className="flex items-start gap-1">
          {/* 离线时整块留空：这里每行都会是「—」，摆一排占位符只会显得像坏了 */}
          {m && (
            <div className="min-w-0 text-[11px] text-fg/50 sm:shrink-0 sm:text-right">
              <p className="truncate">
                {platformLabel(m.platform)} · {m.release} · {m.arch}
              </p>
              <p className="mt-0.5 tabular-nums">已运行 {formatUptime(m.uptime)}</p>
            </div>
          )}

          {/* 管理面板入口：配了地址才出现，点一下直接开面板 */}
          {entry.bt.url && (
            <a
              href={entry.bt.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`打开管理面板\n${entry.bt.url}`}
              aria-label={`打开 ${entry.name} 的管理面板`}
              className="shrink-0 rounded-lg p-1.5 text-fg/45 transition hover:bg-line/15 hover:text-fg"
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}

          {/* 备注和标签存在节点表里，本机存设置，两边都能编辑 */}
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              title="编辑名称、标签与备注"
              aria-label={`编辑 ${entry.name}`}
              className="shrink-0 rounded-lg p-1.5 text-fg/45 transition hover:bg-line/15 hover:text-fg"
            >
              <Pencil className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {offline ? (
        // 没有数据就不画进度条，否则满屏 0% 会让人以为机器真的空着。
        // 也不重复写「恢复了会自动出现」—— 错误信息本身已经说清楚了
        <div
          className={[
            'mt-3 rounded-xl border p-3 text-[11px] leading-relaxed',
            // 「待批准」是好消息（探针已经连上了，只差你点一下），
            // 用警示色会和真正的故障混在一起
            pending ? 'border-warn/25 bg-warn/10 text-warn' : 'border-danger/25 bg-danger/10 text-danger',
          ].join(' ')}
        >
          <div className="flex items-start gap-2">
            {pending ? (
              <ShieldQuestion className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            ) : (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            )}
            <span className="min-w-0">{entry.error || '这台服务器当前无法采集指标'}</span>
          </div>

          {pending && onApprove && (
            <button
              type="button"
              onClick={onApprove}
              className="mt-2.5 w-full rounded-lg bg-warn/20 px-3 py-2 text-xs font-medium text-warn transition hover:bg-warn/30"
            >
              <Check className="mr-1.5 inline size-3.5" aria-hidden />
              批准这台探针
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
            <MetricRow
              icon={<Activity className="size-3.5 shrink-0" aria-hidden />}
              label="CPU"
              percent={m.cpu_usage}
              detail={formatPercent(m.cpu_usage)}
            />
            <MetricRow
              icon={<Server className="size-3.5 shrink-0" aria-hidden />}
              label="内存"
              percent={memPercent}
              detail={
                memPercent === null
                  ? '—'
                  : `${formatBytes(m.mem_used)} / ${formatBytes(m.mem_total)}`
              }
            />
            <MetricRow
              icon={<HardDrive className="size-3.5 shrink-0" aria-hidden />}
              label={firstDisk ? `磁盘 ${firstDisk.mount}` : '磁盘'}
              percent={diskPercent}
              detail={
                firstDisk
                  ? `${formatBytes(firstDisk.used)} / ${formatBytes(firstDisk.total)}`
                  : '没有磁盘信息'
              }
            />
          </div>
      )}

      {/* 展开按钮和详情**移到在线分支外面**：离线时虽然没指标，
          但管理面板的地址和密码还是要能看 —— 服务器挂了正是最需要翻面板的时候 */}
      {canExpand && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="mt-3 flex w-full items-center justify-center gap-1 rounded-xl py-1.5 text-[11px] text-fg/60 transition hover:bg-line/10 hover:text-fg"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          {expanded ? '收起详情' : '展开详情'}
        </button>
      )}

      {expanded && canExpand && (
        <div className="animate-rise mt-2 space-y-2 border-t border-line/10 pt-3">
          {/* 指标区块只在有数据时出现；管理面板那一段离线也要显示 */}
          {m && (
            <>
              <div>
                <p className="mb-1 text-[11px] font-medium text-fg/45">处理器</p>
                <DetailRow label="型号" value={m.cpu_model || '—'} />
                <DetailRow label="核心数" value={m.cpu_cores > 0 ? `${m.cpu_cores} 核` : '—'} />
                <DetailRow label="负载（1/5/15 分钟）" value={formatLoad(m.load, m.platform)} />
              </div>

              <div>
                <p className="mb-1 text-[11px] font-medium text-fg/45">内存与交换</p>
                <DetailRow
                  label="物理内存"
                  value={`${formatBytes(m.mem_used)} / ${formatBytes(m.mem_total)}（${formatPercent(memPercent)}）`}
                />
                <DetailRow
                  label="交换分区"
                  value={
                    m.swap_total > 0
                      ? `${formatBytes(m.swap_used)} / ${formatBytes(m.swap_total)}（${formatPercent(ratio(m.swap_used, m.swap_total))}）`
                      : '无'
                  }
                />
              </div>

              <div>
                <p className="mb-1 text-[11px] font-medium text-fg/45">
                  磁盘
                  {m.disks.length > 0 && (
                    <span className="ml-1 font-normal text-fg/35">{m.disks.length} 个挂载点</span>
                  )}
                </p>
                {m.disks.length === 0 ? (
                  <p className="py-1 text-[11px] text-fg/40">没有读到挂载点。</p>
                ) : (
                  m.disks.map((d) => {
                    const p = ratio(d.used, d.total)
                    const tone = p === null ? null : usageTone(p)
                    return (
                      <div key={d.mount} className="py-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate font-mono text-[11px] text-fg/70">
                            {d.mount}
                          </span>
                          <span
                            className={`shrink-0 text-[11px] tabular-nums ${tone ? TONE_TEXT[tone] : 'text-fg/40'}`}
                          >
                            {formatBytes(d.used)} / {formatBytes(d.total)}
                          </span>
                        </div>
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-line/15">
                          <div
                            className={`h-full rounded-full ${tone ? TONE_BAR[tone] : ''}`}
                            style={{ width: `${p === null ? 0 : p}%` }}
                          />
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <div>
                <p className="mb-1 text-[11px] font-medium text-fg/45">地址</p>
                <DetailRow
                  label="公网 IP"
                  value={
                    m.public_ip ? (
                      <span className="font-mono">{m.public_ip}</span>
                    ) : (
                      // 别只显示「—」：内网机器查不到公网 IP 是正常的，
                      // 说一句原因，免得让人以为探针坏了
                      <span className="text-fg/45">没查到（内网机器或接口不通）</span>
                    )
                  }
                />
                <DetailRow
                  label="内网 IP"
                  value={
                    m.lan_ips.length > 0 ? (
                      <span className="font-mono">{m.lan_ips.join('、')}</span>
                    ) : (
                      '—'
                    )
                  }
                />
              </div>

              <div>
                <p className="mb-1 text-[11px] font-medium text-fg/45">网络</p>
                <DetailRow
                  label="下行"
                  value={
                    <span className="inline-flex items-center gap-1">
                      <Network className="size-3 text-fg/40" aria-hidden />
                      {formatRate(m.net_rx_rate)}
                    </span>
                  }
                />
                <DetailRow label="上行" value={formatRate(m.net_tx_rate)} />
                {m.net_rx_rate === null && (
                  <p className="pt-0.5 text-[10px] leading-relaxed text-fg/35">
                    这个平台没有可用的网卡计数（只有 Linux 能读 /proc/net/dev）。
                  </p>
                )}
              </div>

              <div className="border-t border-line/10 pt-2">
                <DetailRow label="采集时间" value={formatClock(m.collected_at)} />
                {entry.kind === 'agent' && (
                  <DetailRow label="最近上报" value={formatClock(entry.last_seen_at)} />
                )}
              </div>
            </>
          )}

          {/* 管理面板：不依赖指标，离线时照样能翻地址和密码 */}
          {hasPanel(entry.bt) && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-fg/45">管理面板</p>
              {entry.bt.url && <CredentialRow label="地址" value={entry.bt.url} />}
              {entry.bt.user && <CredentialRow label="账号" value={entry.bt.user} />}
              {entry.bt.pass && <CredentialRow label="密码" value={entry.bt.pass} secret />}
              {entry.bt.note && <DetailRow label="备注" value={entry.bt.note} />}
              {entry.bt.url && (
                <a
                  href={entry.bt.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                >
                  <ExternalLink className="size-3" aria-hidden />
                  打开面板
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * 编辑一台服务器：名称、标签、备注。
 *
 * 标签和备注都存在 agent_nodes 表里，所以只有探针节点能编辑 ——
 * 「本机」没有数据库记录，服务端返回的就是 null / 空数组。
 */
function EditServerDialog({
  entry,
  allTags,
  onClose,
  onSaved,
  onResetKey,
}: {
  entry: ServerEntry | null
  allTags: string[]
  onClose: () => void
  onSaved: () => void
  /** 推模式节点：重置密钥（会打回待批准） */
  onResetKey?: () => void
}) {
  const [name, setName] = useState('')
  const [tagText, setTagText] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  // 管理面板（宝塔之类）的入口与凭据
  const [btUrl, setBtUrl] = useState('')
  const [btUser, setBtUser] = useState('')
  const [btPass, setBtPass] = useState('')
  const [btNote, setBtNote] = useState('')

  // 每次打开都用节点当前的值重置表单，免得上一次的输入残留
  useEffect(() => {
    if (!entry) return
    setName(entry.name)
    setTagText(entry.tags.join('，'))
    setNote(entry.note ?? '')
    setBtUrl(entry.bt.url)
    setBtUser(entry.bt.user)
    setBtPass(entry.bt.pass)
    setBtNote(entry.bt.note)
    setSaving(false)
  }, [entry])

  // 注意：hook 必须在任何提前 return 之前
  if (!entry) return null

  const noteLeft = 500 - note.length
  // 前端这份解析只为「即时预览」，真正的规范化在服务端做（去重、截断都在那边）
  const preview = tagText
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)

  async function save() {
    if (!entry) return
    const isLocal = entry.kind === 'local'
    const trimmed = name.trim()
    // 本机的名字是服务端写死的「本机」，没有改名的入口
    if (!isLocal && !trimmed) {
      toast.error('名称不能为空')
      return
    }

    setSaving(true)
    try {
      // 本机在 agent_nodes 里没有记录，走单独接口，且只能改备注和标签
      const path = isLocal ? '/api/servers/local' : `/api/nodes/${entry.id}`
      const bt = { url: btUrl.trim(), user: btUser.trim(), pass: btPass, note: btNote.trim() }
      const body = isLocal
        ? { tags: preview, note: note.trim(), bt }
        : { name: trimmed, tags: preview, note: note.trim(), bt }

      await api(path, { method: 'PUT', body: JSON.stringify(body) })
      toast.success('已保存')
      onSaved()
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={`编辑「${entry.name}」`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={btnGhost}>
            取消
          </button>
          <button type="button" onClick={() => void save()} disabled={saving} className={btnPrimary}>
            {saving && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            保存
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 本机没有名字可改（服务端固定叫「本机」），那就不摆一个改不动的输入框 */}
        {entry.kind === 'agent' ? (
          <div>
            <label className={labelClass} htmlFor="srv-name">
              名称
            </label>
            <input
              id="srv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              className={fieldClass}
              placeholder="例如 腾讯云 · 广州"
            />
          </div>
        ) : (
          <p className="rounded-xl border border-line/12 bg-line/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-fg/55">
            「本机」的名字是固定的。这里可以给它写备注、打标签，方便和别的机器区分。
          </p>
        )}

        <div>
          <label className={labelClass} htmlFor="srv-tags">
            标签
          </label>
          <input
            id="srv-tags"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            className={fieldClass}
            placeholder="用逗号分隔，例如 生产，海外"
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg/50">
            中英文逗号都行，最多 10 个、每个 24 字以内。标签会显示在卡片上，也能用来筛选。
          </p>

          {preview.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1">
              {preview.map((tag) => (
                <li
                  key={tag}
                  className="rounded-md bg-accent/12 px-1.5 py-0.5 text-[10px] text-accent"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}

          {/* 已经用过的标签点一下就能加，省得每次手打 */}
          {allTags.filter((t) => !preview.includes(t)).length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-fg/45">用过的：</span>
              {allTags
                .filter((t) => !preview.includes(t))
                .map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setTagText((prev) => (prev.trim() ? `${prev.replace(/[,，]\s*$/, '')}，${tag}` : tag))}
                    className="rounded-md bg-line/12 px-1.5 py-0.5 text-[10px] text-fg/65 transition hover:bg-line/22 hover:text-fg"
                  >
                    + {tag}
                  </button>
                ))}
            </div>
          )}
        </div>

        <div>
          <label className={labelClass} htmlFor="srv-note">
            备注
          </label>
          <textarea
            id="srv-note"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={3}
            className={`${fieldClass} resize-y leading-relaxed`}
            placeholder="例如：跑数据库，2026-03 到期，续费走公司卡"
          />
          <p className={`mt-1.5 text-right text-[11px] ${noteLeft < 50 ? 'text-warn' : 'text-fg/45'}`}>
            还可输入 {noteLeft} 字
          </p>
        </div>

        {/* 管理面板（宝塔之类）：填了地址卡片上就会出现一个入口按钮 */}
        <div className="rounded-2xl border border-line/12 bg-line/[0.04] p-3.5">
          <div className="mb-3 flex items-start gap-2">
            <PanelTop className="mt-0.5 size-3.5 shrink-0 text-fg/45" aria-hidden />
            <div className="min-w-0">
              <h3 className="text-xs font-medium text-fg">管理面板</h3>
              <p className="mt-0.5 text-[11px] leading-relaxed text-fg/50">
                宝塔之类的面板地址与账号。填了地址，卡片右上角就会出现入口按钮。
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className={labelClass} htmlFor="srv-bt-url">
                面板地址
              </label>
              <input
                id="srv-bt-url"
                value={btUrl}
                onChange={(e) => setBtUrl(e.target.value)}
                className={`${fieldClass} font-mono text-xs`}
                placeholder="https://1.2.3.4:8888/xxxxxxxx"
                inputMode="url"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass} htmlFor="srv-bt-user">
                  账号
                </label>
                <input
                  id="srv-bt-user"
                  value={btUser}
                  onChange={(e) => setBtUser(e.target.value)}
                  className={`${fieldClass} font-mono text-xs`}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="srv-bt-pass">
                  密码
                </label>
                <input
                  id="srv-bt-pass"
                  value={btPass}
                  onChange={(e) => setBtPass(e.target.value)}
                  className={`${fieldClass} font-mono text-xs`}
                  autoComplete="new-password"
                />
              </div>
            </div>

            <div>
              <label className={labelClass} htmlFor="srv-bt-note">
                面板备注
              </label>
              <input
                id="srv-bt-note"
                value={btNote}
                onChange={(e) => setBtNote(e.target.value)}
                maxLength={300}
                className={fieldClass}
                placeholder="例如：安全入口在地址里，端口 8888"
              />
            </div>

            <p className="text-[11px] leading-relaxed text-fg/45">
              密码是<b className="font-medium text-fg/70">明文存在你自己的数据库</b>里的，
              别把导出的数据随便发人。卡片上默认打码，点眼睛才显示。
            </p>
          </div>
        </div>

        {/* 推模式节点的密钥管理。探针换机器、重装系统、密钥文件丢了时用得上 */}
        {entry.mode === 'pushed' && (
          <div className="rounded-2xl border border-line/12 bg-line/[0.04] p-3.5">
            <h3 className="text-xs font-medium text-fg">探针密钥</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-fg/50">
              {entry.has_key
                ? '这台已经领过专属密钥。重置之后它会重新领一把，并且需要你再批准一次才能恢复上报。'
                : '这台还没领到密钥。等探针下次启动（或重启服务）时会自动来领。'}
            </p>
            <button
              type="button"
              onClick={() => onResetKey?.()}
              className="mt-2.5 w-full rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs font-medium text-danger transition hover:bg-danger/20"
            >
              <KeyRound className="mr-1.5 inline size-3.5" aria-hidden />
              重置密钥
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

export function ServersPage() {

  const [data, setData] = useState<ServersResponse | null>(null)
  // loading 只在首次加载和手动刷新时点亮：自动刷新每 5 秒一次，
  // 每次都闪一下 loading 会让整页一直在抖
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 当前筛选的标签，null 表示不筛 */
  const [activeTag, setActiveTag] = useState<string | null>(null)
  /** 正在编辑的节点，null 表示弹窗关着 */
  const [editing, setEditing] = useState<ServerEntry | null>(null)

  const timerRef = useRef<number | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const inFlightRef = useRef(false)
  const aliveRef = useRef(true)
  /**
   * 请求序号。手动刷新可能和「首次加载」或上一拍轮询撞在一起，
   * 只有序号最新的那次才允许写状态 —— 否则先发后到的旧响应会把
   * 新数据覆盖掉，旧请求的 finally 还会把刷新中的转圈提前掐掉（实测过）。
   */
  const reqIdRef = useRef(0)

  const load = useCallback(async (mode: LoadMode) => {
    if (!aliveRef.current) return
    // 轮询请求不叠加：上一次还没回来就跳过这一拍（手动刷新不受影响）
    if (mode === 'auto' && inFlightRef.current) return

    const id = reqIdRef.current + 1
    reqIdRef.current = id
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    inFlightRef.current = true

    if (mode !== 'auto') {
      setLoading(true)
      setRefreshing(true)
    }

    try {
      const res = await api<ServersResponse>('/api/servers', {}, { signal: controller.signal })
      if (!aliveRef.current || id !== reqIdRef.current) return
      setData(res)
      setUpdatedAt(Date.now())
      setError(null)
    } catch (err) {
      if (controller.signal.aborted || !aliveRef.current || id !== reqIdRef.current) return
      const message = errorMessage(err, '加载服务器指标失败')
      setError(message)
      // 自动刷新失败只留在页面上，不弹 toast —— 否则每 5 秒弹一次没法用
      if (mode !== 'auto') toast.error(message)
    } finally {
      if (id === reqIdRef.current) {
        requestRef.current = null
        inFlightRef.current = false
        if (aliveRef.current && mode !== 'auto') {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true

    void load('initial')

    const stop = () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    const start = () => {
      if (timerRef.current !== null) return
      timerRef.current = window.setInterval(() => void load('auto'), REFRESH_MS)
    }

    // 页面切到后台就停表，回来时立刻补一次再恢复轮询：
    // 后台空转只会白白打探针，而回来后第一眼看到的也必须是新数据
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        void load('auto')
        start()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    if (!document.hidden) start()

    return () => {
      aliveRef.current = false
      requestRef.current?.abort()
      requestRef.current = null
      reqIdRef.current += 1
      inFlightRef.current = false
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [load])

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /**
   * 批准一台推模式探针。
   *
   * 批准前那台探针的上报是被服务端拒收的（403），所以点完立刻刷一次面板 ——
   * 探针下一次上报（最多 10 秒）就会带数据上来了，用户不用等 5 秒的自动刷新。
   */
  const approve = useCallback(
    async (entry: ServerEntry) => {
      if (typeof entry.id !== 'number') return
      try {
        await api(`/api/nodes/${entry.id}`, {
          method: 'PUT',
          body: JSON.stringify({ approved: true }),
        })
        toast.success(`已批准「${entry.name}」，等它下一次上报`)
        await load('manual')
      } catch (err) {
        toast.error(errorMessage(err, '批准失败'))
      }
    },
    [load],
  )

  /**
   * 重置某台探针的密钥。会把它打回「待批准」—— 所以这不是提权操作，
   * 拿到新密钥的人仍然要管理员再批一次。
   */
  const resetKey = useCallback(
    async (entry: ServerEntry) => {
      if (typeof entry.id !== 'number') return
      if (!window.confirm(`重置「${entry.name}」的密钥？\n\n探针下次启动会重新领一把，并且需要你再批准一次才能恢复上报。`)) {
        return
      }
      try {
        const res = await api<{ message?: string }>(`/api/nodes/${entry.id}/reset-key`, {
          method: 'POST',
        })
        toast.success(res.message ?? '已重置')
        setEditing(null)
        await load('manual')
      } catch (err) {
        toast.error(errorMessage(err, '重置失败'))
      }
    },
    [load],
  )

  const servers = data?.servers ?? []
  const online = servers.filter((s) => s.online && s.metrics).length
  const offline = servers.length - online

  // 所有出现过的标签，按出现次数排序（常用的排前面）
  const allTags = useMemo(() => {
    const count = new Map<string, number>()
    for (const s of servers) {
      for (const tag of s.tags) count.set(tag, (count.get(tag) ?? 0) + 1)
    }
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag)
  }, [servers])

  const shown = activeTag ? servers.filter((s) => s.tags.includes(activeTag)) : servers

  // 正在筛的标签可能因为改名/删标签而消失，那就自动取消筛选，
  // 否则页面会一直空着、看起来像坏了
  useEffect(() => {
    if (activeTag && !allTags.includes(activeTag)) setActiveTag(null)
  }, [activeTag, allTags])

  return (
    <PageShell
      title="服务器面板"
      description="本机与所有探针节点的实时负载，每 5 秒自动刷新"
      wide
      actions={
        <button
          type="button"
          onClick={() => void load('manual')}
          disabled={refreshing}
          // 玻璃样式：这一页从上到下（汇总条、标签筛选、卡片）都是 glass，
          // 只有这个按钮是纯边框会显得是「别处搬来的」
          className="glass rounded-xl px-4 py-2 text-sm font-medium text-fg/85 transition hover:text-fg disabled:opacity-60"
          title="立即刷新"
        >
          {refreshing ? (
            <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="mr-1.5 inline size-3.5" aria-hidden />
          )}
          刷新
        </button>
      }
    >
      <div className="space-y-4">
        {/* ── 汇总 ── */}
        <div className="glass flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl px-4 py-3 text-xs">
          {data ? (
            <>
              <span className="text-fg/80">
                共 <span className="font-semibold tabular-nums">{servers.length}</span> 台
              </span>
              <span className="text-fg/25" aria-hidden>
                ·
              </span>
              <span className="text-success">
                在线 <span className="font-semibold tabular-nums">{online}</span>
              </span>
              <span className="text-fg/25" aria-hidden>
                ·
              </span>
              <span className={offline > 0 ? 'text-danger' : 'text-fg/50'}>
                离线 <span className="font-semibold tabular-nums">{offline}</span>
              </span>
            </>
          ) : (
            <span className="text-fg/60">正在读取服务器指标…</span>
          )}

          <span className="ml-auto flex items-center gap-1.5 text-fg/45 tabular-nums">
            {refreshing && <Loader2 className="size-3 animate-spin" aria-hidden />}
            最后刷新 {formatClock(updatedAt)}
          </span>
        </div>

        {/* ── 标签筛选 ── 一台机器就几个标签，做成点一下就筛，不引入下拉框 */}
        {allTags.length > 0 && (
          <div className="glass flex flex-wrap items-center gap-1.5 rounded-2xl px-4 py-2.5">
            <Tag className="size-3.5 shrink-0 text-fg/45" aria-hidden />
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className={[
                'rounded-lg px-2 py-1 text-[11px] font-medium transition',
                activeTag === null ? 'bg-accent/15 text-accent' : 'text-fg/60 hover:bg-line/15 hover:text-fg',
              ].join(' ')}
            >
              全部 {servers.length}
            </button>
            {allTags.map((tag) => {
              const count = servers.filter((s) => s.tags.includes(tag)).length
              const active = activeTag === tag
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setActiveTag(active ? null : tag)}
                  aria-pressed={active}
                  className={[
                    'rounded-lg px-2 py-1 text-[11px] font-medium transition',
                    active ? 'bg-accent/15 text-accent' : 'text-fg/60 hover:bg-line/15 hover:text-fg',
                  ].join(' ')}
                >
                  {tag} {count}
                </button>
              )
            })}
          </div>
        )}

        {error && (
          <div className="glass flex items-start gap-2 rounded-2xl border border-danger/25 p-4 text-xs leading-relaxed text-danger">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p>{error}</p>
              <p className="mt-1 text-danger/70">
                指标接口需要登录。自动刷新失败时不会打断你，恢复后下一页数据会自己接上。
              </p>
            </div>
          </div>
        )}

        {loading && !data ? (
          <div className="glass flex flex-col items-center gap-2 rounded-2xl px-6 py-14 text-center">
            <Loader2 className="size-5 animate-spin text-fg/50" aria-hidden />
            <p className="text-xs text-fg/60">正在读取服务器指标…</p>
          </div>
        ) : servers.length === 0 ? (
          <div className="glass flex flex-col items-center gap-2 rounded-2xl px-6 py-14 text-center">
            <Server className="size-7 text-fg/50" aria-hidden />
            <p className="text-sm text-fg/80">还没有可以展示的服务器</p>
            <p className="max-w-md text-xs leading-relaxed text-fg/50">
              「本机」这一项恒存在。要加入其它机器，去「服务对接」里添加探针节点。
            </p>
            <Link to="/services" className={`${btnGhost} mt-1`}>
              去服务对接
            </Link>
          </div>
        ) : (
          /* 手动/首次刷新时把已有内容压暗一点示意「正在更新」，
             但不清空、不换成骨架屏 —— 那样就是每点一次闪一下。
             grid-cols-1 不能省：没有它，列宽会按卡片的最小内容宽度撑开，
             移动端整个布局视口会被顶宽（列宽退化成 max-content） */
          <div
            className={`grid grid-cols-1 gap-4 lg:grid-cols-2 ${refreshing ? 'opacity-60' : ''} transition-opacity`}
          >
            {shown.map((entry) => {
              const key = String(entry.id)
              return (
                <ServerCard
                  key={key}
                  entry={entry}
                  expanded={expanded.has(key)}
                  onToggle={() => toggle(key)}
                  // 本机也能写备注和标签（存 settings），探针节点存在节点表里
                  onEdit={() => setEditing(entry)}
                  onApprove={entry.kind === 'agent' ? () => void approve(entry) : undefined}
                />
              )
            })}
          </div>
        )}

        {/* 筛选后空了要说清楚，否则看着像加载失败 */}
        {activeTag && shown.length === 0 && (
          <p className="glass rounded-2xl px-4 py-6 text-center text-xs text-fg/60">
            没有打「{activeTag}」标签的服务器。
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="ml-1 text-accent underline-offset-2 hover:underline"
            >
              显示全部
            </button>
          </p>
        )}

        {/* 压在壁纸上的说明文字：浅色壁纸 + 白字会糊成一片（实测过），
            所以给它一块玻璃，跟着主题取前景色而不是跟着壁纸 */}
        <p className="glass rounded-2xl px-4 py-3 text-[11px] leading-relaxed text-fg/55">
          指标口径与探针一致：CPU/网络速率是两次采样的差分，所以服务刚启动的第一轮可能显示「—」；
          Windows 没有负载均值，非 Linux 平台没有网卡速率。
        </p>
      </div>

      <EditServerDialog
        entry={editing}
        allTags={allTags}
        onClose={() => setEditing(null)}
        onSaved={() => void load('manual')}
        onResetKey={
          editing && typeof editing.id === 'number' ? () => void resetKey(editing) : undefined
        }
      />
    </PageShell>
  )
}
