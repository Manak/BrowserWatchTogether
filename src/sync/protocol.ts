import type { MediaRef } from '../lib/drive'

/**
 * Wire protocol for the room. Every message is a small JSON object broadcast
 * over WebRTC data channels — there is no server, so these types *are* the
 * contract between peers. Treat changes as breaking and bump PROTOCOL_VERSION.
 */
export const PROTOCOL_VERSION = 1

/** Shared playback intent. `at` is stamped in `origin`'s wall clock. */
export interface Playback {
  /** What the room *wants* to be doing. Local buffering may override this. */
  playing: boolean
  /** Media time (seconds) at instant `at`. */
  time: number
  /** origin's Date.now() when this state was created. */
  at: number
  /** Peer whose clock `at` belongs to. */
  origin: string
  /** Lamport counter — resolves simultaneous control presses. */
  seq: number
}

export interface HelloMsg {
  t: 'hello'
  v: number
  name: string
  /** Ask the recipient to introduce itself back (avoids an infinite volley). */
  reply: boolean
}

/** Full room state, sent by the leader to a peer that just showed up. */
export interface SyncMsg {
  t: 'sync'
  v: number
  media: MediaRef | null
  playback: Playback
  waitForEveryone: boolean
}

/** A deliberate user action: play, pause, seek, or swap the media. */
export interface CtrlMsg {
  t: 'ctrl'
  playback: Playback
  /** Present only when the action changed the media. */
  media?: MediaRef | null
  waitForEveryone?: boolean
}

/**
 * Leader heartbeat. Does not change the control epoch (`seq`), it just
 * re-anchors everyone to the leader's *actual* playhead so small decode-rate
 * differences do not accumulate.
 */
export interface TickMsg {
  t: 'tick'
  seq: number
  /** Leader's real video.currentTime. */
  time: number
  /** Leader's Date.now() at that reading. */
  at: number
  /** Whether the leader's element is genuinely advancing right now. */
  advancing: boolean
}

/** Buffer health report, used to hold the room for whoever is behind. */
export interface ReadyMsg {
  t: 'ready'
  ready: boolean
  /** Seconds of contiguous buffer ahead of the playhead. */
  buffered: number
  time: number
  ended: boolean
}

export interface PingMsg {
  t: 'ping'
  id: number
  t0: number
}

export interface PongMsg {
  t: 'pong'
  id: number
  t0: number
  /** Responder's Date.now() when it handled the ping. */
  t1: number
}

/** Someone left on purpose (fires before the transport notices). */
export interface ByeMsg {
  t: 'bye'
}

export type Msg =
  | HelloMsg
  | SyncMsg
  | CtrlMsg
  | TickMsg
  | ReadyMsg
  | PingMsg
  | PongMsg
  | ByeMsg

// ---------------------------------------------------------------------------
// Tuning. Defaults are chosen for the stated goal: never drift more than a few
// seconds, and never stutter while correcting.
// ---------------------------------------------------------------------------

export const TUNING = {
  /** Drift below this is ignored entirely — chasing it would cause jitter. */
  deadbandSec: 0.15,
  /** Wider deadband while paused, so we do not micro-seek on every update. */
  pausedDeadbandSec: 0.3,
  /** Above this, a smooth rate nudge cannot catch up in reasonable time. */
  hardSeekSec: 2.0,
  /** Max speed-up/slow-down while converging. 10% is inaudible on speech. */
  maxRateDelta: 0.1,
  /** Aim to erase the drift over roughly this window. */
  correctionWindowSec: 12,
  /** Ignore drift for this long after a seek, while the element settles. */
  settleMs: 1200,
  /** Leader heartbeat period. */
  tickMs: 2000,
  /** Clock-offset probe period. */
  pingMs: 5000,
  /** Buffer ahead of the playhead required to count as "ready". */
  minBufferSec: 2,
  /** Buffer ahead required to *resume* after a stall (hysteresis). */
  resumeBufferSec: 4,
  /** How far ahead of "now" a coordinated resume is scheduled. */
  resumeLeadMs: 400,
  /** Peers silent for longer than this are treated as gone. */
  peerTimeoutMs: 30000,
} as const

export type Tuning = typeof TUNING
