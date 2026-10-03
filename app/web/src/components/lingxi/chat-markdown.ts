import DOMPurify from 'dompurify'
import { marked, Renderer } from 'marked'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

function safeLink(href: string): boolean {
  if (!href || /[\u0000-\u0020\u007f\\]/.test(href)) return false
  if (href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'))) return true
  if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return false
  try { const url = new URL(href); return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}

/** A deliberately small Markdown surface: raw HTML is discarded and images stay text. */
export function limitedChatMarkdown(source: string): string {
  const renderer = new Renderer()
  renderer.html = () => ''
  renderer.image = ({ text }) => text ? `[图片：${escapeHtml(text)}]` : '[图片]'
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens)
    if (!safeLink(href)) return text
    return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`
  }
  return marked.parse(source, { async: false, gfm: true, breaks: true, renderer })
}

export function renderChatMarkdown(source: string): string {
  if (!source.trim()) return ''
  return DOMPurify.sanitize(limitedChatMarkdown(source), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  })
}
