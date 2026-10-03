import type { CSSProperties } from 'react'
import { citySilhouette, weatherSceneKind } from './weather-scene-model.ts'
import './weather-scene.css'

export interface WeatherSceneProps {
  city: string
  code: number
  isDay: boolean
  className?: string
}

/** Decorative, local SVG artwork: no remote images or additional weather requests. */
export function WeatherScene({ city, code, isDay, className = '' }: WeatherSceneProps) {
  const skyline = citySilhouette(city)
  const kind = weatherSceneKind(code)
  const cloud = kind !== 'clear'
  const precipitation = kind === 'rain' || kind === 'storm' || kind === 'snow'
  return (
    <div
      className={`weather-scene weather-scene--${kind} ${className}`}
      data-period={isDay ? 'day' : 'night'}
      data-city-scene={skyline.id}
      data-landmark={skyline.landmark}
      aria-hidden="true"
    >
      <div className="weather-scene-atmosphere" />
      <svg className="weather-scene-sky" viewBox="0 0 220 130" fill="none" focusable="false">
        {!isDay && <g className="weather-scene-stars" fill="currentColor"><circle cx="32" cy="32" r="1.7" /><circle cx="180" cy="27" r="1.2" /><circle cx="129" cy="12" r="1.4" /><path d="M76 12V20M72 16H80M186 57V63M183 60H189" stroke="currentColor" strokeWidth="1.3" /></g>}
        <g className="weather-scene-orb">
          {isDay
            ? <><circle className="weather-scene-sun-halo" cx="140" cy="47" r="37" /><circle className="weather-scene-sun" cx="140" cy="47" r="23" /><g className="weather-scene-rays" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M140 11V6M140 83V88M104 47H99M176 47H181M114.5 21.5L111 18M165.5 72.5L169 76M114.5 72.5L111 76M165.5 21.5L169 18" /></g></>
            : <path className="weather-scene-moon" d="M152 23A26 26 0 1 0 174 63A25 25 0 0 1 152 23Z" />}
        </g>
        {cloud && <g className="weather-scene-clouds"><path className="weather-scene-cloud-back" d="M83 57A17 17 0 0 1 116 52A13 13 0 0 1 135 65H143A12 12 0 0 1 143 89H79A16 16 0 0 1 79 57Z" /><path className="weather-scene-cloud-front" d="M121 78A21 21 0 0 1 162 71A16 16 0 0 1 184 85A14 14 0 0 1 180 113H116A18 18 0 0 1 116 78Z" /></g>}
        {kind === 'storm' && <path className="weather-scene-lightning" d="M144 99L134 119H145L139 134L161 110H149L156 99Z" />}
      </svg>
      {precipitation && <div className={`weather-scene-precipitation weather-scene-precipitation--${kind === 'snow' ? 'snow' : 'rain'}`}>
        {Array.from({ length: kind === 'snow' ? 8 : 11 }, (_, index) => (
          <i key={index} style={{ '--particle-x': `${12 + (index * 29) % 83}%`, '--particle-delay': `${-index * .37}s`, '--particle-duration': `${kind === 'snow' ? 4 + index % 3 : .9 + (index % 4) * .2}s` } as CSSProperties} />
        ))}
      </div>}
      <svg className="weather-scene-city" viewBox="0 0 400 160" preserveAspectRatio="xMidYMax meet" focusable="false">
        <path className="weather-scene-distant" d="M0 160V145H27V134H40V120H59V132H78V111H97V123H117V139H142V119H161V130H180V137H205V117H224V130H245V108H263V137H285V122H304V131H331V108H348V128H369V138H388V145H400V160Z" />
        <g className="weather-scene-landmark">
          <path d={skyline.path} fillRule="evenodd" />
          {skyline.detail && <path className="weather-scene-landmark-detail" d={skyline.detail} fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
        </g>
        <path className="weather-scene-river" d="M0 156Q98 148 198 156T400 154V160H0Z" />
      </svg>
      {kind === 'fog' && <div className="weather-scene-fog"><i /><i /><i /></div>}
    </div>
  )
}
