/**
 * Markdown → 安全 HTML。
 *
 * 笔记内容来自一个真实文件夹，可能刚被 VS Code / Typora / 网盘同步改过，
 * 对前端来说就是彻底的不可信输入。所以渲染链固定为
 * **marked 转 HTML → DOMPurify 消毒 → 才允许进 DOM**，
 * 中间任何一步都不能省（省掉消毒等于自己给自己开 XSS 后门）。
 */
import DOMPurify from 'dompurify'
import type { Config } from 'dompurify'
import { marked } from 'marked'

/**
 * 消毒配置：
 * - USE_PROFILES 只允许 HTML 档的标签，`<svg>` 这类默认就进不来
 * - 禁掉能反向加载资源或劫持文档的标签；笔记里写 `<img src=x onerror=…>`
 *   时 onerror 会被 DOMPurify 摘掉，img 本身留着（不影响正常插图）
 * - style 属性一律去掉：内联样式可以做出「覆盖全屏的假登录框」这类钓鱼效果
 */
const SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'srcset', 'formaction'],
}

export function renderMarkdown(source: string): string {
  if (source.trim() === '') return ''
  // async: false 显式声明走同步分支，返回值就是 string（marked 的返回类型是 string | Promise<string>）
  const html = marked(source, { async: false, gfm: true, breaks: true })
  return DOMPurify.sanitize(html, SANITIZE_CONFIG)
}
