/**
 * Google Drive link handling — deliberately API-free.
 *
 * We never touch the Drive REST API (no API key, no OAuth, no quota project).
 * Everything here is pure string work plus two unauthenticated probes that any
 * browser can make against a *publicly shared* file:
 *
 *   1. the thumbnail endpoint  (cheap "is this shared with anyone-with-the-link?")
 *   2. the direct download endpoint (fed straight into <video src>)
 *
 * The direct download endpoint supports HTTP Range requests, which is what makes
 * seeking work in a plain <video> element.
 */

import {
  isBareVideoId,
  isYouTubeHost,
  parseYouTubeUrl,
  youtubeWatchUrl,
} from './youtube'

export type MediaKind = 'drive' | 'putio' | 'direct' | 'youtube' | 'local'

/**
 * A file that exists only on one person's disk.
 *
 * There is nowhere to upload it to — the app has no backend — so the browser
 * holding the file serves byte ranges to the others over the same peer
 * connections everything else uses. This descriptor is what travels; the bytes
 * are fetched on demand. See `src/share/`.
 */
export interface LocalShare {
  /** Unique per share, so two files in one evening cannot be confused. */
  id: string
  /** Peer id of the browser holding the file. It must stay in the room. */
  hostId: string
  size: number
  /** As reported by the file input; may be empty for an unknown extension. */
  mime: string
  name: string
}

export interface MediaRef {
  kind: MediaKind
  /** Drive file id, or null for a plain direct URL. */
  fileId: string | null
  /**
   * URL actually handed to <video src>. For YouTube this is the watch page —
   * nothing loads it as media, it is what the "open on YouTube" link points at.
   * Empty for a local share: each browser builds its own URL for those.
   */
  url: string
  /** Human label shown in the UI. */
  title: string
  /** Display name of whoever set it. */
  setBy: string
  /** Wall clock of the setter, for display only. */
  setAt: number
  /** YouTube video id. Absent for every other kind. */
  videoId?: string
  /** Where to start, from a `?t=` in the pasted link. */
  startAt?: number
  /** Present only for kind 'local'. */
  share?: LocalShare
}

export type ParseResult =
  | { ok: true; kind: 'drive'; fileId: string }
  | { ok: true; kind: 'putio'; url: string; converted: boolean }
  | { ok: true; kind: 'direct'; url: string }
  | { ok: true; kind: 'youtube'; videoId: string; startAt: number }
  | { ok: false; error: string }

/** Drive file ids are base64url-ish and comfortably longer than 20 chars. */
const FILE_ID = /^[A-Za-z0-9_-]{20,}$/

const ID_PATTERNS: RegExp[] = [
  // https://drive.google.com/file/d/<id>/view
  // https://docs.google.com/file/d/<id>/edit
  /\/file\/d\/([A-Za-z0-9_-]{20,})/,
  // https://drive.google.com/open?id=<id>
  // https://drive.google.com/uc?export=download&id=<id>
  // https://drive.usercontent.google.com/download?id=<id>
  /[?&]id=([A-Za-z0-9_-]{20,})/,
  // https://drive.google.com/drive/folders/... is NOT a file, handled separately
  // https://drive.google.com/d/<id>
  /\/d\/([A-Za-z0-9_-]{20,})/,
]

/**
 * Accepts any of the shapes Google hands out from the "Share" and "Copy link"
 * menus, plus a bare file id, plus (as an escape hatch) a direct https URL to a
 * media file on any host.
 */
export function parseMediaLink(raw: string): ParseResult {
  const input = raw.trim()
  if (!input) return { ok: false, error: 'Paste a video link first.' }

  // A bare id. YouTube's is 11 characters and Drive's is comfortably longer, so
  // the two never collide.
  if (!input.includes('/') && !input.includes('.')) {
    if (isBareVideoId(input)) {
      return { ok: true, kind: 'youtube', videoId: input, startAt: 0 }
    }
    if (FILE_ID.test(input)) return { ok: true, kind: 'drive', fileId: input }
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return {
      ok: false,
      error: "That doesn't look like a link. Paste the whole Google Drive URL.",
    }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only http(s) links are supported.' }
  }

  const host = url.hostname.toLowerCase()
  const isGoogle =
    host === 'drive.google.com' ||
    host === 'docs.google.com' ||
    host === 'drive.usercontent.google.com'

  if (isGoogle) {
    if (url.pathname.includes('/folders/')) {
      return {
        ok: false,
        error: 'That is a folder link. Open the video itself and copy its link.',
      }
    }
    for (const re of ID_PATTERNS) {
      const m = re.exec(url.pathname + url.search)
      if (m?.[1]) return { ok: true, kind: 'drive', fileId: m[1] }
    }
    return {
      ok: false,
      error: "Couldn't find a file id in that Google Drive link.",
    }
  }

  if (isYouTubeHost(host)) {
    const yt = parseYouTubeUrl(url)
    if (!yt.ok) return yt
    return { ok: true, kind: 'youtube', videoId: yt.videoId, startAt: yt.startAt }
  }

  if (host === 'put.io' || host === 'api.put.io' || host.endsWith('.put.io')) {
    return parsePutio(url)
  }

  // Any other host: hand the URL straight to <video> and let it decide.
  return { ok: true, kind: 'direct', url: url.toString() }
}

/**
 * put.io serves two things at the same file id:
 *
 *   /files/<id>/download/<name>       the original, often MKV/HEVC, which no
 *                                     browser will play
 *   /files/<id>/mp4/download/<name>   put.io's H.264 + AAC conversion, which
 *                                     every browser plays
 *
 * People copy the first one, so prefer the second automatically rather than
 * handing the user an unexplained "can't play this file".
 */
export function parsePutio(url: URL): ParseResult {
  const m = /\/files\/(\d+)\/(mp4\/)?download\b/.exec(url.pathname)
  if (!m) {
    // Some other put.io URL (a browse page, an API call). Not playable.
    return {
      ok: false,
      error:
        'That is not a put.io download link. Open the file in put.io and copy its download URL.',
    }
  }
  const alreadyConverted = Boolean(m[2])
  if (alreadyConverted) {
    return { ok: true, kind: 'putio', url: url.toString(), converted: true }
  }
  const rewritten = new URL(url.toString())
  rewritten.pathname = rewritten.pathname.replace(
    /\/files\/(\d+)\/download\b/,
    '/files/$1/mp4/download',
  )
  return { ok: true, kind: 'putio', url: rewritten.toString(), converted: false }
}

/**
 * True when a URL carries its own access credential in the query string.
 *
 * put.io download links embed an account-wide `oauth_token`, and the media URL
 * is broadcast to everyone in the room. Worth saying out loud before someone
 * pastes their account key into a chat with five people in it.
 */
export function hasEmbeddedCredential(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const risky = /^(oauth_token|access_token|api_key|apikey|token|auth|key)$/i
  for (const name of url.searchParams.keys()) {
    if (risky.test(name)) return true
  }
  return false
}

/**
 * The endpoint that serves the actual bytes for a public file.
 * `confirm=t` skips the "Google Drive can't scan this file for viruses"
 * interstitial that large files (i.e. every video) otherwise return.
 */
export function driveDirectUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    fileId,
  )}&export=download&confirm=t`
}

/** Loads as an <img> for public files; 403s for private ones. */
export function driveThumbnailUrl(fileId: string, width = 480): string {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`
}

/** Human-facing page, useful for "open in Drive" / troubleshooting links. */
export function drivePageUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}

export function buildMediaRef(
  parsed: Extract<ParseResult, { ok: true }>,
  opts: { title?: string; setBy: string; setAt: number },
): MediaRef {
  if (parsed.kind === 'youtube') {
    return {
      kind: 'youtube',
      fileId: null,
      videoId: parsed.videoId,
      startAt: parsed.startAt,
      url: youtubeWatchUrl(parsed.videoId, parsed.startAt),
      // The real title is fetched separately and is allowed to fail, so there
      // is always a usable fallback here.
      title: opts.title?.trim() || 'YouTube video',
      setBy: opts.setBy,
      setAt: opts.setAt,
    }
  }

  if (parsed.kind === 'drive') {
    return {
      kind: 'drive',
      fileId: parsed.fileId,
      url: driveDirectUrl(parsed.fileId),
      title: opts.title?.trim() || 'Google Drive video',
      setBy: opts.setBy,
      setAt: opts.setAt,
    }
  }
  let guessed = parsed.kind === 'putio' ? 'put.io video' : 'Direct link'
  try {
    const name = new URL(parsed.url).pathname.split('/').pop()
    if (name) guessed = decodeURIComponent(name)
  } catch {
    /* keep fallback */
  }
  return {
    kind: parsed.kind,
    fileId: null,
    url: parsed.url,
    title: opts.title?.trim() || guessed,
    setBy: opts.setBy,
    setAt: opts.setAt,
  }
}

/**
 * Everything the room needs to know about a file being shared from a disk,
 * built once by whoever picked it.
 */
export function buildLocalMediaRef(
  share: LocalShare,
  opts: { title?: string; setBy: string; setAt: number },
): MediaRef {
  return {
    kind: 'local',
    fileId: null,
    // Each browser resolves its own URL for these — the host plays the file
    // directly, everyone else streams it from the host — so there is no single
    // URL worth putting on the wire.
    url: '',
    share,
    title: opts.title?.trim() || share.name,
    setBy: opts.setBy,
    setAt: opts.setAt,
  }
}

/** Containers every browser plays, and the ones that reliably fail. */
const PLAYABLE_EXT = /\.(mp4|m4v|webm|ogv|ogg)$/i
const UNPLAYABLE_EXT = /\.(mkv|avi|wmv|flv|ts|m2ts|vob|rmvb|divx|3gp)$/i

export type FileCheck =
  | { ok: true; warning: string | null }
  | { ok: false; error: string }

/**
 * Advisory, in the same spirit as the Drive probe: block what is certainly not
 * a video, warn about what usually will not decode, and let the file itself
 * have the final word. Whoever picked it sees the result on their own screen
 * immediately, which is the fastest possible feedback.
 */
export function checkLocalFile(file: {
  name: string
  type: string
  size: number
}): FileCheck {
  if (file.size === 0) {
    return { ok: false, error: 'That file is empty.' }
  }
  const looksVideo =
    file.type.startsWith('video/') ||
    PLAYABLE_EXT.test(file.name) ||
    UNPLAYABLE_EXT.test(file.name) ||
    /\.(mov)$/i.test(file.name)
  if (!looksVideo) {
    return {
      ok: false,
      error: 'That is not a video file. Pick an MP4 (H.264 + AAC) for the widest support.',
    }
  }
  if (UNPLAYABLE_EXT.test(file.name)) {
    return {
      ok: true,
      warning:
        'Browsers cannot decode this container, so it will probably not play for anyone — including you. MP4 (H.264 + AAC) is the safe choice.',
    }
  }
  if (/\.mov$/i.test(file.name)) {
    return {
      ok: true,
      warning:
        'A .mov straight from a phone or camera is often HEVC, which plays on Apple devices and nowhere else. If someone sees a black screen, that is why.',
    }
  }
  return { ok: true, warning: null }
}

export type ShareCheck =
  | { status: 'public' }
  | { status: 'not-public' }
  | { status: 'unknown' }

/**
 * Cheap, CORS-free permission probe: a public Drive file exposes a thumbnail to
 * anonymous requests, a restricted one does not. Loading it through an <img>
 * sidesteps CORS entirely — we only need load-vs-error, not the pixels.
 *
 * Advisory only. Some public files (unusual codecs, very fresh uploads) have no
 * thumbnail yet, so a failure here is a strong hint rather than a verdict; the
 * <video> element is the authority. See ASSUMPTIONS.md.
 */
export function checkDriveIsPublic(
  fileId: string,
  opts: { timeoutMs?: number; makeImage?: () => HTMLImageElement } = {},
): Promise<ShareCheck> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const make = opts.makeImage ?? (() => new Image())
  return new Promise((resolve) => {
    let done = false
    const img = make()
    const finish = (r: ShareCheck) => {
      if (done) return
      done = true
      clearTimeout(timer)
      img.onload = null
      img.onerror = null
      img.src = ''
      resolve(r)
    }
    const timer = setTimeout(() => finish({ status: 'unknown' }), timeoutMs)
    img.onload = () => finish({ status: 'public' })
    img.onerror = () => finish({ status: 'not-public' })
    img.referrerPolicy = 'no-referrer'
    img.src = driveThumbnailUrl(fileId, 120)
  })
}

/** Maps a MediaError code from <video> onto something a human can act on. */
export function describeMediaError(
  code: number | undefined,
  kind: MediaKind,
): string {
  const driveHint =
    kind === 'drive'
      ? " In Drive, open the file → Share → General access → \"Anyone with the link\"."
      : ''
  // YouTube never reaches a <video> element, so a MediaError code here would be
  // meaningless; describeYouTubeError handles the player's own codes instead.
  if (kind === 'youtube') return 'YouTube could not play this video.'
  if (kind === 'local') {
    // Nothing about a shared file is fixable by sharing settings or a re-paste,
    // so the advice is about the file itself and about the person holding it.
    if (code === 3 || code === 4) {
      return 'This browser cannot decode that file. It has to be a format the browser plays — MP4 with H.264 video and AAC audio works everywhere; MKV, AVI and HEVC generally do not.'
    }
    return 'Lost the file part-way through. It is coming from another browser in this room, so this usually means that connection dropped — it should recover on its own.'
  }
  switch (code) {
    case 1: // MEDIA_ERR_ABORTED
      return 'Loading was cancelled. Try again.'
    case 2: // MEDIA_ERR_NETWORK
      return `Network error while loading the video.${driveHint}`
    case 3: // MEDIA_ERR_DECODE
      return 'The file downloaded but the browser could not decode it. Re-encode as MP4 (H.264 + AAC) for the widest support.'
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      if (kind === 'drive') {
        return `Could not play this file. Either it is not shared publicly, or it is not a format this browser can play (MP4 / H.264 works everywhere; MKV and AVI usually do not).${driveHint}`
      }
      if (kind === 'putio') {
        return 'Could not play this file. put.io may not have finished converting it — open the file in put.io and check that an MP4 version is available.'
      }
      return 'Could not play this URL. It may not be a direct media link, or the host blocks cross-origin playback.'
    default:
      return `Could not load the video.${driveHint}`
  }
}
