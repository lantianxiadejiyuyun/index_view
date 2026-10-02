import { Hono } from 'hono'
import { readJson } from '../lib/body.js'
import {
  SubscriptionError, createSubscriptionProfile, createSubscriptionSource,
  deleteSubscriptionProfile, deleteSubscriptionSource, listSubscriptionProfiles, listSubscriptionSources,
  previewSubscriptionProfile, previewSubscriptionDraft, refreshSubscriptionSource, refreshSubscriptionSources,
  rotateSubscriptionToken, subscriptionFeed, subscriptionFormat, updateSubscriptionProfile, updateSubscriptionSource,
} from '../lib/subscriptions.js'
import { requireAuth } from '../middleware/auth.js'
import { SubscriptionRelayError, acceptSubscriptionRelay, listSubscriptionRelayNodes, pollSubscriptionRelay, readRelayBody } from '../lib/subscription-relay.js'
import type { AppEnv } from '../types.js'
import { importSubscriptionRules } from '../lib/subscription-rule-import.js'
import { generateSubscriptionAiRules, getSubscriptionAiSettings, saveSubscriptionAiSettings, testSubscriptionAi } from '../lib/subscription-ai.js'
import { SubscriptionAiError } from '../lib/subscription-ai-transport.js'

export const subscriptionRoutes = new Hono<AppEnv>()

// This includes auth errors and revoked share links. Subscription content can
// contain node credentials and must never be reused by shared HTTP caches.
for (const route of ['/subscriptions', '/subscriptions/*', '/agent/subscriptions/*']) {
  subscriptionRoutes.use(route, async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    await next()
  })
}
subscriptionRoutes.onError((err, c) => {
  if (err instanceof SubscriptionAiError) return c.json({ error: 'ai_error', message: err.message }, err.status)
  if (err instanceof SubscriptionRelayError) return c.json({ error: 'relay_error', message: err.message }, err.status)
  if (err instanceof SubscriptionError) {
    return c.json({ error: err.status === 404 ? 'not_found' : err.status === 409 ? 'conflict' : err.status === 503 ? 'unavailable' : 'bad_request', message: err.message }, err.status)
  }
  return c.json({ error: 'internal_error', message: '订阅服务暂时不可用，请稍后重试' }, 500)
})
function idOf(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new SubscriptionError('订阅 ID 无效')
  return Number(raw)
}

async function readAiBody(request: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new SubscriptionAiError('请求内容过大，请缩小规则需求', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new SubscriptionAiError('请求必须是 JSON 对象')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new SubscriptionAiError('请求内容过大，请缩小规则需求', 413)
      }
      chunks.push(chunk.value)
    }
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SubscriptionAiError('请求必须是 JSON 对象')
    return input as Record<string, unknown>
  } catch (err) {
    if (err instanceof SubscriptionAiError) throw err
    throw new SubscriptionAiError('请求必须是有效的 JSON 对象')
  } finally { reader.releaseLock() }
}

// Limit the stream itself even if a caller supplies an incorrect small length.
// JSON may expand a 1 MiB UTF-8 file into up to 6 MiB of Unicode escapes.
const IMPORT_BODY_LIMIT = 8 * 1024 * 1024
const IMPORT_TOO_LARGE = Symbol('rule-import-body-too-large')
async function readRuleImportBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > IMPORT_BODY_LIMIT) return IMPORT_TOO_LARGE
  const reader = request.body?.getReader()
  if (!reader) return {}
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > IMPORT_BODY_LIMIT) {
        void reader.cancel().catch(() => {})
        return IMPORT_TOO_LARGE
      }
      chunks.push(chunk.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
  } catch { return {} }
  finally { reader.releaseLock() }
}

subscriptionRoutes.get('/subscriptions', requireAuth, (c) => {
  const userId = c.get('user').id
  return c.json({ sources: listSubscriptionSources(userId), profiles: listSubscriptionProfiles(userId), relay_nodes: listSubscriptionRelayNodes(), server_time: Date.now() })
})
subscriptionRoutes.post('/subscriptions/rules/import', requireAuth, async (c) => {
  const input = await readRuleImportBody(c.req.raw)
  if (input === IMPORT_TOO_LARGE) return c.json({ error: 'payload_too_large', message: '规则导入请求过大，文件内容不能超过 1 MiB。' }, 413)
  return c.json(importSubscriptionRules(input))
})
subscriptionRoutes.get('/subscriptions/ai/settings', requireAuth, c => c.json({ settings: getSubscriptionAiSettings(c.get('user').id) }))
subscriptionRoutes.put('/subscriptions/ai/settings', requireAuth, async c => c.json({ settings: saveSubscriptionAiSettings(c.get('user').id, await readAiBody(c.req.raw, 16 * 1024)) }))
subscriptionRoutes.post('/subscriptions/ai/test', requireAuth, async c => c.json(await testSubscriptionAi(c.get('user').id)))
subscriptionRoutes.post('/subscriptions/ai/generate', requireAuth, async c => c.json(await generateSubscriptionAiRules(c.get('user').id, await readAiBody(c.req.raw))))
subscriptionRoutes.post('/agent/subscriptions/poll', async (c) => c.json(pollSubscriptionRelay(await readRelayBody(c), c.req.header('x-agent-key'))))
subscriptionRoutes.post('/agent/subscriptions/result', async (c) => c.json(acceptSubscriptionRelay(await readRelayBody(c), c.req.header('x-agent-key'))))
subscriptionRoutes.post('/subscriptions/sources', requireAuth, async (c) =>
  c.json({ source: createSubscriptionSource(c.get('user').id, await readJson(c)) }, 201))
subscriptionRoutes.put('/subscriptions/sources/:id', requireAuth, async (c) =>
  c.json({ source: updateSubscriptionSource(c.get('user').id, idOf(c.req.param('id')), await readJson(c)) }))
subscriptionRoutes.delete('/subscriptions/sources/:id', requireAuth, (c) => {
  deleteSubscriptionSource(c.get('user').id, idOf(c.req.param('id')))
  return c.json({ ok: true })
})
subscriptionRoutes.post('/subscriptions/sources/:id/refresh', requireAuth, async (c) =>
  c.json({ source: await refreshSubscriptionSource(c.get('user').id, idOf(c.req.param('id'))) }))
subscriptionRoutes.post('/subscriptions/refresh', requireAuth, async (c) =>
  c.json({ sources: await refreshSubscriptionSources(c.get('user').id) }))

subscriptionRoutes.post('/subscriptions/profiles', requireAuth, async (c) =>
  c.json({ profile: createSubscriptionProfile(c.get('user').id, await readJson(c)) }, 201))
subscriptionRoutes.post('/subscriptions/profiles/preview', requireAuth, async c =>
  c.json(previewSubscriptionDraft(c.get('user').id, await readAiBody(c.req.raw, 4 * 1024 * 1024), subscriptionFormat(c.req.query('format')))))
subscriptionRoutes.put('/subscriptions/profiles/:id', requireAuth, async (c) =>
  c.json({ profile: updateSubscriptionProfile(c.get('user').id, idOf(c.req.param('id')), await readJson(c)) }))
subscriptionRoutes.delete('/subscriptions/profiles/:id', requireAuth, (c) => {
  deleteSubscriptionProfile(c.get('user').id, idOf(c.req.param('id')))
  return c.json({ ok: true })
})
subscriptionRoutes.post('/subscriptions/profiles/:id/rotate-token', requireAuth, (c) =>
  c.json({ profile: rotateSubscriptionToken(c.get('user').id, idOf(c.req.param('id'))) }))
subscriptionRoutes.get('/subscriptions/profiles/:id/preview', requireAuth, (c) =>
  c.json(previewSubscriptionProfile(c.get('user').id, idOf(c.req.param('id')), subscriptionFormat(c.req.query('format')))))

subscriptionRoutes.get('/subscriptions/feed/:token', (c) => {
  const format = subscriptionFormat(c.req.query('format'))
  const output = subscriptionFeed(c.req.param('token'), format)
  c.header('Content-Type', output.content_type)
  if (output.subscription_userinfo) c.header('Subscription-Userinfo', output.subscription_userinfo)
  return c.body(output.content)
})
