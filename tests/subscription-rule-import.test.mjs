import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const tempRoot = path.resolve(tmpdir())
const workspace = mkdtempSync(path.join(tempRoot, 'hd-rule-import-'))
let analyze
before(async () => {
  const outfile = path.join(workspace, 'import.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../app/server/src/lib/subscription-rule-import.ts', import.meta.url))], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22', banner: { js: SERVER_ESM_BANNER } })
  analyze = (content, options = {}) => importer.importSubscriptionRules({ content, ...options })
  const importer = await import(pathToFileURL(outfile).href)
})
after(() => {
  assert.equal(path.dirname(workspace), tempRoot)
  assert.ok(path.basename(workspace).startsWith('hd-rule-import-'))
  rmSync(workspace, { recursive: true, force: true })
})
const codes = result => result.diagnostics.map(item => item.code)
const list = rules => JSON.stringify(rules)

test('reads only rules from a complete configuration, maps custom groups and retains order and duplicates', () => {
  const result = analyze(JSON.stringify({
    proxies: [{ name: 'not-imported', password: 'PRIVATE_FIXTURE_VALUE' }],
    'rule-providers': { remote: { url: 'https://provider.example.test/never-fetch' } },
    rules: ['DOMAIN-SUFFIX,example.test,Custom group', 'DOMAIN,ads.example.test,REJECT', 'DOMAIN-SUFFIX,example.test,Custom group', 'MATCH,DIRECT'],
  }))
  assert.equal(result.format, 'clash')
  assert.equal(result.can_apply, true)
  assert.equal(result.total, 4)
  assert.equal(result.imported, 4)
  assert.deepEqual(result.rules, ['DOMAIN-SUFFIX,example.test,PROXY', 'DOMAIN,ads.example.test,REJECT', 'DOMAIN-SUFFIX,example.test,PROXY', 'MATCH,DIRECT'])
  assert.deepEqual(result.policies, [{ name: 'Custom group', target: 'PROXY', count: 2 }, { name: 'REJECT', target: 'REJECT', count: 1 }, { name: 'DIRECT', target: 'DIRECT', count: 1 }])
  for (const code of ['OTHER_CONFIG_IGNORED', 'POLICY_DEFAULT_MAPPING', 'DUPLICATE_RULE']) assert.ok(codes(result).includes(code))
  assert.ok(!JSON.stringify(result).includes('PRIVATE_FIXTURE_VALUE'))
  assert.ok(!JSON.stringify(result).includes('never-fetch'))
})

test('supports YAML root lists and commented plain text with source line and column diagnostics', () => {
  const yaml = analyze('# comment\n- DOMAIN,a.example.test,Group\n- IP-CIDR,192.0.2.0/99,DIRECT\n- MATCH,PROXY')
  assert.equal(yaml.format, 'list')
  assert.equal(yaml.can_apply, false)
  const bad = yaml.diagnostics.find(item => item.code === 'INVALID_CIDR_RULE')
  assert.equal(bad.line, 3)
  assert.equal(bad.column, 3)
  const text = analyze('\uFEFF# heading\n  DOMAIN,a.example.test,Custom # trailing comment\n\nMATCH,PROXY\n')
  assert.equal(text.format, 'text')
  assert.equal(text.can_apply, true)
  assert.equal(text.total, 2)
  assert.deepEqual(text.rules, ['DOMAIN,a.example.test,PROXY', 'MATCH,PROXY'])
  assert.equal(text.diagnostics.find(item => item.code === 'POLICY_DEFAULT_MAPPING').line, 2)
})

test('maps unknown groups independently of defaults, accepts explicit overrides and preserves builtins', () => {
  const content = list(['DOMAIN,a.example.test,Group', 'DOMAIN,b.example.test,DIRECT'])
  const defaults = analyze(content, { default_policy: 'REJECT' })
  assert.deepEqual(defaults.rules, ['DOMAIN,a.example.test,PROXY', 'DOMAIN,b.example.test,DIRECT', 'MATCH,REJECT'])
  const mapped = analyze(content, { policy_map: { Group: 'REJECT', DIRECT: 'PROXY' }, default_policy: 'DIRECT' })
  assert.equal(mapped.can_apply, true)
  assert.deepEqual(mapped.rules, ['DOMAIN,a.example.test,REJECT', 'DOMAIN,b.example.test,DIRECT', 'MATCH,DIRECT'])
  assert.ok(codes(mapped).includes('BUILTIN_POLICY_PRESERVED'))
  assert.ok(codes(mapped).includes('POLICY_MAPPED'))
})

test('detects classical, domain and IP payload entries and supplies the requested default policy', () => {
  const result = analyze(JSON.stringify({ payload: [
    'DOMAIN,a.example.test', 'IP-CIDR,192.0.2.0/24,no-resolve', '+.example.test', 'exact.example.test',
    '198.51.100.0/24', '2001:db8::/32', '203.0.113.1', '2001:db8::1', 'GEOIP,CN,Custom',
  ] }), { default_policy: 'DIRECT' })
  assert.equal(result.format, 'payload')
  assert.equal(result.can_apply, true)
  assert.deepEqual(result.rules, [
    'DOMAIN,a.example.test,DIRECT', 'IP-CIDR,192.0.2.0/24,DIRECT,no-resolve', 'DOMAIN-SUFFIX,example.test,DIRECT',
    'DOMAIN,exact.example.test,DIRECT', 'IP-CIDR,198.51.100.0/24,DIRECT', 'IP-CIDR6,2001:db8::/32,DIRECT',
    'IP-CIDR,203.0.113.1/32,DIRECT', 'IP-CIDR6,2001:db8::1/128,DIRECT', 'GEOIP,CN,PROXY', 'MATCH,DIRECT',
  ])
  const unsupported = analyze(JSON.stringify({ payload: ['*.example.test', 'invalid/24'] }))
  assert.equal(unsupported.can_apply, false)
  assert.ok(codes(unsupported).includes('UNSUPPORTED_DOMAIN_WILDCARD'))
  assert.ok(codes(unsupported).includes('INVALID_CIDR'))
})

test('converts FINAL in place but blocks early and multiple catch-all rules without reordering', () => {
  const final = analyze('DOMAIN,a.example.test,DIRECT\nFINAL,Custom')
  assert.equal(final.can_apply, true)
  assert.deepEqual(final.rules, ['DOMAIN,a.example.test,DIRECT', 'MATCH,PROXY'])
  assert.ok(codes(final).includes('FINAL_TO_MATCH'))
  const invalid = analyze(list(['FINAL,PROXY', 'DOMAIN,a.example.test,DIRECT', 'MATCH,DIRECT']))
  assert.equal(invalid.can_apply, false)
  assert.deepEqual(invalid.rules, ['MATCH,PROXY', 'DOMAIN,a.example.test,DIRECT', 'MATCH,DIRECT'])
  assert.ok(codes(invalid).includes('MATCH_NOT_LAST'))
  assert.ok(codes(invalid).includes('MULTIPLE_MATCH'))
})

test('reports each wrong type, unsupported remote/logic rule and malformed matcher without applying partial output', () => {
  const result = analyze(list([false, 12, null, {}, [], 'RULE-SET,remote,DIRECT', 'AND,((DOMAIN,a.test)),PROXY',
    'DOMAIN-REGEX,.*test,PROXY', 'IP-CIDR,192.0.2.0/33,DIRECT', 'IP-CIDR6,2001:db8::/129,DIRECT',
    'IP-CIDR,2001:db8::/32,DIRECT', 'IP-CIDR6,192.0.2.0/24,DIRECT', 'DOMAIN,a.test', 'MATCH,PROXY']))
  assert.equal(result.can_apply, false)
  assert.equal(result.total, 14)
  assert.equal(result.diagnostics.filter(item => item.code === 'NON_STRING_RULE').length, 5)
  assert.equal(result.diagnostics.filter(item => item.code === 'UNSUPPORTED_RULE_TYPE').length, 3)
  assert.equal(result.diagnostics.filter(item => item.code === 'INVALID_CIDR_RULE').length, 4)
  assert.ok(codes(result).includes('MISSING_POLICY'))
  assert.deepEqual(result.rules, ['MATCH,PROXY'])
  assert.equal(analyze(list(['SRC-IP-CIDR,192.0.2.0/24,DIRECT', 'SRC-IP-CIDR,2001:db8::/32,DIRECT'])).can_apply, true)
})

test('returns bounded safe syntax errors with actual positions and rejects alias, tag, duplicate and merge keys', () => {
  const syntax = analyze('rules:\n  - [unclosed\n')
  assert.equal(syntax.can_apply, false)
  assert.ok(syntax.diagnostics.some(item => item.code.startsWith('YAML_') && item.line > 0 && item.column > 0))
  for (const content of [
    'a: &x [MATCH,DIRECT]\nrules: [*x]', 'rules: !!seq ["MATCH,DIRECT"]',
    'rules: ["MATCH,DIRECT"]\nrules: ["MATCH,PROXY"]', 'rules: ["MATCH,DIRECT"]\n<<: {}',
    'rules: ["MATCH,DIRECT"]\n__proto__: {}', 'rules: []\n---\nrules: []',
  ]) {
    const result = analyze(content)
    assert.equal(result.can_apply, false, content)
    assert.ok(result.diagnostics.some(item => item.level === 'error'))
  }
})

test('uses safe policy mapping keys and rejects invalid mapping schemas without prototype pollution', () => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const mapping = JSON.parse(`{"${name}":"DIRECT"}`)
    assert.equal(analyze('MATCH,PROXY', { policy_map: mapping }).can_apply, false)
    assert.equal(analyze(list([`DOMAIN,a.test,${name}`])).can_apply, false)
  }
  const own = analyze(list(['DOMAIN,a.test,toString', 'MATCH,PROXY']), { policy_map: { toString: 'DIRECT' } })
  assert.equal(own.can_apply, true)
  assert.equal(own.rules[0], 'DOMAIN,a.test,DIRECT')
  const inherited = analyze(list(['DOMAIN,a.test,toString']))
  assert.equal(inherited.rules[0], 'DOMAIN,a.test,PROXY')
  for (const options of [{ policy_map: [] }, { policy_map: { x: 'CUSTOM' } }, { default_policy: 'CUSTOM' }, { policy_map: { ' x ': 'DIRECT' } }]) assert.equal(analyze('MATCH,PROXY', options).can_apply, false)
  assert.equal({}.polluted, undefined)
})

test('bounds input bytes, item count, individual rule length and nested YAML structures', () => {
  assert.ok(codes(analyze('中'.repeat(350_000))).includes('CONTENT_TOO_LARGE'))
  assert.equal(analyze('rules: ' + '['.repeat(200) + ']'.repeat(200)).can_apply, false)
  assert.equal(analyze('DOMAIN-KEYWORD,' + 'a'.repeat(1000) + ',DIRECT').can_apply, false)
  const rules = Array.from({ length: 999 }, (_, i) => `DOMAIN,n${i}.example.test,DIRECT`)
  assert.equal(analyze(list(rules)).imported, 1000)
  assert.equal(analyze(list(rules)).can_apply, true)
  assert.equal(analyze(list([...rules, 'MATCH,PROXY'])).can_apply, true)
  const noRoom = analyze(list([...rules, 'DOMAIN,last.example.test,DIRECT']))
  assert.equal(noRoom.can_apply, false)
  assert.ok(codes(noRoom).includes('RULE_LIMIT'))
  const tooMany = analyze(list([...rules, 'DOMAIN,last.example.test,DIRECT', 'MATCH,PROXY']))
  assert.equal(tooMany.total, 1001)
  assert.equal(tooMany.can_apply, false)
  assert.ok(codes(tooMany).includes('RULE_LIMIT'))
})

test('diagnostic truncation cannot hide an error behind many earlier warnings', () => {
  const result = analyze(list([...Array.from({ length: 120 }, (_, i) => `DOMAIN,n${i}.example.test,Group${i}`), 'IP-CIDR,192.0.2.0/99,DIRECT', 'MATCH,PROXY']))
  assert.equal(result.can_apply, false)
  assert.equal(result.diagnostics.length, 100)
  assert.equal(result.diagnostics.at(-1).code, 'DIAGNOSTICS_TRUNCATED')
  assert.equal(result.diagnostics.at(-1).level, 'error')
  assert.match(result.diagnostics.at(-1).message, /1 条错误/)
})

test('rejects unknown, missing, empty and incorrectly shaped rule documents', () => {
  for (const content of ['', '# comment only', 'ordinary text', '{}', '[]', 'rules: true', 'payload: null']) assert.equal(analyze(content).can_apply, false, content)
})
