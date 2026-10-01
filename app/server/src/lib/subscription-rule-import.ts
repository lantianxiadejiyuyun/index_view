import { isIP } from 'node:net'
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml'
import { normalizeRoutingRule } from './subscription-codec.js'

type Policy = 'PROXY' | 'DIRECT' | 'REJECT'
type Position = { line?: number; column?: number }
type Diagnostic = Position & { level: 'error' | 'warning' | 'info'; code: string; message: string }
export type SubscriptionRuleImport = {
  format: 'clash' | 'list' | 'payload' | 'text' | 'unknown'
  rules: string[]
  diagnostics: Diagnostic[]
  policies: Array<{ name: string; target: Policy; count: number }>
  total: number
  imported: number
  can_apply: boolean
}
type Entry = Position & { value: unknown }
const POLICIES = new Set<string>(['PROXY', 'DIRECT', 'REJECT'])
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', '<<'])
const RULE_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'GEOIP', 'SRC-GEOIP', 'IP-ASN', 'SRC-IP-ASN', 'DST-PORT', 'SRC-PORT', 'IN-PORT', 'NETWORK', 'PROCESS-NAME', 'PROCESS-PATH', 'MATCH', 'FINAL'])
const MAX_CONTENT = 1024 * 1024
const MAX_RULES = 1000
const CONTROL = /[\u0000-\u001f\u007f]/u
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
}

/** Analyze only. The result is never persisted or fetched, and partial output
 * must not be applied when can_apply is false. Original ordering is retained. */
export function importSubscriptionRules(input: unknown): SubscriptionRuleImport {
  const result: SubscriptionRuleImport = { format: 'unknown', rules: [], diagnostics: [], policies: [], total: 0, imported: 0, can_apply: false }
  let errors = 0
  let omitted = 0
  let omittedErrors = 0
  const diagnostic = (level: Diagnostic['level'], code: string, message: string, position: Position = {}): void => {
    if (level === 'error') errors++
    if (result.diagnostics.length < 99) result.diagnostics.push({ level, code, message, ...position })
    else { omitted++; if (level === 'error') omittedErrors++ }
  }
  const finish = (): SubscriptionRuleImport => {
    if (omitted) result.diagnostics.push({ level: omittedErrors ? 'error' : 'warning', code: 'DIAGNOSTICS_TRUNCATED', message: `另有 ${omitted} 条诊断未展开，其中 ${omittedErrors} 条错误；请修正后重新分析。` })
    result.imported = result.rules.length
    result.can_apply = errors === 0 && result.rules.length > 0
    return result
  }
  if (!record(input) || typeof input.content !== 'string') {
    diagnostic('error', 'INVALID_INPUT', '请提供字符串类型的规则文件内容。')
    return finish()
  }
  if (Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT) {
    diagnostic('error', 'CONTENT_TOO_LARGE', '规则文件不能超过 1 MiB。')
    return finish()
  }
  if (!input.content.trim()) {
    diagnostic('error', 'EMPTY_CONTENT', '规则文件内容为空。')
    return finish()
  }
  let defaultPolicy: Policy = 'PROXY'
  if (input.default_policy !== undefined) {
    if (typeof input.default_policy !== 'string' || !POLICIES.has(input.default_policy)) diagnostic('error', 'INVALID_DEFAULT_POLICY', '默认策略必须为 PROXY、DIRECT 或 REJECT。')
    else defaultPolicy = input.default_policy as Policy
  }
  const mappings = new Map<string, Policy>()
  if (input.policy_map !== undefined) {
    if (!record(input.policy_map) || Object.keys(input.policy_map).length > MAX_RULES) diagnostic('error', 'INVALID_POLICY_MAP', '策略映射必须为对象且不超过 1000 项。')
    else for (const [name, target] of Object.entries(input.policy_map)) {
      if (!name.trim() || name !== name.trim() || name.length > 256 || CONTROL.test(name) || FORBIDDEN_KEYS.has(name)) {
        diagnostic('error', 'INVALID_POLICY_NAME', '策略映射包含空白、过长或不安全的策略名称。')
      } else if (typeof target !== 'string' || !POLICIES.has(target)) {
        diagnostic('error', 'INVALID_POLICY_TARGET', '策略映射的目标必须为 PROXY、DIRECT 或 REJECT。')
      } else if (POLICIES.has(name)) {
        if (name !== target) diagnostic('warning', 'BUILTIN_POLICY_PRESERVED', `内置策略 ${name} 保持原义，忽略对它的重映射。`)
      } else mappings.set(name, target as Policy)
    }
  }
  if (errors) return finish()

  const content = input.content.replace(/^\uFEFF/, '')
  const rawLines = content.split(/\r?\n/)
  const firstLine = rawLines.find((line) => line.trim() && !line.trimStart().startsWith('#'))?.trim() ?? ''
  let entries: Entry[] = []
  if (/^[A-Za-z][A-Za-z0-9-]*\s*,/.test(firstLine)) {
    result.format = 'text'
    entries = rawLines.flatMap((line, index) => {
      const value = line.replace(/\s+#.*$/, '').trim()
      return !value || value.startsWith('#') ? [] : [{ value, line: index + 1, column: line.search(/\S/) + 1 }]
    })
  } else {
    const counter = new LineCounter()
    const position = (node: unknown): Position => {
      const offset = node && typeof node === 'object' && 'range' in node && Array.isArray(node.range) ? node.range[0] : undefined
      if (typeof offset !== 'number') return {}
      const found = counter.linePos(offset)
      return { line: found.line, column: found.col }
    }
    try {
      const document = parseDocument(content, { lineCounter: counter, schema: 'core', version: '1.2', customTags: [], resolveKnownTags: false, merge: false, stringKeys: true, uniqueKeys: true, prettyErrors: false, logLevel: 'silent' })
      for (const error of document.errors) {
        const found = counter.linePos(error.pos[0])
        const message = error.code === 'DUPLICATE_KEY' ? 'YAML 存在重复键，请保留唯一的 rules 或 payload 字段。'
          : error.code === 'MULTIPLE_DOCS' ? '一次只能导入一个 YAML 文档。'
          : error.code === 'TAB_AS_INDENT' ? 'YAML 缩进不能使用制表符，请改用空格。'
          : 'YAML 语法无效，请检查缩进、引号、冒号和列表结构。'
        diagnostic('error', `YAML_${error.code}`, message, { line: found.line, column: found.col })
      }
      let visited = 0
      visit(document, (key, node, parents) => {
        if (++visited > 30_000 || parents.length > 48) {
          diagnostic('error', 'STRUCTURE_LIMIT', '规则文件结构过大或嵌套过深，请只保留需要导入的规则列表。', position(node))
          return visit.BREAK
        }
        if (isAlias(node)) diagnostic('error', 'YAML_ALIAS_UNSUPPORTED', '不支持 YAML alias，请先展开引用后再导入。', position(node))
        if (node && typeof node === 'object' && 'tag' in node && node.tag) diagnostic('error', 'YAML_TAG_UNSUPPORTED', '不支持显式 YAML 标签，请移除标签后再导入。', position(node))
        if (isScalar(node) && key === 'key' && typeof node.value === 'string' && FORBIDDEN_KEYS.has(node.value)) diagnostic('error', 'YAML_KEY_UNSUPPORTED', '不支持 YAML 合并键或特殊对象键。', position(node))
      })
      for (const warning of document.warnings) {
        const found = counter.linePos(warning.pos[0])
        diagnostic('error', 'YAML_UNSUPPORTED_SYNTAX', 'YAML 使用了无法安全识别的标签或语法，请使用普通字符串列表。', { line: found.line, column: found.col })
      }
      if (errors) return finish()
      const root = document.contents
      let selected: unknown
      if (isSeq(root)) { result.format = 'list'; selected = root }
      else if (isMap(root)) {
        if (root.has('rules')) { result.format = 'clash'; selected = root.get('rules', true) }
        else if (root.has('payload')) { result.format = 'payload'; selected = root.get('payload', true) }
        else {
          diagnostic('error', 'RULE_LIST_MISSING', '未找到 rules 或 payload 列表；不会读取或下载远程 rule-providers。', position(root))
          return finish()
        }
        if (root.items.length > 1) diagnostic('info', 'OTHER_CONFIG_IGNORED', `只读取 ${result.format === 'clash' ? 'rules' : 'payload'} 列表；节点、DNS、策略组和远程 provider 等其他配置不导入。`, position(root))
      } else {
        diagnostic('error', 'UNKNOWN_FORMAT', '未识别到规则列表，请提供 rules、payload、YAML 数组或逐行规则文本。', position(root))
        return finish()
      }
      if (!isSeq(selected)) {
        diagnostic('error', 'RULE_LIST_TYPE', 'rules 或 payload 必须为字符串数组。', position(selected))
        return finish()
      }
      entries = selected.items.map((item) => ({ value: isScalar(item) ? item.value : item, ...position(item) }))
    } catch {
      diagnostic('error', 'YAML_PARSE_FAILED', 'YAML 无法解析或结构过深，请简化为规则字符串列表。')
      return finish()
    }
  }

  result.total = entries.length
  if (!entries.length) {
    diagnostic('error', 'EMPTY_RULES', '规则列表为空，没有可导入的规则。')
    return finish()
  }
  if (entries.length > MAX_RULES) {
    diagnostic('error', 'RULE_LIMIT', '输入规则不能超过 1000 条，请拆分或缩小规则范围。')
    return finish()
  }
  const policyRecords = new Map<string, { name: string; target: Policy; count: number }>()
  function policy(name: string, entry: Entry): Policy | null {
    if (!name || name.length > 256 || CONTROL.test(name) || FORBIDDEN_KEYS.has(name)) {
      diagnostic('error', 'INVALID_POLICY_NAME', '规则的策略名称为空、过长或包含不安全字符。', entryPosition(entry))
      return null
    }
    const target = POLICIES.has(name) ? name as Policy : mappings.get(name) ?? 'PROXY'
    const existing = policyRecords.get(name)
    if (existing) existing.count++
    else {
      policyRecords.set(name, { name, target, count: 1 })
      if (!POLICIES.has(name)) diagnostic(mappings.has(name) ? 'info' : 'warning', mappings.has(name) ? 'POLICY_MAPPED' : 'POLICY_DEFAULT_MAPPING', `原策略「${name}」将映射为 ${target}。${mappings.has(name) ? '' : '如需其他行为，请修改策略映射后重新分析。'}`, entryPosition(entry))
    }
    return target
  }
  let fallbackCount = 0
  const seenRules = new Map<string, number | undefined>()
  for (const [index, entry] of entries.entries()) {
    const at = entryPosition(entry)
    if (typeof entry.value !== 'string') { diagnostic('error', 'NON_STRING_RULE', '每条规则必须是字符串，不能是数字、布尔值、对象或嵌套数组。', at); continue }
    let value = entry.value.trim()
    if (!value || value.length > 1000 || CONTROL.test(value)) { diagnostic('error', 'INVALID_RULE_TEXT', '规则为空、超过 1000 个字符或包含控制字符。', at); continue }
    if (result.format === 'payload' && !value.includes(',')) {
      const ip = value.split('/')[0]!
      const family = isIP(ip)
      if (family) value = `${family === 6 ? 'IP-CIDR6' : 'IP-CIDR'},${value.includes('/') ? value : `${value}/${family === 6 ? 128 : 32}`},${defaultPolicy}`
      else if (value.includes('/')) { diagnostic('error', 'INVALID_CIDR', 'IP 范围必须使用有效 IP 和 CIDR 掩码。', at); continue }
      else if (value.startsWith('+.')) value = `DOMAIN-SUFFIX,${value.slice(2)},${defaultPolicy}`
      else if (/[*+?]/.test(value)) { diagnostic('error', 'UNSUPPORTED_DOMAIN_WILDCARD', '该域名通配规则无法无损转换为现有封装规则，请手动改写；+.example.com 可转换为 DOMAIN-SUFFIX。', at); continue }
      else value = `DOMAIN,${value},${defaultPolicy}`
    }
    const parts = value.split(',').map((part) => part.trim())
    let type = parts[0]!.toUpperCase()
    if (!RULE_TYPES.has(type)) { diagnostic('error', 'UNSUPPORTED_RULE_TYPE', '不支持该规则类型（包括 RULE-SET、逻辑组合和正则规则）；不会加载远程规则，请先展开或手动改写。', at); continue }
    if (type === 'FINAL') {
      type = 'MATCH'
      diagnostic('warning', 'FINAL_TO_MATCH', 'FINAL 已转换为等效的 MATCH 兜底规则，位置保持不变。', at)
    }
    parts[0] = type
    const targetIndex = type === 'MATCH' ? 1 : 2
    if (result.format === 'payload' && (parts.length === targetIndex || (targetIndex === 2 && parts.length === 3 && parts[2] === 'no-resolve'))) parts.splice(targetIndex, 0, defaultPolicy)
    if (parts[targetIndex] === undefined || !parts[targetIndex]) { diagnostic('error', 'MISSING_POLICY', '该规则缺少策略；普通 rules 列表需要明确的策略字段。', at); continue }
    if (type === 'MATCH') {
      fallbackCount++
      if (fallbackCount > 1) diagnostic('error', 'MULTIPLE_MATCH', '只能保留一条 MATCH/FINAL 兜底规则，不会自动删除或合并。', at)
      if (index !== entries.length - 1) diagnostic('error', 'MATCH_NOT_LAST', 'MATCH/FINAL 必须是最后一条规则；不会自动重排以免改变原有匹配顺序。', at)
    }
    const target = policy(parts[targetIndex]!, entry)
    if (!target) continue
    parts[targetIndex] = target
    try {
      const normalized = normalizeRoutingRule(parts.join(','), index, type === 'MATCH' ? index : entries.length - 1)
      if (seenRules.has(normalized)) {
        const firstLine = seenRules.get(normalized)
        diagnostic('warning', 'DUPLICATE_RULE', `此规则与${firstLine === undefined ? '前面的规则' : `第 ${firstLine} 行`}重复；已保留原始顺序和重复条目。`, at)
      } else seenRules.set(normalized, entry.line)
      result.rules.push(normalized)
    }
    catch {
      diagnostic('error', ['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR'].includes(type) ? 'INVALID_CIDR_RULE' : 'INVALID_RULE', ['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR'].includes(type)
        ? 'IP/CIDR 规则无效，请检查 IP、掩码范围和 no-resolve 参数。'
        : '规则参数无效，请检查匹配值、参数数量及 no-resolve 的适用范围。', at)
    }
  }
  if (!fallbackCount) {
    if (entries.length >= MAX_RULES) diagnostic('error', 'RULE_LIMIT', '当前已有 1000 条规则且缺少 MATCH，无法追加兜底；请至少留出一条规则的位置。')
    else {
      result.rules.push(`MATCH,${defaultPolicy}`)
      diagnostic('warning', 'MATCH_ADDED', `原文件没有 MATCH，已在末尾追加 MATCH,${defaultPolicy}。`)
    }
  }
  result.policies = [...policyRecords.values()]
  return finish()
}

function entryPosition(entry: Entry): Position {
  return { ...(entry.line === undefined ? {} : { line: entry.line }), ...(entry.column === undefined ? {} : { column: entry.column }) }
}
