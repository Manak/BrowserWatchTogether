import type { MediaElementLike } from '../sync/engine'
import { AdWatcher, YT_STATE, type AdView } from './adWatcher'

/**
 * The slice of YT.Player this app uses. Declaring it here rather than importing
 * a type from YouTube keeps the adapter testable against a fake player — the
 * awkward paths (an ad arriving mid-seek, autoplay refused, a player destroyed
 * under us) are the whole point and cannot be reached with a real embed.
 */
export interface YtPlayerLike {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  getVideoLoadedFraction(): number
  setPlaybackRate(rate: number): void
  mute(): void
  unMute(): void
  setVolume(volume: number): void
}

/** readyState levels, matching HTMLMediaElement. */
const HAVE_NOTHING = 0
const HAVE_METADATA = 1
const HAVE_CURRENT_DATA = 2
const HAVE_FUTURE_DATA = 3
const HAVE_ENOUGH_DATA = 4
const NETWORK_IDLE = 1
const NETWORK_LOADING = 2

/** How long to give playVideo() before deciding the browser refused it. */
const PLAY_TIMEOUT_MS = 2500

/**
 * How long the player may sit in BUFFERING before it counts as a stall.
 *
 * Every start passes through that state, however healthy the connection.
 * Reporting it as "not ready" straight away puts two peers in a standoff:
 * each resumes, each blinks through BUFFERING, and each stops for the other
 * before either gets going — the room inches forward a second at a time and
 * both people are told they are waiting for someone who is not actually stuck.
 * Past this grace period it is a real stall and the room should wait.
 */
const BUFFER_GRACE_MS = 1500

export interface AdapterOptions {
  now?: () => number
  /** Position from a `?t=` in the pasted link. */
  startAt?: number
}

/**
 * Presents a YouTube embed as the same shape as a `<video>` element, so the
 * sync engine drives both without knowing which it has.
 *
 * Two things it does that a `<video>` never needs to:
 *
 * **It keeps the film's clock, not the player's.** While an ad is on, the
 * player's own numbers describe the ad, so this reports the last position the
 * film was at — frozen, which is exactly true: the film is not advancing.
 *
 * **It refuses to fight an ad.** Play, pause and seek are all dropped or
 * deferred while an ad runs, because acting on them would either pause the ad
 * for ever (the film is behind it and never arrives) or seek within it. The
 * engine keeps asking every quarter second, so once the ad ends the next ask
 * lands normally and nothing needs to remember to retry.
 */
export class YouTubeMedia implements MediaElementLike {
  /**
   * YouTube offers 0.25×, 0.5×, 0.75×, 1×, 1.25× … and rounds anything else
   * towards 1 — the engine's ±10% trim is silently discarded (verified against
   * the live API). The engine reads this and corrects by seeking instead.
   */
  readonly canTrimRate = false

  playbackRate = 1

  private player: YtPlayerLike | null
  private readonly now: () => number
  private readonly watcher: AdWatcher
  private ad: AdView

  /** A seek asked for while an ad was on, applied the moment the film is back. */
  private pendingSeek: number | null = null
  private lastSeekAt = -Infinity

  private playWaiter: {
    resolve: () => void
    reject: (e: Error) => void
    at: number
  } | null = null
  private autoplayBlocked = false
  private destroyed = false

  private muted = false
  private volume = 1
  /** When the player entered BUFFERING, or 0 when it is not waiting. */
  private bufferingSince = 0

  constructor(player: YtPlayerLike | null, opts: AdapterOptions = {}) {
    this.player = player
    this.now = opts.now ?? (() => Date.now())
    this.watcher = new AdWatcher(opts.startAt ?? 0)
    this.ad = this.watcher.view()
  }

  /** The player element arrives asynchronously; the engine does not wait. */
  attachPlayer(player: YtPlayerLike | null): void {
    this.player = player
  }

  /**
   * Sample the player. Called on a timer by the host component: the IFrame API
   * reports state changes but not the duration flips that betray an ad, so
   * polling is the only way to see one.
   */
  poll(): AdView {
    const p = this.player
    if (!p || this.destroyed) return this.ad
    const state = safe(() => p.getPlayerState(), YT_STATE.UNSTARTED)
    if (state === YT_STATE.BUFFERING) {
      if (this.bufferingSince === 0) this.bufferingSince = this.now()
    } else {
      this.bufferingSince = 0
    }
    this.ad = this.watcher.observe({
      at: this.now(),
      state,
      currentTime: safe(() => p.getCurrentTime(), 0),
      duration: safe(() => p.getDuration(), 0),
    })

    // Anything the engine asked for while an ad was on happens now.
    if (!this.ad.adPlaying && this.pendingSeek !== null) {
      const t = this.pendingSeek
      this.pendingSeek = null
      this.applySeek(t)
    }

    if (this.playWaiter && isStarted(state)) {
      const w = this.playWaiter
      this.playWaiter = null
      w.resolve()
    } else if (this.playWaiter && this.now() - this.playWaiter.at > PLAY_TIMEOUT_MS) {
      const w = this.playWaiter
      this.playWaiter = null
      // Nothing happened, which on a phone means the autoplay policy ate it.
      w.reject(new Error('YouTube did not start playing'))
    }

    return this.ad
  }

  /** The player told us outright that it was not allowed to start. */
  noteAutoplayBlocked(): void {
    this.autoplayBlocked = true
    const w = this.playWaiter
    this.playWaiter = null
    w?.reject(new Error('autoplay blocked'))
  }

  /** The film's duration as learned from a peer already past their ads. */
  noteRoomDuration(seconds: number): void {
    this.watcher.noteRoomDuration(seconds)
  }

  get adState(): AdView {
    return this.ad
  }

  get inAd(): boolean {
    return this.ad.adPlaying
  }

  get adElapsedMs(): number {
    return this.ad.adElapsedMs
  }

  // -------------------------------------------------------------------------
  // MediaElementLike
  // -------------------------------------------------------------------------

  get currentTime(): number {
    return this.ad.contentTime
  }

  set currentTime(t: number) {
    const target = Math.max(0, t)
    if (this.ad.adPlaying || !this.player) {
      this.pendingSeek = target
      // Report the destination straight away: the engine compares its next
      // reading against the target, and an unmoved playhead would make it seek
      // again on every update for the length of the ad.
      this.watcher.noteSeek(target)
      this.ad = this.watcher.view()
      return
    }
    this.applySeek(target)
  }

  private applySeek(t: number): void {
    const p = this.player
    if (!p) return
    safe(() => p.seekTo(t, true), undefined)
    this.lastSeekAt = this.now()
    this.watcher.noteSeek(t)
    this.ad = this.watcher.view()
  }

  get paused(): boolean {
    // An ad is not the film playing, whatever the player is doing on screen.
    if (this.ad.adPlaying) return true
    const state = this.state()
    return !(state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING)
  }

  get duration(): number {
    return this.ad.contentDuration || 0
  }

  get ended(): boolean {
    return !this.ad.adPlaying && this.state() === YT_STATE.ENDED
  }

  /**
   * Mapped onto the readyState levels the engine already reasons about:
   *
   *   ad on            → HAVE_METADATA. Below the bar for leading the room and
   *                      below the bar for "ready", which is what makes the
   *                      others wait instead of leaving this person behind.
   *   buffering        → HAVE_CURRENT_DATA, the same signal a stalling <video>
   *                      gives, so the room holds for them.
   *   cued or paused   → HAVE_FUTURE_DATA with an idle network. A cued embed
   *                      fetches nothing until it is played, exactly like a
   *                      paused <video> that has suspended, and the engine
   *                      already knows not to demand buffer depth from one.
   */
  get readyState(): number {
    if (!this.player) return HAVE_NOTHING
    if (this.ad.adPlaying) return HAVE_METADATA
    switch (this.state()) {
      case YT_STATE.UNSTARTED:
        // Once the duration is known the player has its metadata and is simply
        // sitting there — the same position as a cued one. Calling that "not
        // ready" deadlocks the room: it waits for this peer, so nothing plays,
        // so the player never leaves the state the room is waiting for it to
        // leave.
        return this.ad.contentDuration > 0 ? HAVE_FUTURE_DATA : HAVE_NOTHING
      case YT_STATE.BUFFERING:
        // Only a *sustained* wait is a stall; see BUFFER_GRACE_MS. Short of
        // that, defer to how much is buffered ahead, exactly as the engine
        // does for a <video>.
        return this.bufferingSince > 0 &&
          this.now() - this.bufferingSince > BUFFER_GRACE_MS
          ? HAVE_CURRENT_DATA
          : HAVE_FUTURE_DATA
      case YT_STATE.CUED:
      case YT_STATE.PAUSED:
        return HAVE_FUTURE_DATA
      case YT_STATE.PLAYING:
      case YT_STATE.ENDED:
        return HAVE_ENOUGH_DATA
      default:
        return HAVE_NOTHING
    }
  }

  get networkState(): number {
    const state = this.state()
    if (this.ad.adPlaying) return NETWORK_LOADING
    // Nothing is being fetched for the film while it sits waiting to start or
    // paused, exactly like a <video> that has suspended. The engine reads this
    // as "do not demand buffer depth from it", which is what stops a player
    // that is deliberately idle from being mistaken for one that is stuck.
    return state === YT_STATE.CUED ||
      state === YT_STATE.PAUSED ||
      state === YT_STATE.UNSTARTED
      ? NETWORK_IDLE
      : NETWORK_LOADING
  }

  /**
   * YouTube exposes one number — the fraction of the video it considers
   * buffered — and no range boundaries, so this is an approximation: one range
   * from the start of the film to wherever that fraction lands. It is only ever
   * used to answer "is there enough ahead to keep playing", and the ready-state
   * mapping above already covers the case where the player is genuinely stuck.
   */
  get buffered() {
    const p = this.player
    const duration = this.ad.contentDuration
    if (!p || duration <= 0 || this.ad.adPlaying) {
      return EMPTY_RANGES
    }
    const fraction = clamp01(safe(() => p.getVideoLoadedFraction(), 0))
    const end = Math.max(this.ad.contentTime, fraction * duration)
    return {
      length: 1,
      start: (_i: number) => 0,
      end: (_i: number) => end,
    }
  }

  play(): Promise<void> {
    const p = this.player
    if (!p) return Promise.reject(new Error('no player'))
    // Let the ad finish. The engine asks again in a quarter of a second, and
    // the ad is the only route to the film anyway.
    if (this.ad.adPlaying) return Promise.resolve()
    if (this.autoplayBlocked) return Promise.reject(new Error('autoplay blocked'))
    safe(() => p.playVideo(), undefined)
    if (isStarted(this.state())) return Promise.resolve()

    // playVideo() returns nothing and a refusal is silent, so the promise the
    // engine relies on for its "tap to start" prompt is resolved by watching
    // the player instead: started in time, or treat it as refused.
    this.playWaiter?.reject(new Error('superseded'))
    return new Promise<void>((resolve, reject) => {
      this.playWaiter = { resolve, reject, at: this.now() }
    })
  }

  pause(): void {
    // Pausing an ad strands the film behind it: the ad never ends, so the film
    // never starts, and a room that waits for this peer waits for ever.
    if (this.ad.adPlaying) return
    const p = this.player
    if (!p) return
    safe(() => p.pauseVideo(), undefined)
  }

  // -------------------------------------------------------------------------
  // Sound, which the room deliberately does not share
  // -------------------------------------------------------------------------

  setMuted(muted: boolean): void {
    this.muted = muted
    const p = this.player
    if (!p) return
    safe(() => (muted ? p.mute() : p.unMute()), undefined)
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume)
    const p = this.player
    if (!p) return
    safe(() => p.setVolume(Math.round(this.volume * 100)), undefined)
  }

  /** Re-apply local settings to a player that has just been (re)created. */
  applyAudio(): void {
    this.setMuted(this.muted)
    this.setVolume(this.volume)
  }

  /** A new video id: nothing learned about the old one still applies. */
  resetFor(startAt = 0): void {
    this.watcher.reset(startAt)
    this.ad = this.watcher.view()
    this.pendingSeek = null
    this.autoplayBlocked = false
    this.playWaiter?.reject(new Error('media changed'))
    this.playWaiter = null
  }

  destroy(): void {
    this.destroyed = true
    this.playWaiter?.reject(new Error('destroyed'))
    this.playWaiter = null
    this.player = null
  }

  /** Exposed for tests and diagnostics. */
  get msSinceSeek(): number {
    return this.now() - this.lastSeekAt
  }

  private state(): number {
    const p = this.player
    if (!p) return YT_STATE.UNSTARTED
    return safe(() => p.getPlayerState(), YT_STATE.UNSTARTED)
  }
}

const EMPTY_RANGES = {
  length: 0,
  start: (_i: number) => 0,
  end: (_i: number) => 0,
}

function isStarted(state: number): boolean {
  return state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Every call into the player can throw: the iframe is cross-origin and the API
 * object outlives the frame it talks to, so a player destroyed mid-poll raises
 * from a getter that has never failed before.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
