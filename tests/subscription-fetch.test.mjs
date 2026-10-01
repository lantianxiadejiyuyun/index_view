import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { before, after, test } from 'node:test'
import { build } from 'esbuild'

let fetcher
let server
let base
let requests = 0
async function loadFixtureFetcher({ addresses, error } = {}) {
  const bundled = await build({
    entryPoints: ['app/server/src/lib/subscription-fetch.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'subscription-network-fixture', setup(builder) {
      if (addresses) {
        builder.onResolve({ filter: /^node:dns\/promises$/ }, () => ({ path: 'dns', namespace: 'fixture' }))
        builder.onLoad({ filter: /^dns$/, namespace: 'fixture' }, () => ({ contents: `export async function lookup() { return ${JSON.stringify(addresses)} }` }))
      }
      if (error) {
        builder.onResolve({ filter: /^node:http$/ }, () => ({ path: 'http', namespace: 'fixture' }))
        builder.onLoad({ filter: /^http$/, namespace: 'fixture' }, () => ({ contents: `
          import { EventEmitter } from 'node:events'
          export function request() {
            const req = new EventEmitter()
            req.end = () => queueMicrotask(() => req.emit('error', Object.assign(new Error('https://secret.invalid/feed?token=private-secret'), ${JSON.stringify(error)})))
            return req
          }
        ` }))
      }
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}
before(async () => {
  const bundled = await build({ entryPoints: ['app/server/src/lib/subscription-fetch.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  fetcher = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  server = createServer((req, res) => {
    requests++
    res.setHeader('connection', 'close')
    if (req.url.startsWith('/reset')) { req.socket.destroy(); return }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/yaml' }); res.end(); return }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return }
    if (req.url === '/bad-redirect') { res.writeHead(302, { location: 'file:///private-secret' }); res.end(); return }
    if (req.url === '/invalid-redirect') { res.writeHead(302, { location: 'http://[invalid?token=private-secret' }); res.end(); return }
    if (req.url === '/oversized') { res.writeHead(200, { 'content-length': '3000000' }); res.end(); return }
    if (req.url === '/chunks') { res.writeHead(200); res.write('a'.repeat(800)); res.end('b'.repeat(800)); return }
    if (req.url === '/compressed') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('x'.repeat(10000))); return }
    if (req.url === '/slow') { setTimeout(() => res.end('late'), 100).unref(); return }
    if (req.url.startsWith('/error')) { res.writeHead(403); res.end('upstream confidential error'); return }
    res.writeHead(200, { 'content-encoding': 'gzip', 'subscription-userinfo': 'upload=10; download=20; total=100; expire=2000000000' })
    res.end(gzipSync('proxies: []\n'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

test('subscription URLs accept only bounded HTTP(S) without credentials, fragments, or control characters', () => {
  assert.equal(fetcher.validateSubscriptionUrl(' https://example.com/feed?token=secret '), 'https://example.com/feed?token=secret')
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'https://user:secret@example.com', 'https://example.com/#secret', 'example.com', 'https://example.com/\nsecret', null]) {
    assert.throws(() => fetcher.validateSubscriptionUrl(url))
  }
})

test('public address validation rejects loopback, metadata, mapped IPv4, reserved and private networks', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '192.168.0.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '64:ff9b::a00:1']) {
    assert.equal(fetcher.isPublicSubscriptionAddress(address), false, address)
  }
  assert.equal(fetcher.isPublicSubscriptionAddress('8.8.8.8'), true)
  assert.equal(fetcher.isPublicSubscriptionAddress('2606:4700:4700::1111'), true)
})

test('private targets are blocked before any socket request unless explicitly enabled', async () => {
  const before = requests
  await assert.rejects(fetcher.fetchSubscription(`${base}/yaml`, { allowPrivate: false }), /内网或保留地址/)
  await assert.rejects(fetcher.fetchSubscription(`${base.replace('127.0.0.1', 'localhost')}/yaml`, { allowPrivate: false }), /内网或保留地址/)
  assert.equal(requests, before)
})

test('fetching follows bounded redirects, decompresses YAML and keeps upstream usage metadata', async () => {
  const result = await fetcher.fetchSubscription(`${base}/redirect`, { allowPrivate: true })
  assert.equal(result.text, 'proxies: []\n')
  assert.equal(result.subscription_userinfo, 'upload=10; download=20; total=100; expire=2000000000')
})

test('redirect loops and non-HTTP redirect targets are rejected', async () => {
  await assert.rejects(fetcher.fetchSubscription(`${base}/loop`, { allowPrivate: true }), /循环跳转/)
  await assert.rejects(fetcher.fetchSubscription(`${base}/bad-redirect`, { allowPrivate: true }), /HTTP/)
  await assert.rejects(fetcher.fetchSubscription(`${base}/invalid-redirect`, { allowPrivate: true }), (err) => {
    assert.match(err.message, /无效的跳转地址/)
    assert.doesNotMatch(err.message, /private-secret|invalid\?/)
    return true
  })
})

test('declared, streamed and decompressed content sizes are all bounded', async () => {
  for (const endpoint of ['/oversized', '/chunks', '/compressed']) {
    await assert.rejects(fetcher.fetchSubscription(base + endpoint, { allowPrivate: true, maxBytes: 1024 }), /超过|限制/)
  }
})

test('timeout and upstream failures never expose a URL token or response body', async () => {
  await assert.rejects(fetcher.fetchSubscription(`${base}/slow`, { allowPrivate: true, timeoutMs: 20 }), /超时/)
  await assert.rejects(fetcher.fetchSubscription(`${base}/error?token=super-secret`, { allowPrivate: true }), (err) => {
    assert.match(err.message, /HTTP 403/)
    assert.doesNotMatch(err.message, /super-secret|confidential/)
    return true
  })
})

test('checked DNS addresses fall back from unreachable IPv4 and IPv6 endpoints', async () => {
  for (const unavailable of [{ address: '127.0.0.2', family: 4 }, { address: '::1', family: 6 }]) {
    const fixture = await loadFixtureFetcher({ addresses: [unavailable, { address: '127.0.0.1', family: 4 }] })
    const result = await fixture.fetchSubscription(base.replace('127.0.0.1', 'subscription-fixture.invalid') + '/yaml', { allowPrivate: true, timeoutMs: 2000 })
    assert.equal(result.text, 'proxies: []\n')
    assert.match(result.subscription_userinfo, /total=100/)
  }
})

test('every resolved address is validated before enabling address fallback', async () => {
  const before = requests
  const fixture = await loadFixtureFetcher({ addresses: [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] })
  await assert.rejects(fixture.fetchSubscription(base.replace('127.0.0.1', 'subscription-fixture.invalid'), { allowPrivate: false }), /内网或保留地址/)
  assert.equal(requests, before)
})

test('real refused and reset connections receive distinct sanitized messages', async () => {
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  await assert.rejects(fetcher.fetchSubscription(`http://127.0.0.1:${port}/?token=private-secret`, { allowPrivate: true }), /拒绝连接/)
  await assert.rejects(fetcher.fetchSubscription(`${base}/reset?token=private-secret`, { allowPrivate: true }), (error) => {
    assert.match(error.message, /重置了连接/)
    assert.doesNotMatch(error.message, /private-secret|127\.0\.0\.1/)
    return true
  })
})

test('socket and aggregate errors report useful causes without leaking credentials', async () => {
  for (const [error, expected] of [
    [{ code: 'ENETUNREACH' }, /网络不可达/],
    [{ code: 'EHOSTUNREACH' }, /网络不可达/],
    [{ code: 'ETIMEDOUT' }, /超时/],
    [{ code: 'CERT_HAS_EXPIRED' }, /证书无效/],
    [{ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }, /HTTPS 握手失败/],
    [{ code: 'ENETUNREACH', errors: [{ code: 'ENETUNREACH' }, { code: 'ECONNREFUSED' }] }, /拒绝连接/],
    [{ code: 'ENETUNREACH', errors: [{ code: 'ENETUNREACH' }, { code: 'ETIMEDOUT' }] }, /超时/],
  ]) {
    const fixture = await loadFixtureFetcher({ error })
    await assert.rejects(fixture.fetchSubscription('http://127.0.0.1/feed?token=private-secret', { allowPrivate: true }), (cause) => {
      assert.match(cause.message, expected)
      assert.doesNotMatch(cause.message, /private-secret|secret\.invalid|127\.0\.0\.1/)
      return true
    })
  }
})
