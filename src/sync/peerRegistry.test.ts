import { describe, expect, it } from 'vitest'
import {
  createPeerRegistry,
  hasEverFailed,
  labelConnections,
  sharedPeerRegistry,
} from './peerRegistry'

/**
 * jsdom has no WebRTC, so the base class is injected. That is the same seam the
 * browser uses — Trystero is handed a class either way — and it lets these tests
 * count constructions without a real peer connection.
 */
class FakeConnection {
  static built = 0
  readonly config?: RTCConfiguration
  signalingState = 'stable'
  remoteDescription: unknown = null
  connectionState = 'new'
  iceConnectionState = 'new'
  private readonly listeners: Record<string, (() => void)[]> = {}

  constructor(config?: RTCConfiguration) {
    this.config = config
    FakeConnection.built++
  }

  addEventListener(event: string, fn: () => void) {
    ;(this.listeners[event] ??= []).push(fn)
  }

  /** Drive the connection to a state and let the registry notice. */
  moveTo(state: string) {
    this.connectionState = state
    for (const fn of this.listeners.connectionstatechange ?? []) fn()
  }
}

const base = FakeConnection as unknown as typeof RTCPeerConnection
const build = (registry: { connectionClass: typeof RTCPeerConnection | null }) =>
  new (registry.connectionClass as unknown as new () => RTCPeerConnection)()

describe('createPeerRegistry', () => {
  it('records every connection built, in order', () => {
    const registry = createPeerRegistry(base)
    const first = build(registry)
    const second = build(registry)
    expect(registry.built()).toEqual([first, second])
  })

  it('still constructs the real thing, with the config it was given', () => {
    const registry = createPeerRegistry(base)
    const Recorded = registry.connectionClass as unknown as new (
      c: RTCConfiguration,
    ) => FakeConnection
    const servers = [{ urls: 'stun:example.test' }]
    expect(new Recorded({ iceServers: servers }).config).toEqual({ iceServers: servers })
  })

  it('keeps a failed connection, which is the whole point', () => {
    // The old panel read Trystero's connected-peers map, so a room that could
    // not connect showed nothing at all. Whatever else changes here, a
    // connection that never worked has to stay visible.
    const registry = createPeerRegistry(base)
    const doomed = build(registry) as unknown as FakeConnection
    // What a failure looks like: it met somebody, and then it closed.
    doomed.remoteDescription = { type: 'answer' }
    doomed.signalingState = 'closed'
    expect(registry.built()).toContain(doomed)
  })

  it('forgets a pooled offer that closed without meeting anybody', () => {
    // Twenty of these accumulate in a minute of sitting in an empty room, and
    // they would bury the one connection somebody opened the panel to find.
    const registry = createPeerRegistry(base)
    const spent = build(registry) as unknown as FakeConnection
    const live = build(registry)
    spent.signalingState = 'closed'
    expect(registry.built()).toEqual([live])
  })

  it('drops the oldest rather than growing without limit', () => {
    const registry = createPeerRegistry(base)
    const all = Array.from({ length: 200 }, () => build(registry))
    const kept = registry.built()
    expect(kept.length).toBeLessThan(200)
    // Newest survive: they are the ones somebody is asking about.
    expect(kept.at(-1)).toBe(all.at(-1))
    expect(kept).not.toContain(all[0])
  })

  it('hands back a copy, so a caller cannot edit the record', () => {
    const registry = createPeerRegistry(base)
    build(registry)
    registry.built().length = 0
    expect(registry.built()).toHaveLength(1)
  })

  it('remembers a failure after the connection has been closed over it', () => {
    // The reason this is latched at all: `connectionState` reports `closed`
    // once something tidies up, which is also what a peer who left looks like.
    const registry = createPeerRegistry(base)
    const pc = build(registry) as unknown as FakeConnection
    expect(hasEverFailed(pc as unknown as RTCPeerConnection)).toBe(false)
    pc.moveTo('failed')
    pc.moveTo('closed')
    expect(hasEverFailed(pc as unknown as RTCPeerConnection)).toBe(true)
  })

  it('does not mark a connection that closed cleanly', () => {
    const registry = createPeerRegistry(base)
    const pc = build(registry) as unknown as FakeConnection
    pc.moveTo('connected')
    pc.moveTo('closed')
    expect(hasEverFailed(pc as unknown as RTCPeerConnection)).toBe(false)
  })

  it('says so plainly when the browser has no WebRTC at all', () => {
    const registry = createPeerRegistry(undefined)
    expect(registry.connectionClass).toBeNull()
    expect(registry.built()).toEqual([])
  })
})

describe('sharedPeerRegistry', () => {
  it('is one registry for the page, so a reconnect keeps the history', () => {
    // Per-transport, this reset on every rebuild — which is exactly when
    // somebody opens the panel — and missed Trystero's offer pool entirely,
    // because that pool is module-global and outlives any one room.
    expect(sharedPeerRegistry()).toBe(sharedPeerRegistry())
  })
})

describe('labelConnections', () => {
  const pc = (n: number) => ({ id: n }) as unknown as RTCPeerConnection

  it('uses the peer id where Trystero knows one, shortened', () => {
    const connected = pc(1)
    expect(labelConnections({ uSNIFjxCfRIHzzheeksc: connected }, [connected])).toEqual({
      uSNIFj: connected,
    })
  })

  it('numbers the ones nobody can name', () => {
    const failed = pc(1)
    const alsoFailed = pc(2)
    expect(labelConnections({}, [failed, alsoFailed])).toEqual({
      'attempt 1': failed,
      'attempt 2': alsoFailed,
    })
  })

  it('keeps a named peer alongside unnamed attempts', () => {
    const failed = pc(1)
    const connected = pc(2)
    expect(labelConnections({ abcdefghij: connected }, [failed, connected])).toEqual({
      'attempt 1': failed,
      abcdef: connected,
    })
  })

  it('does not lose a peer Trystero knows about but the registry never saw', () => {
    // The polyfill not being used at all: better a report with no attempts than
    // one missing the connection that is actually carrying the room.
    const connected = pc(1)
    expect(labelConnections({ abcdefghij: connected }, [])).toEqual({ abcdef: connected })
  })

  it('leaves out a live connection belonging to a room this page has left', () => {
    // The registry outlives any one room, so after switching rooms the previous
    // room's connection is still open and still in it. Reported here it reads
    // as the *current* room mid-negotiation, and pins the verdict there.
    const elsewhere = { connectionState: 'connected' } as unknown as RTCPeerConnection
    expect(labelConnections({}, [elsewhere])).toEqual({})
  })

  it('keeps a failed connection this room does not know about', () => {
    // The distinction that makes the rule above safe: a failure has no peer id
    // either, and it is the entire reason the panel exists.
    const failed = { connectionState: 'failed' } as unknown as RTCPeerConnection
    expect(labelConnections({}, [failed])).toEqual({ 'attempt 1': failed })
  })

  it('returns nothing when nothing has been built', () => {
    expect(labelConnections({}, [])).toEqual({})
  })
})
