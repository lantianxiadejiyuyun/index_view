import { useEffect, useRef, useState, type CSSProperties, type ReactEventHandler } from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play } from 'lucide-react'
import { videoWallpaperSource } from '../lib/wallpapers.ts'

type Props = {
  src: string
  className?: string
  style?: CSSProperties
  showControls?: boolean
  controlPlacement?: 'inline' | 'floating'
  onError?: ReactEventHandler<HTMLVideoElement>
  onLoadedData?: ReactEventHandler<HTMLVideoElement>
}

/** Muted background video with an explicit motion control and no hidden-tab playback. */
export function VideoWallpaper({
  src: rawSource, className, style, showControls = true, controlPlacement = 'inline', onError, onLoadedData,
}: Props) {
  const src = videoWallpaperSource(rawSource)
  const ref = useRef<HTMLVideoElement>(null)
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [userPlaying, setUserPlaying] = useState<boolean | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const wantsPlay = userPlaying ?? !reduceMotion

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduceMotion(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    setReady(false)
    setFailed(false)
    setPlaying(false)
  }, [src])

  useEffect(() => {
    const video = ref.current
    if (!video || !src) return
    let active = true
    let inView = controlPlacement === 'floating'
    video.muted = true
    const sync = () => {
      if (!active) return
      if (wantsPlay && !document.hidden && inView) {
        // Autoplay can be rejected by a mobile power-saving policy. The play button remains usable.
        void video.play().catch(() => { if (active) setPlaying(false) })
      } else video.pause()
    }
    const observer = new IntersectionObserver(([entry]) => {
      inView = Boolean(entry?.isIntersecting)
      sync()
    })
    observer.observe(video)
    document.addEventListener('visibilitychange', sync)
    video.addEventListener('loadeddata', sync)
    sync()
    return () => {
      active = false
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
      video.removeEventListener('loadeddata', sync)
      video.pause()
    }
  }, [src, wantsPlay, controlPlacement])

  function togglePlayback() {
    const video = ref.current
    if (!video) return
    if (!video.paused) {
      setUserPlaying(false)
      video.pause()
    } else {
      setUserPlaying(true)
      // Keep the call inside the gesture for browsers that block automatic playback.
      void video.play().catch(() => setPlaying(false))
    }
  }

  const control = showControls && src && !failed ? (
    <button type="button" onClick={togglePlayback}
      className={`${controlPlacement === 'floating'
        ? 'fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-20'
        : 'absolute bottom-3 left-3 z-10'} pointer-events-auto flex min-h-11 min-w-11 items-center justify-center rounded-full border border-white/25 bg-black/50 px-3 text-white shadow-lg backdrop-blur-md transition hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white`}
      aria-label={playing ? '暂停动态壁纸' : '播放动态壁纸'} title={playing ? '暂停动态壁纸' : '播放动态壁纸'}>
      {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
    </button>
  ) : null

  return (
    <div className={className}>
      <video ref={ref} src={src || undefined} muted loop playsInline preload="metadata"
        aria-hidden="true" tabIndex={-1} disablePictureInPicture disableRemotePlayback
        className="absolute inset-0 size-full object-cover"
        style={{ ...style, opacity: ready && !failed ? 1 : 0 }}
        onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onLoadedData={(event) => { setReady(true); onLoadedData?.(event) }}
        onError={(event) => { setFailed(true); setPlaying(false); onError?.(event) }} />
      {controlPlacement === 'floating' ? createPortal(control, document.body) : control}
    </div>
  )
}
