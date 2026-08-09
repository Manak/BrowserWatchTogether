import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalShare } from '../lib/media'
import { FakeFileChannel } from '../testing/fakeFileChannel'
import { FileClient } from './fileClient'
import { ShareSession, SHARE_PATH } from './session'

/**
 * The bridge between the service worker and the page.
 *
 * The worker owns a URL and knows nothing else; the page owns the peer
 * connection and knows everything else. They meet over one MessagePort per
 * request, and that seam is entirely our code — the worker is tested from its
 * own source (shareWorker.test.ts), the transfer is tested against a real host
 * (roundTrip.test.ts), and this is the part in between.
 */

const share: LocalShare = {
  id: 'share-1',
  hostId: 'peer-a',
  size: 10_000,
  mime: 'video/mp4',
  name: 'holiday.mp4',
}

function source(): Uint8Array {
  const bytes = new Uint8Array(share.size)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  return bytes
}

/** Stands in for `navigator.serviceWorker`, which jsdom does not implement. */
class FakeServiceWorkerContainer extends EventTarget {
  controller: object | null = { scriptURL: 'share-sw.js' }
  register = vi.fn(async () => ({ scope: '/' }))
  ready = Promise.resolve({} as ServiceWorkerRegistration)
}

let container: FakeServiceWorkerContainer

beforeEach(() => {
  container = new FakeServiceWorkerContainer()
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker')
  vi.restoreAllMocks()
})

/** Ask, the way the worker asks: one channel, one question, one answer. */
function askForRange(
  start: number,
  end: number,
  shareId = share.id,
): Promise<{ ok?: boolean; bytes?: ArrayBuffer; error?: string }> {
  const channel = new MessageChannel()
  const answer = new Promise<{ ok?: boolean; bytes?: ArrayBuffer; error?: string }>(
    (resolve) => {
      channel.port1.onmessage = (e) => resolve(e.data)
    },
  )
  container.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'wt-range', shareId, start, end },
      // The worker transfers a port with each request; this is that port.
      ports: [channel.port2],
    }),
  )
  return answer
}

describe('ShareSession as the worker sees it', () => {
  it('answers a range with the bytes from the peer', async () => {
    const channel = new FakeFileChannel(source())
    const session = new ShareSession(new FileClient(channel))
    session.register(share)

    const reply = await askForRange(100, 199)

    expect(reply.ok).toBe(true)
    expect(new Uint8Array(reply.bytes!)).toEqual(source().slice(100, 200))
    expect(channel.seen).toEqual([
      { from: 'peer-a', shareId: 'share-1', start: 100, end: 199 },
    ])
    session.destroy()
  })

  it('refuses a share it has never been told about', async () => {
    const channel = new FakeFileChannel(source())
    const session = new ShareSession(new FileClient(channel))
    session.register(share)

    const reply = await askForRange(0, 99, 'someone-elses-film')

    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/not being shared here/i)
    // And nothing was asked of the peer on the strength of a stranger's id.
    expect(channel.seen).toHaveLength(0)
    session.destroy()
  })

  /**
   * The worker turns this into a 503 rather than a silent stall. Reporting the
   * failure is what lets the element error, which is what lets the fallback
   * take over.
   */
  it('reports a failure rather than leaving the worker waiting', async () => {
    const channel = new FakeFileChannel(source())
    channel.failures = 99
    const session = new ShareSession(
      new FileClient(channel, { retries: 0, delay: () => Promise.resolve() }),
    )
    session.register(share)

    const reply = await askForRange(0, 99)

    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/peer went away/i)
    session.destroy()
  })

  it('ignores messages that are not ours', async () => {
    const channel = new FakeFileChannel(source())
    const session = new ShareSession(new FileClient(channel))
    session.register(share)

    container.dispatchEvent(
      new MessageEvent('message', { data: { type: 'something-else' } }),
    )
    await Promise.resolve()

    expect(channel.seen).toHaveLength(0)
    session.destroy()
  })

  it('stops answering once the room is left', async () => {
    const channel = new FakeFileChannel(source())
    const session = new ShareSession(new FileClient(channel))
    session.register(share)
    session.destroy()

    const answered = await Promise.race([
      askForRange(0, 99),
      new Promise((resolve) => setTimeout(() => resolve('no answer'), 20)),
    ])

    expect(answered).toBe('no answer')
    expect(channel.seen).toHaveLength(0)
  })
})

describe('the URL handed to the video element', () => {
  it('carries everything the worker needs to answer the first request', () => {
    const session = new ShareSession(new FileClient(new FakeFileChannel(source())))

    const url = new URL(session.streamUrl(share))

    expect(url.pathname).toContain(`/${SHARE_PATH}/share-1`)
    // Size and type ride along so the worker needs no round trip of its own.
    expect(url.searchParams.get('size')).toBe('10000')
    expect(url.searchParams.get('mime')).toBe('video/mp4')
    session.destroy()
  })

  it('escapes a share id rather than letting it shape the path', () => {
    const session = new ShareSession(new FileClient(new FakeFileChannel(source())))
    const url = new URL(session.streamUrl({ ...share, id: 'a/../b?x=1' }))

    expect(url.pathname.endsWith('/a%2F..%2Fb%3Fx%3D1')).toBe(true)
    expect(url.searchParams.get('x')).toBeNull()
    session.destroy()
  })
})

describe('choosing between streaming and downloading', () => {
  it('streams when a worker is installed and controlling the page', async () => {
    const session = new ShareSession(new FileClient(new FakeFileChannel(source())), {
      installWorker: () => Promise.resolve(true),
    })
    await expect(session.streamingAvailable()).resolves.toBe(true)
    session.destroy()
  })

  it('does not stream when there is no worker to answer', async () => {
    const session = new ShareSession(new FileClient(new FakeFileChannel(source())), {
      installWorker: () => Promise.resolve(false),
    })
    await expect(session.streamingAvailable()).resolves.toBe(false)
    session.destroy()
  })

  it('treats a registration that throws as "cannot stream", not as a crash', async () => {
    const session = new ShareSession(new FileClient(new FakeFileChannel(source())), {
      installWorker: () => Promise.reject(new Error('blocked by policy')),
    })
    await expect(session.streamingAvailable()).resolves.toBe(false)
    session.destroy()
  })

  it('decides once, however many times it is asked', async () => {
    const installWorker = vi.fn(() => Promise.resolve(true))
    const session = new ShareSession(new FileClient(new FakeFileChannel(source())), {
      installWorker,
    })

    await Promise.all([
      session.streamingAvailable(),
      session.streamingAvailable(),
      session.streamingAvailable(),
    ])

    expect(installWorker).toHaveBeenCalledTimes(1)
    session.destroy()
  })

  it('falls back to a blob of the whole file', async () => {
    const channel = new FakeFileChannel(source())
    channel.maxSpan = 2500
    const session = new ShareSession(new FileClient(channel))
    const created = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:fake')

    const url = await session.downloadUrl(share)

    expect(url).toBe('blob:fake')
    const blob = created.mock.calls[0]![0] as Blob
    expect(blob.size).toBe(share.size)
    expect(blob.type).toBe('video/mp4')
    session.destroy()
  })
})
