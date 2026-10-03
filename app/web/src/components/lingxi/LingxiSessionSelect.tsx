import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, MessageCircle } from 'lucide-react'

type SessionOption = { id: string; title: string }
type MenuPosition = { left: number; top: number; width: number; maxHeight: number }

export function sessionMenuPosition(anchor: { left: number; top: number; bottom: number; width: number }, viewport: { left: number; top: number; width: number; height: number }, count: number): MenuPosition {
  const margin = 8, gap = 6
  const width = Math.min(Math.max(anchor.width, 280), Math.max(0, viewport.width - margin * 2))
  const below = Math.max(0, viewport.top + viewport.height - margin - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - viewport.top - margin - gap)
  const desired = Math.min(320, count * 44 + 14)
  const upwards = below < desired && above > below
  const maxHeight = Math.min(desired, upwards ? above : below)
  return {
    left: Math.max(viewport.left + margin, Math.min(anchor.left, viewport.left + viewport.width - margin - width)),
    top: upwards ? anchor.top - gap - maxHeight : anchor.bottom + gap,
    width, maxHeight,
  }
}

/** Search after the active option, wrapping once, like a native select. */
export function sessionTypeaheadIndex(options: SessionOption[], prefix: string, active: number): number {
  const needle = prefix.toLocaleLowerCase()
  for (let step = 1; step <= options.length; step++) {
    const index = (active + step + options.length) % options.length
    if ((options[index]!.title || '未命名对话').toLocaleLowerCase().startsWith(needle)) return index
  }
  return active
}

/** Select-only combobox. Focus stays on the trigger, including while its portal is open. */
export function LingxiSessionSelect({ sessions, value, disabled, onChange }: { sessions: SessionOption[]; value: string; disabled?: boolean; onChange: (id: string) => void }) {
  const id = useId(), listId = `${id}-sessions`
  const trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false), [active, setActive] = useState(0)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const typeahead = useRef({ text: '', time: 0 })
  const selected = sessions.find(session => session.id === value)
  const unavailable = disabled || sessions.length === 0
  const expanded = open && !unavailable
  const activeIndex = Math.min(active, Math.max(0, sessions.length - 1))

  function show(index = sessions.findIndex(session => session.id === value)) {
    if (unavailable) return
    setActive(Math.max(0, index)); setOpen(true)
    typeahead.current = { text: '', time: 0 }
  }
  function choose(index: number) {
    const session = sessions[index]
    if (session) onChange(session.id)
    setOpen(false)
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (unavailable || event.nativeEvent.isComposing) return
    if (event.key === 'Tab') { setOpen(false); return }
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (expanded) choose(activeIndex); else show()
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (event.key === 'Home') show(0)
      else if (event.key === 'End') show(sessions.length - 1)
      else if (!expanded) show()
      else setActive(index => Math.max(0, Math.min(sessions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const now = Date.now()
      const previous = now - typeahead.current.time < 700 ? typeahead.current.text : ''
      const text = previous + event.key
      typeahead.current = { text, time: now }
      const repeated = Array.from(text).every(letter => letter === text[0])
      const index = sessionTypeaheadIndex(sessions, repeated ? event.key : text, expanded ? activeIndex : sessions.findIndex(session => session.id === value))
      setActive(Math.max(0, index)); setOpen(true)
    }
  }

  useEffect(() => { if (unavailable) setOpen(false) }, [unavailable])
  useLayoutEffect(() => {
    if (!expanded) return
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const visual = window.visualViewport
      const viewport = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight }
      if (anchor.bottom < viewport.top || anchor.top > viewport.top + viewport.height) { setOpen(false); return }
      setPosition(sessionMenuPosition(anchor, viewport, sessions.length))
    }
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || trigger.current?.contains(event.target) || list.current?.contains(event.target)) return
      setOpen(false)
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    }
  }, [expanded, sessions.length])
  useLayoutEffect(() => {
    const option = list.current?.children[activeIndex] as HTMLElement | undefined
    const container = list.current
    if (!expanded || !option || !container) return
    // Scroll only the list, never the surrounding homepage or widget.
    if (option.offsetTop < container.scrollTop) container.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = option.offsetTop + option.offsetHeight - container.clientHeight
  }, [expanded, activeIndex, position?.maxHeight])

  return <>
    <button ref={trigger} type="button" role="combobox" aria-label="灵犀会话" aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded ? `${id}-option-${activeIndex}` : undefined} className="lingxi-session-select" disabled={unavailable} title={selected?.title || '新对话'} onKeyDown={keyDown} onClick={() => expanded ? setOpen(false) : show()}>
      <MessageCircle size={15} aria-hidden /><span>{selected?.title || (sessions.length ? '选择会话' : '新对话')}</span><ChevronDown size={15} aria-hidden />
    </button>
    {expanded && position && createPortal(<div ref={list} id={listId} role="listbox" aria-label="灵犀会话" className="lingxi-session-menu" style={position} onMouseDown={event => event.preventDefault()}>
      {sessions.map((session, index) => <div key={session.id} id={`${id}-option-${index}`} role="option" aria-selected={session.id === value} data-active={index === activeIndex} className="lingxi-session-option" title={session.title || '未命名对话'} onPointerMove={event => { if (event.pointerType === 'mouse') setActive(index) }} onClick={() => choose(index)}><span>{session.title || '未命名对话'}</span>{session.id === value && <Check size={15} aria-hidden />}</div>)}
    </div>, document.body)}
  </>
}
