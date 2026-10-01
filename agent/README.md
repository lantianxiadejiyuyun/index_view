# 内网探针 agent

单文件、零依赖的 Node 探针（当前版本 `1.2.0`）。装在需要被首页「自动发现」的机器上，它会把本机正在监听的
TCP 端口报给主程序，主程序据此补全站点的内网地址（`url_lan` / `lan_port`），
于是首页在内网打开时就能直接走内网链路。

```
主程序 (Node + Hono)  ──GET /api/services──▶  探针 agent（内网，X-Agent-Token）
        ▲                                            │
        └──── 端口扫描：ss / netstat / lsof ◀────────┘
```

---

## 1. 运行

要求 **Node ≥ 22**（用到内置 `WebSocket`、`AbortSignal.timeout`、`fetch` 等），不需要 `npm install` 或安装 WebSocket 客户端依赖。建议使用 Node 22 的维护版本或更新的 LTS；内置 WebSocket 说明见 [Node 官方文档](https://nodejs.org/api/globals.html#class-websocket)。

```bash
# 最简：只给令牌
node agent/node/index.mjs --token=<令牌>

# 常用：换端口 + 指定服务清单
node agent/node/index.mjs --token=<令牌> --port=9201 --config=/etc/agent/services.json
```

Windows PowerShell：

```powershell
node agent\node\index.mjs --token=<令牌> --port=9201
```

令牌获取方式：登录主程序 → 设置页 → 「探针令牌」，或直接调
`GET /api/agent-token`（需要登录）。也可以用环境变量 `AGENT_TOKEN` 代替 `--token`。

> 探针**没有令牌就不启动**，这是刻意的：没有令牌的探针等于对内网公开端口清单。

### 常用参数

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--token=<令牌>` | `AGENT_TOKEN` | **必填**，探针令牌 |
| `--server=<地址>` | `AGENT_SERVER` | **推模式**：主程序地址。给了它就主动上报，不用主程序来连 |
| `--interval=<秒>` | `AGENT_INTERVAL` | 上报间隔，默认 `10`（下限 5） |
| `--key=<路径>` | `AGENT_KEY_FILE` | 专属密钥的存放位置，默认探针同目录的 `agent-key` |
| `--port=<端口>` | `PORT` | 监听端口，默认 `9201` |
| `--host=<地址>` | `HOST` | 绑定地址，默认自动挑第一个内网 IPv4 |
| `--config=<路径>` | `AGENT_CONFIG` | 服务清单路径，默认探针同目录的 `services.json` |
| `--name=<名称>` | `AGENT_NAME` | 首页里显示的节点名，默认主机名 |
| — | `AGENT_DISK_MOUNTS` | 手工指定要上报的盘：`路径` 或 `路径=显示名`，逗号分隔（**容器里跑要用它**，见下文） |
| — | `AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK` | 订阅任务是否允许访问内网 / 保留地址，默认 `false`；仅明确需要时设为 `true` |
| `--probe-all` | — | 对所有扫到的端口都做 HTTP 探活（默认只探常见 Web 端口） |
| `--print-config` | — | 打印一份可直接用的服务清单示例 |
| `-h, --help` | — | 中文帮助 |

---

## 1.5 推模式：探针主动连出去

默认是**拉模式**：探针开个 HTTP 口，主程序定时来拉。
这要求主程序和探针在**同一个网络**里 —— 主程序在公网、探针在 NAT 后面的内网时，
公网那台根本没有路由进来。

这时候用**推模式**：

```bash
node agent/node/index.mjs --token=<令牌> --server=https://nav.example.com --interval=10
```

探针会每 10 秒把指标 `POST` 到 `<主程序>/api/agent/report`，
主程序**自动登记**这个节点（不用手动去面板里加），之后不再需要任何入站端口。

| | 拉模式 | 推模式 |
|---|---|---|
| 谁发起连接 | 主程序 → 探针 | 探针 → 主程序 |
| 网络要求 | 必须互通（同内网） | 探针能出网即可，**可以穿 NAT** |
| 需要开入站端口 | 需要（9201） | **不需要** |
| 自动登记节点 | 手动加 | **自动** |

两种可以**同时用**：加了 `--server=` 之后本机的 HTTP 口照样开着，
同内网的主程序仍然能拉到它。

几点说明：

- **身份标识**取 `/etc/machine-id`（Linux）或主机名（其它平台）的哈希，
  所以同一台机器反复上报只会更新同一条记录，不会每次都新建
- **节点名只在第一次登记时取探针报的**。之后你在面板里改过名就尊重你的，
  不会被上报冲掉
- 超过 **30 秒**没收到上报就判离线（默认 10 秒一推，容两次丢包）
- 上报失败只重试、不退避 —— 间隔本来就短，网络恢复后应当尽快接上。
  日志做了收敛：头两次说清楚，之后每 30 次（约 5 分钟）才提一次

### 密钥与批准（重要）

推模式**不是**拿共享令牌直接上报，而是两步：

```
① 探针拿共享令牌 → POST /api/agent/enroll → 换回一把**专属密钥**
   （存到探针同目录的 agent-key，权限 600）
② 之后每次上报都用这把密钥（X-Agent-Key）
```

**而且新探针默认是「待批准」状态**：管理员要登录主程序 →「服务器面板」→
找到这台 → 点「批准」，上报才会被接收。在那之前探针会一直重试并提示「等待批准」。

为什么这么设计：

- 共享令牌是全局的，**一旦泄露就能冒充任意节点** —— 改成每台一把密钥后，
  冒充需要拿到那一台的密钥
- 但共享令牌仍然能发起 enrollment，所以新密钥**默认不生效**：
  攻击者最多让面板上多出一条「待批准」，拿不到任何东西

> ⚠️ **已批准的节点不能靠这个接口换密钥。** 否则拿到共享令牌的人可以重新
> enrollment 一把新密钥顶掉已批准节点，整套机制就白做了 —— 服务端会返回 409。
> 要换密钥只能管理员在面板上打开该节点、点「重置密钥」（会把节点打回待批准）。

相关文件：

| | |
|---|---|
| 密钥文件 | 探针同目录的 `agent-key`（`--key=<路径>` 可改），权限 600 |
| 服务端存什么 | 只存**哈希**（`sha256`）。服务端只需要「验」，不需要「取回」 |

探针侧的日志长这样：

```
✓ 已领取专属密钥 7hW6wM…（已存到 /opt/home-dashboard-probe/agent-key）
⏳ 等待批准：登录主程序 →「服务器面板」→ 找到这台 → 点「批准」
✓ 已连上主程序，之后每 10 秒上报一次
```

**不需要重启探针** —— 管理员一点批准，下一次上报（最多 10 秒）就带数据上来了。

---

## 1.6 订阅代拉与回传（v1.2.0）

所有升级至 `1.2.0` 的探针都具备通过 WSS 接收订阅任务的能力，但只执行主程序明确分配给本探针的任务。
在主程序「订阅中心」编辑订阅源，选择负责拉取的已批准探针。手动刷新和定时刷新都会按该配置分配任务；
未被选择的探针不会自行访问订阅，也不会自动寻找或接管其他探针的任务。

探针必须配置 `AGENT_SERVER`，保留现有的 `agent-key`，并已在主程序批准。
完成专属密钥鉴权后，探针主动建立到主程序的 WSS 长连接，服务器按配置下发任务；没有任务时只维护心跳。
纯拉模式、没有有效专属密钥或未批准的探针不能接收订阅任务。
现有每 10 秒指标上报和本地端口发现继续独立运行，任务通道断线不会被前端当作指标上报离线。

```text
主程序按订阅源配置 / 到期调度生成任务
    ↕ 探针主动连接 WSS 443，首帧专属密钥认证与心跳
    ↓ WSS 下发分配给该探针的订阅 URL
探针 → 订阅站点 → 原始订阅内容 + subscription-userinfo
    ↑ HTTPS 回传主程序，统一解析、更新缓存、封装输出
```

任务与结果只通过已配置的 `AGENT_SERVER` 交换。公网配置使用 `https://`，探针自动转换为同站点的 `wss://` 任务通道；只有显式配置 HTTP 时才使用 WS，适合本机调试。控制接口不跟随重定向，订阅请求不会携带探针密钥或共享令牌。

`AGENT_SERVER` 只填写站点地址或已经配置好的 API 基路径，不填写 `/api/agent/subscriptions/ws`；探针会追加该路径，并保留原有基路径。例如 `https://nav.example.com/nav` 对应 `wss://nav.example.com/nav/api/agent/subscriptions/ws`，HTTPS 回传也在 `/nav/api/agent/subscriptions/result`。反向代理必须将两种路径一致映射到后端，不能只处理其中之一；此设置不会自动改变网页的部署基路径。地址中不能放用户名密码、查询参数或 fragment。

连接建立后首帧为 `{ type: 'auth', version: 1, agent_id, key }`，密钥不进入 URL。收到 `ready` 才处理 `job`；探针用 `ack` 确认接收，拉取结果通过带 `X-Agent-Key` 的 HTTPS `/api/agent/subscriptions/result` 返回。`ack` 不代表拉取成功。每 25 秒发送 `ping`，服务端回复 `pong`；50 秒没有有效服务端帧便重连。重连按 1 秒起步的指数退避，带 ±25% 随机抖动、最长 30 秒；连接稳定 60 秒后重置退避。

`1.2.0` 不再发送 HTTPS 任务轮询。主服务继续保留 `/api/agent/subscriptions/poll`，供尚未更新的 `1.1.0` 探针每 5 秒查询任务。升级时先更新主服务和反向代理，再逐台替换探针；不要同时启动同一身份的新旧进程。Nginx 的 WSS Upgrade 配置见 [主项目部署示例](../README.md#nginx)。

- 一次只执行一个任务。任务有效期最多 120 秒，持久租约保存在服务器 SQLite，源站拉取总超时 15 秒，控制请求超时 10 秒。
- 断线重连时，服务器可能重发同一任务；探针按任务 ID 去重，重复帧只确认、不重新拉取。去重及待回传内容保存在探针内存，进程重启后不保留；服务端仍校验租约、版本与截止时间，重复或过期结果不更新缓存。
- 失败结果只包含固定错误码及可选 HTTP 状态码，不记录或回传原始异常、订阅 URL、响应内容到日志。
- 回传失败时只保留一份内存结果，最多尝试 4 次，到期丢弃；重试回传不会再次访问订阅站点。进程重启不保留该结果，服务器负责后续重新调度。
- 原始订阅按 Base64 回传，主程序统一解析 YAML / 链接及流量到期信息。压缩响应与解压内容均限制 2 MiB，最多跟随 3 次源站重定向，拒绝 HTTPS 降级到 HTTP，HTTPS 必须通过证书校验。
- 每个源站和跳转目标均重新解析并检查全部 DNS 地址，连接固定到已检查的地址，并保留多地址回退。默认拒绝内网、回环、云元数据及保留地址。
- 只有自建内网订阅或已确认需要接入 TUN fake-IP 的探针，才设置 `AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK=true`；该设置会放宽该探针的订阅目标地址限制，不会自动启用。
- 主程序尚未支持 WSS、反向代理没有转发 Upgrade 或证书异常时，订阅通道按退避重连，指标上报仍独立运行；先检查站点代理配置，再重新拉取。WSS 的连接与认证状态可在订阅中心查看。

升级只需替换 `agent/node/index.mjs` 并重启；Docker 部署在复制新文件后执行 `docker compose up -d --build`。
保持 `/data` 和 `/etc/machine-id` 挂载不变，可保留专属密钥、节点身份及批准状态。

## 2. 接口

| 方法 | 路径 | 鉴权 | 返回 |
|---|---|---|---|
| GET | `/healthz` | 无 | `{ ok: true }` |
| GET | `/api/info` | **无** | `{ name, hostname, version, agent_port, lan_ips, platform, uptime }` |
| GET | `/api/services` | **必需** | `{ services, scanned_at, sources }` |
| GET | `/api/metrics` | **必需** | 见下面的 `ServerMetrics` |

`/api/info` 不鉴权是设计使然：首页要靠它做内网自动发现。因此它**只返回主机级非敏感信息**，
不含服务列表、环境变量、文件路径。`/api/services` 与 `/api/metrics` 必须带请求头：

```
X-Agent-Token: <令牌>
```

`ServerMetrics`（服务器面板用）：

```jsonc
{
  "hostname": "nas",
  "platform": "linux",          // process.platform
  "arch": "x64",
  "release": "6.1.0-13-amd64",  // 内核版本
  "cpu_model": "Intel(R) N100",
  "cpu_cores": 4,
  "cpu_usage": 12.4,            // 0–100；两次采样之间的平均值
  "load": [0.42, 0.55, 0.61],   // 1/5/15 分钟；Windows 上为 null
  "mem_total": 16777216000,     // 字节
  "mem_used": 5368709120,
  "swap_total": 0,              // 不支持时为 0
  "swap_used": 0,
  "uptime": 1048576,            // 系统运行秒数
  "disks": [{ "mount": "/", "total": 500107862016, "used": 214748364800 }],
  "net_rx_rate": 10240,         // 字节/秒；仅 Linux 有，其它平台为 null
  "net_tx_rate": 2048,
  "lan_ips": ["192.168.1.10"],  // 全部非内部 IPv4
  "public_ip": "203.0.113.7",   // 走外部接口查的公网 IP；内网机器查不到为 null
  "collected_at": 1758532800000
}
```

几个口径上的说明：

- **CPU 与网络是差分算出来的**，第一次请求会先等 200ms 采第二次，所以首个响应就能给出真实值；
  两次请求间隔小于 100ms 时直接复用上一次的结果，避免被连续请求刷成抖动。
- **`load` 在 Windows 上恒为 `null`** —— `os.loadavg()` 在 Windows 上只会返回 `[0,0,0]`，
  那是个假值，不如不给。
- **网络速率只有 Linux 支持**（读 `/proc/net/dev`，跳过回环口）。
- **磁盘**用 `fs.statfs` 采集，Linux 下从 `/proc/mounts` 里挑真实块设备（最多 5 个，
  按设备名去重 —— 同一个设备挂到多个路径是常态）。
- **公网 IP 是异步查的**：缓存 30 分钟，过期时先在后台刷新，**本次仍返回旧值**，
  绝不让指标接口为了它挂住。依次尝试 `myip.ipip.net` / `ip.3322.net` /
  `ifconfig.me/ip` / `api.ipify.org`，都失败则缓存 3 分钟后重试。
  探针跑在纯内网、出不了公网时，这一项恒为 `null`，属于预期。

> 采集口径和主服务进程内的那份（`app/server/src/lib/sysinfo.ts`）**必须保持一致**，
> 但两处是独立实现 —— 探针是刻意的零依赖单文件，不能 import 主程序的 TS 代码。
> 改任何一边时记得同步另一边。

`ServiceInfo`：

```jsonc
{
  "name": "Web 应用 (HTTP)",   // 常见端口来自内置映射表，配置清单里可自定义
  "port": 8080,
  "scheme": "http",            // http | https
  "path": "/",                 // 仅清单里声明了 path 时才出现
  "healthy": true,             // true/false/null；null = 该端口不是 HTTP，不适用
  "latency_ms": 12,            // healthy 为 true/false 时有意义
  "process": "node.exe",       // 尽力而为，拿不到就是 null
  "source": "scan"             // scan | config
}
```

`sources` 说明本次数据来源，例如 `["scan"]` / `["scan","config"]` / `["config"]`。

---

## 3. 端口扫描怎么做的

| 平台 | 命令 | 退化方案 |
|---|---|---|
| Linux | `ss -ltnp` | 读 `/proc/net/tcp`、`/proc/net/tcp6`（十六进制解析，状态 `0A` = LISTEN） |
| Windows | `netstat -ano` + `tasklist` 翻进程名 | 不适用 |
| macOS | `lsof -iTCP -sTCP:LISTEN -P -n` | 不适用 |

- 一律用 `execFile`（不是 `exec`），**没有 shell 注入面**，并且带 5 秒超时；
  命令不存在时优雅降级，不会让探针崩溃。
- 扫到的端口用内置「端口 → 服务名」映射表命名（3306 → MySQL、6379 → Redis……），
  命中不了就显示 `端口 12345`。
- 已知是 HTTP 类的端口会并发探一次 `GET /`（超时 1.5 秒，**并发上限 8**），
  记录 `healthy` 与 `latency_ms`；非 HTTP 端口 `healthy` 保持 `null`（表示「不适用」）。
- HTTPS 探活**忽略证书校验**，这样群晖、路由器这类自签证书设备也能正常判活。
- **探针自己的监听端口不会出现在结果里。**
- 结果有 3 秒内存缓存，避免首页连点造成重复全量扫描。

> 性能提示：一次冷扫描（`netstat -ano` + `tasklist`）在端口较多的 Windows 机器上约
> 2–3.5 秒。主程序等待 `/api/services` 的上限是 **5 秒**，默认模式够用；
> 但 `--probe-all` 会把每个端口都探一遍，端口多时可能超过 5 秒导致主程序报
> 「探针不可达」。**端口数多时请不要用 `--probe-all`**，改用 services.json 声明要
> 探活的服务即可。

---

## 4. 服务清单 `services.json`

扫描只能给出「端口 + 猜测的名字」，想要漂亮的名字和正确的路径，就写一份清单：

```json
{
  "services": [
    { "name": "我的博客", "port": 8080, "scheme": "http", "path": "/", "health_path": "/" },
    { "name": "NAS 面板", "port": 5001, "scheme": "https", "path": "/" },
    { "name": "内部 Wiki", "port": 3000, "scheme": "http", "path": "/wiki", "health_path": "/wiki/health" }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 否 | 显示名，缺省用内置映射表的名字 |
| `port` | **是** | 端口，非法条目会被跳过并打印告警 |
| `scheme` | 否 | `http`（默认）或 `https` |
| `path` | 否 | 首页点开图标时拼在地址后面的路径 |
| `health_path` | 否 | 探活用的路径，缺省沿用 `path` 或 `/` |

规则：

- 清单条目 `source` 为 `config`，扫描到的为 `scan`；
- **同名或同端口以清单为准**，扫描结果里重复的会被丢弃，不会出现两条；
- 清单里声明了但实际没在监听的端口**也会返回**（正好用来记录跑在别处的服务），
  `healthy` 会是 `false`；
- 文件不存在**不是错误**，静默进入纯扫描模式。

---

## 5. 安全建议

1. **默认只监听内网网卡**：启动日志会明确打印「仅内网监听」。
   只有在临时排障时才用 `--host=0.0.0.0`，日志里会给出警告。
2. 令牌走 `X-Agent-Token`，用 `crypto.timingSafeEqual` 定长比较（长度不等先挡掉，
   否则该 API 会直接抛错）。
3. 可选来源 IP 白名单：

   ```bash
   AGENT_ALLOW_IPS=192.168.1.10,192.168.1.20 node index.mjs --token=<令牌>
   ```

   设置后只放行这些来源 IP（`/healthz` 除外，方便排障）。注意要把**主程序所在机器的
   内网 IP** 写进去；如果首页会从浏览器直连探针，也要加上访客机器的 IP。
4. **不要把探针端口映射到公网**，也不建议放在反向代理后面暴露。它存在的意义就是内网可见。
5. 轮换令牌：主程序设置页 → 重置探针令牌，然后重启所有探针。

### 放进 Docker（宿主机没有 Node 时用这个）

`agent/` 目录里带了现成的 `Dockerfile` 和 `docker-compose.yml` ——
NAS、路由器这类装不了 Node 的设备直接用这套：

```bash
cd agent
# 先改 docker-compose.yml 里的 AGENT_TOKEN（建议连 AGENT_SERVER / AGENT_NAME 一起改）
docker compose up -d --build
```

镜像基于 `node:24-alpine`，额外装了 `iproute2`：有 `ss` 才能扫出和裸机一致的结果，
没有它会退回读 `/proc/net/tcp` —— 端口照样能扫到，只是 `process` 字段为空。

三个必须注意的点（compose 里都写了注释）：

| 点 | 为什么 |
|---|---|
| `network_mode: host` | 端口扫描读的是**本进程所在网络命名空间**的监听表。桥接网络里只能看到容器自己（通常一个端口都没有），扫出来是空的；网速读 `/proc/net/dev` 同理，桥接网络里那是 veth，不是这台机器的网卡 |
| `/etc/machine-id` 要挂进去 | 探针的 `agent_id` 取它的哈希，而镜像里**没有**这个文件 —— 不挂就会退化成拿 hostname 算，每次重建容器都变成「一台新机器」 |
| `/data` 必须持久化 | `agent-key` 是这台机器的身份证。丢了就得重新 enroll，然后在面板上重新批准一次 |
| `AGENT_DISK_MOUNTS` 要设 | 不设的话磁盘那一栏报的是**容器的**挂载表：`/`、`/data`、`…/overlay2/<hash>/merged`，名字没法看，而且好几项是同一块盘。用法：把宿主机的盘只读挂进来，再用它指定「挂载点=显示名」 |
| `uts: host` | 不共用的话容器 hostname 是容器 ID，面板「主机名」那栏会是一串随机字符 |

`AGENT_DISK_MOUNTS` 的样子（也是 compose 里的默认值）：

```yaml
environment:
  AGENT_DISK_MOUNTS: "/host/etc=系统盘, /host/vol1=数据盘"
volumes:
  - /etc:/host/etc:ro     # /etc 在系统盘上，用它量系统盘就够 —— 不必把 / 整个挂进来
  - /vol1:/host/vol1:ro   # 数据盘：群晖 /volume1、威联通 /share
```

设了它就是**完全替代**自动挑选（不是追加）。路径写错、或者盘没挂进来时，
那一条会被跳过 —— 面板上少一格，而不是报一个假数字。

仓库里带了两份实际在跑的 compose，换机器就复制一份改三处
（`HOST`、`AGENT_NAME`、磁盘挂载 + `AGENT_DISK_MOUNTS`）：

| 文件 | 目标机器 | 差异 |
|---|---|---|
| `agent/docker-compose.yml` | 飞牛 fnOS | 数据盘 `/vol1`，两块盘（系统 + 数据） |
| `agent/docker-compose.ugreen.yml` | 绿联 NAS 型号 | 五个存储空间 `/volume1…5` + eMMC 系统区，共六块 |

> ⚠️ 绿联那台的 **SFTP 是 chroot 到共享目录视图**的：SFTP 里的 `/` 是共享列表
> （`docker`、`同步-固态`、`文件`…），不是真的根目录，`scp` 到 `/volume4/...`
> 这种绝对路径会失败。往那台传文件要么用共享相对路径（`/docker/hd-agent/…`），
> 要么走 `ssh` + base64 写文件。`docker exec` / `docker compose` 在 ssh 里一切正常。

还有一个容易忽略的点：**compose 里的 `HOST` 建议显式填内网 IP**。
探针默认自己挑第一块内网网卡，而 NAS 上通常还有 `docker0`、`veth`、隧道网卡，
挑错就等于内网谁也连不上。填了它，镜像里的健康检查也才知道该连哪儿
（探针绑的是内网 IP、不是回环，健康检查写死 `127.0.0.1` 会一直 unhealthy）。

自检：

```bash
docker compose ps                  # STATUS 里带 (healthy) 就说明 /healthz 通了
docker compose logs -f --tail 50   # 看「已领取专属密钥」→「等待批准」→「已连上主程序」
curl -s http://127.0.0.1:9201/api/info
```

> **不想构建镜像也行**：探针是零依赖单文件，拿官方 node 镜像直接挂文件跑就可以，
> 代价是镜像里没有 `ss`，端口列表不带进程名。
>
> ```yaml
> services:
>   hd-agent:
>     image: node:24-alpine
>     command: ["node", "/app/index.mjs"]
>     network_mode: host
>     restart: unless-stopped
>     environment:
>       AGENT_TOKEN: "令牌"
>       AGENT_SERVER: "https://nav.example.com"
>       AGENT_KEY_FILE: "/data/agent-key"
>     volumes:
>       - ./data:/data
>       - ./index.mjs:/app/index.mjs:ro
> ```

### 放进 systemd（宿主机有 Node）

```ini
# /etc/systemd/system/home-agent.service
[Unit]
Description=Home dashboard LAN agent
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/home-agent/index.mjs --port=9201
Environment=AGENT_TOKEN=把令牌填这里
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now home-agent
```

---

## 6. 自检

```bash
# 活着吗
curl http://192.168.1.5:9201/healthz

# 自动发现用的信息（不需要令牌）
curl http://192.168.1.5:9201/api/info

# 端口清单（需要令牌）
curl -H "X-Agent-Token: <令牌>" http://192.168.1.5:9201/api/services
```

排查思路：

| 现象 | 原因 |
|---|---|
| 启动就退出，提示缺少令牌 | 没传 `--token` 也没设 `AGENT_TOKEN` |
| `/api/services` 返回 401 | 令牌不对，或请求头名字写错（必须是 `X-Agent-Token`） |
| `/api/services` 返回 403 | 开了 `AGENT_ALLOW_IPS` 但没把来源 IP 加进去 |
| 扫描结果为空 | 受限容器里没有 `ss`/`netstat`/`lsof`，改用 `services.json` 清单模式 |
| 首页发现不到探针 | 探针绑的是别的网卡；检查启动日志里的监听地址，必要时 `--host=<内网IP>` |
