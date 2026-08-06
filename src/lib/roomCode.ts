/**
 * Room codes are the only "account system" this app has: whoever holds the code
 * can join the room, and the code doubles as the encryption password for the
 * signalling payloads. So they need to be easy to read aloud over a phone call
 * and hard to guess by brute force.
 *
 * `word-word-NNN` from these lists is ~24 bits of entropy, which is plenty when
 * there is no directory of live rooms to enumerate.
 */

const ADJECTIVES = [
  'amber', 'brave', 'calm', 'clever', 'cosy', 'crimson', 'dizzy', 'eager',
  'fuzzy', 'gentle', 'golden', 'happy', 'jolly', 'lucky', 'mellow', 'merry',
  'misty', 'neon', 'plush', 'quiet', 'rapid', 'royal', 'silver', 'snug',
  'sunny', 'swift', 'tidy', 'velvet', 'witty', 'zesty',
] as const

const NOUNS = [
  'otter', 'panda', 'comet', 'falcon', 'walrus', 'puffin', 'maple', 'cactus',
  'lagoon', 'bison', 'marble', 'quasar', 'sparrow', 'tulip', 'yak', 'zebra',
  'anchor', 'beacon', 'cinder', 'dune', 'ember', 'fjord', 'harbor', 'island',
  'jungle', 'kettle', 'lantern', 'meadow', 'nebula', 'orchard',
] as const

export const ROOM_CODE_RE = /^[a-z]+-[a-z]+-\d{2,3}$/

function randomInt(maxExclusive: number): number {
  const g = globalThis.crypto
  if (g?.getRandomValues) {
    const buf = new Uint32Array(1)
    // Rejection sampling keeps the distribution flat.
    const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive
    let v: number
    do {
      g.getRandomValues(buf)
      v = buf[0] ?? 0
    } while (v >= limit)
    return v % maxExclusive
  }
  return Math.floor(Math.random() * maxExclusive)
}

function pick<T>(list: readonly T[]): T {
  return list[randomInt(list.length)] as T
}

export function generateRoomCode(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${10 + randomInt(990)}`
}

/**
 * Forgiving normaliser: people retype codes with spaces, capitals, stray
 * punctuation, or paste the whole share URL.
 */
export function normalizeRoomCode(input: string): string {
  let s = input.trim().toLowerCase()
  // Tolerate a pasted share link.
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(hash + 1)
  s = s.replace(/^\/?(room|r)\//, '')
  return s
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

export function isValidRoomCode(code: string): boolean {
  // Generated codes match ROOM_CODE_RE; hand-picked codes just need to be
  // long enough to not collide with someone else's by accident.
  return ROOM_CODE_RE.test(code) || /^[a-z0-9][a-z0-9-]{3,63}$/.test(code)
}

export function roomUrl(code: string, origin?: string): string {
  const base =
    origin ??
    (typeof location !== 'undefined'
      ? location.origin + location.pathname
      : 'https://example.com/')
  return `${base.replace(/#.*$/, '')}#/room/${code}`
}

export function roomCodeFromHash(hash: string): string | null {
  const m = /^#\/room\/([^?&]+)/.exec(hash)
  if (!m?.[1]) return null
  const code = normalizeRoomCode(decodeURIComponent(m[1]))
  return isValidRoomCode(code) ? code : null
}
