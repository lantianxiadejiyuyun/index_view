import { Moon, Sun, Sunrise, Sunset } from 'lucide-react'
import type { Weather } from '../../lib/types.ts'
import { SOLAR_LABELS, solarState, solarTime } from '../../lib/weather-display.ts'
import './solar-timeline.css'

export function SolarTimeline({ data, now }: { data: Weather | null; now: Date }) {
  const state = solarState(data, now)
  if (!state || !data) return null
  const t = state.progress
  const x = 14 + 172 * t
  const y = 66 - 176 * t * (1 - t)
  return (
    <section className="clock-solar" data-phase={state.phase} aria-label={`${data.city}今日太阳轨迹`} title="按城市经纬度估算，时刻使用城市所在时区">
      <div className="solar-caption"><span>{data.city} · {SOLAR_LABELS[state.phase]}</span><span className="solar-estimate">太阳轨迹</span></div>
      <svg className="solar-track" viewBox="0 0 200 76" aria-hidden="true">
        <path className="solar-track-fill" d="M14 66 Q100 -22 186 66 Z" />
        <path className="solar-horizon" d="M4 66 H196" />
        <path className="solar-arc" d="M14 66 Q100 -22 186 66" pathLength="100" />
        <path className="solar-arc-progress" d="M14 66 Q100 -22 186 66" pathLength="100" strokeDasharray={`${t * 100} 100`} />
        {[14, 100, 186].map((cx, i) => <circle className="solar-stop" key={cx} cx={cx} cy={i === 1 ? 22 : 66} r="2.5" />)}
        {state.phase === 'night' ? (
          <g className="solar-moon" transform="translate(91 16)"><Moon size={18} /><circle cx="28" cy="-4" r="1" /><circle cx="-20" cy="6" r="1.5" /></g>
        ) : (
          <g className="solar-orb" transform={`translate(${x} ${y})`}><circle className="solar-orb-halo" r="12" /><circle className="solar-orb-core" r="5" /><g className="solar-rays">{[0, 45, 90, 135].map((a) => <path key={a} transform={`rotate(${a})`} d="M0 -9 V-7 M0 7 V9" />)}</g></g>
        )}
      </svg>
      <div className="solar-times">
        <span><Sunrise aria-hidden="true" /><span>日出<time dateTime={data.sunrise || undefined}>{solarTime(data.sunrise, data.timezone)}</time></span></span>
        <span><Sun aria-hidden="true" /><span>正午<time dateTime={data.solar_noon || undefined}>{solarTime(data.solar_noon, data.timezone)}</time></span></span>
        <span><Sunset aria-hidden="true" /><span>日落<time dateTime={data.sunset || undefined}>{solarTime(data.sunset, data.timezone)}</time></span></span>
      </div>
    </section>
  )
}
