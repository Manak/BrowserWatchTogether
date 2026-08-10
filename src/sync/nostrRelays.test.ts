import { describe, expect, it } from 'vitest'
import { RELAYS_PER_ROOM, RELAY_URLS, hashRoomCode, relaysForRoom } from './nostrRelays'

describe('relaysForRoom', () => {
  it('gives two browsers in the same room the same relay', () => {
    // The whole point. Peers on different relays never find each other.
    expect(relaysForRoom('sunny-otter-42')).toEqual(relaysForRoom('sunny-otter-42'))
  })

  it('hands out four relays by default, so three can fail before a room does', () => {
    expect(relaysForRoom('sunny-otter-42')).toHaveLength(RELAYS_PER_ROOM)
    expect(RELAYS_PER_ROOM).toBe(4)
  })

  it('gives no room a relay twice', () => {
    // Four consecutive out of six wraps, and a room that listed a host twice
    // would be paying for a spare it does not have.
    for (const code of ['a-b-10', 'zesty-orchard-999', 'x', 'a'.repeat(64)]) {
      const chosen = relaysForRoom(code)
      expect(new Set(chosen).size).toBe(chosen.length)
    }
  })

  it('leaves a room connectable when all but one of its relays is bad', () => {
    // The property the number exists for. Two of the original six were silently
    // refusing our candidates; at one relay per room that made a sixth of all
    // room codes dead, and no room could route around it.
    const dead = new Set([RELAY_URLS[0], RELAY_URLS[1], RELAY_URLS[2]])
    for (let i = 0; i < 300; i++) {
      const chosen = relaysForRoom(`room-code-${i}`)
      expect(chosen.some((url) => !dead.has(url as never))).toBe(true)
    }
  })

  it('only ever returns relays from the pinned pool', () => {
    for (const code of ['a-b-10', 'zesty-orchard-999', 'x', 'a'.repeat(64)]) {
      for (const url of relaysForRoom(code, RELAY_URLS.length)) {
        expect(RELAY_URLS).toContain(url)
      }
    }
  })

  it('spreads rooms across the pool rather than favouring one', () => {
    const rooms = 1200
    const seen = new Map<string, number>()
    for (let i = 0; i < rooms; i++) {
      const [url] = relaysForRoom(`room-code-${i}`)
      seen.set(url as string, (seen.get(url as string) ?? 0) + 1)
    }
    // Every relay used, and none carrying a wildly disproportionate share.
    // Bounds are relative to the pool, so growing it does not silently turn this
    // into a test of nothing: loose enough not to assert the hash's exact
    // output, tight enough to catch one that has collapsed onto a bucket.
    const even = rooms / RELAY_URLS.length
    expect(seen.size).toBe(RELAY_URLS.length)
    for (const count of seen.values()) {
      expect(count).toBeGreaterThan(even * 0.4)
      expect(count).toBeLessThan(even * 1.8)
    }
  })

  it('leaves most of the pool out of any one room', () => {
    // The blast-radius half of the design: a room takes four, so a bad host is
    // on 40% of rooms rather than all of them. If this ever reaches the whole
    // pool, every room shares every relay again and one bad host is universal.
    expect(RELAYS_PER_ROOM / RELAY_URLS.length).toBeLessThanOrEqual(0.5)
  })

  it('takes consecutive relays when a room is given more than one', () => {
    const pair = relaysForRoom('sunny-otter-42', 2)
    const [primary] = relaysForRoom('sunny-otter-42')
    expect(pair[0]).toBe(primary)
    const next = (RELAY_URLS.indexOf(pair[0] as never) + 1) % RELAY_URLS.length
    expect(pair[1]).toBe(RELAY_URLS[next])
  })

  it('never asks for more relays than exist, or fewer than one', () => {
    expect(relaysForRoom('sunny-otter-42', 99)).toHaveLength(RELAY_URLS.length)
    expect(relaysForRoom('sunny-otter-42', 0)).toHaveLength(1)
    expect(relaysForRoom('sunny-otter-42', -3)).toHaveLength(1)
  })

  it('does not repeat a relay when a room takes the whole pool', () => {
    const all = relaysForRoom('sunny-otter-42', RELAY_URLS.length)
    expect(new Set(all).size).toBe(RELAY_URLS.length)
  })
})

describe('hashRoomCode', () => {
  it('is stable across calls, which is the only property rooms depend on', () => {
    expect(hashRoomCode('sunny-otter-42')).toBe(hashRoomCode('sunny-otter-42'))
  })

  it('separates codes that differ by a transposed character', () => {
    // The failure mode of a sum-of-character-codes hash, which is why this is
    // not one: these two are indistinguishable to it. Asserted on the hash
    // rather than on the relay, because with six buckets any two codes collide
    // one time in six and that is the design working, not failing.
    expect(hashRoomCode('sunny-otter-42')).not.toBe(hashRoomCode('sunny-otter-24'))
    expect(hashRoomCode('amber-comet-10')).not.toBe(hashRoomCode('amber-comet-01'))
  })

  it('stays an unsigned 32-bit integer', () => {
    for (const code of ['', 'a', 'sunny-otter-42', 'z'.repeat(200)]) {
      const h = hashRoomCode(code)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })
})
