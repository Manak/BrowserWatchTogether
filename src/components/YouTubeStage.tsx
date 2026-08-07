import { useEffect, useRef, useState } from 'react'
import type { MediaRef } from '../lib/media'
import { describeYouTubeError } from '../lib/youtube'
import type { SyncEngine } from '../sync/engine'
import { YouTubeMedia } from '../youtube/adapter'
import { defaultPlayerVars, loadYouTubeApi, PLAYER_HOST, type YtPlayer } from '../youtube/api'
import type { VideoMeta } from './Player'

interface Props {
  engine: SyncEngine
  media: MediaRef
  onMeta: (meta: VideoMeta) => void
  onError: (message: string | null) => void
  muted: boolean
  volume: number
}

/**
 * How often the player is sampled. Faster than the engine's own quarter-second
 * heartbeat, because an ad boundary is only visible as a change in the numbers
 * the player reports and the sooner it is noticed the less of the film plays
 * behind it.
 */
const POLL_MS = 150

/**
 * A YouTube video in the place a `<video>` would be.
 *
 * The embed is created once per video id and driven through the adapter, which
 * is what the engine actually holds — from there the room controls a YouTube
 * video exactly as it controls a Drive file.
 *
 * Two deliberate choices show on screen. YouTube's own controls are turned off,
 * because a scrub on one person's copy moves that person alone; the room's
 * controls below the frame move everybody. And a transparent shield sits over
 * the frame to swallow clicks that would otherwise pause one screen out of two
 * — except during an ad, when it lifts, because the Skip button belongs to the
 * person watching the ad and they need to be able to reach it.
 */
export function YouTubeStage({ engine, media, onMeta, onError, muted, volume }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** The node the API swapped for its iframe. Not React's to manage. */
  const mountRef = useRef<HTMLElement | null>(null)
  const playerRef = useRef<YtPlayer | null>(null)
  const adapterRef = useRef<YouTubeMedia | null>(null)
  const [inAd, setInAd] = useState(false)
  const videoId = media.videoId ?? ''
  const startAt = media.startAt ?? 0

  // Everything is keyed on the video id: a new one tears the player down and
  // builds another, so nothing learned about the last video can leak into it.
  useEffect(() => {
    if (!videoId) return
    let cancelled = false
    const adapter = new YouTubeMedia(null, { startAt })
    adapterRef.current = adapter
    engine.attachMedia(adapter)
    onError(null)

    void loadYouTubeApi()
      .then((YT) => {
        const host = hostRef.current
        if (cancelled || !host) return
        // The API *replaces* the node it is given with the iframe. Handing it
        // a node React rendered would leave React holding a detached element —
        // fine until the video changes, at which point the next player is
        // built inside a node that is no longer on the page. So the node it
        // replaces is one React has never heard of.
        const mount = document.createElement('div')
        mount.className = 'yt-frame'
        host.appendChild(mount)
        mountRef.current = mount
        const player = new YT.Player(mount, {
          videoId,
          host: PLAYER_HOST,
          playerVars: defaultPlayerVars(window.location.origin),
          events: {
            onReady: (e) => {
              if (cancelled) return
              playerRef.current = e.target
              adapter.attachPlayer(e.target)
              adapter.applyAudio()
              // Cue rather than load: it settles the player on the film's own
              // duration before anything can play in front of it, which is the
              // anchor every later ad is recognised against.
              e.target.cueVideoById(videoId, startAt)
              engine.onMediaLoaded()
            },
            onStateChange: () => {
              // The poll below reads the state; this only exists to make the
              // first frame after a transition land promptly.
              adapter.poll()
            },
            onError: (e) => onError(describeYouTubeError(e.data)),
            onAutoplayBlocked: () => adapter.noteAutoplayBlocked(),
          },
        })
        playerRef.current = player
      })
      .catch((err: unknown) => {
        if (cancelled) return
        onError(err instanceof Error ? err.message : 'Could not load the YouTube player.')
      })

    const timer = setInterval(() => {
      const view = adapter.poll()
      setInAd(view.adPlaying)
      onMeta({
        currentTime: view.contentTime,
        duration: view.contentDuration,
        // YouTube reports one buffered fraction and no ranges; the adapter
        // turns it into a range end, which is all the scrubber draws.
        bufferedEnd: adapter.buffered.length ? adapter.buffered.end(0) : 0,
      })
    }, POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
      engine.attachMedia(null)
      adapter.destroy()
      adapterRef.current = null
      try {
        playerRef.current?.destroy()
      } catch {
        // The iframe may already be gone with the DOM node.
      }
      playerRef.current = null
      // destroy() removes the iframe, but not if the player never got that far.
      mountRef.current?.remove()
      mountRef.current = null
    }
  }, [engine, videoId, startAt, onMeta, onError])

  useEffect(() => {
    adapterRef.current?.setMuted(muted)
    adapterRef.current?.setVolume(volume)
  }, [muted, volume])

  return (
    <div className="yt-stage">
      {/* Stays empty as far as React is concerned; the effect puts the
          player's own node inside it. */}
      <div className="yt-host" ref={hostRef} />
      {!inAd && (
        // Clicking the picture is how everybody expects to pause a video, and
        // in the embed it would pause one screen out of two. Catching the click
        // and sending it through the engine instead makes it mean what people
        // think it means: pause for the room.
        <button
          className="yt-shield"
          type="button"
          aria-label="Play or pause for everyone"
          onClick={() => engine.togglePlay()}
        />
      )}
    </div>
  )
}
