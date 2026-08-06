import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatTime } from '../lib/format'
import { roomUrl } from '../lib/roomCode'
import type { SyncEngine } from '../sync/engine'
import { Controls } from './Controls'
import { MediaPicker } from './MediaPicker'
import { PeopleList } from './PeopleList'
import { Player, type VideoMeta } from './Player'

interface Props {
  engine: SyncEngine
  roomCode: string
  name: string
  joinError: string | null
  onLeave: () => void
}

type Tab = 'people' | 'video'

export function RoomView({ engine, roomCode, name, joinError, onLeave }: Props) {
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  const [meta, setMeta] = useState<VideoMeta>({
    currentTime: 0,
    duration: 0,
    bufferedEnd: 0,
  })
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('people')
  const [changing, setChanging] = useState(false)
  const [copied, setCopied] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)

  const onMeta = useCallback((m: VideoMeta) => setMeta(m), [])
  const onError = useCallback((m: string | null) => setMediaError(m), [])

  const share = async () => {
    const url = roomUrl(roomCode)
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Watch Together', text: 'Join my room', url })
        return
      }
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // The user dismissed the share sheet, or the clipboard was denied.
    }
  }

  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current
    const video = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    if (stage?.requestFullscreen) {
      void stage.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.())
      return
    }
    // iPhone Safari only allows the video element itself to go fullscreen.
    video?.webkitEnterFullscreen?.()
  }, [])

  // Desktop keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          engine.togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          engine.nudge(-10)
          break
        case 'ArrowRight':
          e.preventDefault()
          engine.nudge(10)
          break
        case 'f':
          toggleFullscreen()
          break
        case 'm':
          setMuted((v) => !v)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, toggleFullscreen])

  const noMedia = !snap.media
  const showPicker = noMedia || changing

  return (
    <div className="room">
      <header className="topbar">
        <div className="topbar-main">
          <button className="btn-ghost" type="button" onClick={onLeave} aria-label="Leave room">
            ‹ Leave
          </button>
          <button
            className="room-code"
            type="button"
            aria-label={`Room ${roomCode}. Share invite link.`}
            onClick={() => void share()}
          >
            <span className="room-code-label">Room</span>
            <span className="room-code-value">{roomCode}</span>
            <span className="room-code-action">{copied ? 'Copied!' : 'Share'}</span>
          </button>
        </div>
        <div className="topbar-status">
          <StatusChip snap={snap} joinError={joinError} />
        </div>
      </header>

      <div className="layout">
        <section className="stage-wrap">
          <div className="stage" ref={stageRef}>
            <Player
              engine={engine}
              media={snap.media}
              videoRef={videoRef}
              onMeta={onMeta}
              onError={onError}
              muted={muted}
              volume={volume}
            />

            <Overlay
              snap={snap}
              mediaError={mediaError}
              onUnlock={() => void engine.unlock()}
              onPick={() => {
                // The picker lives in the Video tab, so reveal it too —
                // otherwise the button appears to do nothing.
                setChanging(true)
                setTab('video')
              }}
            />
          </div>

          <Controls
            engine={engine}
            snap={snap}
            meta={meta}
            muted={muted}
            volume={volume}
            onMuted={setMuted}
            onVolume={setVolume}
            onFullscreen={toggleFullscreen}
            disabled={noMedia}
          />

          {snap.media && (
            <div className="now-playing">
              <div className="now-playing-title" title={snap.media.title}>
                {snap.media.title}
              </div>
              <div className="now-playing-sub">
                Added by {snap.media.setBy}
                {snap.driftSec !== 0 && Number.isFinite(snap.driftSec) && (
                  <> · {formatDrift(snap.driftSec)}</>
                )}
              </div>
            </div>
          )}
        </section>

        <aside className="panel">
          <div className="tabs" role="tablist">
            <button
              className={`tab ${tab === 'people' ? 'tab-active' : ''}`}
              role="tab"
              aria-selected={tab === 'people'}
              type="button"
              onClick={() => setTab('people')}
            >
              In this room ({snap.peerCount})
            </button>
            <button
              className={`tab ${tab === 'video' ? 'tab-active' : ''}`}
              role="tab"
              aria-selected={tab === 'video'}
              type="button"
              onClick={() => setTab('video')}
            >
              Video
            </button>
          </div>

          <div className="panel-body">
            {tab === 'people' ? (
              <>
                <PeopleList snap={snap} />
                {snap.peerCount === 1 && (
                  <p className="footnote">
                    Nobody else is here yet. Share the room code
                    {' '}<strong className="code-inline">{roomCode}</strong> to invite someone.
                  </p>
                )}
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={snap.waitForEveryone}
                    onChange={(e) => engine.setWaitForEveryone(e.target.checked)}
                  />
                  <span>
                    Wait for everyone
                    <span className="switch-hint">
                      Pause the room when someone is buffering
                    </span>
                  </span>
                </label>
              </>
            ) : (
              <>
                {snap.media && !changing && (
                  <div className="current-media">
                    <div className="label">Now playing</div>
                    <p className="current-media-title">{snap.media.title}</p>
                    <button
                      className="btn btn-block"
                      type="button"
                      onClick={() => setChanging(true)}
                    >
                      Change video
                    </button>
                  </div>
                )}
                {showPicker && (
                  <MediaPicker
                    name={name}
                    current={snap.media}
                    onPick={(ref) => {
                      setMediaError(null)
                      engine.setMedia(ref)
                      setChanging(false)
                    }}
                    onCancel={snap.media ? () => setChanging(false) : undefined}
                  />
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

function formatDrift(drift: number): string {
  const abs = Math.abs(drift)
  if (abs < 0.35) return 'in sync'
  return `${abs.toFixed(1)}s ${drift > 0 ? 'ahead' : 'behind'}`
}

function StatusChip({
  snap,
  joinError,
}: {
  snap: ReturnType<SyncEngine['getSnapshot']>
  joinError: string | null
}) {
  if (joinError) return <span className="chip chip-bad">Connection problem</span>
  if (snap.gated && snap.waitingFor.length > 0) {
    return <span className="chip chip-warn">Waiting for {snap.waitingFor.join(', ')}</span>
  }
  if (snap.gated) return <span className="chip chip-warn">Buffering…</span>
  if (!snap.connected) return <span className="chip">Just you</span>
  return <span className="chip chip-ok">In sync · {snap.peerCount} watching</span>
}

function Overlay({
  snap,
  mediaError,
  onUnlock,
  onPick,
}: {
  snap: ReturnType<SyncEngine['getSnapshot']>
  mediaError: string | null
  onUnlock: () => void
  onPick: () => void
}) {
  if (!snap.media) {
    return (
      <div className="overlay">
        <div className="overlay-inner">
          <p className="overlay-title">No video yet</p>
          <p className="overlay-sub">Paste a public Google Drive link to get started.</p>
          <button className="btn btn-primary" type="button" onClick={onPick}>
            Add a video
          </button>
        </div>
      </div>
    )
  }

  if (mediaError) {
    return (
      <div className="overlay">
        <div className="overlay-inner">
          <p className="overlay-title">Can&rsquo;t play this video</p>
          <p className="overlay-sub">{mediaError}</p>
          <button className="btn btn-primary" type="button" onClick={onPick}>
            Use a different link
          </button>
        </div>
      </div>
    )
  }

  if (snap.needsGesture) {
    return (
      <button className="overlay overlay-tap" type="button" onClick={onUnlock}>
        <div className="overlay-inner">
          <p className="overlay-title">Tap to start</p>
          <p className="overlay-sub">
            Your browser needs one tap before it will play sound.
          </p>
        </div>
      </button>
    )
  }

  if (snap.gated) {
    return (
      <div className="overlay overlay-soft">
        <div className="overlay-inner">
          <span className="spinner" aria-hidden="true" />
          <p className="overlay-title">
            {snap.waitingFor.length
              ? `Waiting for ${snap.waitingFor.join(', ')}`
              : 'Buffering'}
          </p>
          <p className="overlay-sub">Everyone starts again together.</p>
        </div>
      </div>
    )
  }

  if (!snap.intentPlaying && snap.targetTime === 0) {
    return (
      <div className="overlay overlay-soft overlay-quiet">
        <div className="overlay-inner">
          <p className="overlay-sub">Ready · {formatTime(snap.targetTime)}</p>
        </div>
      </div>
    )
  }

  return null
}
