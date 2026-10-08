# 密码管理器设计说明（v0.6.0）

## 数据与密钥

主密码在本机通过 PBKDF2-SHA256（600,000 次、随机 salt）派生不可导出的 AES-GCM-256 CryptoKey。密文文件 v1 包含公开 KDF 参数、独立 verifier 与 payload。每次加密使用随机 12 字节 IV。

- `chrome.storage.local` 保存密文文件、行为设置、同步状态、语言偏好、介绍已读状态、独立的网站外观偏好，以及仅含服务器地址和账号的表单草稿；不保存明文密码或派生密钥。
- 解锁会话保存明文保险库和 CryptoKey。默认只保存在内存，浏览器回收后台或主动锁定后清除会话。
- 站点同步登录凭据放在保险库的 account 字段里加密保存。access token 仅存在内存。
- 锁定会增加会话代数；异步密钥派生、登录、同步等返回后必须再次验证会话，不得使已锁定会话复活。
- 写操作串行化，先校验、加密并成功落盘，再发布内存状态，避免并发编辑丢条目。
- 导入先校验版本、KDF 范围、base64、IV、密文容量与条目字段。明文追加导入生成新 ID；密文导入停用之前的同步绑定。

### 可选的永久关闭自动上锁

`settings.neverAutoLock` 默认 `false`，仅保存在当前浏览器的 `chrome.storage.local`。用户在已解锁状态显式开启后，扩展在自身 IndexedDB 中持久化不可导出的 CryptoKey，用于后台重启或浏览器重启后解密当前本机保险库。主密码与明文保险库不因此落盘，恢复密钥、设置和访问令牌均不上传或跨设备同步。不可导出限制不阻止本机扩展使用该密钥解密，因此此选项降低了对可访问同一浏览器配置的人的保护。

开启时跳过计时和系统闲置/锁屏触发的自动锁定，但保留原 `autoLockMinutes`、`lockOnIdle` 设置。关闭后清除 IndexedDB 恢复密钥并恢复原自动锁定行为。手动锁定清除内存会话及恢复密钥，不关闭 `neverAutoLock` 偏好；之后必须使用主密码解锁，解锁成功再按该偏好建立恢复。清空本机数据同时清除恢复密钥与所有设置。

创建或解锁保险库、更换主密码、密文导入及下载服务器保险库时，恢复记录必须与当前文件、密钥一致。后台启动的恢复先验证记录与当前保险库，再解密并校验保险库内容；记录丢失、损坏或不匹配时保持锁定。恢复过程和持久化写入均遵守会话代数校验，手动锁定不得被在途恢复或旧密钥写入撤销。

仅运行自动化回归测试不等于完成独立安全审计。网页得到填充字段后，其脚本能够读取这些字段；隔离世界不能阻止目标网站读取用户已决定填入的数据。

## 消息边界和填充

扩展页面可管理密码库。密码填充 content script 只可调用 match/fill；后台按 Chrome 提供的 sender.url 校验目标，不相信消息自报的网址。网站外观脚本不调用这些消息，也不读取密码库。

match 仅返回标题、用户名和条目 ID 等摘要。只有用户触发的 fill 返回密码。默认精确匹配主机名，不猜测公共后缀或注册域；显式 `*.example.com` 只匹配子域。

页面提示保留唯一的 closed ShadowRoot。MutationObserver 忽略扩展自身节点，只在页面变化时节流刷新；同一 URL 复用匹配摘要，后台状态变化或 SPA 地址变化时失效。密码填入前重新确认地址、条目匹配、字段是否仍在页面和表单关联。

原生 input value setter 加 input/change 事件兼容 React 等受控输入。多表单按聚焦字段选择；弹窗定向主框架，子框架通过自己的提示选择，避免广播同时写多个框架。

锁定广播给扩展页面清理明文；同步或其他窗口编辑后的广播刷新条目和同步状态。正在编辑的输入保留，但发生外部条目变化时提示核对后保存。

## 同步与冲突

同步服务器就是本项目主站，无独立同步服务：

```text
GET  /api/health                                  探测服务
POST /api/auth/login  { username, password }       获取 access token
GET  /api/vault                                   { version, blob, updated_at }
PUT  /api/vault  { base_version, blob }             成功更新或返回 409
```

公网 HTTPS；有效的内网/本机地址可以 HTTP，并显示无传输加密提示。禁止携带 URL 内嵌凭据、查询或片段，拒绝重定向，超时包含响应体读取。

首次绑定先读取远端。远端为空时可上传；已有密文时暂停并让用户选择。换绑会重置版本，不能拿前一服务器版本覆盖另一服务器。

连接表单的 `serverFormDraft` 只保存 `base` 和 `user`，采用延迟写入，失焦和离开页面时刷新草稿。写入与清除串行化，避免解绑后被在途写入重新保存。草稿只是表单输入，不代表已完成绑定，也不会单独触发网络请求。

`account-connect` 在已解锁、规范化后的服务器地址与账号均和加密库 `account` 一致时，允许空密码复用已有凭据。输入新密码则替换已保存凭据；更换地址或账号时禁止复用。明文密码不回填到页面、不进入草稿，仍仅在加密保险库中持久化。

下载按远端 KDF/salt 派生密钥；本机密钥不适用时要求输入远端主密码。先验证解密成功再替换本机，并保留用户当前明确选择的服务器绑定。下载空远端不会隐式上传。

普通上传带已知版本。用户明确覆盖时重新读取远端版本，再用 CAS 上传；读取与上传之间的第二次修改仍然产生冲突。服务端用带版本条件的 SQLite 语句保证跨进程原子性，不允许省略 base_version 绕过检查。密文响应均为 no-store。

原 `/api/vault` 接口只校验 v1 加密信封形状与 1 MB UTF-8 上限，不持有主密码或该保险库的解密密钥。服务端不能直接解密原 blob。

### 可选的灵犀读取授权

这是原保险库以外的独立功能：后台开关默认关闭；用户先绑定灵犀并打开后台开关，再解锁插件并勾选授权，插件才通过 HTTPS 上传仅含 `items` 的副本。不会发送 `vault.account`、主密码或 `vaultKey`。本机记录当前服务器、账号和 `grant_id`，后台开关重新开启、换绑或授权批次变化后不会静默重新授权。

`lingxi_vault_grants` 保存 AES-256-GCM 副本，AAD 绑定导航账号和 `vault-snapshot` 用途，密文内容另含当前授权批次。后台按需解密供绑定灵犀读取。专用服务令牌只存 SHA-256 摘要，不能访问导航站其他 API，24 小时有效并提前刷新。公网回调来源只取管理员配置的 `NAVIGATION_PUBLIC_URL`，不信任请求 Host。

`source_version` 必须等于原保险库版本，`base_version` 用于授权副本 CAS。原保险库更新但副本未同步时拒绝读取，避免返回旧密码。关闭读取会删除副本、清空服务令牌并轮换批次；读取路由在请求体接收完毕后再次同步校验权限，避免接收慢请求期间的撤销竞态。审计仅保存动作、数量、时间，最多保留最近 200 条。

```text
GET/PUT /api/lingxi/vault/settings              当前账号的后台读取开关及无敏感信息的状态
POST    /api/lingxi/vault/snapshot              已解锁插件显式授权后的副本同步
POST    /api/lingxi/vault/service/read          仅限权服务令牌，读取全部或 ids 指定条目
```

普通导航登录令牌不能调用服务读取接口；服务令牌也不能调用设置或其他导航 API。密码不自动进入模型对话上下文；灵犀如何提供按需显示应遵循其自己的工具与用户界面协议。插件锁定仅关闭本机会话，不撤销用户此前明确授予的服务端读取权限。

自动上传受 enabled、autoPush、dirty、conflict 共同控制。修改后等待约 5 秒上传，并设置浏览器闹钟兜底；自动上传本身不会启用密钥持久化，手动锁定后也不会为了上传恢复会话。失败保留 dirty 与错误，解锁后按设置继续尝试。401 最多重新登录一次。

## 界面与本地化

0.3.0 将弹窗按网站匹配、列表、详情与编辑分层，设置页提供分区导航；共享样式支持深浅色主题与窄屏。使用本地 CSS 和已有图标，不加载外部字体、脚本或图片。

Chrome 清单以 `__MSG_*__` 引用 `_locales/en`、`zh_CN`、`zh_TW`、`ja` 的扩展名称与描述，`default_locale` 为 `en`。应用界面另外使用 `ui/i18n.js` 和 `ui/translations.js`，以简体中文源文和命名占位符组织翻译。

- `language` 偏好可选 `auto`、`zh-CN`、`zh-TW`、`en`、`ja`。自动模式优先读取 Chrome 界面语言，再回退到浏览器语言；不支持的语言回退英语。
- `chrome.storage.onChanged` 同步已打开页面的语言状态；初始读取会检查更新代数，避免旧读取覆盖刚收到的语言变更。
- `localize()` 只修改明确标记的 `data-i18n` 文本及 placeholder、title、aria-label 属性，账号内容和输入值不进入自动翻译。
- 动态文案使用 `t(source, params)`；错误仅翻译已知代码、固定原文和限定的数字模板，不改写未知服务器文本。
- 后台按语言选择向 content script 返回 `locale` 和提示用的小词典；网页提示不需要加载界面模块或新增权限。改变语言只刷新提示，不改写密文或同步版本。

`ui/intro.js` 提供首次使用介绍，可从弹窗或设置页重新打开。关闭时保存 `introSeenVersion`；使用原生 dialog 支持键盘关闭、焦点恢复和语言更新。介绍状态与密码库分离，清空本机数据时一起清除。

### Bilibili 网站外观

0.6.0 在设置页新增独立的「网站外观」分区及导航入口，位于密码库解锁控制区之外。`websiteAppearance` 是 `chrome.storage.local` 的独立键，值为 `{ bilibiliTheme: 'system' | 'off' }`；缺失或非法偏好回退 `system`。设置页直接读写该键，监听 `storage.onChanged` 更新其他页面，使用更新代数保护异步初始化，并在保存失败时恢复最后确认的值。

该偏好不属于密码库的 `settings`、明文保险库或密文文件，不参与备份与服务器同步，也不依赖主密码、恢复密钥、后台会话或密码库是否已经创建、解锁。网页外观切换不会触发解锁或密码数据处理。

`content/bilibili-theme.js` 在 Bilibili 主框架的隔离世界读取这一项偏好，并监听 `matchMedia('(prefers-color-scheme: dark)')`；只把 `dark`、`light` 或 `off` 写入根节点的专用属性。`content/bilibili-theme-page.js` 在 MAIN 世界读取该属性，调用可识别的 Bilibili 官方主题控制器，或切换已存在的官方主题样式表。MAIN 脚本没有扩展 API，DOM 属性不承载凭据或保险库数据。

只接管具备可识别官方主题控制器或官方样式表的页面，其余页面保留原状；不注入远程代码、不使用整页反色滤镜，也不改变图片或视频本身的颜色。开始接管时记录本页原主题状态和网站主题偏好；收到 `off` 时恢复记录，之后保留网站自己的主题选择。浏览器深浅色偏好变化、页面控制器延迟挂载和官方主题样式变化均可触发重新应用。

## 权限

| 权限 | 用途 |
| --- | --- |
| storage | 本机密文和设置 |
| http/https host access | 匹配当前网站、提示/填充、Bilibili 网站外观，以及用户指定的同步服务器 |
| alarms | 自动锁定和待上传调度 |
| idle | 系统闲置或锁屏时锁定 |
| clipboardWrite | 用户点击复制账号或密码 |

不使用 clipboardRead，因此不承诺自动读取或清空剪贴板；复制密码也不会自动显示明文。不使用远程代码、遥测或第三方统计；默认服务器地址为空。

## 文件与验证

- `background.js`：消息路由、会话、持久化与同步。
- `src/crypto.js`、`vault.js`：密码学、加密文件与条目校验。
- `src/session-key.js`：显式开启后的本机 IndexedDB 恢复密钥存取。
- `src/sync.js`、`match.js`、`generator.js`：网络协议、站点匹配和密码生成。
- `content/prompt.js`：页面提示与自动填充。
- `content/bilibili-theme.js`、`content/bilibili-theme-page.js`：本机外观偏好与浏览器配色监听、Bilibili 官方主题适配及停止接管后的恢复。
- `popup/`、`options/`、`ui/`：界面与交互辅助。
- `ui/i18n.js`、`ui/translations.js`、`_locales/`：界面语言、翻译词典与 Chrome 清单本地化。
- `ui/intro.js`、`ui/server-form-cache.js`：首次介绍及非密码连接草稿。
- `app/server/src/routes/vault.ts`：主站密文存储 API。
- `tests/extension-*.test.mjs`、`tests/server-vault.test.mjs`：纯模块、后台会话、内容脚本、翻译完整性、语言切换、表单缓存和隔离数据库回归。
- `scripts/test-extension-browser.mjs`：独立浏览器配置的端到端验证，包含介绍、四语界面、服务器草稿与凭据复用。

在根目录运行 `pnpm test:extension` 验证扩展、Bilibili 外观和密文接口，`node --test tests/lingxi-vault.test.mjs` 验证授权解密、撤销、版本校验和账号隔离；`pnpm test:browser` 运行可选浏览器回归，浏览器环境准备见 [README.md](README.md)。`pnpm pack:extension` 按清单版本生成 `chrome_plug_in-0.6.0.zip`。

尚未实现：TOTP、Passkey、团队共享、Chrome CSV 导入、条目自动合并和网页密码自动采集保存。
