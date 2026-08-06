import type { Msg } from '../sync/protocol'
import type { Transport } from '../sync/transport'

/**
 * A deterministic stand-in for the WebRTC mesh.
 *
 * Time only moves when a test says so, and messages are delivered from a queue
 * ordered by arrival time, so multi-peer sync behaviour is fully reproducible —
 * no timers, no network, no flakes.
 */

interface Envelope {
  at: number
  to: string
  from: string
  msg: Msg
}

type JoinEvent = { at: number; to: string; peer: string; kind: 'join' | 'leave' }

export class MemoryNetwork {
  now = 0
  /** One-way delay applied to every message. */
  latencyMs = 30
  /** Extra delay added deterministically per message, to model jitter. */
  jitterMs = 0

  private nodes = new Map<string, MemoryTransport>()
  private queue: Envelope[] = []
  private events: JoinEvent[] = []
  private jitterCounter = 0
  /** Per-node clock skew, so tests can prove clock sync actually does work. */
  private skew = new Map<string, number>()

  connect(id: string, opts: { clockSkewMs?: number } = {}): MemoryTransport {
    const t = new MemoryTransport(this, id)
    // Tell existing nodes about the newcomer and vice versa.
    for (const other of this.nodes.keys()) {
      this.events.push({ at: this.now + this.latencyMs, to: other, peer: id, kind: 'join' })
      this.events.push({ at: this.now + this.latencyMs, to: id, peer: other, kind: 'join' })
    }
    this.nodes.set(id, t)
    this.skew.set(id, opts.clockSkewMs ?? 0)
    return t
  }

  disconnect(id: string): void {
    this.nodes.delete(id)
    this.skew.delete(id)
    this.queue = this.queue.filter((e) => e.to !== id && e.from !== id)
    for (const other of this.nodes.keys()) {
      this.events.push({ at: this.now + this.latencyMs, to: other, peer: id, kind: 'leave' })
    }
  }

  /** A node's own view of wall-clock time, including its skew. */
  clockFor(id: string): () => number {
    return () => this.now + (this.skew.get(id) ?? 0)
  }

  peersOf(id: string): string[] {
    return [...this.nodes.keys()].filter((n) => n !== id)
  }

  enqueue(from: string, to: string | undefined, msg: Msg): void {
    const jitter = this.jitterMs > 0 ? (this.jitterCounter++ * 7) % this.jitterMs : 0
    const at = this.now + this.latencyMs + jitter
    const targets = to ? [to] : this.peersOf(from)
    for (const target of targets) {
      if (!this.nodes.has(target)) continue
      // Structured clone keeps tests honest about shared references.
      this.queue.push({ at, to: target, from, msg: JSON.parse(JSON.stringify(msg)) as Msg })
    }
  }

  /** Advance time to `t`, delivering everything due along the way. */
  private deliverUntil(t: number): void {
    for (;;) {
      const dueEvent = this.events.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0]
      const dueMsg = this.queue.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0]
      const next =
        dueEvent && dueMsg
          ? dueEvent.at <= dueMsg.at
            ? dueEvent
            : dueMsg
          : (dueEvent ?? dueMsg)
      if (!next) break

      if ('kind' in next) {
        this.events.splice(this.events.indexOf(next), 1)
        this.nodes.get(next.to)?.deliverPeerEvent(next.kind, next.peer)
      } else {
        this.queue.splice(this.queue.indexOf(next), 1)
        this.nodes.get(next.to)?.deliverMessage(next.msg, next.from)
      }
    }
  }

  /** Step the simulated clock forward, in one go. */
  advance(ms: number): void {
    this.now += ms
    this.deliverUntil(this.now)
  }
}

export class MemoryTransport implements Transport {
  private msgHandlers: ((msg: Msg, from: string) => void)[] = []
  private joinHandlers: ((id: string) => void)[] = []
  private leaveHandlers: ((id: string) => void)[] = []
  private left = false

  constructor(
    private readonly net: MemoryNetwork,
    readonly selfId: string,
  ) {}

  send(msg: Msg, target?: string): void {
    if (this.left) return
    this.net.enqueue(this.selfId, target, msg)
  }

  onMessage(h: (msg: Msg, from: string) => void): void {
    this.msgHandlers.push(h)
  }
  onPeerJoin(h: (id: string) => void): void {
    this.joinHandlers.push(h)
  }
  onPeerLeave(h: (id: string) => void): void {
    this.leaveHandlers.push(h)
  }
  peers(): string[] {
    return this.left ? [] : this.net.peersOf(this.selfId)
  }
  async leave(): Promise<void> {
    this.left = true
    this.net.disconnect(this.selfId)
  }

  deliverMessage(msg: Msg, from: string): void {
    if (this.left) return
    for (const h of this.msgHandlers) h(msg, from)
  }

  deliverPeerEvent(kind: 'join' | 'leave', peer: string): void {
    if (this.left) return
    const hs = kind === 'join' ? this.joinHandlers : this.leaveHandlers
    for (const h of hs) h(peer)
  }
}
