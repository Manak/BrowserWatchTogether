/**
 * Decides when a room connection is dead and should be rebuilt.
 *
 * The case that forced this: locking a phone suspends the page, and iOS tears
 * down the WebRTC connections while it is asleep. The other side sees a clean
 * departure. On unlock the phone's page resumes with connections that are
 * closed but never reported as closed, so it still believes it is in the room
 * while nobody else can see it. Nothing on either side ever retries.
 *
 * The rule is deliberately conservative: only rebuild if we have *had* peers
 * and then lost all of them. Someone genuinely alone in a room is not broken,
 * and rebuilding under them would drop the video they just queued up.
 *
 * With one exception, which cost us a working app. A *failed handshake* is not
 * the same as an empty room: it is positive evidence that somebody is there and
 * we did not manage to reach them. Trystero gives the peer connection ten
 * seconds to complete its password handshake once the data channel opens, and
 * across two different networks that can lose a race. Without the exception,
 * the first attempt was also the last — the room had never connected, so it was
 * never considered broken, and "Couldn't reach anyone" stayed on screen until
 * somebody reloaded the page. Reloading worked, which is the tell: the only
 * thing missing was another go.
 */

export interface ReconnectOptions {
  /** Grace period before a silent connection counts as dead. */
  graceMs?: number
  /** After waking from suspend, check sooner — this is the common failure. */
  resumeGraceMs?: number
  /** Ceiling on the backoff between attempts. */
  maxDelayMs?: number
}

const DEFAULTS = {
  graceMs: 8000,
  resumeGraceMs: 2500,
  maxDelayMs: 60_000,
} satisfies Required<ReconnectOptions>

export class ReconnectWatchdog {
  private readonly opts: Required<ReconnectOptions>
  /** Only rooms that have worked can be considered broken. */
  private everConnected = false
  /** …or rooms where reaching a peer was tried and failed. */
  private sawJoinFailure = false
  private lostAt: number | null = null
  private attempts = 0
  private resumed = false

  constructor(options: ReconnectOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
  }

  /**
   * A peer was found and the connection to it failed.
   *
   * This is what makes a room that has never worked eligible for a rebuild:
   * somebody is on the other end, so retrying is worth doing. Repeated
   * failures share the same backoff as everything else, so a room on a network
   * that simply cannot do it settles into a slow retry rather than a loop.
   */
  noteJoinFailure(now: number): void {
    if (this.sawJoinFailure) return
    this.sawJoinFailure = true
    this.lostAt = now
  }

  /** The page came back from being hidden or suspended. */
  noteResume(now: number): void {
    // Only meaningful if we had a working room to lose.
    if (!this.everConnected && !this.sawJoinFailure) return
    this.resumed = true
    // Waking is strong evidence, so restart the clock rather than inheriting a
    // long backoff from earlier failures.
    this.attempts = 0
    this.lostAt = now
  }

  /**
   * Feed the current state. Returns true exactly once per decision to rebuild.
   */
  shouldReconnect(connected: boolean, now: number): boolean {
    if (connected) {
      this.everConnected = true
      this.sawJoinFailure = false
      this.lostAt = null
      this.attempts = 0
      this.resumed = false
      return false
    }
    if (!this.everConnected && !this.sawJoinFailure) return false

    if (this.lostAt === null) {
      this.lostAt = now
      return false
    }

    const base = this.resumed ? this.opts.resumeGraceMs : this.opts.graceMs
    // Back off, so a room whose other occupant simply left does not rebuild
    // itself every few seconds forever.
    const delay = Math.min(base * 2 ** this.attempts, this.opts.maxDelayMs)
    if (now - this.lostAt < delay) return false

    this.attempts++
    this.lostAt = now
    this.resumed = false
    return true
  }

  /** Test seam: how many rebuilds have been asked for. */
  get attemptCount(): number {
    return this.attempts
  }
}
