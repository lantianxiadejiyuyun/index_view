import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const tempRoot = path.resolve(tmpdir())
const workspace = mkdtempSync(path.join(tempRoot, 'hd-subscription-codec-'))
let codec
before(async () => {
  const outfile = path.join(workspace, 'codec.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../app/server/src/lib/subscription-codec.ts', import.meta.url))], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22', banner: { js: SERVER_ESM_BANNER } })
  codec = await import(pathToFileURL(outfile).href)
})
after(() => {
  assert.equal(path.dirname(workspace), tempRoot)
  assert.ok(path.basename(workspace).startsWith('hd-subscription-codec-'))
  rmSync(workspace, { recursive: true, force: true })
})
const ss = (name = '节点', extra = {}) => ({ name, type: 'ss', server: 'proxy.example', port: 443, cipher: 'aes-128-gcm', password: 'test-only:密钥/@', udp: true, ...extra })
const uuid = '7d563f46-cc33-4818-ad12-cc20d7e3bb13'
const rules = (input = {}) => codec.normalizeSubscriptionRules(input)
const output = (proxies, format = 'clash', settings = {}) => codec.buildSubscriptionOutput([{ id: 1, name: '来源 A', proxies }], rules(settings), format)
const getProxies = result => codec.parseSubscription(result.content).proxies

test('extracts Clash/proxy-provider YAML without losing nested or future proxy parameters', () => {
  const original = ss('nested', { 'plugin-opts': { mode: 'websocket', headers: { Host: 'tls.example' }, unknown: [true, 4, null] }, 'future-extension': { key: '值' } })
  const parsed = codec.parseSubscription(JSON.stringify({ proxies: [original], dns: { enable: true }, rules: ['MATCH,DIRECT'] }))
  assert.deepEqual(parsed.proxies, [original])
  assert.equal(parsed.warnings.length, 1)
  assert.deepEqual(getProxies(output(parsed.proxies)), [original])
})

test('rejects aliases, YAML merge keys, explicit tags, duplicate keys and invalid scalar data without exposing secrets', () => {
  const bad = [
    'a: &x [1, 2]\nproxies: *x',
    'proxies:\n- <<: {name: secret}\n  type: ss',
    'proxies: !!js/function secret-function',
    'proxies: !!seq []',
    'proxies: []\nproxies: SECRET_PASSWORD',
    'proxies: [{name: x, type: ss, server: p.example, port: 80, password: .inf}]',
    '{"proxies":[], "__proto__":{"polluted":true}}',
  ]
  for (const value of bad) assert.throws(() => codec.parseSubscription(value), error => !error.message.includes('SECRET_PASSWORD') && !error.message.includes('secret-function'))
  assert.equal({}.polluted, undefined)
})

test('bounds bytes, depth, number of nodes and warning volume', () => {
  assert.throws(() => codec.parseSubscription('x'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/)
  assert.throws(() => codec.parseSubscription('proxies: ' + '['.repeat(200) + ']'.repeat(200)), /结构|嵌套/)
  assert.throws(() => codec.parseSubscription(JSON.stringify({ proxies: Array.from({ length: 5001 }, () => ss()) })), /5000/)
  const parsed = codec.parseSubscription(['ss://' + Buffer.from('aes-128-gcm:p').toString('base64url') + '@p.example:443', ...Array.from({ length: 150 }, () => 'unknown://secret@p.example:443')].join('\n'))
  assert.equal(parsed.proxies.length, 1)
  assert.equal(parsed.warnings.length, 101)
  assert.ok(parsed.warnings.every(message => !message.includes('secret')))
})

test('rejects incomplete common-protocol YAML nodes and invalid field types', () => {
  const invalid = [
    { name: 'ss', type: 'ss', server: 'p.example', port: 443, password: 'SECRET' },
    { name: 'ss', type: 'ss', server: 'p.example', port: 443, cipher: 'aes-128-gcm' },
    { name: 'vless', type: 'vless', server: 'p.example', port: 443 },
    { name: 'vmess', type: 'vmess', server: 'p.example', port: 443, uuid, cipher: 'auto' },
    { name: 'trojan', type: 'trojan', server: 'p.example', port: 443 },
    { name: 'hy2', type: 'hysteria2', server: 'p.example', port: 443, password: 123 },
    { name: 'tuic', type: 'tuic', server: 'p.example', port: 443, uuid },
    ss('bad-bool', { udp: 'true' }), ss('bad-opts', { 'plugin-opts': 'SECRET' }),
  ]
  const result = codec.parseSubscription(JSON.stringify({ proxies: [ss('valid'), ...invalid] }))
  assert.equal(result.proxies.length, 1)
  assert.equal(result.warnings.length, invalid.length)
  assert.ok(result.warnings.every(message => !message.includes('SECRET')))
})

test('parses SIP002, SS2022 plaintext credentials and legacy whole-link base64, including IPv6', () => {
  const credential = 'aes-256-gcm:pass:@/中文'
  const legacy = `ss://${Buffer.from(credential + '@[2001:db8::1]:8388').toString('base64')}#Legacy`
  const modern = `ss://${Buffer.from(credential).toString('base64url')}@[2001:db8::1]:8388#%E8%8A%82%E7%82%B9`
  const next = 'ss://2022-blake3-aes-128-gcm:base64%2B%2F%3D@proxy.example:443#Next'
  const parsed = codec.parseSubscription([legacy, modern, next].join('\n')).proxies
  assert.equal(parsed[0].server, '2001:db8::1')
  assert.equal(parsed[0].password, 'pass:@/中文')
  assert.equal(parsed[1].name, '节点')
  assert.equal(parsed[2].password, 'base64+/=')
  const encoded = output(parsed, 'links', { deduplicate: false })
  assert.match(encoded.content, /ss:\/\/2022-blake3-aes-128-gcm:/)
  assert.deepEqual(getProxies(encoded), parsed)
})

test('parses raw and base64 URI subscriptions with Unicode names and retains usage zeros', () => {
  const raw = output([ss('日本 / 香港')], 'links').content
  assert.deepEqual(codec.parseSubscription(Buffer.from(raw).toString('base64')).proxies, codec.parseSubscription(raw).proxies)
  const usage = codec.parseSubscriptionUsage('upload=0; download=123; total=0; expire=0')
  assert.deepEqual(usage, { upload: 0, download: 123, total: 0, expires_at: 0 })
  assert.deepEqual(codec.parseSubscriptionUsage('download=10; expire=1700000000'), { upload: null, download: 10, total: null, expires_at: 1700000000000 })
  assert.equal(codec.parseSubscriptionUsage(null), null)
  assert.equal(codec.parseSubscriptionUsage('junk; total=Infinity; expire=-1'), null)
  assert.deepEqual(codec.parseSubscriptionUsage('upload=1; upload=2; total=50; expire=999999999999999999'), { upload: null, download: null, total: 50, expires_at: null })
})

test('VMess JSON preserves AEAD, TLS, WebSocket and gRPC parameters through roundtrip', () => {
  for (const extra of [
    { network: 'ws', 'ws-opts': { path: '/socket?ed=2048', headers: { Host: 'cdn.example' } } },
    { network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'my/service' } },
    {},
  ]) {
    const node = { name: 'VMess 中文', type: 'vmess', server: 'proxy.example', port: 443, uuid, alterId: 0, cipher: 'auto', tls: true, servername: 'tls.example', alpn: ['h2', 'http/1.1'], 'client-fingerprint': 'chrome', 'skip-cert-verify': false, udp: true, ...extra }
    assert.deepEqual(getProxies(output([node], 'links')), [node])
  }
  const aead = codec.parseSubscription(`vmess://${uuid}@proxy.example:80?encryption=none&security=none#Standard`).proxies[0]
  assert.equal(aead.cipher, 'none')
  assert.equal(aead.alterId, 0)
})

test('VLESS REALITY and Trojan share links preserve security and transport fields', () => {
  const nodes = [
    { name: 'Reality', type: 'vless', server: 'proxy.example', port: 443, uuid, flow: 'xtls-rprx-vision', tls: true, servername: 'tls.example', 'client-fingerprint': 'chrome', 'reality-opts': { 'public-key': 'public-key-test', 'short-id': 'abcd' }, udp: true },
    { name: 'Trojan', type: 'trojan', server: 'proxy.example', port: 443, password: 'with:@中文', sni: 'tls.example', alpn: ['h2'], 'skip-cert-verify': false, network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'cdn.example' } }, udp: true },
  ]
  assert.deepEqual(getProxies(output(nodes, 'links')), nodes)
})

test('Hysteria2 auth, obfuscation and certificate pinning roundtrip, with default port and hy2 alias', () => {
  const parsed = codec.parseSubscription('hy2://user%3Ap%2541ss@proxy.example/?obfs=salamander&obfs-password=ob%2541fs&sni=tls.example&insecure=0&pinSHA256=AB%3ACD#Hysteria').proxies[0]
  assert.equal(parsed.type, 'hysteria2')
  assert.equal(parsed.port, 443)
  assert.equal(parsed.password, 'user:p%41ss')
  assert.equal(parsed['obfs-password'], 'ob%41fs')
  assert.equal(parsed.fingerprint, 'AB:CD')
  assert.deepEqual(getProxies(output([parsed], 'links')), [parsed])
  assert.equal(codec.parseSubscription('hy2://user:@proxy.example:443').proxies[0].password, 'user:')
  assert.equal(codec.parseSubscription('hy2://@proxy.example:443').proxies[0].password, '')
  assert.equal(codec.parseSubscription('hy2://pass@中文.example:443').proxies[0].server, '中文.example')
})

test('TUIC v5 password, ALPN and congestion controller roundtrip', () => {
  const original = { name: 'TUIC', type: 'tuic', server: '2001:db8::4', port: 8443, uuid, password: 'pass:密%码', sni: 'tls.example', alpn: ['h3'], 'skip-cert-verify': false, 'congestion-controller': 'bbr' }
  assert.deepEqual(getProxies(output([original], 'links')), [original])
  const wholeAuth = encodeURIComponent(uuid + ':pass:word')
  assert.equal(codec.parseSubscription(`tuic://${wholeAuth}@proxy.example:443`).proxies[0].password, 'pass:word')
})

test('UDP remains enabled when SS, VMess, VLESS and Trojan move from YAML through share URIs back to YAML', () => {
  const originals = [
    ss('SS UDP'),
    { name: 'VMess UDP', type: 'vmess', server: 'p.example', port: 443, uuid, cipher: 'auto', alterId: 0, udp: true },
    { name: 'VLESS UDP', type: 'vless', server: 'p.example', port: 443, uuid, tls: true, udp: true },
    { name: 'Trojan UDP', type: 'trojan', server: 'p.example', port: 443, password: 'test-password', udp: true },
  ]
  const importedYaml = codec.parseSubscription(JSON.stringify({ proxies: originals }))
  const exportedLinks = output(importedYaml.proxies, 'links')
  assert.deepEqual(exportedLinks.warnings, [])
  const importedLinks = codec.parseSubscription(exportedLinks.content)
  assert.deepEqual(importedLinks.proxies, originals)
  const finalYaml = getProxies(output(importedLinks.proxies))
  assert.deepEqual(finalYaml, originals)
  assert.ok(finalYaml.every(node => node.udp === true))
})

test('YAML UDP defaults are preserved in YAML and their URI conversion difference is explicitly reported', () => {
  const implicit = ss('implicit')
  delete implicit.udp
  const source = codec.parseSubscription(JSON.stringify({ proxies: [implicit] })).proxies
  assert.equal(Object.hasOwn(getProxies(output(source))[0], 'udp'), false)
  const links = output(source, 'links')
  assert.equal(links.proxy_count, 1)
  assert.equal(links.warnings.length, 1)
  assert.match(links.warnings[0], /未显式设置 UDP.*默认启用 UDP/)
  assert.equal(codec.parseSubscription(links.content).proxies[0].udp, true)
  const mixed = output([ss('enabled'), ss('disabled', { udp: false })], 'links')
  assert.equal(mixed.proxy_count, 1)
  assert.match(mixed.warnings[0], /UDP 开关无法无损转换/)
  assert.throws(() => output([ss('disabled', { udp: false })], 'links'), /没有可无损导出/)
})

test('unsupported URI options are skipped with warnings instead of silently losing behavior', () => {
  const good = output([ss()], 'links').content.trim()
  const unsupported = [
    `vless://${uuid}@proxy.example:443?security=reality&pbk=key&spx=%2Fsecret`,
    `vless://${uuid}@proxy.example:443?security=tls&type=grpc&authority=example`,
    `vless://${uuid}@proxy.example:443?type=ws&path=%2F&security=tls&security=none`,
    `ss://${Buffer.from('aes-128-gcm:secret').toString('base64url')}@proxy.example:443/?plugin=v2ray-plugin`,
    'hy2://secret@proxy.example:443/?ech=secret-value',
  ]
  const result = codec.parseSubscription([good, ...unsupported].join('\n'))
  assert.equal(result.proxies.length, 1)
  assert.equal(result.warnings.length, unsupported.length)
  assert.ok(result.warnings.every(message => !message.includes('secret')))
  assert.throws(() => codec.parseSubscription(unsupported.join('\n')), /没有可用节点/)
})

test('lossy YAML to URI conversion is skipped, while Clash preserves all fields', () => {
  const nodes = [ss('compatible'), ss('plugin', { plugin: 'v2ray-plugin', 'plugin-opts': { tls: true } }), ss('udp disabled', { udp: false }), { name: 'WireGuard', type: 'wireguard', server: 'proxy.example', port: 51820, 'private-key': 'SECRET_KEY', 'public-key': 'public-key' }]
  const result = output(nodes, 'links')
  assert.equal(result.proxy_count, 1)
  assert.equal(result.warnings.length, 3)
  assert.ok(!JSON.stringify(result.warnings).includes('SECRET_KEY'))
  assert.deepEqual(getProxies(output(nodes)), nodes)
  assert.throws(() => output(nodes.slice(1), 'links'), /没有可无损导出/)
})

test('deduplication compares every field except the node name, and naming is unique and reserved-safe', () => {
  const inputs = [
    { id: 1, name: 'A', proxies: [ss('PROXY'), ss('same'), ss('changed', { password: 'different' })] },
    { id: 2, name: 'B', proxies: [ss('same', { password: 'different', 'plugin-opts': { a: 1, b: 2 } }), ss('other', { 'plugin-opts': { b: 2, a: 1 }, password: 'different' })] },
  ]
  const result = codec.buildSubscriptionOutput(inputs, rules(), 'clash')
  const proxies = getProxies(result)
  assert.equal(result.proxy_count, 3)
  assert.equal(proxies[0].name, 'PROXY (2)')
  assert.equal(new Set(proxies.map(node => node.name)).size, 3)
  assert.equal(inputs[0].proxies[0].name, 'PROXY')
  const all = codec.buildSubscriptionOutput(inputs, rules({ deduplicate: false, name_prefix: '前缀 ', append_source: true }), 'clash')
  assert.equal(all.proxy_count, 5)
  assert.match(getProxies(all)[0].name, /^前缀 PROXY \[A\]$/)
})

test('include/exclude use literal case-insensitive keywords, with protocol filtering', () => {
  const nodes = [ss('HK [A]'), ss('HK a'), ss('HK [A] expired'), { name: 'HK [A]', type: 'trojan', server: 'proxy.example', port: 443, password: 'p' }]
  const result = output(nodes, 'clash', { include: ['hk [a]'], exclude: ['expired'], protocols: ['SS'] })
  assert.equal(result.proxy_count, 1)
  assert.equal(getProxies(result)[0].name, 'HK [A]')
  assert.throws(() => output(nodes, 'clash', { include: ['no-match'] }), /没有可导出/)
})

test('dialer-proxy references follow renaming and deduplication within their own source', () => {
  const nodes = [ss('upstream'), ss('same-upstream'), ss('downstream', { password: 'next', 'dialer-proxy': 'same-upstream' })]
  const result = output(nodes, 'clash', { name_prefix: 'P ', append_source: true })
  const proxies = getProxies(result)
  assert.equal(proxies.length, 2)
  assert.equal(proxies[1]['dialer-proxy'], proxies[0].name)
  const links = output(nodes, 'links')
  assert.equal(links.proxy_count, 1)
  assert.match(links.warnings[0], /不能无损/)
})

test('missing, filtered, ambiguous and cyclic dialer dependencies never become dangling YAML references', () => {
  const nodes = [ss('ok'), ss('a', { password: 'a', 'dialer-proxy': 'b' }), ss('b', { password: 'b', 'dialer-proxy': 'a' }), ss('c', { password: 'c', 'dialer-proxy': 'a' }), ss('missing', { password: 'x', 'dialer-proxy': 'OriginalGroup' })]
  const result = output(nodes)
  assert.deepEqual(getProxies(result), [ss('ok')])
  assert.ok(result.warnings.length >= 2)
  const filtered = output([ss('filtered'), ss('kept', { password: 'k', 'dialer-proxy': 'filtered' }), ss('ok')], 'clash', { exclude: ['filtered'] })
  assert.deepEqual(getProxies(filtered), [ss('ok')])
  const ambiguous = output([ss('x'), ss('x', { password: 'other' }), ss('dependent', { password: 'd', 'dialer-proxy': 'x' })])
  assert.equal(ambiguous.proxy_count, 2)
})

test('identically named dialer references do not accidentally resolve through another subscription', () => {
  const inputs = [
    { id: 1, name: 'A', proxies: [ss('upstream', { server: 'a.example' }), ss('dependent', { password: 'next', 'dialer-proxy': 'upstream' })] },
    { id: 2, name: 'B', proxies: [ss('upstream', { server: 'b.example' }), ss('dependent', { password: 'next', 'dialer-proxy': 'upstream' })] },
  ]
  const nodes = getProxies(codec.buildSubscriptionOutput(inputs, rules(), 'clash'))
  assert.equal(nodes.length, 4)
  assert.equal(nodes[1]['dialer-proxy'], nodes[0].name)
  assert.equal(nodes[3]['dialer-proxy'], nodes[2].name)
  assert.notEqual(nodes[1]['dialer-proxy'], nodes[3]['dialer-proxy'])
})

test('normalizes defaults and accepts documented self-contained Mihomo routing rules', () => {
  assert.deepEqual(rules(), { include: [], exclude: [], protocols: [], name_prefix: '', append_source: false, deduplicate: true, rules: ['MATCH,PROXY'] })
  const routeRules = ['DOMAIN,ads.example,REJECT', 'DOMAIN-SUFFIX,example.com,PROXY', 'DOMAIN-KEYWORD,search,PROXY', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR6,2001:db8::/32,DIRECT', 'SRC-IP-CIDR,192.168.1.1/32,DIRECT', 'GEOIP,CN,DIRECT,no-resolve', 'DST-PORT,80/443/8000-9000,PROXY', 'SRC-PORT,1024-65535,DIRECT', 'PROCESS-NAME,example.exe,PROXY', 'NETWORK,UDP,DIRECT', 'MATCH,PROXY']
  const normalized = rules({ rules: routeRules })
  assert.equal(normalized.rules.at(-2), 'NETWORK,udp,DIRECT')
  assert.match(output([ss()], 'clash', normalized).content, /MATCH,PROXY/)
})

test('rejects invalid rules, unavailable providers, unsupported policies and early/missing fallbacks', () => {
  const invalid = [
    { include: 'HK' }, { deduplicate: 'false' }, { protocols: ['ss.*'] }, { name_prefix: '\n' }, { unknown: true },
    { rules: [] }, { rules: ['DOMAIN,example.com,PROXY'] },
    { rules: ['MATCH,DIRECT', 'DOMAIN,example.com,PROXY', 'MATCH,PROXY'] },
    { rules: ['MATCH,PROXY', 'MATCH,PROXY'] },
    ...['DOMAIN,example.com,Unknown', 'RULE-SET,external,PROXY', 'IP-CIDR,10.0.0.0/999,DIRECT', 'IP-CIDR,not-an-ip/24,DIRECT', 'DST-PORT,70000,PROXY', 'SRC-PORT,900-80,DIRECT', 'DOMAIN,example.com,DIRECT,no-resolve', 'GEOIP,CHINA,DIRECT', 'NETWORK,quic,PROXY', 'DOMAIN-REGEX,[,PROXY'].map(rule => ({ rules: [rule, 'MATCH,PROXY'] })),
  ]
  for (const input of invalid) assert.throws(() => rules(input), undefined, JSON.stringify(input))
})

test('base64 export reports actual node count and warns that non-default routing requires YAML', () => {
  const result = output([ss(), ss('lossy', { plugin: 'unsupported' })], 'base64', { rules: ['DOMAIN,ads.example,REJECT', 'MATCH,PROXY'] })
  assert.equal(result.proxy_count, 1)
  assert.equal(codec.parseSubscription(result.content).proxies.length, 1)
  assert.equal(result.content_type, 'text/plain; charset=utf-8')
  assert.equal(result.warnings.length, 2)
  assert.match(Buffer.from(result.content, 'base64').toString('utf8'), /^ss:\/\//)
})
