/**
 * SQLite 薄封装。
 *
 * 刻意只用 Node 内置的 node:sqlite —— 零原生依赖、不需要编译，
 * Windows 裸跑和 Docker 镜像里行为完全一致。全部语句走位置参数 `?`，
 * 这样将来若要换成 better-sqlite3，只需要改这一个文件。
 */
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { DB_FILE, ensureDirs } from '../config.js'

export type Row = Record<string, unknown>
export type Param = string | number | bigint | null | Uint8Array

ensureDirs()

export const db: DatabaseSync = new DatabaseSync(DB_FILE)

// WAL 让读写并发不互相阻塞；外键约束默认是关的，必须显式打开
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA busy_timeout = 5000')
db.exec('PRAGMA synchronous = NORMAL')

const cache = new Map<string, StatementSync>()

function stmt(sql: string): StatementSync {
  let s = cache.get(sql)
  if (!s) {
    s = db.prepare(sql)
    cache.set(sql, s)
  }
  return s
}

/** node:sqlite 的 lastInsertRowid 可能是 bigint，统一收敛成 number */
function normalizeChanges(res: { changes: number | bigint; lastInsertRowid: number | bigint }) {
  return {
    changes: Number(res.changes),
    lastInsertRowid: Number(res.lastInsertRowid),
  }
}

export const sql = {
  /** 查询多行 */
  all<T = Row>(query: string, ...params: Param[]): T[] {
    return stmt(query).all(...params) as T[]
  },
  /** 查询单行，无结果返回 undefined */
  get<T = Row>(query: string, ...params: Param[]): T | undefined {
    return stmt(query).get(...params) as T | undefined
  },
  /** 写入，返回影响行数与自增主键 */
  run(query: string, ...params: Param[]) {
    return normalizeChanges(stmt(query).run(...params))
  },
  /** 执行多条 DDL / 无参数语句 */
  exec(query: string): void {
    db.exec(query)
    cache.clear()
  },
  /** 事务包装：抛错自动回滚 */
  tx<T>(fn: () => T): T {
    db.exec('BEGIN')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 回滚失败时保留原始错误 */
      }
      throw err
    }
  },
}

/** SQLite 存布尔用 0/1，写库前显式转换 */
export function fromBool(v: boolean): number {
  return v ? 1 : 0
}

export function closeDb(): void {
  try {
    db.close()
  } catch {
    /* 已关闭 */
  }
}

// 便于排障时确认数据库文件位置
if (process.env.DEBUG_DB === '1') {
  console.log(`[db] ${path.resolve(DB_FILE)}`)
}
