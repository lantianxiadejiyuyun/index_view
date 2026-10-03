import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../app/web/src/components/lingxi/chat-markdown.ts', import.meta.url))
const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false }).outputFiles[0].text
const { limitedChatMarkdown } = await import(`data:text/javascript,${encodeURIComponent(code)}`)

// Exercise the untrusted-input renderer before the independent DOMPurify browser pass.
test('assistant Markdown preserves headings, lists, code and tables', () => {
  const html = limitedChatMarkdown('## 今日计划\n\n1. **完成复习**\n2. 整理笔记\n\n```js\nconst value = "<tag>"\n```\n\n| 日期 | 事项 |\n| --- | --- |\n| 周一 | 复习 |')
  assert.match(html, /<h2>今日计划<\/h2>/)
  assert.match(html, /<ol>/)
  assert.match(html, /<strong>完成复习<\/strong>/)
  assert.match(html, /<pre><code/)
  assert.match(html, /&lt;tag&gt;/)
  assert.match(html, /<table>/)
})

test('chat images and embedded HTML cannot trigger external requests or handlers', () => {
  const html = limitedChatMarkdown('![预览](https://tracker.invalid/pixel.gif)\n\n<img src="https://tracker.invalid/raw" onerror="alert(1)">\n\n<iframe src="https://tracker.invalid/frame"></iframe>\n\n<script>alert(1)</script>\n\n<svg onload="alert(1)"></svg>')
  assert.match(html, /\[图片：预览\]/)
  assert.doesNotMatch(html, /<(?:img|iframe|script|svg)\b/i)
  assert.doesNotMatch(html, /(?:src|onerror|onload)\s*=/i)
  assert.doesNotMatch(html, /tracker\.invalid/)
})

test('dangerous Markdown link schemes, entities and protocol-relative URLs are inert', () => {
  const source = [
    '[javascript](javascript:alert%281%29)',
    '[encoded](javascript&#58;alert%281%29)',
    '[data](data:text/html;base64,ZXZpbA==)',
    '[protocol-relative](//tracker.invalid/x)',
    '[file](file:///C:/private)',
    '<a href="javascript:alert(1)" onclick="alert(2)">raw link</a>',
  ].join('\n\n')
  const html = limitedChatMarkdown(source)
  assert.doesNotMatch(html, /<a\b/i)
  assert.doesNotMatch(html, /onclick=/i)
  assert.match(html, /protocol-relative/)
})

test('allowed links have opener protection and escaped attributes', () => {
  const html = limitedChatMarkdown('[文档](https://example.com/?a=1&b=2 "说明")\n\n[密码查看](/settings/lingxi#lingxi-vault)')
  assert.match(html, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/)
  assert.match(html, /href="\/settings\/lingxi#lingxi-vault"/)
  assert.equal((html.match(/rel="noopener noreferrer"/g) ?? []).length, 2)
})
