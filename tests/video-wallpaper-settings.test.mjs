import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

async function load(relative) {
  const output = buildSync({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' }).outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}
const { normalizeSettings, activeWallpaper } = await load('../app/web/src/lib/settings.ts')
const { videoWallpaperSource } = await load('../app/web/src/lib/wallpapers.ts')
const { computeScrims } = await load('../app/web/src/lib/visual.ts')

test('video settings preserve separate theme slots and explicitly removed videos', () => {
  const settings = normalizeSettings({ wallpaper_light_type: 'video', wallpaper_light_value: '/uploads/light.mp4', wallpaper_dark_type: 'video', wallpaper_dark_value: '/uploads/dark.webm' })
  assert.deepEqual(activeWallpaper(settings, false), { type: 'video', value: '/uploads/light.mp4' })
  assert.deepEqual(activeWallpaper(settings, true), { type: 'video', value: '/uploads/dark.webm' })
  assert.equal(normalizeSettings({ wallpaper_light_type: 'video', wallpaper_light_value: '' }).wallpaper_light_value, '')
  assert.equal(normalizeSettings({ wallpaper_type: 'image', wallpaper_value: '/uploads/legacy.jpg' }).wallpaper_dark_value, '/uploads/legacy.jpg')
})

test('video rendering accepts uploaded media and HTTP sources but rejects other imported URLs', () => {
  for (const value of ['/uploads/clip-123.mp4', '/uploads/clip.webm', 'https://example.com/video?token=signed-value', 'http://localhost:9200/video.mp4']) assert.equal(videoWallpaperSource(value), value)
  for (const value of ['javascript:alert(1)', 'data:video/mp4;base64,AAAA', 'file:///test.mp4', '//example.com/test.mp4', '/uploads/../test.mp4', 'https://user:pass@example.com/video.mp4', 'aurora']) assert.equal(videoWallpaperSource(value), '')
})

test('changing video frames retains stable readable text in both themes', () => {
  for (const dark of [true, false]) {
    for (const frame of ['dark', 'light']) {
      const result = computeScrims({ type: 'video', value: '/uploads/test.mp4', dim: 0 }, dark, frame)
      assert.equal(result.effectiveTone, 'dark')
      assert.ok(result.scrim >= 0.55)
    }
    assert.equal(computeScrims({ type: 'video', value: '', dim: 80 }, dark).scrim, 0.8)
  }
})
