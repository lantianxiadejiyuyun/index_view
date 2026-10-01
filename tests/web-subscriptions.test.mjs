import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const result = buildSync({
  entryPoints: [fileURLToPath(new URL('../app/web/src/lib/subscriptions.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
})
const helpers = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

test('subscription usage distinguishes missing fields, zero usage, and unlimited traffic', () => {
  assert.deepEqual(helpers.usageSummary(null), { used: '未提供', total: '未提供', remaining: '未提供', ratio: null, exhausted: false })
  assert.deepEqual(helpers.usageSummary({ upload: 0, download: 0, total: 1024, expires_at: null }), { used: '0 B', total: '1 KiB', remaining: '1 KiB', ratio: 0, exhausted: false })
  const unlimited = helpers.usageSummary({ upload: 1024, download: 1024, total: 0, expires_at: 0 })
  assert.equal(unlimited.total, '不限流量')
  assert.equal(unlimited.remaining, '不限流量')
  assert.equal(unlimited.used, '2 KiB')
  assert.equal(unlimited.ratio, null)
})

test('partial or invalid counters never invent remaining traffic', () => {
  for (const upload of [null, NaN, -1, Infinity]) {
    const summary = helpers.usageSummary({ upload, download: 1024, total: 4096, expires_at: null })
    assert.equal(summary.used, '未提供')
    assert.equal(summary.remaining, '未提供')
    assert.equal(summary.ratio, null)
  }
  const overflow = helpers.usageSummary({ upload: Number.MAX_VALUE, download: Number.MAX_VALUE, total: 4096, expires_at: null })
  assert.equal(overflow.exhausted, false)
  assert.equal(overflow.remaining, '未提供')
})

test('exhausted plans clamp the meter and remaining amount without hiding actual usage', () => {
  const exhausted = helpers.usageSummary({ upload: 1024, download: 3072, total: 2048, expires_at: null })
  assert.equal(exhausted.used, '4 KiB')
  assert.equal(exhausted.remaining, '0 B')
  assert.equal(exhausted.ratio, 1)
  assert.equal(exhausted.exhausted, true)
})

test('expiry formatting uses millisecond timestamps and keeps unknown and unlimited distinct', () => {
  const now = 1_800_000_000_000
  assert.deepEqual(helpers.formatExpiry(null, now), { text: '未提供到期信息', state: 'missing' })
  assert.deepEqual(helpers.formatExpiry(0, now), { text: '长期有效', state: 'unlimited' })
  assert.deepEqual(helpers.formatExpiry(now, now), { text: '已到期', state: 'expired' })
  assert.deepEqual(helpers.formatExpiry(now + 90_061_000, now), { text: '剩余 1 天 01:01:01', state: 'active' })
  assert.equal(helpers.formatExpiry(now + 1, now).text, '剩余 00:00:01')
})

test('refresh status separates an in-flight fetch, paused schedules, and missing schedule data', () => {
  const source = { fetching: false, enabled: true, next_fetch_at: 11_000 }
  assert.equal(helpers.formatNextRefresh(source, 10_000), '00:00:01 后')
  assert.equal(helpers.formatNextRefresh(source, 12_000), '即将拉取')
  assert.equal(helpers.formatNextRefresh({ ...source, next_fetch_at: null }, 12_000), '等待服务器调度')
  assert.equal(helpers.formatNextRefresh({ ...source, enabled: false }, 12_000), '已暂停定时拉取')
  assert.equal(helpers.formatNextRefresh({ ...source, enabled: false, fetching: true }, 12_000), '正在拉取…')
})

test('probe refresh progress distinguishes queued work from a completed cached fetch', () => {
  const source = { name: 'Test source', fetching: true, fetch_agent_id: 2, fetch_agent_name: 'Home probe', fetch_status: 'queued', enabled: true, next_fetch_at: 11_000, last_error: 'Previous failure' }
  assert.equal(helpers.formatNextRefresh(source, 12_000), '等待探针接收')
  assert.equal(helpers.sourceRefreshFeedback(source).kind, 'info')
  assert.match(helpers.sourceRefreshFeedback(source).message, /等待回传结果/)
  const running = { ...source, fetch_status: 'fetching', enabled: false }
  assert.equal(helpers.formatNextRefresh(running, 12_000), '探针正在拉取')
  assert.equal(helpers.sourceRefreshFeedback(running).kind, 'info')
  const failed = { ...source, fetch_status: 'idle', fetching: false }
  assert.equal(helpers.sourceFetchProgress(failed), null)
  assert.equal(helpers.sourceRefreshFeedback(failed).kind, 'error')
  const done = { ...failed, last_error: null }
  assert.equal(helpers.sourceRefreshFeedback(done).kind, 'success')
  assert.match(helpers.sourceRefreshFeedback(done).message, /已更新/)
})

test('source edits retain a selected probe while legacy sources default to direct pulling', () => {
  const source = { name: 'Test source', url: 'https://example.test', note: 'Keep me', enabled: true, refresh_interval_minutes: 60 }
  assert.equal(helpers.sourceInput(source).fetch_agent_id, null)
  assert.equal(helpers.sourceFetchMethod(source), '服务器直接拉取')
  const relayed = { ...source, fetch_agent_id: 19, fetch_agent_name: 'Remote probe' }
  assert.equal(helpers.sourceInput({ ...relayed, enabled: false }).fetch_agent_id, 19)
  assert.equal(helpers.sourceFetchMethod(relayed), '探针 · Remote probe')
  assert.equal(helpers.sourceFetchMethod({ ...relayed, fetch_agent_name: null }), '探针 · #19')
})

test('relay options expose approval, upgrade, and online state without claiming readiness', () => {
  const node = { id: 19, name: 'Remote probe', approved: true, enabled: true, capable: true, online: true, last_seen_at: null }
  assert.equal(helpers.relayNodeLabel(node), 'Remote probe（订阅通道状态未知）')
  assert.equal(helpers.relayNodeLabel({ ...node, capable: false, online: false }), 'Remote probe（需要升级 · 节点心跳过期）')
  assert.equal(helpers.relayNodeLabel({ ...node, approved: false, enabled: false }), 'Remote probe（未批准 · 已停用 · 订阅通道不可用）')
})

test('relay transport state keeps WSS readiness distinct from metrics and old-server metadata', () => {
  const node = { id: 19, name: 'Remote probe', approved: true, enabled: true, capable: true, online: true, last_seen_at: null }
  assert.equal(helpers.relayTransportLabel(node), '订阅通道状态未知')
  assert.equal(helpers.relayTransportLabel({ ...node, relay_transport: null, relay_connected: false }), '待连接')
  const wss = { ...node, relay_transport: 'wss', relay_connected: true }
  assert.equal(helpers.relayTransportLabel(wss), 'WSS 已连接')
  assert.equal(helpers.relayTransportLabel({ ...wss, online: false }), 'WSS 已连接')
  assert.match(helpers.relayNodeLabel({ ...wss, online: false }), /节点心跳过期 · WSS 已连接/)
  const disconnected = { ...wss, relay_connected: false }
  assert.equal(helpers.relayTransportLabel(disconnected), 'WSS 待连接')
  assert.doesNotMatch(helpers.relayNodeLabel(disconnected), /离线/)
  assert.match(helpers.relayNodeHint(disconnected), /该状态与指标上报独立/)
  assert.equal(helpers.relayTransportLabel({ ...node, relay_transport: 'https-poll', relay_connected: false }), '旧版 HTTPS 轮询')
  assert.match(helpers.relayNodeHint({ ...node, relay_transport: 'https-poll' }), /升级至新版探针/)
  assert.equal(helpers.relayTransportLabel({ ...wss, enabled: false }), '订阅通道不可用')
  assert.match(helpers.relayNodeHint({ ...wss, capable: false }), /升级程序/)
})

test('literal keyword lines preserve regex punctuation and remove only whitespace and duplicate lines', () => {
  assert.deepEqual(helpers.splitLines(' 香港\r\n.*\n[日本]\n香港\n \n'), ['香港', '.*', '[日本]'])
  assert.deepEqual(helpers.splitLines(''), [])
})

test('routing rules retain duplicates and original order through import and profile submission', () => {
  assert.deepEqual(helpers.splitRoutingRules(' DOMAIN-SUFFIX,example.com,DIRECT\r\n\nDOMAIN-SUFFIX,example.com,DIRECT\nMATCH,PROXY '), [
    'DOMAIN-SUFFIX,example.com,DIRECT', 'DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,PROXY',
  ])
  assert.deepEqual(helpers.splitRoutingRules(' \n'), [])
})

test('source naming defaults to prepend for new profiles while preserving legacy profile choices', () => {
  assert.equal(helpers.sourceNamePosition(null), 'prepend')
  assert.equal(helpers.sourceNamePosition({}), 'none')
  assert.equal(helpers.sourceNamePosition({ append_source: false }), 'none')
  assert.equal(helpers.sourceNamePosition({ append_source: true }), 'append')
  assert.equal(helpers.sourceNamePosition({ prepend_source: true, append_source: false }), 'prepend')
  for (const [position, expected] of [
    ['prepend', { prepend_source: true, append_source: false }],
    ['append', { prepend_source: false, append_source: true }],
    ['none', { prepend_source: false, append_source: false }],
  ]) assert.deepEqual(helpers.sourceNameRuleFields(position), expected)
})

test('source naming examples place the actual source outside the custom node prefix', () => {
  assert.equal(helpers.sourceNameExample('快雷', '[日常] ', 'prepend'), '[快雷] [日常] 香港01')
  assert.equal(helpers.sourceNameExample('琉璃', '[日常] ', 'append'), '[日常] 香港01 [琉璃]')
  assert.equal(helpers.sourceNameExample('琉璃', '', 'none'), '香港01')
  assert.equal(helpers.sourceNameExample('来源 [A]', '$1 .* ', 'prepend'), '[来源 [A]] $1 .* 香港01')
})

test('profile updates send explicit source-name flags without mutating legacy rule data', () => {
  const rules = { include: [], exclude: [], protocols: [], name_prefix: '日常 ', append_source: true, deduplicate: false, rules: ['MATCH,PROXY'] }
  const profile = { name: 'Daily', note: '', source_ids: [1], rules, enabled: false }
  const input = helpers.profileInput(profile)
  assert.equal(input.rules.prepend_source, false)
  assert.equal(input.rules.append_source, true)
  assert.equal(input.rules.deduplicate, false)
  assert.equal(input.rules.name_prefix, '日常 ')
  assert.equal(Object.hasOwn(rules, 'prepend_source'), false)
  assert.notEqual(input.rules, rules)
})

test('rule imports check file size before reading and measure pasted text as UTF-8 bytes', () => {
  assert.equal(helpers.ruleImportFileError({ name: 'rules.YAML', size: 1024 * 1024 }), null)
  assert.match(helpers.ruleImportFileError({ name: 'rules.yml', size: 1024 * 1024 + 1 }), /1 MiB/)
  assert.match(helpers.ruleImportFileError({ name: 'rules.exe', size: 1 }), /yaml/)
  assert.equal(helpers.ruleImportContentError('MATCH,PROXY'), null)
  assert.match(helpers.ruleImportContentError('   \n'), /选择文件或粘贴/)
  assert.match(helpers.ruleImportContentError('规'.repeat(350_000)), /1 MiB/)
})

test('rule import application requires a complete valid result even if a partial preview exists', () => {
  const result = { format: 'text', rules: ['MATCH,PROXY'], diagnostics: [], policies: [], total: 1, imported: 1, can_apply: true }
  assert.equal(helpers.canApplyImportedRules(result), true)
  assert.equal(helpers.canApplyImportedRules({ ...result, diagnostics: [{ level: 'warning', code: 'mapped', message: 'Mapped group' }] }), true)
  assert.equal(helpers.canApplyImportedRules({ ...result, can_apply: false }), false)
  assert.equal(helpers.canApplyImportedRules({ ...result, rules: [] }), false)
  assert.equal(helpers.canApplyImportedRules({ ...result, diagnostics: [{ level: 'error', code: 'unsupported', message: 'Unsupported rule', line: 3 }] }), false)
})

test('share URLs encode the token as one path segment and preserve each requested output format', () => {
  for (const format of ['clash', 'links', 'base64']) {
    assert.equal(helpers.subscriptionFeedUrl('a/b?#token', format, 'https://example.test'), `https://example.test/api/subscriptions/feed/a%2Fb%3F%23token?format=${format}`)
  }
})

test('byte and timestamp formatting handles absent and out-of-range values', () => {
  assert.equal(helpers.formatBytes(1024 ** 3), '1 GiB')
  assert.equal(helpers.formatBytes(0.5), '0.5 B')
  assert.equal(helpers.formatBytes(-1), '未提供')
  assert.equal(helpers.formatTimestamp(null), '尚无记录')
  assert.equal(helpers.formatTimestamp(1e30), '尚无记录')
})
