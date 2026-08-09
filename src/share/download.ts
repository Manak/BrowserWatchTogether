import type { LocalShare } from '../lib/media'
import type { FileClient } from './fileClient'

/**
 * The fallback for a browser that will not let a service worker answer a
 * `<video>`: fetch the whole file first, then play it from memory.
 *
 * It is worse in every way that matters — nothing starts until everything has
 * arrived, and a two-hour film is a two-hour film in RAM — so it exists only to
 * keep a browser that cannot stream from being a browser that cannot watch.
 */

/** Ask for rather more than the host will send in one go; it caps us anyway. */
const SPAN = 1024 * 1024

export interface DownloadOptions {
  /** Fraction complete, 0 to 1. Called often enough to animate. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export async function downloadShare(
  client: FileClient,
  share: LocalShare,
  opts: DownloadOptions = {},
): Promise<Blob> {
  const parts: Uint8Array[] = []
  let offset = 0

  while (offset < share.size) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const bytes = await client.fetchRange(
      share,
      offset,
      Math.min(share.size - 1, offset + SPAN - 1),
      opts.signal,
    )
    parts.push(bytes)
    offset += bytes.byteLength
    opts.onProgress?.(Math.min(1, offset / share.size))
  }

  return new Blob(parts as BlobPart[], { type: share.mime || 'video/mp4' })
}
