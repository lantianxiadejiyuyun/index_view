import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
const bundled = buildSync({ entryPoints: ['app/web/src/lib/weather-display.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { cityDate, solarTime, solarState, uvReading, uvLevel } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const data = { timezone: 'Asia/Shanghai', solar_date: '2026-10-03', sunrise: '2026-10-02T22:00:00Z', solar_noon: '2026-10-03T04:00:00Z', sunset: '2026-10-03T10:00:00Z' }
const at = hour => new Date(`2026-10-03T${hour}:00+08:00`)
test('solar animation follows city sunrise, true noon and sunset instead of fixed device hours', () => {
  for (const [time, phase] of [['05:20','night'],['05:40','sunrise'],['06:20','sunrise'],['09:00','morning'],['12:00','noon'],['15:00','afternoon'],['18:15','sunset'],['19:00','night']]) assert.equal(solarState(data, at(time)).phase, phase)
  assert.equal(solarState(data, at('06:00')).progress, 0)
  assert.equal(solarState(data, at('12:00')).progress, .5)
  assert.equal(solarState(data, at('18:00')).progress, 1)
  assert.equal(solarState(data, at('18:00')).isDay, false)
})
test('stale, missing and invalid solar readings never animate an invented path', () => {
  assert.equal(solarState(null, at('12:00')), null)
  assert.equal(solarState({...data,solar_date:'2026-10-02'},at('12:00')), null)
  assert.equal(solarState({...data,sunrise:null},at('12:00')), null)
  assert.equal(solarState({...data,solar_noon:data.sunset},at('12:00')), null)
  assert.equal(solarState({...data,timezone:'invalid'},at('12:00')), null)
})
test('formatting honors a city timezone across midnight and handles unavailable timestamps', () => {
  assert.equal(cityDate(new Date('2026-10-02T17:00:00Z'),'Asia/Shanghai'),'2026-10-03')
  assert.equal(solarTime(data.sunrise, data.timezone),'06:00')
  assert.equal(solarTime('invalid', data.timezone),'—')
  assert.equal(solarTime(null, data.timezone),'—')
})
test('UV shows zero as valid, rejects yesterday and preserves unavailable data', () => {
  const daily = { timezone:'Asia/Shanghai', forecast_date:'2026-10-03', uv_index:0 }
  assert.equal(uvReading(daily,at('12:00')),0)
  for (const v of [null,undefined,-1,NaN,Infinity]) assert.equal(uvReading({...daily,uv_index:v},at('12:00')),null)
  assert.equal(uvReading({...daily,forecast_date:'2026-10-02',uv_index:5},at('12:00')),null)
  assert.deepEqual([0,2.9,3,5.9,6,7.9,8,10.9,11].map(v=>uvLevel(v).level),['low','low','moderate','moderate','high','high','very-high','very-high','extreme'])
})
