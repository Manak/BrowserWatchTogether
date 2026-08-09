import type { SignalStore } from './store.ts'

/**
 * The signalling relay: the one piece of server this app has.
 *
 * Peers need somewhere to leave a WebRTC offer where the other person will find
 * it. That is all this does. It never sees the video, never sees the room code
 * (only an opaque hash of it), and cannot read what it carries — Trystero
 * encrypts the payloads with the room code before they get here.
 *
 * Written as a pure function of (request, store, clock) so it can be run three
 * ways from one implementation: as a Netlify function, as Vite dev middleware,
 * and in tests with no network at all.
 */

/** Messages older than this are dead: an offer nobody answered is not worth keeping. */
export const MESSAGE_TTL_MS = 120_000

/** A single request cannot be used to bulk-delete somebody else's room. */
const MAX_SWEEP_PER_REQUEST = 200

/** Offers and answers are a few KB; this is a wide margin and a hard stop. */
export const MAX_MESSAGE_BYTES = 64 * 1024

/** Topics are hashes Trystero derives; ids are its peer ids. Nothing else. */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,128}$/
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** How many topics one poll may ask about. Trystero uses two. */
const MAX_TOPICS = 8

export interface SignalRequest {
  method: string
  /** Full URL, so the query string can be parsed here rather than by a caller. */
  url: string
  /** Already-read request body, for POSTs. */
  body?: string
}

export interface SignalResponse {
  status: number
  body: string
  headers: Record<string, string>
}

export interface SignalMessage {
  topic: string
  msg: string
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  // Signalling is live by definition; a cached answer is a wrong answer.
  'Cache-Control': 'no-store',
}

/**
 * Every message gets a key nobody else writes to.
 *
 * `<topic>/<writer>/<timestamp>-<nonce>`: the topic groups them for listing,
 * the writer makes collisions between peers impossible, and the timestamp lets
 * a reader tell what is new and a sweeper tell what is dead — all without
 * reading a single value.
 */
export function messageKey(
  topic: string,
  from: string,
  at: number,
  nonce: string,
): string {
  return `${topic}/${from}/${at}-${nonce}`
}

interface ParsedKey {
  topic: string
  from: string
  at: number
}

export function parseKey(key: string): ParsedKey | null {
  const parts = key.split('/')
  if (parts.length !== 3) return null
  const [topic, from, tail] = parts as [string, string, string]
  const at = Number(tail.split('-')[0])
  if (!Number.isFinite(at)) return null
  return { topic, from, at }
}

export async function handleSignal(
  req: SignalRequest,
  store: SignalStore,
  now: () => number = Date.now,
): Promise<SignalResponse> {
  const url = new URL(req.url, 'http://relay.invalid')

  if (req.method === 'POST') return publish(req, store, now)
  if (req.method === 'GET') return poll(url, store, now)
  if (req.method === 'OPTIONS') return { status: 204, body: '', headers: JSON_HEADERS }
  return fail(405, 'Method not allowed.')
}

async function publish(
  req: SignalRequest,
  store: SignalStore,
  now: () => number,
): Promise<SignalResponse> {
  let parsed: { topic?: unknown; from?: unknown; msg?: unknown }
  try {
    parsed = JSON.parse(req.body ?? '') as typeof parsed
  } catch {
    return fail(400, 'Body must be JSON.')
  }

  const { topic, from, msg } = parsed
  if (typeof topic !== 'string' || !TOPIC_RE.test(topic)) {
    return fail(400, 'Bad topic.')
  }
  if (typeof from !== 'string' || !ID_RE.test(from)) return fail(400, 'Bad sender.')
  if (typeof msg !== 'string') return fail(400, 'Bad message.')
  if (msg.length > MAX_MESSAGE_BYTES) return fail(413, 'Message too large.')

  const at = now()
  await store.put(messageKey(topic, from, at, nonce()), msg)
  return ok({ at })
}

async function poll(
  url: URL,
  store: SignalStore,
  now: () => number,
): Promise<SignalResponse> {
  const topics = (url.searchParams.get('topics') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  if (topics.length === 0) return ok({ now: now(), messages: [] })
  if (topics.length > MAX_TOPICS) return fail(400, 'Too many topics.')
  if (topics.some((t) => !TOPIC_RE.test(t))) return fail(400, 'Bad topic.')

  const self = url.searchParams.get('self') ?? ''
  if (self && !ID_RE.test(self)) return fail(400, 'Bad sender.')
  const since = Number(url.searchParams.get('since') ?? 0)
  const at = now()
  const cutoff = at - MESSAGE_TTL_MS

  const expired: string[] = []

  const collected = await Promise.all(
    topics.map(async (topic) => {
      const wanted: { key: string; at: number }[] = []
      for (const key of await store.list(`${topic}/`)) {
        const parsed = parseKey(key)
        if (!parsed) continue
        if (parsed.at < cutoff) {
          expired.push(key)
          continue
        }
        // Our own announcement coming back would be read as a second peer.
        if (self && parsed.from === self) continue
        if (Number.isFinite(since) && parsed.at <= since) continue
        wanted.push({ key, at: parsed.at })
      }
      // Oldest first: an offer must arrive before the candidates that follow it.
      wanted.sort((a, b) => a.at - b.at)
      const values = await Promise.all(wanted.map((w) => store.get(w.key)))
      return values.flatMap((msg) => (msg == null ? [] : [{ topic, msg }]))
    }),
  )

  // Nothing else ever cleans up, so a poll sweeps what it walked past.
  await Promise.all(expired.slice(0, MAX_SWEEP_PER_REQUEST).map((k) => store.delete(k)))

  return ok({ now: at, messages: collected.flat() })
}

function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

function ok(payload: unknown): SignalResponse {
  return { status: 200, body: JSON.stringify(payload), headers: JSON_HEADERS }
}

function fail(status: number, error: string): SignalResponse {
  return { status, body: JSON.stringify({ error }), headers: JSON_HEADERS }
}
