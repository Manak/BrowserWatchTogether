import { useEffect, useState } from 'react'
import type { RoomEvent, SyncEngine } from '../sync/engine'
import { playChime } from '../voice/chime'

/** How long a notice stays up. Long enough to read, short enough to ignore. */
const LIFETIME_MS = 4500
/** Never stack more than this; the newest matter most. */
const MAX_VISIBLE = 3

interface Toast {
  key: number
  kind: RoomEvent['kind']
  text: string
}

/**
 * Arrival and departure notices, drawn over the video.
 *
 * Over the video specifically, because the participant list lives in a side
 * panel that is a whole tab away on a phone — someone watching fullscreen on
 * an iPhone would otherwise never learn that their partner had joined.
 */
export function Toasts({ engine, muted }: { engine: SyncEngine; muted: boolean }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    let seq = 0
    const unsubscribe = engine.onRoomEvent((event) => {
      const key = ++seq
      const text =
        event.kind === 'join' ? `${event.name} joined` : `${event.name} left`
      setToasts((current) => [...current, { key, kind: event.kind, text }].slice(-MAX_VISIBLE))
      // The chime follows the same mute switch as the video, so silencing the
      // tab silences everything the tab makes.
      if (!muted) playChime(event.kind)
      setTimeout(() => {
        setToasts((current) => current.filter((t) => t.key !== key))
      }, LIFETIME_MS)
    })
    return unsubscribe
  }, [engine, muted])

  if (toasts.length === 0) return null

  return (
    // aria-live so a screen reader announces arrivals without stealing focus.
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.key} className={`toast toast-${t.kind}`}>
          <span className="toast-dot" aria-hidden="true" />
          {t.text}
        </div>
      ))}
    </div>
  )
}
