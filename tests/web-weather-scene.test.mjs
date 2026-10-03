import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../app/web/src/components/weather/weather-scene-model.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { citySilhouette, citySilhouettes, weatherSceneKind } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('city landmarks accept common Chinese administrative names and English weather-provider names', () => {
  for (const [city, expected] of [['宁波', 'ningbo'], ['浙江省宁波市鄞州区', 'ningbo'], ['中国/浙江/宁波市', 'ningbo'], ['浙江 宁波 鄞州', 'ningbo'], ['Ningbo, Zhejiang', 'ningbo'], ['NINGBO CITY', 'ningbo'], [' 北京市 ', 'beijing'], ['陕西省西安市', 'xian'], ["Xi'an", 'xian'], ['Hong Kong', 'hongkong'], ['香港特别行政区', 'hongkong'], ['澳門特別行政區', 'macau']]) {
    assert.equal(citySilhouette(city).id, expected, city)
  }
})

test('unknown cities and similarly named streets never receive a falsely attributed landmark', () => {
  for (const city of ['', '测试城市', '北京路', '南京东路', '宁波路街道', 'Suzhou Industrial Park Road', 'New Shanghai']) {
    assert.equal(citySilhouette(city).id, 'generic', city)
    assert.equal(citySilhouette(city).landmark, '城市剪影')
  }
  assert.ok(citySilhouettes.length >= 15)
  assert.equal(new Set(citySilhouettes.map(city => city.id)).size, citySilhouettes.length)
})

test('weather scenes preserve WMO distinctions including freezing rain, snow showers, fog and storms', () => {
  for (const [codes, kind] of [[[0], 'clear'], [[1, 2], 'fair'], [[3], 'cloudy'], [[45, 48], 'fog'], [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], 'rain'], [[71, 73, 75, 77, 85, 86], 'snow'], [[95, 96, 99], 'storm']]) {
    for (const code of codes) assert.equal(weatherSceneKind(code), kind, String(code))
  }
  for (const invalid of [-1, 4, 58, 100, NaN, Infinity]) assert.equal(weatherSceneKind(invalid), 'cloudy')
})
