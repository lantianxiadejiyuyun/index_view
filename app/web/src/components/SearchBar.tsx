import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { allEngines, findEngine, type SearchEngine } from '../lib/settings.ts'
import { useApp } from '../store/app.ts'

/**
 * 判断输入的是不是一个网址。
 * 「带点且没有空格」是业界通行的启发式：`github.com` 当网址，`github com` 当搜索词。
 */
function looksLikeUrl(input: string): boolean {
  const text = input.trim()
  if (!text || /\s/.test(text)) return false
  if (/^https?:\/\//i.test(text)) return true
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return true
  // 常见内网写法：192.168.1.1:8080 / nas.lan / 主机名:端口
  if (/^[\w-]+(:\d+)(\/.*)?$/.test(text)) return true
  return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)
}

function toUrl(input: string): string {
  const text = input.trim()
  if (/^https?:\/\//i.test(text)) return text

  // 内网地址基本都跑 http，补成 https 会直接打不开，而且很难看出原因
  const hostname = (text.split('/')[0] ?? '').split(':')[0]?.toLowerCase() ?? ''
  const isPrivate =
    hostname === 'localhost' ||
    (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) &&
      (/^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^127\./.test(hostname))) ||
    /\.(lan|local|home|internal|intranet|corp)$/.test(hostname)

  return `${isPrivate ? 'http' : 'https'}://${text}`
}

/** 匹配 "g 关键词" 这种强制走某个引擎的写法 */
function matchKeywordEngine(input: string, engines: SearchEngine[]): { engine: SearchEngine; query: string } | null {
  const m = /^(\S+)\s+(.+)$/.exec(input.trim())
  if (!m) return null
  const [, prefix, rest] = m
  const engine = engines.find((e) => e.keyword && e.keyword === prefix?.toLowerCase())
  if (!engine || !rest) return null
  return { engine, query: rest }
}

export function SearchBar() {
  const settings = useApp((s) => s.settings)
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [engineOpen, setEngineOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const engines = useMemo(() => allEngines(settings), [settings])
  const engine = useMemo(() => findEngine(settings, settings.search_engine), [settings])

  // 打开首页就能直接打字。
  // 只在「精确指针」设备上自动聚焦 —— 触屏上这么做会立刻弹出软键盘，
  // 把整个首屏顶上去，很烦人。
  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    inputRef.current?.focus()
  }, [])

  // 键盘党：按 "/" 或 Ctrl/Cmd+K 直接聚焦搜索框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (typing) return

      if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 点外面收起引擎下拉
  useEffect(() => {
    if (!engineOpen) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setEngineOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [engineOpen])

  function submit(raw: string) {
    const text = raw.trim()
    if (!text) return

    // 1) 前缀强制引擎： "gh react hooks"
    const forced = matchKeywordEngine(text, engines)
    if (forced) {
      const url = forced.engine.url.replace('%s', encodeURIComponent(forced.query))
      window.open(url, '_blank', 'noopener,noreferrer')
      setValue('')
      return
    }

    // 2) 看着像网址就直接跳
    if (looksLikeUrl(text)) {
      window.open(toUrl(text), '_blank', 'noopener,noreferrer')
      setValue('')
      return
    }

    // 3) 否则按当前引擎搜索
    const url = engine.url.replace('%s', encodeURIComponent(text))
    window.open(url, '_blank', 'noopener,noreferrer')
    setValue('')
  }

  const hint = matchKeywordEngine(value, engines)

  return (
    <div ref={wrapRef} className="relative mx-auto mb-6 w-full max-w-xl sm:mb-8">
      <div
        className={[
          'glass flex items-center gap-2 rounded-2xl px-3 transition-all duration-300 sm:px-4',
          // 聚焦时用品牌色描边 + 一圈柔光，让页面唯一的主动作有明确的反馈
          focused
            ? 'ring-2 ring-accent/60 shadow-[0_0_0_6px_rgb(var(--accent-rgb)/0.12)]'
            : 'ring-1 ring-line/10 hover:ring-line/25',
        ].join(' ')}
      >
        <Search className="size-4 shrink-0 text-fg/60" aria-hidden />

        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(value)
            if (e.key === 'Escape') {
              setValue('')
              inputRef.current?.blur()
            }
          }}
          placeholder="搜索，或直接输入网址"
          aria-label="搜索或输入网址"
          className="min-w-0 flex-1 bg-transparent py-4 text-[15px] text-fg outline-none placeholder:text-fg/45 sm:text-base"
        />

        {/* 引擎选择器 */}
        <div className="relative shrink-0">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEngineOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium text-fg/80 transition hover:bg-line/15"
            aria-label="切换搜索引擎"
            aria-expanded={engineOpen}
          >
            {engine.name}
            <CornerDownLeft className="size-3 opacity-60" aria-hidden />
          </button>

          {engineOpen && (
            <div className="glass glass-pop animate-pop absolute right-0 top-full z-30 mt-2 w-44 overflow-hidden rounded-xl p-1">
              {engines.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onMouseDown={(e2) => e2.preventDefault()}
                  onClick={() => {
                    void useApp.getState().saveSettings({ search_engine: e.id })
                    setEngineOpen(false)
                  }}
                  className={[
                    'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition',
                    e.id === engine.id
                      ? 'bg-line/20 text-fg'
                      : 'text-fg/75 hover:bg-line/10 hover:text-fg',
                  ].join(' ')}
                >
                  <span>{e.name}</span>
                  {e.keyword && <span className="text-[10px] text-fg/40">{e.keyword}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 输入了前缀才提示会走哪个引擎，避免用户以为搜索坏了。
          没有提示时整块不渲染 —— 之前用固定高度占位，白白吃掉 24px 首屏高度。 */}
      {hint && (
        <div className="mt-2 text-center text-[11px] text-fg/50">
          {`将用「${hint.engine.name}」搜索：${hint.query}`}
        </div>
      )}
    </div>
  )
}
