import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * app/server/src 或 app/server/dist 往上三级 = 仓库根目录。
 * 目录层级变了这里必须跟着改，否则数据目录和前端产物都会指错地方。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..', '..')

// .env 是可选的：缺失或用例不合法都不应该让服务起不来
const ENV_FILE = path.join(ROOT, '.env')
if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE)
  } catch (err) {
    console.warn(`[config] .env 解析失败，已忽略：${(err as Error).message}`)
  }
}

function str(key: string, fallback: string): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

function num(key: string, fallback: number): number {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v !== 'false' && v !== '0'
}

/** 相对路径一律相对仓库根解析，这样在任意 cwd 下启动行为都一致 */
function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p)
}

export const DATA_DIR = resolveFromRoot(str('DATA_DIR', 'app/server/data'))
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
export const DB_FILE = path.join(DATA_DIR, 'app.db')

/**
 * 笔记目录刻意独立于 DATA_DIR：想用网盘同步笔记，把它指向同步盘即可。
 */
export const NOTES_DIR = resolveFromRoot(str('NOTES_DIR', path.join(DATA_DIR, 'notes')))

/** 生产环境下由 Hono 托管的前端产物 */
export const WEB_DIST = path.resolve(ROOT, 'app/web/dist')

export const PORT = num('PORT', 9200)
export const HOST = str('HOST', '0.0.0.0')

/**
 * 允许未登录浏览首页内容（编辑始终需要登录）。
 *
 * 默认**关**：这是个私人导航页，默认就把书签、分组暴露在公网不合适 ——
 * 想让别人看你的导航站时再显式打开。
 */
export const PUBLIC_VIEW = bool('PUBLIC_VIEW', false)
export const REFRESH_DAYS = num('REFRESH_DAYS', 30)

/** 仅在数据库首次初始化时使用；之后改 .env 不再生效 */
export const ADMIN_USERNAME = str('ADMIN_USERNAME', 'admin')
export const ADMIN_PASSWORD = str('ADMIN_PASSWORD', 'admin123')

/** .env 中显式提供的密钥优先，否则首次启动生成并存入数据库 */
export const ENV_JWT_SECRET = process.env.JWT_SECRET || undefined
export const ENV_AGENT_TOKEN = process.env.AGENT_TOKEN || undefined

export const IS_PROD = process.env.NODE_ENV === 'production'

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, UPLOAD_DIR, NOTES_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
