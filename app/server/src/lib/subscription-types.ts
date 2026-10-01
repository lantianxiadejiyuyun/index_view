export type SubscriptionUsage = {
  upload: number | null
  download: number | null
  total: number | null
  expires_at: number | null
}

export type ProxyNode = Record<string, unknown> & {
  name: string
  type: string
  server: string
  port: number
}

export type SubscriptionSource = {
  id: number
  name: string
  url: string
  note: string
  enabled: boolean
  refresh_interval_minutes: number
  last_attempt_at: number | null
  last_success_at: number | null
  next_fetch_at: number | null
  last_error: string | null
  proxy_count: number
  usage: SubscriptionUsage | null
  warnings: string[]
  fetching: boolean
  fetch_agent_id: number | null
  fetch_agent_name: string | null
  fetch_status: 'idle' | 'queued' | 'fetching'
  created_at: number
  updated_at: number
}

export type SubscriptionRelayNode = {
  id: number
  name: string
  enabled: boolean
  approved: boolean
  online: boolean
  capable: boolean
  last_seen_at: number | null
  relay_transport: 'wss' | 'https-poll' | null
  relay_connected: boolean
}

export type SubscriptionRules = {
  include: string[]
  exclude: string[]
  protocols: string[]
  name_prefix: string
  append_source: boolean
  deduplicate: boolean
  rules: string[]
}

export type SubscriptionProfile = {
  id: number
  name: string
  note: string
  source_ids: number[]
  rules: SubscriptionRules
  token: string
  enabled: boolean
  created_at: number
  updated_at: number
}

export type ParsedSubscription = { proxies: ProxyNode[]; warnings: string[] }
export type SubscriptionInput = { id: number; name: string; proxies: ProxyNode[] }
export type SubscriptionOutput = {
  content: string
  content_type: string
  proxy_count: number
  warnings: string[]
}
