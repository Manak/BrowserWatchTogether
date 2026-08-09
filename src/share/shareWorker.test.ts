import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHARE_PATH } from './session'

/**
 * The service worker is shipped as-is from `public/`, so it is never imported,
 * bundled or typechecked — which makes it the one piece of this feature that
 * could rot silently. Two things are worth pinning down:
 *
 *  1. It and the page agree on the URL shape. A mismatch would mean the worker
 *     ignores our requests and the video element quietly 404s against the real
 *     server, which looks exactly like a broken file.
 *  2. Its range arithmetic. Every seek in a shared film goes through it, and an
 *     off-by-one in a Content-Range is the kind of bug that shows up as one
 *     browser refusing to play and no error anywhere.
 *
 * So the shipped source is read and the function under test lifted straight out
 * of it. Renaming it fails these tests rather than skipping them.
 */
const source = readFileSync(join(process.cwd(), 'public/share-sw.js'), 'utf8')

function lift<T>(name: string): T {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} is missing from public/share-sw.js`).toBeGreaterThan(-1)
  // Functions in this file are top-level, so the first line-initial `}` after
  // the declaration closes it.
  const end = source.indexOf('\n}', start)
  const body = source.slice(start, end + 2)
  return new Function(`${body}; return ${name}`)() as T
}

type Range = { start: number; end: number } | 'unsatisfiable' | null
const parseRange = lift<(header: string | null, size: number) => Range>('parseRange')

describe('the share URL the page mints and the worker answers', () => {
  it('uses the same prefix on both sides', () => {
    expect(source).toContain(`const PREFIX = '${SHARE_PATH}'`)
  })

  it('is matched by the worker as a path segment', () => {
    // The worker's own test, applied to a URL of the shape session.ts builds.
    const url = new URL(`https://example.com/app/${SHARE_PATH}/abc?size=10&mime=video%2Fmp4`)
    expect(url.pathname.includes(`/${SHARE_PATH}/`)).toBe(true)
    expect(decodeURIComponent(url.pathname.split('/').pop()!)).toBe('abc')
  })
})

describe('worker range parsing', () => {
  it('reads an open-ended range as "from here to the end"', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('reads a closed range inclusively, as HTTP defines it', () => {
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
  })

  /**
   * The reason a mid-film join works at all: a plain MP4 often keeps its index
   * at the end of the file, and the browser asks for the tail first.
   */
  it('reads a suffix range, which is how a browser finds a moov atom', () => {
    expect(parseRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('clamps an end that runs past the file', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('rejects a start past the end of the file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=200-100', 1000)).toBe('unsatisfiable')
  })

  it('treats a missing or unparseable header as no range at all', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=abc', 1000)).toBeNull()
    expect(parseRange('items=0-10', 1000)).toBeNull()
  })

  it('seeks anywhere, not just forwards from the start', () => {
    // A peer arriving an hour into a two-hour film asks for the middle first.
    expect(parseRange('bytes=1073741824-', 2_147_483_648)).toEqual({
      start: 1_073_741_824,
      end: 2_147_483_647,
    })
  })
})
