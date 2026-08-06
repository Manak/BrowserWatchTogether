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

export type MediaKind = 'drive' | 'direct'

export interface MediaRef {
  kind: MediaKind
  /** Drive file id, or null for a plain direct URL. */
  fileId: string | null
  /** URL actually handed to <video src>. */
  url: string
  /** Human label shown in the UI. */
  title: string
  /** Display name of whoever set it. */
  setBy: string
  /** Wall clock of the setter, for display only. */
  setAt: number
}

export type ParseResult =
  | { ok: true; kind: 'drive'; fileId: string }
  | { ok: true; kind: 'direct'; url: string }
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
  if (!input) return { ok: false, error: 'Paste a Google Drive link first.' }

  // Bare file id.
  if (FILE_ID.test(input) && !input.includes('/') && !input.includes('.')) {
    return { ok: true, kind: 'drive', fileId: input }
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

  // Non-Drive host: allow it, but only if it looks like a media file or stream.
  return { ok: true, kind: 'direct', url: url.toString() }
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
  let guessed = 'Direct link'
  try {
    const name = new URL(parsed.url).pathname.split('/').pop()
    if (name) guessed = decodeURIComponent(name)
  } catch {
    /* keep fallback */
  }
  return {
    kind: 'direct',
    fileId: null,
    url: parsed.url,
    title: opts.title?.trim() || guessed,
    setBy: opts.setBy,
    setAt: opts.setAt,
  }
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
  switch (code) {
    case 1: // MEDIA_ERR_ABORTED
      return 'Loading was cancelled. Try again.'
    case 2: // MEDIA_ERR_NETWORK
      return `Network error while loading the video.${driveHint}`
    case 3: // MEDIA_ERR_DECODE
      return 'The file downloaded but the browser could not decode it. Re-encode as MP4 (H.264 + AAC) for the widest support.'
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return kind === 'drive'
        ? `Could not play this file. Either it is not shared publicly, or it is not a format this browser can play (MP4 / H.264 works everywhere; MKV and AVI usually do not).${driveHint}`
        : 'Could not play this URL. It may not be a direct media link, or the host blocks cross-origin playback.'
    default:
      return `Could not load the video.${driveHint}`
  }
}
