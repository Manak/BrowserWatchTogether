import { joinRoom, selfId } from 'trystero/nostr'
import type { Msg } from './protocol'
import type { MediaChannel, Transport } from './transport'

/**
 * The real transport: a WebRTC mesh with no backend of our own.
 *
 * Trystero uses public Nostr relays purely to exchange connection offers. Once
 * peers have found each other, every message below travels directly between
 * browsers over an encrypted data channel — no server sees the room, and there
 * is nothing to host, pay for, or keep running.
 */

export const APP_ID = 'browser-watch-together'

/** Trystero caps action names at 32 bytes. */
const ACTION = 'wt'

/**
 * Trystero's default list samples from dozens of community relays, several of
 * which are frequently down — a dead one retries forever, which is console
 * noise on a laptop and wasted battery and mobile data on a phone.
 *
 * These are the long-running, high-uptime public relays, all verified
 * reachable from a browser. We only need one to work: peers are matched
 * through whichever relays they have in common, and once WebRTC connects the
 * relays are not used again for that pair.
 */
const RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://nostr.mom',
]

/** How many of the above to hold connections to at once. */
const RELAY_REDUNDANCY = 4

export interface TrysteroOptions {
  roomCode: string
  onJoinError?: (message: string) => void
}

export function createTrysteroTransport(opts: TrysteroOptions): Transport {
  const room = joinRoom(
    {
      appId: APP_ID,
      // Encrypts the signalling payloads with the room code, so relay operators
      // cannot read them. The code is the shared secret; treat it like one.
      password: opts.roomCode,
      relayConfig: {
        urls: RELAY_URLS,
        redundancy: RELAY_REDUNDANCY,
        // We surface connection trouble in the UI; a single flaky relay out of
        // several is normal and not worth shouting about.
        warnOnRelayFailure: false,
      },
      rtcConfig: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      },
    },
    opts.roomCode,
    {
      onJoinError: (details) =>
        opts.onJoinError?.(details.error || 'Could not reach the signalling relays.'),
    },
  )

  const msgHandlers: ((msg: Msg, from: string) => void)[] = []

  // DataPayload is a JSON value; our Msg union is JSON-shaped but TypeScript
  // cannot see that through interfaces, so the cast is confined to this file.
  const action = room.makeAction<never>(ACTION, {
    onMessage: (data, context) => {
      for (const h of msgHandlers) h(data as unknown as Msg, context.peerId)
    },
  })

  let left = false

  const streamHandlers: ((stream: MediaStream, peerId: string) => void)[] = []
  room.onPeerStream = (stream, peerId) => {
    for (const h of streamHandlers) h(stream, peerId)
  }

  // Voice chat rides the same peer connections as the sync messages, so there
  // is no second connection to establish and no server in the audio path.
  const media: MediaChannel = {
    addStream(stream, target) {
      if (left) return
      // Returns one promise per peer; a peer that drops mid-negotiation is
      // routine in a mesh and must not become an unhandled rejection.
      const sends = target ? room.addStream(stream, { target }) : room.addStream(stream)
      for (const p of sends) void p.catch(() => {})
    },
    removeStream(stream) {
      if (left) return
      try {
        room.removeStream(stream)
      } catch {
        /* already gone */
      }
    },
    onPeerStream(handler) {
      streamHandlers.push(handler)
    },
    connections() {
      return left ? {} : room.getPeers()
    },
  }

  return {
    selfId,
    media,

    send(msg: Msg, target?: string) {
      if (left) return
      void action
        .send(msg as unknown as never, target ? { target } : undefined)
        .catch(() => {
          // A peer vanishing mid-send is routine in a mesh; the engine's
          // heartbeats will re-establish state when they reconnect.
        })
    },

    onMessage(h) {
      msgHandlers.push(h)
    },

    onPeerJoin(h) {
      const prev = room.onPeerJoin
      room.onPeerJoin = (peerId) => {
        prev?.(peerId)
        h(peerId)
      }
    },

    onPeerLeave(h) {
      const prev = room.onPeerLeave
      room.onPeerLeave = (peerId) => {
        prev?.(peerId)
        h(peerId)
      }
    },

    peers() {
      return Object.keys(room.getPeers())
    },

    async leave() {
      left = true
      await room.leave()
    },
  }
}
