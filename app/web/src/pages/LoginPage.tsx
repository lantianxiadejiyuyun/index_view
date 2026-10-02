import { useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, BookOpen, Compass, Eye, EyeOff, LayoutGrid,
  Loader2, LockKeyhole, Monitor, Moon, Server, Sun, TriangleAlert, User,
} from 'lucide-react'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { errorMessage } from '../lib/api.ts'
import './LoginPage.css'

export function LoginPage() {
  const login = useApp((s) => s.login)
  const title = useApp((s) => s.settings.site_title)
  const theme = useApp((s) => s.settings.theme)
  const setTheme = useApp((s) => s.setTheme)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const navigate = useNavigate()
  const location = useLocation()
  // 保留路由守卫传来的目标，登录后继续原来的操作。
  const from = (location.state as { from?: string } | null)?.from
  const redirectTo = from && !from.startsWith('/login') ? from : '/'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    if (!username.trim() || !password) {
      setError('请输入用户名和密码')
      return
    }
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await login(username.trim(), password)
      toast.success('登录成功')
      navigate(redirectTo, { replace: true })
    } catch (err) {
      setError(errorMessage(err, '登录失败，请稍后重试'))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const themes = [
    { value: 'light', label: '浅色', Icon: Sun },
    { value: 'auto', label: '跟随系统', Icon: Monitor },
    { value: 'dark', label: '深色', Icon: Moon },
  ] as const

  return (
    <main className="login-page">
      <header className="login-header">
        <Link to="/" className="login-brand" aria-label={`${title}，返回首页`}>
          <span className="login-brand-icon"><Compass className="size-6" aria-hidden /></span>
          <span className="min-w-0 break-words">{title}</span>
        </Link>
        <div className="login-theme" role="group" aria-label="外观（仅当前设备）">
          {themes.map(({ value, label, Icon }) => (
            <button key={value} type="button" aria-label={label} title={label}
              aria-pressed={theme === value} onClick={() => setTheme(value)}>
              <Icon className="size-4" aria-hidden />
            </button>
          ))}
        </div>
      </header>

      <div className="login-content">
        <div className="login-panel animate-rise">
          <section className="login-intro" aria-label="你的个人工作台">
            <div className="login-intro-copy">
              <p className="login-eyebrow">YOUR PERSONAL SPACE</p>
              <h2>常用的，<br />都在这里。</h2>
              <p className="login-intro-description">收藏喜欢的网站，整理灵感与日常。<br />从这里，开始专注的一天。</p>
            </div>
            <div className="login-illustration" aria-hidden="true">
              <div className="login-preview">
                <div className="login-preview-top"><span /><span /><span /></div>
                <div className="login-preview-search"><Compass className="size-4" /><span /><ArrowRight className="size-4" /></div>
                <div className="login-preview-grid">
                  <span><LayoutGrid /></span><span><BookOpen /></span><span><Server /></span><span><Compass /></span>
                </div>
                <div className="login-preview-lines"><span /><span /></div>
              </div>
              <div className="login-orbit-icon"><Compass className="size-7" /></div>
            </div>
            <div className="login-intro-features"><span>个性导航</span><i /><span>灵感笔记</span><i /><span>服务管理</span></div>
          </section>

          <section className="login-form-section" aria-labelledby="login-heading">
            <div className="login-welcome-icon"><LockKeyhole className="size-6" aria-hidden /></div>
            <p className="login-form-eyebrow">很高兴再次见到你</p>
            <h1 id="login-heading">欢迎回来</h1>
            <p className="login-form-description">登录账号，进入你的专属空间。</p>

            <form className="login-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
              <div>
                <label htmlFor="login-user">用户名</label>
                <div className="login-input-wrap">
                  <User className="login-input-icon" aria-hidden />
                  <input id="login-user" name="username" type="text" placeholder="请输入用户名"
                    value={username} onChange={(event) => { setUsername(event.target.value); setError('') }}
                    autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                    required readOnly={busy} aria-describedby={error ? 'login-error' : undefined} />
                </div>
              </div>
              <div>
                <label htmlFor="login-pass">密码</label>
                <div className="login-input-wrap">
                  <LockKeyhole className="login-input-icon" aria-hidden />
                  <input id="login-pass" name="password" type={showPassword ? 'text' : 'password'}
                    placeholder="请输入密码" className="login-password"
                    value={password} onChange={(event) => { setPassword(event.target.value); setError('') }}
                    autoComplete="current-password" required readOnly={busy}
                    aria-describedby={error ? 'login-error' : undefined} />
                  <button className="login-password-toggle" type="button"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-controls="login-pass"
                    aria-pressed={showPassword} onClick={() => setShowPassword((shown) => !shown)}>
                    {showPassword ? <EyeOff className="size-[18px]" aria-hidden /> : <Eye className="size-[18px]" aria-hidden />}
                  </button>
                </div>
              </div>
              {error && <p id="login-error" className="login-error" role="alert"><TriangleAlert className="size-4 shrink-0" aria-hidden />{error}</p>}
              <button className="login-submit" type="submit" disabled={busy}>
                {busy ? <><Loader2 className="size-[18px] animate-spin" aria-hidden />正在登录…</> : <>登 录<ArrowRight className="size-[18px]" aria-hidden /></>}
              </button>
            </form>

            <div className="login-form-footer">
              <Link to="/"><ArrowLeft className="size-4" aria-hidden />返回首页</Link>
              <span>让每次出发，都更简单</span>
            </div>
          </section>
        </div>
      </div>
      <footer className="login-footer">一个入口，连接你的日常。</footer>
    </main>
  )
}
