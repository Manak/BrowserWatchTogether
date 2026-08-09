import { createTopicStrategy, selfId } from '@trystero-p2p/core'
import type { BaseRoomConfig, TopicPublishContext } from '@trystero-p2p/core'
import type { SignalMessage } from '../signal/relay'

/**
 * Trystero's signalling, pointed at our own relay instead of at strangers'.
 *
 * **Not currently wired up.** The transport signals over a public Nostr relay
 * again (`trysteroTransport.ts`, `nostrRelays.ts`). This file, the handler in
 * `src/signal/`, the Netlify function and their tests are kept whole and green
 * as the standby: if the public relays go dark or start refusing our events,
 * swapping the import in `trysteroTransport.ts` is the entire migration.
 *
 * Why it is the standby rather than the default: it is HTTP polling, because
 * Netlify functions cannot hold a WebSocket open, and every step of the
 * handshake then waits out a poll interval. Announce, offer, answer and each
 * candidate — three to six seconds before two browsers in the same room can see
 * each other, where a socket costs one round trip each. What it buys, and the
 * reason it is still here, is a relay that is up when the site is up and that
 * we can actually look inside when a room will not connect.
 *
 * Nothing sensitive passes through it. Trystero derives the topics by hashing
 * the room code and encrypts every payload with it before publishing, so the
 * relay handles opaque strings and could not join a room if it wanted to.
 */

/**
 * How often we tell Trystero we intend to re-announce.
 *
 * This number is load-bearing for a reason that is not obvious from its name.
 * Trystero derives the deadline for an unanswered offer from it, at 90% of the
 * interval (`signal-handler.mjs`, `prunePendingOffer`). Left unset, it takes
 * its 5,333ms default and gives an offer **4.8 seconds** to be answered — a
 * budget our signalling cannot meet. An offer has to reach the relay, wait out
 * the far side's poll, wait for that browser to answer, and come back. Miss the
 * deadline and Trystero discards the offer and starts again on the next
 * announce, which is precisely the "refresh a few times and it eventually
 * connects" this app was reported as doing.
 *
 * 12s gives a 10.8s deadline, which fits with room to spare.
 *
 * It costs nothing in discovery, which is the part that looks like it should.
 * The relay replays a 20s window (`REPLAY_WINDOW_MS`), so a joiner's very first
 * poll already sees any announce made in the last twenty seconds — how often we
 * repeat one does not gate finding anybody. Trystero's own warm-up still fires
 * the first three announces at 233/533/1333ms regardless.
 */
export const ANNOUNCE_INTERVAL_MS = 12_000

/** Poll hard while nobody has answered — this is the wait people feel. */
const EAGER_POLL_MS = 900
/** Then settle down: Trystero re-announces every 5.3s, so this misses nothing. */
const STEADY_POLL_MS = 3500
/**
 * How long the eager period lasts after the last sign of activity.
 *
 * Refreshed by traffic rather than counted from joining: a connection being
 * negotiated is exactly when messages are flowing, and slowing down in the
 * middle of it is the worst possible moment. It goes quiet on its own once the
 * room settles.
 */
const EAGER_WINDOW_MS = 25_000
/** A relay that is down should not become a request storm. */
const ERROR_BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000]
/**
 * How long a delivered message is remembered so its replays can be ignored.
 * Comfortably longer than the relay keeps anything, so nothing is delivered
 * twice by having been forgotten too early.
 */
const SEEN_TTL_MS = 180_000

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
  /**
   * Messages already delivered upwards, and when they may be forgotten.
   *
   * The relay replays a window rather than tracking a cursor for us, because a
   * cursor loses messages it cannot see yet (see `REPLAY_WINDOW_MS`). Repeats
   * are filtered here instead, where a mistake costs a duplicate rather than a
   * connection.
   */
  private readonly seen = new Map<string, number>()
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

  /** Bounded by the relay's own retention, so this can never grow unchecked. */
  private forgetSeen(at: number): void {
    if (this.seen.size < 256) return
    for (const [id, expires] of this.seen) {
      if (expires <= at) this.seen.delete(id)
    }
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
      const res = await this.fetcher(url.toString(), { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`Signalling relay said ${res.status}.`)
      const body = (await res.json()) as { now?: number; messages?: SignalMessage[] }
      this.errors = 0

      const at = this.now()
      this.forgetSeen(at)
      for (const m of body.messages ?? []) {
        if (!m.id || this.seen.has(m.id)) continue
        this.seen.set(m.id, at + SEEN_TTL_MS)
        // Something is happening, so keep looking often until it stops.
        this.eagerUntil = at + EAGER_WINDOW_MS
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
  publishTopic: (relay, topic, msg, context) =>
    announceInterval(
      relay.publish(topic, typeof msg === 'string' ? msg : JSON.stringify(msg)),
      context.kind,
    ),
})

/**
 * Publish, then hand Trystero our announce cadence.
 *
 * Trystero reads a number back from an *announce* publish and takes it as "come
 * back in this many ms" — see `ANNOUNCE_INTERVAL_MS` for why we care, which is
 * not the announcing. Its published types declare this return as `void`, but
 * `strategy.mjs` reads it (`if (typeof ms === "number")`), so the cast is where
 * an undocumented contract gets acknowledged rather than hidden. A Trystero
 * upgrade that drops it fails soft: the interval reverts to the default and
 * joining gets slower, which is the behaviour we started from.
 */
function announceInterval(
  published: Promise<void>,
  kind: TopicPublishContext['kind'],
): Promise<void> {
  if (kind !== 'announce') return published
  return published.then(() => ANNOUNCE_INTERVAL_MS as unknown as void)
}

export { selfId }
/** Exported for tests, which drive it with a fake clock and a fake fetch. */
export { SignalRelay }
