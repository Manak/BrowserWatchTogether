import { useEffect, useRef, type RefObject } from 'react'
import { describeMediaError, type MediaRef } from '../lib/media'
import type { SyncEngine } from '../sync/engine'

export interface VideoMeta {
  currentTime: number
  duration: number
  bufferedEnd: number
}

interface Props {
  engine: SyncEngine
  media: MediaRef | null
  videoRef: RefObject<HTMLVideoElement | null>
  onMeta: (meta: VideoMeta) => void
  onError: (message: string | null) => void
  muted: boolean
  volume: number
}

export function Player({
  engine,
  media,
  videoRef,
  onMeta,
  onError,
  muted,
  volume,
}: Props) {
  const lastUrl = useRef<string | null>(null)

  // Hand the element to the engine once; the engine drives play/pause/seek.
  useEffect(() => {
    engine.attachMedia(videoRef.current)
    return () => engine.attachMedia(null)
  }, [engine, videoRef])

  // Swap sources only when the URL actually changes, so a re-render never
  // restarts the download.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const url = media?.url ?? null
    if (url === lastUrl.current) return
    lastUrl.current = url
    onError(null)
    if (url) {
      el.src = url
      el.load()
    } else {
      el.removeAttribute('src')
      el.load()
    }
  }, [media?.url, videoRef, onError])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.muted = muted
    el.volume = volume
  }, [muted, volume, videoRef])

  const report = () => {
    const el = videoRef.current
    if (!el) return
    const b = el.buffered
    onMeta({
      currentTime: el.currentTime,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      bufferedEnd: b.length ? b.end(b.length - 1) : 0,
    })
  }

  return (
    <video
      ref={videoRef}
      className="video"
      // Required on iOS, otherwise playback hijacks the screen into the native
      // fullscreen player and we lose control of it.
      playsInline
      preload="auto"
      // No crossOrigin: Drive does not send CORS headers, and requesting them
      // would break playback. We never read pixels, so we do not need them.
      onLoadedMetadata={() => {
        engine.onMediaLoaded()
        report()
      }}
      onDurationChange={report}
      onProgress={report}
      onTimeUpdate={report}
      onWaiting={() => engine.onStalled()}
      onStalled={() => engine.onStalled()}
      onError={() => {
        const el = videoRef.current
        onError(describeMediaError(el?.error?.code, media?.kind ?? 'drive'))
      }}
      onCanPlay={() => onError(null)}
    />
  )
}
