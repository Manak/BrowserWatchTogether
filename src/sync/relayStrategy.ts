import { createTopicStrategy, selfId } from '@trystero-p2p/core'
import type { BaseRoomConfig } from '@trystero-p2p/core'
import type { SignalMessage } from '../signal/relay'

/**
 * Trystero's signalling, pointed at our own relay instead of at strangers'.
 *
 * Trystero's built-in strategies all lean on somebody else's infrastructure —
 * public Nostr relays, a public MQTT broker, BitTorrent trackers. They cost
 * nothing and answer to nobody, which is the same sentence twice. This replaces
 * them with one endpoint on our own deployment.
 *
 * It is HTTP polling rather than a socket because Netlify functions cannot hold
 * a WebSocket open. That is the whole compromise: joining costs one poll
 * interval of latency, and the app pays for its own signalling in function
 * invocations. What it buys is a relay that is up when the site is up.
 *
 * Nothing sensitive passes through it. Trystero derives the topics by hashing
 * the room code and encrypts every payload with it before publishing, so the
 * relay handles opaque strings and could not join a room if it wanted to.
 */

/** Poll hard while nobody has answered — this is the wait people feel. */
const EAGER_POLL_MS = 900
/** Then settle down: Trystero re-announces every 5.3s, so this misses nothing. */
const STEADY_POLL_MS = 3500
/** How long the eager period lasts after the last change in what we watch. */
const EAGER_WINDOW_MS = 25_000
/** A relay that is down should not become a request storm. */
const ERROR_BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000]

export interface RelayConfig {
  /** Where the relay lives. Same origin as the app, so no CORS and no config. */
  signalUrl?: string
}

type Handler = (topic: string, msg: string) => void

/**
 * One poller for the whole room, not one per topic. Trystero subscribes to two
 * topics — the room and this peer — and asking about both in one request keeps
 * signalling to a single round trip per interval.
 */
export interface SignalRelayOptions {
  /**
   * Who we are, as far as the relay is concerned. Injectable because Trystero's
   * `selfId` is one value per page load, and a test that wants two peers has to
   * be able to be two peers in one process.
   */
  selfId?: string
  now?: () => number
  fetcher?: typeof fetch
}

class SignalRelay {
  private readonly handlers = new Map<string, Handler>()
  /** Server clock of the newest message we have consumed. */
  private since = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private errors = 0
  private eagerUntil = 0
  private closed = false

  private readonly me: string
  private readonly now: () => number
  private readonly fetcher: typeof fetch

  constructor(
    readonly url: string,
    opts: SignalRelayOptions = {},
  ) {
    this.me = opts.selfId ?? selfId
    this.now = opts.now ?? Date.now
    this.fetcher = opts.fetcher ?? ((...args) => fetch(...args))
  }

  subscribe(topic: string, handler: Handler): () => void {
    this.handlers.set(topic, handler)
    // A new topic is a new reason to look immediately.
    this.eagerUntil = this.now() + EAGER_WINDOW_MS
    this.schedule(0)
    return () => {
      this.handlers.delete(topic)
      if (this.handlers.size === 0) this.stop()
    }
  }

  async publish(topic: string, msg: string): Promise<void> {
    const res = await this.fetcher(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, from: this.me, msg }),
      keepalive: true,
    })
    if (!res.ok) throw new Error(`Signalling relay said ${res.status}.`)
  }

  stop(): void {
    this.closed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay: number): void {
    if (this.closed || this.handlers.size === 0) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll()
    }, delay)
  }

  private interval(): number {
    if (this.errors > 0) {
      return ERROR_BACKOFF_MS[Math.min(this.errors - 1, ERROR_BACKOFF_MS.length - 1)] as number
    }
    return this.now() < this.eagerUntil ? EAGER_POLL_MS : STEADY_POLL_MS
  }

  private async poll(): Promise<void> {
    if (this.polling || this.closed) return
    const topics = [...this.handlers.keys()]
    if (topics.length === 0) return
    this.polling = true
    try {
      const url = new URL(this.url, location.href)
      url.searchParams.set('topics', topics.join(','))
      url.searchParams.set('self', this.me)
      url.searchParams.set('since', String(this.since))
      const res = await this.fetcher(url.toString(), { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`Signalling relay said ${res.status}.`)
      const body = (await res.json()) as { now?: number; messages?: SignalMessage[] }

      // Advance on the *relay's* clock, not ours: comparing our clock against
      // its timestamps would skip or repeat messages by however far the two
      // devices disagree, which on a phone is routinely seconds.
      if (typeof body.now === 'number') this.since = body.now
      this.errors = 0

      for (const m of body.messages ?? []) {
        this.handlers.get(m.topic)?.(m.topic, m.msg)
      }
    } catch {
      // Nothing to say: a relay blip is a slower join, not a broken room, and
      // the app already reports the outcome that matters (nobody connected).
      this.errors++
    } finally {
      this.polling = false
      this.schedule(this.interval())
    }
  }
}

/** Same origin as the page, so it needs no configuration and no CORS. */
export const DEFAULT_SIGNAL_URL = '/api/signal'

/**
 * A `joinRoom` with the same shape as `trystero/nostr`'s, so the transport
 * above it does not know or care which one it got.
 */
export const joinRoom = createTopicStrategy<SignalRelay, BaseRoomConfig & RelayConfig>({
  init: (config) => [
    Promise.resolve(new SignalRelay(config.signalUrl ?? DEFAULT_SIGNAL_URL)),
  ],
  subscribeTopic: (relay, topic, onMessage) =>
    relay.subscribe(topic, (t, msg) => void onMessage(t, msg)),
  publishTopic: (relay, topic, msg) =>
    relay.publish(topic, typeof msg === 'string' ? msg : JSON.stringify(msg)),
})

export { selfId }
/** Exported for tests, which drive it with a fake clock and a fake fetch. */
export { SignalRelay }
