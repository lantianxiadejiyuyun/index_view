import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { DATA_DIR, HOST, IS_PROD, PORT, WEB_DIST, ensureDirs } from './config.js'
import { initDatabase, getSetting } from './db/schema.js'
import { closeDb } from './lib/db.js'
import { prewarmHitokoto } from './lib/hitokoto.js'
import { DEFAULT_WEATHER_CITY, prewarmWeather } from './lib/weather.js'
import { startSubscriptionScheduler } from './lib/subscriptions.js'
import { attachSubscriptionRelayWebSocket } from './lib/subscription-relay-ws.js'
import { authRoutes } from './routes/auth.js'
import { bootstrapRoutes } from './routes/bootstrap.js'
import { faviconRoutes } from './routes/favicon.js'
import { folderRoutes } from './routes/folders.js'
import { importRoutes } from './routes/import.js'
import { nodeRoutes } from './routes/nodes.js'
import { navigationAiRoutes } from './routes/navigation-ai.js'
import { desktopRoutes } from './routes/desktop.js'
import { noteRoutes } from './routes/notes.js'
import { serverRoutes } from './routes/servers.js'
import { settingsRoutes } from './routes/settings.js'
import { subscriptionRoutes } from './routes/subscriptions.js'
import { siteRoutes } from './routes/sites.js'
import { uploadRoutes } from './routes/upload.js'
import { uploadedVideoRoutes } from './routes/uploaded-video.js'
import { vaultRoutes } from './routes/vault.js'
import { widgetRoutes } from './routes/widgets.js'
import { workbenchRoutes } from './routes/workbench.js'
import type { AppEnv } from './types.js'

ensureDirs()
initDatabase()

/**
 * 派生图允许的两种扩展名，按优先级排。
 * Chrome 编得出 WebP 就用它（同画质体积小一截）；Safari 编不出，落成 JPEG。
 */
const DERIVED_EXTENSIONS = ['.webp', '.jpg']

const app = new Hono<AppEnv>()

app.use('*', logger((message, ...rest) => {
  // Client subscription URLs contain bearer credentials; keep them out of logs.
  console.log(message.replace(/(\/api\/subscriptions\/feed\/)[^?\s]+/g, '$1[redacted]'), ...rest)
}))
let stopSubscriptions = () => {}

// ── API ───────────────────────────────────────────────────────
const api = new Hono<AppEnv>()

api.get('/health', (c) =>
  c.json({ ok: true, service: 'home-dashboard', time: new Date().toISOString() }),
)

api.route('/auth', authRoutes)
api.route('/', bootstrapRoutes)
api.route('/', siteRoutes)
api.route('/', folderRoutes)
api.route('/', settingsRoutes)
api.route('/', subscriptionRoutes)
api.route('/', navigationAiRoutes)
api.route('/', desktopRoutes)
api.route('/', uploadRoutes)
api.route('/', vaultRoutes)
api.route('/', noteRoutes)
api.route('/', nodeRoutes)
api.route('/', serverRoutes)
api.route('/', widgetRoutes)
api.route('/', workbenchRoutes)
api.route('/', importRoutes)
// favicon 代理要挂在 /api 下 → /api/favicon。必须在下面的 /api/* 404 兜底之前。
api.route('/', faviconRoutes)

app.route('/api', api)

// 未匹配的 /api/* 一律返回 JSON，避免前端拿到 HTML 解析失败
app.all('/api/*', (c) => c.json({ error: 'not_found', message: '接口不存在' }, 404))

// ── 上传文件 ──────────────────────────────────────────────────
app.route('/', uploadedVideoRoutes)
/**
 * 派生图路由。接受**两种形式**：
 *
 *   /uploads/derived/<名字>.thumb          ← 与编码格式无关的稳定地址
 *   /uploads/derived/<名字>.thumb.webp     ← 带真实扩展名的确切地址（接口返回的就是这种）
 *
 * 第一种是给前端自己推地址用的：Safari 编不出 WebP，它的派生图落成 `.jpg`，
 * 前端要是写死 `.webp` 就会 404，所以给一个格式无关的写法。
 * 第二种是 `/api/uploads` 直接返回的完整文件名，本来由 serveStatic 提供 ——
 * ⚠️ 这个路由注册在 serveStatic **之前**，所以必须把它也放行，
 * 否则带扩展名的地址会在这里吃 400，图整个加载不出来（踩过一次）。
 *
 * 必须注册在 serveStatic 之前，否则会被当成静态文件去找。
 */
app.get('/uploads/derived/:name', (c) => {
  const param = c.req.param('name')
  // basename 之后仍要确认没跑出派生图目录
  if (path.basename(param) !== param) return c.json({ error: 'bad_request' }, 400)

  const m = /^([A-Za-z0-9_-]+)\.(thumb|large)(?:\.(webp|jpg))?$/.exec(param)
  if (!m?.[1] || !m[2]) return c.json({ error: 'bad_request' }, 400)

  const stem = `${m[1]}.${m[2]}`
  // 写明了扩展名就只找那一个；没写就按优先级找实际存在的
  const candidates = m[3] ? [`.${m[3]}`] : DERIVED_EXTENSIONS
  const dir = path.join(DATA_DIR, 'uploads', 'derived')
  const found = candidates
    .map((ext) => ({ ext, file: path.join(dir, stem + ext) }))
    .find((cand) => fs.existsSync(cand.file))

  if (!found) return c.json({ error: 'not_found', message: '派生图不存在' }, 404)

  return new Response(fs.readFileSync(found.file), {
    headers: {
      'content-type': found.ext === '.webp' ? 'image/webp' : 'image/jpeg',
      // 派生图的内容由原图决定，原图不变它就不变
      'cache-control': 'public, max-age=604800',
    },
  })
})

// serveStatic 把「请求路径」直接拼到 root 后面，所以 root 要取 uploads 的父目录，
// 这样 /uploads/xxx.png 正好命中 DATA_DIR/uploads/xxx.png
app.use('/uploads/*', serveStatic({ root: DATA_DIR }))

// favicon 代理的根路径短别名 → /favicon
app.route('/', faviconRoutes)

// ── 前端静态资源 ──────────────────────────────────────────────
const hasWebDist = fs.existsSync(path.join(WEB_DIST, 'index.html'))

if (hasWebDist) {
  app.use('*', serveStatic({ root: WEB_DIST }))
  // SPA 兜底：非静态资源的路径统一返回 index.html，交给前端路由
  app.get('*', (c) => {
    const html = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8')
    return c.html(html)
  })
} else {
  app.get('*', (c) =>
    c.html(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
       <title>前端尚未构建</title>
       <style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e6e9f5;
       display:grid;place-items:center;height:100vh;margin:0}
       code{background:#1b2340;padding:.2em .5em;border-radius:6px}
       .box{max-width:560px;line-height:1.9}</style></head><body><div class="box">
       <h2>前端还没构建</h2>
       <p>后端已经在跑了，但 <code>app/web/dist</code> 不存在。开发时请用：</p>
       <p><code>pnpm dev</code>（前端 5173，API 已代理到本服务）</p>
       <p>生产构建请执行：<code>pnpm build</code></p>
       <p>API 健康检查：<a style="color:#7aa2ff" href="/api/health">/api/health</a></p>
       </div></body></html>`,
    ),
  )
}

// ── 错误处理 ──────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[error]', err)
  if (c.req.path.startsWith('/api/')) {
    return c.json(
      {
        error: 'internal_error',
        message: IS_PROD ? '服务器内部错误' : err.message,
      },
      500,
    )
  }
  return c.text('Internal Server Error', 500)
})

app.notFound((c) => c.json({ error: 'not_found', message: '资源不存在' }, 404))

// ── 启动 ──────────────────────────────────────────────────────

/** 列出内网 IPv4，方便直接判断该用哪个地址访问，也方便配置探针 */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const lan = lanAddresses()
  console.log('')
  console.log('  ┌──────────────────────────────────────────────┐')
  console.log('  │  个人部署首页已启动                          │')
  console.log('  └──────────────────────────────────────────────┘')
  console.log(`  本机   http://127.0.0.1:${info.port}`)
  for (const ip of lan) console.log(`  内网   http://${ip}:${info.port}`)
  if (!hasWebDist) console.log('  ⚠ 前端未构建，当前仅 API 可用')
  console.log('')

  startWidgetWarmup()
  stopSubscriptions = startSubscriptionScheduler()
})
const stopSubscriptionSockets = attachSubscriptionRelayWebSocket(server)

// ── 小组件预热 ────────────────────────────────────────────────

/** 天气缓存 3 小时，所以按同样的节奏去刷；一言的池子刷勤一点，句子才够换 */
const WEATHER_REFRESH_MS = 3 * 60 * 60 * 1000
const HITOKOTO_REFRESH_MS = 60 * 60 * 1000

/**
 * 让小组件的数据提前就位。
 *
 * 天气和一言都依赖外部接口，而首页是「打开就要看到」的场景 ——
 * 等用户来了再去拉，那两个组件就会先空一下。
 * 这里在启动后主动拉一次（落盘缓存，重启也能顶上），并按小时级刷新。
 *
 * 两个 prewarm 函数内部都会先判缓存还新不新，所以定时调用不会白打请求。
 */
function startWidgetWarmup(): void {
  const tick = () => {
    const city = (getSetting('weather_city') ?? '').trim() || DEFAULT_WEATHER_CITY
    prewarmWeather(city, getSetting('weather_provider'))
    prewarmHitokoto()
  }

  // 稍等一下再拉：先让服务能对外响应，别和启动抢网络
  setTimeout(tick, 2000).unref()

  setInterval(() => {
    prewarmWeather(
      (getSetting('weather_city') ?? '').trim() || DEFAULT_WEATHER_CITY,
      getSetting('weather_provider'),
    )
  }, WEATHER_REFRESH_MS).unref()

  setInterval(() => prewarmHitokoto(), HITOKOTO_REFRESH_MS).unref()
}

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[server] 收到 ${signal}，正在关闭…`)
  stopSubscriptions()
  void stopSubscriptionSockets().then(() => {
    server.close(() => {
      closeDb()
      process.exit(0)
    })
  })
  // 兜底：10 秒后强制退出，避免被长连接挂住
  setTimeout(() => process.exit(0), 10_000).unref()
}

/**
 * 绑定失败要立刻退出并说清楚原因。
 *
 * 不处理 'error' 的话，端口被占用时进程会**挂在那里什么都不监听**，
 * 看起来像启动了其实没在服务（实测重启时留下过这种僵尸进程，
 * 而且它不占端口、也不报错，光看进程列表根本发现不了）。
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[server] ✗ 端口 ${PORT} 已被占用。换一个端口（PORT=9300）或先停掉占用它的进程。`,
    )
  } else {
    console.error(`[server] ✗ 启动失败：${err.message}`)
  }
  process.exit(1)
})

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
