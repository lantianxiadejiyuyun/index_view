/**
 * 建表 / 迁移 / 种子数据。
 *
 * 迁移策略刻意做得很土但很可靠：用 user_version 记录版本号，
 * 顺序执行 MIGRATIONS 里比当前版本新的语句块。低负载自用场景足够了。
 */
import crypto from 'node:crypto'
import { sql } from '../lib/db.js'
import { hashPassword } from '../lib/password.js'
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  ENV_AGENT_TOKEN,
  ENV_JWT_SECRET,
} from '../config.js'

type Migration = { version: number; name: string; up: string; rebuildReferencedTable?: boolean }

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE refresh_tokens (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT    NOT NULL UNIQUE,
        ua         TEXT,
        ip         TEXT,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);
      CREATE INDEX idx_refresh_hash ON refresh_tokens(token_hash);

      CREATE TABLE categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        icon       TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sites (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        title       TEXT    NOT NULL,
        description TEXT,
        url_public  TEXT,
        url_lan     TEXT,
        lan_port    INTEGER,
        link_mode   TEXT    NOT NULL DEFAULT 'auto',
        icon_url    TEXT,
        icon_text   TEXT,
        color       TEXT,
        source      TEXT    NOT NULL DEFAULT 'manual',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        clicks      INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_sites_category ON sites(category_id);
      CREATE INDEX idx_sites_sort ON sites(category_id, sort_order);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE uploads (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        filename   TEXT    NOT NULL,
        mime       TEXT,
        size       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE agent_nodes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        base_url      TEXT    NOT NULL UNIQUE,
        token         TEXT,
        services_json TEXT,
        last_seen_at  INTEGER,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'uploads-original-name',
    up: `
      ALTER TABLE uploads ADD COLUMN original_name TEXT;
    `,
  },
  {
    version: 3,
    name: 'nodes-note-and-tags',
    up: `
      -- 服务器面板用：note 是自由文本备注，tags 是 JSON 数组字符串
      -- （存 JSON 而不是关联表：标签就十来个短词，单独建表反而要多一次 join 和一套增删接口）
      ALTER TABLE agent_nodes ADD COLUMN note TEXT;
      ALTER TABLE agent_nodes ADD COLUMN tags TEXT;
    `,
  },
  {
    version: 4,
    name: 'wallpaper-per-theme',
    up: `
      -- 壁纸从「一套」拆成「浅色一套 + 深色一套」。
      --
      -- 老库里的 wallpaper_type / wallpaper_value 同时复制给两套 —— 这样升级完
      -- 不管当前是深色还是浅色，看到的还是原来那张壁纸，不会突然变样。
      -- 新库这两行 SELECT 查不到东西，什么都不插，随后 seedSettings() 会填默认值。
      INSERT OR IGNORE INTO settings (key, value)
        SELECT 'wallpaper_light_type', value FROM settings WHERE key = 'wallpaper_type';
      INSERT OR IGNORE INTO settings (key, value)
        SELECT 'wallpaper_light_value', value FROM settings WHERE key = 'wallpaper_value';
      INSERT OR IGNORE INTO settings (key, value)
        SELECT 'wallpaper_dark_type', value FROM settings WHERE key = 'wallpaper_type';
      INSERT OR IGNORE INTO settings (key, value)
        SELECT 'wallpaper_dark_value', value FROM settings WHERE key = 'wallpaper_value';
    `,
  },
  {
    version: 5,
    name: 'nodes-panel-credential',
    up: `
      -- 每台服务器的「管理面板」入口：地址、账号、密码、备注。
      -- 存成一个 JSON 字段而不是四列：这四项永远是一起读写的，
      -- 而且将来想再加一项（比如端口、安全入口路径）不用再迁移一次。
      ALTER TABLE agent_nodes ADD COLUMN bt_json TEXT;
    `,
  },
  {
    version: 6,
    name: 'uploads-derivatives',
    up: `
      -- 派生图文件名。图片是浏览器端缩好的（服务端不做图片处理，
      -- 那需要 sharp 这种原生依赖，会把「零依赖单文件」的设计破坏掉）。
      -- 老数据这两列为空，前端会回退到原图。
      ALTER TABLE uploads ADD COLUMN thumb TEXT;
      ALTER TABLE uploads ADD COLUMN large TEXT;
    `,
  },
  {
    version: 7,
    name: 'workbench',
    up: `
      -- 工作台：和首页图标墙类似，但每一条还能记「用途 / 账号 / 密码 / 备注」，
      -- 面向的是「一堆后台要登」这种场景，所以是单独一张表而不是塞进 sites。
      --
      -- 分组直接用字符串，不另建 groups 表：
      -- 这里的分组就是「生产后台 / 财务系统」这种十来个固定标签，
      -- 单独建表要多一次 join、多一套增删接口，改个名还要跨表更新。
      -- 想改分组名时直接批量改 group_name 即可（接口里就有）。
      CREATE TABLE workbench_items (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        group_name TEXT    NOT NULL DEFAULT '',
        title      TEXT    NOT NULL,
        url        TEXT,
        purpose    TEXT,
        username   TEXT,
        password   TEXT,
        note       TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_workbench_group ON workbench_items(group_name);
    `,
  },
  {
    version: 8,
    name: 'nodes-push-report',
    up: `
      -- 推模式：探针主动连出来上报，而不是等面板去连它。
      --
      -- 为什么需要：探针常常在 NAT 后面（家庭/公司内网），公网那台导航根本没有
      -- 路由进去，只能反过来让探针往外连。
      --
      -- agent_id 是探针自报的稳定标识（取机器码，取不到就用主机名），
      -- 面板靠它在多次上报之间认出「还是那台机器」，从而 upsert 而不是每次新建。
      --
      -- report_json 存最近一次上报的指标原文。存库而不是只放内存：
      -- 主程序重启后不该把所有推模式节点的卡片清空。
      ALTER TABLE agent_nodes ADD COLUMN agent_id TEXT;
      ALTER TABLE agent_nodes ADD COLUMN report_json TEXT;
    `,
  },
  {
    version: 9,
    name: 'nodes-per-agent-key',
    up: `
      -- 每台探针一把专属密钥，替掉「所有探针共用一个令牌」。
      --
      -- 流程：探针拿共享令牌去 /api/agent/enroll 换一把专属密钥（只回传一次），
      -- 之后上报都用这把密钥；管理员在面板上**批准**之前，上报一律拒收。
      --
      -- 存哈希而不是明文：服务端只需要「验」，不需要「取回」，
      -- 库被看到也不至于直接拿到能冒充的凭据（和密码一个道理）。
      --
      -- approved 只管推模式节点 —— 拉模式节点是管理员手动建的，本身就是可信的。
      --
      -- 已有的推模式节点一律置为未批准：升级后需要管理员**主动确认一次**，
      -- 这正是这个改动的意义所在，不能默认继承一个「已信任」状态。
      ALTER TABLE agent_nodes ADD COLUMN agent_key_hash TEXT;
      ALTER TABLE agent_nodes ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
      UPDATE agent_nodes SET approved = 0 WHERE agent_id IS NOT NULL;
    `,
  },
  {
    version: 10,
    name: 'password-vault',
    up: `
      -- 密码管理器扩展的**密文保险库**。
      --
      -- 服务端是零知识的：blob 是扩展在本地用主密码派生的 vaultKey 加密出来的，
      -- 主密码与 vaultKey 都不上传，所以这份数据服务端自己也解不开 ——
      -- 拖库只能拿到密文。authKey（派生自同一条主密码的另一把钥匙）才是用来登录的。
      --
      -- version 用来做乐观并发：扩展带上 base_version，对不上就 409，
      -- 由用户决定用哪边 —— 密码数据上没有「智能合并」，静默选一边等于吃掉另一边的改动。
      --
      -- per user：主站是多用户表结构（实际单管理员），索引跟着 user_id 走。
      CREATE TABLE vaults (
        user_id    INTEGER PRIMARY KEY,
        version    INTEGER NOT NULL DEFAULT 0,
        blob       TEXT,
        updated_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 11,
    name: 'clash-subscriptions',
    up: `
      CREATE TABLE subscription_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        refresh_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (refresh_interval_minutes BETWEEN 5 AND 10080),
        revision INTEGER NOT NULL DEFAULT 1,
        fetch_revision INTEGER NOT NULL DEFAULT 0,
        proxy_count INTEGER NOT NULL DEFAULT 0,
        proxies_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT,
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        next_fetch_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_subscription_sources_user ON subscription_sources(user_id, id);
      CREATE INDEX idx_subscription_sources_due ON subscription_sources(enabled, next_fetch_at);

      CREATE TABLE subscription_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        rules_json TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_subscription_profiles_user ON subscription_profiles(user_id, id);
    `,
  },
  {
    version: 12,
    name: 'subscription-agent-relay',
    up: `
      -- Keep the selected id after deleting a node: a missing relay must never
      -- silently send the subscription through the server's own network.
      ALTER TABLE subscription_sources ADD COLUMN fetch_agent_id INTEGER;
      ALTER TABLE agent_nodes ADD COLUMN relay_seen_at INTEGER;
      CREATE TABLE subscription_fetch_jobs (
        id TEXT PRIMARY KEY,
        source_id INTEGER NOT NULL UNIQUE REFERENCES subscription_sources(id) ON DELETE CASCADE,
        agent_id INTEGER NOT NULL,
        agent_key_hash TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        fetch_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'leased')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_subscription_jobs_agent ON subscription_fetch_jobs(agent_id, state, created_at);
      CREATE INDEX idx_subscription_jobs_expiry ON subscription_fetch_jobs(expires_at);
      CREATE TRIGGER subscription_relay_node_changed AFTER UPDATE OF enabled, approved, agent_key_hash ON agent_nodes
      WHEN NEW.enabled IS NOT OLD.enabled OR NEW.approved IS NOT OLD.approved OR NEW.agent_key_hash IS NOT OLD.agent_key_hash
      BEGIN
        UPDATE subscription_sources SET last_error = '探针授权或启用状态已变更，请确认探针状态后重新拉取',
          next_fetch_at = CASE WHEN enabled = 1 THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) + refresh_interval_minutes * 60000 ELSE NULL END
          WHERE id IN (SELECT source_id FROM subscription_fetch_jobs WHERE agent_id = OLD.id);
        DELETE FROM subscription_fetch_jobs WHERE agent_id = OLD.id;
        UPDATE agent_nodes SET relay_seen_at = NULL WHERE id = OLD.id AND NEW.agent_key_hash IS NOT OLD.agent_key_hash;
      END;
      CREATE TRIGGER subscription_relay_node_deleted BEFORE DELETE ON agent_nodes
      BEGIN
        UPDATE subscription_sources SET last_error = '指定探针已删除，请重新选择拉取位置',
          next_fetch_at = CASE WHEN enabled = 1 THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) + refresh_interval_minutes * 60000 ELSE NULL END
          WHERE fetch_agent_id = OLD.id;
        DELETE FROM subscription_fetch_jobs WHERE agent_id = OLD.id;
      END;
    `,
  },
  {
    version: 13,
    name: 'independent-device-sessions',
    up: `
      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client TEXT NOT NULL DEFAULT 'web' CHECK (client IN ('web', 'extension')),
        ua TEXT,
        ip TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id, revoked_at, expires_at);
      ALTER TABLE refresh_tokens ADD COLUMN session_id TEXT REFERENCES auth_sessions(id) ON DELETE CASCADE;
      ALTER TABLE refresh_tokens ADD COLUMN replacement_hash TEXT;
      CREATE INDEX idx_refresh_session ON refresh_tokens(session_id);
      -- Preserve every live v12 cookie. Its hash supplies a stable, opaque ID;
      -- previously revoked tokens cannot identify or revoke another device.
      INSERT INTO auth_sessions (id, user_id, ua, ip, created_at, last_seen_at, expires_at)
        SELECT substr(token_hash, 1, 32), user_id, substr(ua, 1, 512), substr(ip, 1, 128),
          created_at, created_at, expires_at
        FROM refresh_tokens WHERE revoked_at IS NULL
          AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER);
      UPDATE refresh_tokens SET session_id = substr(token_hash, 1, 32)
        WHERE revoked_at IS NULL AND EXISTS (
          SELECT 1 FROM auth_sessions WHERE id = substr(refresh_tokens.token_hash, 1, 32)
        );
    `,
  },
  {
    version: 14,
    name: 'custom-sized-bookmark-folders',
    up: `
      CREATE TABLE folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        columns INTEGER NOT NULL DEFAULT 2 CHECK (columns BETWEEN 1 AND 4),
        rows INTEGER NOT NULL DEFAULT 2 CHECK (rows BETWEEN 1 AND 3),
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_folders_category ON folders(category_id, sort_order);
      ALTER TABLE sites ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
      CREATE INDEX idx_sites_folder ON sites(folder_id, sort_order);
    `,
  },
  {
    version: 15,
    name: 'unrestricted-folder-dimensions',
    rebuildReferencedTable: true,
    up: `
      CREATE TABLE folders_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        columns INTEGER NOT NULL DEFAULT 2 CHECK (typeof(columns) = 'integer' AND columns BETWEEN 1 AND 9007199254740991),
        rows INTEGER NOT NULL DEFAULT 2 CHECK (typeof(rows) = 'integer' AND rows BETWEEN 1 AND 9007199254740991),
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO folders_next (id, name, category_id, columns, rows, color, sort_order, created_at, updated_at)
        SELECT id, name, category_id, columns, rows, color, sort_order, created_at, updated_at FROM folders;
      -- Preserve the high-water mark even when the most recent folder was deleted.
      UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'folders'), 0))
        WHERE name = 'folders_next';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'folders_next', seq FROM sqlite_sequence WHERE name = 'folders'
          AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'folders_next');
      DROP TABLE folders;
      ALTER TABLE folders_next RENAME TO folders;
      CREATE INDEX idx_folders_category ON folders(category_id, sort_order);
    `,
  },
  {
    version: 16,
    name: 'subscription-ai-settings',
    up: `
      CREATE TABLE subscription_ai_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'openai-compatible')),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key_encrypted TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
  },
]
export const DEFAULT_SETTINGS: Record<string, string> = {
  site_title: '我的导航',
  site_subtitle: '',
  search_engine: 'bing',
  custom_engines: '[]',
  // 壁纸分两套：浅色主题一套、深色主题一套，切主题时自动换。
  // 默认给浅色配「素白」、深色配「极光」，两套都是开箱即看的。
  wallpaper_light_type: 'gradient', // gradient | color | image | url
  wallpaper_light_value: 'paper',
  wallpaper_dark_type: 'gradient',
  wallpaper_dark_value: 'aurora',
  wallpaper_blur: '0',
  wallpaper_dim: '28',
  theme: 'auto', // auto | light | dark
  card_size: 'md', // sm | md | lg
  grid_gap: 'md',
  glass: 'md',
  show_clock: 'true',
  show_greeting: 'true',
  show_weather: 'true',
  show_hitokoto: 'true',
  // 工作台入口小组件。工作台本身是独立页面，这里只控制首页上那颗入口要不要出现
  show_workbench: 'true',
  // 压在壁纸上的文字颜色：auto 按壁纸明暗采样，black / white 强制固定
  tone_clock: 'auto',
  tone_heading: 'auto',
  tone_page_title: 'auto',
  weather_city: '',
  weather_provider: 'china',
  open_in_new_tab: 'true',
  agent_ports: '9201',
  // 默认关：新装的实例先要求登录，公开浏览要显式打开
  public_view: 'false',
  // 服务器面板里「本机」的备注与标签。
  // 本机在 agent_nodes 里没有记录，所以只能存在设置里
  local_note: '',
  local_tags: '[]',
  // 本机的管理面板入口（JSON），结构同 agent_nodes.bt_json
  local_bt: '',
}

function getUserVersion(): number {
  const row = sql.get<{ user_version: number }>('PRAGMA user_version')
  return Number(row?.user_version ?? 0)
}

function setUserVersion(v: number): void {
  // PRAGMA 不支持参数绑定，这里的值来自内部常量，没有注入风险
  sql.exec(`PRAGMA user_version = ${Math.floor(v)}`)
}

function migrate(): void {
  const current = getUserVersion()
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  )
  if (pending.length === 0) return

  for (const m of pending) {
    // SQLite ignores foreign_keys changes inside a transaction. Rebuilding a
    // referenced table with it enabled would detach every sites.folder_id.
    const restoreForeignKeys = m.rebuildReferencedTable
      ? Number(sql.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys ?? 0)
      : null
    if (m.rebuildReferencedTable) sql.exec('PRAGMA foreign_keys = OFF')
    try {
      if (m.rebuildReferencedTable && sql.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys !== 0) {
        throw new Error(`Cannot disable foreign keys for migration v${m.version}`)
      }
      sql.tx(() => {
        sql.exec(m.up)
        if (m.rebuildReferencedTable && sql.all('PRAGMA foreign_key_check').length > 0) {
          throw new Error(`Foreign key validation failed for migration v${m.version}`)
        }
        setUserVersion(m.version)
      })
    } finally {
      if (restoreForeignKeys !== null) {
        sql.exec(`PRAGMA foreign_keys = ${restoreForeignKeys ? 'ON' : 'OFF'}`)
        if (Number(sql.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys) !== restoreForeignKeys) {
          throw new Error(`Cannot restore foreign keys after migration v${m.version}`)
        }
      }
    }
    console.log(`[db] 迁移完成 v${m.version} ${m.name}`)
  }
}

function getSetting(key: string): string | undefined {
  return sql.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value
}

function putSetting(key: string, value: string): void {
  sql.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  )
}

/**
 * 密钥优先取 .env，否则首次生成后落库。
 * 落库而不是写 .env，是为了在只读文件系统的容器里也能正常工作。
 */
function ensureSecret(key: string, envValue: string | undefined, bytes = 48): string {
  if (envValue) return envValue
  const existing = getSetting(key)
  if (existing) return existing
  const generated = crypto.randomBytes(bytes).toString('base64url')
  putSetting(key, generated)
  console.log(`[db] 已生成 ${key}（存于数据库，可在设置页查看/重置）`)
  return generated
}

function seedSettings(): void {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const row = sql.get('SELECT 1 AS x FROM settings WHERE key = ?', k)
    if (!row) putSetting(k, v)
  }
}

function seedAdmin(): void {
  const count = sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0
  if (count > 0) return
  const t = Date.now()
  sql.run(
    'INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ADMIN_USERNAME,
    hashPassword(ADMIN_PASSWORD),
    t,
    t,
  )
  console.log(`[db] 已创建管理员账号：${ADMIN_USERNAME}`)
  if (ADMIN_PASSWORD === 'admin123') {
    console.warn('[db] ⚠ 正在使用默认密码 admin123，请登录后立刻在设置页修改')
  }
}

function seedDemoContent(): void {
  const count = sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM sites')?.n ?? 0
  if (count > 0) return
  // Empty folders/groups are intentional content too. Restarting must not add
  // demo bookmarks into a freshly organized workspace with no sites yet.
  const containers = sql.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM categories) + (SELECT COUNT(*) FROM folders) AS n')?.n ?? 0
  if (containers > 0) return

  const t = Date.now()
  const groups: Array<{ name: string; icon: string; sites: Array<[string, string, string]> }> = [
    {
      name: '常用',
      icon: 'star',
      sites: [
        ['GitHub', 'https://github.com', '代码托管'],
        ['Bilibili', 'https://www.bilibili.com', ''],
        ['知乎', 'https://www.zhihu.com', ''],
      ],
    },
    {
      name: '工具',
      icon: 'wrench',
      sites: [
        ['DeepSeek', 'https://chat.deepseek.com', ''],
        ['Excalidraw', 'https://excalidraw.com', '在线白板'],
      ],
    },
  ]

  sql.tx(() => {
    groups.forEach((g, gi) => {
      const { lastInsertRowid: catId } = sql.run(
        'INSERT INTO categories (name, icon, sort_order, created_at) VALUES (?, ?, ?, ?)',
        g.name,
        g.icon,
        gi,
        t,
      )
      g.sites.forEach(([title, url, desc], si) => {
        sql.run(
          `INSERT INTO sites (category_id, title, description, url_public, link_mode,
                              source, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'auto', 'manual', ?, ?, ?)`,
          catId,
          title,
          desc || null,
          url,
          si,
          t,
          t,
        )
      })
    })
  })
  console.log('[db] 已写入示例分组与图标')
}

export type Secrets = { jwtSecret: string; agentToken: string }

let secrets: Secrets | null = null

export function initDatabase(): Secrets {
  migrate()
  seedSettings()
  seedAdmin()
  seedDemoContent()

  const jwtSecret = ensureSecret('jwt_secret', ENV_JWT_SECRET)
  const agentToken = ensureSecret('agent_token', ENV_AGENT_TOKEN, 32)
  secrets = { jwtSecret, agentToken }
  return secrets
}

export function getSecrets(): Secrets {
  if (!secrets) {
    // 正常情况下 initDatabase() 已在启动时调用过
    secrets = {
      jwtSecret: getSetting('jwt_secret') ?? '',
      agentToken: getSetting('agent_token') ?? '',
    }
  }
  return secrets
}

export { getSetting, putSetting }
