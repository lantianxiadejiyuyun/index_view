import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build, buildSync } from 'esbuild'
import { SERVER_ESM_BANNER } from '../scripts/server-bundle-options.mjs'

async function loadWeb(relative) {
  const output = buildSync({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' }).outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}
const { APPEARANCE_PRESETS, APPEARANCE_PRESET_IDS, normalizeAppearancePreset, appearancePresetPatch } = await loadWeb('../app/web/src/lib/appearance-presets.ts')
const { normalizeSettings, activeWallpaper } = await loadWeb('../app/web/src/lib/settings.ts')
const { GRADIENT_PRESETS } = await loadWeb('../app/web/src/lib/wallpapers.ts')
const workspace = mkdtempSync(path.join(tmpdir(), 'hd-appearance-presets-'))
let h
let token

before(async () => {
  const output = path.join(workspace, 'harness.mjs')
  await build({
    stdin: { contents: `
      export { settingsRoutes } from './src/routes/settings.ts';
      export { bootstrapRoutes } from './src/routes/bootstrap.ts';
      export { authRoutes } from './src/routes/auth.ts';
      export { sql, closeDb } from './src/lib/db.ts';
      export { initDatabase, getSetting, putSetting } from './src/db/schema.ts';
    `, resolveDir: fileURLToPath(new URL('../app/server/', import.meta.url)), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: output,
    banner: { js: SERVER_ESM_BANNER },
    plugins: [{ name: 'isolated-appearance-data', setup(builder) {
      builder.onResolve({ filter: /\/config\.js$/ }, () => ({ path: 'config', namespace: 'appearance-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'appearance-fixture' }, () => ({ contents: `
        export const DB_FILE = ${JSON.stringify(path.join(workspace, 'app.db'))};
        export const REFRESH_DAYS = 30;
        export const ADMIN_USERNAME = 'appearance-test';
        export const ADMIN_PASSWORD = 'fixture-appearance-password';
        export const ENV_AGENT_TOKEN = 'fixture-appearance-agent';
        export const ENV_JWT_SECRET = undefined;
        export const PUBLIC_VIEW = true;
        export function ensureDirs() {}
      `, loader: 'js' }))
    } }],
  })
  h = await import(pathToFileURL(output).href)
  h.initDatabase()
  const login = await h.authRoutes.request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'appearance-test', password: 'fixture-appearance-password' }) })
  assert.equal(login.status, 200)
  token = (await login.json()).access_token
})

after(() => {
  h?.closeDb()
  assert.equal(path.dirname(path.resolve(workspace)), path.resolve(tmpdir()))
  assert.ok(path.basename(workspace).startsWith('hd-appearance-presets-'))
  rmSync(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
})

function request(route, method = 'GET', body) {
  return h.settingsRoutes.request(route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('old settings retain their layout and wallpaper with classic as the missing or invalid preset fallback', () => {
  for (const value of [undefined, null, '', 'CLASSIC', 'unknown', ['desktop'], {}, 1]) {
    assert.equal(normalizeAppearancePreset(value), 'classic')
  }
  const raw = { card_size: 'lg', grid_gap: 'sm', glass: 'sm', wallpaper_light_type: 'video', wallpaper_light_value: '/uploads/saved.mp4', wallpaper_dark_type: 'url', wallpaper_dark_value: 'https://example.test/saved.jpg' }
  const settings = normalizeSettings(raw)
  assert.equal(settings.appearance_preset, 'classic')
  for (const [key, value] of Object.entries(raw)) assert.equal(settings[key], value)
  assert.equal(normalizeSettings({ appearance_preset: 'unexpected' }).appearance_preset, 'classic')
})

test('all five complete presets use existing wallpapers and never change the local light/dark preference', () => {
  assert.deepEqual(APPEARANCE_PRESET_IDS, ['classic', 'desktop', 'minimal', 'paper', 'terminal'])
  assert.deepEqual(APPEARANCE_PRESETS.map(preset => preset.id), APPEARANCE_PRESET_IDS)
  const wallpaperIds = new Set(GRADIENT_PRESETS.map(preset => preset.id))
  for (const preset of APPEARANCE_PRESETS) {
    assert.ok(preset.name && preset.description && preset.tag)
    const patch = appearancePresetPatch(preset.id, { preserveWallpaper: false })
    assert.ok(Object.values(patch).every(value => typeof value === 'string'))
    assert.ok(!('theme' in patch))
    assert.equal(patch.tone_clock, 'auto')
    assert.equal(patch.tone_heading, 'auto')
    assert.equal(patch.tone_page_title, 'auto')
    for (const theme of ['auto', 'light', 'dark']) {
      const settings = normalizeSettings({ theme, ...patch })
      assert.equal(settings.appearance_preset, preset.id)
      assert.equal(settings.theme, theme)
      for (const isDark of [false, true]) {
        const wallpaper = activeWallpaper(settings, isDark)
        assert.equal(wallpaper.type, 'gradient')
        assert.ok(wallpaperIds.has(wallpaper.value))
      }
    }
  }
})

test('preserve wallpaper keeps uploaded video, separate dark background, blur, dim and unrelated settings intact', () => {
  const current = { wallpaper_light_type: 'video', wallpaper_light_value: '/uploads/personal.mp4', wallpaper_dark_type: 'color', wallpaper_dark_value: '#010203', wallpaper_blur: '17', wallpaper_dim: '42', site_title: '个人导航', theme: 'dark' }
  for (const id of APPEARANCE_PRESET_IDS) {
    const patch = appearancePresetPatch(id, { preserveWallpaper: true })
    assert.ok(!Object.keys(patch).some(key => key.startsWith('wallpaper_')))
    const merged = { ...current, ...patch }
    for (const [key, value] of Object.entries(current)) assert.equal(merged[key], value)
    patch.appearance_preset = 'mutated'
    assert.equal(appearancePresetPatch(id, { preserveWallpaper: true }).appearance_preset, id)
  }
})

test('appearance changes require authentication', async () => {
  const response = await h.settingsRoutes.request('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appearance_preset: 'desktop' }) })
  assert.equal(response.status, 401)
})

test('all presets persist as raw strings and load through settings, public bootstrap and backup export', async () => {
  h.putSetting('theme', 'auto')
  h.putSetting('public_view', 'true')
  for (const id of APPEARANCE_PRESET_IDS) {
    const response = await request('/settings', 'PUT', { ...appearancePresetPatch(id, { preserveWallpaper: false }), theme: 'dark' })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.ok(result.applied.includes('appearance_preset'))
    assert.ok(result.ignored.includes('theme'))
    assert.equal(h.getSetting('appearance_preset'), id)
    assert.equal(h.getSetting('theme'), 'auto')
    const saved = await (await request('/settings')).json()
    assert.equal(saved.settings.appearance_preset, id)
    const bootstrapResponse = await h.bootstrapRoutes.request('/bootstrap')
    assert.equal(bootstrapResponse.status, 200)
    const bootstrap = await bootstrapResponse.json()
    assert.equal(bootstrap.settings.appearance_preset, id)
    const backup = await (await request('/export')).json()
    assert.equal(backup.settings.appearance_preset, id)
    assert.equal(backup.settings.theme, undefined)
  }
})

test('invalid preset values reject the entire settings patch without partial changes', async () => {
  const previous = h.getSetting('appearance_preset')
  h.putSetting('site_title', 'unchanged')
  for (const value of ['unknown', '', ' desktop ', 'DESKTOP', null, 42, ['desktop'], { id: 'desktop' }]) {
    const response = await request('/settings', 'PUT', { site_title: 'must not persist', appearance_preset: value })
    assert.equal(response.status, 400, JSON.stringify(value))
    assert.equal((await response.json()).error, 'invalid_value')
    assert.equal(h.getSetting('appearance_preset'), previous)
    assert.equal(h.getSetting('site_title'), 'unchanged')
  }
})

test('backup import round trips all presets while ignoring the legacy synced theme', async () => {
  h.putSetting('theme', 'auto')
  for (const id of APPEARANCE_PRESET_IDS) {
    const response = await request('/import', 'POST', {
      mode: 'replace', categories: [{ id: 1, name: `fixture-${id}` }], sites: [],
      settings: { appearance_preset: id, theme: 'dark' },
    })
    assert.equal(response.status, 200)
    assert.equal(h.getSetting('appearance_preset'), id)
    assert.equal(h.getSetting('theme'), 'auto')
    assert.equal((await (await request('/export')).json()).settings.appearance_preset, id)
  }
  const legacy = await request('/import', 'POST', { mode: 'merge', categories: [{ id: 1, name: 'legacy' }], settings: { site_subtitle: 'older backup without preset' } })
  assert.equal(legacy.status, 200)
  assert.equal(h.getSetting('appearance_preset'), 'terminal')
})

test('invalid imported presets fail before replacing categories, sites or settings', async () => {
  const categories = h.sql.all('SELECT * FROM categories ORDER BY id')
  const sites = h.sql.all('SELECT * FROM sites ORDER BY id')
  const preset = h.getSetting('appearance_preset')
  const subtitle = h.getSetting('site_subtitle')
  for (const mode of ['replace', 'merge']) {
    for (const value of ['unknown', '', null, ['desktop'], { id: 'desktop' }]) {
      const response = await request('/import', 'POST', {
        mode, categories: [{ id: 999, name: 'must not insert' }], sites: [],
        settings: { appearance_preset: value, site_subtitle: 'must not persist' },
      })
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error, 'invalid_value')
      assert.deepEqual(h.sql.all('SELECT * FROM categories ORDER BY id'), categories)
      assert.deepEqual(h.sql.all('SELECT * FROM sites ORDER BY id'), sites)
      assert.equal(h.getSetting('appearance_preset'), preset)
      assert.equal(h.getSetting('site_subtitle'), subtitle)
    }
  }
})
