/**
 * 常见端口 → 服务名映射。
 *
 * 为什么单独抽一个文件：探针（`agent/node/index.mjs`）和服务端都需要这张表。
 * 探针是「零依赖单文件」，不能 import TS 代码，所以两边各存一份**等价**的表，
 * 改动时请同步修改 `agent/node/index.mjs` 顶部的 SERVICE_MAP。
 *
 * scheme 表示「这个端口大概率是 HTTP/HTTPS 服务」：
 *   - 有 scheme → 探针会去 HEAD/GET 探活，服务端也据此推断内网地址
 *   - 无 scheme → 纯 TCP 服务，healthy 用 null 表示「不适用」而不是失败
 */

export type PortService = {
  name: string
  scheme?: 'http' | 'https'
}

const M = (name: string, scheme?: 'http' | 'https'): PortService =>
  scheme ? { name, scheme } : { name }

/** 键是端口号，值是推断出的服务名与协议 */
export const PORT_SERVICES: Record<number, PortService> = {
  21: M('FTP'),
  22: M('SSH'),
  23: M('Telnet'),
  25: M('SMTP'),
  53: M('DNS'),
  80: M('Web (HTTP)', 'http'),
  110: M('POP3'),
  111: M('rpcbind'),
  135: M('Windows RPC'),
  139: M('SMB (NetBIOS)'),
  143: M('IMAP'),
  161: M('SNMP'),
  389: M('LDAP'),
  443: M('Web (HTTPS)', 'https'),
  445: M('SMB 文件共享'),
  465: M('SMTPS'),
  514: M('Syslog'),
  587: M('SMTP (提交)'),
  631: M('CUPS 打印服务', 'http'),
  873: M('rsync'),
  993: M('IMAPS'),
  995: M('POP3S'),
  1080: M('代理 (SOCKS)'),
  1433: M('SQL Server'),
  1521: M('Oracle'),
  1883: M('MQTT'),
  2049: M('NFS'),
  2181: M('ZooKeeper'),
  2375: M('Docker API', 'http'),
  2376: M('Docker API (TLS)', 'https'),
  3000: M('Node 应用', 'http'),
  3001: M('Node 应用', 'http'),
  3002: M('Node 应用', 'http'),
  3003: M('Node 应用', 'http'),
  3128: M('代理 (HTTP)'),
  3306: M('MySQL'),
  3389: M('远程桌面 (RDP)'),
  4369: M('Erlang EPMD'),
  5000: M('Synology DSM / Web 应用', 'http'),
  5001: M('Synology DSM (HTTPS)', 'https'),
  5044: M('Logstash Beats'),
  5173: M('Vite 开发服务器', 'http'),
  5432: M('PostgreSQL'),
  5601: M('Kibana', 'http'),
  5672: M('RabbitMQ'),
  5900: M('VNC'),
  5984: M('CouchDB', 'http'),
  6379: M('Redis'),
  6443: M('Kubernetes API', 'https'),
  7000: M('Cassandra'),
  8000: M('Web 应用', 'http'),
  8006: M('Proxmox VE', 'https'),
  8080: M('Web 应用 (HTTP)', 'http'),
  8081: M('Web 应用 (HTTP)', 'http'),
  8086: M('InfluxDB', 'http'),
  8088: M('Web 应用 (HTTP)', 'http'),
  8090: M('Web 应用 (HTTP)', 'http'),
  8123: M('Home Assistant', 'http'),
  8161: M('ActiveMQ 控制台', 'http'),
  8200: M('Vault', 'http'),
  8388: M('代理 (Shadowsocks)'),
  8443: M('Web 应用 (HTTPS)', 'https'),
  8500: M('Consul', 'http'),
  8848: M('Nacos', 'http'),
  8888: M('Web 应用 / Jupyter', 'http'),
  9000: M('Web 应用 / Portainer', 'http'),
  9001: M('Web 应用 / Portainer (HTTPS)', 'https'),
  9090: M('Prometheus / Cockpit', 'http'),
  9091: M('Transmission', 'http'),
  9092: M('Kafka'),
  9200: M('Elasticsearch / Web 服务', 'http'),
  9300: M('Elasticsearch (节点通信)'),
  9418: M('Git 协议'),
  9443: M('Web 应用 (HTTPS)', 'https'),
  11211: M('Memcached'),
  11434: M('Ollama', 'http'),
  15672: M('RabbitMQ 管理台', 'http'),
  16379: M('Redis (集群总线)'),
  25565: M('Minecraft 服务器'),
  27017: M('MongoDB'),
  32400: M('Plex Media Server', 'http'),
  50000: M('Jenkins Agent'),
}

/**
 * 端口对应的服务名，命中不了就退化成 `端口 12345`。
 * 这是给 UI 直接显示的字符串，不要返回空串。
 */
export function guessServiceName(port: number): string {
  if (!Number.isFinite(port)) return '未知服务'
  return PORT_SERVICES[Math.trunc(port)]?.name ?? `端口 ${Math.trunc(port)}`
}

/** 端口推断出的协议；null 表示「不像 HTTP 服务」 */
export function guessScheme(port: number): 'http' | 'https' | null {
  if (!Number.isFinite(port)) return null
  return PORT_SERVICES[Math.trunc(port)]?.scheme ?? null
}
