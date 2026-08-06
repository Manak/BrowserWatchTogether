import { useCallback, useEffect, useRef, useState } from 'react'

/** Idle time before the controls fade away while watching. */
const IDLE_MS = 3000

export interface Immersive {
  /** The browser reports us as fullscreen. */
  active: boolean
  /** Whether the controls should currently be on screen. */
  controlsVisible: boolean
  toggle: () => void
  /** Call on any pointer or key activity to bring the controls back. */
  wake: () => void
}

/**
 * Fullscreen, plus the auto-hiding controls that go with it.
 *
 * The hiding cannot be done in CSS: `:hover` is always true once the player
 * covers the screen, so it can never express "idle". It has to be timed in JS.
 *
 * On iPhone, where the Fullscreen API exists only for `<video>`, we hand the
 * screen to Apple's player. Our own controls are not available there, but the
 * engine adopts whatever the native controls do (see Player), so the room
 * stays in sync either way.
 */
export function useImmersive(
  target: React.RefObject<HTMLElement | null>,
  video: React.RefObject<HTMLVideoElement | null>,
  playing: boolean,
): Immersive {
  const [active, setActive] = useState(false)
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Derived rather than stored, so leaving fullscreen or pausing brings the
  // controls back without an effect having to reach in and set state.
  const controlsVisible = !active || !playing || !idle

  // Track the browser's own idea of fullscreen; the user can leave with Escape
  // or the system chrome, and our state has to follow.
  useEffect(() => {
    const sync = () => setActive(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  const wake = useCallback(() => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS)
  }, [])

  // Controls only hide while immersed and actually playing. Nobody wants them
  // to vanish from a paused video they are still deciding what to do with.
  useEffect(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    if (!active || !playing) return
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS)
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [active, playing])

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
      return
    }
    const el = target.current
    const nativeVideo = video.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null
    if (el?.requestFullscreen) {
      void el.requestFullscreen().catch(() => nativeVideo?.webkitEnterFullscreen?.())
      return
    }
    // iPhone Safari: only the video element can go fullscreen, which means
    // Apple's controls rather than ours.
    nativeVideo?.webkitEnterFullscreen?.()
  }, [target, video])

  return { active, controlsVisible, toggle, wake }
}
