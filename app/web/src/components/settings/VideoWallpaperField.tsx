import { useEffect, useRef, useState } from 'react'
import { Check, Link2, Loader2, Trash2, Upload, Video, X } from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import { toast } from '../../store/toast.ts'
import { btnGhost, btnPrimary } from '../Modal.tsx'
import { FieldBlock, inputClass } from './controls.tsx'
import { useSettingsSave } from './saver.tsx'

const MAX_VIDEO_BYTES = 100 * 1024 * 1024

/** 上传与保存使用发起操作时的回调，避免迟到的响应写入另一套主题。 */
export function VideoWallpaperField({
  value,
  onSave,
  onUploadingChange,
}: {
  value: string
  onSave: (value: string) => Promise<boolean>
  onUploadingChange: (uploading: boolean) => void
}) {
  const { readOnly } = useSettingsSave()
  const [url, setUrl] = useState(() => /^https?:\/\//i.test(value) ? value : '')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    setUrl(/^https?:\/\//i.test(value) ? value : '')
    setError('')
  }, [value])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      uploadRef.current?.abort()
      onUploadingChange(false)
    }
  }, [onUploadingChange])

  async function upload(file: File) {
    if (readOnly || busyRef.current) return
    if (!/\.(mp4|webm)$/i.test(file.name)) {
      setError('请选择 MP4 或 WebM 视频文件。')
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    if (file.size === 0 || file.size > MAX_VIDEO_BYTES) {
      setError(file.size === 0 ? '视频文件为空，请重新选择。' : '视频不能超过 100MB，请压缩后再上传。')
      if (fileRef.current) fileRef.current.value = ''
      return
    }

    const controller = new AbortController()
    uploadRef.current = controller
    busyRef.current = true
    setUploading(true)
    onUploadingChange(true)
    setError('')
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await api<{ url: string }>('/api/upload/video', { method: 'POST', body }, {
        signal: controller.signal,
      })
      controller.signal.throwIfAborted()
      if (await onSave(res.url)) {
        toast.success('动态壁纸已应用')
      } else if (mounted.current) {
        setError('视频已上传，但壁纸设置保存失败，请重试。')
      }
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) {
        setError(errorMessage(err, '视频上传失败，请重试。'))
      }
    } finally {
      uploadRef.current = null
      busyRef.current = false
      if (mounted.current) {
        setUploading(false)
        onUploadingChange(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    }
  }

  async function applyUrl() {
    if (readOnly || busyRef.current) return
    const next = url.trim()
    try {
      const parsed = new URL(next)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
    } catch {
      setError('请输入完整的 HTTP 或 HTTPS 视频直链。')
      return
    }

    busyRef.current = true
    setSaving(true)
    setError('')
    try {
      if (await onSave(next)) {
        setUrl(next)
        toast.success('视频链接已应用')
      } else if (mounted.current) {
        setError('视频链接保存失败，请重试。')
      }
    } finally {
      busyRef.current = false
      if (mounted.current) setSaving(false)
    }
  }

  async function clearVideo() {
    if (readOnly || busyRef.current) return
    busyRef.current = true
    setSaving(true)
    setError('')
    try {
      if (await onSave('')) setUrl('')
      else if (mounted.current) setError('移除视频失败，请重试。')
    } finally {
      busyRef.current = false
      if (mounted.current) setSaving(false)
    }
  }

  const busy = uploading || saving

  return (
    <div className="space-y-4 rounded-2xl border border-line/10 bg-line/[0.04] p-4">
      <FieldBlock label="本地视频" hint="支持 MP4 / WebM，最大 100MB。推荐短时循环视频，上传后可在其它设备使用。">
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/webm,.mp4,.webm"
          className="hidden"
          disabled={busy || readOnly}
          aria-label="选择动态壁纸视频"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void upload(file)
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnGhost} disabled={busy || readOnly} onClick={() => fileRef.current?.click()}>
            {uploading
              ? <Loader2 className="mr-1.5 inline size-4 animate-spin" aria-hidden />
              : <Upload className="mr-1.5 inline size-4" aria-hidden />}
            {uploading ? '视频上传中…' : '选择视频'}
          </button>
          {uploading && (
            <button type="button" className={btnGhost} onClick={() => uploadRef.current?.abort()}>
              <X className="mr-1.5 inline size-4" aria-hidden />取消上传
            </button>
          )}
          {value && !uploading && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg/60">
              <Check className="size-3.5 shrink-0 text-success" aria-hidden />
              {value.startsWith('/uploads/') ? '已使用上传视频' : '已使用视频链接'}
            </span>
          )}
        </div>
      </FieldBlock>

      <FieldBlock label="或使用视频链接" htmlFor="set-wallpaper-video-url" hint="请填写可直接播放的 MP4 / WebM 地址，视频平台的页面链接无法作为壁纸。推荐使用 HTTPS。">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="set-wallpaper-video-url"
            className={`${inputClass} min-w-0 flex-1 font-mono`}
            value={url}
            onChange={(event) => { setUrl(event.target.value); setError('') }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void applyUrl() }
            }}
            inputMode="url"
            placeholder="https://example.com/wallpaper.mp4"
            spellCheck={false}
            autoComplete="off"
            disabled={busy || readOnly}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'wallpaper-video-error' : undefined}
          />
          <button type="button" className={`${btnPrimary} shrink-0`} disabled={busy || readOnly || !url.trim()} onClick={() => void applyUrl()}>
            {saving ? <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden /> : <Link2 className="mr-1.5 inline size-3.5" aria-hidden />}
            应用链接
          </button>
        </div>
      </FieldBlock>

      {error && <p id="wallpaper-video-error" role="alert" className="text-xs leading-relaxed text-danger">{error}</p>}
      {uploading && <p role="status" className="text-xs text-fg/60">正在上传并保存视频，请保持此页面打开。</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/10 pt-3">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-[11px] leading-relaxed text-fg/50">
          <Video className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          静音循环播放；动态画面会适当压暗以保证文字清晰，系统减少动态效果时默认暂停。
        </p>
        {value && (
          <button type="button" className={btnGhost} disabled={busy || readOnly} onClick={() => void clearVideo()}>
            <Trash2 className="mr-1.5 inline size-3.5" aria-hidden />移除视频
          </button>
        )}
      </div>
    </div>
  )
}
