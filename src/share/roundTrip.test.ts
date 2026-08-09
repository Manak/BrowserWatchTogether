import { describe, expect, it } from 'vitest'
import type { LocalShare } from '../lib/media'
import type { FileChannel, RangeRequest } from '../sync/transport'
import { downloadShare } from './download'
import { FileClient } from './fileClient'
import { FileHost, MAX_SERVED_BYTES } from './fileHost'

/**
 * Host and client tested against each other rather than against a stub.
 *
 * The two halves each do their own arithmetic on inclusive byte ranges, and an
 * off-by-one in either produces a file that is subtly wrong rather than
 * obviously broken — a video that plays and then stops, or a seek that lands a
 * frame out. Round-tripping real bytes is the only assertion that catches it.
 */

function wire(host: FileHost): FileChannel {
  return {
    async request(_target: string, req: RangeRequest): Promise<Uint8Array> {
      const bytes = await host.serve(req)
      if (!bytes) throw new Error('Refused.')
      return bytes
    },
    onRequest: () => {},
  }
}

function contents(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 7) % 251
  return bytes
}

function setUp(size: number): { share: LocalShare; client: FileClient; source: Uint8Array } {
  const source = contents(size)
  const host = new FileHost()
  const share = host.add(new File([source], 'film.mp4', { type: 'video/mp4' }), 'peer-a')
  return { share, client: new FileClient(wire(host)), source }
}

describe('bytes travelling from one browser to another', () => {
  it('delivers the exact range asked for', async () => {
    const { share, client, source } = setUp(50_000)

    const bytes = await client.fetchRange(share, 1234, 5678)

    expect(bytes.length).toBe(5678 - 1234 + 1)
    expect(bytes).toEqual(source.slice(1234, 5679))
  })

  it('delivers the last byte of the file, which nothing else would catch', async () => {
    const { share, client, source } = setUp(5000)

    const bytes = await client.fetchRange(share, 4999, 4999)

    expect(bytes).toEqual(source.slice(4999))
  })

  /**
   * The mid-film join. A peer arriving an hour in asks for the middle of the
   * file and nothing before it — which is the whole reason streaming beats
   * downloading, so it had better work without a single earlier byte.
   */
  it('serves the middle of a file that has never been read from the start', async () => {
    const { share, client, source } = setUp(1_000_000)

    const middle = await client.fetchRange(share, 500_000, 500_999)

    expect(middle).toEqual(source.slice(500_000, 501_000))
  })

  /** How a browser finds the index of a plain, non-faststart MP4. */
  it('serves the tail of the file', async () => {
    const { share, client, source } = setUp(1_000_000)

    const tail = await client.fetchRange(share, 999_000, 999_999)

    expect(tail).toEqual(source.slice(999_000))
  })

  it('reassembles a whole file identically, in the host-sized pieces it gives', async () => {
    const size = MAX_SERVED_BYTES * 2 + 1234
    const { share, client, source } = setUp(size)

    const blob = await downloadShare(client, share)

    expect(blob.size).toBe(size)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(source)
  })
})
