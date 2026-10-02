import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Radar,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
  XCircle,
} from 'lucide-react'
import { PageShell } from '../components/PageShell.tsx'
import { Modal, btnGhost, btnPrimary, fieldClass, labelClass } from '../components/Modal.tsx'
import { api, errorMessage } from '../lib/api.ts'
import { currentServerHost } from '../lib/net.ts'
import type { AgentNode, ServiceInfo, Site } from '../lib/types.ts'
import { useApp } from '../store/app.ts'
import { beginLoading, endLoading } from '../store/loading.ts'
import { toast } from '../store/toast.ts'

type DiscoveredNode = AgentNode & { error?: string; message?: string }

/** 探针返回的端口里有一堆系统端口（135/445/49664…），默认不勾选它们 */
function looksLikeSystemPort(port: number): boolean {
  if (port < 1024) return true
  if (port >= 49664 && port <= 49673) return true
  return [1236, 2179, 2869, 5040, 5357, 7680, 22000, 27036].includes(port)
}

function HealthDot({ healthy }: { healthy: boolean | null }) {
  if (healthy === null) {
    return <span className="text-xs text-fg/35">—</span>
  }
  return healthy ? (
    <CheckCircle2 className="size-4 text-emerald-400" aria-label="可用" />
  ) : (
    <XCircle className="size-4 text-rose-400" aria-label="无响应" />
  )
}

function relativeTime(ts: number | null): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function NodesPage() {
  const agentPorts = useApp((s) => s.settings.agent_ports)

  const [nodes, setNodes] = useState<AgentNode[]>([])
  const [loading, setLoading] = useState(true)
  const [discovering, setDiscovering] = useState(false)
  const [activeNode, setActiveNode] = useState<AgentNode | null>(null)
  const [services, setServices] = useState<ServiceInfo[] | null>(null)
  const [loadingServices, setLoadingServices] = useState(false)
  const [servicesError, setServicesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)

  const [token, setToken] = useState('')
  const [tokenShown, setTokenShown] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [manual, setManual] = useState({ name: '', base_url: '', token: '' })

  const loadNodes = useCallback(async () => {
    try {
      const res = await api<{ nodes: AgentNode[] }>('/api/nodes')
      setNodes(res.nodes)
    } catch (err) {
      toast.error(errorMessage(err, '加载探针节点失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadNodes()
    api<{ token: string }>('/api/agent-token')
      .then((r) => setToken(r.token))
      .catch(() => undefined)
  }, [loadNodes])

  async function discover() {
    setDiscovering(true)
    try {
      const ports = agentPorts
        .split(',')
        .map((p) => Number(p.trim()))
        .filter((p) => Number.isFinite(p) && p > 0)

      const res = await api<{ found: DiscoveredNode[] }>('/api/nodes/discover', {
        method: 'POST',
        body: JSON.stringify({ host: currentServerHost(), ports }),
      })

      if (res.found.length === 0) {
        toast.info(
          `没有在 ${currentServerHost()} 的 ${ports.join('/')} 端口上发现探针。确认探针已启动，且端口与「设置」里的候选端口一致。`,
        )
      } else {
        const withError = res.found.filter((n) => n.error)
        toast.success(`发现了 ${res.found.length} 个探针节点`)
        if (withError.length > 0) {
          toast.error(
            `${withError.length} 个节点连上了但拿不到服务列表（${withError[0]?.message ?? '令牌可能不匹配'}）`,
          )
        }
      }
      await loadNodes()
    } catch (err) {
      toast.error(errorMessage(err, '自动发现失败'))
    } finally {
      setDiscovering(false)
    }
  }

  async function openServices(node: AgentNode) {
    setActiveNode(node)
    setServices(null)
    setServicesError(null)
    setSelected(new Set())
    setLoadingServices(true)
    // 扫描端口最慢能到 5 秒，而且这期间面板是空的 —— 盖个遮罩说明在干嘛
    beginLoading('正在让探针扫描端口…')
    try {
      const res = await api<{ services: ServiceInfo[]; sources: string[] }>(
        `/api/nodes/${node.id}/services`,
      )
      setServices(res.services)
      // 预勾选「像 Web 服务且当前可用」的条目，系统端口和不可用的默认不选
      setSelected(
        new Set(
          res.services
            .filter((s) => s.healthy === true && !looksLikeSystemPort(s.port))
            .map((s) => s.port),
        ),
      )
    } catch (err) {
      setServicesError(errorMessage(err, '获取服务列表失败'))
    } finally {
      setLoadingServices(false)
      endLoading()
    }
  }

  async function addSelected() {
    if (!activeNode || !services) return
    const picked = services.filter((s) => selected.has(s.port))
    if (picked.length === 0) {
      toast.info('先勾选要添加的服务')
      return
    }

    setAdding(true)
    let ok = 0
    let failed = 0

    // 故意逐个建：探针一次能扫出几十个端口，一把梭全建会把首页塞满系统服务
    for (const svc of picked) {
      try {
        await api<{ site: Site }>('/api/sites', {
          method: 'POST',
          body: JSON.stringify({
            title: svc.name,
            url_lan: svc.url_lan,
            lan_port: svc.port,
            link_mode: 'auto',
            category_id: null,
            icon_text: Array.from(svc.name)[0] ?? null,
          }),
        })
        ok += 1
      } catch {
        failed += 1
      }
    }

    setAdding(false)
    if (ok > 0) {
      await useApp.getState().bootstrap()
      toast.success(`已添加 ${ok} 个图标${failed ? `，${failed} 个失败` : ''}`)
    } else {
      toast.error('添加失败，请检查地址是否合法')
    }
  }

  async function syncMatched() {
    if (!activeNode) return
    try {
      const res = await api<{ matched: number; created: number }>(
        `/api/nodes/${activeNode.id}/sync`,
        { method: 'POST', body: JSON.stringify({ create: false }) },
      )
      if (res.matched > 0) {
        await useApp.getState().bootstrap()
        toast.success(`已为 ${res.matched} 个现有图标补全内网地址`)
      } else {
        toast.info('没有匹配到现有的图标')
      }
    } catch (err) {
      toast.error(errorMessage(err, '同步失败'))
    }
  }

  async function removeNode(node: AgentNode) {
    if (!window.confirm(`删除探针节点「${node.name}」？\n\n只会移除这条记录，不会影响那台机器上的探针。`))
      return
    try {
      await api(`/api/nodes/${node.id}`, { method: 'DELETE' })
      if (activeNode?.id === node.id) {
        setActiveNode(null)
        setServices(null)
      }
      await loadNodes()
      toast.success('已删除')
    } catch (err) {
      toast.error(errorMessage(err, '删除失败'))
    }
  }

  async function toggleEnabled(node: AgentNode) {
    try {
      await api(`/api/nodes/${node.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: node.enabled ? 0 : 1 }),
      })
      await loadNodes()
    } catch (err) {
      toast.error(errorMessage(err, '操作失败'))
    }
  }

  async function addManual() {
    const name = manual.name.trim()
    const baseUrl = manual.base_url.trim()
    if (!name || !baseUrl) {
      toast.error('名称和地址都要填')
      return
    }
    try {
      await api('/api/nodes', {
        method: 'POST',
        body: JSON.stringify({
          name,
          base_url: baseUrl,
          token: manual.token.trim() || undefined,
        }),
      })
      setAddOpen(false)
      setManual({ name: '', base_url: '', token: '' })
      await loadNodes()
      toast.success('已添加')
    } catch (err) {
      toast.error(errorMessage(err, '添加失败'))
    }
  }

  async function rotateToken() {
    if (!window.confirm('轮换令牌后，所有还配置着旧令牌的探针都会失联，需要重新配置。确定继续？'))
      return
    try {
      const res = await api<{ token: string }>('/api/agent-token/rotate', { method: 'POST' })
      setToken(res.token)
      setTokenShown(true)
      toast.success('令牌已轮换')
    } catch (err) {
      toast.error(errorMessage(err, '轮换失败'))
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token)
      toast.success('令牌已复制')
    } catch {
      // http 环境下 clipboard API 可能不可用，让用户手动复制
      setTokenShown(true)
      toast.info('浏览器不允许自动复制，请手动选中复制')
    }
  }

  return (
    <PageShell
      title="服务对接"
      description="内网探针会自动发现服务器上的服务，并补全图标的公网/内网双链路"
      wide
      actions={
        <button type="button" onClick={() => setAddOpen(true)} className={btnGhost}>
          <Plus className="mr-1 inline size-3.5" aria-hidden />
          手动添加
        </button>
      }
    >
      <div className="space-y-5">
        {/* ── 探针令牌与部署命令 ── */}
        <section className="glass rounded-2xl p-5">
          <h2 className="mb-1 text-sm font-semibold text-fg">探针令牌</h2>
          <p className="mb-3 text-xs leading-relaxed text-fg/55">
            在要自动发现服务的机器上运行探针时，用它作为身份凭据。探针默认只监听内网，不要把它暴露到公网。
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-xl border border-line/15 bg-line/10 px-3 py-2.5 font-mono text-xs text-success">
              {token ? (tokenShown ? token : '•'.repeat(32)) : '（加载中…）'}
            </code>
            <button type="button" onClick={() => setTokenShown((v) => !v)} className={btnGhost}>
              {tokenShown ? (
                <EyeOff className="size-3.5" aria-hidden />
              ) : (
                <Eye className="size-3.5" aria-hidden />
              )}
            </button>
            <button type="button" onClick={() => void copyToken()} className={btnGhost}>
              <Copy className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => void rotateToken()}
              className="rounded-xl border border-warn/30 bg-warn/12 px-4 py-2.5 text-sm font-medium text-warn transition hover:bg-warn/20"
            >
              轮换
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-line/10 bg-line/10 p-3">
            <p className="mb-2 text-[11px] font-medium text-fg/50">在目标机器上启动探针：</p>
            <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-info">
{`node agent/node/index.mjs --token=${tokenShown ? token : '<上面的令牌>'}`}
            </pre>
            <p className="mt-2 text-[11px] leading-relaxed text-fg/45">
              需要 Node ≥ 22.5。加 <code className="text-fg/70">--help</code> 看全部参数，
              加 <code className="text-fg/70">--print-config</code> 生成服务清单模板。
              详细说明见 <code className="text-fg/70">agent/README.md</code>。
            </p>
          </div>
        </section>

        {/* ── 自动发现 ── */}
        <section className="glass rounded-2xl p-5">
          <h2 className="mb-1 text-sm font-semibold text-fg">自动发现</h2>
          <p className="mb-3 text-xs leading-relaxed text-fg/55">
            会在本机 <span className="font-mono text-fg/80">{currentServerHost()}</span> 的{' '}
            <span className="font-mono text-fg/80">{agentPorts}</span> 端口上寻找探针
            （候选端口可在
            <Link to="/settings/behavior" className="mx-1 text-accent underline underline-offset-2">
              设置
            </Link>
            里修改）。这也是「内网自动获取服务器和对应端口」的原理。
          </p>
          <button
            type="button"
            onClick={() => void discover()}
            disabled={discovering}
            className={btnPrimary}
          >
            {discovering ? (
              <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />
            ) : (
              <Radar className="mr-1.5 inline size-3.5" aria-hidden />
            )}
            开始扫描
          </button>
        </section>

        {/* ── 节点列表 ── */}
        <section className="glass rounded-2xl p-5">
          <h2 className="mb-3 text-sm font-semibold text-fg">
            探针节点
            <span className="ml-2 text-xs font-normal text-fg/45">{nodes.length}</span>
          </h2>

          {loading ? (
            <p className="py-6 text-center text-xs text-fg/50">加载中…</p>
          ) : nodes.length === 0 ? (
            <p className="py-6 text-center text-xs text-fg/50">
              还没有探针节点。先在上面点「开始扫描」。
            </p>
          ) : (
            <ul className="space-y-2">
              {nodes.map((node) => (
                <li
                  key={node.id}
                  className={[
                    'flex flex-wrap items-center gap-3 rounded-xl border p-3 transition',
                    activeNode?.id === node.id
                      ? 'border-brand-400/50 bg-brand-500/10'
                      : 'border-line/10 bg-line/5 hover:bg-line/10',
                  ].join(' ')}
                >
                  <Server
                    className={`size-4 shrink-0 ${node.enabled ? 'text-success' : 'text-fg/35'}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">
                      {node.name}
                      {!node.enabled && (
                        <span className="ml-2 rounded-md bg-line/15 px-1.5 py-0.5 text-[10px] text-fg/60">
                          已停用
                        </span>
                      )}
                    </p>
                    <p className="truncate font-mono text-[11px] text-fg/45">{node.base_url}</p>
                  </div>

                  <span className="shrink-0 text-[11px] text-fg/45">
                    最后在线 {relativeTime(node.last_seen_at)}
                  </span>

                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => void openServices(node)}
                      className="rounded-lg px-2.5 py-1.5 text-xs text-fg/80 transition hover:bg-line/15 hover:text-fg"
                    >
                      <RefreshCw className="mr-1 inline size-3" aria-hidden />
                      服务
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleEnabled(node)}
                      className="rounded-lg px-2.5 py-1.5 text-xs text-fg/60 transition hover:bg-line/15 hover:text-fg"
                    >
                      {node.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeNode(node)}
                      className="rounded-lg p-1.5 text-fg/50 transition hover:bg-rose-500/20 hover:text-rose-500"
                      aria-label={`删除节点 ${node.name}`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 服务列表 ── */}
        {activeNode && (
          <section className="glass animate-rise rounded-2xl p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-fg">
                {activeNode.name} 上的服务
                {services && (
                  <span className="ml-2 text-xs font-normal text-fg/45">
                    {services.length} 个，已选 {selected.size}
                  </span>
                )}
              </h2>
              <div className="flex gap-2">
                <button type="button" onClick={() => void syncMatched()} className={btnGhost}>
                  同步到现有图标
                </button>
                <button
                  type="button"
                  onClick={() => void addSelected()}
                  disabled={adding || selected.size === 0}
                  className={btnPrimary}
                >
                  {adding && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
                  添加选中项
                </button>
              </div>
            </div>

            {loadingServices && (
              <p className="py-8 text-center text-xs text-fg/50">正在让探针扫描端口…</p>
            )}

            {servicesError && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-warn">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div>
                  <p>{servicesError}</p>
                  <p className="mt-1 text-warn/70">
                    常见原因：探针没在运行、令牌不匹配、或者那台机器不在当前网络里。
                  </p>
                </div>
              </div>
            )}

            {services && services.length > 0 && (
              <>
                <div className="max-h-96 overflow-y-auto rounded-xl border border-line/10">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-surface/95 backdrop-blur">
                      <tr className="text-fg/55">
                        <th className="w-10 px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label="全选"
                            checked={selected.size === services.length}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked ? new Set(services.map((s) => s.port)) : new Set(),
                              )
                            }
                          />
                        </th>
                        <th className="px-2 py-2 font-medium">服务</th>
                        <th className="px-2 py-2 font-medium">端口</th>
                        <th className="px-2 py-2 font-medium">状态</th>
                        <th className="hidden px-2 py-2 font-medium sm:table-cell">延迟</th>
                        <th className="hidden px-2 py-2 font-medium md:table-cell">来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {services.map((svc) => (
                        <tr
                          key={`${svc.port}-${svc.name}`}
                          className="border-t border-line/5 text-fg/80 hover:bg-line/5"
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              aria-label={`选择 ${svc.name}`}
                              checked={selected.has(svc.port)}
                              onChange={(e) => {
                                const next = new Set(selected)
                                if (e.target.checked) next.add(svc.port)
                                else next.delete(svc.port)
                                setSelected(next)
                              }}
                            />
                          </td>
                          <td className="max-w-[12rem] truncate px-2 py-2">{svc.name}</td>
                          <td className="px-2 py-2 font-mono">{svc.port}</td>
                          <td className="px-2 py-2">
                            <HealthDot healthy={svc.healthy} />
                          </td>
                          <td className="hidden px-2 py-2 font-mono text-fg/50 sm:table-cell">
                            {svc.latency_ms === null || svc.latency_ms === undefined
                              ? '—'
                              : `${svc.latency_ms}ms`}
                          </td>
                          <td className="hidden px-2 py-2 text-fg/45 md:table-cell">
                            {svc.source === 'config' ? '清单' : '扫描'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-fg/45">
                  默认只勾选了「有响应且不是系统端口」的条目。非 HTTP 端口（如 445、135）虽然会列出来，
                  但拼出来的内网地址没有实际意义，建议不要添加。
                </p>
              </>
            )}

            {services && services.length === 0 && (
              <p className="py-8 text-center text-xs text-fg/50">探针没有报告任何监听端口。</p>
            )}
          </section>
        )}
      </div>

      <Modal
        open={addOpen}
        title="手动添加探针节点"
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setAddOpen(false)} className={btnGhost}>
              取消
            </button>
            <button type="button" onClick={() => void addManual()} className={btnPrimary}>
              添加
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className={labelClass} htmlFor="nd-name">
              名称
            </label>
            <input
              id="nd-name"
              className={fieldClass}
              value={manual.name}
              onChange={(e) => setManual((m) => ({ ...m, name: e.target.value }))}
              placeholder="例如：家里的 NAS"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="nd-url">
              探针地址
            </label>
            <input
              id="nd-url"
              className={fieldClass}
              value={manual.base_url}
              onChange={(e) => setManual((m) => ({ ...m, base_url: e.target.value }))}
              placeholder="http://192.168.1.10:9201"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="nd-token">
              令牌（留空则用全局令牌）
            </label>
            <input
              id="nd-token"
              className={fieldClass}
              value={manual.token}
              onChange={(e) => setManual((m) => ({ ...m, token: e.target.value }))}
              placeholder="可选"
            />
          </div>
        </div>
      </Modal>
    </PageShell>
  )
}
