import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

function bundle(relative) {
  return buildSync({
    entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).outputFiles[0].text
}
let generation = 0
const load = (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${++generation}`)
const { createDeviceTheme, DEVICE_THEME_KEY } = await load(bundle('../app/web/src/lib/device-theme.ts'))
const { appearancePresetPatch } = await load(bundle('../app/web/src/lib/appearance-presets.ts'))
const appCode = bundle('../app/web/src/store/app.ts')

function storage(initial) {
  const values = new Map(initial === undefined ? [] : [[DEVICE_THEME_KEY, initial]])
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('each browser retains its own theme across legacy settings refreshes and reloads', () => {
  const aStorage = storage('light')
  const bStorage = storage('dark')
  const a = createDeviceTheme(() => aStorage)
  const b = createDeviceTheme(() => bStorage)
  assert.equal(a.initialize('dark'), 'light')
  assert.equal(b.initialize('light'), 'dark')
  a.set('auto')
  assert.equal(b.initialize('auto'), 'dark')
  assert.equal(createDeviceTheme(() => aStorage).initialize('dark'), 'auto')
  assert.equal(createDeviceTheme(() => bStorage).initialize('light'), 'dark')
})

test('legacy migration happens only once, and a new browser defaults to follow system', () => {
  const saved = storage()
  const migrated = createDeviceTheme(() => saved)
  assert.equal(migrated.current(), null, 'initial render must not overwrite a future legacy seed')
  assert.equal(migrated.initialize('dark'), 'dark')
  assert.equal(saved.getItem(DEVICE_THEME_KEY), 'dark')
  assert.equal(migrated.initialize('light'), 'dark')
  const fresh = createDeviceTheme(() => storage('corrupted'))
  assert.equal(fresh.initialize(undefined), 'auto')
  assert.equal(fresh.initialize('dark'), 'auto')
})

test('blocked storage preserves the current page preference instead of falling back on every response', () => {
  const pref = createDeviceTheme(() => { throw new Error('Storage disabled') })
  assert.equal(pref.initialize('dark'), 'dark')
  pref.set('light')
  assert.equal(pref.initialize('dark'), 'light')
  pref.set('auto', false)
  assert.equal(pref.initialize('dark'), 'auto')
})

const original = Object.fromEntries(['window', 'localStorage', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
after(() => {
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

async function app(initial) {
  const saved = storage(initial)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: saved })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hostname: 'dashboard.example' } } })
  return { useApp: (await load(appCode)).useApp, saved }
}

function bootstrap(settings) {
  return Response.json({ user: { id: 1, username: 'fixture' }, can_edit: true, settings, sites: [], categories: [] })
}

test('theme-only saves never call the server and bootstrap cannot overwrite the local choice', async () => {
  const { useApp, saved } = await app('light')
  let calls = 0
  globalThis.fetch = async () => { calls++; return bootstrap({ theme: 'dark' }) }
  await useApp.getState().bootstrap()
  assert.equal(useApp.getState().settings.theme, 'light')
  assert.equal(calls, 1)
  await useApp.getState().saveSettings({ theme: 'dark' })
  assert.equal(calls, 1)
  assert.equal(saved.getItem(DEVICE_THEME_KEY), 'dark')
  await useApp.getState().saveSettings({ theme: 'auto' })
  await useApp.getState().reload()
  assert.equal(calls, 2)
  assert.equal(useApp.getState().settings.theme, 'auto')
})

test('mixed saves send only shared settings and late responses preserve newer theme choices', async () => {
  const { useApp, saved } = await app('light')
  let request
  let finish
  globalThis.fetch = async (url, init) => {
    request = { url, body: JSON.parse(init.body) }
    return new Promise((resolve) => { finish = resolve })
  }
  const saving = useApp.getState().saveSettings({ theme: 'dark', wallpaper_blur: 5 })
  assert.deepEqual(request, { url: '/api/settings', body: { wallpaper_blur: 5 } })
  assert.equal(saved.getItem(DEVICE_THEME_KEY), 'dark')
  useApp.getState().setTheme('light')
  finish(Response.json({ settings: { theme: 'dark', wallpaper_blur: '5' } }))
  await saving
  assert.equal(useApp.getState().settings.theme, 'light')
  assert.equal(useApp.getState().settings.wallpaper_blur, 5)
  assert.equal(saved.getItem(DEVICE_THEME_KEY), 'light')
})

test('local choice survives failed shared saves and can update from another tab without a write', async () => {
  const { useApp, saved } = await app('light')
  globalThis.fetch = async () => { throw new Error('Offline') }
  await assert.rejects(useApp.getState().saveSettings({ theme: 'dark', card_size: 'lg' }), /Offline/)
  assert.equal(useApp.getState().settings.theme, 'dark')
  assert.equal(saved.getItem(DEVICE_THEME_KEY), 'dark')
  useApp.getState().setTheme('auto', false)
  assert.equal(useApp.getState().settings.theme, 'auto')
  assert.equal(saved.getItem(DEVICE_THEME_KEY), 'dark', 'storage events must not write back in a loop')
})

test('applying and reloading a complete appearance preset keeps the browser theme and preserved video wallpaper', async () => {
  const { useApp, saved } = await app('dark')
  let remote = { theme: 'light', appearance_preset: 'classic', wallpaper_light_type: 'video', wallpaper_light_value: '/uploads/personal.mp4', wallpaper_dark_type: 'video', wallpaper_dark_value: '/uploads/night.webm', wallpaper_blur: '4', wallpaper_dim: '31' }
  const writes = []
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/bootstrap') return bootstrap(remote)
    assert.equal(url, '/api/settings')
    assert.equal(init.method, 'PUT')
    const patch = JSON.parse(init.body)
    writes.push(patch)
    remote = { ...remote, ...patch }
    return Response.json({ settings: remote })
  }
  await useApp.getState().bootstrap()
  assert.equal(useApp.getState().settings.appearance_preset, 'classic')
  const patch = appearancePresetPatch('desktop', { preserveWallpaper: true })
  await useApp.getState().saveSettings(patch)
  assert.deepEqual(writes, [patch])
  assert.ok(!('theme' in writes[0]))
  assert.equal(useApp.getState().rawSettings.appearance_preset, 'desktop')
  assert.equal(useApp.getState().settings.appearance_preset, 'desktop')
  await useApp.getState().reload()
  const settings = useApp.getState().settings
  assert.equal(settings.appearance_preset, 'desktop')
  assert.equal(settings.theme, 'dark')
  assert.equal(saved.getItem(DEVICE_THEME_KEY), 'dark')
  assert.equal(remote.theme, 'light', 'preset saves must not replace another device or legacy preference')
  assert.equal(settings.wallpaper_light_type, 'video')
  assert.equal(settings.wallpaper_light_value, '/uploads/personal.mp4')
  assert.equal(settings.wallpaper_dark_type, 'video')
  assert.equal(settings.wallpaper_dark_value, '/uploads/night.webm')
  assert.equal(settings.wallpaper_blur, 4)
  assert.equal(settings.wallpaper_dim, 31)
})

test('offline and rejected appearance saves retain the previous preset and current browser theme', async () => {
  for (const failure of ['offline', 'invalid']) {
    const { useApp, saved } = await app('dark')
    const remote = { theme: 'light', appearance_preset: 'paper', card_size: 'lg', glass: 'none', wallpaper_light_value: 'sakura', wallpaper_dark_value: 'sunset' }
    globalThis.fetch = async () => bootstrap(remote)
    await useApp.getState().bootstrap()
    const oldSettings = useApp.getState().settings
    const oldRawSettings = useApp.getState().rawSettings
    let requests = 0
    globalThis.fetch = async (url, init) => {
      requests++
      assert.equal(url, '/api/settings')
      assert.ok(!('theme' in JSON.parse(init.body)))
      if (failure === 'offline') throw new Error('Offline preset save')
      return Response.json({ error: 'invalid_value', message: 'Unsupported appearance preset' }, { status: 400 })
    }
    await assert.rejects(
      useApp.getState().saveSettings(appearancePresetPatch('terminal', { preserveWallpaper: false })),
      failure === 'offline' ? /Offline preset save/ : /Unsupported appearance preset/,
    )
    assert.equal(requests, 1)
    assert.deepEqual(useApp.getState().settings, oldSettings)
    assert.deepEqual(useApp.getState().rawSettings, oldRawSettings)
    assert.equal(useApp.getState().settings.appearance_preset, 'paper')
    assert.equal(useApp.getState().settings.theme, 'dark')
    assert.equal(saved.getItem(DEVICE_THEME_KEY), 'dark')
  }
})
