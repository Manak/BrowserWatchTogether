import { describe, expect, it } from 'vitest'
import { parseMediaLink, buildMediaRef } from './media'
import {
  describeYouTubeError,
  fetchYouTubeTitle,
  parseTimeToken,
  youtubeWatchUrl,
} from './youtube'

const ID = 'dQw4w9WgXcQ'

/** Every shape YouTube's own Share menu, address bar and apps hand out. */
const SHAPES: [label: string, link: string][] = [
  ['watch page', `https://www.youtube.com/watch?v=${ID}`],
  ['watch page without www', `https://youtube.com/watch?v=${ID}`],
  ['mobile', `https://m.youtube.com/watch?v=${ID}`],
  ['music', `https://music.youtube.com/watch?v=${ID}`],
  ['short link', `https://youtu.be/${ID}`],
  ['short link with query', `https://youtu.be/${ID}?si=abcdef`],
  ['embed', `https://www.youtube.com/embed/${ID}`],
  ['nocookie embed', `https://www.youtube-nocookie.com/embed/${ID}`],
  ['shorts', `https://www.youtube.com/shorts/${ID}`],
  ['live', `https://www.youtube.com/live/${ID}`],
  ['old /v/', `https://www.youtube.com/v/${ID}`],
  ['bare id', ID],
  ['watch page inside a playlist', `https://www.youtube.com/watch?v=${ID}&list=PL123&index=4`],
]

describe('parsing YouTube links', () => {
  it.each(SHAPES)('reads the video id from a %s link', (_label, link) => {
    expect(parseMediaLink(link)).toMatchObject({ ok: true, kind: 'youtube', videoId: ID })
  })

  it('keeps the start time from a "share at current time" link', () => {
    expect(parseMediaLink(`https://youtu.be/${ID}?t=90`)).toMatchObject({
      startAt: 90,
    })
    expect(parseMediaLink(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)).toMatchObject({
      startAt: 90,
    })
    expect(parseMediaLink(`https://www.youtube.com/watch?v=${ID}&start=42`)).toMatchObject({
      startAt: 42,
    })
  })

  it('parses timestamp tokens, and shrugs off nonsense', () => {
    expect(parseTimeToken('1h2m3s')).toBe(3723)
    expect(parseTimeToken('45')).toBe(45)
    expect(parseTimeToken('45s')).toBe(45)
    expect(parseTimeToken('')).toBe(0)
    expect(parseTimeToken('later')).toBe(0)
    expect(parseTimeToken('-30')).toBe(0)
  })

  it('says what is wrong with a playlist link instead of guessing', () => {
    const r = parseMediaLink('https://www.youtube.com/playlist?list=PL12345')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/playlist/i)
  })

  it('rejects a channel link', () => {
    const r = parseMediaLink('https://www.youtube.com/@somechannel')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/channel/i)
  })

  it('rejects a malformed video id rather than loading a dead embed', () => {
    const r = parseMediaLink('https://www.youtube.com/watch?v=tooshort')
    expect(r.ok).toBe(false)
  })

  /**
   * A Drive file id is 20 characters or more and a YouTube id is exactly 11,
   * so a bare id can always be told apart. Worth pinning: the two kinds load
   * through completely different players.
   */
  it('tells a bare YouTube id apart from a bare Drive id', () => {
    expect(parseMediaLink(ID)).toMatchObject({ kind: 'youtube' })
    expect(parseMediaLink('1a2b3c4d5e6f7g8h9i0jKLMNOP')).toMatchObject({ kind: 'drive' })
  })

  it('leaves other hosts alone', () => {
    expect(parseMediaLink('https://example.com/film.mp4')).toMatchObject({ kind: 'direct' })
  })
})

describe('buildMediaRef for YouTube', () => {
  it('carries the id and start time, and links back to the watch page', () => {
    const parsed = parseMediaLink(`https://youtu.be/${ID}?t=30`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const ref = buildMediaRef(parsed, { setBy: 'Ada', setAt: 5 })
    expect(ref).toMatchObject({
      kind: 'youtube',
      videoId: ID,
      startAt: 30,
      fileId: null,
      setBy: 'Ada',
    })
    expect(ref.url).toBe(youtubeWatchUrl(ID, 30))
  })

  it('falls back to a usable title when none is given or fetched', () => {
    const parsed = parseMediaLink(ID)
    if (!parsed.ok) throw new Error('unreachable')
    expect(buildMediaRef(parsed, { setBy: 'Ada', setAt: 0 }).title).toBe('YouTube video')
    expect(
      buildMediaRef(parsed, { title: 'Movie night', setBy: 'Ada', setAt: 0 }).title,
    ).toBe('Movie night')
  })
})

describe('player errors', () => {
  /**
   * 101 and 150 are the same refusal reported two ways, and they are the one
   * people actually hit: a video that plays on youtube.com and nowhere else.
   */
  it('explains an embedding refusal in terms of what to do next', () => {
    for (const code of [101, 150]) {
      expect(describeYouTubeError(code)).toMatch(/does not allow/i)
    }
  })

  it('distinguishes a removed video from a broken one', () => {
    expect(describeYouTubeError(100)).toMatch(/removed|private/i)
    expect(describeYouTubeError(5)).not.toMatch(/removed/i)
    expect(describeYouTubeError(undefined)).toBeTruthy()
  })
})

describe('fetching the title', () => {
  it('reads the title out of an oEmbed response', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ title: 'Some film' }),
    })) as unknown as typeof fetch
    expect(await fetchYouTubeTitle(ID, { fetchImpl })).toBe('Some film')
  })

  /** Cosmetic only: a failure must never stop the video from loading. */
  it('returns null rather than throwing when the endpoint is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await fetchYouTubeTitle(ID, { fetchImpl })).toBeNull()
  })

  it('returns null on a non-OK response or an empty title', async () => {
    const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await fetchYouTubeTitle(ID, { fetchImpl: notOk })).toBeNull()

    const blank = (async () => ({
      ok: true,
      json: async () => ({ title: '   ' }),
    })) as unknown as typeof fetch
    expect(await fetchYouTubeTitle(ID, { fetchImpl: blank })).toBeNull()
  })
})
