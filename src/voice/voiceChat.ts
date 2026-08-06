import type { Msg } from '../sync/protocol'
import type { Transport } from '../sync/transport'
import { SPEAKING_DEFAULTS, SpeakingDetector, type SpeakingOptions } from './speaking'

/**
 * Voice chat over the room's existing peer connections.
 *
 * Two properties matter and are both structural rather than best-effort:
 *
 * 1. **The video is never ducked.** This class has no reference to the video
 *    element and no way to reach it, so it cannot turn the film down when
 *    somebody talks. Echo is handled by the browser's echo canceller instead,
 *    which removes the film from *your outgoing microphone* — your partner
 *    stops hearing a doubled soundtrack, and your own playback is untouched.
 *
 * 2. **Latency stays low.** Audio rides the peer connections that already
 *    exist, so there is no server hop, and receivers are asked for the smallest
 *    jitter buffer the browser will accept.
 */

export type VoiceState =
  | 'off'
  | 'starting'
  | 'on'
  /** The user said no, or the browser blocked it. */
  | 'denied'
  /** No microphone, or the API is missing (insecure origin, old browser). */
  | 'unavailable'
  | 'error'

export interface VoicePeer {
  on: boolean
  muted: boolean
  speaking: boolean
}

export interface VoiceSnapshot {
  state: VoiceState
  /** Mic is on but deliberately silenced. */
  muted: boolean
  /** We are talking right now. */
  speaking: boolean
  error: string | null
  peers: Record<string, VoicePeer>
  /** True when at least one other person has their mic on. */
  anyoneElseOn: boolean
  /**
   * Someone is talking but the browser refused to play them until we get a
   * user gesture. Listeners who never touch the screen hit this on iOS.
   */
  needsGesture: boolean
}

/** A remote peer's audio, attached to something audible. */
export interface RemoteAudio {
  /** Start playback. Resolves false when the browser refused. */
  play(): Promise<boolean>
  detach(): void
}

/**
 * The snapshot to show when there is no voice chat at all.
 *
 * A single frozen instance, because `useSyncExternalStore` compares snapshots
 * by identity: returning a fresh object each call makes React re-render
 * forever.
 */
export const VOICE_OFF: VoiceSnapshot = Object.freeze({
  state: 'off',
  muted: false,
  speaking: false,
  error: null,
  peers: Object.freeze({}),
  anyoneElseOn: false,
  needsGesture: false,
}) as VoiceSnapshot

/** Reads the current microphone level. Real one uses an AnalyserNode. */
export interface LevelMeter {
  rms(): number
  close(): void
}

export interface VoiceDeps {
  transport: Transport
  now?: () => number
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  /** Build a level meter for the local stream. Optional: no meter, no speaking flag. */
  makeMeter?: (stream: MediaStream) => LevelMeter | null
  /** Attach a remote stream to something audible. */
  playRemote?: (stream: MediaStream, peerId: string) => RemoteAudio
  /** Ask the platform to keep playback and capture running together. */
  configureAudioSession?: () => void
  speaking?: SpeakingOptions
}

/**
 * Capture constraints. Echo cancellation is the important one: without it your
 * microphone re-sends the film's own soundtrack to the other end, half a second
 * late, which is exactly the doubled-audio effect people describe as an echo.
 */
export const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
}

/** How often we sample the mic level and, if it changed, tell the room. */
const METER_MS = 100
/** Re-announce this often even when nothing changed, so late joiners catch up. */
const REANNOUNCE_MS = 5000

export class VoiceChat {
  private readonly transport: Transport
  private readonly now: () => number
  private readonly getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
  private readonly makeMeter: (s: MediaStream) => LevelMeter | null
  private readonly playRemote: (s: MediaStream, id: string) => RemoteAudio
  private readonly configureAudioSession: () => void

  private state: VoiceState = 'off'
  private error: string | null = null
  private muted = false
  private speaking = false

  private stream: MediaStream | null = null
  private meter: LevelMeter | null = null
  private readonly detector: SpeakingDetector
  private readonly peers = new Map<string, VoicePeer>()
  private readonly remotes = new Map<string, RemoteAudio>()
  /** Remotes the browser refused to start until we get a gesture. */
  private readonly blocked = new Set<string>()

  private lastMeterAt = 0
  private lastAnnounceAt = 0
  private lastAnnounced = ''
  private destroyed = false

  private listeners = new Set<() => void>()
  private snapshot: VoiceSnapshot
  private dirty = true

  constructor(deps: VoiceDeps) {
    this.transport = deps.transport
    this.now = deps.now ?? (() => Date.now())
    this.getUserMedia =
      deps.getUserMedia ??
      ((c) => {
        const md = globalThis.navigator?.mediaDevices
        if (!md?.getUserMedia) {
          return Promise.reject(new DOMException('unsupported', 'NotSupportedError'))
        }
        return md.getUserMedia(c)
      })
    this.makeMeter = deps.makeMeter ?? (() => null)
    this.playRemote =
      deps.playRemote ?? (() => ({ play: () => Promise.resolve(true), detach: () => {} }))
    this.configureAudioSession = deps.configureAudioSession ?? (() => {})
    this.detector = new SpeakingDetector(deps.speaking ?? SPEAKING_DEFAULTS)
    this.snapshot = this.build()

    this.transport.onMessage((msg, from) => this.handle(msg, from))
    this.transport.onPeerLeave((id) => this.dropPeer(id))
    this.transport.onPeerJoin((id) => this.offerLocalStream(id))
    this.transport.media?.onPeerStream((stream, peerId) => {
      this.attachRemote(stream, peerId)
    })
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  /** Must be called from a user gesture — browsers require one for the mic. */
  async enable(): Promise<void> {
    if (this.destroyed || this.state === 'on' || this.state === 'starting') return
    this.state = 'starting'
    this.error = null
    this.invalidate()

    // Do this before capture starts: on iOS, opening a microphone otherwise
    // switches the audio session in a way that quietens everything else.
    this.configureAudioSession()

    try {
      const stream = await this.getUserMedia(AUDIO_CONSTRAINTS)
      if (this.destroyed) {
        stopStream(stream)
        return
      }
      this.stream = stream
      this.applyMuteToTracks()
      this.transport.media?.addStream(stream)
      this.meter = this.makeMeter(stream)
      this.state = 'on'
      this.tuneReceiversForLatency()
      // Turning the mic on is a user gesture, so it is a free chance to start
      // any remote the browser refused earlier.
      void this.resumePlayback()
      this.announce(true)
    } catch (err) {
      this.state = classifyError(err)
      this.error = describeError(err)
    }
    this.invalidate()
  }

  disable(): void {
    if (this.stream) {
      this.transport.media?.removeStream(this.stream)
      stopStream(this.stream)
      this.stream = null
    }
    this.meter?.close()
    this.meter = null
    this.detector.reset()
    this.speaking = false
    this.state = 'off'
    this.error = null
    this.announce(true)
    this.invalidate()
  }

  async toggle(): Promise<void> {
    if (this.state === 'on') this.disable()
    else await this.enable()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyMuteToTracks()
    if (muted) {
      this.detector.reset()
      this.speaking = false
    }
    this.announce(true)
    this.invalidate()
  }

  toggleMuted(): void {
    this.setMuted(!this.muted)
  }

  /** Drive metering and presence. Call on the same interval as the engine. */
  update(): void {
    if (this.destroyed) return
    const now = this.now()

    if (this.state === 'on' && this.meter && now - this.lastMeterAt >= METER_MS) {
      this.lastMeterAt = now
      // A muted mic is silent by definition; do not light up the indicator.
      const level = this.muted ? 0 : this.meter.rms()
      const next = this.detector.push(level, now)
      if (next !== this.speaking) {
        this.speaking = next
        this.invalidate()
      }
    }

    this.announce(false)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const remote of this.remotes.values()) remote.detach()
    this.remotes.clear()
    this.blocked.clear()
    if (this.stream) {
      this.transport.media?.removeStream(this.stream)
      stopStream(this.stream)
      this.stream = null
    }
    this.meter?.close()
    this.meter = null
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): VoiceSnapshot => {
    if (this.dirty) {
      this.snapshot = this.build()
      this.dirty = false
    }
    return this.snapshot
  }

  private build(): VoiceSnapshot {
    const peers: Record<string, VoicePeer> = {}
    let anyoneElseOn = false
    for (const [id, p] of this.peers) {
      peers[id] = { ...p }
      if (p.on) anyoneElseOn = true
    }
    return {
      state: this.state,
      muted: this.muted,
      speaking: this.speaking,
      error: this.error,
      peers,
      anyoneElseOn,
      needsGesture: this.blocked.size > 0,
    }
  }

  private invalidate(): void {
    this.dirty = true
    for (const fn of this.listeners) fn()
  }

  // -------------------------------------------------------------------------
  // Wire
  // -------------------------------------------------------------------------

  private handle(msg: Msg, from: string): void {
    if (this.destroyed || msg.t !== 'mic' || from === this.transport.selfId) return
    this.peers.set(from, { on: msg.on, muted: msg.muted, speaking: msg.speaking })
    this.invalidate()
  }

  private dropPeer(id: string): void {
    this.peers.delete(id)
    this.remotes.get(id)?.detach()
    this.remotes.delete(id)
    this.blocked.delete(id)
    this.invalidate()
  }

  private attachRemote(stream: MediaStream, peerId: string): void {
    if (this.destroyed) return
    // A peer that re-enables its mic sends a new stream; drop the old one.
    this.remotes.get(peerId)?.detach()
    const remote = this.playRemote(stream, peerId)
    this.remotes.set(peerId, remote)
    this.tuneReceiversForLatency()
    void this.start(peerId, remote)
  }

  /**
   * Send our microphone to a peer that has just appeared.
   *
   * `addStream` only reaches the peers connected at the moment it is called,
   * so without this anyone who joins — or rejoins after their connection
   * dropped — hears silence from us forever. Reconnects look exactly like
   * joins, which is what makes this the recovery path too.
   */
  private offerLocalStream(peerId: string): void {
    if (this.destroyed || !this.stream) return
    this.transport.media?.addStream(this.stream, peerId)
    // Also re-announce, so they learn our mute state without waiting.
    this.announce(true)
  }

  /** Try to start a remote, recording whether the browser refused. */
  private async start(peerId: string, remote: RemoteAudio): Promise<void> {
    const ok = await remote.play()
    if (this.destroyed || this.remotes.get(peerId) !== remote) return
    if (ok) this.blocked.delete(peerId)
    else this.blocked.add(peerId)
    this.invalidate()
  }

  /**
   * Retry every remote the browser refused to start. Must be called from a
   * real user gesture — that is the whole point.
   *
   * Someone who joins to watch and never touches the screen has made no
   * gesture at all, so iOS silently blocks their partner's voice. There is no
   * way to detect that except to try, fail, and ask for a tap.
   */
  async resumePlayback(): Promise<void> {
    const pending = [...this.blocked]
    await Promise.all(
      pending.map(async (peerId) => {
        const remote = this.remotes.get(peerId)
        if (remote) await this.start(peerId, remote)
      }),
    )
  }

  /** Announce mic state, on change or as a periodic refresh. */
  private announce(force: boolean): void {
    const now = this.now()
    const payload = `${this.state === 'on'}|${this.muted}|${this.speaking}`
    const stale = now - this.lastAnnounceAt >= REANNOUNCE_MS
    if (!force && payload === this.lastAnnounced && !stale) return
    this.lastAnnounced = payload
    this.lastAnnounceAt = now
    this.transport.send({
      t: 'mic',
      on: this.state === 'on',
      muted: this.muted,
      speaking: this.speaking,
    })
  }

  private applyMuteToTracks(): void {
    // Disabling the track keeps the connection up and makes unmuting instant,
    // where stopping it would need a fresh negotiation every time.
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.enabled = !this.muted
    }
  }

  /**
   * Ask the browser for the smallest jitter buffer it will give us. Chrome
   * defaults to a comfortable buffer that trades latency for smoothness; for
   * two people talking over a film, responsiveness matters more.
   */
  private tuneReceiversForLatency(): void {
    const connections = this.transport.media?.connections() ?? {}
    for (const pc of Object.values(connections)) {
      for (const receiver of pc.getReceivers?.() ?? []) {
        if (receiver.track?.kind !== 'audio') continue
        // Non-standard, Chromium-only, and simply absent elsewhere.
        const tunable = receiver as RTCRtpReceiver & { playoutDelayHint?: number }
        try {
          tunable.playoutDelayHint = 0
        } catch {
          /* not supported here; the default buffer is fine */
        }
      }
    }
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

/**
 * getUserMedia rejects with a DOMException, which is *not* an `instanceof
 * Error` in every engine — so read the name structurally rather than gating on
 * the prototype chain, or every real permission denial lands in the generic
 * bucket with a useless message.
 */
function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return ''
}

function classifyError(err: unknown): VoiceState {
  const name = errorName(err)
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'NotSupportedError') return 'unavailable'
  return 'error'
}

function describeError(err: unknown): string {
  switch (errorName(err)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow it in your browser settings, then try again.'
    case 'NotFoundError':
      return 'No microphone found.'
    case 'NotSupportedError':
      return 'This browser cannot use the microphone here. Voice chat needs an https:// page.'
    case 'NotReadableError':
      return 'Your microphone is being used by another app.'
    default:
      return 'Could not turn on the microphone.'
  }
}
