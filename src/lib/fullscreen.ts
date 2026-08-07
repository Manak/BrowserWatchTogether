/**
 * Can this browser put an *arbitrary element* into fullscreen?
 *
 * iPhone Safari cannot, and never has: the Fullscreen API there exists only on
 * `<video>`, through `webkitEnterFullscreen`. For a Drive file that is fine —
 * there is a real `<video>` to hand over, and the room follows whatever Apple's
 * player does to it. For YouTube there is no `<video>` to reach: the real one
 * lives inside a cross-origin iframe. So on an iPhone our fullscreen button had
 * nothing at all to call, and did nothing at all.
 *
 * Feature-tested rather than sniffed for the browser: what matters is whether
 * the call exists, and a Safari that grows the API tomorrow should start
 * working without anybody editing a list of user agents.
 */
export function canFullscreenElement(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => void
  }
  return (
    typeof el.requestFullscreen === 'function' ||
    typeof el.webkitRequestFullscreen === 'function'
  )
}
