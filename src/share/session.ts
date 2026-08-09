import type { LocalShare } from '../lib/media'
import { downloadShare, type DownloadOptions } from './download'
import type { FileClient } from './fileClient'

/**
 * Everything a *receiving* browser needs to play a file that lives on somebody
 * else's disk.
 *
 * Two routes, in order of preference:
 *
 *   1. **Stream it.** A service worker mints a URL for the share and answers
 *      the video element's range requests from the peer. Playback starts on the
 *      first chunk, seeking works, memory stays flat. This is the route a phone
 *      needs, and it is the reason a phone can join a film sitting on a laptop.
 *
 *   2. **Download it.** Some browsers will not route a media element's requests
 *      through a service worker. There the whole file is fetched into a Blob
 *      first. It works everywhere and it is a poor second: nothing plays until
 *      everything has arrived.
 *
 * Which one you get is decided by trying, not by sniffing a user agent — see
 * `streamingAvailable`, and the Player's fallback when a stream URL fails.
 */

/** Must match `PREFIX` in public/share-sw.js. */
export const SHARE_PATH = '__wt-share'

/** Long enough for a slow activation, short enough not to stall a film. */
const CONTROLLER_TIMEOUT_MS = 4000

export interface ShareSessionOptions {
  /** Swapped out in tests; the real one registers public/share-sw.js. */
  installWorker?: () => Promise<boolean>
}

export class ShareSession {
  /** Shares this browser is currently able to answer the worker's questions about. */
  private readonly shares = new Map<string, LocalShare>()
  private readonly installWorker: () => Promise<boolean>
  private streaming: Promise<boolean> | null = null
  private listening = false
  private destroyed = false

  constructor(
    private readonly client: FileClient,
    opts: ShareSessionOptions = {},
  ) {
    this.installWorker = opts.installWorker ?? installShareWorker
  }

  /**
   * Remember a share so the worker's questions about it can be answered. The
   * worker only ever sends us an id; everything else — which peer holds the
   * file, how big it is — lives here.
   */
  register(share: LocalShare): void {
    this.shares.set(share.id, share)
    this.listen()
  }

  /** True when a service worker is installed and controlling this page. */
  streamingAvailable(): Promise<boolean> {
    this.streaming ??= this.installWorker().catch(() => false)
    return this.streaming
  }

  /** The URL a `<video>` can be pointed at once streaming is available. */
  streamUrl(share: LocalShare): string {
    const url = new URL(
      `${import.meta.env.BASE_URL}${SHARE_PATH}/${encodeURIComponent(share.id)}`,
      location.href,
    )
    // Size and type ride in the URL so the worker can answer the first range
    // request without a round trip of its own.
    url.searchParams.set('size', String(share.size))
    url.searchParams.set('mime', share.mime || 'video/mp4')
    return url.toString()
  }

  /** The fallback route. Resolves to an object URL the caller must revoke. */
  async downloadUrl(share: LocalShare, opts: DownloadOptions = {}): Promise<string> {
    const blob = await downloadShare(this.client, share, opts)
    return URL.createObjectURL(blob)
  }

  destroy(): void {
    this.destroyed = true
    this.shares.clear()
    if (this.listening && hasServiceWorker()) {
      navigator.serviceWorker.removeEventListener('message', this.onMessage)
      this.listening = false
    }
  }

  private listen(): void {
    if (this.listening || this.destroyed || !hasServiceWorker()) return
    navigator.serviceWorker.addEventListener('message', this.onMessage)
    this.listening = true
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const data = event.data as
      | { type?: string; shareId?: string; start?: number; end?: number }
      | null
    if (!data || data.type !== 'wt-range') return
    const port = event.ports[0]
    if (!port) return
    void this.answer(data, port)
  }

  private async answer(
    req: { shareId?: string; start?: number; end?: number },
    port: MessagePort,
  ): Promise<void> {
    const share = req.shareId ? this.shares.get(req.shareId) : undefined
    if (!share) {
      port.postMessage({ ok: false, error: 'That file is not being shared here.' })
      return
    }
    try {
      const bytes = await this.client.fetchRange(share, req.start ?? 0, req.end ?? 0)
      // Detached rather than copied: the worker is the only reader from here on.
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
      port.postMessage({ ok: true, bytes: buffer }, [buffer])
    } catch (err) {
      port.postMessage({ ok: false, error: describe(err) })
    }
  }
}

function hasServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'Could not fetch that part of the file.'
}

/**
 * Register the worker and wait until it is actually controlling this page.
 *
 * "Registered" is not enough: a worker that is installed but not yet in control
 * does not see the video element's requests, and the element would get a 404
 * from the real server instead. So this resolves false unless there is a
 * controller, and the caller falls back to downloading.
 */
async function installShareWorker(): Promise<boolean> {
  if (!hasServiceWorker()) return false
  // Service workers need https (or localhost) — the same bar voice chat sets.
  if (typeof window === 'undefined' || !window.isSecureContext) return false

  const url = new URL(`${import.meta.env.BASE_URL}share-sw.js`, location.href)
  await navigator.serviceWorker.register(url, { scope: new URL('.', url).pathname })
  await navigator.serviceWorker.ready
  if (navigator.serviceWorker.controller) return true

  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      resolve(value)
    }
    const onChange = () => done(!!navigator.serviceWorker.controller)
    const timer = setTimeout(() => done(false), CONTROLLER_TIMEOUT_MS)
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
  })
}
