import { useEffect, useRef, useState, type RefObject } from 'react'
import { describeMediaError, type MediaRef } from '../lib/media'
import type { SyncEngine } from '../sync/engine'
import { YouTubeStage } from './YouTubeStage'

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

/** Give a flaky network a few chances before blaming the file. */
const MAX_RELOADS = 6
/** Back off so a long outage does not become a request storm. */
const RELOAD_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000]

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
  const reloads = useRef(0)
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, forceRetry] = useState(0)
  const isYouTube = media?.kind === 'youtube'

  // Cancel any pending recovery when the component goes away.
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
    },
    [],
  )

  // Hand the element to the engine once; the engine drives play/pause/seek.
  // YouTube has no element to hand over — the stage attaches its own adapter.
  useEffect(() => {
    if (isYouTube) return
    engine.attachMedia(videoRef.current)
    return () => engine.attachMedia(null)
  }, [engine, videoRef, isYouTube])

  // Swap sources only when the URL actually changes, so a re-render never
  // restarts the download.
  useEffect(() => {
    const el = videoRef.current
    if (!el || isYouTube) return
    const url = media?.url ?? null
    if (url === lastUrl.current) return
    lastUrl.current = url
    reloads.current = 0
    onError(null)
    if (url) {
      el.src = url
      el.load()
    } else {
      el.removeAttribute('src')
      el.load()
    }
  }, [media?.url, videoRef, onError, isYouTube])

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

  // YouTube is played by YouTube — an embed is the only sanctioned way, and it
  // brings its own timeline, its own buffering and its own ads. See
  // youtube/adapter.ts for how the room drives it all the same.
  if (media && isYouTube) {
    return (
      <YouTubeStage
        engine={engine}
        media={media}
        onMeta={onMeta}
        onError={onError}
        muted={muted}
        volume={volume}
      />
    )
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
      // Native controls (iOS fullscreen, the lock screen, a headset) change the
      // element directly. Tell the engine so the room follows instead of
      // silently drifting apart; it ignores echoes of its own changes.
      onPlay={() => engine.adoptExternal('play', videoRef.current?.currentTime ?? 0)}
      onPause={() => engine.adoptExternal('pause', videoRef.current?.currentTime ?? 0)}
      onSeeked={() => engine.adoptExternal('seek', videoRef.current?.currentTime ?? 0)}
      onError={() => {
        const el = videoRef.current
        const code = el?.error?.code
        // A dropped connection is not a broken file. Retry, keeping our place,
        // before telling the user anything is wrong.
        if (code === 2 && reloads.current < MAX_RELOADS) {
          const attempt = reloads.current++
          const resumeAt = el?.currentTime ?? 0
          const wait = RELOAD_BACKOFF_MS[attempt] ?? 30000
          if (reloadTimer.current) clearTimeout(reloadTimer.current)
          reloadTimer.current = setTimeout(() => {
            const v = videoRef.current
            if (!v || !media) return
            v.src = media.url
            v.load()
            // Restore the position once there is enough of the file to seek.
            const restore = () => {
              v.currentTime = resumeAt
              engine.onMediaLoaded()
              v.removeEventListener('loadedmetadata', restore)
            }
            v.addEventListener('loadedmetadata', restore)
            forceRetry((n) => n + 1)
          }, wait)
          return
        }
        onError(describeMediaError(code, media?.kind ?? 'drive'))
      }}
      onCanPlay={() => {
        reloads.current = 0
        onError(null)
      }}
    />
  )
}
