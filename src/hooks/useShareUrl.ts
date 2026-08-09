import { useEffect, useState } from 'react'
import type { LocalShare } from '../lib/media'
import { fileHost } from '../share/fileHost'
import type { ShareSession } from '../share/session'

/**
 * Turns "there is a file on somebody's laptop" into "there is a URL this
 * `<video>` can play", and reports what is happening while it cannot.
 *
 * Three outcomes, in the order they are tried: it is our own file, so play it
 * off the disk; a service worker can stream it from the peer, so play that URL;
 * or it has to be downloaded whole first, which is the slow path and the one
 * that needs a progress bar.
 */

export type ShareUrlState =
  | { status: 'ready'; url: string }
  /** Working out which of the routes above applies. */
  | { status: 'resolving' }
  /** Fetching the whole file before anything can play. */
  | { status: 'preparing'; progress: number }
  /** The person holding the file is not in the room. */
  | { status: 'waiting' }
  | { status: 'error'; message: string }

const NOTHING: ShareUrlState = { status: 'ready', url: '' }
const RESOLVING: ShareUrlState = { status: 'resolving' }

/**
 * Object URLs, kept alive past the component that made them.
 *
 * Reconnecting rebuilds the transport and everything hanging off it. Losing a
 * finished download to that would mean fetching a whole film again because
 * somebody's phone locked, so completed work is keyed by share id and outlives
 * the connection that produced it.
 */
const urls = new Map<string, string>()

export function useShareUrl(
  share: LocalShare | null,
  session: ShareSession | null,
  selfId: string,
  hostPresent: boolean,
): { state: ShareUrlState; useDownload: () => void } {
  // Stamped with the share it belongs to, so a state left over from the last
  // film can never be handed to the player as this one's.
  const [resolved, setResolved] = useState<{ id: string; state: ShareUrlState }>({
    id: '',
    state: NOTHING,
  })
  /**
   * The share whose streamed URL turned out not to play. Held as an id rather
   * than a flag so a new file starts fresh on its own: what one browser did
   * with one file says nothing about the next.
   */
  const [streamFailedFor, setStreamFailedFor] = useState<string | null>(null)
  const forceDownload = !!share && streamFailedFor === share.id

  useEffect(() => {
    if (!share) return

    let cancelled = false
    const abort = new AbortController()
    const settle = (state: ShareUrlState) => {
      if (!cancelled) setResolved({ id: share.id, state })
    }

    const run = async () => {
      // Re-registered before anything else, because a reconnect builds a fresh
      // session and the worker's questions have to keep finding an answer.
      if (session && share.hostId !== selfId) session.register(share)

      // A URL we already have keeps working. In particular it is not thrown
      // away when the person sharing drops off for a moment: the element plays
      // on out of its buffer, and reloading the source would cost the position
      // and the buffer for a connection that is about to come back.
      const cached = urls.get(share.id)
      if (cached) {
        settle({ status: 'ready', url: cached })
        return
      }

      // Our own file. No transfer, no worker, no waiting.
      const own = share.hostId === selfId ? fileHost.file(share.id) : undefined
      if (own) {
        const url = URL.createObjectURL(own)
        urls.set(share.id, url)
        settle({ status: 'ready', url })
        return
      }

      if (!session) {
        settle({
          status: 'error',
          message: 'This browser cannot receive a shared file.',
        })
        return
      }
      if (!hostPresent) {
        settle({ status: 'waiting' })
        return
      }

      if (!forceDownload && (await session.streamingAvailable())) {
        const url = session.streamUrl(share)
        urls.set(share.id, url)
        settle({ status: 'ready', url })
        return
      }

      settle({ status: 'preparing', progress: 0 })
      try {
        const url = await session.downloadUrl(share, {
          onProgress: (progress) => settle({ status: 'preparing', progress }),
          signal: abort.signal,
        })
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        urls.set(share.id, url)
        settle({ status: 'ready', url })
      } catch (err) {
        if (abort.signal.aborted) return
        settle({ status: 'error', message: describe(err) })
      }
    }

    void run()
    return () => {
      cancelled = true
      abort.abort()
    }
  }, [share, session, selfId, hostPresent, forceDownload])

  const state = !share ? NOTHING : resolved.id === share.id ? resolved.state : RESOLVING

  return {
    state,
    useDownload: () => {
      if (!share) return
      // The streamed URL is what just failed, so it must not be handed back by
      // the cache on the very next render.
      const stale = urls.get(share.id)
      if (stale && !stale.startsWith('blob:')) urls.delete(share.id)
      setStreamFailedFor(share.id)
    },
  }
}

/** Drop everything held for shares that are no longer in play. */
export function forgetShareUrls(keep?: string): void {
  for (const [id, url] of urls) {
    if (id === keep) continue
    // Only a downloaded copy holds memory; a streamed URL is just a string.
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    urls.delete(id)
  }
}

function describe(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return 'Could not fetch the shared file.'
}
