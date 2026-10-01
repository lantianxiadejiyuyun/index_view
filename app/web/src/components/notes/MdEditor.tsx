import { useEffect, useRef } from 'react'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { basicSetup } from 'codemirror'

/**
 * 配色隔间。深浅色切换只需要重配它，文档、光标、撤销历史都不受影响。
 */
const themeCompartment = new Compartment()

/** 当前是不是深色主题。真相只有一个：<html> 上的 .dark（见 App.applyThemeClass） */
function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark')
}

/**
 * CodeMirror 6 的 Markdown 编辑器。
 *
 * 这里刻意做成「非受控」：编辑器实例只在挂载时创建一次，之后文档由 CM 自己维护，
 * 内容变化往外抛给 onChange。原因是把 value 当受控 prop 逐字母同步回 CM，
 * 每次 dispatch 都会把光标顶到行尾、并且清掉撤销历史。
 *
 * React 19 的 StrictMode 会把 effect 跑两遍，所以创建/销毁必须严格配对，
 * 且创建所需的初始值放在 ref 里（第二次执行时读到的是同一个值，不会串）。
 */
export function MdEditor({
  value,
  onChange,
  onSave,
  onScrollRatio,
  className = '',
}: {
  value: string
  onChange: (next: string) => void
  onSave: () => void
  /** 0~1 的滚动进度，用于分栏模式下同步预览 */
  onScrollRatio?: (ratio: number) => void
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 挂载时的初值。StrictMode 下第二次建实例时仍然读它，保证两边一致
  const initialRef = useRef(value)

  // 回调统一走 ref：实例只建一次，不能因为父组件每次渲染产生的新函数引用就重建编辑器
  const handlers = useRef({ onChange, onSave, onScrollRatio })
  useEffect(() => {
    handlers.current = { onChange, onSave, onScrollRatio }
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let frame = 0

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialRef.current,
        extensions: [
          basicSetup,
          markdown(),
          // Markdown 是长行文本，不折行会出现横向滚动条，很难受
          EditorView.lineWrapping,
          placeholder('开始写点什么…  支持 Markdown，Ctrl/Cmd+S 保存'),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave()
                return true
              },
            },
          ]),
          themeCompartment.of(editorTheme(isDarkTheme())),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })

    viewRef.current = view

    // 滚动进度用 rAF 节流：滚动事件触发频率远高于屏幕刷新，直接转发会白算很多次
    const scroller = view.scrollDOM
    const onScroll = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const cb = handlers.current.onScrollRatio
        if (!cb) return
        const max = scroller.scrollHeight - scroller.clientHeight
        cb(max <= 0 ? 0 : scroller.scrollTop / max)
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
      // 不 destroy 会在切换文件/热更新时留下野实例，越攒越多
      view.destroy()
      viewRef.current = null
    }
  }, [])

  /**
   * 跟随应用主题。
   *
   * CodeMirror 的深浅标记不只是一组颜色：它的内置界面（搜索面板、自动补全、
   * 原生控件）也是按这个标记挑基础样式的。所以主题一变就得重配 ——
   * 写死 dark 会让浅色主题下的搜索框变成深色控件，反过来同理。
   */
  useEffect(() => {
    const observer = new MutationObserver(() => {
      viewRef.current?.dispatch({
        effects: themeCompartment.reconfigure(editorTheme(isDarkTheme())),
      })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // 外部整体替换文档（冲突后「加载磁盘版本」、重新读盘）时才需要动 CM
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={hostRef} className={`h-full overflow-hidden ${className}`} />
}

/**
 * 编辑器主题：背景全透明，让底下的玻璃卡片透出来，
 * 这样笔记页和首页是同一套视觉语言。
 *
 * ⚠️ 颜色一律走 index.css 的语义 token（--fg-rgb / --line-rgb / --surface-rgb /
 * --accent-rgb），它们在 :root（浅色）和 .dark（深色）里各有一组值，
 * 浏览器在绘制时实时解析，所以切主题不用重建编辑器。
 * 这里曾经写死成白色 —— 浅色主题的玻璃卡片也是白的，白字压上去
 * 整个编辑器看起来就是一片空白（内容其实还在，光标也在，就是看不见）。
 *
 * 深浅两套各只建一次并缓存：EditorView.theme() 每次调用都会注册一份新的
 * 样式表，来回切主题时不该越攒越多。
 */
const themeCache = new Map<boolean, Extension>()

function editorTheme(dark: boolean): Extension {
  const cached = themeCache.get(dark)
  if (cached) return cached

  const theme = EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'transparent',
        color: 'rgb(var(--fg-rgb) / 0.9)',
        fontSize: '13.5px',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono, monospace)',
        lineHeight: '1.75',
        overflow: 'auto',
      },
      '.cm-content': { padding: '12px 4px 40px', caretColor: 'rgb(var(--accent-rgb))' },
      '.cm-line': { padding: '0 6px' },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'rgb(var(--fg-rgb) / 0.25)',
        border: 'none',
        paddingRight: '2px',
      },
      '.cm-activeLine': { backgroundColor: 'rgb(var(--line-rgb) / 0.045)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'rgb(var(--fg-rgb) / 0.5)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--accent-rgb))' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'rgb(79 124 255 / 0.35)',
      },
      '.cm-placeholder': { color: 'rgb(var(--fg-rgb) / 0.3)' },
      '.cm-panels': {
        backgroundColor: 'rgb(var(--surface-rgb) / 0.95)',
        color: 'rgb(var(--fg-rgb))',
      },
      '.cm-searchMatch': { backgroundColor: 'rgb(234 179 8 / 0.35)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgb(234 179 8 / 0.6)' },
      '.cm-tooltip': {
        backgroundColor: 'rgb(var(--surface-rgb) / 0.95)',
        border: '1px solid rgb(var(--line-rgb) / 0.15)',
        borderRadius: '10px',
        color: 'rgb(var(--fg-rgb))',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgb(79 124 255 / 0.5)' },
    },
    { dark },
  )

  themeCache.set(dark, theme)
  return theme
}
