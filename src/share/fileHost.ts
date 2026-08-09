import type { LocalShare } from '../lib/media'
import type { RangeRequest } from '../sync/transport'

/**
 * The side of a local share that holds the bytes.
 *
 * A `File` cannot travel on the wire and cannot go in React state that is
 * broadcast, so it stays here, keyed by the share id that *does* travel. Peers
 * ask for ranges; this answers them.
 */

/**
 * The most we hand over in one reply, whatever the range asked for.
 *
 * A browser opening a video happily asks for "byte 0 to the end", and honouring
 * that literally would mean reading a whole film into memory on both sides. A
 * short answer is legal for a range request and simply makes the receiver come
 * back for more, which is exactly the behaviour we want: bounded memory, and a
 * seek that costs one chunk rather than a download.
 */
export const MAX_SERVED_BYTES = 512 * 1024

export class FileHost {
  private readonly shares = new Map<string, File>()

  /** Register a file and produce the descriptor the room will see. */
  add(file: File, hostId: string, makeId: () => string = randomId): LocalShare {
    const id = makeId()
    this.shares.set(id, file)
    return {
      id,
      hostId,
      size: file.size,
      mime: file.type || 'video/mp4',
      name: file.name,
    }
  }

  has(shareId: string): boolean {
    return this.shares.has(shareId)
  }

  /** The file itself — whoever picked it plays it directly, not over the wire. */
  file(shareId: string): File | undefined {
    return this.shares.get(shareId)
  }

  /** Everything is forgotten on leaving the room; nothing outlives the tab. */
  clear(): void {
    this.shares.clear()
  }

  /**
   * Answer one range request. Null means "not serving that", which the asking
   * side surfaces as a failure rather than as an empty, silently broken video.
   *
   * `end` is inclusive, matching an HTTP Range header, so the arithmetic here
   * and the arithmetic in the service worker are the same arithmetic.
   */
  async serve(req: RangeRequest): Promise<Uint8Array | null> {
    const file = this.shares.get(req.shareId)
    if (!file) return null

    const start = Math.max(0, Math.floor(req.start))
    if (!Number.isFinite(start) || start >= file.size) return null
    const asked = Math.floor(req.end)
    const end = Math.min(
      file.size - 1,
      Number.isFinite(asked) ? asked : file.size - 1,
      start + MAX_SERVED_BYTES - 1,
    )
    if (end < start) return null

    try {
      return new Uint8Array(await file.slice(start, end + 1).arrayBuffer())
    } catch {
      // The file moved or was deleted after being picked. Nothing to do but
      // stop claiming to have it.
      return null
    }
  }
}

/** One per tab: the picker registers files, the transport answers for them. */
export const fileHost = new FileHost()

function randomId(): string {
  const c = globalThis.crypto
  if (c && 'randomUUID' in c) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
