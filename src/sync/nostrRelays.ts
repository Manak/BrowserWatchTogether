/**
 * Which relay a room signals through, decided by the room's own name.
 *
 * Trystero matches peers through the relays they have in common. Handing every
 * room the same six meant every room had all six in common, which sounds like
 * redundancy and mostly is not: both browsers opened six sockets, announced on
 * six topics, and ran six independent offer exchanges for one connection. The
 * per-relay offer state is real state — Trystero tracks `offerRelays[relayId]`
 * separately and prunes each on its own deadline — so six relays meant six
 * chances for the same pair to race each other into a discarded offer.
 *
 * So the room code picks the relay. Both browsers hash the same string and land
 * on the same host, which is the only property that matters: two peers on
 * different relays never find each other, and two peers on the same one always
 * do. One socket, one announce, one offer exchange. Rooms spread across the
 * pool instead of stacking onto whichever relay happened to be first in a list.
 *
 * The cost is stated plainly: a room is now only as reachable as the one relay
 * its name chose. Before, five of six could be down and the room still formed.
 * `RELAYS_PER_ROOM` is the dial — at 2 or 3 a room keeps a deterministic
 * assignment and gets a spare, at the price of bringing the racing back.
 */

/**
 * The pinned pool.
 *
 * Trystero's own default samples from dozens of community relays, several of
 * which are frequently down, and a dead relay retries forever — console noise
 * on a laptop, wasted battery and mobile data on a phone. These are the
 * long-running, high-uptime public ones, verified reachable and measured
 * carrying real room announcements between two peers.
 *
 * Order is load-bearing now in a way it was not before: a room's relay is an
 * index into this list, so inserting a host in the middle moves every room
 * after it. Append, do not insert — a room open in two browsers on either side
 * of a deploy must still agree on where to look.
 */
export const RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://nostr.mom',
] as const

/**
 * How many of the pool a single room uses.
 *
 * One, deliberately. See the note at the top of this file for what that buys
 * and what it costs.
 */
export const RELAYS_PER_ROOM = 1

/**
 * FNV-1a, 32-bit.
 *
 * Any stable hash would do, but it has to be *stable* and it has to be
 * synchronous. Stable because a room's relay cannot change between two browsers
 * or between two deploys; synchronous because this is read while building the
 * transport, and an async hash would put a promise in front of joining for no
 * reason. Trystero's own `strToNum` is a sum of character codes, which puts
 * `sunny-otter-42` and `sunny-otter-24` in the same bucket — fine for deriving
 * an event kind, too clumsy for spreading rooms over six hosts.
 *
 * Not a security boundary. It says nothing an observer could not work out by
 * connecting to all six relays anyway.
 */
export function hashRoomCode(code: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i)
    // Multiplication that stays in 32 bits, which plain `*` would not.
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The relays this room signals through.
 *
 * Takes the code exactly as the rest of the app has it. Both entry paths — the
 * lobby and an invite link — normalise before anything sees the code, and they
 * have to: it is also the Trystero room id and the encryption password, so two
 * browsers that disagreed about it were never going to connect regardless of
 * which relay they picked.
 */
export function relaysForRoom(code: string, count = RELAYS_PER_ROOM): string[] {
  const wanted = Math.max(1, Math.min(count, RELAY_URLS.length))
  const start = hashRoomCode(code) % RELAY_URLS.length
  // Consecutive from the starting point rather than a second hash per slot:
  // a room's spare is then predictable from its primary, which is what you
  // want at 3am when somebody says one room works and another does not.
  return Array.from(
    { length: wanted },
    (_, i) => RELAY_URLS[(start + i) % RELAY_URLS.length] as string,
  )
}
