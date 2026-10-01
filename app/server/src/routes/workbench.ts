import { Hono } from 'hono'
import { readJson } from '../lib/body.js'
import { sql } from '../lib/db.js'
import { str } from '../lib/parse.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export const workbenchRoutes = new Hono<AppEnv>()

/**
 * 工作台：一堆要登的后台/系统，每条记网址、用途、账号、密码、备注。
 *
 * ── 为什么是单独一张表，而不是给 sites 加几列 ──
 * 语义不一样：sites 是「点开就走」的快捷入口，工作台是「打开 → 找账号 → 复制密码」，
 * 界面上要平铺凭据，两者混在一起会让首页那套卡片逻辑处处要判空。
 *
 * ── 权限 ──
 * 整个路由都要登录。这里面有明文密码，不能像 /uploads 那样匿名可读。
 *
 * ⚠️ 密码是**明文存在 SQLite** 里的，和 agent_token / jwt_secret / 宝塔凭据一样。
 * 库就在你自己机器上，没引入密钥管理（那会带来「密钥存哪」的循环问题）。
 * 界面上默认打码，但**导出数据会把它带出去**，别把备份随手发人。
 */

const MAX_GROUP = 40
const MAX_TITLE = 100
const MAX_URL = 500
const MAX_PURPOSE = 200
const MAX_USER = 200
const MAX_PASS = 300
const MAX_NOTE = 500

type WorkbenchRow = {
  id: number
  group_name: string
  title: string
  url: string | null
  purpose: string | null
  username: string | null
  password: string | null
  note: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

/** 密码**不 trim**：前后空格可能就是密码的一部分 */
function readPassword(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_PASS) : null
}

workbenchRoutes.get('/workbench', requireAuth, (c) => {
  const items = sql.all<WorkbenchRow>(
    `SELECT id, group_name, title, url, purpose, username, password, note,
            sort_order, created_at, updated_at
       FROM workbench_items
      ORDER BY group_name ASC, sort_order ASC, id ASC`,
  )

  // 分组列表由数据现推 —— 用字符串存分组的好处就在这，不用维护一张表
  const groups = [...new Set(items.map((i) => i.group_name).filter(Boolean))]

  return c.json({ items, groups })
})

workbenchRoutes.post('/workbench', requireAuth, async (c) => {
  const body = await readJson<Record<string, unknown>>(c)

  const title = str(body.title, MAX_TITLE)
  if (!title) return c.json({ error: 'bad_request', message: '名称不能为空' }, 400)

  const now = Date.now()
  const maxOrder =
    sql.get<{ n: number | null }>('SELECT MAX(sort_order) AS n FROM workbench_items')?.n ?? 0

  const { lastInsertRowid } = sql.run(
    `INSERT INTO workbench_items
       (group_name, title, url, purpose, username, password, note, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    str(body.group_name, MAX_GROUP) ?? '',
    title,
    str(body.url, MAX_URL),
    str(body.purpose, MAX_PURPOSE),
    str(body.username, MAX_USER),
    readPassword(body.password),
    str(body.note, MAX_NOTE),
    maxOrder + 10,
    now,
    now,
  )

  const row = sql.get<WorkbenchRow>('SELECT * FROM workbench_items WHERE id = ?', lastInsertRowid)
  return c.json({ item: row }, 201)
})

workbenchRoutes.put('/workbench/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad_request' }, 400)

  const existing = sql.get<WorkbenchRow>('SELECT * FROM workbench_items WHERE id = ?', id)
  if (!existing) return c.json({ error: 'not_found', message: '没有这一条' }, 404)

  const body = await readJson<Record<string, unknown>>(c)

  // 字段没传就保持原样，这样「只改备注」不会把别的字段清掉
  const title = body.title === undefined ? existing.title : str(body.title, MAX_TITLE)
  if (!title) return c.json({ error: 'bad_request', message: '名称不能为空' }, 400)

  const pick = (key: keyof WorkbenchRow, max: number) =>
    body[key] === undefined ? (existing[key] as string | null) : str(body[key], max)

  sql.run(
    `UPDATE workbench_items
        SET group_name = ?, title = ?, url = ?, purpose = ?, username = ?, password = ?,
            note = ?, updated_at = ?
      WHERE id = ?`,
    str(body.group_name, MAX_GROUP) ?? existing.group_name,
    title,
    pick('url', MAX_URL),
    pick('purpose', MAX_PURPOSE),
    pick('username', MAX_USER),
    body.password === undefined ? existing.password : readPassword(body.password),
    pick('note', MAX_NOTE),
    Date.now(),
    id,
  )

  const row = sql.get<WorkbenchRow>('SELECT * FROM workbench_items WHERE id = ?', id)
  return c.json({ item: row })
})

workbenchRoutes.delete('/workbench/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad_request' }, 400)

  const res = sql.run('DELETE FROM workbench_items WHERE id = ?', id)
  if (res.changes === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true })
})

/**
 * 整组改名。
 *
 * 分组用字符串存，改名本来要逐条改 —— 与其让前端循环发 N 个请求，
 * 不如给一个接口一次 `UPDATE ... WHERE group_name = ?`。
 */
workbenchRoutes.put('/workbench/group/:name', requireAuth, async (c) => {
  const from = decodeURIComponent(c.req.param('name'))
  const body = await readJson<{ name?: unknown }>(c)
  const to = str(body.name, MAX_GROUP) ?? ''

  const res = sql.run(
    'UPDATE workbench_items SET group_name = ?, updated_at = ? WHERE group_name = ?',
    to,
    Date.now(),
    from,
  )
  return c.json({ ok: true, moved: res.changes })
})
