import type { Msg } from './protocol'

/**
 * The engine talks to peers only through this interface. Trystero/WebRTC is one
 * implementation; the in-memory one used by the tests is another. Keeping the
 * seam here is what makes the sync algorithm testable without a network.
 */
export interface Transport {
  readonly selfId: string
  /** Broadcast, or unicast when `target` is given. */
  send(msg: Msg, target?: string): void
  onMessage(handler: (msg: Msg, from: string) => void): void
  onPeerJoin(handler: (peerId: string) => void): void
  onPeerLeave(handler: (peerId: string) => void): void
  peers(): string[]
  leave(): Promise<void>
}
