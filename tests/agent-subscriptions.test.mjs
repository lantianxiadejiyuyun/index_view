import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const agentPath = path.resolve('agent/node/index.mjs')
const code = await readFile(agentPath, 'utf8')
// Exercise the shipped single-file worker without starting its metrics listener.
const workerCode = code.slice(code.indexOf('const SUBSCRIPTION_MAX_BYTES'), code.indexOf('// ── HTTP 服务'))
let instance = 0
async function worker(options = {}) {
  const moduleText = `
    import http from 'node:http'; import https from 'node:https';
    ${options.addresses ? `const subscriptionLookup=async()=>${JSON.stringify(options.addresses)};` : "import { lookup as subscriptionLookup } from 'node:dns/promises';"}
    import { BlockList, isIP } from 'node:net';
    import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
    let REPORT_TO=${JSON.stringify(options.server ?? '')};
    let AGENT_KEY=${JSON.stringify(options.key ?? 'fixture-key')};
    const AGENT_ID='fixture-agent';
    let subscriptionApproved=${JSON.stringify(options.approved ?? true)};
    const process={env:{AGENT_SUBSCRIPTION_ALLOW_PRIVATE_NETWORK:${JSON.stringify(options.allowPrivate ? 'true' : 'false')}}};
    ${workerCode}
    export { fetchAgentSubscription, isPublicSubscriptionAddress, subscriptionTick, subscriptionErrorCode };
    export function state() { return {pending:subscriptionPending,busy:subscriptionBusy,approved:subscriptionApproved} }
    export function setState(value) {
      if ('approved' in value) subscriptionApproved=value.approved;
      if ('key' in value) AGENT_KEY=value.key;
      if (subscriptionPending && 'retryAt' in value) subscriptionPending.retry_at=value.retryAt;
    }
    // Unique module instance ${instance++}
  `
  return import(`data:text/javascript;base64,${Buffer.from(moduleText).toString('base64')}`)
}

let upstream, upstreamBase, fetcher
const upstreamHits = new Map()
before(async () => {
  fetcher = await worker()
  upstream = createServer((req, res) => {
    const route = new URL(req.url, 'http://test').pathname
    upstreamHits.set(route, (upstreamHits.get(route) ?? 0) + 1)
    if (route === '/reset') { req.socket.destroy(); return }
    if (route === '/slow') { setTimeout(() => res.end('late'), 150).unref(); return }
    if (route === '/redirect') { res.writeHead(302, { location: '/yaml' }); res.end(); return }
    if (route === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return }
    if (route === '/bad-redirect') { res.writeHead(302, { location: 'file:///private-secret' }); res.end(); return }
    if (route === '/huge') { res.writeHead(200, { 'content-length': 3 * 1024 * 1024 }); res.end(); return }
    if (route === '/chunks') { res.write('a'.repeat(800)); res.end('b'.repeat(800)); return }
    if (route === '/compressed') { res.setHeader('content-encoding', 'gzip'); res.end(gzipSync('x'.repeat(4000))); return }
    if (route === '/unknown-encoding') { res.setHeader('content-encoding', 'unknown'); res.end('body'); return }
    if (route === '/http-error') { res.writeHead(403); res.end('private-secret'); return }
    if (route === '/metadata-huge') { res.setHeader('subscription-userinfo', 'x'.repeat(1025)); res.end('body'); return }
    res.writeHead(200, { 'content-encoding': 'gzip', 'subscription-userinfo': 'upload=10; download=20; total=100; expire=2000000000' })
    res.end(gzipSync(Buffer.from('\uFEFFproxies: []\n备注: 测试\n')))
  })
  await listen(upstream)
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`
})
after(async () => { await close(upstream) })
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
async function eventually(predicate, timeout = 20_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)) }
  throw new Error('Fixture did not reach expected state before deadline')
}
const codeIs = (expected) => (error) => error.code === expected && !error.message.includes('private-secret')

test('agent subscription URL and address boundary validation blocks local and reserved targets', async () => {
  for (const value of ['file:///private-secret', 'http://a:b@public.example', 'https://example.com/#secret', 'http://[bad', 'http://example.com/\nprivate-secret']) {
    await assert.rejects(fetcher.fetchAgentSubscription(value), codeIs('INVALID_URL'))
  }
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '::1', '::ffff:8.8.8.8', 'fd00::1', '2001:db8::1']) assert.equal(fetcher.isPublicSubscriptionAddress(ip), false, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(fetcher.isPublicSubscriptionAddress(ip), true, ip)
  const before = upstreamHits.get('/yaml') ?? 0
  await assert.rejects(fetcher.fetchAgentSubscription(`${upstreamBase}/yaml`, { allowPrivate: false }), codeIs('PRIVATE_ADDRESS'))
  assert.equal(upstreamHits.get('/yaml') ?? 0, before)
})

test('agent fetch keeps original UTF-8 bytes, bounded userinfo and compressed redirects', async () => {
  const result = await fetcher.fetchAgentSubscription(`${upstreamBase}/redirect`, { allowPrivate: true })
  assert.equal(Buffer.from(result.content_base64, 'base64').toString('utf8'), '\uFEFFproxies: []\n备注: 测试\n')
  assert.equal(result.subscription_userinfo, 'upload=10; download=20; total=100; expire=2000000000')
  const huge = await fetcher.fetchAgentSubscription(`${upstreamBase}/metadata-huge`, { allowPrivate: true })
  assert.equal(huge.subscription_userinfo, null)
})

test('agent validates every DNS address and falls back only among pinned checked addresses', async () => {
  const mixed = await worker({ addresses: [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] })
  await assert.rejects(mixed.fetchAgentSubscription('http://fixture.invalid/yaml'), codeIs('PRIVATE_ADDRESS'))
  const pinned = await worker({ addresses: [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }], allowPrivate: true })
  const result = await pinned.fetchAgentSubscription(`http://fixture.invalid:${upstream.address().port}/yaml`)
  assert.equal(Buffer.from(result.content_base64, 'base64').toString('utf8'), '\uFEFFproxies: []\n备注: 测试\n')
})

test('agent fetch caps streamed, declared and decompressed bytes and normalizes error codes', async () => {
  for (const route of ['/huge', '/chunks', '/compressed']) await assert.rejects(fetcher.fetchAgentSubscription(`${upstreamBase}${route}`, { allowPrivate: true, maxBytes: 1024 }), codeIs('TOO_LARGE'))
  for (const route of ['/loop', '/bad-redirect']) await assert.rejects(fetcher.fetchAgentSubscription(`${upstreamBase}${route}`, { allowPrivate: true }), codeIs('INVALID_URL'))
  await assert.rejects(fetcher.fetchAgentSubscription(`${upstreamBase}/slow`, { allowPrivate: true, timeoutMs: 20 }), codeIs('TIMEOUT'))
  await assert.rejects(fetcher.fetchAgentSubscription(`${upstreamBase}/reset?private-secret`, { allowPrivate: true }), codeIs('CONNECTION_RESET'))
  await assert.rejects(fetcher.fetchAgentSubscription(`${upstreamBase}/unknown-encoding`, { allowPrivate: true }), codeIs('UNSUPPORTED_ENCODING'))
  await assert.rejects(fetcher.fetchAgentSubscription(`${upstreamBase}/http-error`, { allowPrivate: true }), (error) => codeIs('HTTP_ERROR')(error) && error.http_status === 403)
  assert.equal(fetcher.subscriptionErrorCode({ errors: [{ code: 'ECONNREFUSED' }] }), 'CONNECTION_REFUSED')
  assert.equal(fetcher.subscriptionErrorCode({ code: 'CERT_HAS_EXPIRED' }), 'TLS_ERROR')
  assert.equal(fetcher.subscriptionErrorCode({ code: 'ENETUNREACH' }), 'NETWORK_UNREACHABLE')
  assert.equal(fetcher.subscriptionErrorCode({ code: 'EAI_AGAIN' }), 'DNS_ERROR')
})
