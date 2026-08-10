/**
 * Which relays a room signals through, decided by the room's own name.
 *
 * Trystero matches peers through the relays they have in common, so the only
 * property that actually matters is agreement: two peers sharing no relay never
 * find each other, and two peers sharing one always do. Hashing the room code
 * gives both browsers the same answer without either of them asking anybody.
 *
 * Four of ten, and the number has been all over the place.
 *
 * It was six of six — Trystero's default of handing every room the whole list —
 * and then one, on the reasoning that six relays meant six independent offer
 * exchanges racing each other for a single connection. That reasoning was
 * wrong, and reading the current `@trystero-p2p/core` is what settles it:
 * per-peer state is keyed by peer, not by relay. One `offerPeer`, one
 * `answeringPeer`, one `connectedPeer`, and `ensureOffer` hands back the offer
 * it already made. `handleAnnouncement` and `handleOffer` both return early on
 * `answeringPeer || offerAnswered`, and glare is settled by comparing `selfId`
 * to `peerId`, which is the same comparison whichever relay carried what. Four
 * announcements produce one offer, published four times. Nothing races.
 *
 * What one relay per room really bought was a single point of failure, and it
 * collected within a day: two of the six were silently refusing our ICE
 * candidates, which made a third of all room codes unconnectable purely by
 * name. At four, a room has to lose all four before anybody notices.
 *
 * **Four of ten rather than four of six**, because the two numbers do different
 * jobs. Four is the room's own redundancy — how many hosts have to fail
 * together before that room dies. Ten is the blast radius: a room draws four
 * consecutive hosts from the pool, so one bad relay is on 40% of rooms rather
 * than 67%, and every one of those rooms still has three good ones. Widening the
 * pool costs a room nothing, because a room still opens four sockets either way.
 *
 * The costs of four, real but small: four WebSockets open per participant rather
 * than one, and four times the announce traffic out of each browser. The
 * per-relay burst is unchanged, which is the number that mattered, because each
 * relay still sees exactly one offer and one candidate stream.
 *
 * None of which excuses a bad pool. Read the note on `RELAY_URLS` before
 * touching it: redundancy raises the number of relays that have to fail
 * together, and that is all it does.
 */

/**
 * The pinned pool.
 *
 * Trystero's own default samples from a list of about fifty community relays.
 * Surveyed with the script below, sixteen of those fifty could not carry two
 * rounds of a dozen events: a third refused the socket outright, and the rest
 * failed in ways nothing in the app could have seen. So the list is pinned, and
 * every host on it is one that was measured rather than recommended.
 *
 * **"Reachable" is not the bar**, and believing it was cost a working app. A
 * relay has to carry a *burst*: trickle ICE emits a dozen candidate events in
 * about a second, and a relay that accepts the first two and refuses the rest
 * leaves two browsers that have exchanged SDP and can never finish connecting.
 * From outside that is indistinguishable from a network problem — Trystero
 * reports "could not connect after exchanging SDP" and blames TURN, because a
 * refused publish is not something it can see.
 *
 * **One passing burst is not the bar either.** Every host here carried five
 * consecutive rounds of sixteen. That is deliberately far more than a room does,
 * and it is set there because the cheaper tests kept promoting relays that
 * failed later:
 *
 *   - `relay.damus.io` — refused 7 of the first 12 with "rate-limited: you are
 *     noting too much", on first contact, from an idle connection. It then
 *     refuses the *socket* for several minutes, so the app's own reconnect makes
 *     it worse rather than better.
 *   - `offchain.pub` — carries the first burst from a new key and then refuses
 *     everything: "Policy violated and pubkey is not in our web of trust".
 *     Trystero signs with a throwaway key per session, so nothing it sends is
 *     ever in anybody's web of trust; that first allowance is all a room gets.
 *   - `nostr.oxtr.dev` — passed a single round, was added on the strength of it,
 *     and failed the very next round with "rate limited". It was in this list for
 *     a day. Hence rounds.
 *
 * The test is `npm run probe:relays`. `SURVEY=1` sweeps Trystero's whole default
 * list if this pool ever needs restocking. Run it before adding a host, and
 * re-run it when a room will not connect — a relay's policy changes under a pool
 * that has not.
 *
 * Order is load-bearing: a room's relays are an index into this list, so changing
 * the list moves rooms between hosts. Append where you can. When a host has to
 * go, the reshuffle is a one-off cost paid by rooms held open across the deploy,
 * and rejoining fixes them.
 */
export const RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://relay.mostr.pub',
  'wss://nostr.mom',
  'wss://purplerelay.com',
  'wss://bucket.coracle.social',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.angor.io',
  'wss://yabu.me/v2',
] as const

/**
 * How many of the pool a single room uses.
 *
 * Four: enough that three can fail before a room does, and few enough that a
 * room draws well under half the pool, so a bad host is on 40% of rooms rather
 * than all of them. See the note at the top of this file for why the racing this
 * was once set to 1 to avoid does not happen.
 */
export const RELAYS_PER_ROOM = 4

/**
 * FNV-1a, 32-bit.
 *
 * Any stable hash would do, but it has to be *stable* and it has to be
 * synchronous. Stable because a room's relay cannot change between two browsers
 * or between two deploys; synchronous because this is read while building the
 * transport, and an async hash would put a promise in front of joining for no
 * reason. Trystero's own `strToNum` is a sum of character codes, which puts
 * `sunny-otter-42` and `sunny-otter-24` in the same bucket — fine for deriving
 * an event kind, too clumsy for spreading rooms over a pool this size.
 *
 * Not a security boundary. It says nothing an observer could not work out by
 * connecting to every relay in the pool anyway.
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
