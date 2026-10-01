import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, LockKeyhole, User } from 'lucide-react'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { btnPrimary, fieldClass, labelClass } from '../components/Modal.tsx'
import { errorMessage } from '../lib/api.ts'

export function LoginPage() {
  const login = useApp((s) => s.login)
  const title = useApp((s) => s.settings.site_title)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  // 被路由守卫拦下来时会带上来原目标，登录完直接回那儿，不用再点一次
  const from = (location.state as { from?: string } | null)?.from
  const redirectTo = from && !from.startsWith('/login') ? from : '/'

  async function submit() {
    if (!username.trim() || !password) {
      toast.error('请输入用户名和密码')
      return
    }
    setBusy(true)
    try {
      await login(username.trim(), password)
      toast.success('登录成功')
      navigate(redirectTo, { replace: true })
    } catch (err) {
      toast.error(errorMessage(err, '登录失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="glass glass-pop animate-rise w-full max-w-sm rounded-3xl p-7">
        <h1 className="text-center text-xl font-semibold text-fg">{title}</h1>
        <p className="mt-1.5 text-center text-xs text-fg/55">登录后可以编辑图标与分组</p>

        <div className="mt-6 space-y-4">
          <div>
            <label className={labelClass} htmlFor="login-user">
              用户名
            </label>
            <div className="relative">
              <User
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg/40"
                aria-hidden
              />
              <input
                id="login-user"
                className={`${fieldClass} pl-9`}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="login-pass">
              密码
            </label>
            <div className="relative">
              <LockKeyhole
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg/40"
                aria-hidden
              />
              <input
                id="login-pass"
                type="password"
                className={`${fieldClass} pl-9`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className={`${btnPrimary} w-full`}
          >
            {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            登录
          </button>
        </div>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-fg/40">
          首次部署的默认账号是 admin / admin123，
          <br />
          登录后请立刻在设置页修改密码。
        </p>
      </div>

      <Link
        to="/"
        className="text-shadow-soft mt-5 flex items-center gap-1.5 text-xs text-wp/85 transition hover:text-wp"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        返回首页
      </Link>
    </div>
  )
}
