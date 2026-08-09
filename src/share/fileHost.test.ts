import { describe, expect, it } from 'vitest'
import { FileHost, MAX_SERVED_BYTES } from './fileHost'

function makeFile(size: number, name = 'film.mp4'): File {
  // Byte i is i mod 251, so any slice is identifiable by its contents alone.
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  return new File([bytes], name, { type: 'video/mp4' })
}

describe('FileHost', () => {
  it('describes a share by what peers need to ask for it', () => {
    const host = new FileHost()
    const share = host.add(makeFile(2048), 'peer-a', () => 'share-1')
    expect(share).toEqual({
      id: 'share-1',
      hostId: 'peer-a',
      size: 2048,
      mime: 'video/mp4',
      name: 'film.mp4',
    })
  })

  it('serves exactly the requested range, end inclusive', async () => {
    const host = new FileHost()
    const share = host.add(makeFile(1000), 'peer-a')

    const bytes = await host.serve({ shareId: share.id, start: 10, end: 19 })

    expect(bytes).not.toBeNull()
    expect(bytes!.length).toBe(10)
    expect([...bytes!]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it('caps a reply, so "give me the whole film" cannot be honoured literally', async () => {
    const size = MAX_SERVED_BYTES * 2
    const host = new FileHost()
    const share = host.add(makeFile(size), 'peer-a')

    const bytes = await host.serve({ shareId: share.id, start: 0, end: size - 1 })

    expect(bytes!.length).toBe(MAX_SERVED_BYTES)
  })

  it('clamps a range that runs off the end of the file', async () => {
    const host = new FileHost()
    const share = host.add(makeFile(100), 'peer-a')

    const bytes = await host.serve({ shareId: share.id, start: 90, end: 500 })

    expect(bytes!.length).toBe(10)
  })

  it('refuses a share it does not have', async () => {
    const host = new FileHost()
    host.add(makeFile(100), 'peer-a')
    expect(await host.serve({ shareId: 'someone-elses', start: 0, end: 10 })).toBeNull()
  })

  it('refuses a start beyond the end of the file', async () => {
    const host = new FileHost()
    const share = host.add(makeFile(100), 'peer-a')
    expect(await host.serve({ shareId: share.id, start: 100, end: 200 })).toBeNull()
  })

  it('stops serving once the room is left', async () => {
    const host = new FileHost()
    const share = host.add(makeFile(100), 'peer-a')
    host.clear()
    expect(host.has(share.id)).toBe(false)
    expect(await host.serve({ shareId: share.id, start: 0, end: 10 })).toBeNull()
  })
})
