import { beforeEach, describe, expect, it } from 'vitest'
import type { MediaRef } from '../lib/media'
import { FakeVideo } from '../testing/fakeVideo'
import { MemoryNetwork } from '../testing/memoryNetwork'
import { SyncEngine } from './engine'
import { TUNING } from './protocol'

const MEDIA: MediaRef = {
  kind: 'drive',
  fileId: 'FILE123456789012345678',
  url: 'https://drive.usercontent.google.com/download?id=FILE123456789012345678',
  title: 'Our film',
  setBy: 'Ada',
  setAt: 0,
}

const OTHER_MEDIA: MediaRef = { ...MEDIA, fileId: 'ZZZ', url: 'https://x/z', title: 'Other' }

interface Node {
  id: string
  engine: SyncEngine
  video: FakeVideo
}

/** Let promise callbacks (e.g. a rejected play()) run before asserting. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0))

/** Drives a whole simulated room off one fake clock. */
class Sim {
  readonly net = new MemoryNetwork()
  readonly nodes: Node[] = []

  add(id: string, name: string, opts: { clockSkewMs?: number } = {}): Node {
    const transport = this.net.connect(id, opts)
    const video = new FakeVideo()
    const engine = new SyncEngine({
      transport,
      name,
      now: this.net.clockFor(id),
    })
    engine.attachMedia(video)
    const node: Node = { id, engine, video }
    this.nodes.push(node)
    return node
  }

  remove(id: string): void {
    const i = this.nodes.findIndex((n) => n.id === id)
    if (i >= 0) this.nodes.splice(i, 1)
    this.net.disconnect(id)
  }

  /** Advance `ms` of wall time in `step`-sized slices, ticking every engine. */
  run(ms: number, step = 100): void {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      const slice = Math.min(step, ms - elapsed)
      for (const n of this.nodes) n.video.advance(slice)
      this.net.advance(slice)
      for (const n of this.nodes) n.engine.update()
    }
  }

  get(id: string): Node {
    const n = this.nodes.find((x) => x.id === id)
    if (!n) throw new Error(`no node ${id}`)
    return n
  }

  /** Largest pairwise difference in playhead position, in seconds. */
  spread(): number {
    const times = this.nodes.map((n) => n.video.currentTime)
    return Math.max(...times) - Math.min(...times)
  }
}

let sim: Sim
beforeEach(() => {
  sim = new Sim()
})

describe('room formation', () => {
  it('introduces peers to each other by name', () => {
    sim.add('a', 'Ada')
    sim.add('b', 'Bo')
    sim.run(1000)

    const namesFromA = sim.get('a').engine.getSnapshot().peers.map((p) => p.name).sort()
    const namesFromB = sim.get('b').engine.getSnapshot().peers.map((p) => p.name).sort()
    expect(namesFromA).toEqual(['Ada', 'Bo'])
    expect(namesFromB).toEqual(['Ada', 'Bo'])
  })

  it('reports the same leader on every peer', () => {
    sim.add('b', 'Bo')
    sim.add('a', 'Ada')
    sim.add('c', 'Cy')
    sim.run(1000)
    const leaders = sim.nodes.map((n) => n.engine.getSnapshot().leaderId)
    expect(new Set(leaders).size).toBe(1)
    expect(leaders[0]).toBe('a')
  })

  /**
   * Regression: peers can briefly disagree about who leads while they are
   * still learning about each other. A peer that pinned its anchor to its own
   * (paused) element during that window used to freeze its target at zero and
   * yank itself backwards until the real leader's next heartbeat.
   */
  it('recovers immediately after handing leadership over', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()

    // Well inside a single heartbeat period, so only the fallback can help.
    sim.run(TUNING.tickMs - 200)

    expect(b.video.paused).toBe(false)
    expect(b.video.currentTime).toBeGreaterThan(1)
    expect(Math.abs(b.video.currentTime - a.video.currentTime)).toBeLessThan(0.5)
    expect(b.video.seekCount).toBeLessThanOrEqual(1)
  })

  it('hands leadership over when the leader leaves', () => {
    sim.add('a', 'Ada')
    sim.add('b', 'Bo')
    sim.run(1000)
    expect(sim.get('b').engine.getSnapshot().isLeader).toBe(false)

    sim.remove('a')
    sim.run(1000)
    expect(sim.get('b').engine.getSnapshot().isLeader).toBe(true)
  })

  it('marks a solo user as disconnected but still playable', () => {
    const a = sim.add('a', 'Ada')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(2000)
    expect(a.engine.getSnapshot().connected).toBe(false)
    expect(a.video.paused).toBe(false)
    expect(a.video.currentTime).toBeGreaterThan(1.5)
  })
})

describe('arrivals and departures', () => {
  /** Collect room events from a node. */
  function watch(node: Node) {
    const events: string[] = []
    node.engine.onRoomEvent((e) => events.push(`${e.kind}:${e.name}`))
    return events
  }

  it('announces someone joining, by name', () => {
    const a = sim.add('a', 'Ada')
    const events = watch(a)
    sim.add('b', 'Bo')
    sim.run(1500)
    expect(events).toEqual(['join:Bo'])
  })

  it('never announces a nameless peer', () => {
    const a = sim.add('a', 'Ada')
    const events = watch(a)
    sim.add('b', 'Bo')
    sim.run(1500)
    // 'Guest' is the placeholder before their hello arrives.
    expect(events.join()).not.toMatch(/Guest/)
  })

  it('announces someone leaving, by name', () => {
    const a = sim.add('a', 'Ada')
    sim.add('b', 'Bo')
    sim.run(1500)
    const events = watch(a)

    sim.get('b').engine.destroy()
    sim.remove('b')
    sim.run(1500)
    expect(events).toEqual(['leave:Bo'])
  })

  it('does not announce ourselves', () => {
    const a = sim.add('a', 'Ada')
    const events = watch(a)
    sim.run(1500)
    expect(events).toEqual([])
  })

  it('announces each person once, not once per message', () => {
    const a = sim.add('a', 'Ada')
    const events = watch(a)
    sim.add('b', 'Bo')
    sim.run(30_000) // many heartbeats and re-announcements go by
    expect(events).toEqual(['join:Bo'])
  })

  it('announces a rejoin after a dropped connection', () => {
    const a = sim.add('a', 'Ada')
    sim.add('b', 'Bo')
    sim.run(1500)
    const events = watch(a)

    sim.remove('b')
    sim.run(1500)
    sim.add('b', 'Bo')
    sim.run(1500)

    expect(events).toEqual(['leave:Bo', 'join:Bo'])
  })
})

describe('changes made outside our controls', () => {
  it('adopts a pause from the native player', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(5000)

    // iOS fullscreen controls pause the element directly.
    b.video.pause()
    b.engine.adoptExternal('pause', b.video.currentTime)
    sim.run(1500)

    expect(a.engine.getSnapshot().intentPlaying).toBe(false)
    expect(a.video.paused).toBe(true)
  })

  it('adopts a seek from the native player', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(5000)

    b.video.currentTime = 900
    b.engine.adoptExternal('seek', 900)
    sim.run(1500)

    expect(a.video.currentTime).toBeGreaterThan(898)
    expect(a.video.currentTime).toBeLessThan(903)
  })

  it('ignores the echo of a change the engine just made itself', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.seek(300)
    sim.run(1000)

    // The engine's own seek raises a `seeked` event on the element. Adopting
    // it would issue a redundant control epoch and could ping-pong.
    const before = b.engine.getSnapshot()
    b.engine.adoptExternal('seek', b.video.currentTime)
    sim.run(500)
    expect(b.engine.getSnapshot().targetTime).toBeCloseTo(before.targetTime, 1)
  })

  it('ignores a play that merely confirms what the room already wants', () => {
    const a = sim.add('a', 'Ada')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(5000)
    const seq = a.engine.getSnapshot()

    a.engine.adoptExternal('play', a.video.currentTime)
    sim.run(500)
    expect(a.engine.getSnapshot().intentPlaying).toBe(seq.intentPlaying)
  })

  it('does nothing when there is no media', () => {
    const a = sim.add('a', 'Ada')
    a.engine.adoptExternal('play', 0)
    expect(a.engine.getSnapshot().intentPlaying).toBe(false)
  })
})

describe('control propagation', () => {
  it('propagates the media choice to everyone', () => {
    const a = sim.add('a', 'Ada')
    sim.add('b', 'Bo')
    sim.run(500)

    a.engine.setMedia(MEDIA)
    sim.run(500)

    expect(sim.get('b').engine.getSnapshot().media?.url).toBe(MEDIA.url)
    expect(sim.get('b').engine.getSnapshot().media?.title).toBe('Our film')
  })

  it('propagates play and pause from a follower as well as the leader', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    sim.run(500)

    // Follower presses play.
    b.engine.play()
    sim.run(1000)
    expect(a.video.paused).toBe(false)
    expect(b.video.paused).toBe(false)

    // Leader presses pause.
    a.engine.pause()
    sim.run(1000)
    expect(a.video.paused).toBe(true)
    expect(b.video.paused).toBe(true)
  })

  it('propagates seeks', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    sim.run(500)

    a.engine.seek(600)
    sim.run(1000)
    expect(b.video.currentTime).toBeGreaterThan(599)
    expect(b.video.currentTime).toBeLessThan(602)
  })

  it('treats skip buttons as relative to the room, not the local element', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.seek(100)
    sim.run(1000)

    b.engine.nudge(-10)
    sim.run(1000)
    expect(a.video.currentTime).toBeGreaterThan(89)
    expect(a.video.currentTime).toBeLessThan(92)
  })

  it('clamps seeks into the media duration', () => {
    const a = sim.add('a', 'Ada')
    a.engine.setMedia(MEDIA)
    a.engine.seek(999_999)
    sim.run(500)
    expect(a.video.currentTime).toBeLessThanOrEqual(a.video.duration)
    a.engine.seek(-50)
    sim.run(500)
    expect(a.video.currentTime).toBe(0)
  })

  it('resolves simultaneous conflicting presses identically on both peers', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    sim.run(500)

    // Same tick, opposite intents, same Lamport epoch.
    a.engine.play()
    b.engine.pause()
    sim.run(1500)

    const sa = a.engine.getSnapshot()
    const sb = b.engine.getSnapshot()
    expect(sa.intentPlaying).toBe(sb.intentPlaying)
    // Ties break on the lower peer id, so 'a' (play) wins deterministically.
    expect(sa.intentPlaying).toBe(true)
  })

  it('does not let a stale heartbeat undo a newer control action', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(3000)

    b.engine.pause()
    sim.run(4000) // several leader ticks go by
    expect(a.video.paused).toBe(true)
    expect(b.video.paused).toBe(true)
  })

  it('propagates a media change and restarts everyone at zero', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.seek(300)
    a.engine.play()
    sim.run(2000)

    b.engine.setMedia(OTHER_MEDIA)
    sim.run(1000)

    expect(a.engine.getSnapshot().media?.title).toBe('Other')
    expect(a.engine.getSnapshot().intentPlaying).toBe(false)
    expect(a.video.currentTime).toBeLessThan(1)
    expect(b.video.currentTime).toBeLessThan(1)
  })
})

describe('staying in sync', () => {
  it('holds two peers together despite differing decode rates', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.video.decodeSkew = 1.0
    b.video.decodeSkew = 1.02 // b's clock runs 2% fast — 1.2s of drift per minute
    a.engine.setMedia(MEDIA)
    a.engine.play()

    let worst = 0
    for (let i = 0; i < 60; i++) {
      sim.run(5000)
      worst = Math.max(worst, sim.spread())
    }
    // Five minutes of playback, well inside the stated 3-5s budget.
    expect(worst).toBeLessThan(1)
  })

  it('corrects drift smoothly rather than by seeking repeatedly', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    b.video.decodeSkew = 1.01
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(5000)

    const before = b.video.seekCount
    sim.run(120_000)
    const seeksDuringSteadyState = b.video.seekCount - before

    expect(seeksDuringSteadyState).toBeLessThanOrEqual(1)
    // ...and it really was correcting, via playback rate.
    expect(b.video.playbackRate).toBeLessThanOrEqual(1)
  })

  it('compensates for peers whose wall clocks disagree', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo', { clockSkewMs: 45_000 })
    const c = sim.add('c', 'Cy', { clockSkewMs: -12_000 })
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(20_000)

    expect(sim.spread()).toBeLessThan(0.5)
    expect(b.video.currentTime).toBeGreaterThan(15)
    expect(c.video.currentTime).toBeGreaterThan(15)
  })

  it('recovers when a peer is dragged far out of position', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(10_000)

    // Simulate a tab that was suspended and resumed far behind.
    b.video.currentTime = 2
    sim.run(3000)
    expect(Math.abs(b.video.currentTime - a.video.currentTime)).toBeLessThan(0.6)
  })

  it('keeps three peers together through play, seek and pause', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    const c = sim.add('c', 'Cy')
    b.video.decodeSkew = 1.005
    c.video.decodeSkew = 0.995
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(20_000)
    expect(sim.spread()).toBeLessThan(0.6)

    c.engine.seek(1200)
    sim.run(5000)
    expect(sim.spread()).toBeLessThan(0.6)

    b.engine.pause()
    sim.run(3000)
    expect(sim.nodes.every((n) => n.video.paused)).toBe(true)
    expect(sim.spread()).toBeLessThan(0.4)
  })

  it('never exceeds the agreed tolerance under jitter', () => {
    sim.net.latencyMs = 120
    sim.net.jitterMs = 150
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo', { clockSkewMs: 3000 })
    b.video.decodeSkew = 1.015
    a.engine.setMedia(MEDIA)
    a.engine.play()

    let worst = 0
    for (let i = 0; i < 40; i++) {
      sim.run(3000)
      worst = Math.max(worst, sim.spread())
    }
    expect(worst).toBeLessThan(3)
  })

  it('does not jump when a peer with a badly wrong clock joins', () => {
    const a = sim.add('a', 'Ada')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(4000)

    // A phone whose clock is two minutes off. Before the first pong lands we
    // have no offset for it, so its timestamps must not be taken literally.
    const b = sim.add('b', 'Bo', { clockSkewMs: 120_000 })

    // Taking the skewed timestamp literally would fling b two minutes ahead.
    let mostAhead = -Infinity
    for (let i = 0; i < 40; i++) {
      sim.run(250)
      mostAhead = Math.max(mostAhead, b.video.currentTime - a.video.currentTime)
    }
    expect(mostAhead).toBeLessThan(1)
    expect(Math.abs(b.video.currentTime - a.video.currentTime)).toBeLessThan(0.5)
  })
})

describe('late joiners', () => {
  it('catches a newcomer up to the current position', () => {
    const a = sim.add('a', 'Ada')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(30_000)

    const c = sim.add('c', 'Cy')
    sim.run(3000)

    expect(c.engine.getSnapshot().media?.url).toBe(MEDIA.url)
    expect(Math.abs(c.video.currentTime - a.video.currentTime)).toBeLessThan(1)
    expect(c.video.paused).toBe(false)
  })

  // Regression: caught by running two real browser tabs. Leadership goes to
  // the lowest peer id, so a newcomer can become leader the moment it arrives.
  // If only the leader hands out state, nobody ever tells it what is playing.
  it('catches up a newcomer that outranks the existing room', () => {
    const z = sim.add('z', 'Zoe')
    z.engine.setMedia(MEDIA)
    z.engine.play()
    sim.run(20_000)

    // 'a' sorts below 'z', so it becomes leader on arrival.
    const a = sim.add('a', 'Ada')
    sim.run(4000)

    expect(a.engine.getSnapshot().media?.url).toBe(MEDIA.url)
    expect(Math.abs(a.video.currentTime - z.video.currentTime)).toBeLessThan(1)
  })

  it('does not let an unloaded newcomer drag the room back to the start', () => {
    const z = sim.add('z', 'Zoe')
    z.engine.setMedia(MEDIA)
    z.engine.play()
    sim.run(30_000)
    const before = z.video.currentTime
    expect(before).toBeGreaterThan(25)

    // Joins with the lowest id but nothing loaded: it must not become the
    // timing authority and heartbeat a playhead of zero.
    const a = sim.add('a', 'Ada')
    a.video.downloadRate = 0
    a.video.bufferEnd = 0
    sim.run(6000)

    expect(z.video.currentTime).toBeGreaterThan(before)
    expect(z.engine.getSnapshot().leaderId).toBe('z')
  })

  it('hands leadership over once the newcomer has the media open', () => {
    const z = sim.add('z', 'Zoe')
    z.engine.setMedia(MEDIA)
    z.engine.play()
    sim.run(10_000)

    const a = sim.add('a', 'Ada')
    sim.run(6000)

    expect(z.engine.getSnapshot().leaderId).toBe('a')
    expect(a.engine.getSnapshot().isLeader).toBe(true)
    expect(sim.spread()).toBeLessThan(0.6)
  })

  it('catches a newcomer up while the room is paused', () => {
    const a = sim.add('a', 'Ada')
    a.engine.setMedia(MEDIA)
    a.engine.seek(450)
    sim.run(2000)

    const c = sim.add('c', 'Cy')
    sim.run(2000)
    expect(c.video.currentTime).toBeCloseTo(450, 0)
    expect(c.video.paused).toBe(true)
  })
})

describe('buffering coordination', () => {
  it('pauses the room for whoever is buffering, then resumes', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(5000)
    expect(a.video.paused).toBe(false)

    b.video.starve(0)
    sim.run(2000)

    expect(a.video.paused).toBe(true)
    expect(a.engine.getSnapshot().gated).toBe(true)
    expect(a.engine.getSnapshot().waitingFor).toEqual(['Bo'])
    // Intent is still "playing" — we are only holding, not stopping.
    expect(a.engine.getSnapshot().intentPlaying).toBe(true)

    b.video.refill(20)
    sim.run(4000)

    expect(a.engine.getSnapshot().gated).toBe(false)
    expect(a.video.paused).toBe(false)
    expect(b.video.paused).toBe(false)
    expect(sim.spread()).toBeLessThan(1)
  })

  /**
   * Regression, found with a real 1GB file over the network. A paused <video>
   * buffers a couple of seconds, fires `suspend`, and stops fetching until it
   * plays. Requiring a deeper buffer than that deadlocks the room: not ready,
   * so we hold; held, so it never plays; never playing, so it never buffers.
   */
  it('starts even though a paused element suspends with a shallow buffer', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    sim.run(500)

    // Less than resumeBufferSec, which is exactly what Chrome does.
    expect(2.4).toBeLessThan(TUNING.resumeBufferSec)
    a.video.suspendWithBuffer(2.4)
    b.video.suspendWithBuffer(2.4)
    sim.run(1000)

    a.engine.play()
    sim.run(2000)

    expect(a.engine.getSnapshot().gated).toBe(false)
    expect(a.engine.getSnapshot().waitingFor).toEqual([])
    expect(a.video.paused).toBe(false)
    expect(b.video.paused).toBe(false)
  })

  it('still waits for a peer whose buffer has genuinely run dry', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(3000)

    // An empty buffer is not the same as a satisfied browser.
    b.video.starve(0)
    sim.run(2000)
    expect(a.engine.getSnapshot().gated).toBe(true)
    expect(a.engine.getSnapshot().waitingFor).toEqual(['Bo'])
  })

  it('does not wait when the option is turned off', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.setWaitForEveryone(false)
    a.engine.play()
    sim.run(3000)

    b.video.starve(0)
    sim.run(4000)

    expect(a.video.paused).toBe(false)
    expect(a.engine.getSnapshot().gated).toBe(false)
    expect(b.engine.getSnapshot().waitForEveryone).toBe(false)
  })

  it('resyncs the straggler once its buffer returns', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.setWaitForEveryone(false)
    a.engine.play()
    sim.run(3000)

    b.video.starve(0)
    sim.run(10_000)
    expect(a.video.currentTime - b.video.currentTime).toBeGreaterThan(5)

    b.video.refill(500)
    sim.run(6000)
    expect(Math.abs(a.video.currentTime - b.video.currentTime)).toBeLessThan(1)
  })

  it('ignores a peer that never reports, so one bad client cannot freeze the room', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(2000)

    // b goes silent without disconnecting.
    b.engine.destroy()
    sim.remove('b')
    sim.run(TUNING.peerTimeoutMs + 6000)

    expect(a.engine.getSnapshot().gated).toBe(false)
    expect(a.video.paused).toBe(false)
  })
})

describe('autoplay policy', () => {
  it('flags that a gesture is required and clears it after unlock', async () => {
    const a = sim.add('a', 'Ada')
    a.video.blockAutoplay = true
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(500)
    await flushMicrotasks()

    expect(a.engine.getSnapshot().needsGesture).toBe(true)
    expect(a.video.paused).toBe(true)

    a.video.unlocked = true // the user tapped
    await a.engine.unlock()
    sim.run(500)

    expect(a.engine.getSnapshot().needsGesture).toBe(false)
    expect(a.video.paused).toBe(false)
  })

  it('stops retrying play() once the browser has refused', async () => {
    const a = sim.add('a', 'Ada')
    a.video.blockAutoplay = true
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(200)
    await flushMicrotasks()

    const callsAfterRefusal = a.video.playCalls
    sim.run(5000)
    await flushMicrotasks()
    expect(a.video.playCalls).toBe(callsAfterRefusal)
  })
})

describe('snapshot', () => {
  it('lists self first and exposes buffer health per person', () => {
    const a = sim.add('a', 'Ada')
    sim.add('b', 'Bo')
    a.engine.setMedia(MEDIA)
    a.engine.play()
    sim.run(3000)

    const snap = a.engine.getSnapshot()
    expect(snap.peers[0]?.isSelf).toBe(true)
    expect(snap.peers[0]?.name).toBe('Ada')
    expect(snap.peerCount).toBe(2)
    expect(snap.peers[1]?.buffered).toBeGreaterThan(0)
    expect(snap.peers[1]?.rttMs).not.toBeNull()
  })

  it('notifies subscribers as state changes', () => {
    const a = sim.add('a', 'Ada')
    let calls = 0
    const unsub = a.engine.subscribe(() => calls++)
    a.engine.setMedia(MEDIA)
    sim.run(500)
    expect(calls).toBeGreaterThan(0)

    const before = calls
    unsub()
    sim.run(500)
    expect(calls).toBe(before)
  })

  it('propagates a name change', () => {
    const a = sim.add('a', 'Ada')
    const b = sim.add('b', 'Bo')
    sim.run(500)
    a.engine.setName('Ada L.')
    sim.run(500)
    const names = b.engine.getSnapshot().peers.map((p) => p.name).sort()
    expect(names).toEqual(['Ada L.', 'Bo'])
  })
})
