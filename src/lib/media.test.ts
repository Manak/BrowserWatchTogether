import { describe, expect, it, vi } from 'vitest'
import {
  buildMediaRef,
  checkDriveIsPublic,
  describeMediaError,
  driveDirectUrl,
  driveThumbnailUrl,
  hasEmbeddedCredential,
  parseMediaLink,
} from './media'

const ID = '1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUv'

describe('parseMediaLink', () => {
  it.each([
    `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${ID}/view?usp=drive_link`,
    `https://drive.google.com/file/d/${ID}/preview`,
    `https://docs.google.com/file/d/${ID}/edit`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/uc?export=download&id=${ID}`,
    `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
    ` https://drive.google.com/file/d/${ID}/view \n`,
    ID,
  ])('extracts the file id from %s', (link) => {
    const r = parseMediaLink(link)
    expect(r).toEqual({ ok: true, kind: 'drive', fileId: ID })
  })

  it('rejects an empty string', () => {
    expect(parseMediaLink('   ')).toMatchObject({ ok: false })
  })

  it('rejects folder links with a specific message', () => {
    const r = parseMediaLink(`https://drive.google.com/drive/folders/${ID}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/folder/i)
  })

  it('rejects a Drive link with no file id', () => {
    const r = parseMediaLink('https://drive.google.com/drive/my-drive')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/file id/i)
  })

  it('rejects non-URL junk', () => {
    const r = parseMediaLink('just some words')
    expect(r.ok).toBe(false)
  })

  it('rejects non-http protocols', () => {
    expect(parseMediaLink('ftp://example.com/a.mp4')).toMatchObject({ ok: false })
  })

  it('accepts a plain direct media URL as an escape hatch', () => {
    const r = parseMediaLink('https://example.com/media/movie.mp4')
    expect(r).toEqual({
      ok: true,
      kind: 'direct',
      url: 'https://example.com/media/movie.mp4',
    })
  })
})

const PUTIO_MP4 =
  'https://api.put.io/v2/files/1603908054/mp4/download/Show.S04E01.1080p.mkv?oauth_token=SECRET123'
const PUTIO_RAW =
  'https://api.put.io/v2/files/1603908054/download/Show.S04E01.1080p.mkv?oauth_token=SECRET123'

describe('put.io links', () => {
  it('keeps an already-converted mp4 link as-is', () => {
    const r = parseMediaLink(PUTIO_MP4)
    expect(r).toMatchObject({ ok: true, kind: 'putio', converted: true })
    if (r.ok && r.kind === 'putio') expect(r.url).toBe(PUTIO_MP4)
  })

  it('rewrites a raw download link to the browser-playable mp4', () => {
    const r = parseMediaLink(PUTIO_RAW)
    expect(r).toMatchObject({ ok: true, kind: 'putio', converted: false })
    if (r.ok && r.kind === 'putio') {
      expect(r.url).toContain('/files/1603908054/mp4/download/')
      // The token must survive the rewrite or the link stops working.
      expect(r.url).toContain('oauth_token=SECRET123')
    }
  })

  it('keeps the filename and query intact when rewriting', () => {
    const r = parseMediaLink(PUTIO_RAW)
    if (r.ok && r.kind === 'putio') {
      expect(r.url).toContain('Show.S04E01.1080p.mkv')
    }
  })

  it('handles put.io links without an api subdomain', () => {
    const r = parseMediaLink('https://put.io/v2/files/42/download/a.mkv')
    expect(r).toMatchObject({ ok: true, kind: 'putio', converted: false })
  })

  it('rejects a put.io URL that is not a download link', () => {
    const r = parseMediaLink('https://app.put.io/files/1603908054')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/download link/i)
  })

  it('builds a put.io ref that plays the converted url', () => {
    const parsed = parseMediaLink(PUTIO_RAW)
    if (!parsed.ok) throw new Error('expected ok')
    const ref = buildMediaRef(parsed, { setBy: 'Ada', setAt: 0 })
    expect(ref.kind).toBe('putio')
    expect(ref.url).toContain('/mp4/download/')
    expect(ref.title).toBe('Show.S04E01.1080p.mkv')
  })

  it('explains a put.io failure in put.io terms', () => {
    const msg = describeMediaError(4, 'putio')
    expect(msg).toMatch(/put\.io/)
    expect(msg).not.toMatch(/Anyone with the link/)
  })
})

describe('hasEmbeddedCredential', () => {
  it('flags put.io oauth tokens', () => {
    expect(hasEmbeddedCredential(PUTIO_MP4)).toBe(true)
  })

  it.each(['access_token', 'api_key', 'token', 'auth', 'key'])(
    'flags a %s parameter',
    (param) => {
      expect(hasEmbeddedCredential(`https://x.dev/a.mp4?${param}=abc`)).toBe(true)
    },
  )

  it('does not flag ordinary links', () => {
    expect(hasEmbeddedCredential('https://example.com/movie.mp4')).toBe(false)
    expect(hasEmbeddedCredential(`https://drive.google.com/file/d/${ID}/view`)).toBe(
      false,
    )
  })

  it('does not flag opaque signature parameters that are not credentials', () => {
    expect(hasEmbeddedCredential('https://cdn.example.com/a.mp4?u=abc123')).toBe(false)
  })

  it('is safe on junk input', () => {
    expect(hasEmbeddedCredential('not a url')).toBe(false)
  })
})

describe('url builders', () => {
  it('uses the usercontent download endpoint with confirm=t', () => {
    const u = driveDirectUrl(ID)
    expect(u).toContain('drive.usercontent.google.com/download')
    expect(u).toContain(`id=${ID}`)
    expect(u).toContain('confirm=t')
  })

  it('builds a thumbnail url at the requested width', () => {
    expect(driveThumbnailUrl(ID, 120)).toBe(
      `https://drive.google.com/thumbnail?id=${ID}&sz=w120`,
    )
  })
})

describe('buildMediaRef', () => {
  it('builds a drive ref with a default title', () => {
    const ref = buildMediaRef(
      { ok: true, kind: 'drive', fileId: ID },
      { setBy: 'Ada', setAt: 10 },
    )
    expect(ref).toMatchObject({ kind: 'drive', fileId: ID, setBy: 'Ada', setAt: 10 })
    expect(ref.url).toBe(driveDirectUrl(ID))
    expect(ref.title).toBe('Google Drive video')
  })

  it('derives a title from the filename of a direct url', () => {
    const ref = buildMediaRef(
      { ok: true, kind: 'direct', url: 'https://example.com/a/My%20Movie.mp4' },
      { setBy: 'Ada', setAt: 0 },
    )
    expect(ref.title).toBe('My Movie.mp4')
    expect(ref.fileId).toBeNull()
  })

  it('prefers an explicit title', () => {
    const ref = buildMediaRef(
      { ok: true, kind: 'drive', fileId: ID },
      { setBy: 'Ada', setAt: 0, title: '  Our film  ' },
    )
    expect(ref.title).toBe('Our film')
  })
})

/** Minimal stand-in for HTMLImageElement that we can fire events on. */
function fakeImage() {
  const img = {
    onload: null as null | (() => void),
    onerror: null as null | (() => void),
    referrerPolicy: '',
    src: '',
  }
  return img as unknown as HTMLImageElement & typeof img
}

describe('checkDriveIsPublic', () => {
  it('reports public when the thumbnail loads', async () => {
    const img = fakeImage()
    const p = checkDriveIsPublic(ID, { makeImage: () => img })
    img.onload?.()
    await expect(p).resolves.toEqual({ status: 'public' })
  })

  it('reports not-public when the thumbnail errors', async () => {
    const img = fakeImage()
    const p = checkDriveIsPublic(ID, { makeImage: () => img })
    img.onerror?.()
    await expect(p).resolves.toEqual({ status: 'not-public' })
  })

  it('reports unknown when the probe times out', async () => {
    vi.useFakeTimers()
    const img = fakeImage()
    const p = checkDriveIsPublic(ID, { makeImage: () => img, timeoutMs: 100 })
    vi.advanceTimersByTime(101)
    await expect(p).resolves.toEqual({ status: 'unknown' })
    vi.useRealTimers()
  })

  it('requests the thumbnail endpoint', async () => {
    const img = fakeImage()
    const p = checkDriveIsPublic(ID, { makeImage: () => img })
    expect(img.src).toContain('drive.google.com/thumbnail')
    img.onload?.()
    await p
  })
})

describe('describeMediaError', () => {
  it('points at sharing settings for unsupported drive sources', () => {
    expect(describeMediaError(4, 'drive')).toMatch(/Anyone with the link/)
  })

  it('does not mention Drive sharing for direct links', () => {
    expect(describeMediaError(4, 'direct')).not.toMatch(/Anyone with the link/)
  })

  it('explains decode failures as a codec problem', () => {
    expect(describeMediaError(3, 'drive')).toMatch(/H\.264/)
  })

  it('has a fallback for unknown codes', () => {
    expect(describeMediaError(undefined, 'drive')).toMatch(/Could not load/)
  })
})
