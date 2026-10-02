import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { requireAuth } from '../middleware/auth.js'
import { applyNavigationAi, NavigationAiError, previewNavigationAi, undoNavigationAi } from '../lib/navigation-ai.js'
import { SubscriptionAiError } from '../lib/subscription-ai-transport.js'

export const navigationAiRoutes = new Hono<AppEnv>()
navigationAiRoutes.use('/navigation/ai/*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  await next()
})
navigationAiRoutes.onError((error, c) => {
  if (error instanceof NavigationAiError || error instanceof SubscriptionAiError) return c.json({ error: 'navigation_ai_error', message: error.message }, error.status)
  return c.json({ error: 'internal_error', message: 'AI 整理暂时不可用，请稍后重试' }, 500)
})
async function readBody(request: Request): Promise<unknown> {
  const limit = 16 * 1024
  if (Number(request.headers.get('content-length')) > limit) throw new NavigationAiError('整理请求内容过大', 413)
  const reader = request.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        void reader.cancel().catch(() => {})
        throw new NavigationAiError('整理请求内容过大', 413)
      }
      chunks.push(chunk.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
  } catch (error) {
    if (error instanceof NavigationAiError) throw error
    throw new NavigationAiError('请发送有效的 JSON 请求')
  } finally { reader.releaseLock() }
}
navigationAiRoutes.post('/navigation/ai/preview', requireAuth, async c => c.json(await previewNavigationAi(c.get('user').id, await readBody(c.req.raw))))
navigationAiRoutes.post('/navigation/ai/apply', requireAuth, async c => c.json(applyNavigationAi(c.get('user').id, await readBody(c.req.raw))))
navigationAiRoutes.post('/navigation/ai/undo', requireAuth, async c => c.json(undoNavigationAi(c.get('user').id, await readBody(c.req.raw))))
