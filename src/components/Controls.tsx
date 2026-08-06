import { useState } from 'react'
import { formatTime } from '../lib/format'
import type { SyncEngine, Snapshot } from '../sync/engine'
import type { VideoMeta } from './Player'

interface Props {
  engine: SyncEngine
  snap: Snapshot
  meta: VideoMeta
  muted: boolean
  volume: number
  onMuted: (v: boolean) => void
  onVolume: (v: number) => void
  onFullscreen: () => void
  disabled: boolean
  /** Voice-chat control, rendered next to the transport buttons. */
  voiceButton?: React.ReactNode
}

const SKIP = 10

export function Controls({
  engine,
  snap,
  meta,
  muted,
  volume,
  onMuted,
  onVolume,
  onFullscreen,
  disabled,
  voiceButton,
}: Props) {
  // While a finger is on the scrubber we show the finger's position, not the
  // room's, and only commit the seek on release — otherwise every pixel of
  // movement would broadcast a seek to everyone.
  const [scrub, setScrub] = useState<number | null>(null)
  const duration = meta.duration || 0
  const shown = scrub ?? meta.currentTime
  const pct = duration > 0 ? (shown / duration) * 100 : 0
  const bufferedPct = duration > 0 ? (meta.bufferedEnd / duration) * 100 : 0

  const commitScrub = () => {
    if (scrub === null) return
    engine.seek(scrub)
    setScrub(null)
  }

  return (
    <div className="controls">
      <div className="scrubber">
        <div className="scrub-track">
          <div className="scrub-buffered" style={{ width: `${bufferedPct}%` }} />
          <div className="scrub-played" style={{ width: `${pct}%` }} />
        </div>
        <input
          className="scrub-input"
          type="range"
          min={0}
          max={duration || 100}
          step={0.1}
          value={shown}
          disabled={disabled || duration === 0}
          aria-label="Seek"
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={commitScrub}
          onTouchEnd={commitScrub}
          onMouseUp={commitScrub}
          onKeyUp={commitScrub}
          onBlur={commitScrub}
        />
      </div>

      <div className="controls-row">
        <div className="controls-left">
          <button
            className="btn-icon"
            type="button"
            aria-label={`Back ${SKIP} seconds`}
            title={`Back ${SKIP}s`}
            disabled={disabled}
            onClick={() => engine.nudge(-SKIP)}
          >
            <IconBack />
          </button>

          <button
            className="btn-icon btn-icon-primary"
            type="button"
            aria-label={snap.intentPlaying ? 'Pause' : 'Play'}
            title={snap.intentPlaying ? 'Pause' : 'Play'}
            disabled={disabled}
            onClick={() => engine.togglePlay()}
          >
            {snap.intentPlaying ? <IconPause /> : <IconPlay />}
          </button>

          <button
            className="btn-icon"
            type="button"
            aria-label={`Forward ${SKIP} seconds`}
            title={`Forward ${SKIP}s`}
            disabled={disabled}
            onClick={() => engine.nudge(SKIP)}
          >
            <IconForward />
          </button>

          <span className="time" aria-live="off">
            {formatTime(shown)}
            <span className="muted"> / {formatTime(duration)}</span>
          </span>
        </div>

        <div className="controls-right">
          {voiceButton}
          <button
            className="btn-icon"
            type="button"
            aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute' : 'Mute'}
            onClick={() => onMuted(!muted)}
          >
            {muted || volume === 0 ? <IconMuted /> : <IconSound />}
          </button>

          {/* Volume is deliberately per-person and never synced. */}
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => {
              const v = Number(e.target.value)
              onVolume(v)
              onMuted(v === 0)
            }}
          />

          <button
            className="btn-icon"
            type="button"
            aria-label="Fullscreen"
            title="Fullscreen"
            onClick={onFullscreen}
          >
            <IconFullscreen />
          </button>
        </div>
      </div>
    </div>
  )
}

/* Inline SVGs: no icon font, no network request, scales cleanly on any DPI. */
const S = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'currentColor' } as const

const IconPlay = () => (
  <svg {...S} aria-hidden="true">
    <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" />
  </svg>
)
const IconPause = () => (
  <svg {...S} aria-hidden="true">
    <path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" />
  </svg>
)
const IconBack = () => (
  <svg {...S} aria-hidden="true">
    <path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z" />
    <text x="11.2" y="15.6" fontSize="7.5" textAnchor="middle" fill="currentColor">
      10
    </text>
  </svg>
)
const IconForward = () => (
  <svg {...S} aria-hidden="true">
    <path d="M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7Z" />
    <text x="12.6" y="15.6" fontSize="7.5" textAnchor="middle" fill="currentColor">
      10
    </text>
  </svg>
)
const IconSound = () => (
  <svg {...S} aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Zm-2.5 7.9a8 8 0 0 0 0-15.8v2.1a6 6 0 0 1 0 11.6v2.1Z" />
  </svg>
)
const IconMuted = () => (
  <svg {...S} aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4Zm12.7 3 2.3-2.3-1.4-1.4-2.3 2.3-2.3-2.3-1.4 1.4 2.3 2.3-2.3 2.3 1.4 1.4 2.3-2.3 2.3 2.3 1.4-1.4-2.3-2.3Z" />
  </svg>
)
const IconFullscreen = () => (
  <svg {...S} aria-hidden="true">
    <path d="M4 9V4h5v2H6v3H4Zm11-5h5v5h-2V6h-3V4ZM4 15h2v3h3v2H4v-5Zm14 0h2v5h-5v-2h3v-3Z" />
  </svg>
)
