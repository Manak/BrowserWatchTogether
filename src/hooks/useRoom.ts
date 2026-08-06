import { useEffect, useRef, useState } from 'react'
import { SyncEngine } from '../sync/engine'
import { createTrysteroTransport } from '../sync/trysteroTransport'
import type { Transport } from '../sync/transport'

/** How often the engine re-evaluates drift, buffering and heartbeats. */
const UPDATE_MS = 250

export interface RoomHandle {
  engine: SyncEngine | null
  joinError: string | null
}

/**
 * Owns the lifetime of one room connection. The engine is created in an effect
 * (never during render) so that joining a relay is never a render side effect.
 */
export function useRoom(roomCode: string, initialName: string): RoomHandle {
  const [engine, setEngine] = useState<SyncEngine | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  // Read at connect time only; later renames go through engine.setName.
  // Declared before the connect effect so the ref is current when it runs.
  const nameRef = useRef(initialName)
  useEffect(() => {
    nameRef.current = initialName
  }, [initialName])

  useEffect(() => {
    let transport: Transport | null = null
    let created: SyncEngine | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false

    try {
      transport = createTrysteroTransport({
        roomCode,
        onJoinError: (message) => setJoinError(message),
      })
      created = new SyncEngine({ transport, name: nameRef.current })
      if (cancelled) throw new Error('unmounted')
      setEngine(created)
      setJoinError(null)
      const e = created
      timer = setInterval(() => {
        e.update()
        // Connecting to one peer can fail while another succeeds. Once anyone
        // is on the line, retire the earlier complaint.
        if (e.getSnapshot().connected) setJoinError(null)
      }, UPDATE_MS)
    } catch (err) {
      setJoinError(
        err instanceof Error && err.message !== 'unmounted'
          ? err.message
          : 'Could not connect to the room.',
      )
    }

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      created?.destroy()
      void transport?.leave()
      setEngine(null)
    }
  }, [roomCode])

  return { engine, joinError }
}
