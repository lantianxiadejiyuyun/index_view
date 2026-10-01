# Clash 订阅中心

订阅中心位于 `/subscriptions`，需要登录。它负责拉取和重新生成订阅配置，不运行代理内核，也不修改主机代理设置。

## 使用流程

1. 新建订阅源，填写名称、完整 HTTP(S) URL、备注和刷新间隔，并选择「服务器直接拉取」或指定探针。URL 中的查询参数会原样保留。
2. 点击「拉取」或等待服务端定时任务，查看节点数量、最近成功时间及上游提供的流量和到期信息。
3. 新建封装配置并选择一个或多个来源，设置筛选、命名、去重和路由规则。
4. 预览生成结果及兼容性提示，复制所需格式的订阅地址到客户端。

源备注和封装备注分别保存，方便区分来源用途与不同客户端配置。备注不会成为节点密码的一部分。

## 到期与流量

从上游响应的 `subscription-userinfo` 头读取 `upload`、`download`、`total`（字节）和 `expire`（Unix 秒）。内部的 `expires_at` 使用毫秒，前端按服务端时间校准后显示倒计时。

- 上传和下载信息都存在时，已用流量为两者之和；总额也已知时才计算剩余流量。
- `total=0` 表示不限流量，`expire=0` 表示长期有效。
- 字段缺失或无效时显示「未提供」，不会据此判定订阅已用完或已过期。
- 这些信息随上游成功拉取更新，不代表实时计费数据。多个来源分别显示，封装不会把不同服务商的配额冒充成同一个套餐。

仅使用一个来源的客户端订阅会通过 `Subscription-Userinfo` 响应头透传缓存中的有效数字字段，方便客户端显示流量与到期信息；多个来源不会合并或汇总该响应头。

## 定时拉取和缓存

每个源默认每 60 分钟刷新一次，可设置为 5–10080 分钟。调度在 Node.js 进程内运行，每 10 秒检查到期任务。服务器直连最多同时拉取 3 个来源；探针来源按所选探针分别排队，每台探针一次执行一个任务。同一来源的并发刷新会合并，不重复创建任务。

新建的启用源会等待最近一次调度。下次执行时间保存在 SQLite 中，重启后继续处理到期任务；服务器进程停止时不执行任务。暂停来源只暂停定时更新，已有缓存仍可供封装使用，手动单源拉取仍然可用。

失败会记录原因，保留之前有效的节点和流量信息，并在下一个刷新周期重试。编辑 URL 会清除旧地址的缓存；迟到的旧请求不会覆盖新配置。客户端读取封装订阅只使用缓存，不会触发上游请求。

## 探针代拉与回传

所有升级至 `1.2.0` 的探针都具备通过 WSS 接收订阅任务的能力；实际执行哪些任务完全由服务器的订阅源配置决定。选择某个探针后，手动刷新和定时刷新都交给该探针。服务器只向被指定的探针提供对应订阅 URL，不广播订阅链接，也不会自动让其他探针接管任务。旧版 `1.1.0` 的 HTTPS 轮询仍受支持，便于分批升级。

1. 在能够访问订阅站点的机器上升级探针，并配置 `AGENT_SERVER` 指向本站。保留原有专属密钥文件和节点身份，完成主程序的批准。
2. 探针完成专属密钥认证并建立 WSS 连接后，会登记订阅回传能力。在订阅源的「拉取方式」中选择该探针，确认显示「WSS 已连接」，保存后点击「立即拉取」。
3. 页面依次显示等待探针、正在拉取及完成状态。探针取得原始订阅内容和 `subscription-userinfo` 后回传，服务器统一解析节点、流量和到期信息，更新现有缓存与封装输出。

新版探针主动连接站点的 `wss://主机/api/agent/subscriptions/ws`，由服务器即时下发任务；取得订阅后仍通过 HTTPS `/api/agent/subscriptions/result` 回传。使用同一站点的 443 端口，不需要在探针上开放额外入站端口，可在 NAT 后运行。专属密钥仅放在连接建立后的首个认证帧中，不放入 URL。`1.2.0` 不再调用轮询接口；`1.1.0` 继续每 5 秒通过 HTTPS 领取任务。指标上报与订阅任务通道独立运行，WSS 断开不等于指标上报已停止。

新选择必须是已批准、已启用且有专属密钥的推送型探针。纯拉模式探针需要先配置主动上报；尚无订阅能力的旧版探针可以被选择，但执行时会提示升级。尚未登记回传能力，或最近 90 秒没有订阅通道活动时，本次尝试记录明确错误；升级并连接后可手动重试，或等待下一次定时尝试。WSS 刚断开但最近 90 秒仍有订阅通道活动时，可入队等待重连，任务截止时间仍为入队后 120 秒。页面将节点心跳与任务通道分别展示：WSS 已连接、旧版 HTTPS 轮询、待连接；旧服务器未提供通道字段时显示状态未知，不据此误判离线。

服务器将任务保存在 SQLite 中，每个来源最多一项待处理任务。任务从入队起有效 120 秒，派发时原子领取唯一租约；WSS 断线重连时可重发同一租约，探针按任务 ID 去重，接收确认不代表拉取成功。每台探针一次执行一个任务。探针进程重启会丢失本地内存去重与待回传内容，但服务端仍校验持久任务版本和有效期，重复结果不能覆盖已处理结果。任务超时、源站拉取失败或回传解析失败都保留原有效缓存，并安排下一轮。每台探针的源站拉取总时限为 15 秒；回传重试只发送已取得的结果，不再次请求上游。

探针每 25 秒通过 WSS 发送应用心跳，50 秒未收到有效服务端帧时重连。重连采用带随机抖动的指数退避，最长 30 秒；稳定连接 60 秒后重置退避。更新反向代理后可从页面检查 WSS 状态，不能仅根据服务器面板上的指标更新判断订阅任务通道已可用。

修改来源、暂停定时、切换探针或删除来源都会撤销该来源正在排队或执行的旧任务。停用探针、撤销批准、重置密钥也会撤销旧任务，重新启用后不能继续提交旧结果。服务器校验来源版本、任务版本、节点归属、密钥与截止时间，重复或迟到的结果不会覆盖数据。

删除或停用探针后，来源保留原探针选择；仍可保存备注或暂停定时。服务器不会自动回退直连。要换到其他探针或恢复服务器直连，需明确修改「拉取方式」。切换拉取位置保留旧缓存，修改订阅 URL 才清除旧地址缓存。

探针启动、更新及网络限制详见 [探针说明](../../agent/README.md)。

## 输入与输出

接受带 `proxies` 的 Clash / Mihomo YAML（包括 proxy-provider 内容）、通用节点 URI 列表及其 Base64 编码。外部 `proxy-providers` 和 `rule-providers` 不会递归下载；应填写实际节点订阅 URL。

通用链接的读取与导出支持以下范围；表外协议仍可通过 YAML 保留节点参数，由客户端决定是否支持。

| 协议 | 支持范围 |
| --- | --- |
| Shadowsocks | 读取 SIP002、SS2022 明文编码认证和旧式整段 Base64 链接；导出 SIP002/SS2022，不含插件 |
| VMess | 读取 v2 Base64 JSON 与 AEAD URI，导出 v2 Base64 JSON；支持 TCP、WebSocket、gRPC，以及 TLS、SNI、ALPN、客户端指纹 |
| VLESS | TCP、WebSocket、gRPC、TLS、REALITY；TCP 下的 `xtls-rprx-vision` |
| Trojan | TCP、WebSocket、gRPC、TLS、SNI、ALPN、客户端指纹 |
| Hysteria2 / `hy2` | 认证、SNI、证书校验开关、`pinSHA256`、salamander/gecko 混淆 |
| TUIC v5 | UUID/密码、SNI、ALPN、证书校验开关、拥塞控制；TUIC v4 仅保留 YAML |

链接转换使用明确的参数白名单。SS 插件、额外 WebSocket headers/early-data、gRPC authority、其他传输方式、ECH、Hysteria2 多端口/带宽参数、TUIC 的其他客户端选项，以及显式关闭 UDP 的节点等暂不能转换；请使用 YAML 保存这些参数。未知链接参数也会使该节点被跳过，不会直接丢弃参数后继续导出。

通用链接不携带 Mihomo 的客户端 UDP 开关。导入 SS、VMess、VLESS、Trojan 链接时会明确设置 `udp: true`，避免 UDP 能力在转换为 YAML 后被默认关闭；Hysteria2/TUIC 使用内核的默认 UDP 支持。YAML 原有的 UDP 设置保持不变；未填写 `udp` 的上述四类节点导出为链接时会提示重新导入将启用 UDP，需要保持 Mihomo 默认关闭行为时应使用 YAML。

YAML 不接受 aliases（`*name`）、合并键（`<<`）或显式标签（如 `!!str`）；请先展开引用并移除标签。输入上限为 2 MiB、5000 个节点，并限制嵌套深度和结构数量。一次封装最多选择 100 个来源，所选来源的节点合计不得超过 5000 个或 8 MiB。

Clash 输出重新生成 `proxies`、固定的 `PROXY` 选择组和自定义 `rules`，保留可用节点的协议参数；上游的监听端口、DNS、控制接口与策略组不会直接并入新配置。输出中重名节点会获得唯一名称。同一来源内的 `dialer-proxy` 节点引用会跟随改名更新；引用不存在、被筛除、存在歧义或形成循环时，依赖该引用的节点会跳过并提示。

链接输出会检查协议和参数能否转换。无法无损转换的节点会跳过并在预览中给出提示；没有任何可导出节点时返回错误，不生成看似成功的空订阅。通用链接本身不携带 Clash 策略组或分流规则，分流规则只用于 YAML 输出。

## 封装规则

- **包含 / 排除关键词**：逐行填写，按节点名称作不区分大小写的字面匹配；空包含列表代表不限，不执行正则表达式。
- **协议筛选**：不选时保留全部协议；选择后仅保留对应类型。
- **命名**：支持统一前缀，以及将订阅源名称前置、后置或不显示。前置示例为 `[快雷] 香港01`，后置为 `香港01 [快雷]`。同时填写统一前缀 `[日常] ` 时，前置结果为 `[快雷] [日常] 香港01`。页面新建配置默认前置，编辑旧配置保留原设置；名称变化会同步更新同一来源内的 `dialer-proxy` 引用，并应用于 YAML、通用链接和 Base64 输出。启用去重时，相同节点保留首个所选来源的名称。
- **去重**：比较除名称外的全部节点字段，字段相同的节点只保留一份；带 `dialer-proxy` 节点依赖的节点按来源分别去重，避免跨来源改变连接路径。
- **路由规则**：每行一条，目标策略使用 `PROXY`、`DIRECT` 或 `REJECT`，最终规则必须为 `MATCH`。默认 `MATCH,PROXY`。

支持的路由类型为 `DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`IP-CIDR`、`IP-CIDR6`、`SRC-IP-CIDR`、`GEOIP`、`SRC-GEOIP`、`IP-ASN`、`SRC-IP-ASN`、`DST-PORT`、`SRC-PORT`、`IN-PORT`、`NETWORK`、`PROCESS-NAME`、`PROCESS-PATH` 和 `MATCH`。端口支持单值、`8000-9000` 范围及 `/` 分隔组合；`NETWORK` 仅接受 TCP/UDP。`no-resolve` 仅允许附在 `IP-CIDR`、`IP-CIDR6`、`GEOIP`、`IP-ASN` 后。

示例：

```text
DOMAIN-SUFFIX,example.com,PROXY
DOMAIN-KEYWORD,tracking,REJECT
IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
MATCH,PROXY
```

`RULE-SET`、逻辑组合、正则/通配符规则及其他未列出的类型会被拒绝；本模块不会联网下载远程规则集。需要这些规则或上游自定义策略组时，应在客户端中另外配置，不能直接贴入这里。`MATCH` 只能出现一次且必须位于最后，避免后续规则永远不生效。

## 从 YAML / 文本导入规则

编辑或新建封装配置时，在自定义路由规则旁打开导入面板，可以选择 `.yaml`、`.yml`、`.txt` 文件或粘贴文本。导入器自动识别完整配置中的 `rules`、YAML 字符串列表、`payload` 规则集及逐行规则文本；完整配置中的节点、DNS、监听端口和策略组定义不会并入封装。

原文件中的自定义策略名（例如 `快雷GO`）默认映射到 `PROXY`，预览会逐项展示名称、目标策略和使用次数，也可调整为 `DIRECT` 或 `REJECT` 后重新分析。内置 `DIRECT`、`REJECT`、`PROXY` 保持原含义。默认策略用于缺少策略的 `payload` 条目和自动补充的末尾 `MATCH`，不会改变已有规则的动作。

导入保留规则顺序与重复项，重复项会给出提示。`FINAL` 会识别为 `MATCH`；缺少兜底规则时追加默认 `MATCH` 并提示。中间出现 `MATCH`、多条 `MATCH`、不支持的规则类型、无效参数和 YAML 语法错误均会阻止应用，支持定位到原文件行号。不会通过移动兜底规则或删除错误项来产生看似成功的结果。

输入最多 1 MiB、1000 条规则；YAML 引用、合并键和显式标签需要先展开或移除。`payload` 中的域名、`+.example.com` 和 CIDR 可转换为当前支持的路由规则；无法无损表达的通配符会报错。远程 `rule-providers`、`RULE-SET` 和逻辑组合仍不在当前支持范围，导入不会联网下载它们。

分析操作不写入数据库。只有点击应用，规则才替换当前表单中的文本；保存封装配置后才生效。修改输入或映射会使旧预览失效，不能误用上一次分析结果。

## 管理 API 和客户端订阅

管理接口沿用站点 Bearer 登录认证，数据按账号隔离。

| 方法 / 路径（均以 `/api` 开头） | 用途 |
| --- | --- |
| `GET /subscriptions` | 来源、封装配置、可见探针元数据和服务端时间 |
| `POST /subscriptions/sources` | 新建来源 |
| `PUT /subscriptions/sources/:id` | 修改来源、备注、刷新间隔与拉取探针 |
| `DELETE /subscriptions/sources/:id` | 删除来源，并从封装配置中移除引用 |
| `POST /subscriptions/sources/:id/refresh` | 手动拉取单个来源 |
| `POST /subscriptions/refresh` | 拉取全部启用来源 |
| `POST /subscriptions/rules/import` | 分析 YAML / 文本规则、策略映射与逐行诊断；不保存配置 |
| `POST /subscriptions/profiles` | 新建封装配置 |
| `PUT /subscriptions/profiles/:id` | 修改封装规则或启用状态 |
| `DELETE /subscriptions/profiles/:id` | 删除配置并撤销分享 |
| `POST /subscriptions/profiles/:id/rotate-token` | 重置客户端订阅令牌 |
| `GET /subscriptions/profiles/:id/preview?format=clash` | 已登录预览，返回内容、数量、提示 |
| `GET /subscriptions/feed/:token?format=clash` | 客户端凭独立令牌读取缓存订阅 |

`format` 支持 `clash`、`links`、`base64`，缺省为 `clash`。停用封装配置会禁用客户端链接，但管理者仍可预览。重置令牌后旧链接立即失效；这些响应使用 `Cache-Control: no-store`。

封装规则的 `prepend_source` 与 `append_source` 分别控制来源名称前置和后置，不能同时为 `true`。API 中省略时均为 `false`；旧配置读取时自动补齐默认值，无需修改数据库结构。

规则导入请求为 `{ content, policy_map?, default_policy? }`；映射目标与默认策略只能为 `PROXY`、`DIRECT`、`REJECT`。响应包含识别格式 `format`、输出 `rules`、带严重程度与行列的 `diagnostics`、策略映射 `policies`、输入条目数 `total`、输出数 `imported` 和是否允许应用的 `can_apply`。任何错误都会令 `can_apply` 为 `false`；诊断列表有数量上限，但未展示的错误仍会阻止应用。

来源写入字段 `fetch_agent_id` 为数字节点 ID，`null` 表示服务器直连；新建时省略也按直连处理。来源响应另有 `fetch_agent_name` 和 `fetch_status`（`idle`、`queued`、`fetching`）；兼容字段 `fetching` 在排队和执行期间都为 `true`。探针模式的刷新 API 在入队后立即返回，不等待探针网络请求完成。

`GET /subscriptions` 的 `relay_nodes` 列出推送型探针的 `id`、`name`、`enabled`、`approved`、`online`、`capable`、`last_seen_at`、`relay_transport` 和 `relay_connected`，不会下发探针密钥或密钥哈希。`online` 表示最近 90 秒收到有效节点心跳，WSS 活动也会更新该时间，不代表 CPU 等指标刚刚采集。`capable` 表示已登记订阅回传能力，不代表该探针现在在线。`relay_transport` 优先显示当前可用的 `wss`，否则显示最近 90 秒实际请求过的 `https-poll`，否则为 `null`。`relay_connected` 表示已认证、授权仍有效且最近 70 秒有应用帧的 WSS 连接当前可用；HTTPS 轮询没有持续连接，因此该字段为 `false` 并不表示轮询不可用。

### 探针任务 API

以下 HTTP 接口使用该探针自己的 `X-Agent-Key`，WSS 使用首帧专属密钥认证；同时要求节点已批准并启用。站点登录令牌、共享登记令牌或其他探针的密钥均不能代替。正文中的 `agent_id` 是探针稳定身份字符串，与来源配置的数字 `fetch_agent_id` 不同。

| 方法 / 路径（均以 `/api` 开头） | 请求正文与响应 |
| --- | --- |
| `GET /agent/subscriptions/ws`（Upgrade） | 新版探针的 WSS 任务通道，先认证再下发任务 |
| `POST /agent/subscriptions/poll` | 兼容 `1.1.0`；请求 `{ agent_id, version: 1 }`；响应 `{ job: null 或 { id, url, expires_at }, server_time }` |
| `POST /agent/subscriptions/result` | 请求 `{ agent_id, job_id, content_base64, subscription_userinfo? }`，或 `{ agent_id, job_id, error_code, http_status? }`；响应 `{ ok: true, accepted }` |

`expires_at` 与 `server_time` 均为 Unix 毫秒。探针用两者之差计算本地剩余时限，避免服务器与探针时钟偏差造成误判。每次领取只返回分配给该探针的一项任务；已有未结束租约时不会再分派第二项。

WSS 使用 JSON 文本帧：探针首帧为 `{ type: 'auth', version: 1, agent_id, key }`，认证后等待 `ready`，随后接收 `job`，以 `ack` 确认已收到任务，并通过 `ping` / `pong` 保持通道。单个连接不会重复下发同一租约；重连可重发同一 ID，截止时间保持不变，HTTPS 结果处理完成后再派发下一项。订阅内容只通过 HTTPS 结果接口回传，不放进 WebSocket 帧。代理和调试工具不应记录认证帧或完整任务 URL。

请求体上限为 4 MiB；订阅必须为严格 Base64，解码后最多 2 MiB 且为有效 UTF-8；用量响应头最多 1024 字节。探针只回传原始内容，不能提交自行解析的节点或流量对象。`accepted: true` 表示该任务结果已被处理，也可能是已记录失败原因；是否拉取成功以来源的 `last_success_at`、`last_error` 为准。重复、过期或已撤销任务返回 `accepted: false`，不会改变缓存。

失败只接受固定错误码：`NETWORK_UNREACHABLE`、`CONNECTION_REFUSED`、`CONNECTION_RESET`、`TIMEOUT`、`DNS_ERROR`、`TLS_ERROR`、`HTTP_ERROR`、`TOO_LARGE`、`INVALID_URL`、`PRIVATE_ADDRESS`、`FETCH_FAILED`、`UNSUPPORTED_ENCODING`。服务端将其映射为固定提示，不把探针提交的原始异常或订阅 URL 写入错误文案。可选 `http_status` 必须为 100–599 的整数。

订阅 URL、节点和分享令牌保存在本站 SQLite 中，分享链接持有者能读取对应节点，请按原订阅链接管理。服务端访问日志会隐藏分享路径中的令牌。

## 部署与数据

执行 `pnpm install`、`pnpm build` 后重启服务；首次启动自动顺序执行到数据库迁移 v12，不需要手工建表。v12 为原有来源增加拉取探针选择，为探针增加回传能力心跳，并创建持久任务表；既有来源保持服务器直连，原缓存与规则保留。YAML 解析依赖会打入后端单文件，运行时仍可只部署构建产物。

先升级主服务并按 [Nginx WSS 配置示例](../../README.md#nginx) 为现有 443 入口转发 Upgrade，再更新探针至 `1.2.0`。`AGENT_SERVER` 使用站点地址，由探针自动追加 WSS 和 HTTPS 接口路径；存在反向代理基路径时，两种接口必须使用相同的前缀映射。WSS 客户端使用 Node 22+ 内置实现，无需额外安装客户端依赖。代码升级不会自动替换远程探针文件，每台机器仍需通过其现有部署方式更新，并在页面确认连接状态。

默认只允许公网 HTTP(S) 来源。拉取过程校验 DNS 与每次重定向，只连接本次已校验的地址；域名返回多个地址时，会尝试后续可用地址。单次总时限 15 秒，最多 3 次跳转，下载及解压后均限制为 2 MiB。

如果确实使用自建内网订阅，在 `.env` 或 Docker 环境变量中显式设置：

```dotenv
SUBSCRIPTIONS_ALLOW_PRIVATE_NETWORK=true
```

该设置仅影响服务器直连。探针侧的对应开关是 `AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK=true`，也默认关闭；服务端不会代替探针打开此开关。它会放宽所选机器上的目标地址限制，仅在明确需要自建内网订阅时设置。

SQLite 中的 `subscription_sources`、`subscription_profiles`、`subscription_fetch_jobs` 包含来源、缓存、规则、调度时间和待执行任务，`agent_nodes` 保存探针身份与回传心跳。完整备份请停机后复制数据目录；现有设置页的导航 JSON 导出不包含订阅中心数据。

## 拉取失败排查

拉取由来源选定的服务器或探针发起。本地 Clash 能更新，并不代表所选机器使用相同的 DNS 或网络出口；本地客户端的代理也不会自动供服务器或探针使用。

- **网络不可达 / 连接被拒绝 / 连接被重置**：检查实际拉取机器到订阅域名及端口的连通性、DNS 结果与上游服务状态；尚未取得订阅内容时，流量和到期信息会显示「未提供」。
- **HTTPS 证书无效**：检查域名与证书、服务端系统时间，修正地址或上游证书。拉取器不会跳过证书验证或自动降级为 HTTP。
- **拉取超时**：连接、跳转和读取共用 15 秒时限。拉取失败会保留原缓存，并按已设间隔重试。
- **探针需要升级 / 未在线 / 未在时限内回传**：确认探针已更新为支持回传的版本，配置了本站 `AGENT_SERVER`，已批准且启用，并可用专属密钥主动连接本站。恢复后手动刷新，或等待下一轮定时尝试。
- **节点有心跳，但 WSS 待连接**：检查 443 反向代理是否转发 Upgrade、站点基路径是否一致、TLS 证书是否有效。指标和任务通道独立；CPU 等指标还在变化，不能据此认定 WSS 可用。新版探针不会自动退回 HTTPS 任务轮询。
- **指定探针已删除**：原选择会保留。编辑来源选择其他可用探针，或明确改为服务器直连。

如果该订阅只在特定网络出口下可访问，可选择位于该网络且能直接获取订阅的探针，或让服务商提供所选机器可直连的备用地址。修改刷新间隔无法解决连通性问题。

## 验证

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:bundle
```

可选真实浏览器回归使用 `node scripts/test-subscriptions-browser.mjs`，需要已安装的 Playwright 和 Chrome。可通过 `PLAYWRIGHT_MODULE` 指向现有 Playwright 模块，通过 `TEST_BROWSER_CHANNEL` 选择浏览器；测试使用独立 SQLite、模拟上游与临时浏览器上下文，不连接真实订阅。

探针任务的独立服务端回归为 `node --test tests/subscription-relay.test.mjs`，覆盖真实临时 SQLite、专属密钥认证、唯一租约、跨进程持久化、来源与节点变更、过期回传及缓存保留；不会访问用户数据库或真实订阅。

格式参考：[Mihomo 配置文档](https://wiki.metacubex.one/config/)、[YAML 解析选项](https://eemeli.org/yaml/#options)。
