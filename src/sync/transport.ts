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
  /**
   * Bulk bytes, for a file shared straight from someone's disk. Optional for
   * the same reason as `media`: nothing in the sync algorithm depends on it.
   */
  files?: FileChannel
}

/** A slice of a shared file. `end` is inclusive, as in an HTTP Range header. */
export interface RangeRequest {
  /** Identifies which shared file, not which peer. */
  shareId: string
  start: number
  end: number
}

/**
 * Request/response for file bytes, kept off the JSON message path.
 *
 * Sync messages are tiny, frequent and broadcast; file bytes are none of those.
 * Giving them their own seam means the engine's wire protocol stays a small
 * readable union, and a transport that cannot carry binary (the in-memory one
 * used by most tests) simply omits this.
 */
export interface FileChannel {
  /**
   * Ask one peer for a byte range. Resolves with *at most* the requested range:
   * a host is free to answer with less, which is what keeps a receiver's memory
   * bounded no matter how much the browser asks for at once.
   *
   * Rejects if the peer is gone, refuses, or does not answer in time.
   */
  request(target: string, req: RangeRequest, signal?: AbortSignal): Promise<Uint8Array>
  /**
   * Answer incoming range requests. Returning null means "I am not serving
   * that", which reaches the other side as a rejected request.
   */
  onRequest(
    handler: (req: RangeRequest, from: string) => Promise<Uint8Array | null>,
  ): void
}

/** Sending and receiving live media tracks over the same peer connections. */
export interface MediaChannel {
  /** Send to everyone, or to one peer when `target` is given. */
  addStream(stream: MediaStream, target?: string): void
  removeStream(stream: MediaStream): void
  onPeerStream(handler: (stream: MediaStream, peerId: string) => void): void
  /**
   * The underlying connections, so the voice layer can tune receivers for
   * latency. Returns an empty object when unavailable.
   */
  connections(): Record<string, RTCPeerConnection>
}
