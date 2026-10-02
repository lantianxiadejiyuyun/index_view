import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

const root = path.resolve(tmpdir())
const workspace = mkdtempSync(path.join(root, 'hd-video-wallpaper-'))
const uploadDir = path.join(workspace, 'uploads')
mkdirSync(uploadDir)
let h
let token

function box(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length + 8)
  header.write(type, 4)
  return Buffer.concat([header, data])
}
function mp4(track = 'vide') {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isommp42', 'binary')),
    box('moov', box('trak', box('mdia', box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(track)]))))),
    box('mdat', Buffer.from([1, 2, 3, 4])),
  ])
}
function ebml(id, body) {
  assert.ok(body.length < 127)
  return Buffer.concat([Buffer.from(id, 'hex'), Buffer.from([0x80 | body.length]), body])
}
function webm(track = 1, docType = 'webm', unknownSegment = false) {
  const contents = Buffer.concat([
    ebml('1654ae6b', ebml('ae', ebml('83', Buffer.from([track])))),
    ebml('1f43b675', ebml('e7', Buffer.from([0]))),
  ])
  return Buffer.concat([
    ebml('1a45dfa3', ebml('4282', Buffer.from(docType))),
    unknownSegment ? Buffer.concat([Buffer.from('18538067ff', 'hex'), contents]) : ebml('18538067', contents),
  ])
}
before(async () => {
  const output = path.join(workspace, 'harness.mjs')
  await build({
    stdin: { contents: `
      export { uploadRoutes } from './src/routes/upload.ts';
      export { uploadedVideoRoutes } from './src/routes/uploaded-video.ts';
      export { settingsRoutes } from './src/routes/settings.ts';
      export { authRoutes } from './src/routes/auth.ts';
      export { detectVideoFormat } from './src/lib/video-wallpaper.ts';
      export { sql, closeDb } from './src/lib/db.ts';
      export { initDatabase } from './src/db/schema.ts';
    `, resolveDir: fileURLToPath(new URL('../app/server/', import.meta.url)), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: output,
    banner: { js: SERVER_ESM_BANNER }, define: { 'process.env.MAX_VIDEO_UPLOAD_MB': '"1"' },
    plugins: [{ name: 'isolated-video-data', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'video-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'video-fixture' }, () => ({ contents: `
        export const DB_FILE = ${JSON.stringify(path.join(workspace, 'app.db'))};
        export const UPLOAD_DIR = ${JSON.stringify(uploadDir)};
        export const REFRESH_DAYS = 30;
        export const ADMIN_USERNAME = 'video-test';
        export const ADMIN_PASSWORD = 'fixture-video-password';
        export const ENV_AGENT_TOKEN = 'fixture-video-agent';
        export const ENV_JWT_SECRET = undefined;
        export const PUBLIC_VIEW = true;
        export function ensureDirs() {}
      `, loader: 'js' }))
    } }],
  })
  h = await import(pathToFileURL(output).href)
  h.initDatabase()
  const login = await h.authRoutes.request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'video-test', password: 'fixture-video-password' }) })
  assert.equal(login.status, 200)
  token = (await login.json()).access_token
})
after(() => {
  h?.closeDb()
  assert.equal(path.dirname(path.resolve(workspace)), root)
  assert.ok(path.basename(workspace).startsWith('hd-video-wallpaper-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
})
function form(data, name = 'wallpaper.mp4', mime = 'video/mp4') {
  const body = new FormData()
  body.append('file', new File([data], name, { type: mime }))
  return body
}
function upload(body, authenticated = true, route = '/upload/video') {
  return h.uploadRoutes.request(route, { method: 'POST', headers: authenticated ? { Authorization: 'Bearer ' + token } : {}, body })
}
function request(route, init = {}) {
  return h.uploadRoutes.request(route, { ...init, headers: { Authorization: 'Bearer ' + token, ...init.headers } })
}

test('only MP4/WebM containers with video tracks are accepted, including streaming WebM', () => {
  assert.deepEqual(h.detectVideoFormat(mp4()), { ext: '.mp4', mime: 'video/mp4' })
  assert.deepEqual(h.detectVideoFormat(webm()), { ext: '.webm', mime: 'video/webm' })
  assert.equal(h.detectVideoFormat(webm(1, 'webm', true)).ext, '.webm')
  for (const data of [mp4('soun'), webm(2), webm(1, 'matroska'), mp4().subarray(0, 20), webm().subarray(0, 18), Buffer.from('<html>fake video</html>'), Buffer.from('89504e470d0a1a0a', 'hex')]) {
    assert.equal(h.detectVideoFormat(data), null)
  }
})

test('video upload requires login and rejects empty/multiple/mismatched files', async () => {
  assert.equal((await upload(form(mp4()), false)).status, 401)
  assert.equal((await upload(form(Buffer.alloc(0)))).status, 400)
  assert.equal((await upload(form(mp4(), 'renamed.webm'))).status, 415)
  assert.equal((await upload(form(Buffer.from('not a video')))).status, 415)
  const multiple = form(mp4())
  multiple.append('another', new File([webm()], 'another.webm', { type: 'video/webm' }))
  assert.equal((await upload(multiple)).status, 400)
  assert.deepEqual(readdirSync(uploadDir), ['derived'])
})

test('both file and multipart body sizes are bounded before storage', async () => {
  assert.equal((await upload(form(Buffer.alloc(1024 * 1024 + 1)))).status, 413)
  assert.equal((await upload(form(Buffer.alloc(1024 * 1024 + 70 * 1024)))).status, 413)
  assert.deepEqual(readdirSync(uploadDir), ['derived'])
})

test('uploaded videos use detected MIME, remain outside photo lists, and support existing deletion', async () => {
  const response = await upload(form(mp4(), 'MY WALLPAPER.MP4', 'application/octet-stream'))
  assert.equal(response.status, 201)
  const media = await response.json()
  assert.equal(media.mime, 'video/mp4')
  assert.equal(media.original_name, 'MY WALLPAPER.MP4')
  assert.equal(media.thumb_url, null)
  assert.deepEqual(readFileSync(path.join(uploadDir, media.filename)), mp4())
  const image = await upload(form(Buffer.from('image fixture'), 'picture.png', 'image/png'), true, '/upload')
  assert.equal(image.status, 201)
  const photos = await (await request('/uploads')).json()
  assert.equal(photos.total, 1)
  assert.equal(photos.uploads[0].mime, 'image/png')
  assert.equal((await (await request('/uploads?type=video')).json()).total, 1)
  assert.equal((await (await request('/uploads?type=all')).json()).total, 2)
  assert.equal((await request('/uploads/' + media.filename, { method: 'DELETE' })).status, 200)
  assert.equal(existsSync(path.join(uploadDir, media.filename)), false)
  assert.equal((await (await request('/uploads?type=video')).json()).total, 0)
})

test('a failed database insert removes the new video file', async () => {
  const beforeFiles = readdirSync(uploadDir).sort()
  h.sql.exec("CREATE TRIGGER fail_video_insert BEFORE INSERT ON uploads WHEN NEW.mime LIKE 'video/%' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END")
  h.uploadRoutes.onError((_error, c) => c.json({ error: 'fixture' }, 500))
  try { assert.equal((await upload(form(mp4()))).status, 500) }
  finally { h.sql.exec('DROP TRIGGER fail_video_insert') }
  assert.deepEqual(readdirSync(uploadDir).sort(), beforeFiles)
})

test('static videos serve MIME, HEAD, byte ranges, suffix ranges, and reject invalid ranges', async () => {
  for (const [data, name, mime] of [[mp4(), 'test.mp4', 'video/mp4'], [webm(), 'test.webm', 'video/webm']]) {
    const uploaded = await (await upload(form(data, name, mime))).json()
    const full = await h.uploadedVideoRoutes.request(uploaded.url)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), mime)
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), data)
    const head = await h.uploadedVideoRoutes.request(uploaded.url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(data.length))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    for (const [range, expected, start, end] of [
      ['bytes=0-0', data.subarray(0, 1), 0, 0],
      ['bytes=0-1', data.subarray(0, 2), 0, 1],
      ['bytes=2-7', data.subarray(2, 8), 2, 7],
      ['bytes=-4', data.subarray(-4), data.length - 4, data.length - 1],
      ['bytes=4-', data.subarray(4), 4, data.length - 1],
    ]) {
      const partial = await h.uploadedVideoRoutes.request(uploaded.url, { headers: { Range: range } })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end}/${data.length}`)
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected)
    }
    for (const range of ['bytes=999999-', 'bytes=6-2', 'bytes=-0', 'bytes=abc-def']) {
      const invalid = await h.uploadedVideoRoutes.request(uploaded.url, { headers: { Range: range } })
      assert.equal(invalid.status, 416)
      assert.equal(invalid.headers.get('content-range'), `bytes */${data.length}`)
    }
  }
  assert.equal((await h.uploadedVideoRoutes.request('/uploads/missing.mp4')).status, 404)
})

test('light and dark wallpaper types accept video without changing local theme semantics', async () => {
  const response = await h.settingsRoutes.request('/settings', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ wallpaper_light_type: 'video', wallpaper_light_value: '/uploads/example.mp4', wallpaper_dark_type: 'video', wallpaper_dark_value: 'https://example.test/dark.webm', theme: 'dark' }) })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.settings.wallpaper_light_type, 'video')
  assert.equal(result.settings.wallpaper_dark_type, 'video')
  assert.deepEqual(result.ignored, ['theme'])
})
