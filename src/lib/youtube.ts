/**
 * YouTube link handling.
 *
 * YouTube cannot be played in a <video> element — the bytes are not fetchable
 * and the terms of service are unambiguous about it. The only sanctioned way to
 * play a YouTube video on another page is YouTube's own iframe embed, driven by
 * the IFrame Player API. So a YouTube MediaRef carries a video id rather than a
 * media URL, and the player layer swaps the <video> element for an embed.
 *
 * Everything in this file is pure string work: no network, no API key.
 */

/** Video ids are 11 characters of base64url. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

/** Path shapes that carry the id as the last segment. */
const PATH_PREFIXES = ['/embed/', '/shorts/', '/live/', '/v/']

export type YouTubeParse =
  | { ok: true; videoId: string; startAt: number }
  | { ok: false; error: string }

export function isYouTubeHost(hostname: string): boolean {
  return HOSTS.has(hostname.toLowerCase())
}

/**
 * Pulls the video id out of any of the shapes YouTube's own Share menu, address
 * bar and mobile app hand out, plus a bare id.
 */
export function parseYouTubeUrl(url: URL): YouTubeParse {
  const path = url.pathname
  const startAt = parseStartSeconds(url)

  // /watch?v=<id> — also the shape music.youtube.com uses.
  const v = url.searchParams.get('v')
  if (v) {
    if (!VIDEO_ID.test(v)) return { ok: false, error: BAD_ID }
    return { ok: true, videoId: v, startAt }
  }

  // A playlist or a channel is not one video, and guessing which video the
  // person meant is worse than saying so.
  if (path === '/playlist' || path.startsWith('/playlist/')) {
    return {
      ok: false,
      error: 'That is a playlist link. Open the video itself and copy its link.',
    }
  }
  if (path === '/' || path === '') {
    return {
      ok: false,
      error: "That link has no video in it. Open the video and use YouTube's Share button.",
    }
  }

  for (const prefix of PATH_PREFIXES) {
    if (path.startsWith(prefix)) {
      const id = path.slice(prefix.length).split('/')[0] ?? ''
      if (!VIDEO_ID.test(id)) return { ok: false, error: BAD_ID }
      return { ok: true, videoId: id, startAt }
    }
  }

  // youtu.be/<id>
  const host = url.hostname.toLowerCase()
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = path.slice(1).split('/')[0] ?? ''
    if (!VIDEO_ID.test(id)) return { ok: false, error: BAD_ID }
    return { ok: true, videoId: id, startAt }
  }

  // /@channel, /c/name, /user/name and friends.
  return {
    ok: false,
    error: 'That looks like a channel or search link, not a video.',
  }
}

const BAD_ID = "Couldn't find a video id in that YouTube link."

/** A bare 11-character id, as pasted from a URL by hand. */
export function isBareVideoId(input: string): boolean {
  return VIDEO_ID.test(input)
}

/**
 * `t=90`, `t=1m30s`, `t=90s` and `start=90` all appear in links copied from
 * YouTube's "Share → Start at" checkbox and from the mobile app.
 */
export function parseStartSeconds(url: URL): number {
  const raw = url.searchParams.get('t') ?? url.searchParams.get('start')
  if (!raw) return 0
  return parseTimeToken(raw)
}

export function parseTimeToken(raw: string): number {
  const plain = Number(raw)
  if (Number.isFinite(plain) && plain >= 0) return Math.floor(plain)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw.trim())
  if (!m || (!m[1] && !m[2] && !m[3])) return 0
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

/** The canonical page, for display and for "open on YouTube" links. */
export function youtubeWatchUrl(videoId: string, startAt = 0): string {
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  return startAt > 0 ? `${base}&t=${Math.floor(startAt)}` : base
}

export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
}

/**
 * Player error codes, from the IFrame API reference. 101 and 150 are the same
 * refusal reported two different ways, and they are the common one: plenty of
 * music and TV clips are watchable on youtube.com but blocked everywhere else.
 */
export function describeYouTubeError(code: number | undefined): string {
  switch (code) {
    case 2:
      return 'YouTube rejected that video id. Paste the link again.'
    case 5:
      return 'YouTube could not play this video in this browser. Try reloading the page.'
    case 100:
      return 'That video is gone — it has been removed, or it is private.'
    case 101:
    case 150:
      return 'The owner does not allow this video to be played outside YouTube, so it cannot be watched in the room. Anything on YouTube with a working Share → Embed option will work.'
    default:
      return 'YouTube could not play this video.'
  }
}

/**
 * The oEmbed endpoint is public, needs no key, and sends CORS headers — so we
 * can put the real title on the "now playing" line instead of "YouTube video".
 * Purely cosmetic: every caller treats a failure as "no title".
 */
export async function fetchYouTubeTitle(
  videoId: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  if (!doFetch) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000)
  try {
    const res = await doFetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
        youtubeWatchUrl(videoId),
      )}`,
      { signal: controller.signal },
    )
    if (!res.ok) return null
    const body: unknown = await res.json()
    const title = (body as { title?: unknown } | null)?.title
    return typeof title === 'string' && title.trim() ? title.trim() : null
  } catch {
    // Offline, blocked, aborted, or not JSON. The title is a nicety.
    return null
  } finally {
    clearTimeout(timer)
  }
}
