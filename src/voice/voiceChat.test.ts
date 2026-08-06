import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Msg } from '../sync/protocol'
import type { MediaChannel, Transport } from '../sync/transport'
import { AUDIO_CONSTRAINTS, VoiceChat, type LevelMeter } from './voiceChat'

class FakeTrack {
  enabled = true
  stopped = false
  readonly kind = 'audio'
  stop() {
    this.stopped = true
  }
}

class FakeStream {
  readonly tracks: FakeTrack[] = [new FakeTrack()]
  getAudioTracks() {
    return this.tracks
  }
  getTracks() {
    return this.tracks
  }
}

const asStream = (s: FakeStream) => s as unknown as MediaStream

class FakeTransport implements Transport {
  readonly selfId = 'self'
  sent: Msg[] = []
  private msgHandlers: ((m: Msg, from: string) => void)[] = []
  private leaveHandlers: ((id: string) => void)[] = []
  added: MediaStream[] = []
  /** Peer ids that a stream was sent to individually. */
  addedTargets: string[] = []
  removed: MediaStream[] = []
  private joinHandlers: ((id: string) => void)[] = []
  private streamHandlers: ((s: MediaStream, id: string) => void)[] = []

  media: MediaChannel = {
    addStream: (s, target) => {
      if (target) this.addedTargets.push(target)
      else this.added.push(s)
    },
    removeStream: (s) => void this.removed.push(s),
    onPeerStream: (h) => void this.streamHandlers.push(h),
    connections: () => ({}),
  }

  send(msg: Msg) {
    this.sent.push(msg)
  }
  onMessage(h: (m: Msg, from: string) => void) {
    this.msgHandlers.push(h)
  }
  onPeerJoin(h: (id: string) => void) {
    this.joinHandlers.push(h)
  }
  onPeerLeave(h: (id: string) => void) {
    this.leaveHandlers.push(h)
  }
  peers() {
    return []
  }
  async leave() {}

  deliver(msg: Msg, from: string) {
    for (const h of this.msgHandlers) h(msg, from)
  }
  peerJoined(id: string) {
    for (const h of this.joinHandlers) h(id)
  }
  peerLeft(id: string) {
    for (const h of this.leaveHandlers) h(id)
  }
  peerStream(s: MediaStream, id: string) {
    for (const h of this.streamHandlers) h(s, id)
  }
  micMessages() {
    return this.sent.filter((m): m is Extract<Msg, { t: 'mic' }> => m.t === 'mic')
  }
}

/** Builds a VoiceChat wired to controllable fakes. */
function setup(
  opts: {
    fail?: Error
    level?: () => number
    /** Simulate a browser that refuses to autoplay remote audio (iOS). */
    blockRemotePlayback?: boolean
  } = {},
) {
  const transport = new FakeTransport()
  const stream = new FakeStream()
  let now = 0
  const detached: string[] = []
  let meterClosed = false

  const meter: LevelMeter = {
    rms: () => opts.level?.() ?? 0,
    close: () => {
      meterClosed = true
    },
  }

  let allowPlayback = !opts.blockRemotePlayback
  const playAttempts: string[] = []

  const voice = new VoiceChat({
    transport,
    now: () => now,
    getUserMedia: opts.fail
      ? () => Promise.reject(opts.fail)
      : () => Promise.resolve(asStream(stream)),
    makeMeter: () => meter,
    playRemote: (_s, id) => ({
      play: () => {
        playAttempts.push(id)
        return Promise.resolve(allowPlayback)
      },
      detach: () => void detached.push(id),
    }),
    speaking: { threshold: 0.05, attackMs: 100, releaseMs: 300 },
  })

  return {
    transport,
    stream,
    voice,
    detached,
    playAttempts,
    /** Simulate the user finally tapping, which lifts the autoplay block. */
    allowPlayback() {
      allowPlayback = true
    },
    meterClosed: () => meterClosed,
    tick(ms: number) {
      now += ms
      voice.update()
    },
    at: () => now,
  }
}

let s: ReturnType<typeof setup>
beforeEach(() => {
  s = setup()
})

describe('enabling the microphone', () => {
  it('shares the captured stream with the room', async () => {
    await s.voice.enable()
    expect(s.voice.getSnapshot().state).toBe('on')
    expect(s.transport.added).toHaveLength(1)
  })

  it('requests echo cancellation, which is what stops the film echoing back', () => {
    const audio = AUDIO_CONSTRAINTS.audio as MediaTrackConstraints
    expect(audio.echoCancellation).toBe(true)
    expect(audio.noiseSuppression).toBe(true)
    expect(audio.autoGainControl).toBe(true)
  })

  it('configures the audio session before capturing, for iOS', async () => {
    const order: string[] = []
    const transport = new FakeTransport()
    const voice = new VoiceChat({
      transport,
      configureAudioSession: () => order.push('session'),
      getUserMedia: () => {
        order.push('capture')
        return Promise.resolve(asStream(new FakeStream()))
      },
    })
    await voice.enable()
    expect(order).toEqual(['session', 'capture'])
  })

  it('announces the mic to the room', async () => {
    await s.voice.enable()
    const last = s.transport.micMessages().at(-1)
    expect(last).toMatchObject({ t: 'mic', on: true, muted: false })
  })

  it('ignores a second enable while already on', async () => {
    await s.voice.enable()
    await s.voice.enable()
    expect(s.transport.added).toHaveLength(1)
  })
})

describe('failures', () => {
  it('reports a denied permission without throwing', async () => {
    const denied = setup({ fail: new DOMException('no', 'NotAllowedError') })
    await denied.voice.enable()
    const snap = denied.voice.getSnapshot()
    expect(snap.state).toBe('denied')
    expect(snap.error).toMatch(/blocked/i)
  })

  it('reports a missing microphone', async () => {
    const none = setup({ fail: new DOMException('no', 'NotFoundError') })
    await none.voice.enable()
    expect(none.voice.getSnapshot().state).toBe('unavailable')
    expect(none.voice.getSnapshot().error).toMatch(/no microphone/i)
  })

  it('explains that an insecure origin cannot use the mic', async () => {
    const insecure = setup({ fail: new DOMException('no', 'NotSupportedError') })
    await insecure.voice.enable()
    expect(insecure.voice.getSnapshot().error).toMatch(/https/i)
  })

  it('mentions another app holding the microphone', async () => {
    const busy = setup({ fail: new DOMException('no', 'NotReadableError') })
    await busy.voice.enable()
    expect(busy.voice.getSnapshot().state).toBe('error')
    expect(busy.voice.getSnapshot().error).toMatch(/another app/i)
  })

  it('shares nothing when capture fails', async () => {
    const denied = setup({ fail: new DOMException('no', 'NotAllowedError') })
    await denied.voice.enable()
    expect(denied.transport.added).toHaveLength(0)
  })
})

describe('muting', () => {
  it('disables the track rather than dropping it, so unmute is instant', async () => {
    await s.voice.enable()
    s.voice.setMuted(true)
    expect(s.stream.tracks[0]!.enabled).toBe(false)
    expect(s.stream.tracks[0]!.stopped).toBe(false)
    expect(s.transport.removed).toHaveLength(0)

    s.voice.setMuted(false)
    expect(s.stream.tracks[0]!.enabled).toBe(true)
  })

  it('tells the room about the mute', async () => {
    await s.voice.enable()
    s.voice.setMuted(true)
    expect(s.transport.micMessages().at(-1)).toMatchObject({ on: true, muted: true })
  })

  it('never reports speaking while muted', async () => {
    const loud = setup({ level: () => 0.9 })
    await loud.voice.enable()
    loud.voice.setMuted(true)
    for (let i = 0; i < 20; i++) loud.tick(100)
    expect(loud.voice.getSnapshot().speaking).toBe(false)
  })
})

describe('speaking detection', () => {
  it('reports speaking once the level holds', async () => {
    let level = 0
    const v = setup({ level: () => level })
    await v.voice.enable()
    expect(v.voice.getSnapshot().speaking).toBe(false)

    level = 0.9
    for (let i = 0; i < 5; i++) v.tick(100)
    expect(v.voice.getSnapshot().speaking).toBe(true)

    level = 0
    for (let i = 0; i < 8; i++) v.tick(100)
    expect(v.voice.getSnapshot().speaking).toBe(false)
  })

  it('broadcasts speaking changes but does not spam the room', async () => {
    let level = 0.9
    const v = setup({ level: () => level })
    await v.voice.enable()
    const before = v.transport.micMessages().length

    for (let i = 0; i < 10; i++) v.tick(100) // steady speech
    const after = v.transport.micMessages().length
    // One transition, plus at most the periodic refresh.
    expect(after - before).toBeLessThanOrEqual(2)
    expect(v.transport.micMessages().at(-1)?.speaking).toBe(true)
    level = 0
  })

  it('re-announces periodically so late joiners learn the state', async () => {
    await s.voice.enable()
    const before = s.transport.micMessages().length
    for (let i = 0; i < 100; i++) s.tick(100) // 10 seconds
    expect(s.transport.micMessages().length).toBeGreaterThan(before)
  })
})

describe('peers', () => {
  it('tracks other people’s mic state', () => {
    s.transport.deliver({ t: 'mic', on: true, muted: false, speaking: true }, 'bo')
    const snap = s.voice.getSnapshot()
    expect(snap.peers.bo).toEqual({ on: true, muted: false, speaking: true })
    expect(snap.anyoneElseOn).toBe(true)
  })

  it('ignores its own echo', () => {
    s.transport.deliver({ t: 'mic', on: true, muted: false, speaking: true }, 'self')
    expect(s.voice.getSnapshot().peers.self).toBeUndefined()
  })

  it('ignores non-voice traffic', () => {
    s.transport.deliver({ t: 'bye' }, 'bo')
    expect(s.voice.getSnapshot().peers.bo).toBeUndefined()
  })

  it('plays a peer stream and detaches when they leave', () => {
    s.transport.peerStream(asStream(new FakeStream()), 'bo')
    s.transport.deliver({ t: 'mic', on: true, muted: false, speaking: false }, 'bo')
    expect(s.voice.getSnapshot().peers.bo?.on).toBe(true)

    s.transport.peerLeft('bo')
    expect(s.detached).toEqual(['bo'])
    expect(s.voice.getSnapshot().peers.bo).toBeUndefined()
  })

  it('replaces an old stream when a peer re-enables its mic', () => {
    s.transport.peerStream(asStream(new FakeStream()), 'bo')
    s.transport.peerStream(asStream(new FakeStream()), 'bo')
    expect(s.detached).toEqual(['bo'])
  })
})

/**
 * Regression: voice was inaudible on iOS. A listener who joins to watch and
 * never touches the screen has made no user gesture, so iOS silently refuses
 * to start their partner's audio. The old code swallowed that rejection and
 * nothing ever retried.
 */
describe('when the browser refuses to autoplay remote audio', () => {
  it('reports that a gesture is needed instead of failing silently', async () => {
    const ios = setup({ blockRemotePlayback: true })
    ios.transport.peerStream(asStream(new FakeStream()), 'bo')
    await vi.waitFor(() => expect(ios.voice.getSnapshot().needsGesture).toBe(true))
  })

  it('starts the audio once a gesture arrives', async () => {
    const ios = setup({ blockRemotePlayback: true })
    ios.transport.peerStream(asStream(new FakeStream()), 'bo')
    await vi.waitFor(() => expect(ios.voice.getSnapshot().needsGesture).toBe(true))

    ios.allowPlayback()
    await ios.voice.resumePlayback()

    expect(ios.voice.getSnapshot().needsGesture).toBe(false)
    expect(ios.playAttempts.filter((p) => p === 'bo').length).toBeGreaterThan(1)
  })

  it('retries every blocked peer, not just the first', async () => {
    const ios = setup({ blockRemotePlayback: true })
    ios.transport.peerStream(asStream(new FakeStream()), 'bo')
    ios.transport.peerStream(asStream(new FakeStream()), 'cy')
    await vi.waitFor(() => expect(ios.voice.getSnapshot().needsGesture).toBe(true))

    ios.allowPlayback()
    await ios.voice.resumePlayback()
    expect(ios.voice.getSnapshot().needsGesture).toBe(false)
  })

  it('takes turning the mic on as the gesture', async () => {
    const ios = setup({ blockRemotePlayback: true })
    ios.transport.peerStream(asStream(new FakeStream()), 'bo')
    await vi.waitFor(() => expect(ios.voice.getSnapshot().needsGesture).toBe(true))

    ios.allowPlayback()
    await ios.voice.enable()
    await vi.waitFor(() => expect(ios.voice.getSnapshot().needsGesture).toBe(false))
  })

  it('clears the prompt when the blocked peer leaves', async () => {
    const ios = setup({ blockRemotePlayback: true })
    ios.transport.peerStream(asStream(new FakeStream()), 'bo')
    await vi.waitFor(() => expect(ios.voice.getSnapshot().needsGesture).toBe(true))

    ios.transport.peerLeft('bo')
    expect(ios.voice.getSnapshot().needsGesture).toBe(false)
  })

  it('asks for no gesture when playback simply works', async () => {
    s.transport.peerStream(asStream(new FakeStream()), 'bo')
    await vi.waitFor(() => expect(s.playAttempts).toContain('bo'))
    expect(s.voice.getSnapshot().needsGesture).toBe(false)
  })
})

/**
 * Recovery. `addStream` only reaches the peers connected when it is called, so
 * without re-offering, anyone who joins — or rejoins after their connection
 * dropped — hears silence from us forever.
 */
describe('recovering from a dropped connection', () => {
  it('sends our microphone to a peer that joins later', async () => {
    await s.voice.enable()
    expect(s.transport.added).toHaveLength(1)

    s.transport.peerJoined('bo')
    expect(s.transport.addedTargets).toContain('bo')
  })

  it('re-sends after a peer drops and comes back', async () => {
    await s.voice.enable()
    s.transport.peerJoined('bo')
    s.transport.peerLeft('bo')
    s.transport.peerJoined('bo')

    expect(s.transport.addedTargets.filter((t) => t === 'bo')).toHaveLength(2)
  })

  it('re-announces mute state to the returning peer', async () => {
    await s.voice.enable()
    s.voice.setMuted(true)
    const before = s.transport.micMessages().length
    s.transport.peerJoined('bo')
    expect(s.transport.micMessages().length).toBeGreaterThan(before)
    expect(s.transport.micMessages().at(-1)).toMatchObject({ on: true, muted: true })
  })

  it('offers nothing when our microphone is off', () => {
    s.transport.peerJoined('bo')
    expect(s.transport.addedTargets).toHaveLength(0)
  })
})

describe('disabling', () => {
  it('stops the tracks, withdraws the stream and tells the room', async () => {
    await s.voice.enable()
    s.voice.disable()

    expect(s.stream.tracks[0]!.stopped).toBe(true)
    expect(s.transport.removed).toHaveLength(1)
    expect(s.meterClosed()).toBe(true)
    expect(s.voice.getSnapshot().state).toBe('off')
    expect(s.transport.micMessages().at(-1)).toMatchObject({ on: false })
  })

  it('toggles on and off', async () => {
    await s.voice.toggle()
    expect(s.voice.getSnapshot().state).toBe('on')
    await s.voice.toggle()
    expect(s.voice.getSnapshot().state).toBe('off')
  })

  it('cleans up everything on destroy', async () => {
    await s.voice.enable()
    s.transport.peerStream(asStream(new FakeStream()), 'bo')
    s.voice.destroy()
    expect(s.stream.tracks[0]!.stopped).toBe(true)
    expect(s.detached).toEqual(['bo'])
  })

  it('does nothing after destroy', async () => {
    s.voice.destroy()
    await s.voice.enable()
    expect(s.transport.added).toHaveLength(0)
  })
})

describe('the video is structurally safe from ducking', () => {
  it('exposes no way to reach a media element', async () => {
    await s.voice.enable()
    // The constructor takes a transport and audio helpers, and nothing else.
    // There is no video element in scope, so no code path can turn it down.
    const surface = Object.keys(s.voice)
    expect(surface.join(' ')).not.toMatch(/video|element|volume/i)
  })

  it('notifies subscribers as state changes', async () => {
    const fn = vi.fn()
    s.voice.subscribe(fn)
    await s.voice.enable()
    expect(fn).toHaveBeenCalled()
  })
})
