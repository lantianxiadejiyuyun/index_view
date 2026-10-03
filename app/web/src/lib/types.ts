/** 与后端契约一一对应的类型定义。改后端接口时同步改这里。 */

export type SessionUser = {
  id: number
  username: string
}

export type Category = {
  id: number
  name: string
  icon: string | null
  sort_order: number
}

export type Folder = {
  id: number
  name: string
  category_id: number | null
  columns: number
  rows: number
  color: string | null
  sort_order: number
}

export type LinkMode = 'auto' | 'public' | 'lan'

export type Site = {
  id: number
  category_id: number | null
  folder_id?: number | null
  title: string
  description: string | null
  url_public: string | null
  url_lan: string | null
  lan_port: number | null
  link_mode: LinkMode
  icon_url: string | null
  icon_text: string | null
  color: string | null
  source: string
  sort_order: number
  clicks: number
}

export type Bootstrap = {
  user: SessionUser | null
  can_edit: boolean
  settings: Record<string, string>
  categories: Category[]
  folders?: Folder[]
  sites: Site[]
}

export type ServiceInfo = {
  name: string
  port: number
  scheme: 'http' | 'https'
  path?: string
  url_lan: string
  healthy: boolean | null
  latency_ms?: number | null
  process?: string | null
  source: 'scan' | 'config'
}

export type AgentNode = {
  id: number
  name: string
  base_url: string
  token: string | null
  services_json: string | null
  last_seen_at: number | null
  enabled: number
  created_at: number
}

export type NoteNode = {
  name: string
  path: string
  type: 'file' | 'dir'
  title?: string
  mtime?: number
  size?: number
  children?: NoteNode[]
}

export type Weather = {
  city: string
  temperature: number
  apparent_temperature: number
  weather_code: number
  description: string
  humidity: number
  wind_speed: number
  is_day: boolean
  updated_at: string
  provider: string
  latitude?: number
  longitude?: number
  timezone?: string
  solar_date?: string
  sunrise?: string | null
  solar_noon?: string | null
  sunset?: string | null
  /** Approximate sea-level solar times calculated for the weather city. */
  solar_source?: 'calculated'
  /** Forecast daily maximum, not a live ultraviolet reading. */
  uv_index?: number | null
  uv_index_kind?: 'daily_max'
  temperature_min?: number | null
  temperature_max?: number | null
  forecast_date?: string
  forecast_provider?: 'open-meteo'
}

export type Hitokoto = {
  text: string
  source: string
  author: string
}

/** 已上传的图片（照片墙用） */
export type UploadItem = {
  id: number
  filename: string
  /** 用户上传时的原文件名；磁盘上存的是随机名，展示用这个 */
  original_name: string | null
  mime: string
  size: number
  created_at: number
  /** 最长边 480 的缩略图；老数据或用 API 直传的图没有，为 null */
  thumb_url: string | null
  /** 最长边 1600 的中等图；原图本来就不大时不会生成 */
  large_url: string | null
}

/**
 * 单台机器的实时指标。字段与探针的 `GET /api/metrics` 完全一致
 * （见 .tmp/servers-spec.md 第 1 节），前端不再做二次改名。
 */
export type ServerMetrics = {
  hostname: string
  platform: string
  arch: string
  release: string
  cpu_model: string
  cpu_cores: number
  /** 0–100；采不到样本时为 null */
  cpu_usage: number | null
  /** 1/5/15 分钟负载；Windows 上恒为 null */
  load: [number, number, number] | null
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  /** 系统运行秒数 */
  uptime: number
  disks: Array<{ mount: string; total: number; used: number }>
  /** 字节/秒；非 Linux 平台没有 /proc/net/dev，为 null */
  net_rx_rate: number | null
  net_tx_rate: number | null
  /** 全部非内部 IPv4 */
  lan_ips: string[]
  /** 走外部接口查到的公网 IP；查不到（内网机器、接口不通）为 null */
  public_ip: string | null
  collected_at: number
}

/** 一台机器的管理面板（宝塔之类）入口与凭据 */
export type PanelCredential = {
  url: string
  user: string
  /** ⚠️ 明文存在自己的库里；界面上默认打码 */
  pass: string
  note: string
}

/**
 * 工作台的一条：要登的后台 / 系统。
 *
 * ⚠️ `password` 是**明文**存的服务端 SQLite（和 agent_token、宝塔凭据一样）。
 * 界面上默认打码；导出数据会把它带出去。
 */
export type WorkbenchItem = {
  id: number
  group_name: string
  title: string
  url: string | null
  /** 这个系统是干什么的 —— 隔几个月回来看，光有名字往往想不起来 */
  purpose: string | null
  username: string | null
  password: string | null
  note: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

/** 服务器面板里的一台机器：本机（同一份采集口径）或一台探针节点 */
export type ServerEntry = {
  id: number | 'local'
  name: string
  kind: 'local' | 'agent'
  /** local 为空串 */
  base_url: string
  online: boolean
  /** 离线原因，在线为 null */
  error: string | null
  metrics: ServerMetrics | null
  /** agent 的最近上报时间；local 为 null */
  last_seen_at: number | null
  /** 用户自己写的备注；本机没有记录，恒为 null */
  note: string | null
  /** 用户自己打的标签，用来分组和筛选；本机恒为空数组 */
  tags: string[]
  /** 管理面板入口；没配时四项都是空串 */
  bt: PanelCredential
  /** local=本机，pulled=面板去连它，pushed=探针主动上报 */
  mode: 'local' | 'pulled' | 'pushed'
  /** 推模式：管理员批准了没。未批准时探针上报会被拒收 */
  approved: boolean
  /** 推模式：探针领过密钥没 */
  has_key?: boolean
}

/** `GET /api/servers` 的响应 */
export type ServersResponse = {
  servers: ServerEntry[]
  collected_at: number
}

export type ApiErrorBody = {
  error?: string
  message?: string
}
