import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react'
import { api, errorMessage, faviconUrl } from '../lib/api.ts'
import type { Category, Site } from '../lib/types.ts'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { Modal, btnGhost, btnPrimary, fieldClass, labelClass } from './Modal.tsx'

type Props = {
  open: boolean
  /** null 表示新建 */
  site: Site | null
  defaultCategoryId: number | null
  onClose: () => void
}

type FormState = {
  title: string
  url_public: string
  url_lan: string
  lan_port: string
  link_mode: string
  category_id: string
  description: string
  icon_url: string
  icon_text: string
  color: string
}

const EMPTY: FormState = {
  title: '',
  url_public: '',
  url_lan: '',
  lan_port: '',
  link_mode: 'auto',
  category_id: '',
  description: '',
  icon_url: '',
  icon_text: '',
  color: '',
}

const COLOR_SWATCHES = [
  '#4f7cff',
  '#8b5cf6',
  '#ec4899',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#0ea5e9',
  '#64748b',
  '#ef4444',
]

export function SiteEditorModal({ open, site, defaultCategoryId, onClose }: Props) {
  const categories = useApp((s) => s.categories)
  const createSite = useApp((s) => s.createSite)
  const updateSite = useApp((s) => s.updateSite)
  const deleteSite = useApp((s) => s.deleteSite)

  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 每次打开都用最新的 site 重置表单，避免残留上一次的输入
  useEffect(() => {
    if (!open) return
    if (site) {
      setForm({
        title: site.title,
        url_public: site.url_public ?? '',
        url_lan: site.url_lan ?? '',
        lan_port: site.lan_port === null ? '' : String(site.lan_port),
        link_mode: site.link_mode,
        category_id: site.category_id === null ? '' : String(site.category_id),
        description: site.description ?? '',
        icon_url: site.icon_url ?? '',
        icon_text: site.icon_text ?? '',
        color: site.color ?? '',
      })
    } else {
      setForm({
        ...EMPTY,
        category_id: defaultCategoryId === null ? '' : String(defaultCategoryId),
      })
    }
  }, [open, site, defaultCategoryId])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function uploadIcon(file: File) {
    setUploading(true)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await api<{ url: string }>('/api/upload', { method: 'POST', body })
      set('icon_url', res.url)
      toast.success('图标已上传')
    } catch (err) {
      toast.error(errorMessage(err, '上传失败'))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function submit() {
    const title = form.title.trim()
    if (!title) {
      toast.error('请填写名称')
      return
    }
    if (!form.url_public.trim() && !form.url_lan.trim()) {
      toast.error('至少填写一个地址')
      return
    }

    const payload = {
      title,
      url_public: form.url_public.trim() || null,
      url_lan: form.url_lan.trim() || null,
      lan_port: form.lan_port.trim() ? Number(form.lan_port.trim()) : null,
      link_mode: form.link_mode,
      category_id: form.category_id === '' ? null : Number(form.category_id),
      description: form.description.trim() || null,
      icon_url: form.icon_url.trim() || null,
      icon_text: form.icon_text.trim() || null,
      color: form.color.trim() || null,
    }

    setSaving(true)
    try {
      if (site) {
        await updateSite(site.id, payload)
        toast.success('已保存')
      } else {
        await createSite(payload)
        toast.success('已添加')
      }
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!site) return
    if (!window.confirm(`确定删除「${site.title}」吗？`)) return
    setSaving(true)
    try {
      await deleteSite(site.id)
      toast.success('已删除')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, '删除失败'))
    } finally {
      setSaving(false)
    }
  }

  const bothUrls = Boolean(form.url_public.trim() && form.url_lan.trim())
  const previewSrc = form.icon_url.trim() || faviconUrl({ url_public: form.url_public, url_lan: form.url_lan })

  return (
    <Modal
      open={open}
      title={site ? '编辑图标' : '添加图标'}
      onClose={onClose}
      size="wide"
      footer={
        <>
          {site && (
            <button type="button" onClick={() => void remove()} className="mr-auto text-sm text-danger transition hover:text-danger">
              <Trash2 className="mr-1 inline size-3.5" aria-hidden />
              删除
            </button>
          )}
          <button type="button" onClick={onClose} className={btnGhost}>
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={saving} className={btnPrimary}>
            {saving && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            保存
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 实时预览：所见即所得，省得保存完再回头看效果 */}
        <div className="flex items-center gap-4 rounded-2xl border border-line/10 bg-line/5 p-3">
          <div className="glass flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl">
            {previewSrc ? (
              <img src={previewSrc} alt="" className="size-9 object-contain" />
            ) : (
              <span
                className="flex size-9 items-center justify-center rounded-lg text-sm font-semibold text-fg"
                style={{ background: form.color || '#4f7cff' }}
              >
                {form.icon_text.trim() || form.title.trim().charAt(0) || '?'}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{form.title.trim() || '未命名'}</p>
            <p className="truncate text-xs text-fg/50">
              {form.url_public.trim() || form.url_lan.trim() || '还没有地址'}
            </p>
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor="se-title">
            名称 <span className="text-danger">*</span>
          </label>
          <input
            id="se-title"
            className={fieldClass}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="例如：NAS 面板"
            maxLength={80}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="se-public">
              公网地址
            </label>
            <input
              id="se-public"
              className={fieldClass}
              value={form.url_public}
              onChange={(e) => set('url_public', e.target.value)}
              placeholder="https://nas.example.com:9200"
              inputMode="url"
            />
            <p className="mt-1 text-[11px] text-fg/40">在外网访问时使用</p>
          </div>

          <div>
            <label className={labelClass} htmlFor="se-lan">
              内网地址
            </label>
            <input
              id="se-lan"
              className={fieldClass}
              value={form.url_lan}
              onChange={(e) => set('url_lan', e.target.value)}
              placeholder="http://192.168.1.10:9200"
              inputMode="url"
            />
            <p className="mt-1 text-[11px] text-fg/40">在内网访问时优先使用</p>
          </div>
        </div>

        {bothUrls && (
          <div className="animate-pop rounded-xl border border-line/10 bg-line/5 p-3">
            <label className={labelClass}>链路选择</label>
            <div className="flex flex-wrap gap-2">
              {[
                { id: 'auto', name: '自动', desc: '按访问入口判断' },
                { id: 'lan', name: '总是内网', desc: '固定走内网地址' },
                { id: 'public', name: '总是公网', desc: '固定走公网地址' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => set('link_mode', opt.id)}
                  className={[
                    'rounded-lg px-3 py-1.5 text-xs transition',
                    form.link_mode === opt.id
                      ? 'bg-brand-500 text-white'
                      : 'bg-line/10 text-fg/70 hover:bg-line/20',
                  ].join(' ')}
                  title={opt.desc}
                >
                  {opt.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="se-cat">
              所属分组
            </label>
            <select
              id="se-cat"
              className={fieldClass}
              value={form.category_id}
              onChange={(e) => set('category_id', e.target.value)}
            >
              <option value="">未分组</option>
              {categories.map((c: Category) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="se-port">
              内网端口
            </label>
            <input
              id="se-port"
              className={fieldClass}
              value={form.lan_port}
              onChange={(e) => set('lan_port', e.target.value.replace(/\D/g, ''))}
              placeholder="留空则由探针自动填充"
              inputMode="numeric"
            />
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor="se-desc">
            描述
          </label>
          <input
            id="se-desc"
            className={fieldClass}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="鼠标悬停时显示"
            maxLength={200}
          />
        </div>

        <div className="rounded-xl border border-line/10 bg-line/5 p-3">
          <label className={labelClass}>
            <ImagePlus className="mr-1 inline size-3.5" aria-hidden />
            图标
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${fieldClass} min-w-[12rem] flex-1`}
              value={form.icon_url}
              onChange={(e) => set('icon_url', e.target.value)}
              placeholder="留空自动抓取网站图标"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void uploadIcon(file)
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className={btnGhost}
            >
              {uploading ? (
                <Loader2 className="mr-1 inline size-3.5 animate-spin" aria-hidden />
              ) : (
                <Upload className="mr-1 inline size-3.5" aria-hidden />
              )}
              上传
            </button>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="se-text">
                文字图标
              </label>
              <input
                id="se-text"
                className={fieldClass}
                value={form.icon_text}
                onChange={(e) => set('icon_text', e.target.value)}
                placeholder="抓不到图标时显示，留空取首字母"
                maxLength={4}
              />
            </div>
            <div>
              <label className={labelClass}>底色</label>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {COLOR_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set('color', form.color === c ? '' : c)}
                    className={[
                      'size-6 rounded-lg transition',
                      form.color === c ? 'ring-2 ring-line ring-offset-2 ring-offset-transparent' : '',
                    ].join(' ')}
                    style={{ background: c }}
                    aria-label={`底色 ${c}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
