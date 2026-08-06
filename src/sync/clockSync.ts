/**
 * NTP-style clock offset estimation over the data channel.
 *
 * Peers' `Date.now()` values can be seconds apart, which would show up directly
 * as playback drift. For each peer we keep a small window of round trips and
 * trust the *lowest-latency* sample: on a jittery link the fastest round trip is
 * the one least distorted by queueing, so its midpoint is the best estimate of
 * the remote clock.
 */

export interface Sample {
  rtt: number
  offset: number
}

export class ClockSync {
  private readonly samplesByPeer = new Map<string, Sample[]>()
  private readonly windowSize: number

  constructor(windowSize = 8) {
    this.windowSize = windowSize
  }

  /**
   * @param t0 local time the ping was sent
   * @param t1 remote time the ping was received (from the pong)
   * @param t3 local time the pong arrived
   */
  addSample(peerId: string, t0: number, t1: number, t3: number): void {
    const rtt = t3 - t0
    if (rtt < 0) return
    const offset = t1 - (t0 + rtt / 2)
    const list = this.samplesByPeer.get(peerId) ?? []
    list.push({ rtt, offset })
    if (list.length > this.windowSize) list.shift()
    this.samplesByPeer.set(peerId, list)
  }

  private best(peerId: string): Sample | null {
    const list = this.samplesByPeer.get(peerId)
    if (!list?.length) return null
    let best = list[0] as Sample
    for (const s of list) if (s.rtt < best.rtt) best = s
    return best
  }

  /** Add to our local clock to get the peer's clock. 0 for ourselves/unknown. */
  offsetTo(peerId: string): number {
    return this.best(peerId)?.offset ?? 0
  }

  /** Best round-trip time seen for a peer, or null if never measured. */
  rttTo(peerId: string): number | null {
    return this.best(peerId)?.rtt ?? null
  }

  /** Convert a local timestamp into `peerId`'s clock. */
  toPeerClock(peerId: string, localNow: number): number {
    return localNow + this.offsetTo(peerId)
  }

  /** Convert a timestamp taken on `peerId` into our local clock. */
  toLocalClock(peerId: string, peerTime: number): number {
    return peerTime - this.offsetTo(peerId)
  }

  forget(peerId: string): void {
    this.samplesByPeer.delete(peerId)
  }

  has(peerId: string): boolean {
    return (this.samplesByPeer.get(peerId)?.length ?? 0) > 0
  }
}
