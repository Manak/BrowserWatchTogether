import type { FileChannel, RangeRequest } from '../sync/transport'

/**
 * A file channel with no network under it.
 *
 * The real one is Trystero's request/response action; this is the same
 * contract backed by an array of bytes, plus the two things that actually go
 * wrong in a mesh: a request that fails, and several arriving at once.
 */
export class FakeFileChannel implements FileChannel {
  /** Every request received, in order. Assert on this rather than on timing. */
  readonly seen: (RangeRequest & { from: string })[] = []
  /** Requests still in flight, so a test can prove the concurrency cap holds. */
  peak = 0
  private active = 0
  /** Fail this many times before answering, to exercise the retry path. */
  failures = 0
  /** Never send more than this in one reply, as a real host would not. */
  maxSpan = 64 * 1024

  constructor(private readonly bytes: Uint8Array) {}

  async request(target: string, req: RangeRequest): Promise<Uint8Array> {
    this.seen.push({ ...req, from: target })
    this.active++
    this.peak = Math.max(this.peak, this.active)
    try {
      // Yield, so concurrent callers genuinely overlap.
      await Promise.resolve()
      if (this.failures > 0) {
        this.failures--
        throw new Error('Peer went away.')
      }
      const end = Math.min(req.end, this.bytes.length - 1, req.start + this.maxSpan - 1)
      if (end < req.start) throw new Error('Out of range.')
      return this.bytes.slice(req.start, end + 1)
    } finally {
      this.active--
    }
  }

  onRequest(): void {
    // Nothing in these tests plays the serving side; FileHost is tested directly.
  }
}
