import type { MediaRef } from '../lib/drive'
import { ClockSync } from './clockSync'
import { bufferedAhead, computeCorrection } from './drift'
import type { CtrlMsg, Msg, Playback, Tuning } from './protocol'
import { PROTOCOL_VERSION, TUNING } from './protocol'
import type { Transport } from './transport'

/**
 * Just enough of HTMLVideoElement for the engine to work with, so the whole
 * sync algorithm can be exercised against a simulated element in tests.
 * A real HTMLVideoElement satisfies this structurally.
 */
export interface MediaElementLike {
  currentTime: number
  playbackRate: number
  readonly paused: boolean
  readonly duration: number
  readonly readyState: number
  readonly ended: boolean
  readonly buffered: {
    readonly length: number
    start(i: number): number
    end(i: number): number
  }
  play(): Promise<void>
  pause(): void
}

export interface PeerView {
  id: string
  name: string
  isSelf: boolean
  isLeader: boolean
  /** Buffered enough to keep up. */
  ready: boolean
  /** Seconds of buffer ahead of their playhead. */
  buffered: number
  /** Their reported media time. */
  time: number
  rttMs: number | null
  /** Connected but silent for a while — excluded from the wait-for-everyone gate. */
  stale: boolean
}

export interface Snapshot {
  selfId: string
  name: string
  /** Everyone in the room, self first. */
  peers: PeerView[]
  media: MediaRef | null
  /** What the room intends: unaffected by local buffering. */
  intentPlaying: boolean
  /** What our element is actually doing. */
  effectivePlaying: boolean
  /** True when we are holding playback for someone who is buffering. */
  gated: boolean
  /** Display names we are waiting on. */
  waitingFor: string[]
  waitForEveryone: boolean
  leaderId: string
  isLeader: boolean
  /** Our playhead minus the room's target, in seconds. */
  driftSec: number
  targetTime: number
  /** The browser refused to autoplay; the UI must ask for a tap. */
  needsGesture: boolean
  /** At least one other person is connected. */
  connected: boolean
  playbackRate: number
  peerCount: number
}

interface PeerRecord {
  id: string
  name: string
  ready: boolean
  buffered: number
  time: number
  ended: boolean
  lastSeen: number
}

/** Where the room's playhead is anchored, and whether it is moving. */
interface Anchor {
  time: number
  at: number
  origin: string
  advancing: boolean
}

export interface EngineOptions {
  transport: Transport
  name: string
  now?: () => number
  tuning?: Tuning
  /** Start already knowing about a media item (used when restoring a session). */
  initialMedia?: MediaRef | null
}

const HAVE_CURRENT_DATA = 2
const HAVE_FUTURE_DATA = 3

export class SyncEngine {
  private readonly transport: Transport
  private readonly tuning: Tuning
  private readonly now: () => number
  private readonly clock = new ClockSync()

  private name: string
  private el: MediaElementLike | null = null
  private media: MediaRef | null
  private peers = new Map<string, PeerRecord>()

  private playback: Playback
  private anchor: Anchor
  private waitForEveryone = true

  private lastSeekAt = -Infinity
  // -Infinity so the first update() pings and heartbeats immediately: a newly
  // joined peer needs a clock offset before its first drift correction.
  private lastTickSent = -Infinity
  private lastPingSent = -Infinity
  private lastReadySent = -Infinity
  private lastReady = false
  private pingSeq = 0
  private readonly pending = new Map<number, { peerId: string; t0: number }>()

  private needsGesture = false
  private destroyed = false
  private playAttempt: Promise<void> | null = null

  private listeners = new Set<() => void>()
  private snapshot: Snapshot
  private snapshotDirty = true

  constructor(opts: EngineOptions) {
    this.transport = opts.transport
    this.tuning = opts.tuning ?? TUNING
    this.now = opts.now ?? (() => Date.now())
    this.name = opts.name
    this.media = opts.initialMedia ?? null

    const t = this.now()
    this.playback = {
      playing: false,
      time: 0,
      at: t,
      origin: this.transport.selfId,
      seq: 0,
    }
    this.anchor = { time: 0, at: t, origin: this.transport.selfId, advancing: false }
    this.snapshot = this.buildSnapshot()

    this.transport.onMessage((msg, from) => this.handle(msg, from))
    this.transport.onPeerJoin((id) => this.onPeerJoin(id))
    this.transport.onPeerLeave((id) => this.onPeerLeave(id))
  }

  // -------------------------------------------------------------------------
  // Host wiring
  // -------------------------------------------------------------------------

  attachMedia(el: MediaElementLike | null): void {
    this.el = el
    this.lastSeekAt = -Infinity
    if (el) this.hardResync()
    this.invalidate()
  }

  /** Call when the element has loaded a new source and knows its duration. */
  onMediaLoaded(): void {
    this.hardResync()
    this.invalidate()
  }

  /** The element buffered out; report it immediately rather than waiting. */
  onStalled(): void {
    this.sendReady(true)
    this.invalidate()
  }

  /**
   * The single heartbeat. Everything time-based happens here, so tests can
   * drive the whole engine deterministically by advancing a fake clock.
   * Call roughly every 250ms.
   */
  update(): void {
    if (this.destroyed) return
    const now = this.now()

    this.reapStalePeers(now)

    if (now - this.lastPingSent >= this.tuning.pingMs) {
      this.lastPingSent = now
      this.pingAll(now)
    }

    if (this.isLeader() && now - this.lastTickSent >= this.tuning.tickMs) {
      this.lastTickSent = now
      this.sendTick(now)
    }

    this.sendReady(false)
    this.enforce(now)
    this.invalidate()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.transport.send({ t: 'bye' })
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------
  // User intents
  // -------------------------------------------------------------------------

  play(): void {
    this.needsGesture = false
    this.issue({ playing: true, time: this.currentTime() })
  }

  pause(): void {
    this.issue({ playing: false, time: this.currentTime() })
  }

  togglePlay(): void {
    if (this.playback.playing) this.pause()
    else this.play()
  }

  seek(time: number): void {
    const clamped = this.clampToDuration(time)
    this.issue({ playing: this.playback.playing, time: clamped })
  }

  /** Skip button: relative to where the *room* is, not our local element. */
  nudge(deltaSec: number): void {
    this.seek(this.targetTime() + deltaSec)
  }

  setMedia(ref: MediaRef): void {
    this.media = ref
    this.issue({ playing: false, time: 0 }, { media: ref })
  }

  setWaitForEveryone(value: boolean): void {
    this.waitForEveryone = value
    this.issue(
      { playing: this.playback.playing, time: this.currentTime() },
      { waitForEveryone: value },
    )
  }

  setName(name: string): void {
    this.name = name
    this.transport.send({ t: 'hello', v: PROTOCOL_VERSION, name, reply: false })
    this.invalidate()
  }

  /**
   * Called from a real user gesture to satisfy mobile autoplay policy.
   * Resolves once the element has been permitted to play at least once.
   */
  async unlock(): Promise<void> {
    const el = this.el
    if (!el) return
    try {
      await el.play()
      if (!this.shouldBePlaying()) el.pause()
      this.needsGesture = false
    } catch {
      this.needsGesture = true
    }
    this.invalidate()
  }

  // -------------------------------------------------------------------------
  // Snapshot / subscription (for useSyncExternalStore)
  // -------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): Snapshot => {
    if (this.snapshotDirty) {
      this.snapshot = this.buildSnapshot()
      this.snapshotDirty = false
    }
    return this.snapshot
  }

  private invalidate(): void {
    this.snapshotDirty = true
    for (const l of this.listeners) l()
  }

  private buildSnapshot(): Snapshot {
    const selfId = this.transport.selfId
    const leaderId = this.leaderId()
    const now = this.now()

    const self: PeerView = {
      id: selfId,
      name: this.name,
      isSelf: true,
      isLeader: leaderId === selfId,
      ready: this.selfReady(),
      buffered: this.selfBuffered(),
      time: this.currentTime(),
      rttMs: null,
      stale: false,
    }

    const others = [...this.peers.values()]
      .map<PeerView>((p) => ({
        id: p.id,
        name: p.name,
        isSelf: false,
        isLeader: leaderId === p.id,
        ready: p.ready,
        buffered: p.buffered,
        time: p.time,
        rttMs: this.clock.rttTo(p.id),
        stale: now - p.lastSeen > this.tuning.peerTimeoutMs,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

    const waitingFor = this.notReadyPeers(now).map((p) => p.name)
    const target = this.targetTime()

    return {
      selfId,
      name: this.name,
      peers: [self, ...others],
      media: this.media,
      intentPlaying: this.playback.playing,
      effectivePlaying: !!this.el && !this.el.paused,
      gated: this.isGated(now),
      waitingFor,
      waitForEveryone: this.waitForEveryone,
      leaderId,
      isLeader: leaderId === selfId,
      driftSec: this.el ? this.el.currentTime - target : 0,
      targetTime: target,
      needsGesture: this.needsGesture,
      connected: this.peers.size > 0,
      playbackRate: this.el?.playbackRate ?? 1,
      peerCount: this.peers.size + 1,
    }
  }

  // -------------------------------------------------------------------------
  // Leadership
  // -------------------------------------------------------------------------

  /**
   * Deterministic and message-free: the lexicographically smallest peer id in
   * the room leads. Every peer computes the same answer from the same set, so
   * handover on disconnect is instant and needs no election.
   */
  private leaderId(): string {
    let min = this.transport.selfId
    for (const id of this.peers.keys()) if (id < min) min = id
    return min
  }

  private isLeader(): boolean {
    return this.leaderId() === this.transport.selfId
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  private onPeerJoin(id: string): void {
    this.touch(id)
    this.transport.send(
      { t: 'hello', v: PROTOCOL_VERSION, name: this.name, reply: true },
      id,
    )
    this.invalidate()
  }

  private onPeerLeave(id: string): void {
    this.peers.delete(id)
    this.clock.forget(id)
    this.invalidate()
  }

  private touch(id: string): PeerRecord {
    let rec = this.peers.get(id)
    if (!rec) {
      rec = {
        id,
        name: 'Guest',
        ready: false,
        buffered: 0,
        time: 0,
        ended: false,
        lastSeen: this.now(),
      }
      this.peers.set(id, rec)
    }
    rec.lastSeen = this.now()
    return rec
  }

  private handle(msg: Msg, from: string): void {
    if (this.destroyed || from === this.transport.selfId) return
    const rec = this.touch(from)

    switch (msg.t) {
      case 'hello': {
        rec.name = msg.name
        if (msg.reply) {
          this.transport.send(
            { t: 'hello', v: PROTOCOL_VERSION, name: this.name, reply: false },
            from,
          )
        }
        // The leader owns the canonical state, so it catches newcomers up.
        if (this.isLeader()) {
          this.transport.send(
            {
              t: 'sync',
              v: PROTOCOL_VERSION,
              media: this.media,
              playback: this.playback,
              waitForEveryone: this.waitForEveryone,
            },
            from,
          )
        }
        break
      }

      case 'sync': {
        // Only accept a catch-up from the leader, and only if it is not stale.
        if (from !== this.leaderId()) break
        if (msg.playback.seq < this.playback.seq) break
        this.media = msg.media
        this.waitForEveryone = msg.waitForEveryone
        this.adoptPlayback(msg.playback)
        break
      }

      case 'ctrl': {
        if (!this.acceptPlayback(msg.playback)) break
        if (msg.media !== undefined) this.media = msg.media
        if (msg.waitForEveryone !== undefined) {
          this.waitForEveryone = msg.waitForEveryone
        }
        this.adoptPlayback(msg.playback)
        break
      }

      case 'tick': {
        // Re-anchor to the leader's real playhead, but never let a heartbeat
        // override a newer control action.
        if (from !== this.leaderId()) break
        if (msg.seq !== this.playback.seq) break
        if (this.isLeader()) break
        this.anchor = this.localizeAnchor({
          time: msg.time,
          at: msg.at,
          origin: from,
          advancing: msg.advancing,
        })
        break
      }

      case 'ready': {
        rec.ready = msg.ready
        rec.buffered = msg.buffered
        rec.time = msg.time
        rec.ended = msg.ended
        break
      }

      case 'ping': {
        this.transport.send(
          { t: 'pong', id: msg.id, t0: msg.t0, t1: this.now() },
          from,
        )
        break
      }

      case 'pong': {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (p && p.peerId === from) {
          this.clock.addSample(from, p.t0, msg.t1, this.now())
        }
        break
      }

      case 'bye': {
        this.peers.delete(from)
        this.clock.forget(from)
        break
      }
    }
    this.invalidate()
  }

  private pingAll(now: number): void {
    // Keep the pending map from growing if a peer never answers.
    if (this.pending.size > 32) this.pending.clear()
    for (const id of this.peers.keys()) {
      const seq = ++this.pingSeq
      this.pending.set(seq, { peerId: id, t0: now })
      this.transport.send({ t: 'ping', id: seq, t0: now }, id)
    }
  }

  private sendTick(now: number): void {
    const el = this.el
    this.anchor = {
      time: el ? el.currentTime : this.playback.time,
      at: now,
      origin: this.transport.selfId,
      advancing: !!el && !el.paused && !el.ended,
    }
    this.transport.send({
      t: 'tick',
      seq: this.playback.seq,
      time: this.anchor.time,
      at: now,
      advancing: this.anchor.advancing,
    })
  }

  private sendReady(force: boolean): void {
    const now = this.now()
    const ready = this.selfReady()
    const changed = ready !== this.lastReady
    if (!force && !changed && now - this.lastReadySent < this.tuning.tickMs) return
    this.lastReady = ready
    this.lastReadySent = now
    this.transport.send({
      t: 'ready',
      ready,
      buffered: this.selfBuffered(),
      time: this.currentTime(),
      ended: !!this.el?.ended,
    })
  }

  /** Create and broadcast a new control epoch. */
  private issue(
    partial: { playing: boolean; time: number },
    extra: Omit<CtrlMsg, 't' | 'playback'> = {},
  ): void {
    const now = this.now()
    this.playback = {
      playing: partial.playing,
      time: partial.time,
      at: now,
      origin: this.transport.selfId,
      seq: this.playback.seq + 1,
    }
    this.adoptPlayback(this.playback)
    this.transport.send({ t: 'ctrl', playback: this.playback, ...extra })
    this.invalidate()
  }

  /**
   * Conflict resolution for simultaneous presses: higher epoch wins; ties break
   * on peer id so every peer lands on the same answer without extra messages.
   */
  private acceptPlayback(p: Playback): boolean {
    if (p.seq > this.playback.seq) return true
    if (p.seq < this.playback.seq) return false
    return p.origin < this.playback.origin
  }

  private adoptPlayback(p: Playback): void {
    this.playback = p
    this.anchor = this.localizeAnchor({
      time: p.time,
      at: p.at,
      origin: p.origin,
      advancing: p.playing,
    })
    this.hardResync()
  }

  /**
   * A remote timestamp is meaningless until we have measured that peer's clock
   * offset — a phone whose clock is a minute off would otherwise throw us a
   * minute out of position on the very first message. Until the first pong
   * lands, treat the message as having been sent "now"; the error is then one
   * network hop instead of an unbounded clock difference. The leader's regular
   * heartbeat re-anchors properly once real samples exist.
   */
  private localizeAnchor(a: Anchor): Anchor {
    if (a.origin === this.transport.selfId || this.clock.has(a.origin)) return a
    return { ...a, at: this.now(), origin: this.transport.selfId }
  }

  // -------------------------------------------------------------------------
  // Playback control
  // -------------------------------------------------------------------------

  private currentTime(): number {
    return this.el ? this.el.currentTime : this.targetTime()
  }

  /** Where the room believes the playhead should be, right now, locally. */
  targetTime(): number {
    const a = this.anchor
    if (!a.advancing) return a.time
    const nowInOrigin =
      a.origin === this.transport.selfId
        ? this.now()
        : this.clock.toPeerClock(a.origin, this.now())
    return a.time + Math.max(0, nowInOrigin - a.at) / 1000
  }

  private clampToDuration(t: number): number {
    const d = this.el?.duration
    const lo = Math.max(0, t)
    if (d !== undefined && Number.isFinite(d) && d > 0) {
      return Math.min(lo, Math.max(0, d - 0.05))
    }
    return lo
  }

  private selfBuffered(): number {
    const el = this.el
    if (!el) return 0
    return bufferedAhead(el.buffered, el.currentTime)
  }

  private selfReady(): boolean {
    const el = this.el
    if (!this.media) return true
    if (!el) return false
    if (el.ended) return true
    // Hysteresis: once we have stalled, demand a deeper buffer before we claim
    // to be ready again, so the room does not stutter in and out of the gate.
    const need = this.lastReady
      ? this.tuning.minBufferSec
      : this.tuning.resumeBufferSec
    return el.readyState >= HAVE_FUTURE_DATA && this.selfBuffered() >= need
  }

  private notReadyPeers(now: number): PeerRecord[] {
    return [...this.peers.values()].filter(
      (p) => !p.ready && now - p.lastSeen <= this.tuning.peerTimeoutMs,
    )
  }

  /** True when we are deliberately holding playback for someone. */
  private isGated(now: number): boolean {
    if (!this.waitForEveryone) return false
    if (!this.playback.playing) return false
    if (!this.selfReady()) return true
    return this.notReadyPeers(now).length > 0
  }

  private shouldBePlaying(): boolean {
    const now = this.now()
    if (!this.playback.playing) return false
    if (!this.media) return false
    if (this.el?.ended) return false
    return !this.isGated(now)
  }

  /** Jump straight to the room's position — used after seeks and media loads. */
  private hardResync(): void {
    const el = this.el
    if (!el) return
    if (el.readyState < HAVE_CURRENT_DATA && el.currentTime === 0) {
      // Nothing decoded yet; the seek would be dropped. `onMediaLoaded` retries.
      return
    }
    const target = this.clampToDuration(this.targetTime())
    if (Math.abs(el.currentTime - target) > this.tuning.deadbandSec) {
      el.currentTime = target
      this.lastSeekAt = this.now()
    }
    el.playbackRate = 1
    this.applyPlayState()
  }

  private applyPlayState(): void {
    const el = this.el
    if (!el) return
    const want = this.shouldBePlaying()
    // Once autoplay has been refused, stop hammering play(): every rejected
    // call is a console error, and only a real gesture can change the answer.
    if (want && el.paused && !this.needsGesture) {
      const p = el.play()
      this.playAttempt = p
      void p
        .then(() => {
          if (this.playAttempt === p) this.needsGesture = false
        })
        .catch(() => {
          // Autoplay policy, almost always on mobile before any interaction.
          if (this.playAttempt === p) {
            this.needsGesture = true
            this.invalidate()
          }
        })
    } else if (!want && !el.paused) {
      el.pause()
    }
  }

  /** Per-update convergence: keep our element locked to the room's playhead. */
  private enforce(now: number): void {
    const el = this.el
    if (!el || !this.media) return

    this.applyPlayState()

    // The leader defines the playhead, so it never corrects against itself.
    if (this.isLeader()) {
      el.playbackRate = 1
      return
    }
    // Do not fight the network while we are the one buffering.
    if (el.readyState < HAVE_CURRENT_DATA) return

    const correction = computeCorrection(
      {
        localTime: el.currentTime,
        targetTime: this.targetTime(),
        advancing: !el.paused && this.anchor.advancing,
        sinceSeekMs: now - this.lastSeekAt,
        duration: el.duration,
      },
      this.tuning,
    )

    if (correction.kind === 'seek' && correction.seekTo !== undefined) {
      el.currentTime = correction.seekTo
      el.playbackRate = 1
      this.lastSeekAt = now
    } else {
      el.playbackRate = correction.rate
    }
  }

  private reapStalePeers(now: number): void {
    // We never drop peers the transport still considers connected — a silent
    // peer is merely excluded from gating (see notReadyPeers).
    const live = new Set(this.transport.peers())
    for (const id of [...this.peers.keys()]) {
      if (!live.has(id) && now - (this.peers.get(id)?.lastSeen ?? 0) > 5000) {
        this.peers.delete(id)
        this.clock.forget(id)
      }
    }
  }
}
