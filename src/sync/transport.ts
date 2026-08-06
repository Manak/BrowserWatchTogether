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
  /**
   * Live audio, for voice chat. Optional: the sync engine never touches it, and
   * the in-memory test transport does not implement it.
   */
  media?: MediaChannel
}

/** Sending and receiving live media tracks over the same peer connections. */
export interface MediaChannel {
  addStream(stream: MediaStream): void
  removeStream(stream: MediaStream): void
  onPeerStream(handler: (stream: MediaStream, peerId: string) => void): void
  /**
   * The underlying connections, so the voice layer can tune receivers for
   * latency. Returns an empty object when unavailable.
   */
  connections(): Record<string, RTCPeerConnection>
}
