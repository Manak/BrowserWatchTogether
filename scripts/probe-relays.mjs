/**
 * Does each relay in the pool carry a burst, and keep carrying it?
 *
 *   npm run probe:relays                       the pinned pool
 *   node scripts/probe-relays.mjs wss://a…     specific hosts
 *   ROUNDS=4 npm run probe:relays              lean on them harder
 *   SURVEY=1 node scripts/probe-relays.mjs     Trystero's whole default list
 *
 * Reachability is not the question — every relay in `RELAY_URLS` answered a
 * socket the day it was added. The question is what a relay does with a dozen
 * events arriving in a second, because that is trickle ICE, and a relay that
 * takes the first two and refuses the rest leaves two browsers that have
 * exchanged SDP and can never finish connecting. From inside the app that is
 * invisible: Trystero reports "could not connect after exchanging SDP" and
 * points at TURN, because a refused publish is not something it can see.
 *
 * So: two sockets to the same relay, both on one ephemeral topic. One publishes
 * twelve events as fast as it can; the other counts what comes out.
 *
 * **And then it does it again**, which is not incidental. `offchain.pub` carried
 * the first burst perfectly and refused every one after it — a quota against a
 * new key, and Trystero mints a new key per session. One round would have
 * promoted it. Rounds are the difference between "it worked when I tried it" and
 * "it works".
 *
 * The events are built by Trystero's own `createEvent`, so this is the exact
 * wire traffic a room produces, throwaway signing key and all — which is itself
 * the thing some relays object to.
 */
import { createEvent, defaultRelayUrls } from '@trystero-p2p/nostr'
import { RELAY_URLS } from '../src/sync/nostrRelays.ts'

const BURST = Number(process.env.BURST ?? 12)
const ROUNDS = Number(process.env.ROUNDS ?? 2)
/** Enough to keep a sweep short, low enough to stay a polite guest. */
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6)
const SETTLE_MS = 4000

const named = process.argv.slice(2)
const targets = named.length
  ? named
  : process.env.SURVEY
    ? [...new Set([...RELAY_URLS, ...defaultRelayUrls])]
    : [...RELAY_URLS]

const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('connect timed out')), 8000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('connect refused'))
    }
  })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** One burst through a fresh pair of sockets. */
async function round(url) {
  // A fresh topic per round, so nothing counts somebody else's traffic or a
  // relay's replay of our own from the round before.
  const topic = `probe-${Math.random().toString(36).slice(2, 10)}`
  let listener, sender
  try {
    ;[listener, sender] = await Promise.all([open(url), open(url)])
  } catch (err) {
    return { error: err.message }
  }

  const delivered = new Set()
  let refused = 0
  let accepted = 0
  let firstRefusal = ''

  listener.onmessage = ({ data }) => {
    const [type, , event] = JSON.parse(data)
    if (type === 'EVENT' && event?.content?.startsWith(topic)) delivered.add(event.content)
  }
  sender.onmessage = ({ data }) => {
    const [type, , ok, message] = JSON.parse(data)
    if (type === 'OK') {
      if (ok) accepted++
      else {
        refused++
        firstRefusal ||= message || 'refused, no reason given'
      }
    }
    // A NOTICE is the other way a relay says no, and some say it instead of OK.
    if (type === 'NOTICE') firstRefusal ||= `NOTICE: ${ok}`
  }

  listener.send(
    JSON.stringify([
      'REQ',
      'probe',
      { kinds: [20000 + strToNum(topic)], since: Math.floor(Date.now() / 1000), '#x': [topic] },
    ]),
  )
  // The subscription has to be live before anything is published: these are
  // ephemeral events, and a relay does not store them for a late subscriber.
  await wait(1200)

  for (let i = 0; i < BURST; i++) sender.send(await createEvent(topic, `${topic}:${i}`))

  await wait(SETTLE_MS)
  listener.close()
  sender.close()

  return { delivered: delivered.size, accepted, refused, firstRefusal }
}

async function probe(url) {
  const rounds = []
  for (let i = 0; i < ROUNDS; i++) {
    rounds.push(await round(url))
    // A relay is entitled to see this as one client, not a stampede.
    if (i < ROUNDS - 1) await wait(1500)
  }
  const worst = rounds.reduce((a, b) => ((a.delivered ?? -1) <= (b.delivered ?? -1) ? a : b))
  return { url, rounds, worst }
}

/** Trystero's kind derivation, copied because it does not export it. */
function strToNum(str, limit = 1e4) {
  let sum = 0
  for (let i = 0; i < str.length; i++) sum += str.charCodeAt(i)
  return sum % limit
}

function report({ url, rounds, worst }) {
  const scores = rounds.map((r) => (r.error ? '--' : `${r.delivered}/${BURST}`)).join(' ')
  const good = rounds.every((r) => r.delivered === BURST)
  console.log(
    `${good ? 'ok  ' : 'BAD '}${url.padEnd(34)} ${scores}` +
      (worst.error ? `  ${worst.error}` : '') +
      (worst.firstRefusal ? `\n     ${worst.firstRefusal.slice(0, 90)}` : ''),
  )
  return good
}

// A small worker pool: a sweep of fifty relays serially is ten minutes of
// waiting, and all of it is waiting rather than working.
let next = 0
let bad = 0
const results = new Array(targets.length)
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (next < targets.length) {
      const i = next++
      results[i] = await probe(targets[i])
    }
  }),
)
for (const r of results) if (!report(r)) bad++

console.log(`\n${targets.length - bad}/${targets.length} carried ${ROUNDS} rounds of ${BURST}.`)
// Non-zero on any bad relay, so this can gate a release rather than only inform
// somebody who thought to look.
process.exit(bad === 0 ? 0 : 1)
