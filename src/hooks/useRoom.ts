import { useEffect, useRef, useState } from 'react'
import { SyncEngine } from '../sync/engine'
import { createTrysteroTransport } from '../sync/trysteroTransport'
import type { Transport } from '../sync/transport'
import { configureAudioSession, makeMeter, playRemote } from '../voice/browserAudio'
import { VoiceChat } from '../voice/voiceChat'

/** How often the engine re-evaluates drift, buffering and heartbeats. */
const UPDATE_MS = 250
/** Voice metering wants finer granularity than sync does. */
const VOICE_UPDATE_MS = 100

export interface RoomHandle {
  engine: SyncEngine | null
  voice: VoiceChat | null
  joinError: string | null
}

/**
 * Owns the lifetime of one room connection: the transport, the sync engine and
 * voice chat, created and torn down together. All three are built inside a
 * single effect, so joining a relay or touching a microphone is never a render
 * side effect, and there is exactly one teardown path.
 */
export function useRoom(roomCode: string, initialName: string): RoomHandle {
  const [room, setRoom] = useState<{
    engine: SyncEngine
    voice: VoiceChat
  } | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  // Read at connect time only; later renames go through engine.setName.
  // Declared before the connect effect so the ref is current when it runs.
  const nameRef = useRef(initialName)
  useEffect(() => {
    nameRef.current = initialName
  }, [initialName])

  useEffect(() => {
    let transport: Transport | null = null
    let engine: SyncEngine | null = null
    let voice: VoiceChat | null = null
    const timers: ReturnType<typeof setInterval>[] = []

    try {
      transport = createTrysteroTransport({
        roomCode,
        onJoinError: (message) => setJoinError(message),
      })
      engine = new SyncEngine({ transport, name: nameRef.current })
      // Voice rides the same peer connections; it requests nothing from the
      // microphone until the user asks for it.
      voice = new VoiceChat({
        transport,
        getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
        makeMeter,
        playRemote,
        configureAudioSession,
      })

      const e = engine
      const v = voice
      timers.push(
        setInterval(() => {
          e.update()
          // Connecting to one peer can fail while another succeeds. Once anyone
          // is on the line, retire the earlier complaint.
          if (e.getSnapshot().connected) setJoinError(null)
        }, UPDATE_MS),
        setInterval(() => v.update(), VOICE_UPDATE_MS),
      )
      setRoom({ engine, voice })
      setJoinError(null)
    } catch (err) {
      setJoinError(
        err instanceof Error ? err.message : 'Could not connect to the room.',
      )
    }

    return () => {
      for (const t of timers) clearInterval(t)
      voice?.destroy()
      engine?.destroy()
      void transport?.leave()
      setRoom(null)
    }
  }, [roomCode])

  return { engine: room?.engine ?? null, voice: room?.voice ?? null, joinError }
}
