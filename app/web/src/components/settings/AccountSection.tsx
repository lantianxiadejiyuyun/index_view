import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import { api, errorMessage } from '../../lib/api.ts'
import { useApp } from '../../store/app.ts'
import { toast } from '../../store/toast.ts'
import { btnGhost, btnPrimary, fieldClass, labelClass } from '../Modal.tsx'
import { LoginRequired, Note } from './controls.tsx'
import { SettingsSection } from './Section.tsx'
import { LoginSessions } from './LoginSessions.tsx'

/** 复制到剪贴板。内网 HTTP 下没有 clipboard API，得退回到临时 textarea 的老办法 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const box = document.createElement('textarea')
  box.value = text
  box.style.position = 'fixed'
  box.style.opacity = '0'
  document.body.appendChild(box)
  box.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(box)
  if (!ok) throw new Error('当前浏览器不支持自动复制')
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  async function submit() {
    if (!current) {
      toast.error('请输入当前密码')
      return
    }
    if (next.length < 6) {
      toast.error('新密码至少 6 位')
      return
    }
    if (next !== confirm) {
      toast.error('两次输入的新密码不一致')
      return
    }
    if (next === current) {
      toast.error('新密码不能和当前密码相同')
      return
    }

    setBusy(true)
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next }),
      })
      toast.success('密码已更新，请用新密码重新登录')
      // 后端把全部 refresh token 都撤销了、Cookie 也清了，
      // 本地还留着 user 会让界面假装「已登录」，所以必须走一遍登出流程
      await useApp.getState().logout()
      navigate('/login', { replace: true })
    } catch (err) {
      toast.error(errorMessage(err, '修改失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-line/10 bg-line/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg/80">
        <KeyRound className="size-3.5" aria-hidden />
        修改密码
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="pw-current">
            当前密码
          </label>
          <input
            id="pw-current"
            type="password"
            className={fieldClass}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="pw-next">
            新密码
          </label>
          <input
            id="pw-next"
            type="password"
            className={fieldClass}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            placeholder="至少 6 位"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="pw-confirm">
            确认新密码
          </label>
          <input
            id="pw-confirm"
            type="password"
            className={fieldClass}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </div>
      </div>

      <Note tone="warn" icon={ShieldAlert}>
        改完密码后，<strong className="font-semibold">所有设备上的登录都会立刻失效</strong>
        ，包括你现在这台，需要用新密码重新登录一次。
      </Note>

      <div className="flex justify-end">
        <button
          type="button"
          className={`${btnPrimary} flex items-center gap-1.5`}
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Check className="size-3.5" aria-hidden />
          )}
          保存新密码
        </button>
      </div>
    </div>
  )
}

function AgentTokenPanel() {
  const [token, setToken] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [rotating, setRotating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api<{ token: string }>('/api/agent-token')
      .then((res) => {
        if (!alive) return
        setToken(res.token)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(errorMessage(err, '令牌读取失败'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  async function rotate() {
    if (
      !window.confirm(
        '轮换后旧令牌立即作废，所有还用着旧令牌的探针都会连不上主程序，需要逐台更新。\n\n确定要轮换吗？',
      )
    ) {
      return
    }
    setRotating(true)
    try {
      const res = await api<{ token: string }>('/api/agent-token/rotate', { method: 'POST' })
      setToken(res.token)
      setRevealed(true)
      toast.success('令牌已轮换，请更新探针配置')
    } catch (err) {
      toast.error(errorMessage(err, '轮换失败'))
    } finally {
      setRotating(false)
    }
  }

  async function copy() {
    if (!token) {
      toast.error('还没有取到令牌')
      return
    }
    try {
      await copyText(token)
      toast.success('令牌已复制')
    } catch (err) {
      toast.error(errorMessage(err, '复制失败'))
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-line/10 bg-line/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg/80">
        <ShieldCheck className="size-3.5" aria-hidden />
        探针令牌
      </p>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-fg/50">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          正在读取…
        </p>
      ) : error ? (
        <Note tone="danger">{error}</Note>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-xl border border-line/15 bg-line/10 px-3 py-2.5 font-mono text-xs text-fg/85">
              {token
                ? revealed
                  ? token
                  : '•'.repeat(Math.min(token.length, 40))
                : '（尚未生成）'}
            </code>

            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                className={`${btnGhost} flex flex-1 items-center justify-center gap-1.5 sm:flex-none`}
                onClick={() => setRevealed((v) => !v)}
                disabled={!token}
              >
                {revealed ? (
                  <EyeOff className="size-3.5" aria-hidden />
                ) : (
                  <Eye className="size-3.5" aria-hidden />
                )}
                {revealed ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                className={`${btnGhost} flex flex-1 items-center justify-center gap-1.5 sm:flex-none`}
                onClick={() => void copy()}
                disabled={!token}
              >
                <Copy className="size-3.5" aria-hidden />
                复制
              </button>
              <button
                type="button"
                className={`${btnGhost} flex flex-1 items-center justify-center gap-1.5 sm:flex-none`}
                onClick={() => void rotate()}
                disabled={rotating}
              >
                {rotating ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="size-3.5" aria-hidden />
                )}
                轮换
              </button>
            </div>
          </div>

          <Note tone="warn" icon={ShieldAlert}>
            轮换令牌会立刻断开所有旧探针。令牌只在服务端保存，页面刷新后需要重新「显示」。
          </Note>

          <details className="rounded-xl border border-line/10 bg-line/5 px-3 py-2.5">
            <summary className="cursor-pointer text-xs font-medium text-fg/80">
              探针怎么用这个令牌？
            </summary>
            <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-fg/60">
              <p>
                探针的所有业务接口都要带请求头{' '}
                <code className="rounded bg-line/10 px-1 py-0.5 font-mono text-fg/80">
                  X-Agent-Token
                </code>
                ；只有 <code className="font-mono text-fg/80">/api/info</code>{' '}
                是免鉴权的，首页靠它做自动发现。
              </p>
              <pre className="overflow-x-auto rounded-lg bg-line/10 p-2.5 font-mono text-[11px] text-fg/75">
                {`# 在内网机器上启动探针
node agent/node/index.mjs --port=9201 --token=<令牌>

# 自检（应返回端口清单 JSON）
curl -H "X-Agent-Token: <令牌>" http://<探针IP>:9201/api/services`}
              </pre>
              <p>
                探针默认只绑定第一个内网网卡，<strong className="font-semibold">不要</strong>
                把它的端口映射到公网。
              </p>
            </div>
          </details>
        </>
      )}
    </div>
  )
}

export function AccountSection() {
  const canEdit = useApp((s) => s.canEdit)
  const user = useApp((s) => s.user)

  return (
    <SettingsSection id="account" description="账号、登录设备、密码与探针令牌">
      {!canEdit ? (
        <LoginRequired>账号与安全需要管理员登录后才能查看</LoginRequired>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line/10 bg-line/5 px-3 py-2.5">
            <span className="text-xs text-fg/55">当前账号</span>
            <span className="font-mono text-sm text-fg">{user?.username ?? '—'}</span>
          </div>

          <LoginSessions key={user?.id} />
          <PasswordForm />
          <AgentTokenPanel />
        </>
      )}
    </SettingsSection>
  )
}
