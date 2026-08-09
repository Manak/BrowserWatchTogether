import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSignal } from '../signal/relay'
import { MemoryStore } from '../signal/store'
import { SignalRelay } from './relayStrategy'

/**
 * The client half of the relay, driven against the real handler.
 *
 * Between them, `signal/relay.test.ts` proves the server keeps and hands back
 * the right messages, and this proves the browser side asks for them correctly
 * and does not ask too often. What neither can prove is WebRTC itself, which
 * needs a real browser — see the note in ASSUMPTIONS.
 */

let store: MemoryStore
let requests: { method: string; url: string }[]

/** A fetch that goes to the relay handler instead of to the network. */
function relayFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    requests.push({ method, url })
    const res = await handleSignal({
      method,
      url,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }, store)
    return new Response(res.body, { status: res.status, headers: res.headers })
  }) as typeof fetch
}

beforeEach(() => {
  store = new MemoryStore()
  requests = []
  vi.useFakeTimers()
})

afterEach(() => vi.useRealTimers())

/** Let the poll's promise chain settle, then run its next timer. */
async function tick(ms = 1000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('a peer talking to our relay', () => {
  it('carries a message from one peer to another', async () => {
    const heard: string[] = []
    const a = new SignalRelay('/api/signal', { selfId: 'peer-a', fetcher: relayFetch() })
    const b = new SignalRelay('/api/signal', { selfId: 'peer-b', fetcher: relayFetch() })
    b.subscribe('room1', (_t, msg) => heard.push(msg))

    await a.publish('room1', 'an offer')
    await tick(2000)

    expect(heard).toEqual(['an offer'])
    a.stop()
    b.stop()
  })

  it('never delivers a peer its own announcement', async () => {
    const heard: string[] = []
    const a = new SignalRelay('/api/signal', { selfId: 'peer-a', fetcher: relayFetch() })
    a.subscribe('room1', (_t, msg) => heard.push(msg))

    await a.publish('room1', 'my own announcement')
    await tick(3000)

    expect(heard).toEqual([])
    a.stop()
  })

  it('delivers each message exactly once, though the relay replays it', async () => {
    const heard: string[] = []
    const a = new SignalRelay('/api/signal', { selfId: 'peer-a', fetcher: relayFetch() })
    const b = new SignalRelay('/api/signal', { selfId: 'peer-b', fetcher: relayFetch() })
    b.subscribe('room1', (_t, msg) => heard.push(msg))

    await a.publish('room1', 'an offer')
    await tick(20_000)

    expect(heard).toEqual(['an offer'])
    a.stop()
    b.stop()
  })

  it('asks about every topic it watches in one request', async () => {
    const b = new SignalRelay('/api/signal', { selfId: 'peer-b', fetcher: relayFetch() })
    b.subscribe('room1', () => {})
    b.subscribe('peer-b-topic', () => {})
    await tick(1500)

    const polls = requests.filter((r) => r.method === 'GET')
    expect(polls.length).toBeGreaterThan(0)
    for (const poll of polls) {
      const topics = new URL(poll.url, 'http://x').searchParams.get('topics')
      expect(topics).toBe('room1,peer-b-topic')
    }
    b.stop()
  })

  it('stops polling the moment the room is left', async () => {
    const b = new SignalRelay('/api/signal', { selfId: 'peer-b', fetcher: relayFetch() })
    const unsubscribe = b.subscribe('room1', () => {})
    await tick(2000)
    const before = requests.length
    expect(before).toBeGreaterThan(0)

    unsubscribe()
    await tick(30_000)

    expect(requests.length).toBe(before)
  })

  /**
   * Signalling is a background cost for the whole time a film is playing, so
   * the steady rate matters: it is what the deployment pays for per hour.
   */
  it('polls hard while joining and then settles down', async () => {
    const b = new SignalRelay('/api/signal', { selfId: 'peer-b', fetcher: relayFetch() })
    b.subscribe('room1', () => {})

    await tick(10_000)
    const eager = requests.length

    // Clear the eager window entirely before measuring the rate it settles to.
    await tick(20_000)
    requests = []
    await tick(30_000)
    const settled = requests.length

    // About one a second while joining…
    expect(eager).toBeGreaterThan(8)
    // …and roughly a third of that once nothing is happening, which is what a
    // deployment pays for per hour of film.
    expect(settled).toBeLessThan(eager)
    expect(settled / 30).toBeLessThan(0.4)
    b.stop()
  })

  it('backs off when the relay is down instead of hammering it', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    const b = new SignalRelay('/api/signal', {
      selfId: 'peer-b',
      fetcher: failing as unknown as typeof fetch,
    })
    b.subscribe('room1', () => {})

    await tick(30_000)

    // With the backoff schedule this is a handful of attempts, not thirty.
    expect(failing.mock.calls.length).toBeLessThan(12)
    expect(failing.mock.calls.length).toBeGreaterThan(2)
    b.stop()
  })

  it('recovers on its own once the relay answers again', async () => {
    let broken = true
    const real = relayFetch()
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (broken) throw new Error('offline')
      return real(input, init)
    }) as typeof fetch

    const heard: string[] = []
    const a = new SignalRelay('/api/signal', { selfId: 'peer-a', fetcher: relayFetch() })
    const b = new SignalRelay('/api/signal', { selfId: 'peer-b', fetcher: flaky })
    b.subscribe('room1', (_t, msg) => heard.push(msg))

    await tick(10_000)
    expect(heard).toEqual([])

    broken = false
    await a.publish('room1', 'an offer')
    await tick(30_000)

    expect(heard).toEqual(['an offer'])
    a.stop()
    b.stop()
  })

  it('does not stack up requests when one is slow', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const real = relayFetch()
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
      return real(input, init)
    }) as typeof fetch

    const b = new SignalRelay('/api/signal', { selfId: 'peer-b', fetcher: slow })
    b.subscribe('room1', () => {})

    await tick(20_000)
    expect(requests.length).toBe(0) // still blocked on the first one
    gate.release?.()
    await tick(0)

    // One in flight at a time: the slow request did not queue nineteen behind it.
    expect(requests.length).toBe(1)
    b.stop()
  })
})
