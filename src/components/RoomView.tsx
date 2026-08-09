import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatBytes } from '../lib/format'
import { canFullscreenElement } from '../lib/fullscreen'
import { roomUrl } from '../lib/roomCode'
import { useFileDrop } from '../hooks/useFileDrop'
import { useShareUrl, type ShareUrlState } from '../hooks/useShareUrl'
import { canShareLocalFile } from '../lib/device'
import type { ShareSession } from '../share/session'
import { firstVideoFile, shareLocalFile } from '../share/shareFile'
import type { SyncEngine } from '../sync/engine'
import { Controls } from './Controls'
import { MediaPicker } from './MediaPicker'
import { PeopleList } from './PeopleList'
import { Player, type VideoMeta } from './Player'
import { Toasts } from './Toasts'
import { useImmersive } from '../hooks/useImmersive'
import { VoiceButton } from './VoiceButton'
import { VoicePanel } from './VoicePanel'
import { VOICE_OFF, type VoiceChat } from '../voice/voiceChat'

interface Props {
  engine: SyncEngine
  voice: VoiceChat | null
  /** Fetches files shared from another person's disk. Null without a transport. */
  shareSession: ShareSession | null
  roomCode: string
  name: string
  joinError: string | null
  onLeave: () => void
}

type Tab = 'people' | 'video'

export function RoomView({
  engine,
  voice,
  shareSession,
  roomCode,
  name,
  joinError,
  onLeave,
}: Props) {
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
  const voiceSnap = useSyncExternalStore(
    voice ? voice.subscribe : NO_SUBSCRIBE,
    voice ? voice.getSnapshot : NO_VOICE,
  )
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const playerRef = useRef<HTMLDivElement | null>(null)

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

  // A file shared from someone's disk has no URL of its own: each browser
  // resolves one, and until it has, there is nothing for the element to load.
  const localShare = snap.media?.kind === 'local' ? (snap.media.share ?? null) : null
  const hostPresent = !!localShare && snap.peers.some((p) => p.id === localShare.hostId)
  const shareUrl = useShareUrl(localShare, shareSession, snap.selfId, hostPresent)
  const src = localShare
    ? shareUrl.state.status === 'ready'
      ? shareUrl.state.url
      : null
    : (snap.media?.url ?? null)

  // Copying a whole film across is minutes, not seconds. Say so, so the room
  // carries on without us instead of everyone staring at a spinner; we join at
  // whatever point they have reached once the copy lands.
  const copying = shareUrl.state.status === 'preparing'
  useEffect(() => engine.setFetching(copying), [engine, copying])

  // Dropping a film on the picture is what people try first, so it is worth
  // supporting rather than making them find the button. Same validation and
  // same registration as the button — see share/shareFile.ts.
  const [dropError, setDropError] = useState<string | null>(null)
  const onFilesDropped = useCallback(
    (files: FileList) => {
      const file = firstVideoFile(files)
      if (!file) return
      const attempt = shareLocalFile(file, { selfId: snap.selfId, name })
      if (!attempt.ok) {
        setDropError(attempt.error)
        return
      }
      setDropError(null)
      setMediaError(null)
      engine.setMedia(attempt.ref)
      setChanging(false)
    },
    [engine, name, snap.selfId],
  )
  const drop = useFileDrop(playerRef, onFilesDropped, canShareLocalFile())

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

  const immersive = useImmersive(playerRef, videoRef, snap.effectivePlaying)

  // Any interaction anywhere counts as the gesture iOS is waiting for, so most
  // people never see the "tap to hear" prompt — the first thing they touch
  // starts the audio. The prompt is the fallback for someone who touches
  // nothing at all.
  useEffect(() => {
    if (!voice) return
    const retry = () => void voice.resumePlayback()
    document.addEventListener('pointerdown', retry)
    document.addEventListener('keydown', retry)
    return () => {
      document.removeEventListener('pointerdown', retry)
      document.removeEventListener('keydown', retry)
    }
  }, [voice])

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
          immersive.toggle()
          break
        case 'm':
          setMuted((v) => !v)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, immersive])

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
          {/* Video and controls share one element, so going fullscreen takes
              the controls with it instead of leaving them behind. */}
          <div
            className={`player${
              immersive.active && !immersive.controlsVisible ? ' player-idle' : ''
            }${drop.dragging ? ' player-drop' : ''}`}
            ref={playerRef}
            onPointerMove={immersive.wake}
            onPointerDown={immersive.wake}
            onTouchStart={immersive.wake}
          >
            <div className="stage">
              <Player
                engine={engine}
                media={snap.media}
                src={src}
                videoRef={videoRef}
                onMeta={onMeta}
                onError={onError}
                onStreamFailed={shareUrl.useDownload}
                muted={muted}
                volume={volume}
              />

              <Toasts engine={engine} muted={muted} />

              {voice && voiceSnap.needsGesture && (
                <button
                  className="voice-unlock"
                  type="button"
                  onClick={() => void voice.resumePlayback()}
                >
                  Tap to hear voice chat
                </button>
              )}

              {drop.dragging && (
                <div className="overlay overlay-soft" role="status">
                  <div className="overlay-inner">
                    <p className="overlay-title">Drop to play it together</p>
                    <p className="overlay-sub">
                      It stays on this computer and streams to the room.
                    </p>
                  </div>
                </div>
              )}

              <Overlay
                snap={snap}
                mediaError={mediaError}
                dropError={dropError}
                shareState={localShare ? shareUrl.state : null}
                shareSize={localShare?.size ?? 0}
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
              onFullscreen={immersive.toggle}
              // A YouTube embed on an iPhone is the one case our button cannot
              // serve: there is no element this browser will fullscreen, and no
              // <video> of our own to hand to Apple's player. The embed keeps
              // its own controls there, and its fullscreen button works.
              canFullscreen={
                snap.media?.kind !== 'youtube' || canFullscreenElement()
              }
              disabled={noMedia}
              voiceButton={<VoiceButton voice={voice} />}
            />
          </div>

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
                {snap.media.kind === 'youtube' && (
                  // The embed's own "Watch on YouTube" affordance sits under
                  // the click catcher, so put one back where it still works.
                  <>
                    {' · '}
                    <a
                      className="link"
                      href={snap.media.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Open on YouTube
                    </a>
                  </>
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
                <PeopleList snap={snap} voice={voice ? voiceSnap : null} />
                {snap.peerCount === 1 && (
                  <p className="footnote">
                    Nobody else is here yet. Share the room code
                    {' '}<strong className="code-inline">{roomCode}</strong> to invite someone.
                  </p>
                )}
                {voice && <VoicePanel voice={voice} />}
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
                    selfId={snap.selfId}
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

const NO_SUBSCRIBE = () => () => {}
// Must return the same object every call, or useSyncExternalStore loops.
const NO_VOICE = () => VOICE_OFF

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
  // A join error is per-peer and often transient. If we are talking to
  // somebody, the room is working — do not cry wolf about it.
  if (joinError && !snap.connected) {
    // Worded as an attempt rather than a verdict, because it is one: a failed
    // handshake now rebuilds the connection and tries again, with backoff.
    return (
      <span className="chip chip-bad" title={joinError}>
        Can&rsquo;t reach them · retrying
      </span>
    )
  }
  if (snap.selfInAd) return <span className="chip chip-warn">Your ad is playing</span>
  if (snap.gated && snap.waitingForAd.length > 0) {
    // Naming the ad matters: "buffering" reads as a broken connection, and the
    // person waiting starts fiddling with something that is not wrong.
    return (
      <span className="chip chip-warn">
        {snap.waitingForAd.join(', ')} · ad
      </span>
    )
  }
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
  dropError,
  shareState,
  shareSize,
  onUnlock,
  onPick,
}: {
  snap: ReturnType<SyncEngine['getSnapshot']>
  mediaError: string | null
  /** A dropped file that was refused before it ever reached the room. */
  dropError: string | null
  /** Null unless the room is watching a file from somebody's disk. */
  shareState: ShareUrlState | null
  shareSize: number
  onUnlock: () => void
  onPick: () => void
}) {
  // Ahead of the empty state, which would otherwise hide it: a refused drop
  // happens precisely when there is no video yet.
  if (dropError) {
    return (
      <div className="overlay">
        <div className="overlay-inner">
          <p className="overlay-title">Can&rsquo;t play that file</p>
          <p className="overlay-sub">{dropError}</p>
          <button className="btn btn-primary" type="button" onClick={onPick}>
            Choose another
          </button>
        </div>
      </div>
    )
  }

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

  // A shared file's problems are all about the person holding it, so they are
  // reported before anything the player itself could say.
  if (shareState && shareState.status !== 'ready') {
    if (shareState.status === 'waiting') {
      return (
        <div className="overlay">
          <div className="overlay-inner">
            <p className="overlay-title">Waiting for {snap.media.setBy}</p>
            <p className="overlay-sub">
              This film is playing from their computer, so it needs them here.
              It starts on its own when they are back — though if they reloaded
              the page, they will have to pick the file again.
            </p>
            <button className="btn" type="button" onClick={onPick}>
              Play something else
            </button>
          </div>
        </div>
      )
    }
    if (shareState.status === 'error') {
      return (
        <div className="overlay">
          <div className="overlay-inner">
            <p className="overlay-title">Can&rsquo;t get this file</p>
            <p className="overlay-sub">{shareState.message}</p>
            <button className="btn btn-primary" type="button" onClick={onPick}>
              Play something else
            </button>
          </div>
        </div>
      )
    }
    if (shareState.status === 'resolving') {
      return (
        <div className="overlay overlay-soft">
          <div className="overlay-inner">
            <span className="spinner" aria-hidden="true" />
            <p className="overlay-title">Getting the film</p>
            <p className="overlay-sub">
              It is coming from {snap.media.setBy}&rsquo;s computer.
            </p>
          </div>
        </div>
      )
    }
    const percent = Math.round(shareState.progress * 100)
    return (
      <div className="overlay overlay-soft">
        <div className="overlay-inner">
          <p className="overlay-title">Copying the film across</p>
          <p className="overlay-sub">
            This browser will not play it as it arrives, so it has to come over
            in full first — {percent}% of {formatBytes(shareSize)}.
          </p>
          <div
            className="share-bar"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="share-bar-fill" style={{ width: `${percent}%` }} />
          </div>
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

  // Our own ad is the one case where nothing must cover the picture: the Skip
  // button is in there, and it belongs to the person watching. A corner note
  // explains why everyone else has stopped.
  if (snap.selfInAd) {
    return (
      <div className="ad-note" role="status">
        <span className="ad-dot" aria-hidden="true" />
        Ad playing{snap.peerCount > 1 ? ' — the room is waiting for you' : ''}
        {snap.selfAdMs > 1500 && <> · {Math.round(snap.selfAdMs / 1000)}s</>}
      </div>
    )
  }

  if (snap.gated) {
    const ads = snap.waitingForAd
    return (
      <div className="overlay overlay-soft">
        <div className="overlay-inner">
          <span className="spinner" aria-hidden="true" />
          <p className="overlay-title">
            {ads.length
              ? `${joinNames(ads)} ${ads.length === 1 ? 'has' : 'have'} an ad`
              : snap.waitingFor.length
                ? `Waiting for ${joinNames(snap.waitingFor)}`
                : 'Buffering'}
          </p>
          <p className="overlay-sub">
            {ads.length
              ? 'YouTube shows ads to each person separately. The film waits.'
              : 'Everyone starts again together.'}
          </p>
        </div>
      </div>
    )
  }

  return null
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
