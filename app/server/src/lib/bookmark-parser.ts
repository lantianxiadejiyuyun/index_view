/**
 * Netscape Bookmark File 解析器（Chrome / Edge / Firefox / Safari 导出的 bookmarks.html）。
 *
 * 为什么不用 XML / DOM 解析器：这个格式是「HTML 片段」而不是合法 XML ——
 *   · `<DT>` 通常没有闭合标签，`<p>` 是裸标签
 *   · 属性大小写不固定，引号可能是单引号 / 双引号 / 完全没有
 *   · `<DT>` `<H3>` `<A>` 经常各自占一行，标题文本跨行
 *   · 文件被截断时 `<DL>` 会少一个闭合标签
 * 严格解析器会直接抛错，所以这里自己写一个「标签扫描 + 手工栈」的容错解析：
 * 全程只顺序扫一遍字符串（O(n)），不反复拼接大字符串，能扛住上万条书签。
 *
 * 本文件是纯函数模块，刻意不依赖 Hono，方便单独测试。
 */

/** 书签直接挂在容器（书签栏 / 其他书签）下、没有子文件夹时，落到这个分组 */
export const DEFAULT_GROUP_NAME = '未分类'

/** 与 sites.ts 的字段上限保持一致，避免「预览一个样、入库另一个样」 */
export const MAX_TITLE_LENGTH = 80
export const MAX_GROUP_NAME_LENGTH = 60
export const MAX_URL_LENGTH = 2000
export const MAX_ICON_URL_LENGTH = 1000

export type ParsedSite = {
  title: string
  url: string
  /** 只保留 http/https 的图标地址；data: 内联图标会被丢掉（见 addSite 注释） */
  icon_url?: string
}

export type ParsedGroup = {
  /** 扁平化后的分组名，嵌套文件夹形如 `父/子` */
  name: string
  sites: ParsedSite[]
}

// ── 文本工具 ─────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  times: '×',
  divide: '÷',
  plusmn: '±',
  laquo: '«',
  raquo: '»',
  bull: '•',
  sect: '§',
  para: '¶',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  infin: '∞',
  ne: '≠',
  le: '≤',
  ge: '≥',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  pi: 'π',
}

// 命名实体 / 十进制 / 十六进制数字实体；要求分号，避免把正文里的裸 `&` 也吃掉
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g

/** HTML 实体解码，认不出来的实体原样保留（宁可显示 `&foo;` 也不要吞字符） */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(ENTITY_RE, (whole: string, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      // 越界码点和孤立代理项直接放弃，交给 String.fromCodePoint 会抛错
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      if (code >= 0xd800 && code <= 0xdfff) return whole
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 按「字符」截断，避免把 emoji 的代理对劈成两半 */
export function clipText(input: string, max: number): string {
  if (input.length <= max) return input
  return Array.from(input).slice(0, max).join('')
}

/** 去实体 + 去掉换行缩进：Chrome 的标题经常跨行，实体也要还原成字符 */
export function cleanBookmarkText(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, ' ').trim()
}

// ── URL 规范化 ───────────────────────────────────────────────

/**
 * 显式挡掉非网页协议。
 *
 * 为什么单独列一份：sites.ts 的 normalizeUrl 只做「没协议就补 https://」，
 * 碰到 `mailto:a@b.com` 这种会被 URL 解析成 `https://a@b.com/`（userinfo 语法），
 * `javascript:void(0)` 则依赖端口解析失败才被拒 —— 太隐晦，这里直接挑明。
 * 其余规则（补 https://、只允许 http/https）与 sites.ts 完全一致。
 */
const NON_WEB_SCHEME_RE =
  /^(?:javascript|place|data|about|file|chrome|blob|vbscript|jar|view-source|mailto|tel|ftp|ftps|ws|wss|wyciwyg):/i

export function normalizeBookmarkUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  // HREF 里可能带实体，如 `?a=1&amp;b=2`
  const raw = decodeEntities(input).trim()
  if (!raw) return null
  if (NON_WEB_SCHEME_RE.test(raw)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const out = u.toString()
    return out.length > MAX_URL_LENGTH ? null : out
  } catch {
    return null
  }
}

// ── 编码嗅探 ─────────────────────────────────────────────────

const META_CHARSET_RE = /<meta[^>]*charset\s*=\s*["']?\s*([a-z0-9_\-]+)/i

/**
 * 把文件字节解成字符串。
 *
 * Chrome / Firefox 导出的都是 UTF-8，但老 IE / 部分国内浏览器会导出 gb2312，
 * 顺序是「先看 <meta charset>，再按 UTF-8 严格解，最后宽松 UTF-8 兜底」。
 * 尽力而为：解错了也只是乱码，不会让接口 500。
 */
export function decodeBookmarkHtml(bytes: Uint8Array): string {
  const decode = (label: string, fatal: boolean): string | null => {
    try {
      return new TextDecoder(label, { fatal }).decode(bytes)
    } catch {
      return null
    }
  }

  // latin1 解码不会因非法字节抛错，用它安全地嗅探文件头部的 ASCII 声明
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
  const declared = META_CHARSET_RE.exec(head)?.[1]?.toLowerCase()
  if (declared && declared !== 'utf-8' && declared !== 'utf8' && declared !== 'us-ascii') {
    const decoded = decode(declared, false)
    if (decoded !== null) return decoded
  }

  // fatal:true 用来判断「这确实是一份合法 UTF-8」
  const strict = decode('utf-8', true)
  if (strict !== null) return strict

  // 声明的 charset 不认识 / 文件里有坏字节：宽松解，坏字节变 U+FFFD 但不抛错
  return decode('utf-8', false) ?? Buffer.from(bytes).toString('utf8')
}

// ── 主解析器 ─────────────────────────────────────────────────

// 一次匹配一个「标签」或「注释」；注释优先，避免注释里的假标签被当成真标签
const TAG_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g
const TAG_NAME_RE = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)/

// 属性：引号可有可无；前面加一个分隔符限定，避免把 `DATA-HREF` 之类误当 href
const HREF_ATTR_RE = /(?:[\s"'/<])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i
const ICON_ATTR_RE = /(?:[\s"'/<])icon\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i
const TOOLBAR_FLAG_RE = /personal_toolbar_folder\s*=\s*(?:"?\s*true\s*"?|true)/i

/**
 * 容器文件夹名：这些是浏览器的「书签栏 / 收藏夹」外壳，不是用户建的分组，
 * 直接跳过它们、用里面的子文件夹当分组名，否则所有人导入完都多一个没意义的「书签栏」分组。
 */
const CONTAINER_NAMES = new Set(
  [
    '书签栏',
    '书签工具栏',
    '书签菜单',
    '收藏夹栏',
    '收藏夹',
    '收藏夹工具栏',
    '其他书签',
    '其它书签',
    '移动端书签',
    '手机书签',
    'bookmarks',
    'bookmarks bar',
    'bookmarks toolbar',
    'bookmarks menu',
    'bookmarks toolbar folder',
    'other bookmarks',
    'favorites',
    'favorites bar',
    'favorites toolbar',
    'mobile bookmarks',
    'mobile favorites',
    'unsorted bookmarks',
  ].map((s) => s.toLowerCase()),
)

function attrOf(tag: string, re: RegExp): string | null {
  const m = re.exec(tag)
  if (!m) return null
  return m[1] ?? m[2] ?? m[3] ?? null
}

/** H3 的文本 → 分组名；容器名或空名返回 null（null 表示「这一层不新增分组」） */
function folderNameOf(text: string, headingTag: string): string | null {
  const name = cleanBookmarkText(text)
  if (!name) return null
  // PERSONAL_TOOLBAR_FOLDER="true" 是最可靠的「这是书签栏」标志，比名字匹配准
  if (TOOLBAR_FLAG_RE.test(headingTag)) return null
  if (CONTAINER_NAMES.has(name.toLowerCase())) return null
  return clipText(name, MAX_GROUP_NAME_LENGTH)
}

/**
 * 解析 Netscape Bookmark 文件，按分组聚合。
 *
 * 结构：`<DL>` 是层级，`<H3>` 声明「下一个 <DL> 属于哪个文件夹」，
 * `<A HREF>` 是条目。用一个手工栈维护当前文件夹路径，遇到 `<DL>` 压栈、`</DL>` 出栈。
 */
export function parseBookmarks(html: string): ParsedGroup[] {
  const groups = new Map<string, ParsedSite[]>()

  /** 当前文件夹路径（只装真正的用户分组） */
  const path: string[] = []
  /** 与 path 平行的入栈标记：这一层 <DL> 到底有没有压入名字 */
  const pushed: boolean[] = []

  let pendingFolder: string | null = null
  let headingTag = ''
  let mode: 'none' | 'a' | 'h3' = 'none'
  let anchorHref: string | null = null
  let anchorIcon: string | null = null
  let cursor = 0

  const addSite = (titleText: string, href: string | null, icon: string | null): void => {
    // 只认落在 <DL> 结构里的 <A>：书签文件必然是 <DL><DT><H3>/<A> 的嵌套，
    // 而「另存为网页」的普通 HTML 里散落的 <a href> 不该被当成书签（否则导入什么文件都「成功」）
    if (pushed.length === 0) return

    const url = normalizeBookmarkUrl(href)
    if (!url) return
    const title = clipText(cleanBookmarkText(titleText), MAX_TITLE_LENGTH)
    if (!title) return // 空标题条目按需求直接过滤

    const name = clipText(
      path.length > 0 ? path.join('/') : DEFAULT_GROUP_NAME,
      MAX_GROUP_NAME_LENGTH,
    )

    const site: ParsedSite = { title, url }
    // 只收 http/https 图标：Chrome / Firefox 的 ICON 多是 data:image/png;base64… 的
    // 1x1 占位图，上万条能让 preview 的 JSON 膨胀到几十 MB，而项目本来就有 favicon 代理兜底
    const iconUrl = normalizeBookmarkUrl(icon)
    if (iconUrl && iconUrl.length <= MAX_ICON_URL_LENGTH) site.icon_url = iconUrl

    const bucket = groups.get(name)
    if (bucket) bucket.push(site)
    else groups.set(name, [site])
  }

  TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(html)) !== null) {
    const tag = match[0]
    const start = match.index
    const isComment = tag.startsWith('<!--')
    const nameMatch = isComment ? null : TAG_NAME_RE.exec(tag)
    const closing = nameMatch?.[1] === '/'
    const name = (nameMatch?.[2] ?? '').toLowerCase()

    // 标签之间的文本只在收集标题时有意义；mode 为 none 时整段跳过，避免无谓的 substring
    const between = mode === 'none' ? '' : html.slice(cursor, start)
    cursor = start + tag.length

    if (isComment) continue // 注释既不开也不闭合任何元素

    // 任何「不属于当前收集状态」的标签都说明上一个元素到此结束 —— 这正是
    // 缺闭合标签时还能正确收尾的关键：<A>…<DT> 也算标题结束
    if (mode === 'a' && !(name === 'a' && closing)) {
      addSite(between, anchorHref, anchorIcon)
      mode = 'none'
    } else if (mode === 'h3' && !(name === 'h3' && closing)) {
      pendingFolder = folderNameOf(between, headingTag)
      mode = 'none'
    }

    switch (name) {
      case 'a':
        if (closing) {
          if (mode === 'a') {
            addSite(between, anchorHref, anchorIcon)
            mode = 'none'
          }
        } else {
          // H3 后面直接跟 <A>，说明那个 H3 不是文件夹（少了 <DL>），别把它当分组
          pendingFolder = null
          anchorHref = attrOf(tag, HREF_ATTR_RE)
          anchorIcon = attrOf(tag, ICON_ATTR_RE)
          mode = 'a'
        }
        break
      case 'h3':
        if (closing) {
          if (mode === 'h3') {
            pendingFolder = folderNameOf(between, headingTag)
            mode = 'none'
          }
        } else {
          headingTag = tag
          mode = 'h3'
        }
        break
      case 'dl':
        if (closing) {
          // 文件被截断时可能多出 </DL>，栈空就忽略
          if (pushed.pop() === true) path.pop()
        } else {
          if (pendingFolder !== null) {
            path.push(pendingFolder)
            pushed.push(true)
          } else {
            pushed.push(false)
          }
          pendingFolder = null
        }
        break
      default:
        // <DT> <p> <DD> <META> <H1> <TITLE> <HR> 等一律只当分隔符
        break
    }
  }

  // 文件末尾没收尾的 <A>（截断文件）也要救回来
  if (mode === 'a') addSite(html.slice(cursor), anchorHref, anchorIcon)

  return Array.from(groups, ([name, sites]) => ({ name, sites }))
}
