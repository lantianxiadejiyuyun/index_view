import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ExternalLink,
  FolderOpen,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { CredentialRow } from '../components/CredentialRow.tsx'
import { Modal, btnGhost, btnPrimary, fieldClass, labelClass } from '../components/Modal.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { api, errorMessage } from '../lib/api.ts'
import type { WorkbenchItem } from '../lib/types.ts'
import { toast } from '../store/toast.ts'

/**
 * 工作台：一堆要登的后台 / 系统。
 *
 * 和首页图标墙的区别在于**信息密度和用途**：
 *   · 图标墙是「点开就走」，一条只有一个名字和一个地址
 *   · 工作台是「打开 → 看用途 → 复制账号 → 复制密码」，
 *     所以每条平铺凭据，左边还有一栏分组导航
 *
 * ⚠️ 密码明文存在服务端（和 agent_token、宝塔凭据一样）。界面默认打码。
 */

const ALL = '__all__'

/** 分组名一律按本地化顺序排，「生产」「财务」这种中文才不会按字节序乱排 */
function sortGroups(groups: string[]): string[] {
  return [...groups].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

export function WorkbenchPage() {
  const [items, setItems] = useState<WorkbenchItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activeGroup, setActiveGroup] = useState<string>(ALL)
  const [query, setQuery] = useState('')
  // undefined = 弹窗关着；null = 新建；对象 = 编辑
  const [editing, setEditing] = useState<WorkbenchItem | null | undefined>(undefined)
  const [creatingIn, setCreatingIn] = useState<string>('')

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: WorkbenchItem[] }>('/api/workbench')
      setItems(res.items ?? [])
    } catch (err) {
      toast.error(errorMessage(err, '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(
    () => sortGroups([...new Set(items.map((i) => i.group_name).filter(Boolean))]),
    [items],
  )

  // 搜索命中 名称 / 用途 / 网址 / 账号 / 备注 —— 但**不搜密码**：
  // 拿密码去搜等于把明文散到更多地方，也没人会这么找
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((i) => {
      if (activeGroup !== ALL && i.group_name !== activeGroup) return false
      if (!q) return true
      return [i.title, i.purpose, i.url, i.username, i.note, i.group_name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
  }, [items, activeGroup, query])

  /** 按分组切块。没填分组的归到一个「未分组」里，排最后 */
  const sections = useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>()
    for (const item of filtered) {
      const key = item.group_name || ''
      const list = map.get(key)
      if (list) list.push(item)
      else map.set(key, [item])
    }
    const named = sortGroups([...map.keys()].filter(Boolean))
    const out = named.map((g) => ({ group: g, items: map.get(g)! }))
    const loose = map.get('')
    if (loose) out.push({ group: '', items: loose })
    return out
  }, [filtered])

  async function remove(item: WorkbenchItem) {
    if (!window.confirm(`删除「${item.title}」？这条的账号密码也会一起没。`)) return
    try {
      await api(`/api/workbench/${item.id}`, { method: 'DELETE' })
      setItems((list) => list.filter((i) => i.id !== item.id))
      toast.success('已删除')
    } catch (err) {
      toast.error(errorMessage(err, '删除失败'))
    }
  }

  const countOf = (group: string) =>
    group === ALL ? items.length : items.filter((i) => i.group_name === group).length

  return (
    <PageShell
      title="工作台"
      description={`后台与系统账号，共 ${items.length} 条`}
      wide
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              setCreatingIn(activeGroup === ALL ? '' : activeGroup)
              setEditing(null)
            }}
          >
            <Plus className="mr-1.5 inline size-3.5" aria-hidden />
            新增
          </button>
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start">
        {/* ── 分组导航 ── */}
        <aside className="lg:sticky lg:top-5">
          <div className="glass rounded-2xl p-3">
            <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-medium text-fg/45">
              <Layers className="size-3" aria-hidden />
              分组
            </div>

            {/* 移动端横向滚动，桌面端竖排 */}
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
              {[{ key: ALL, label: '全部' }, ...groups.map((g) => ({ key: g, label: g }))].map(
                (g) => {
                  const active = activeGroup === g.key
                  return (
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => setActiveGroup(g.key)}
                      className={[
                        'flex shrink-0 items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs transition lg:w-full',
                        active
                          ? 'bg-brand-500/85 font-medium text-white'
                          : 'text-fg/75 hover:bg-line/15 hover:text-fg',
                      ].join(' ')}
                    >
                      <span className="max-w-[9rem] truncate">{g.label}</span>
                      <span className={active ? 'text-white/75' : 'text-fg/40'}>
                        {countOf(g.key)}
                      </span>
                    </button>
                  )
                },
              )}
            </div>

            {groups.length === 0 && (
              <p className="px-1 pt-1 text-[11px] leading-relaxed text-fg/40">
                还没有分组。新增条目时填一个分组名，这里就会自动出现。
              </p>
            )}
          </div>
        </aside>

        {/* ── 内容 ── */}
        <div className="min-w-0 space-y-4">
          {/* 条目一多就得能搜。放这里而不是页头，是因为它只作用于这一页的内容 */}
          {items.length > 4 && (
            <div className="glass flex items-center gap-2 rounded-2xl px-3.5 py-2.5">
              <Search className="size-3.5 shrink-0 text-fg/40" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜名称、用途、网址、账号…"
                className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg/35"
                aria-label="搜索工作台"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="shrink-0 text-[11px] text-fg/45 transition hover:text-fg"
                >
                  清除
                </button>
              )}
            </div>
          )}

          {loading ? (
            <div className="glass flex items-center justify-center gap-2 rounded-2xl px-5 py-12 text-xs text-fg/60">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              正在加载…
            </div>
          ) : sections.length === 0 ? (
            <div className="glass flex flex-col items-center gap-3 rounded-2xl px-6 py-14 text-center">
              <FolderOpen className="size-7 text-fg/45" aria-hidden />
              <p className="text-sm text-fg/80">
                {items.length === 0 ? '还没有条目' : '没有匹配的条目'}
              </p>
              {items.length === 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setCreatingIn('')
                    setEditing(null)
                  }}
                  className={btnPrimary}
                >
                  <Plus className="mr-1.5 inline size-3.5" aria-hidden />
                  添加第一条
                </button>
              )}
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.group || '__none__'} className="space-y-3">
                <div className="flex items-center gap-2 px-1">
                  <h2 className="text-sm font-semibold text-fg">
                    {section.group || '未分组'}
                  </h2>
                  <span className="text-[11px] text-fg/40">{section.items.length}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setCreatingIn(section.group)
                      setEditing(null)
                    }}
                    className="ml-auto rounded-lg px-2 py-1 text-[11px] text-fg/55 transition hover:bg-line/15 hover:text-fg"
                  >
                    <Plus className="mr-1 inline size-3" aria-hidden />
                    加一条
                  </button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {section.items.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      onEdit={() => setEditing(item)}
                      onDelete={() => void remove(item)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <WorkbenchEditor
        entry={editing}
        defaultGroup={creatingIn}
        groups={groups}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined)
          void load()
        }}
      />
    </PageShell>
  )
}

function ItemCard({
  item,
  onEdit,
  onDelete,
}: {
  item: WorkbenchItem
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <article className="glass group flex flex-col rounded-2xl p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-fg" title={item.title}>
            {item.title}
          </h3>
          {item.purpose && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-fg/55">{item.purpose}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`打开\n${item.url}`}
              aria-label={`打开 ${item.title}`}
              className="rounded-lg p-1.5 text-fg/45 transition hover:bg-line/15 hover:text-fg"
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          <button
            type="button"
            onClick={onEdit}
            title="编辑"
            aria-label={`编辑 ${item.title}`}
            className="rounded-lg p-1.5 text-fg/45 transition hover:bg-line/15 hover:text-fg"
          >
            <Pencil className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="删除"
            aria-label={`删除 ${item.title}`}
            className="rounded-lg p-1.5 text-fg/45 transition hover:bg-danger/15 hover:text-danger"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {item.url && (
        <p className="mt-1.5 truncate font-mono text-[10px] text-fg/40" title={item.url}>
          {item.url}
        </p>
      )}

      {(item.username || item.password) && (
        <div className="mt-2.5 border-t border-line/10 pt-2">
          {item.username && <CredentialRow label="账号" value={item.username} />}
          {item.password && <CredentialRow label="密码" value={item.password} secret />}
        </div>
      )}

      {item.note && (
        <p className="mt-2 border-t border-line/10 pt-2 text-[11px] leading-relaxed text-fg/55">
          {item.note}
        </p>
      )}
    </article>
  )
}

function WorkbenchEditor({
  entry,
  defaultGroup,
  groups,
  onClose,
  onSaved,
}: {
  entry: WorkbenchItem | null | undefined
  defaultGroup: string
  groups: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState('')
  const [group, setGroup] = useState('')
  const [url, setUrl] = useState('')
  const [purpose, setPurpose] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const open = entry !== undefined

  // 每次打开都按当前条目重置，免得上一次输入残留
  useEffect(() => {
    if (!open) return
    setTitle(entry?.title ?? '')
    setGroup(entry?.group_name ?? defaultGroup)
    setUrl(entry?.url ?? '')
    setPurpose(entry?.purpose ?? '')
    setUsername(entry?.username ?? '')
    setPassword(entry?.password ?? '')
    setNote(entry?.note ?? '')
    setSaving(false)
  }, [open, entry, defaultGroup])

  if (!open) return null

  async function save() {
    const trimmed = title.trim()
    if (!trimmed) {
      toast.error('名称不能为空')
      return
    }

    setSaving(true)
    try {
      const body = {
        title: trimmed,
        group_name: group.trim(),
        url: url.trim(),
        purpose: purpose.trim(),
        username: username.trim(),
        // 密码不 trim：前后空格可能是密码的一部分
        password,
        note: note.trim(),
      }
      if (entry) await api(`/api/workbench/${entry.id}`, { method: 'PUT', body: JSON.stringify(body) })
      else await api('/api/workbench', { method: 'POST', body: JSON.stringify(body) })
      toast.success(entry ? '已保存' : '已添加')
      onSaved()
    } catch (err) {
      toast.error(errorMessage(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={entry ? `编辑「${entry.title}」` : '新增一条'}
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
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="wb-title">
              名称
            </label>
            <input
              id="wb-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              className={fieldClass}
              placeholder="例如 阿里云控制台"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="wb-group">
              分组
            </label>
            <input
              id="wb-group"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              maxLength={40}
              list="wb-group-list"
              className={fieldClass}
              placeholder="例如 云服务"
            />
            <datalist id="wb-group-list">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor="wb-url">
            网址
          </label>
          <input
            id="wb-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={`${fieldClass} font-mono text-xs`}
            placeholder="https://console.aliyun.com"
            inputMode="url"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="wb-purpose">
            用途
          </label>
          <input
            id="wb-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            maxLength={200}
            className={fieldClass}
            placeholder="例如 买域名、看账单"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="wb-user">
              账号
            </label>
            <input
              id="wb-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={`${fieldClass} font-mono text-xs`}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="wb-pass">
              密码
            </label>
            <input
              id="wb-pass"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${fieldClass} font-mono text-xs`}
              autoComplete="new-password"
            />
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor="wb-note">
            备注
          </label>
          <textarea
            id="wb-note"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={3}
            className={`${fieldClass} resize-y leading-relaxed`}
            placeholder="例如 绑的是公司邮箱，双因素在老板手机上"
          />
        </div>

        <p className="text-[11px] leading-relaxed text-fg/45">
          密码是<b className="font-medium text-fg/70">明文存在你自己的数据库</b>里的，
          别把导出的数据随便发人。卡片上默认打码，点眼睛才显示。
        </p>
      </div>
    </Modal>
  )
}
