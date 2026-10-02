import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'

const tempRoot = path.resolve(tmpdir())
const workspace = mkdtempSync(path.join(tempRoot, 'hd-device-theme-test-'))
const bundleFile = path.join(workspace, 'routes.mjs')
let harness

before(async () => {
  await build({
    stdin: {
      contents: `
        export { settingsRoutes } from './src/routes/settings.ts';
        export { closeDb } from './src/lib/db.ts';
        export { initDatabase, getSetting, putSetting } from './src/db/schema.ts';
      `,
      resolveDir: fileURLToPath(new URL('../app/server/', import.meta.url)), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundleFile,
    plugins: [{
      name: 'isolated-settings',
      setup(builder) {
        builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'theme-test' }))
        builder.onLoad({ filter: /^config$/, namespace: 'theme-test' }, () => ({
          contents: `
            export const DB_FILE = ${JSON.stringify(path.join(workspace, 'app.db'))};
            export const REFRESH_DAYS = 30;
            export const ADMIN_USERNAME = 'theme-test';
            export const ADMIN_PASSWORD = 'test-only-password';
            export const ENV_AGENT_TOKEN = 'test-only-agent-token';
            export const ENV_JWT_SECRET = undefined;
            export const PUBLIC_VIEW = true;
            export function ensureDirs() {}
          `, loader: 'js',
        }))
        // Route behavior is under test; auth is covered independently by server session tests.
        builder.onResolve({ filter: /\/middleware\/auth\.js$/ }, () => ({ path: 'auth', namespace: 'theme-test' }))
        builder.onLoad({ filter: /^auth$/, namespace: 'theme-test' }, () => ({
          contents: 'export const requireAuth = async (c, next) => next(); export const optionalAuth = requireAuth;', loader: 'js',
        }))
      },
    }],
  })
  harness = await import(pathToFileURL(bundleFile).href)
  harness.initDatabase()
  harness.putSetting('theme', 'light')
})

after(() => {
  harness?.closeDb()
  assert.equal(path.dirname(path.resolve(workspace)), tempRoot)
  assert.ok(path.basename(workspace).startsWith('hd-device-theme-test-'))
  rmSync(workspace, { recursive: true, force: true })
})

function request(url, body, method = 'PUT') {
  return harness.settingsRoutes.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

test('legacy theme-only or mixed writes are ignored without rejecting unrelated settings', async () => {
  const response = await request('/settings', { theme: 'dark' })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.applied, [])
  assert.deepEqual(result.ignored, ['theme'])
  assert.equal(harness.getSetting('theme'), 'light')
  const mixed = await request('/settings', { theme: 'invalid-legacy-value', card_size: 'lg' })
  assert.equal(mixed.status, 200)
  assert.equal(harness.getSetting('card_size'), 'lg')
  assert.equal(harness.getSetting('theme'), 'light')
})

test('backup export excludes theme and legacy backup import cannot change it', async () => {
  const response = await harness.settingsRoutes.request('/export')
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(Object.hasOwn(data.settings, 'theme'), false)
  assert.equal(data.settings.card_size, 'lg')
  const imported = await request('/import', {
    mode: 'merge', settings: { theme: 'dark', wallpaper_light_value: 'paper' },
    categories: [{ id: 99, name: 'Theme fixture' }], sites: [],
  }, 'POST')
  assert.equal(imported.status, 200)
  assert.equal(harness.getSetting('theme'), 'light')
  assert.equal(harness.getSetting('wallpaper_light_value'), 'paper')
})
