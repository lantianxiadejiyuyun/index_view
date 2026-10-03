# 导航站与灵犀联动 API

本页约定导航站前端使用的接口。灵犀上游接口契约见灵犀工程 `docs/接入API.md`。

## 首次接入步骤

每个导航账号首次绑定一次自己的灵犀 API Token。绑定成功后，在其他设备登录同一导航账号即可继续使用日历、日程、Deadline 和 AI 聊天，无需再次登录灵犀或再次填写 Token。两个独立导航站分别保存各自的绑定。

下表是完成 HTTPS/WSS 反向代理后的部署配置示例；地址列在这里不表示已部署或已经连接成功。

| 导航站 | 在「灵犀后台地址」中填写 | 导航设置入口 |
|---|---|---|
| 主站 | `https://index.eugenstudio.cn/lingxi-service` | `https://index.eugenstudio.cn/settings/lingxi` |
| ojjlab 独立站 | `https://ojjlab.eugenstudio.cn/lingxi-service` | `https://ojjlab.eugenstudio.cn/settings/lingxi` |

1. 首次打开灵犀的「设置 → 账号」，生成或复制当前用户自己的 API Token。
2. 登录导航站，进入 `/settings/lingxi`，填写上述部署基地址和 API Token，点击「保存并连接」。连接成功后会显示已绑定的灵犀账号；Token 在导航后台加密保存，不再回显。
3. 在同页开启需要的「灵犀日历」「日程与待办」「Deadline」「灵犀 AI 聊天」小组件，或打开 `/lingxi` 工作区。桌面模式还可在组件菜单中添加和拖动。

日常使用只需导航登录。只有重置或撤销灵犀 API Token、解除绑定、更换灵犀账号或服务地址时，才需要重新连接。

### 一次性授权插件密码读取

密码读取另有一次明确授权，范围为密码插件同步到当前导航账号的全部密码条目。原保险库继续端到端加密；主密码、保险库密钥和原密文格式均保持不变。

1. 将 Chrome 密码插件更新到 **0.4.0**，确认插件已连接当前导航站及同一导航账号，并完成原密文保险库同步。
2. 在导航站 `/settings/lingxi` 的「插件密码读取授权」中开启「允许灵犀读取密码」。此时会显示等待插件授权。
3. 在插件中解锁保险库，打开选项页的「灵犀密码读取授权」，勾选「我允许后台解密全部密码条目供已绑定的灵犀读取」，点击「授权并同步」。导航设置显示已授权条目数量后即可使用。

同一绑定和授权有效期间无需反复确认。插件处于解锁状态并完成正常同步后，会继续更新授权副本；如果导航提示副本待更新，可在插件中点击「同步授权副本」。重新开启已关闭的授权、更换导航账号或绑定的灵犀账号时，需要重新确认。

当前每个灵犀账号只登记一个密码库来源。同一灵犀账号先后在两站开启密码读取时，后注册的站点会替换之前的来源；旧站读取时会收到来源不匹配错误，不会显示另一站的密码。两站若需同时独立使用密码库，可分别绑定不同灵犀账号。日程和聊天不受此单密码库来源限制。

授权副本通过 HTTPS 发送到导航后台，后台加密保存，并可按授权解密提供给已绑定的灵犀账号。它独立于原始端到端加密保险库。灵犀 AI 仅可搜索条目元数据并提供受保护的查看入口；密码明文不注入 AI 模型、系统提示词或聊天历史，只在用户点击查看某一条时临时显示。

关闭导航读取开关，或在插件中点击「关闭读取并删除副本」，会立即禁止读取、撤销服务凭证并删除后台授权副本。解除绑定也会撤销该授权。原插件保险库继续保留。

### 部署与恢复

部署时应为两站分别设置自己的 `NAVIGATION_PUBLIC_URL`（站点 origin），并完成上述 `/lingxi-service` 的 HTTPS/WSS 转发。服务器间回调登记和受限凭证轮换由后台处理，用户无需复制第二个服务 Token。

恢复备份时需同时保留导航数据库及原服务器根密钥：如使用环境变量 `JWT_SECRET`，应恢复原值；如使用首次启动生成的密钥，应保留数据库中的对应私密设置。灵犀自身的 `SECRET_KEY` 也须按其备份流程保留。密钥和 Token 只存入受保护的备份，不写入文档、代码仓库或示例配置。根密钥更换后，旧绑定 Token 和授权副本可能无法解密，需要重新绑定并从插件授权同步。

## 账号绑定

导航站浏览器只调用同源 `/api/lingxi/*`，使用现有导航登录的 Bearer access token。每个导航用户绑定自己的灵犀 Token。首次绑定验证成功后，后续设备只需登录导航站。

- `GET /api/lingxi/settings` → `{configured,base_url,has_token,user,updated_at}`；`user` 为 `{id,username,display_name,timezone}` 或 null。
- `PUT /api/lingxi/settings`，正文 `{base_url,api_token}`。先调用灵犀 `/me` 检查账号，成功后加密保存；失败保留原绑定。同地址更新可以省略或留空 Token；换地址必须重新填写。
- `DELETE /api/lingxi/settings` → `{ok:true}`，同时立即撤销密码桥接授权。
- `GET /api/lingxi/me` → `{user,capabilities}`，实时检查当前灵犀授权。

`base_url` 是后台入口，如 `https://bot.example.com/lingxi`，也接受以 `/api/v1` 结尾的接口基地址。不使用公开网页端口，不调用灵犀登录接口，不读取灵犀登录 Cookie。保存的 API Token 不出现在 settings、bootstrap、导出或日志中。

服务端默认仅允许公开 HTTPS 地址，逐次检查并固定 DNS 解析结果，不跟随重定向；隔离测试或自建内网可在服务端明确设置 `LINGXI_ALLOW_PRIVATE_NETWORK=true`。

## 日历与日程

- `GET /api/lingxi/calendar?start=...&end=...` → `{events,timezone}`。范围左闭右开，最多 93 天。开始和结束都须为带时区 ISO 日期时间（UTC `Z` 或 `+08:00`），不可只传日期。
- `POST /api/lingxi/calendar` → `{event}`，201。
- `GET /api/lingxi/calendar/:id` → `{event}`，用于编辑前读取主日程（特别是重复系列原始开始时间）。
- `PATCH /api/lingxi/calendar/:id` → `{event}`。
- `DELETE /api/lingxi/calendar/:id` → `{ok:true}`。

事件字段 `{id,title,start,end,all_day,description,location,rrule,reminder_minutes}`；`end` 可 null。创建必须有 title、start。输出同时保留上游 `event_id`、`occurrence_id`、`start_at`、`end_at` 等字段，`id` 使用原日程 ID，修改重复日程作用于整个系列，不冒充单次例外编辑。

## 待办与截止时间

- `GET /api/lingxi/tasks?status=open&limit=200&offset=0` → `{tasks,timezone,pagination}`；支持 status=open/done/cancelled/all、q、due_after、due_before。
- `POST /api/lingxi/tasks` → `{task}`，201。
- `PATCH /api/lingxi/tasks/:id` → `{task}`。
- `DELETE /api/lingxi/tasks/:id` → `{ok:true}`。

待办字段 `{id,title,notes,due,status,priority,project,tags}`；due 为带时区 ISO 时间或 null；status=open/done/cancelled；priority=1/2/3；tags 为字符串数组。输出同时保留上游 due_at。PATCH `{due:null}` 清除截止时间；PATCH `{status:'done'}` 完成待办。所有列表需尊重 pagination，默认最多 200 条，不声称未加载的条目不存在。

## AI 聊天

- `GET /api/lingxi/sessions?limit=200&offset=0` → `{sessions,pagination}`。
- `POST /api/lingxi/sessions`，正文 `{title?}` → `{session}`，201。
- `PATCH /api/lingxi/sessions/:id`，正文 `{title}` → `{session}`。
- `DELETE /api/lingxi/sessions/:id` → `{ok:true}`。
- `GET /api/lingxi/sessions/:id/messages?limit=200&offset=0` → `{messages,pagination}`，上游按 ID 升序。
- `POST /api/lingxi/sessions/:id/messages`，正文 `{message,request_id?}` → SSE。使用 fetch 流，携带导航站 access token，不用 EventSource。

会话 `{id,title,updated_at}`；消息 `{id,role,content,created_at}`。正文最多 64 KiB，聊天消息最多 32000 字符。上游映射为 `/api/v1/conversations`。

SSE 事件完整保留灵犀格式：

```text
event: delta
data: {"type":"delta","conversation_id":123,"request_id":"nav-1","seq":2,"data":"明天有"}

```

支持 start、ack、delta、tool、notice、title、error、done。delta.data 是增量字符串，done.data 是完整最终回复，需替换临时拼接结果。error 后的 done 仍表示失败，不要改成成功。工具结果不是 HTML，不可直接渲染。断线后查询历史确认，不自动重发消息，以免重复执行工具。

## WSS 代理

`POST /api/lingxi/ws-ticket` 使用导航登录，返回 `{ticket,expires_at,path:'/api/lingxi/ws',protocol:'lingxi.v1'}`。票据 60 秒内有效，只能使用一次，绑定设备登录和当前灵犀绑定版本。

浏览器连同源 `wss://当前站点/api/lingxi/ws`，10 秒内发首帧 `{type:'auth',ticket}`，不要把票据或 API Token 放 URL。代理后端单独连接灵犀的固定 `/api/v1/ws`，首帧传保存的 API Token；浏览器只收到 ready 及聊天事件。ready 后可发送 `{type:'chat.send',conversation_id,message,request_id?}`，同一连接等待本次 done 后再发送下一条。应用 ping 返回 pong；服务端还使用协议心跳。

上游断开、导航退出或撤销设备登录、换绑、解绑都会终止关联连接。不重放 chat.send。慢客户端被关闭；单账号最多 4 个实时连接。SSE 同样会在解绑或登录撤销后中止并停止输出原账号的数据。

## 受保护的密码查看

导航后端仅在本地读取开关已开启、插件授权副本已就绪且与最新保险库版本一致、服务凭证已登记且未过期时访问以下接口；出站前后都检查授权、副本版本和服务凭证摘要，关闭授权、更新副本或轮换凭证后丢弃在途结果。

- `GET /api/lingxi/vault/items?q=&limit=200&offset=0` → `{items:[{id,title,site,username_masked,password_set}],pagination}`。id 是字符串（可为 UUID）；site 是网址 origin，不含路径查询参数；列表没有密码或完整用户名。
- `POST /api/lingxi/vault/reveal`，正文 `{id:'字符串 ID'}` → `{item:{id,title,site,username,password}}`。只有用户点击查看单条密码时调用，返回 `Cache-Control: no-store`。前端隐藏页面或超时后清空，不把返回值送入聊天请求或模型。

未开启返回 403 / `lingxi_vault_disabled`；待插件同步返回 409 / `lingxi_vault_not_ready`；服务凭证未登记或已过期返回 409 / `lingxi_vault_service_not_ready`；读取期间授权、副本或凭证变化返回 409 / `lingxi_vault_changed`。这些接口仍使用导航登录，浏览器无需再次登录灵犀。

导航后端向灵犀的 items/reveal 请求附带固定 `X-Navigation-Vault-Grant` 请求头，值为本地登记的读取凭证 SHA-256 摘要（64 位十六进制），仅从服务器授权记录取得，不能由浏览器指定。灵犀先将其与当前登记来源比对，不匹配返回 409 且不请求密码回调。因此同一灵犀账号的来源被另一站替换后，旧站会拒绝读取，避免同名条目造成错源显示。摘要不作为独立读取凭证，原 API Token 和回调授权校验仍然生效。

## 失败语义与隐私

导航登录失效返回 401；灵犀 Token 失效返回 403 / `lingxi_auth_required`，不可清除导航登录。未绑定返回 409 / `lingxi_not_configured`。其他错误 `{error,message}`，保留明确错误 HTTP 状态。聊天断开/超时、未部署接口、私网不可达均显示实际错误，不用示例数据替代。

API Token 使用 AES-256-GCM，密钥由服务器根密钥派生，AAD 绑定用户 ID 和用途。更换上游地址或灵犀用户、解绑时撤销原密码桥接授权。仅固定允许的灵犀 API 可代理，不能将此服务用作任意 URL 转发器。
