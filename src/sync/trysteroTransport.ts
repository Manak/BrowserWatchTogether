import { joinRoom, selfId } from 'trystero/nostr'
import { DEFAULT_ICE_SERVERS } from './iceServers'
import { relaysForRoom } from './nostrRelays'
import { labelConnections, sharedPeerRegistry } from './peerRegistry'
import type { Msg } from './protocol'
import type { FileChannel, MediaChannel, RangeRequest, Transport } from './transport'

/**
 * The real transport: a WebRTC mesh, introduced over a public Nostr relay.
 *
 * The relay exists only to exchange connection offers, and only until the two
 * browsers have found each other. After that every message below travels
 * directly between them over an encrypted data channel — the relay sees no
 * video, no room code, and nothing it could decrypt.
 *
 * This was ours for a while: one Netlify function polled over HTTP, in
 * `src/signal/relay.ts`, which is still in the tree and still tested. It was
 * built for a good reason — a public relay answers to nobody, so a room that
 * will not connect leaves nothing to inspect — and it was replaced for a better
 * one. Netlify cannot hold a WebSocket open, so the client had to poll, and
 * every step of the handshake then waited out a poll interval: announce, offer,
 * answer and each candidate, three to six seconds before two browsers in the
 * same room could see each other. Four commits went on paying that down, and
 * the fixes were all the same fix. A relay that pushes does not need any of
 * them. Trystero's own defaults — trickle ICE, a 4.8s offer deadline, a 5.3s
 * announce — assume push, and are correct again the moment we have it.
 *
 * What survived the round trip is worth keeping: TURN credentials from
 * `iceServers.ts` for the pairs that genuinely cannot connect directly, the
 * diagnostics panel that says which of the three failures this is, and the
 * standby relay itself.
 */

export const APP_ID = 'browser-watch-together'

/** Trystero caps action names at 32 bytes. */
const ACTION = 'wt'
/** File bytes get their own action, so a chunk never delays a play/pause. */
const FILE_ACTION = 'wtfile'

/**
 * How long a peer has to answer a request for file bytes.
 *
 * Generous, because the answer competes with the video the host is watching and
 * with a mesh renegotiating after somebody's phone woke up. The receiver retries
 * on top of this, so the cost of being wrong is a stutter, not a dead player.
 */
const FILE_REQUEST_TIMEOUT_MS = 20000

/**
 * How long a found peer has to finish Trystero's room-password handshake
 * before it is written off. See the note where this is passed in.
 */
const HANDSHAKE_TIMEOUT_MS = 30000

/** The refusal reply: "I am not serving that." */
const EMPTY = new ArrayBuffer(0)

/**
 * A view can be a window onto a larger buffer, so handing its `.buffer` over
 * would send bytes nobody asked for. Copy unless it already owns exactly the
 * bytes in question.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer as ArrayBuffer
}

export interface TrysteroOptions {
  roomCode: string
  /** STUN and TURN, already resolved. Falls back to STUN-only when absent. */
  iceServers?: RTCIceServer[]
  onJoinError?: (message: string) => void
}

export function createTrysteroTransport(opts: TrysteroOptions): Transport {
  // Records every peer connection built below, including the ones that fail,
  // which is the only way the diagnostics panel can describe a failure. Shared
  // across rooms deliberately — a reconnect must not wipe the history of what
  // went wrong before it.
  const registry = sharedPeerRegistry()

  const room = joinRoom(
    {
      appId: APP_ID,
      // Encrypts the signalling payloads with the room code, so relay operators
      // cannot read them. The code is the shared secret; treat it like one.
      password: opts.roomCode,
      relayConfig: {
        /**
         * Four relays, chosen by the room's own name. See `nostrRelays.ts` for
         * why four rather than one or the whole pool.
         *
         * Note that supplying `urls` means all of them are used: Trystero's
         * `redundancy` only trims its own default list, so setting it here
         * would have been silently ignored. Which is what we want — the list
         * we hand over is already the decision.
         */
        urls: relaysForRoom(opts.roomCode),
        /**
         * Left on, and it has to stay on.
         *
         * This was off, on the grounds that a relay reconnecting is not worth
         * shouting about. What it actually silenced was the relay saying *no*:
         * Trystero logs a refused publish through this same switch, and a public
         * relay that rate-limits a burst of ICE candidates — several in the pool
         * did, one of them on first contact — leaves two browsers that have
         * exchanged SDP and can never finish connecting. With the warning off,
         * the only symptom was
         * Trystero's own guess that TURN must be misconfigured, which sent the
         * search in the wrong direction entirely.
         *
         * A relay reconnect logs a line nobody reads. A refused publish is the
         * whole diagnosis. There is no setting that keeps the second and drops
         * the first, so keep both.
         */
        warnOnRelayFailure: true,
      },
      /**
       * Trickle ICE is left at Trystero's default of on, which is the right
       * default for signalling that pushes: each candidate goes out the moment
       * it is found, so the connection forms as early as it can.
       *
       * It was turned off once, when signalling polled and every candidate had
       * to wait out a poll interval. That made things worse rather than better
       * — it moved the answering browser's ICE gathering, which Trystero allows
       * fifteen seconds, inside the 4.8s an unanswered offer gets. Over a
       * socket neither number is under pressure, so there is nothing here to
       * tune.
       */
      rtcConfig: {
        /**
         * STUN first, then whatever TURN we were given.
         *
         * Order here is presentational — ICE decides for itself, and it always
         * prefers a direct path: candidates are checked by priority, and the
         * spec's own ordering is host > srflx > relay. Which is the behaviour
         * we want, so the important part of this block is what it does *not*
         * say. `iceTransportPolicy` is left at its default of `all`. Setting it
         * to `relay` would force every byte through the TURN server — voice,
         * and a shared film at a gigabyte a viewer — for rooms that could have
         * connected directly. TURN is here to rescue the pairs that cannot, and
         * to give them something that validates on the first check rather than
         * after ICE has exhausted the direct paths.
         */
        iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS,
      },
      // Every peer connection Trystero builds is now one of ours, so the
      // diagnostics panel can find the ones that failed as well as the one that
      // worked. Omitted when the browser has no RTCPeerConnection to subclass,
      // which leaves Trystero on its own default. See `peerRegistry.ts`.
      ...(registry.connectionClass ? { rtcPolyfill: registry.connectionClass } : {}),
    },
    opts.roomCode,
    {
      onJoinError: (details) =>
        opts.onJoinError?.(details.error || 'Could not reach the signalling relay.'),
      // Trystero's default is ten seconds from the data channel opening to the
      // room-password challenge completing. That is a comfortable margin
      // between two tabs on one machine and a tight one between a laptop and a
      // phone on mobile data, where the channel can be open but slow for its
      // first few round trips. Losing that race fails the peer outright, so buy
      // it more time: the cost of waiting is nothing, and the cost of timing
      // out is the whole room.
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
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
      // Everything built, not just what connected — `room.getPeers()` alone
      // shows an empty panel in exactly the case somebody opened it for.
      return left ? {} : labelConnections(room.getPeers(), registry.built())
    },
  }

  // Bulk file bytes. A request/response action rather than a broadcast: exactly
  // one peer has the file, and the reply has to be matched to the range that
  // asked for it. Trystero splits a large reply across the data channel and
  // reassembles it, so a chunk never blocks the tiny sync messages behind it.
  let serve: ((req: RangeRequest, from: string) => Promise<Uint8Array | null>) | null =
    null

  const fileAction = room.makeAction<never, ArrayBuffer>(FILE_ACTION, {
    kind: 'request',
    onRequest: async (data, context) => {
      const req = data as unknown as RangeRequest
      const bytes = serve ? await serve(req, context.peerId) : null
      // An empty reply is the refusal. Throwing would be more direct, but this
      // says the same thing through a path every transport can express.
      if (!bytes) return EMPTY
      return toArrayBuffer(bytes)
    },
  })

  const files: FileChannel = {
    async request(target, req, signal) {
      if (left) throw new Error('Left the room.')
      const reply = await fileAction.request(req as unknown as never, {
        target,
        timeoutMs: FILE_REQUEST_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      })
      const bytes = new Uint8Array(reply)
      if (bytes.byteLength === 0) {
        throw new Error('That file is no longer being shared.')
      }
      return bytes
    },
    onRequest(handler) {
      serve = handler
    },
  }

  return {
    selfId,
    media,
    files,

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
