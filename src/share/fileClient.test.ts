import { describe, expect, it, vi } from 'vitest'
import type { LocalShare } from '../lib/media'
import { FakeFileChannel } from '../testing/fakeFileChannel'
import type { FileChannel } from '../sync/transport'
import { FileClient } from './fileClient'

const SIZE = 4096
const share: LocalShare = {
  id: 'share-1',
  hostId: 'peer-a',
  size: SIZE,
  mime: 'video/mp4',
  name: 'film.mp4',
}

function bytes(size = SIZE): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = i % 251
  return out
}

/** No real waiting: retry timing is asserted by counting, not by clock. */
const noDelay = () => Promise.resolve()

describe('FileClient', () => {
  it('asks the peer that holds the file for the range it was given', async () => {
    const channel = new FakeFileChannel(bytes())
    const got = await new FileClient(channel).fetchRange(share, 100, 199)

    expect(channel.seen).toEqual([
      { from: 'peer-a', shareId: 'share-1', start: 100, end: 199 },
    ])
    expect(got.length).toBe(100)
    expect(got[0]).toBe(100)
  })

  it('never asks past the end of the file, whatever it is told', async () => {
    const channel = new FakeFileChannel(bytes())
    await new FileClient(channel).fetchRange(share, SIZE - 10, SIZE + 5000)

    expect(channel.seen[0]!.end).toBe(SIZE - 1)
  })

  it('retries a dropped request rather than failing the film', async () => {
    const channel = new FakeFileChannel(bytes())
    channel.failures = 2
    const client = new FileClient(channel, { delay: noDelay })

    const got = await client.fetchRange(share, 0, 99)

    expect(channel.seen).toHaveLength(3)
    expect(got.length).toBe(100)
  })

  it('gives up with a usable message once retries run out', async () => {
    const channel = new FakeFileChannel(bytes())
    channel.failures = 99
    const client = new FileClient(channel, { retries: 2, delay: noDelay })

    await expect(client.fetchRange(share, 0, 99)).rejects.toThrow(/peer went away/i)
    expect(channel.seen).toHaveLength(3)
  })

  it('treats an empty reply as a refusal, not as an empty video', async () => {
    const channel: FileChannel = {
      request: async () => new Uint8Array(0),
      onRequest: () => {},
    }
    const client = new FileClient(channel, { retries: 0, delay: noDelay })

    await expect(client.fetchRange(share, 0, 99)).rejects.toThrow()
  })

  it('refuses a range that starts outside the file', async () => {
    const client = new FileClient(new FakeFileChannel(bytes()))
    await expect(client.fetchRange(share, SIZE, SIZE + 10)).rejects.toBeInstanceOf(
      RangeError,
    )
  })

  it('holds back requests so bulk bytes cannot crowd out the sync messages', async () => {
    const channel = new FakeFileChannel(bytes())
    const client = new FileClient(channel, { concurrency: 2 })

    await Promise.all(
      Array.from({ length: 8 }, (_, i) => client.fetchRange(share, i * 100, i * 100 + 99)),
    )

    expect(channel.seen).toHaveLength(8)
    expect(channel.peak).toBeLessThanOrEqual(2)
  })

  it('stops retrying once the caller has aborted', async () => {
    const channel = new FakeFileChannel(bytes())
    channel.failures = 99
    const abort = new AbortController()
    const client = new FileClient(channel, {
      delay: async () => {
        abort.abort()
      },
    })

    await expect(
      client.fetchRange(share, 0, 99, abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.seen).toHaveLength(1)
  })

  it('passes the abort signal on to the transport', async () => {
    const request = vi.fn(async () => bytes(10))
    const client = new FileClient({ request, onRequest: () => {} })
    const abort = new AbortController()

    await client.fetchRange(share, 0, 9, abort.signal)

    expect(request).toHaveBeenCalledWith(
      'peer-a',
      { shareId: 'share-1', start: 0, end: 9 },
      abort.signal,
    )
  })
})
