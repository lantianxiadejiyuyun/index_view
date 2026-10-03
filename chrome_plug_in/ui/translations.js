/** Source messages stay in Simplified Chinese; values are [English, Traditional Chinese, Japanese]. */
const rows = [
["关闭常开模式","Turn off persistent unlock","關閉常開模式","常時ロック解除を無効にする"],
["浏览器不支持保存本机恢复密钥","This browser cannot store a local recovery key","瀏覽器不支援儲存本機恢復金鑰","このブラウザは端末内の復元キーの保存に対応していません"],
["本机恢复密钥存储被占用，请关闭其他插件页面后重试","Local recovery key storage is busy. Close other extension pages and try again.","本機恢復金鑰儲存空間忙碌中，請關閉其他擴充功能頁面後重試","端末内の復元キーの保存先が使用中です。他の拡張機能ページを閉じて、もう一度お試しください。"],
["本机恢复密钥保存失败","Failed to save the local recovery key","本機恢復金鑰儲存失敗","端末内の復元キーを保存できませんでした"],
["本机恢复密钥无效","The local recovery key is invalid","本機恢復金鑰無效","端末内の復元キーが無効です"],
["永久关闭自动上锁","Permanently disable automatic locking","永久關閉自動上鎖","自動ロックを常に無効にする"],
["开启后，计时、闲置、锁屏、后台休眠和重启浏览器均不会自动上锁。","When enabled, the vault stays unlocked through inactivity, screen locking, background suspension and browser restarts.","開啟後，計時、閒置、鎖定螢幕、背景休眠和重新啟動瀏覽器均不會自動上鎖。","有効にすると、タイマー・アイドル状態・画面ロック・バックグラウンドの休止・ブラウザの再起動で自動ロックされません。"],
["恢复密钥仅保存在当前设备，不同步。手动锁定会清除恢复密钥；下次用主密码解锁后恢复常开。","The recovery key stays on this device and is not synced. Locking manually clears it; unlocking with your master password enables persistent access again.","恢復金鑰僅儲存在目前裝置，不會同步。手動鎖定會清除恢復金鑰；下次以主密碼解鎖後恢復常開。","復元キーはこの端末にのみ保存され、同期されません。手動でロックするとキーが削除され、次にマスターパスワードで解除すると常時ロック解除に戻ります。"],
["灵犀密码读取授权","Lingxi password access","靈犀密碼讀取授權","Lingxiのパスワード読み取り許可"],
["开启后，全部密码条目的授权副本会发送到导航站。后台加密保存并可解密供已绑定的灵犀读取；原密文保险库和主密码保持不变。","When enabled, an authorized copy of all entries is sent to your dashboard. The server encrypts this copy and can decrypt it for your linked Lingxi account. Your original encrypted vault and master password stay unchanged.","開啟後，全部密碼條目的授權副本會傳送到導航站。後台加密儲存並可解密供已綁定的靈犀讀取；原密文保險庫和主密碼保持不變。","有効にすると全項目の許可されたコピーをダッシュボードへ送信します。サーバーは暗号化して保存し、連携したLingxiのために復号できます。元の保管庫とマスターパスワードは変更しません。"],
["我允许后台解密全部密码条目供已绑定的灵犀读取","Allow the server to decrypt all entries for my linked Lingxi account","我允許後台解密全部密碼條目供已綁定的靈犀讀取","連携したLingxiのためにサーバーが全項目を復号することを許可します"],
["授权并同步","Authorize and sync","授權並同步","許可して同期"],
["同步授权副本","Sync authorized copy","同步授權副本","許可済みコピーを同期"],
["关闭读取并删除副本","Disable access and delete copy","關閉讀取並刪除副本","アクセスを無効にしてコピーを削除"],
["先在导航站的灵犀设置中开启读取开关，再在这里授权。关闭后立即停止读取；重新开启需要再次确认。","Enable password access in the dashboard Lingxi settings, then authorize here. Disabling access takes effect immediately; enabling it again requires renewed consent.","先在導航站的靈犀設定中開啟讀取開關，再在這裡授權。關閉後立即停止讀取；重新開啟需要再次確認。","ダッシュボードのLingxi設定で読み取りを有効にし、ここで許可してください。無効にすると即時停止します。再度有効にするには改めて許可が必要です。"],
["后台读取开关已关闭","Server password access is disabled","後台讀取開關已關閉","サーバーの読み取りは無効です"],
["已授权全部 {count} 条密码","All {count} password entries authorized","已授權全部 {count} 條密碼","全{count}件のパスワードを許可済み"],
["等待本机解锁后确认授权","Waiting for authorization on this unlocked device","等待本機解鎖後確認授權","この端末でロック解除後の許可を待っています"],
["授权副本已保存，正在连接灵犀读取服务","Authorized copy saved; connecting Lingxi access","授權副本已儲存，正在連接靈犀讀取服務","許可済みコピーを保存しました。Lingxiへの接続を準備中です"],
["请先勾选密码读取授权","Select the password access consent first","請先勾選密碼讀取授權","まずパスワード読み取りの許可を選択してください"],
["密码授权副本已加密保存","Authorized password copy saved encrypted","密碼授權副本已加密儲存","許可したパスワードのコピーを暗号化して保存しました"],
["读取已关闭，后台授权副本已删除","Access disabled and the server copy deleted","讀取已關閉，後台授權副本已刪除","読み取りを無効にし、サーバーのコピーを削除しました"],
["授权密码同步必须使用 HTTPS 服务器","Authorized password sync requires HTTPS","授權密碼同步必須使用 HTTPS 伺服器","許可したパスワードの同期にはHTTPSが必要です"],
["请先完成密码库密文同步，再授权灵犀","Sync the encrypted vault before authorizing Lingxi","請先完成密碼庫密文同步，再授權靈犀","暗号化された保管庫を同期してからLingxiを許可してください"],
["请先在导航站设置中开启允许灵犀读取密码","Enable Lingxi password access in dashboard settings first","請先在導航站設定中開啟允許靈犀讀取密碼","先にダッシュボードの設定でLingxiのパスワード読み取りを有効にしてください"],
["密码授权已变化，请重新确认","Password authorization changed; confirm it again","密碼授權已變更，請重新確認","パスワードの許可が変わりました。再度確認してください"],
["请先在插件中确认授权","Confirm authorization in the extension first","請先在擴充功能中確認授權","拡張機能で許可を確認してください"],
["服务器上的保险库已经变过了","The server vault has changed","伺服器上的保險庫已變更","サーバー上の保管庫が変更されています"],
["登录已过期，请重新登录","Your session expired. Sign in again.","登入已過期，請重新登入","セッションが切れました。もう一度ログインしてください。"],
["用户名或密码不正确","Incorrect username or password","使用者名稱或密碼不正確","ユーザー名またはパスワードが正しくありません"],
["请输入用户名和密码","Enter a username and password","請輸入使用者名稱和密碼","ユーザー名とパスワードを入力してください"],
["尝试过于频繁，请 {seconds} 秒后再试","Too many attempts. Try again in {seconds} seconds.","嘗試過於頻繁，請於 {seconds} 秒後重試","試行回数が多すぎます。{seconds}秒後にもう一度お試しください。"],
["密文超过 {size} KB，拒绝保存","Encrypted data exceeds {size} KB and cannot be saved","密文超過 {size} KB，無法儲存","暗号化データが{size} KBを超えているため、保存できません"],
["base_version 必须是非负安全整数","The base version must be a non-negative safe integer","base_version 必須是非負安全整數","base_versionには0以上の安全な整数を指定してください"],
["blob 必须是非空字符串","The encrypted payload must be a non-empty string","blob 必須是非空字串","暗号化データには空でない文字列を指定してください"],
["blob 必须是保险库密文（JSON 对象）","The payload must be an encrypted vault JSON object","blob 必須是保險庫密文（JSON 物件）","データは暗号化された保管庫のJSONオブジェクトである必要があります"],
["本机加密保险库","Locally encrypted vault","本機加密保險庫","端末内で暗号化する保管庫"],
["你的密码，安心收好","Your passwords, safely stored","你的密碼，安心收好","パスワードを、安心して保管"],
["输入主密码","Enter master password","輸入主密碼","マスターパスワードを入力"],
["创建我的密码库","Create my vault","建立我的密碼庫","自分の保管庫を作成"],
["搜索账号、网址或用户名","Search accounts, websites or usernames","搜尋帳號、網址或使用者名稱","アカウント・URL・ユーザー名を検索"],
["已保存账号","Saved accounts","已儲存帳號","保存済みアカウント"],
["仅当前网站","This website only","僅目前網站","現在のサイトのみ"],
["已复制用户名","Username copied","已複製使用者名稱","ユーザー名をコピーしました"],
["已复制密码","Password copied","已複製密碼","パスワードをコピーしました"],
["密码库已在其他页面更新。仍将当前编辑保存到现在的密码库？","The vault changed in another view. Save your current edits to the updated vault?","密碼庫已在其他頁面更新。仍要將目前編輯儲存至更新後的密碼庫？","別の画面で保管庫が更新されました。現在の編集内容を更新後の保管庫に保存しますか？"],
["密码库已在其他页面更新，当前输入已保留；保存前请核对。","The vault changed in another view. Your inputs are preserved; review them before saving.","密碼庫已在其他頁面更新，目前輸入已保留；儲存前請確認。","別の画面で保管庫が更新されました。入力内容は保持されています。保存前に確認してください。"],
["第 1 步 / 共 3 步","Step 1 of 3","第 1 步 / 共 3 步","ステップ 1 / 3"],
["地址和账号保存在当前浏览器；站点密码只在密码库中加密保存。","The URL and username are remembered in this browser. The server password is stored only inside the encrypted vault.","網址與帳號會保存在目前瀏覽器；站點密碼只在密碼庫中加密保存。","URLとユーザー名はこのブラウザに記憶されます。サーバーのパスワードは暗号化された保管庫内にのみ保存されます。"],
["已加密保存，留空可沿用","Stored encrypted; leave blank to reuse","已加密保存，留空可沿用","暗号化して保存済み。空欄で再利用"],
["请输入站点密码","Enter the server password","請輸入站點密碼","サーバーのパスワードを入力してください"],
["请填写服务器地址和站点账号","Enter the server URL and username","請填寫伺服器網址和站點帳號","サーバーのURLとユーザー名を入力してください"],
["连接信息已在本机记住","Connection details remembered on this device","連線資訊已在本機記住","接続情報をこの端末に記憶しました"],
  [
    "密码管理器",
    "Password Manager",
    "密碼管理器",
    "パスワードマネージャー"
  ],
  [
    "自部署密码管理器",
    "Self-hosted Password Manager",
    "自架密碼管理器",
    "セルフホスト型パスワードマネージャー"
  ],
  [
    "密码管理器 · 设置",
    "Password Manager · Settings",
    "密碼管理器 · 設定",
    "パスワードマネージャー · 設定"
  ],
  [
    "设置",
    "Settings",
    "設定",
    "設定"
  ],
  [
    "设置中心",
    "Settings",
    "設定中心",
    "設定センター"
  ],
  [
    "偏好设置",
    "Preferences",
    "偏好設定",
    "環境設定"
  ],
  [
    "安全与锁定",
    "Security & locking",
    "安全與鎖定",
    "セキュリティとロック"
  ],
  [
    "数据与备份",
    "Data & backups",
    "資料與備份",
    "データとバックアップ"
  ],
  [
    "使用介绍",
    "Quick tour",
    "使用介紹",
    "使い方ガイド"
  ],
  [
    "界面语言",
    "Display language",
    "介面語言",
    "表示言語"
  ],
  [
    "跟随浏览器",
    "Use browser language",
    "跟隨瀏覽器",
    "ブラウザの言語を使用"
  ],
  [
    "简体中文",
    "简体中文",
    "简体中文",
    "简体中文"
  ],
  [
    "繁體中文",
    "繁體中文",
    "繁體中文",
    "繁體中文"
  ],
  [
    "English",
    "English",
    "English",
    "English"
  ],
  [
    "日本語",
    "日本語",
    "日本語",
    "日本語"
  ],
  [
    "本机密码库",
    "Local vault",
    "本機密碼庫",
    "この端末の保管庫"
  ],
  [
    "掌控你的密码与同步",
    "Your passwords. Your sync.",
    "掌控你的密碼與同步",
    "パスワードも同期も、自分で管理"
  ],
  [
    "按照你的习惯管理密码库。",
    "Make your vault work for you.",
    "按照你的習慣管理密碼庫。",
    "使い方に合わせて保管庫を設定できます。"
  ],
  [
    "本机加密 · 你的服务器 · 你的数据",
    "Local encryption · Your server · Your data",
    "本機加密 · 你的伺服器 · 你的資料",
    "端末内で暗号化 · 自分のサーバー · 自分のデータ"
  ],
  [
    "本机加密 · 自部署同步",
    "Local encryption · Self-hosted sync",
    "本機加密 · 自架同步",
    "端末内で暗号化 · 自分のサーバーへ同期"
  ],
  [
    "立即锁定",
    "Lock now",
    "立即鎖定",
    "今すぐロック"
  ],
  [
    "锁定",
    "Lock",
    "鎖定",
    "ロック"
  ],
  [
    "解锁",
    "Unlock",
    "解鎖",
    "ロック解除"
  ],
  [
    "解锁密码库",
    "Unlock your vault",
    "解鎖密碼庫",
    "保管庫のロックを解除"
  ],
  [
    "主密码",
    "Master password",
    "主密碼",
    "マスターパスワード"
  ],
  [
    "主密码（至少 8 位）",
    "Master password (at least 8 characters)",
    "主密碼（至少 8 個字元）",
    "マスターパスワード（8文字以上）"
  ],
  [
    "确认主密码",
    "Confirm master password",
    "確認主密碼",
    "マスターパスワードを確認"
  ],
  [
    "创建本机密码库",
    "Create a local vault",
    "建立本機密碼庫",
    "この端末に保管庫を作成"
  ],
  [
    "创建密码库",
    "Create vault",
    "建立密碼庫",
    "保管庫を作成"
  ],
  [
    "主密码只在本机派生密钥。忘记后无法找回，请妥善保存。",
    "Your master password derives an encryption key on this device only. It cannot be recovered if forgotten. Keep it safe.",
    "主密碼只在本機衍生金鑰。忘記後無法找回，請妥善保存。",
    "マスターパスワードから、この端末内でのみ暗号鍵を生成します。忘れると復元できないため、大切に保管してください。"
  ],
  [
    "已有密文备份？可直接使用下方「备份与恢复」。已有服务器密码库？创建后连接服务器，再下载恢复。",
    "Have an encrypted backup? Use Backup & restore below. Have a vault on your server? Create a local vault, connect your server, then download it.",
    "已有加密備份？可直接使用下方「備份與還原」。已有伺服器密碼庫？建立後連接伺服器，再下載還原。",
    "暗号化バックアップがある場合は、下の「バックアップと復元」を使えます。サーバーに保管庫がある場合は、作成後に接続してダウンロードしてください。"
  ],
  [
    "连接你的服务器",
    "Connect your server",
    "連接你的伺服器",
    "自分のサーバーに接続"
  ],
  [
    "使用导航站账号登录，密码库以密文同步。也可以仅保存在当前浏览器。",
    "Sign in with your dashboard account to sync an encrypted vault. You can also keep it in this browser only.",
    "使用導航站帳號登入，以密文同步密碼庫。也可以僅保存在目前瀏覽器。",
    "ダッシュボードのアカウントでログインすると、保管庫を暗号化して同期できます。このブラウザだけで使うこともできます。"
  ],
  [
    "导航站地址",
    "Dashboard URL",
    "導航站網址",
    "ダッシュボードのURL"
  ],
  [
    "https://你的域名 或 http://192.168.1.10:9200",
    "https://your-domain or http://192.168.1.10:9200",
    "https://你的網域 或 http://192.168.1.10:9200",
    "https://your-domain または http://192.168.1.10:9200"
  ],
  [
    "站点账号",
    "Server username",
    "站點帳號",
    "サーバーのユーザー名"
  ],
  [
    "站点密码",
    "Server password",
    "站點密碼",
    "サーバーのパスワード"
  ],
  [
    "站点密码（加密保存）",
    "Server password (stored encrypted)",
    "站點密碼（加密保存）",
    "サーバーのパスワード（暗号化して保存）"
  ],
  [
    "连接服务器",
    "Connect server",
    "連接伺服器",
    "サーバーに接続"
  ],
  [
    "仅在本机使用",
    "Use locally only",
    "僅在本機使用",
    "この端末だけで使う"
  ],
  [
    "公网使用 HTTPS。内网 HTTP 不加密网络连接，站点登录凭据在同网段可能被读取。",
    "Use HTTPS on public networks. Local HTTP connections are not encrypted, so others on the network may read your server login credentials.",
    "公網使用 HTTPS。內網 HTTP 不會加密連線，同網段的人可能讀取站點登入憑證。",
    "公開ネットワークではHTTPSを使用してください。ローカルのHTTP接続は暗号化されず、同じネットワーク上でログイン情報が読み取られる可能性があります。"
  ],
  [
    "设置完成",
    "You’re ready",
    "設定完成",
    "設定が完了しました"
  ],
  [
    "点击工具栏图标，添加你的第一个账号。",
    "Click the toolbar icon to add your first account.",
    "點擊工具列圖示，新增你的第一個帳號。",
    "ツールバーのアイコンをクリックして、最初のアカウントを追加しましょう。"
  ],
  [
    "匹配的登录页面会出现账号提示；点击后填充，不会自动提交表单。",
    "Matching sign-in pages show saved accounts. Click one to fill the form; it is never submitted automatically.",
    "相符的登入頁面會顯示帳號提示；點擊後填入，不會自動送出表單。",
    "一致するログインページに保存済みアカウントが表示されます。クリックすると入力されますが、フォームは自動送信されません。"
  ],
  [
    "进入设置",
    "Open settings",
    "進入設定",
    "設定を開く"
  ],
  [
    "主密码只在本机校验。",
    "Your master password is verified on this device only.",
    "主密碼只在本機驗證。",
    "マスターパスワードはこの端末内でのみ確認されます。"
  ],
  [
    "锁定与使用习惯",
    "Locking & behavior",
    "鎖定與使用習慣",
    "ロックと動作"
  ],
  [
    "没有操作时自动锁定",
    "Lock after inactivity",
    "閒置時自動鎖定",
    "操作がない場合に自動ロック"
  ],
  [
    "1 分钟",
    "1 minute",
    "1 分鐘",
    "1分"
  ],
  [
    "5 分钟",
    "5 minutes",
    "5 分鐘",
    "5分"
  ],
  [
    "10 分钟",
    "10 minutes",
    "10 分鐘",
    "10分"
  ],
  [
    "30 分钟",
    "30 minutes",
    "30 分鐘",
    "30分"
  ],
  [
    "不按计时锁定",
    "No inactivity timer",
    "不依計時鎖定",
    "時間による自動ロックなし"
  ],
  [
    "系统闲置或锁屏时锁定",
    "Lock when the system is idle or locked",
    "系統閒置或鎖定螢幕時鎖定",
    "システムのアイドル時や画面ロック時にロック"
  ],
  [
    "修改后自动上传（约 5 秒后）",
    "Upload changes automatically (after about 5 seconds)",
    "修改後自動上傳（約 5 秒後）",
    "変更を自動アップロード（約5秒後）"
  ],
  [
    "在匹配的登录页面显示账号提示",
    "Show account suggestions on matching sign-in pages",
    "在相符的登入頁面顯示帳號提示",
    "一致するログインページにアカウント候補を表示"
  ],
  [
    "浏览器回收扩展后台或重启时也会锁定；解锁后可继续同步未上传的修改。",
    "The vault also locks when the browser suspends the extension worker or restarts. Unlock it to resume syncing pending changes.",
    "瀏覽器停止擴充功能背景程序或重新啟動時也會鎖定；解鎖後可繼續同步尚未上傳的修改。",
    "ブラウザが拡張機能のバックグラウンド処理を停止したときや再起動したときもロックされます。解除すると未送信の変更を同期できます。"
  ],
  [
    "服务器与同步",
    "Server & sync",
    "伺服器與同步",
    "サーバーと同期"
  ],
  [
    "读取中…",
    "Loading…",
    "讀取中…",
    "読み込み中…"
  ],
  [
    "连接 / 更新账号",
    "Connect / update account",
    "連接 / 更新帳號",
    "接続 / アカウント更新"
  ],
  [
    "测试地址",
    "Test connection",
    "測試網址",
    "接続をテスト"
  ],
  [
    "解绑",
    "Disconnect",
    "解除綁定",
    "接続を解除"
  ],
  [
    "服务器和本机密码库需要选择保留哪一份。建议先导出本机密文备份，再下载服务器版本或明确覆盖服务器。",
    "Choose which vault to keep. Export a local encrypted backup first, then download the server vault or explicitly overwrite it.",
    "請選擇要保留的密碼庫。建議先匯出本機加密備份，再下載伺服器版本或明確覆寫伺服器。",
    "どちらの保管庫を残すか選んでください。先に端末内の暗号化バックアップを書き出し、その後サーバー版をダウンロードするか、サーバー版を上書きしてください。"
  ],
  [
    "服务器密码库的主密码（跨设备恢复或更换过主密码时填写）",
    "Server vault master password (for another device or a changed password)",
    "伺服器密碼庫的主密碼（跨裝置還原或更換過主密碼時填寫）",
    "サーバーの保管庫のマスターパスワード（別の端末での復元やパスワード変更時）"
  ],
  [
    "只在本机解密，不会上传",
    "Used only for local decryption; never uploaded",
    "只在本機解密，不會上傳",
    "端末内での復号にのみ使用し、送信しません"
  ],
  [
    "上传本机修改",
    "Upload local changes",
    "上傳本機修改",
    "端末内の変更をアップロード"
  ],
  [
    "下载并替换本机",
    "Download & replace local vault",
    "下載並取代本機",
    "ダウンロードして端末内の保管庫を置換"
  ],
  [
    "用本机覆盖服务器",
    "Overwrite server with local vault",
    "以本機覆寫伺服器",
    "端末内の保管庫でサーバーを上書き"
  ],
  [
    "下载会替换本机密码库，包括主密码。双方都修改时停止自动上传，由你选择；不会自动合并。",
    "Downloading replaces the local vault, including its master password. Changes on both sides pause automatic uploads until you choose a version; they are never merged automatically.",
    "下載會取代本機密碼庫，包括主密碼。雙方都有修改時會暫停自動上傳，由你選擇；不會自動合併。",
    "ダウンロードすると、マスターパスワードを含む端末内の保管庫が置き換わります。両側に変更がある場合は自動アップロードを停止し、残す版を選ぶまで自動結合しません。"
  ],
  [
    "更换主密码",
    "Change master password",
    "更換主密碼",
    "マスターパスワードを変更"
  ],
  [
    "当前主密码",
    "Current master password",
    "目前主密碼",
    "現在のマスターパスワード"
  ],
  [
    "新主密码（至少 8 位）",
    "New master password (at least 8 characters)",
    "新主密碼（至少 8 個字元）",
    "新しいマスターパスワード（8文字以上）"
  ],
  [
    "确认新主密码",
    "Confirm new master password",
    "確認新主密碼",
    "新しいマスターパスワードを確認"
  ],
  [
    "更新主密码",
    "Update master password",
    "更新主密碼",
    "マスターパスワードを更新"
  ],
  [
    "备份与恢复",
    "Backup & restore",
    "備份與還原",
    "バックアップと復元"
  ],
  [
    "密文可用于新设备恢复。密文导入会替换本机密码库并停用同步；明文导入会追加条目。",
    "Encrypted backups can restore a vault on a new device. Importing one replaces the local vault and disables sync. Plaintext imports add entries.",
    "加密備份可用於新裝置還原。匯入加密備份會取代本機密碼庫並停用同步；明文匯入會追加項目。",
    "暗号化バックアップは新しい端末での復元にも使えます。読み込むと端末内の保管庫が置き換わり、同期が無効になります。平文ファイルの読み込みは項目を追加します。"
  ],
  [
    "导出密文备份",
    "Export encrypted backup",
    "匯出加密備份",
    "暗号化バックアップを書き出す"
  ],
  [
    "导出明文",
    "Export plaintext",
    "匯出明文",
    "平文で書き出す"
  ],
  [
    "密文备份的原主密码（明文导入可留空）",
    "Original master password for the backup (leave blank for plaintext)",
    "加密備份的原主密碼（明文匯入可留空）",
    "バックアップ作成時のマスターパスワード（平文の場合は空欄）"
  ],
  [
    "选择 JSON 文件导入",
    "Choose a JSON file to import",
    "選擇 JSON 檔案匯入",
    "読み込むJSONファイルを選択"
  ],
  [
    "清除本机数据",
    "Clear local data",
    "清除本機資料",
    "端末内のデータを削除"
  ],
  [
    "只删除当前浏览器的密码库与设置。服务器上的密文不受影响。",
    "Deletes this browser’s vault and settings only. Encrypted data on your server is unchanged.",
    "只刪除目前瀏覽器的密碼庫與設定。伺服器上的密文不受影響。",
    "このブラウザの保管庫と設定だけを削除します。サーバー上の暗号化データには影響しません。"
  ],
  [
    "清空本机密码库",
    "Delete local vault",
    "清空本機密碼庫",
    "端末内の保管庫を削除"
  ],
  [
    "开始首次设置",
    "Get started",
    "開始首次設定",
    "使い始める"
  ],
  [
    "搜索标题 / 网址 / 用户名",
    "Search title / URL / username",
    "搜尋標題 / 網址 / 使用者名稱",
    "タイトル・URL・ユーザー名を検索"
  ],
  [
    "搜索密码库",
    "Search vault",
    "搜尋密碼庫",
    "保管庫を検索"
  ],
  [
    "添加当前网站",
    "Add current website",
    "新增目前網站",
    "現在のサイトを追加"
  ],
  [
    "只看当前网站",
    "Current website only",
    "只看目前網站",
    "現在のサイトのみ"
  ],
  [
    "返回",
    "Back",
    "返回",
    "戻る"
  ],
  [
    "网址",
    "Website",
    "網址",
    "ウェブサイト"
  ],
  [
    "用户名",
    "Username",
    "使用者名稱",
    "ユーザー名"
  ],
  [
    "密码",
    "Password",
    "密碼",
    "パスワード"
  ],
  [
    "显示",
    "Show",
    "顯示",
    "表示"
  ],
  [
    "隐藏",
    "Hide",
    "隱藏",
    "非表示"
  ],
  [
    "备注",
    "Notes",
    "備註",
    "メモ"
  ],
  [
    "复制用户名",
    "Copy username",
    "複製使用者名稱",
    "ユーザー名をコピー"
  ],
  [
    "复制密码",
    "Copy password",
    "複製密碼",
    "パスワードをコピー"
  ],
  [
    "填充当前页",
    "Fill this page",
    "填入目前頁面",
    "このページに入力"
  ],
  [
    "编辑",
    "Edit",
    "編輯",
    "編集"
  ],
  [
    "删除",
    "Delete",
    "刪除",
    "削除"
  ],
  [
    "添加账号",
    "Add account",
    "新增帳號",
    "アカウントを追加"
  ],
  [
    "编辑账号",
    "Edit account",
    "編輯帳號",
    "アカウントを編集"
  ],
  [
    "标题",
    "Title",
    "標題",
    "タイトル"
  ],
  [
    "例如：公司邮箱",
    "e.g. Work email",
    "例如：公司信箱",
    "例：仕事用メール"
  ],
  [
    "网址（支持 *.example.com）",
    "Website (supports *.example.com)",
    "網址（支援 *.example.com）",
    "ウェブサイト（*.example.comに対応）"
  ],
  [
    "生成一个强密码",
    "Generate a strong password",
    "產生高強度密碼",
    "強力なパスワードを生成"
  ],
  [
    "生成",
    "Generate",
    "產生",
    "生成"
  ],
  [
    "生成长度",
    "Length",
    "產生長度",
    "文字数"
  ],
  [
    "包含符号",
    "Include symbols",
    "包含符號",
    "記号を含める"
  ],
  [
    "保存",
    "Save",
    "儲存",
    "保存"
  ],
  [
    "取消",
    "Cancel",
    "取消",
    "キャンセル"
  ],
  [
    "账号",
    "Account",
    "帳號",
    "アカウント"
  ],
  [
    "（未命名）",
    "(Untitled)",
    "（未命名）",
    "（無題）"
  ],
  [
    "（没有用户名）",
    "(No username)",
    "（沒有使用者名稱）",
    "（ユーザー名なし）"
  ],
  [
    "（空密码）",
    "(Empty password)",
    "（空密碼）",
    "（空のパスワード）"
  ],
  [
    "当前页面",
    "Current page",
    "目前頁面",
    "現在のページ"
  ],
  [
    "当前网站",
    "Current website",
    "目前網站",
    "現在のサイト"
  ],
  [
    "当前页面不支持填充",
    "This page does not support filling",
    "目前頁面不支援填入",
    "このページには入力できません"
  ],
  [
    "仅本机",
    "Local only",
    "僅本機",
    "端末内のみ"
  ],
  [
    "已锁定",
    "Locked",
    "已鎖定",
    "ロック済み"
  ],
  [
    "欢迎使用",
    "Welcome",
    "歡迎使用",
    "ようこそ"
  ],
  [
    "同步待处理",
    "Sync needs attention",
    "同步待處理",
    "同期の確認が必要"
  ],
  [
    "同步失败",
    "Sync failed",
    "同步失敗",
    "同期に失敗"
  ],
  [
    "待上传",
    "Pending upload",
    "待上傳",
    "アップロード待ち"
  ],
  [
    "明文已从界面清除",
    "Decrypted data cleared from this view",
    "明文已從介面清除",
    "復号済みデータを画面から消去しました"
  ],
  [
    "没有用户名",
    "No username",
    "沒有使用者名稱",
    "ユーザー名なし"
  ],
  [
    "很弱",
    "Very weak",
    "很弱",
    "非常に弱い"
  ],
  [
    "弱",
    "Weak",
    "弱",
    "弱い"
  ],
  [
    "一般",
    "Fair",
    "普通",
    "普通"
  ],
  [
    "强",
    "Strong",
    "強",
    "強い"
  ],
  [
    "很强",
    "Very strong",
    "很強",
    "非常に強い"
  ],
  [
    "空",
    "Empty",
    "空",
    "空"
  ],
  [
    "操作失败，请重试",
    "Could not complete the action. Please try again.",
    "操作失敗，請重試",
    "操作に失敗しました。もう一度お試しください。"
  ],
  [
    "不支持的界面语言",
    "Unsupported display language",
    "不支援的介面語言",
    "対応していない表示言語です"
  ],
  [
    "主密码不正确",
    "Incorrect master password",
    "主密碼不正確",
    "マスターパスワードが正しくありません"
  ],
  [
    "保险库已锁定，请重新解锁",
    "The vault is locked. Please unlock it again.",
    "保險庫已鎖定，請重新解鎖",
    "保管庫がロックされています。もう一度解除してください。"
  ],
  [
    "操作已取消，保险库已锁定",
    "Action cancelled because the vault was locked",
    "操作已取消，保險庫已鎖定",
    "保管庫がロックされたため、操作を取り消しました"
  ],
  [
    "请输入服务器保险库的主密码，以恢复这台设备",
    "Enter the server vault’s master password to restore it on this device",
    "請輸入伺服器保險庫的主密碼，以在此裝置還原",
    "この端末に復元するには、サーバーの保管庫のマスターパスワードを入力してください"
  ],
  [
    "请输入服务器保险库的主密码",
    "Enter the server vault’s master password",
    "請輸入伺服器保險庫的主密碼",
    "サーバーの保管庫のマスターパスワードを入力してください"
  ],
  [
    "服务器已有不同版本，请选择下载服务器版本或确认覆盖上传",
    "The server has a different version. Download it or confirm an overwrite upload.",
    "伺服器已有不同版本，請選擇下載伺服器版本或確認覆寫上傳",
    "サーバーに異なるバージョンがあります。ダウンロードするか、上書きアップロードを確認してください。"
  ],
  [
    "该账号的网址与当前页面不匹配，已取消填充",
    "This account’s website does not match the current page. Filling was cancelled.",
    "此帳號的網址與目前頁面不符，已取消填入",
    "このアカウントのURLが現在のページと一致しないため、入力を取り消しました"
  ],
  [
    "请先绑定服务器账号",
    "Connect a server account first",
    "請先綁定伺服器帳號",
    "先にサーバーのアカウントを接続してください"
  ],
  [
    "该页面无权执行此操作",
    "This page is not allowed to perform this action",
    "此頁面無權執行此操作",
    "このページではこの操作を実行できません"
  ],
  [
    "未知消息",
    "Unknown message",
    "未知訊息",
    "不明なメッセージです"
  ],
  [
    "服务器保险库格式无效",
    "The server vault has an invalid format",
    "伺服器保險庫格式無效",
    "サーバーの保管庫の形式が無効です"
  ],
  [
    "服务器响应格式无效",
    "The server returned an invalid response",
    "伺服器回應格式無效",
    "サーバーからの応答形式が無効です"
  ],
  [
    "本机同步版本无效",
    "The local sync version is invalid",
    "本機同步版本無效",
    "端末内の同期バージョンが無効です"
  ],
  [
    "保险库密文无效或超过 1 MB",
    "The encrypted vault is invalid or exceeds 1 MB",
    "保險庫密文無效或超過 1 MB",
    "暗号化された保管庫が無効か、1 MBを超えています"
  ],
  [
    "还没填服务器地址",
    "Enter a server URL first",
    "尚未填寫伺服器網址",
    "先にサーバーのURLを入力してください"
  ],
  [
    "服务器地址无效",
    "Invalid server URL",
    "伺服器網址無效",
    "サーバーのURLが無効です"
  ],
  [
    "服务器登录已失效，请检查站点账号和密码",
    "Your server session expired. Check the server username and password.",
    "伺服器登入已失效，請檢查站點帳號和密碼",
    "サーバーのセッションが切れました。ユーザー名とパスワードを確認してください。"
  ],
  [
    "站点账号或密码不正确",
    "Incorrect server username or password",
    "站點帳號或密碼不正確",
    "サーバーのユーザー名またはパスワードが正しくありません"
  ],
  [
    "服务器返回 {status}",
    "The server returned {status}",
    "伺服器回傳 {status}",
    "サーバーが{status}を返しました"
  ],
  [
    "条目的{name}必须是有效文本",
    "The entry’s {name} must be valid text",
    "項目的{name}必須是有效文字",
    "項目の「{name}」には有効なテキストを指定してください"
  ],
  [
    "条目不存在",
    "Entry not found",
    "項目不存在",
    "項目が見つかりません"
  ],
  [
    "还没有创建保险库",
    "No vault has been created yet",
    "尚未建立保險庫",
    "保管庫はまだ作成されていません"
  ],
  [
    "不支持的保险库格式或版本",
    "Unsupported vault format or version",
    "不支援的保險庫格式或版本",
    "対応していない保管庫の形式またはバージョンです"
  ],
  [
    "保险库密文超过 1 MB",
    "The encrypted vault exceeds 1 MB",
    "保險庫密文超過 1 MB",
    "暗号化された保管庫が1 MBを超えています"
  ],
  [
    "保险库密文结构无效",
    "The encrypted vault structure is invalid",
    "保險庫密文結構無效",
    "暗号化された保管庫の構造が無効です"
  ],
  [
    "密码条目必须是对象",
    "Each password entry must be an object",
    "密碼項目必須是物件",
    "パスワード項目はオブジェクトである必要があります"
  ],
  [
    "标题和网址至少填一个",
    "Enter a title or a website",
    "標題和網址至少填寫一項",
    "タイトルまたはウェブサイトを入力してください"
  ],
  [
    "条目 ID 无效",
    "Invalid entry ID",
    "項目 ID 無效",
    "項目IDが無効です"
  ],
  [
    "保险库内容格式无效",
    "Invalid vault contents",
    "保險庫內容格式無效",
    "保管庫の内容の形式が無効です"
  ],
  [
    "保险库包含重复的条目 ID",
    "The vault contains duplicate entry IDs",
    "保險庫包含重複的項目 ID",
    "保管庫に重複した項目IDがあります"
  ],
  [
    "保险库服务器账号格式无效",
    "Invalid server account in the vault",
    "保險庫伺服器帳號格式無效",
    "保管庫内のサーバーアカウントの形式が無効です"
  ],
  [
    "主密码至少 8 位",
    "The master password must be at least 8 characters",
    "主密碼至少需要 8 個字元",
    "マスターパスワードは8文字以上にしてください"
  ],
  [
    "导入文件过大（最多 4 MB）",
    "The import file is too large (4 MB maximum)",
    "匯入檔案過大（最多 4 MB）",
    "読み込むファイルが大きすぎます（最大4 MB）"
  ],
  [
    "不是合法的 JSON 文件",
    "This is not a valid JSON file",
    "不是有效的 JSON 檔案",
    "有効なJSONファイルではありません"
  ],
  [
    "不是本扩展的保险库导出文件",
    "This file is not a vault export from this extension",
    "此檔案不是本擴充功能的保險庫匯出檔",
    "この拡張機能から書き出された保管庫ファイルではありません"
  ],
  [
    "认不出这个文件（既不是密文保险库，也不是明文导出）",
    "Unrecognized file: expected an encrypted vault or a plaintext export",
    "無法辨識此檔案（既不是加密保險庫，也不是明文匯出檔）",
    "ファイルを認識できません。暗号化された保管庫または平文の書き出しファイルを指定してください"
  ],
  [
    "保险库的密钥派生参数不受支持",
    "Unsupported vault key derivation parameters",
    "不支援的保險庫金鑰衍生參數",
    "保管庫の鍵導出パラメーターに対応していません"
  ],
  [
    "保险库盐值无效",
    "Invalid vault salt",
    "保險庫鹽值無效",
    "保管庫のソルトが無効です"
  ],
  [
    "保险库密文编码无效",
    "Invalid encrypted vault encoding",
    "保險庫密文編碼無效",
    "暗号化された保管庫のエンコードが無効です"
  ],
  [
    "请输入主密码（最多 4096 字符）",
    "Enter your master password (up to 4096 characters)",
    "請輸入主密碼（最多 4096 個字元）",
    "マスターパスワードを入力してください（最大4096文字）"
  ],
  [
    "网址必须是文本",
    "The website must be text",
    "網址必須是文字",
    "ウェブサイトはテキストで指定してください"
  ],
  [
    "通配网址请使用 *.example.com 格式",
    "Use *.example.com for a wildcard website",
    "萬用字元網址請使用 *.example.com 格式",
    "ワイルドカードには *.example.com の形式を使ってください"
  ],
  [
    "请输入有效的 http/https 网址或主机名",
    "Enter a valid HTTP/HTTPS URL or hostname",
    "請輸入有效的 HTTP/HTTPS 網址或主機名稱",
    "有効なHTTP/HTTPSのURLまたはホスト名を入力してください"
  ],
  [
    "请填写服务器地址",
    "Enter a server URL",
    "請填寫伺服器網址",
    "サーバーのURLを入力してください"
  ],
  [
    "服务器地址不能包含空格",
    "The server URL cannot contain spaces",
    "伺服器網址不能包含空格",
    "サーバーのURLに空白は使えません"
  ],
  [
    "地址看不懂，检查一下有没有写错",
    "Invalid URL. Check it for typos.",
    "無法辨識網址，請檢查是否輸入錯誤",
    "URLを認識できません。入力内容を確認してください。"
  ],
  [
    "请输入 http/https 服务器地址，不含账号、查询参数或片段",
    "Enter an HTTP/HTTPS server URL without credentials, query parameters or fragments",
    "請輸入 HTTP/HTTPS 伺服器網址，不含帳號、查詢參數或片段",
    "認証情報・クエリ・フラグメントを含まないHTTP/HTTPSのサーバーURLを入力してください"
  ],
  [
    "公网地址必须用 https，密码数据不能明文过网",
    "Public servers require HTTPS; password data cannot travel unencrypted",
    "公網網址必須使用 HTTPS，密碼資料不能以明文傳輸",
    "公開サーバーにはHTTPSが必要です。パスワードを暗号化せずに送信することはできません"
  ],
  [
    "服务器未返回有效 JSON",
    "The server did not return valid JSON",
    "伺服器未回傳有效 JSON",
    "サーバーから有効なJSONが返されませんでした"
  ],
  [
    "连服务器超时",
    "The server connection timed out",
    "連接伺服器逾時",
    "サーバーへの接続がタイムアウトしました"
  ],
  [
    "连不上服务器（地址 / 端口 / 网络或重定向）",
    "Cannot reach the server. Check the URL, port, network or redirects.",
    "無法連接伺服器，請檢查網址、連接埠、網路或重新導向",
    "サーバーに接続できません。URL・ポート・ネットワーク・リダイレクトを確認してください。"
  ],
  [
    "服务器健康检查未通过",
    "The server health check failed",
    "伺服器健康檢查未通過",
    "サーバーのヘルスチェックに失敗しました"
  ],
  [
    "服务器没返回有效 access_token",
    "The server did not return a valid access token",
    "伺服器未回傳有效的存取權杖",
    "サーバーから有効なアクセストークンが返されませんでした"
  ],
  [
    "服务器没有确认正确的同步版本，请重新拉取检查",
    "The server did not confirm the expected sync version. Download again to check.",
    "伺服器未確認正確的同步版本，請重新下載檢查",
    "サーバーが正しい同期バージョンを確認できませんでした。再度ダウンロードして確認してください。"
  ],
  [
    "保险库已经存在了（想换主密码请去设置页）",
    "A vault already exists. To change its master password, use Settings.",
    "保險庫已存在（如需更換主密碼，請前往設定頁）",
    "保管庫はすでに存在します。マスターパスワードの変更は設定から行ってください。"
  ],
  [
    "设置格式无效",
    "Invalid settings format",
    "設定格式無效",
    "設定の形式が無効です"
  ],
  [
    "自动锁定时间必须在 0 到 1440 分钟之间",
    "The auto-lock time must be between 0 and 1440 minutes",
    "自動鎖定時間必須介於 0 到 1440 分鐘之間",
    "自動ロック時間は0〜1440分で指定してください"
  ],
  [
    "开关设置必须是布尔值",
    "A switch setting must be true or false",
    "開關設定必須是布林值",
    "スイッチの設定には真偽値を指定してください"
  ],
  [
    "账号和密码都要填",
    "Enter both the username and password",
    "請填寫帳號和密碼",
    "ユーザー名とパスワードの両方を入力してください"
  ],
  [
    "服务器已有保险库，请选择下载恢复或确认覆盖上传",
    "A vault already exists on the server. Download it to restore, or confirm an overwrite upload.",
    "伺服器已有保險庫，請選擇下載還原或確認覆寫上傳",
    "サーバーに保管庫が存在します。ダウンロードして復元するか、上書きアップロードを確認してください。"
  ],
  [
    "密码库已锁定 · 点扩展图标解锁",
    "Vault locked · Click the extension icon to unlock",
    "密碼庫已鎖定 · 點擊擴充功能圖示解鎖",
    "保管庫はロック中 · 拡張機能のアイコンで解除"
  ],
  [
    "保存了 {count} 个账号",
    "{count} saved accounts",
    "已儲存 {count} 個帳號",
    "保存済みアカウント：{count}件"
  ],
  [
    "选择要填充的账号",
    "Choose an account to fill",
    "選擇要填入的帳號",
    "入力するアカウントを選択"
  ],
  [
    "扩展连接已断开，请刷新页面后重试",
    "The extension connection was lost. Refresh the page and try again.",
    "擴充功能連線已中斷，請重新整理頁面後重試",
    "拡張機能との接続が切れました。ページを再読み込みしてお試しください。"
  ],
  [
    "正在填充，请稍候",
    "Filling… Please wait",
    "正在填入，請稍候",
    "入力中です。お待ちください"
  ],
  [
    "这个页面里没找到可填写的密码框",
    "No writable password field was found on this page",
    "此頁面找不到可填入的密碼欄位",
    "このページに入力可能なパスワード欄が見つかりません"
  ],
  [
    "正在填充…",
    "Filling…",
    "正在填入…",
    "入力中…"
  ],
  [
    "页面或表单已变化，请重新选择账号",
    "The page or form changed. Choose the account again.",
    "頁面或表單已變更，請重新選擇帳號",
    "ページまたはフォームが変わりました。アカウントを選び直してください。"
  ],
  [
    "已填充：{title}",
    "Filled: {title}",
    "已填入：{title}",
    "入力しました：{title}"
  ],
  [
    "填充失败，请重试",
    "Filling failed. Please try again.",
    "填入失敗，請重試",
    "入力に失敗しました。もう一度お試しください。"
  ],
  [
    "这个页面里没找到可填写的密码框；嵌入的登录表单可点击框旁提示填充",
    "No writable password field was found here. For an embedded sign-in form, use the suggestion beside its password field.",
    "此頁面找不到可填入的密碼欄位；內嵌登入表單可點擊欄位旁的提示填入",
    "入力可能なパスワード欄が見つかりません。埋め込みのログインフォームには、入力欄の横にある候補から入力できます。"
  ],
  [
    "页面已变化，请重新选择账号",
    "The page changed. Choose the account again.",
    "頁面已變更，請重新選擇帳號",
    "ページが変わりました。アカウントを選び直してください。"
  ],
  [
    "密码库已锁定，请先解锁",
    "The vault is locked. Unlock it first.",
    "密碼庫已鎖定，請先解鎖",
    "保管庫がロックされています。先に解除してください。"
  ],
  [
    "该账号的网址与当前页面不匹配，未填充",
    "This account’s website does not match the current page. Nothing was filled.",
    "此帳號的網址與目前頁面不符，未填入",
    "このアカウントのURLは現在のページと一致しないため、入力しませんでした"
  ],
  [
    "填充失败，请刷新页面重试",
    "Filling failed. Refresh the page and try again.",
    "填入失敗，請重新整理頁面後重試",
    "入力に失敗しました。ページを再読み込みしてお試しください。"
  ],
  [
    "第 {step} 步 / 共 3 步",
    "Step {step} of 3",
    "第 {step} 步 / 共 3 步",
    "ステップ {step} / 3"
  ],
  [
    "强度估计：{strength}",
    "Estimated strength: {strength}",
    "強度估計：{strength}",
    "強度の目安：{strength}"
  ],
  [
    "主密码至少 8 位，建议使用较长且独特的口令",
    "Use at least 8 characters for your master password; a long, unique passphrase is recommended",
    "主密碼至少需要 8 個字元，建議使用較長且獨特的口令",
    "マスターパスワードは8文字以上にしてください。長く、他で使っていないパスフレーズをおすすめします"
  ],
  [
    "两次输入的主密码不一致",
    "The master passwords do not match",
    "兩次輸入的主密碼不一致",
    "入力したマスターパスワードが一致しません"
  ],
  [
    "正在创建…",
    "Creating…",
    "正在建立…",
    "作成中…"
  ],
  [
    "密码库已准备好，目前仅保存在当前浏览器。可以随时从设置中连接服务器。",
    "Your vault is ready and stored in this browser only. You can connect a server anytime in Settings.",
    "密碼庫已準備好，目前僅保存在此瀏覽器。可以隨時從設定中連接伺服器。",
    "保管庫ができました。現在はこのブラウザにのみ保存されています。設定からいつでもサーバーに接続できます。"
  ],
  [
    "请填写服务器地址、站点账号和站点密码",
    "Enter the server URL, username and password",
    "請填寫伺服器網址、站點帳號和站點密碼",
    "サーバーのURL・ユーザー名・パスワードを入力してください"
  ],
  [
    "正在连接…",
    "Connecting…",
    "正在連接…",
    "接続中…"
  ],
  [
    "服务器已有密码库，请输入其主密码，再下载恢复。",
    "A vault already exists on the server. Enter its master password, then download it to restore.",
    "伺服器已有密碼庫，請輸入其主密碼，再下載還原。",
    "サーバーに保管庫があります。そのマスターパスワードを入力してから、ダウンロードして復元してください。"
  ],
  [
    "服务器已连接，首份密文已上传。",
    "Server connected. Your first encrypted backup has been uploaded.",
    "伺服器已連接，首份密文已上傳。",
    "サーバーに接続し、最初の暗号化データをアップロードしました。"
  ],
  [
    "服务器已绑定。{message}",
    "Server connected. {message}",
    "伺服器已綁定。{message}",
    "サーバーを接続しました。{message}"
  ],
  [
    "可在设置中手动同步。",
    "You can sync manually in Settings.",
    "可在設定中手動同步。",
    "設定から手動で同期できます。"
  ],
  [
    "正在解锁…",
    "Unlocking…",
    "正在解鎖…",
    "ロック解除中…"
  ],
  [
    "已保存",
    "Saved",
    "已儲存",
    "保存しました"
  ],
  [
    "从未",
    "Never",
    "從未",
    "なし"
  ],
  [
    "（内网 HTTP）",
    " (local HTTP)",
    "（內網 HTTP）",
    "（ローカルHTTP）"
  ],
  [
    "服务器版本 v{version}",
    "Server version v{version}",
    "伺服器版本 v{version}",
    "サーバーのバージョン v{version}"
  ],
  [
    "上次同步：{time}",
    "Last synced: {time}",
    "上次同步：{time}",
    "前回の同期：{time}"
  ],
  [
    "本机有待上传修改",
    "Local changes are waiting to upload",
    "本機有待上傳的修改",
    "端末内に未アップロードの変更があります"
  ],
  [
    "未绑定服务器，密码库仅保存在当前浏览器。",
    "No server connected. The vault is stored in this browser only.",
    "未綁定伺服器，密碼庫僅保存在目前瀏覽器。",
    "サーバー未接続です。保管庫はこのブラウザにのみ保存されています。"
  ],
  [
    "已连接并上传密文",
    "Connected and encrypted vault uploaded",
    "已連接並上傳密文",
    "接続し、暗号化した保管庫をアップロードしました"
  ],
  [
    "已连接，请选择同步方向",
    "Connected. Choose a sync direction.",
    "已連接，請選擇同步方向",
    "接続しました。同期する方向を選んでください。"
  ],
  [
    "正在测试…",
    "Testing…",
    "正在測試…",
    "テスト中…"
  ],
  [
    "连接正常：{base}{notice}",
    "Connection successful: {base}{notice}",
    "連線正常：{base}{notice}",
    "接続成功：{base}{notice}"
  ],
  [
    "服务器没有正常响应",
    "The server did not respond correctly",
    "伺服器未正常回應",
    "サーバーから正常な応答がありません"
  ],
  [
    "解绑后保留本机密码库，停止同步；服务器密文不变。继续？",
    "Disconnect this server? Your local vault is kept, syncing stops, and the encrypted server copy is unchanged.",
    "解除綁定後會保留本機密碼庫並停止同步；伺服器密文不變。繼續？",
    "サーバーとの接続を解除しますか？端末内の保管庫を保持して同期を停止します。サーバーの暗号化データは変更されません。"
  ],
  [
    "已解绑",
    "Disconnected",
    "已解除綁定",
    "接続を解除しました"
  ],
  [
    "已恢复 {count} 条账号；以后使用服务器密码库的主密码解锁。",
    "Restored {count} accounts. Use the server vault’s master password to unlock from now on.",
    "已還原 {count} 個帳號；之後請使用伺服器密碼庫的主密碼解鎖。",
    "{count}件のアカウントを復元しました。今後はサーバーの保管庫のマスターパスワードで解除してください。"
  ],
  [
    "上传完成 · v{version}",
    "Upload complete · v{version}",
    "上傳完成 · v{version}",
    "アップロード完了 · v{version}"
  ],
  [
    "已是最新版本",
    "Already up to date",
    "已是最新版本",
    "最新の状態です"
  ],
  [
    "服务器尚无密码库，请先上传本机密文。",
    "The server has no vault yet. Upload your local encrypted vault first.",
    "伺服器尚無密碼庫，請先上傳本機密文。",
    "サーバーに保管庫がまだありません。先に端末内の暗号化データをアップロードしてください。"
  ],
  [
    "没有执行同步，请检查绑定状态",
    "No sync was performed. Check the server connection.",
    "未執行同步，請檢查綁定狀態",
    "同期は実行されませんでした。サーバーの接続状態を確認してください。"
  ],
  [
    "下载会替换本机全部条目及主密码，未上传的修改会丢失。建议先导出密文备份。继续下载？",
    "Downloading replaces all local entries and the master password. Unsynced changes will be lost. Export an encrypted backup first. Continue?",
    "下載會取代本機全部項目及主密碼，未上傳的修改將遺失。建議先匯出加密備份。繼續下載？",
    "ダウンロードすると端末内の全項目とマスターパスワードが置き換わり、未アップロードの変更は失われます。先に暗号化バックアップを書き出してください。続けますか？"
  ],
  [
    "正在下载并验证密文…",
    "Downloading and verifying encrypted data…",
    "正在下載並驗證密文…",
    "暗号化データをダウンロードして検証中…"
  ],
  [
    "正在上传…",
    "Uploading…",
    "正在上傳…",
    "アップロード中…"
  ],
  [
    "用本机密码库替换服务器版本？其他设备尚未同步到本机的修改会丢失。请确认已保留需要的备份。",
    "Replace the server vault with this device’s vault? Changes from other devices that are not on this device will be lost. Make sure you have the backups you need.",
    "以本機密碼庫取代伺服器版本？其他裝置尚未同步至本機的修改將遺失。請確認已保留需要的備份。",
    "この端末の保管庫でサーバー版を置き換えますか？この端末に未同期の他の端末の変更は失われます。必要なバックアップがあることを確認してください。"
  ],
  [
    "正在覆盖服务器版本…",
    "Overwriting the server version…",
    "正在覆寫伺服器版本…",
    "サーバー版を上書き中…"
  ],
  [
    "新主密码至少 8 位",
    "The new master password must be at least 8 characters",
    "新主密碼至少需要 8 個字元",
    "新しいマスターパスワードは8文字以上にしてください"
  ],
  [
    "两次输入的新主密码不一致",
    "The new master passwords do not match",
    "兩次輸入的新主密碼不一致",
    "新しいマスターパスワードが一致しません"
  ],
  [
    "主密码已更新。同步完成后，其他设备需使用新主密码下载恢复。",
    "Master password updated. After syncing, other devices must download and restore using the new password.",
    "主密碼已更新。同步完成後，其他裝置需使用新主密碼下載還原。",
    "マスターパスワードを更新しました。同期後、他の端末では新しいパスワードを使ってダウンロード・復元してください。"
  ],
  [
    "密文备份已导出，请保留对应的主密码。",
    "Encrypted backup exported. Keep its master password safe.",
    "加密備份已匯出，請保留對應的主密碼。",
    "暗号化バックアップを書き出しました。対応するマスターパスワードを保管してください。"
  ],
  [
    "明文文件可直接查看全部密码。确认导出？",
    "A plaintext file reveals every password. Export it?",
    "明文檔案可直接查看全部密碼。確認匯出？",
    "平文ファイルではすべてのパスワードを直接閲覧できます。書き出しますか？"
  ],
  [
    "明文已导出，请妥善处理文件。",
    "Plaintext exported. Handle the file with care.",
    "明文已匯出，請妥善處理檔案。",
    "平文で書き出しました。ファイルは慎重に取り扱ってください。"
  ],
  [
    "文件超过 4 MB，拒绝导入",
    "The file exceeds 4 MB and cannot be imported",
    "檔案超過 4 MB，無法匯入",
    "4 MBを超えるファイルは読み込めません"
  ],
  [
    "不是有效的 JSON 文件",
    "This is not a valid JSON file",
    "不是有效的 JSON 檔案",
    "有効なJSONファイルではありません"
  ],
  [
    "密文导入会替换当前密码库并停用同步。确认已备份需要保留的内容？",
    "Importing this encrypted backup replaces your current vault and disables sync. Have you backed up everything you need?",
    "匯入加密備份會取代目前密碼庫並停用同步。確認已備份需要保留的內容？",
    "暗号化バックアップを読み込むと現在の保管庫が置き換わり、同期が無効になります。必要な内容はバックアップ済みですか？"
  ],
  [
    "已导入 {count} 条账号",
    "Imported {count} accounts",
    "已匯入 {count} 個帳號",
    "{count}件のアカウントを読み込みました"
  ],
  [
    "。同步已停用，请重新绑定服务器。",
    ". Sync is disabled. Reconnect your server.",
    "。同步已停用，請重新綁定伺服器。",
    "。同期は無効になっています。サーバーを再接続してください。"
  ],
  [
    "清空当前浏览器全部密码库与设置？服务器上的密文不会被删除。",
    "Delete this browser’s vault and all settings? Encrypted data on your server will not be deleted.",
    "清空目前瀏覽器的全部密碼庫與設定？伺服器上的密文不會被刪除。",
    "このブラウザの保管庫とすべての設定を削除しますか？サーバーの暗号化データは削除されません。"
  ],
  [
    "确认已备份需要保留的数据？本机删除无法撤销。",
    "Have you backed up the data you need? Deleting local data cannot be undone.",
    "確認已備份需要保留的資料？本機刪除無法復原。",
    "必要なデータはバックアップ済みですか？端末内のデータを削除すると元に戻せません。"
  ],
  [
    "创建密码库，或从设置中恢复已有的密文备份。",
    "Create a vault, or restore an encrypted backup in Settings.",
    "建立密碼庫，或從設定中還原既有的加密備份。",
    "保管庫を作成するか、設定から暗号化バックアップを復元してください。"
  ],
  [
    "密码库已锁定，输入主密码继续。",
    "Your vault is locked. Enter your master password to continue.",
    "密碼庫已鎖定，請輸入主密碼繼續。",
    "保管庫がロックされています。マスターパスワードを入力して続けてください。"
  ],
  [
    "已连接 · v{version}",
    "Connected · v{version}",
    "已連接 · v{version}",
    "接続済み · v{version}"
  ],
  [
    "{count} 条密码",
    "{count} passwords",
    "{count} 筆密碼",
    "パスワード {count}件"
  ],
  [
    "{count} 条匹配",
    "{count} matches",
    "{count} 筆相符",
    "一致 {count}件"
  ],
  [
    "还没有保存的账号。点击「＋」添加当前网站。",
    "No accounts saved yet. Click “＋” to add this website.",
    "尚未儲存帳號。點擊「＋」新增目前網站。",
    "保存済みのアカウントはありません。「＋」で現在のサイトを追加してください。"
  ],
  [
    "没有匹配的条目，试试其他关键词或取消当前网站筛选。",
    "No matching entries. Try another keyword or turn off the current website filter.",
    "沒有相符的項目，請試試其他關鍵字或取消目前網站篩選。",
    "一致する項目がありません。別のキーワードを使うか、現在のサイトの絞り込みを解除してください。"
  ],
  [
    "填充当前页面的登录表单",
    "Fill the sign-in form on this page",
    "填入目前頁面的登入表單",
    "現在のページのログインフォームに入力"
  ],
  [
    "条目网址与当前页面不匹配",
    "This entry’s website does not match the current page",
    "項目網址與目前頁面不符",
    "項目のURLが現在のページと一致しません"
  ],
  [
    "已复制{label}",
    "Copied {label}",
    "已複製{label}",
    "{label}をコピーしました"
  ],
  [
    "当前网址不匹配，未填充",
    "The current website does not match. Nothing was filled.",
    "目前網址不符，未填入",
    "現在のURLが一致しないため、入力しませんでした"
  ],
  [
    "此页面暂不能填充；安装扩展后请先刷新页面",
    "Cannot fill this page yet. Refresh it after installing the extension.",
    "此頁面暫時無法填入；安裝擴充功能後請先重新整理頁面",
    "このページにはまだ入力できません。拡張機能のインストール後にページを再読み込みしてください"
  ],
  [
    "没有找到可填写的登录表单",
    "No writable sign-in form was found",
    "找不到可填入的登入表單",
    "入力可能なログインフォームが見つかりません"
  ],
  [
    "删除「{title}」？",
    "Delete “{title}”?",
    "刪除「{title}」？",
    "「{title}」を削除しますか？"
  ],
  [
    "用新生成的密码替换当前输入？保存后生效。",
    "Replace the current password with a generated one? The change applies when you save.",
    "以新產生的密碼取代目前輸入？儲存後生效。",
    "現在の入力を新しく生成したパスワードで置き換えますか？保存後に反映されます。"
  ],
  [
    "已生成 {length} 位密码 · {strength}",
    "Generated a {length}-character password · {strength}",
    "已產生 {length} 位密碼 · {strength}",
    "{length}文字のパスワードを生成 · {strength}"
  ],
  [
    "设置导航",
    "Settings navigation",
    "設定導覽",
    "設定のナビゲーション"
  ],
  [
    "概览",
    "Overview",
    "概覽",
    "概要"
  ],
  [
    "保存账号",
    "Save account",
    "儲存帳號",
    "アカウントを保存"
  ],
  [
    "认识你的密码库",
    "Meet your vault",
    "認識你的密碼庫",
    "保管庫を使ってみよう"
  ],
  [
    "关闭介绍",
    "Close tour",
    "關閉介紹",
    "ガイドを閉じる"
  ],
  [
    "把密码，留在你手里",
    "Keep your passwords in your hands",
    "把密碼，留在你手裡",
    "パスワードは、自分の手の中に"
  ],
  [
    "从保存到填充，让每一次登录都更从容。",
    "Save, fill, and sign in with less effort.",
    "從儲存到填入，讓每一次登入都更從容。",
    "保存から入力まで、毎回のログインをもっと簡単に。"
  ],
  [
    "本机加密保存",
    "Encrypted on your device",
    "本機加密儲存",
    "端末内で暗号化して保存"
  ],
  [
    "用一个主密码守护账号。默认仅在解锁时将密钥保留于内存；开启永久关闭自动上锁后，会在本机保存恢复密钥。",
    "Protect your accounts with one master password. By default, the key stays in memory only while unlocked. Permanently disabling automatic locking saves a recovery key on this device.",
    "以一個主密碼守護帳號。預設僅在解鎖時將金鑰保留於記憶體；開啟永久關閉自動上鎖後，會在本機儲存恢復金鑰。",
    "1つのマスターパスワードでアカウントを守ります。通常、鍵はロック解除中のみメモリに保持されます。自動ロックを常に無効にすると、この端末に復元キーを保存します。"
  ],
  [
    "匹配网站，一键填充",
    "Match the site. Fill in one click.",
    "比對網站，一鍵填入",
    "サイトが一致したら、ワンクリックで入力"
  ],
  [
    "保存网站与账号，在登录表单旁选择要填入的账号。",
    "Save a website and account, then choose it beside the sign-in form to fill.",
    "儲存網站與帳號，在登入表單旁選擇要填入的帳號。",
    "サイトとアカウントを保存し、ログインフォームの横から入力するアカウントを選べます。"
  ],
  [
    "同步，由你决定",
    "Sync on your terms",
    "同步，由你決定",
    "同期するかは、自分で決める"
  ],
  [
    "仅在本机使用，或连接自己的服务器同步密文。",
    "Keep your vault local, or sync encrypted data to your own server.",
    "僅在本機使用，或連接自己的伺服器同步密文。",
    "この端末だけで使うことも、自分のサーバーに暗号化データを同期することもできます。"
  ],
  [
    "请牢记主密码：忘记后无法找回。建议定期导出密文备份。",
    "Remember your master password: it cannot be recovered. Export encrypted backups regularly.",
    "請牢記主密碼：忘記後無法找回。建議定期匯出加密備份。",
    "マスターパスワードは忘れると復元できません。定期的に暗号化バックアップを書き出してください。"
  ],
  [
    "开始使用",
    "Get started",
    "開始使用",
    "使い始める"
  ],
  [
    "以后可以通过「使用介绍」再次查看。",
    "You can reopen this from “Quick tour” anytime.",
    "之後可透過「使用介紹」再次查看。",
    "「使い方ガイド」からいつでも見直せます。"
  ],
  [
    "无法读取介绍偏好，下次打开时可能会再次显示。",
    "Could not read your tour preference. The tour may appear again next time.",
    "無法讀取介紹偏好，下次開啟時可能再次顯示。",
    "ガイドの表示設定を読み込めませんでした。次回も表示される場合があります。"
  ]
]
export const MESSAGE_KEYS = Object.freeze(rows.map(([source]) => source))
export const TRANSLATIONS = Object.freeze({
  'zh-CN': Object.freeze(Object.fromEntries(rows.map(([source]) => [source, source]))),
  en: Object.freeze(Object.fromEntries(rows.map(([source, en]) => [source, en]))),
  'zh-TW': Object.freeze(Object.fromEntries(rows.map(([source, , traditional]) => [source, traditional]))),
  ja: Object.freeze(Object.fromEntries(rows.map(([source, , , japanese]) => [source, japanese]))),
})
