import type { LocalShare } from '../lib/media'
import type { FileChannel } from '../sync/transport'

/**
 * The side of a local share that wants the bytes.
 *
 * One method, deliberately: give me these bytes of that file. Everything above
 * it — a service worker answering the video element's range requests, or the
 * fallback that downloads the lot — is built on this and nothing else.
 */

/** A dropped chunk is a stutter, not a failure, as long as we ask again. */
const RETRIES = 3
const RETRY_DELAY_MS = [250, 750, 2000]

export interface FileClientOptions {
  retries?: number
  /** Injected in tests so retry behaviour is asserted without real waiting. */
  delay?: (ms: number) => Promise<void>
  /**
   * How many range requests may be in flight to the host at once. The browser
   * asks for several at a time when it seeks; letting them all through would
   * queue a megabyte of video ahead of the sync messages on the same peer
   * connection, and the room feels that as laggy controls.
   */
  concurrency?: number
}

export class FileClient {
  private readonly retries: number
  private readonly delay: (ms: number) => Promise<void>
  private readonly limit: number
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(
    private readonly channel: FileChannel,
    opts: FileClientOptions = {},
  ) {
    this.retries = opts.retries ?? RETRIES
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.limit = opts.concurrency ?? 3
  }

  /**
   * Fetch a byte range, `end` inclusive. Resolves with *at most* what was asked
   * for — the host caps its replies — so every caller must be prepared to loop.
   */
  async fetchRange(
    share: LocalShare,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (start < 0 || start >= share.size) {
      throw new RangeError(`Range ${start}-${end} is outside ${share.name}.`)
    }
    const last = Math.min(end, share.size - 1)

    await this.acquire()
    try {
      let lastError: unknown = null
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        try {
          const bytes = await this.channel.request(
            share.hostId,
            { shareId: share.id, start, end: last },
            signal,
          )
          if (bytes.byteLength === 0) throw new Error('Empty reply.')
          return bytes
        } catch (err) {
          if (signal?.aborted) throw err
          lastError = err
          if (attempt < this.retries) {
            await this.delay(RETRY_DELAY_MS[attempt] ?? 2000)
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('Could not reach the person sharing this file.')
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
  }

  private release(): void {
    this.active--
    this.waiting.shift()?.()
  }
}
