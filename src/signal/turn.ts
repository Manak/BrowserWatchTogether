/**
 * Short-lived TURN credentials, minted server-side.
 *
 * Most rooms never need a TURN server: two browsers on ordinary networks find a
 * direct path and the relay candidates go unused. The rooms that do need one
 * are the rooms that currently cannot connect at all — a symmetric NAT, which
 * mobile carriers and hotel Wi-Fi hand out freely, gives each destination a
 * different external port, so the address STUN teaches a peer is worthless to
 * anybody else. No amount of signalling fixes that. A relay in the middle is
 * the only thing that does.
 *
 * This exists as its own endpoint rather than a constant in the bundle because
 * the account secret must not be in the bundle. Cloudflare mints credentials
 * that expire, from a key that does not; the key stays here, in an environment
 * variable, and the browser is handed something that stops working by itself.
 *
 * Written as a pure function of (key, fetch, clock) for the same reason the
 * signalling relay is: it runs as a Netlify function, as Vite dev middleware,
 * and in tests with no network at all, from one implementation.
 */

/** The account credential. Never leaves the server. */
export interface TurnKey {
  keyId: string
  apiToken: string
}

export interface TurnResponse {
  status: number
  body: string
  headers: Record<string, string>
}

/** What the browser gets: ICE servers, and when to come back for more. */
export interface TurnCredentials {
  iceServers: RTCIceServer[]
  /** Epoch milliseconds. */
  expiresAt: number
}

/**
 * How long a minted credential lasts.
 *
 * It has to outlive the session that starts with it, not just the moment of
 * connecting: a TURN allocation is refreshed against the same credential for as
 * long as it carries traffic, so one that expires mid-film takes the connection
 * with it. Six hours covers any film plus the evening around it, and is still
 * short enough that a scraped credential is a temporary problem.
 */
export const CREDENTIAL_TTL_SECONDS = 6 * 60 * 60

const API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  // A credential is only good until it isn't; a cached one is a wrong one.
  'Cache-Control': 'no-store',
}

export async function handleTurn(
  key: TurnKey | null,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<TurnResponse> {
  // Not configured is a state, not a fault: the app is expected to run without
  // TURN, and the client falls back to STUN. Say so plainly rather than 500.
  if (!key?.keyId || !key.apiToken) {
    return fail(503, 'No TURN key is configured.')
  }

  let res: Response
  try {
    res = await fetcher(
      `${API_BASE}/${encodeURIComponent(key.keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      },
    )
  } catch {
    return fail(502, 'Could not reach the TURN provider.')
  }

  if (!res.ok) {
    // Deliberately not forwarding the upstream body: it is the one place an
    // account identifier or a key fragment could be echoed back to a browser.
    return fail(502, `The TURN provider said ${res.status}.`)
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return fail(502, 'The TURN provider sent something unreadable.')
  }

  const iceServers = normalise(payload)
  if (iceServers.length === 0) {
    return fail(502, 'The TURN provider sent no usable servers.')
  }

  const body: TurnCredentials = {
    iceServers,
    expiresAt: now() + CREDENTIAL_TTL_SECONDS * 1000,
  }
  return { status: 200, body: JSON.stringify(body), headers: JSON_HEADERS }
}

/**
 * Cloudflare answers with `iceServers` as a single object; the shape is
 * documented loosely enough that an array would not be a surprise, and the cost
 * of accepting both is four lines against an outage nobody could debug from the
 * browser. Anything without usable `urls` is dropped rather than passed on,
 * because an ICE server the browser cannot parse fails the whole connection
 * rather than just itself.
 */
function normalise(payload: unknown): RTCIceServer[] {
  const raw = (payload as { iceServers?: unknown } | null)?.iceServers
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : []

  return list.flatMap((entry): RTCIceServer[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const { urls, username, credential } = entry as Record<string, unknown>
    const usable =
      typeof urls === 'string'
        ? [urls]
        : Array.isArray(urls)
          ? urls.filter((u): u is string => typeof u === 'string')
          : []
    if (usable.length === 0) return []
    return [
      {
        urls: usable,
        ...(typeof username === 'string' ? { username } : {}),
        ...(typeof credential === 'string' ? { credential } : {}),
      },
    ]
  })
}

function fail(status: number, error: string): TurnResponse {
  return { status, body: JSON.stringify({ error }), headers: JSON_HEADERS }
}

/** Reads the key from the environment, or null when it is not set up. */
export function turnKeyFromEnv(env: Record<string, string | undefined>): TurnKey | null {
  const keyId = env.TURN_KEY_ID
  const apiToken = env.TURN_KEY_API_TOKEN
  return keyId && apiToken ? { keyId, apiToken } : null
}
