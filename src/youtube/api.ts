/**
 * Loading YouTube's IFrame Player API.
 *
 * It is the one piece of third-party script in the app, and it is not optional:
 * an embed is the only sanctioned way to play a YouTube video on another page,
 * and the API is the only way to drive that embed. It is fetched lazily — a
 * room watching a Drive file never touches YouTube at all.
 *
 * The API calls a single global when it finishes loading, so this has to be a
 * module-level promise: two players racing to load it would each install their
 * own callback and one would be overwritten.
 */

export interface YtPlayerOptions {
  videoId: string
  playerVars?: Record<string, string | number>
  host?: string
  events?: {
    onReady?: (e: { target: YtPlayer }) => void
    onStateChange?: (e: { data: number; target: YtPlayer }) => void
    onError?: (e: { data: number; target: YtPlayer }) => void
    onAutoplayBlocked?: () => void
  }
}

/** The methods this app uses, plus the lifecycle ones. */
export interface YtPlayer {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  getVideoLoadedFraction(): number
  setPlaybackRate(rate: number): void
  mute(): void
  unMute(): void
  setVolume(volume: number): void
  loadVideoById(videoId: string, startSeconds?: number): void
  cueVideoById(videoId: string, startSeconds?: number): void
  getIframe(): HTMLIFrameElement
  destroy(): void
}

interface YtNamespace {
  Player: new (el: HTMLElement | string, opts: YtPlayerOptions) => YtPlayer
}

declare global {
  interface Window {
    YT?: YtNamespace & { loading?: number }
    onYouTubeIframeAPIReady?: () => void
  }
}

const SCRIPT_SRC = 'https://www.youtube.com/iframe_api'

/**
 * The privacy-enhanced host. Same player, same API, but it does not write
 * tracking cookies until something is actually played — a reasonable default
 * for an app whose whole point is not having a backend that knows about you.
 */
export const PLAYER_HOST = 'https://www.youtube-nocookie.com'

let loader: Promise<YtNamespace> | null = null

export function loadYouTubeApi(): Promise<YtNamespace> {
  if (loader) return loader
  loader = new Promise<YtNamespace>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('No document; the YouTube player needs a browser.'))
      return
    }
    // A previous page load may already have it (or a test may have stubbed it).
    if (window.YT?.Player) {
      resolve(window.YT)
      return
    }

    // Chain rather than replace: the API only ever calls the global it finds.
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT?.Player) resolve(window.YT)
      else reject(new Error('YouTube API loaded without a player.'))
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    )
    if (existing) return

    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.onerror = () => {
      // A blocked script is the common case here — a content blocker, or a
      // network that filters YouTube — so say that rather than "failed".
      loader = null
      reject(
        new Error(
          'Could not load the YouTube player. A content blocker or network filter may be blocking youtube.com.',
        ),
      )
    }
    document.head.appendChild(script)
  })
  return loader
}

/** Test seam: forget any in-flight or completed load. */
export function resetYouTubeApiForTests(): void {
  loader = null
}

/**
 * `controls: 0` is the default, and it is deliberate. Two people watching one
 * film need one set of controls, and YouTube's belong to whoever's screen they
 * are on — a scrub there moves that person alone and desyncs the room silently.
 * Ours go through the engine, so they move everybody.
 *
 * `nativeControls` is the exception, for browsers that cannot put an element
 * into fullscreen — which in practice means an iPhone. There, YouTube's own
 * fullscreen button is the *only* way into fullscreen, and it only exists as
 * part of its control bar, so the bar has to come with it. The room copes by
 * adopting whatever those controls do rather than fighting them, exactly as it
 * already does with Apple's native player for a Drive file.
 */
export function defaultPlayerVars(
  origin: string,
  opts: { nativeControls?: boolean } = {},
): Record<string, string | number> {
  const native = opts.nativeControls === true
  return {
    controls: native ? 1 : 0,
    // The keyboard is ours either way: this is a desktop concern, and the room
    // already binds the same keys.
    disablekb: 1,
    modestbranding: 1,
    rel: 0,
    fs: native ? 1 : 0,
    iv_load_policy: 3,
    playsinline: 1,
    enablejsapi: 1,
    origin,
  }
}
