import type { TurnCredentials } from '../signal/turn'

/**
 * Where the browser gets its ICE servers.
 *
 * STUN is a constant and always available. TURN is fetched, because it carries
 * a credential that expires — see `src/signal/turn.ts` for why that matters.
 *
 * The important property of this module is that it never fails. A room that
 * could have connected directly must not be held up by a credentials endpoint
 * being slow, or broken, or not configured at all; those are the overwhelming
 * majority of rooms, and TURN is worth nothing to them. So every error path
 * ends at STUN-only and the room carries on.
 */

/**
 * Enough for most networks, useless on the ones that need TURN.
 *
 * Two providers because a single STUN server that does not answer means a
 * browser that never learns its own public address, and that is
 * indistinguishable from "the network blocks it" when you are reading a bug
 * report.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

const ENDPOINT = '/api/turn'

/**
 * Re-mint this far ahead of expiry.
 *
 * A credential that dies mid-film takes the connection with it, and the room
 * has no way to tell that apart from the network going away.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * The floor on how often we will ask.
 *
 * Reconnects rebuild the whole transport — a phone waking up can do it several
 * times in a minute — and each rebuild asks for ICE servers. Without a floor, a
 * flapping connection turns into a request loop against an endpoint that is
 * probably already unhappy.
 */
const RETRY_FLOOR_MS = 60_000

let cached: { servers: RTCIceServer[]; until: number } | null = null
let inflight: Promise<RTCIceServer[]> | null = null

/**
 * ICE servers for a new peer connection: STUN always, TURN when we have it.
 *
 * Resolves immediately from cache after the first call, so joining a room costs
 * no round trip once `prewarmIceServers` has run.
 */
export function loadIceServers(
  fetcher: typeof fetch = (...args) => fetch(...args),
  now: () => number = Date.now,
): Promise<RTCIceServer[]> {
  const at = now()
  if (cached && cached.until > at) return Promise.resolve(cached.servers)
  // Several peer connections can be built in the same tick. They share one
  // request rather than racing to mint credentials nobody needed.
  inflight ??= fetch_(fetcher, now).finally(() => {
    inflight = null
  })
  return inflight
}

/**
 * Start fetching before anybody joins anything.
 *
 * Called at startup, so the request overlaps with the person reading the lobby
 * and typing a room code. By the time a room is joined the answer is already
 * cached, and joining does not pay for it.
 */
export function prewarmIceServers(): void {
  void loadIceServers()
}

/** Test seam: drops the cache so each test starts from nothing. */
export function forgetIceServers(): void {
  cached = null
  inflight = null
}

async function fetch_(
  fetcher: typeof fetch,
  now: () => number,
): Promise<RTCIceServer[]> {
  try {
    const res = await fetcher(ENDPOINT, { headers: { Accept: 'application/json' } })
    // 503 is the documented "no TURN key configured" answer, and is not worth
    // distinguishing here: every failure means the same thing to a browser.
    if (!res.ok) throw new Error(`TURN endpoint said ${res.status}.`)

    const body = (await res.json()) as Partial<TurnCredentials>
    if (!Array.isArray(body.iceServers) || body.iceServers.length === 0) {
      throw new Error('TURN endpoint returned no servers.')
    }

    // Ours first, theirs after. ICE ignores the order — it prioritises by
    // candidate type, always preferring a direct path — so this is only for
    // whoever reads it in a diagnostics dump.
    const servers = [...DEFAULT_ICE_SERVERS, ...body.iceServers]
    const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0
    cached = {
      servers,
      until: Math.max(now() + RETRY_FLOOR_MS, expiresAt - REFRESH_MARGIN_MS),
    }
    return servers
  } catch {
    // Cached deliberately, and as a success would be. The point is the floor:
    // a room joining on STUN alone should not re-ask on every reconnect.
    cached = { servers: DEFAULT_ICE_SERVERS, until: now() + RETRY_FLOOR_MS }
    return DEFAULT_ICE_SERVERS
  }
}
