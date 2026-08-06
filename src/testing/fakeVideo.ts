import type { MediaElementLike } from '../sync/engine'

/**
 * A simulated <video> that advances under a test-controlled clock.
 *
 * It models the three things that actually break real-world sync:
 *   - decode rate is never exactly 1.0 (`decodeSkew`)
 *   - the buffer is finite and can run dry (`bufferEnd`, `downloadRate`)
 *   - autoplay can be refused (`blockAutoplay`)
 */
export class FakeVideo implements MediaElementLike {
  currentTime = 0
  playbackRate = 1
  paused = true
  duration = 7200
  ended = false

  /** How far the download has got, in media seconds. */
  bufferEnd = 7200
  /** Media seconds downloaded per wall second. 0 pauses the download. */
  downloadRate = Infinity
  /** Multiplier on real playback speed, modelling imperfect decode timing. */
  decodeSkew = 1
  blockAutoplay = false

  /** Set true once a user gesture has happened. */
  unlocked = false

  playCalls = 0
  seekCount = 0

  get readyState(): number {
    if (this.bufferEnd <= this.currentTime + 0.01) return 1 // HAVE_METADATA
    if (this.bufferEnd < this.currentTime + 0.5) return 2 // HAVE_CURRENT_DATA
    return 4 // HAVE_ENOUGH_DATA
  }

  get buffered() {
    const end = Math.min(this.bufferEnd, this.duration)
    return {
      length: 1,
      start: (_i: number) => 0,
      end: (_i: number) => end,
    }
  }

  play(): Promise<void> {
    this.playCalls++
    if (this.blockAutoplay && !this.unlocked) {
      return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
    }
    this.paused = false
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
  }

  /** Simulate `ms` of wall time passing. */
  advance(ms: number): void {
    const secs = ms / 1000
    if (Number.isFinite(this.downloadRate)) {
      this.bufferEnd = Math.min(this.duration, this.bufferEnd + this.downloadRate * secs)
    }
    if (this.paused) return
    // Playback stalls at the edge of the buffer, exactly like a real element.
    const wanted = secs * this.playbackRate * this.decodeSkew
    const room = Math.max(0, this.bufferEnd - this.currentTime)
    this.currentTime = Math.min(this.duration, this.currentTime + Math.min(wanted, room))
    if (this.currentTime >= this.duration) {
      this.ended = true
      this.paused = true
    }
  }

  /** Drain the buffer to simulate hitting an un-downloaded region. */
  starve(bufferSecondsAhead = 0): void {
    this.bufferEnd = this.currentTime + bufferSecondsAhead
    this.downloadRate = 0
  }

  /** Let the buffer refill again. */
  refill(rate = 8): void {
    this.downloadRate = rate
  }

  seekTo(t: number): void {
    this.currentTime = t
    this.seekCount++
  }
}

/**
 * Proxy that counts assignments to currentTime, so tests can assert we are not
 * seeking constantly (which is what causes visible stutter).
 */
export function countingVideo(v: FakeVideo): FakeVideo {
  return new Proxy(v, {
    set(target, prop, value) {
      if (prop === 'currentTime' && value !== target.currentTime) target.seekCount++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(target as any)[prop] = value
      return true
    },
  })
}
