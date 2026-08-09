import { describe, expect, it } from 'vitest'
import { ReconnectWatchdog } from './reconnect'

const OPTS = { graceMs: 8000, resumeGraceMs: 2500, maxDelayMs: 60_000 }

describe('ReconnectWatchdog', () => {
  it('never reconnects a room that has never connected', () => {
    const w = new ReconnectWatchdog(OPTS)
    // Someone sitting alone in a room they just made is not broken.
    for (let t = 0; t < 120_000; t += 1000) {
      expect(w.shouldReconnect(false, t)).toBe(false)
    }
  })

  /**
   * Reported from real use: two people on different networks open the same
   * room, both see "Couldn't reach anyone", and it never clears. Reloading
   * fixed it, which is the tell — the connection was retryable and nothing
   * retried. A failed handshake means a peer was *found*; that is the opposite
   * of an empty room, and the one case where a room that never worked should
   * still be rebuilt.
   */
  it('retries a room that failed to reach a peer it had found', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.noteJoinFailure(1000)

    expect(w.shouldReconnect(false, 2000)).toBe(false)
    expect(w.shouldReconnect(false, 9500)).toBe(true)
  })

  it('still leaves someone sitting alone in a fresh room alone', () => {
    const w = new ReconnectWatchdog(OPTS)
    // No join failure: nobody has turned up, which is not the same as failing.
    for (let t = 0; t < 120_000; t += 1000) {
      expect(w.shouldReconnect(false, t)).toBe(false)
    }
  })

  it('backs off across repeated failures rather than hammering', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.noteJoinFailure(0)

    const fired: number[] = []
    for (let t = 500; t < 400_000; t += 500) {
      if (w.shouldReconnect(false, t)) fired.push(t)
    }
    const gaps = fired.slice(1).map((t, i) => t - (fired[i] as number))
    expect(gaps.length).toBeGreaterThan(3)
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0] as number)
  })

  it('stops retrying once the room finally connects', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.noteJoinFailure(0)
    expect(w.shouldReconnect(false, 9000)).toBe(true)

    w.shouldReconnect(true, 10_000)
    expect(w.attemptCount).toBe(0)
    // And a later solitary moment is not treated as the old failure.
    for (let t = 11_000; t < 100_000; t += 1000) w.shouldReconnect(true, t)
    expect(w.shouldReconnect(false, 101_000)).toBe(false)
  })

  it('does nothing while peers are present', () => {
    const w = new ReconnectWatchdog(OPTS)
    for (let t = 0; t < 60_000; t += 1000) {
      expect(w.shouldReconnect(true, t)).toBe(false)
    }
  })

  it('reconnects after the grace period once peers are lost', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.shouldReconnect(true, 0)
    expect(w.shouldReconnect(false, 1000)).toBe(false)
    expect(w.shouldReconnect(false, 8000)).toBe(false)
    expect(w.shouldReconnect(false, 9500)).toBe(true)
  })

  it('reacts faster after waking from suspend, which is the common case', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.shouldReconnect(true, 0)
    w.shouldReconnect(false, 1000)

    // The phone was locked and has just been unlocked.
    w.noteResume(20_000)
    expect(w.shouldReconnect(false, 21_000)).toBe(false)
    expect(w.shouldReconnect(false, 23_000)).toBe(true)
  })

  it('ignores a resume in a room that never worked', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.noteResume(1000)
    expect(w.shouldReconnect(false, 10_000)).toBe(false)
  })

  it('backs off, so an empty room does not rebuild itself forever', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.shouldReconnect(true, 0)

    const fired: number[] = []
    for (let t = 1000; t < 400_000; t += 500) {
      if (w.shouldReconnect(false, t)) fired.push(t)
    }
    // Intervals should grow, not stay flat.
    const gaps = fired.slice(1).map((t, i) => t - (fired[i] as number))
    expect(gaps.length).toBeGreaterThan(3)
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0] as number)
  })

  it('caps the backoff so recovery stays possible on a long outage', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.shouldReconnect(true, 0)
    let last = 0
    const fired: number[] = []
    for (let t = 1000; t < 2_000_000; t += 1000) {
      if (w.shouldReconnect(false, t)) {
        fired.push(t - last)
        last = t
      }
    }
    expect(Math.max(...fired.slice(-5))).toBeLessThanOrEqual(OPTS.maxDelayMs + 1000)
  })

  it('resets completely once the room comes back', () => {
    const w = new ReconnectWatchdog(OPTS)
    w.shouldReconnect(true, 0)
    w.shouldReconnect(false, 1000)
    expect(w.shouldReconnect(false, 20_000)).toBe(true)

    w.shouldReconnect(true, 21_000) // reconnected
    expect(w.attemptCount).toBe(0)

    // A later loss gets the full grace period again, not a long backoff.
    w.shouldReconnect(false, 30_000)
    expect(w.shouldReconnect(false, 39_000)).toBe(true)
  })
})
