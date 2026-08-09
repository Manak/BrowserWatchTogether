/**
 * Whether this browser may *share* a file from its own disk.
 *
 * Watching a shared file works everywhere — a phone is exactly the audience the
 * streaming path exists for. Serving one is different, and is deliberately
 * restricted to a desktop browser:
 *
 * - The sharer uploads the whole film, once per viewer, over its own
 *   connection. On a phone that is somebody's mobile data and somebody's
 *   battery, for as long as the film lasts.
 * - It only works while that tab is awake and in the room. Phones suspend
 *   background tabs, and the room's video stops when they do.
 * - A phone's video library is mostly HEVC `.mov` from its own camera, which
 *   plays on Apple devices and nowhere else.
 *
 * The test is for a touch-first device rather than a user-agent string, so an
 * unusual browser is judged by what it is, not by what it is called. iPads
 * report themselves as desktop Safari and are caught by this anyway, which is
 * the intended answer: an iPad has all three problems above.
 */
export function canShareLocalFile(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const touch = (navigator.maxTouchPoints ?? 0) > 1
  return !(coarse && touch)
}
