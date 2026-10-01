import { useState } from 'react'
import { Copy, Eye, EyeOff } from 'lucide-react'
import { toast } from '../store/toast.ts'

/**
 * 凭据一行：标签 + 值 + 复制。
 *
 * 密码默认**打码**，点眼睛才显示 —— 这页面经常被截图发到群里，
 * 别让密码裸奔在屏幕上。复制按钮不管显示与否都能用，不用为了复制先把密码亮出来。
 *
 * 服务器面板（宝塔凭据）和工作台（后台账号）都用它。
 */
export function CredentialRow({
  label,
  value,
  secret = false,
}: {
  label: string
  value: string
  secret?: boolean
}) {
  const [shown, setShown] = useState(!secret)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label}已复制`)
    } catch {
      // 非 HTTPS 或没授权时剪贴板不可用，退化成把内容显示出来让用户手抄
      toast.info(value)
    }
  }

  const masked = '•'.repeat(Math.min(16, Math.max(6, value.length)))

  return (
    <div className="flex items-center gap-1 py-0.5 text-[11px]">
      <span className="w-12 shrink-0 text-fg/50">{label}</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-fg/85"
        title={secret && !shown ? '已隐藏' : value}
      >
        {secret && !shown ? masked : value}
      </span>
      {secret && (
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          title={shown ? '隐藏' : '显示'}
          aria-label={shown ? `隐藏${label}` : `显示${label}`}
          className="shrink-0 rounded p-1 text-fg/40 transition hover:text-fg"
        >
          {shown ? <EyeOff className="size-3" aria-hidden /> : <Eye className="size-3" aria-hidden />}
        </button>
      )}
      <button
        type="button"
        onClick={() => void copy()}
        title="复制"
        aria-label={`复制${label}`}
        className="shrink-0 rounded p-1 text-fg/40 transition hover:text-fg"
      >
        <Copy className="size-3" aria-hidden />
      </button>
    </div>
  )
}
