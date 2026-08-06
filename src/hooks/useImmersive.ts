import { useCallback, useEffect, useRef, useState } from 'react'

/** Idle time before the controls fade away while watching. */
const IDLE_MS = 3000

export interface Immersive {
  /** Filling the screen, by either route. */
  active: boolean
  /** Our own expanded layout, used where the Fullscreen API is unavailable. */
  fauxFullscreen: boolean
  /** Whether the controls should currently be on screen. */
  controlsVisible: boolean
  toggle: () => void
  exit: () => void
  /** Call on any pointer or key activity to bring the controls back. */
  wake: () => void
}

/**
 * Fullscreen, plus the auto-hiding controls that go with it.
 *
 * Two things the browser will not do for us:
 *
 * 1. **iPhone has no Fullscreen API.** Only a `<video>` can go fullscreen
 *    there, and doing so hands the screen to Apple's player — our controls,
 *    participant list and join notices all disappear. So on iPhone we expand
 *    our own player to fill the viewport instead, and keep our UI.
 * 2. **Hiding controls cannot be done in CSS.** `:hover` is always true once
 *    the player covers the screen, so idleness has to be timed in JS.
 */
export function useImmersive(
  target: React.RefObject<HTMLElement | null>,
  playing: boolean,
): Immersive {
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const [fauxFullscreen, setFaux] = useState(false)
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const active = nativeFullscreen || fauxFullscreen
  // Derived rather than stored, so leaving fullscreen or pausing brings the
  // controls back without an effect having to reach in and set state.
  const controlsVisible = !active || !playing || !idle

  // Track the browser's own idea of fullscreen; the user can leave with Escape
  // or the system chrome, and our state has to follow.
  useEffect(() => {
    const sync = () => setNativeFullscreen(Boolean(document.fullscreenElement))
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

  // Our expanded layout locks the page behind it, or iOS will happily scroll
  // the room out from under the player.
  useEffect(() => {
    if (!fauxFullscreen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [fauxFullscreen])

  // Escape is wired into the Fullscreen API for free, but not into ours.
  useEffect(() => {
    if (!fauxFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFaux(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fauxFullscreen])

  const exit = useCallback(() => {
    setFaux(false)
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }, [])

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
      return
    }
    if (fauxFullscreen) {
      setFaux(false)
      return
    }
    const el = target.current
    // requestFullscreen simply does not exist on iPhone Safari.
    if (el?.requestFullscreen) {
      void el.requestFullscreen().catch(() => setFaux(true))
      return
    }
    setFaux(true)
  }, [fauxFullscreen, target])

  return { active, fauxFullscreen, controlsVisible, toggle, exit, wake }
}
