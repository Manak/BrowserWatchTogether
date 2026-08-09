import { describe, expect, it } from 'vitest'
import {
  handleSignal,
  MESSAGE_TTL_MS,
  parseKey,
  REPLAY_WINDOW_MS,
  type SignalMessage,
} from './relay'
import { MemoryStore } from './store'

/**
 * The relay is the one server this app has, and the only thing standing between
 * two people and a room they cannot join. Its whole job is: keep a message
 * briefly, hand it to the other person exactly once, and forget it.
 */

let clock = 1_000_000
const now = () => clock

function publish(store: MemoryStore, topic: string, from: string, msg: string) {
  return handleSignal(
    { method: 'POST', url: '/api/signal', body: JSON.stringify({ topic, from, msg }) },
    store,
    now,
  )
}

async function poll(
  store: MemoryStore,
  topics: string[],
  self: string,
): Promise<{ now: number; messages: SignalMessage[] }> {
  const res = await handleSignal(
    { method: 'GET', url: `/api/signal?topics=${topics.join(',')}&self=${self}` },
    store,
    now,
  )
  expect(res.status).toBe(200)
  return JSON.parse(res.body) as { now: number; messages: SignalMessage[] }
}

describe('the signalling relay', () => {
  it('hands one peer what another left for it', async () => {
    const store = new MemoryStore()
    await publish(store, 'room1', 'peer-a', 'my offer')

    const { messages } = await poll(store, ['room1'], 'peer-b')

    expect(messages).toMatchObject([{ topic: 'room1', msg: 'my offer' }])
  })

  it('never hands a peer its own announcement back', async () => {
    const store = new MemoryStore()
    await publish(store, 'room1', 'peer-a', 'my offer')

    // Trystero would read this as a second person in the room.
    expect((await poll(store, ['room1'], 'peer-a')).messages).toEqual([])
  })

  /**
   * The reason every message gets its own key. Two peers announcing in the same
   * millisecond used to be the classic way to lose one of them to a
   * read-modify-write, and a lost announcement is a peer that is never found.
   */
  it('keeps both of two announcements made at the same instant', async () => {
    const store = new MemoryStore()
    await Promise.all([
      publish(store, 'room1', 'peer-a', 'from A'),
      publish(store, 'room1', 'peer-b', 'from B'),
    ])

    const { messages } = await poll(store, ['room1'], 'peer-c')

    expect(messages.map((m) => m.msg).sort()).toEqual(['from A', 'from B'])
  })

  it('keeps repeated announcements from one peer rather than overwriting', async () => {
    const store = new MemoryStore()
    await publish(store, 'room1', 'peer-a', 'first')
    clock += 10
    await publish(store, 'room1', 'peer-a', 'second')

    const { messages } = await poll(store, ['room1'], 'peer-b')

    expect(messages.map((m) => m.msg)).toEqual(['first', 'second'])
  })

  it('delivers in the order they were sent, so an offer precedes its candidates', async () => {
    const store = new MemoryStore()
    await publish(store, 'room1', 'peer-a', 'offer')
    clock += 5
    await publish(store, 'room1', 'peer-a', 'candidate-1')
    clock += 5
    await publish(store, 'room1', 'peer-a', 'candidate-2')

    const { messages } = await poll(store, ['room1'], 'peer-b')

    expect(messages.map((m) => m.msg)).toEqual(['offer', 'candidate-1', 'candidate-2'])
  })

  /**
   * The bug this replaced a cursor to fix, stated as a test.
   *
   * A write is stamped when the request arrives and becomes visible a store
   * round trip later. A cursor-based poll landing in that gap saw nothing and
   * still advanced past the message, losing it for ever. Here the write lands
   * late — after a poll has already been answered — and must still be
   * delivered.
   */
  it('still delivers a message that became visible after a poll had answered', async () => {
    const store = new MemoryStore()
    const stampedAt = clock

    // A poll happens first and sees nothing, as it would mid-write.
    expect((await poll(store, ['room1'], 'peer-b')).messages).toEqual([])

    // The write lands, carrying its original timestamp — now in the past.
    clock += 300
    await store.put(`room1/peer-a/${stampedAt}-late`, 'the answer')

    clock += 900
    const { messages } = await poll(store, ['room1'], 'peer-b')
    expect(messages.map((m) => m.msg)).toEqual(['the answer'])
  })

  it('gives every message a stable id, so repeats can be told apart', async () => {
    const store = new MemoryStore()
    await publish(store, 'room1', 'peer-a', 'offer')

    const first = await poll(store, ['room1'], 'peer-b')
    clock += 1000
    const second = await poll(store, ['room1'], 'peer-b')

    expect(first.messages[0]!.id).toBeTruthy()
    // Replayed rather than withheld, and recognisable as the same message.
    expect(second.messages[0]!.id).toBe(first.messages[0]!.id)
  })

  it('stops replaying once a message is older than the window', async () => {
    const store = new MemoryStore()
    await publish(store, 'room1', 'peer-a', 'offer')
    expect((await poll(store, ['room1'], 'peer-b')).messages).toHaveLength(1)

    clock += REPLAY_WINDOW_MS + 1000
    expect((await poll(store, ['room1'], 'peer-b')).messages).toEqual([])
  })

  it('answers about several topics in one request', async () => {
    const store = new MemoryStore()
    await publish(store, 'room1', 'peer-a', 'to the room')
    await publish(store, 'peer-b-topic', 'peer-a', 'just for you')

    const { messages } = await poll(store, ['room1', 'peer-b-topic'], 'peer-b')

    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.topic).sort()).toEqual(['peer-b-topic', 'room1'])
  })

  it('forgets messages nobody came back for', async () => {
    const store = new MemoryStore()
    await publish(store, 'room1', 'peer-a', 'stale offer')
    expect(store.size).toBe(1)

    clock += MESSAGE_TTL_MS + 1000
    const { messages } = await poll(store, ['room1'], 'peer-b')

    expect(messages).toEqual([])
    // And swept, so a busy room does not accumulate for ever.
    expect(store.size).toBe(0)
  })
})

describe('what the relay refuses', () => {
  const store = new MemoryStore()

  it('rejects a body that is not JSON', async () => {
    const res = await handleSignal({ method: 'POST', url: '/api/signal', body: 'nope' }, store, now)
    expect(res.status).toBe(400)
  })

  it('rejects a topic that is not one of ours', async () => {
    // Anything that could reach outside its own key space.
    for (const topic of ['../etc', 'a/b', '', 'x'.repeat(200)]) {
      const res = await handleSignal(
        { method: 'POST', url: '/api/signal', body: JSON.stringify({ topic, from: 'a', msg: 'x' }) },
        store,
        now,
      )
      expect(res.status, topic).toBe(400)
    }
  })

  it('rejects a sender id that is not one of ours', async () => {
    const res = await handleSignal(
      { method: 'POST', url: '/api/signal', body: JSON.stringify({ topic: 'r', from: 'a/b', msg: 'x' }) },
      store,
      now,
    )
    expect(res.status).toBe(400)
  })

  it('refuses a message far larger than any offer', async () => {
    const res = await handleSignal(
      {
        method: 'POST',
        url: '/api/signal',
        body: JSON.stringify({ topic: 'r', from: 'a', msg: 'x'.repeat(70_000) }),
      },
      store,
      now,
    )
    expect(res.status).toBe(413)
  })

  it('caps how many topics one poll may ask about', async () => {
    const res = await handleSignal(
      { method: 'GET', url: `/api/signal?topics=${Array(20).fill('t').join(',')}` },
      store,
      now,
    )
    expect(res.status).toBe(400)
  })

  it('never caches, because a cached answer is a wrong answer', async () => {
    const res = await handleSignal({ method: 'GET', url: '/api/signal?topics=r' }, store, now)
    expect(res.headers['Cache-Control']).toBe('no-store')
  })
})

describe('message keys', () => {
  it('round-trips the parts a reader needs without opening the value', () => {
    expect(parseKey('room1/peer-a/1234-abcd')).toEqual({
      topic: 'room1',
      from: 'peer-a',
      at: 1234,
    })
  })

  it('rejects a key it did not write', () => {
    expect(parseKey('nonsense')).toBeNull()
    expect(parseKey('a/b/not-a-number')).toBeNull()
  })
})
