import { joinRoom, selfId } from './relayStrategy'
import type { Msg } from './protocol'
import type { FileChannel, MediaChannel, RangeRequest, Transport } from './transport'

/**
 * The real transport: a WebRTC mesh over one small relay of our own.
 *
 * The relay exists only to exchange connection offers, and only until the two
 * browsers have found each other. After that every message below travels
 * directly between them over an encrypted data channel — the relay sees no
 * video, no room code, and nothing it could decrypt.
 *
 * It used to be public Nostr relays. They cost nothing and answer to nobody,
 * which is the same sentence twice: a room that will not connect is then a
 * problem with somebody else's server and there is nothing to look at. See
 * `relayStrategy.ts`.
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
  onJoinError?: (message: string) => void
}

export function createTrysteroTransport(opts: TrysteroOptions): Transport {
  const room = joinRoom(
    {
      appId: APP_ID,
      // Encrypts the signalling payloads with the room code, so relay operators
      // cannot read them. The code is the shared secret; treat it like one.
      password: opts.roomCode,
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
      return left ? {} : room.getPeers()
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
