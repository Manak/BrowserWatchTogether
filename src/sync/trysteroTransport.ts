import { joinRoom, selfId } from 'trystero/nostr'
import type { Msg } from './protocol'
import type { Transport } from './transport'

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

  return {
    selfId,

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
