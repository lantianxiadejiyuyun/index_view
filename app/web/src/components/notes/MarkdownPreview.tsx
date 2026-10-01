import type { RefObject } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from './markdown.ts'

/**
 * Markdown 预览区。
 *
 * 滚动同步是「父组件推、这里被动接收」：父组件把 previewRef 拿在手里，
 * 编辑器滚动时直接改 scrollTop。如果把滚动比例做成 prop，
 * 每滚一像素都会触发一次整页重渲染，得不偿失。
 */
export function MarkdownPreview({
  content,
  containerRef,
  className = '',
}: {
  content: string
  containerRef?: RefObject<HTMLDivElement | null>
  className?: string
}) {
  // 渲染 + 消毒都不便宜，只在内容真的变了时重算
  const html = useMemo(() => renderMarkdown(content), [content])

  const bodyRef = useRef<HTMLDivElement>(null)

  /**
   * 图片加载失败就地隐藏。
   *
   * 笔记里的图片路径基本都不可能解析成功（笔记目录没有静态托管），
   * 被消毒掉的 XSS 载荷也会剩下一个 `<img src=x>`；留着破图图标很难看。
   * error 事件不冒泡，所以必须用捕获阶段监听。
   */
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onError = (event: Event): void => {
      if (event.target instanceof HTMLImageElement) event.target.style.display = 'none'
    }
    el.addEventListener('error', onError, true)
    return () => el.removeEventListener('error', onError, true)
  }, [html])

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    // 预览里的链接点开就是离开应用，统一改成新标签打开，避免误触丢掉未保存的编辑
    const target = event.target
    const anchor = target instanceof Element ? target.closest('a') : null
    if (!anchor) return
    const href = anchor.getAttribute('href')
    event.preventDefault()
    if (!href || href.startsWith('#')) return
    window.open(href, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      ref={containerRef}
      className={`overflow-y-auto overscroll-contain px-4 py-3 sm:px-6 ${className}`}
    >
      <PreviewStyles />
      {html ? (
        <div
          ref={bodyRef}
          className="md-body max-w-none break-words text-[13.5px] leading-relaxed text-fg/85"
          onClick={handleClick}
          // html 已经过 DOMPurify 消毒（见 markdown.ts），这是唯一允许 innerHTML 的地方
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <p className="py-10 text-center text-xs text-fg/35">这篇笔记还是空的</p>
      )}
    </div>
  )
}

/**
 * 预览区的排版样式。
 *
 * 项目没装 @tailwindcss/typography，index.css 也不适合塞进这么大一坨排版规则，
 * 所以就近放在组件里 —— 只作用于 .md-body，不会影响其它页面。
 *
 * ⚠️ 颜色走 index.css 的语义 token，而不是写死的白色：
 * 浅色主题下玻璃卡片是白的，白字标题压上去等于没写（正文因为用了 text-fg
 * 才侥幸正常，标题、加粗、引用线、表格线、代码块底全都是隐形的）。
 * --fg-rgb / --line-rgb 在 .dark 里会翻成白色系，深色主题的观感不变。
 */
function PreviewStyles() {
  return (
    <style>{`
      .md-body > *:first-child { margin-top: 0; }
      .md-body > *:last-child { margin-bottom: 0; }
      .md-body h1, .md-body h2, .md-body h3, .md-body h4 {
        color: rgb(var(--fg-rgb) / 0.96);
        font-weight: 600;
        line-height: 1.35;
        margin: 1.4em 0 0.6em;
      }
      .md-body h1 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid rgb(var(--line-rgb) / 0.12); }
      .md-body h2 { font-size: 1.25em; }
      .md-body h3 { font-size: 1.08em; }
      .md-body p { margin: 0.7em 0; }
      .md-body a { color: rgb(var(--accent-rgb)); text-decoration: underline; text-underline-offset: 2px; }
      .md-body strong { color: rgb(var(--fg-rgb) / 0.96); font-weight: 600; }
      .md-body em { color: rgb(var(--fg-rgb) / 0.92); }
      .md-body ul, .md-body ol { margin: 0.7em 0; padding-left: 1.5em; }
      .md-body ul { list-style: disc; }
      .md-body ol { list-style: decimal; }
      .md-body li { margin: 0.25em 0; }
      .md-body li::marker { color: rgb(var(--fg-rgb) / 0.4); }
      .md-body input[type='checkbox'] { margin-right: 0.4em; }
      .md-body blockquote {
        margin: 0.9em 0;
        padding: 0.1em 0 0.1em 0.9em;
        border-left: 3px solid rgb(var(--line-rgb) / 0.25);
        color: rgb(var(--fg-rgb) / 0.68);
      }
      .md-body code {
        font-family: var(--font-mono, monospace);
        font-size: 0.92em;
        background: rgb(var(--line-rgb) / 0.1);
        padding: 0.12em 0.4em;
        border-radius: 6px;
      }
      .md-body pre {
        margin: 0.9em 0;
        padding: 0.8em 1em;
        background: rgb(var(--line-rgb) / 0.07);
        border: 1px solid rgb(var(--line-rgb) / 0.12);
        border-radius: 12px;
        overflow-x: auto;
      }
      .md-body pre code { background: none; padding: 0; font-size: 0.88em; }
      .md-body hr { margin: 1.4em 0; border: none; border-top: 1px solid rgb(var(--line-rgb) / 0.15); }
      .md-body table { margin: 0.9em 0; border-collapse: collapse; width: 100%; font-size: 0.95em; }
      .md-body th, .md-body td { border: 1px solid rgb(var(--line-rgb) / 0.15); padding: 0.4em 0.6em; text-align: left; }
      .md-body th { background: rgb(var(--line-rgb) / 0.07); color: rgb(var(--fg-rgb) / 0.92); }
      .md-body img { max-width: 100%; border-radius: 10px; }
    `}</style>
  )
}
