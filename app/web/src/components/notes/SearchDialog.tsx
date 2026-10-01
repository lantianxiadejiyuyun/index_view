import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Loader2, Search } from 'lucide-react'
import { Modal, fieldClass } from '../Modal.tsx'
import { describeError, searchNotes, type SearchHit } from './notes-api.ts'
import { formatTime } from './paths.ts'

/**
 * 把后端返回的片段安全地高亮出来。
 *
 * 后端的 snippet 用 `**命中词**` 标记命中位置，但**不能**丢给 marked 渲染：
 * 笔记正文里可能写着 `<img src=x onerror=alert(1)>`，一旦当 Markdown 渲染
 * 就等于把笔记内容当代码执行。这里改成按 `**` 切分，用 React 元素包 <mark>，
 * 全程不碰 innerHTML —— 标题和路径同理，永远按纯文本渲染。
 */
function HighlightedSnippet({ snippet }: { snippet: string }) {
  const parts = useMemo(() => snippet.split('**'), [snippet])
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark
            // 片段是纯字符串，用下标做 key 足够：内容一变整段就重渲染
            key={index}
            className="rounded bg-amber-300/30 px-0.5 text-warn"
          >
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  )
}

export function SearchDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setError(null)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [open])

  // 输入防抖：每敲一个字都打一次全文搜索会把同步盘上的目录扫很多遍
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed === '') {
      setHits([])
      setLoading(false)
      setError(null)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    const timer = window.setTimeout(() => {
      searchNotes(trimmed, controller.signal)
        .then((results) => {
          setHits(results)
          setError(null)
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          setError(describeError(err, '搜索失败'))
          setHits([])
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 260)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, open])

  return (
    <Modal open={open} title="搜索笔记" onClose={onClose}>
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg/40" aria-hidden />
          <input
            ref={inputRef}
            className={`${fieldClass} pl-9`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索全部笔记内容…"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-fg/50" aria-hidden />
          )}
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        {!error && query.trim() !== '' && !loading && hits.length === 0 && (
          <p className="py-8 text-center text-xs text-fg/45">没有匹配「{query.trim()}」的笔记</p>
        )}

        {hits.length > 0 && (
          <ul className="space-y-1.5">
            {hits.map((hit) => (
              <li key={hit.path}>
                <button
                  type="button"
                  onClick={() => onPick(hit.path)}
                  className="w-full rounded-xl border border-line/10 bg-line/5 px-3 py-2.5 text-left transition hover:border-line/25 hover:bg-line/10"
                >
                  <div className="flex items-center gap-2">
                    <FileText className="size-3.5 shrink-0 text-accent" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                      {hit.title}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-fg/35">
                      {formatTime(hit.mtime)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-fg/45">{hit.path}</p>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-fg/70">
                    <HighlightedSnippet snippet={hit.snippet} />
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}

        {query.trim() === '' && (
          <p className="py-6 text-center text-[11px] leading-relaxed text-fg/35">
            大小写不敏感的子串匹配，命中片段最多显示前后 40 字。
            <br />
            搜索会跳过以 <code className="font-mono">.</code> 开头的目录和非 Markdown 文件。
          </p>
        )}
      </div>
    </Modal>
  )
}
