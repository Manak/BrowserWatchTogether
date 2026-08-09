import { describe, expect, it, vi } from 'vitest'
import type { LocalShare } from '../lib/media'
import { FakeFileChannel } from '../testing/fakeFileChannel'
import { downloadShare } from './download'
import { FileClient } from './fileClient'

const SIZE = 10_000
const share: LocalShare = {
  id: 'share-1',
  hostId: 'peer-a',
  size: SIZE,
  mime: 'video/mp4',
  name: 'film.mp4',
}

function source(): Uint8Array {
  const out = new Uint8Array(SIZE)
  for (let i = 0; i < SIZE; i++) out[i] = i % 251
  return out
}

describe('downloadShare', () => {
  it('reassembles the whole file out of the short replies a host gives', async () => {
    const channel = new FakeFileChannel(source())
    // Far smaller than the client asks for, which is the point: the loop has to
    // keep going until it has everything, not until it has had one answer.
    channel.maxSpan = 1000
    const blob = await downloadShare(new FileClient(channel), share)

    expect(blob.size).toBe(SIZE)
    expect(blob.type).toBe('video/mp4')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(source())
    expect(channel.seen).toHaveLength(10)
  })

  it('reports progress that ends at exactly one', async () => {
    const channel = new FakeFileChannel(source())
    channel.maxSpan = 2500
    const onProgress = vi.fn()

    await downloadShare(new FileClient(channel), share, { onProgress })

    const reported = onProgress.mock.calls.map((c) => c[0] as number)
    expect(reported).toEqual([0.25, 0.5, 0.75, 1])
  })

  it('stops when the caller aborts, rather than fetching a whole film', async () => {
    const channel = new FakeFileChannel(source())
    channel.maxSpan = 1000
    const abort = new AbortController()

    const promise = downloadShare(new FileClient(channel), share, {
      signal: abort.signal,
      onProgress: () => abort.abort(),
    })

    await expect(promise).rejects.toThrow()
    expect(channel.seen.length).toBeLessThan(10)
  })
})
