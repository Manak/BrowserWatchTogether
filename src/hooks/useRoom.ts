import { useEffect, useRef, useState } from 'react'
import { FileClient } from '../share/fileClient'
import { fileHost } from '../share/fileHost'
import { ShareSession } from '../share/session'
import { SyncEngine } from '../sync/engine'
import { ReconnectWatchdog } from '../sync/reconnect'
import { createTrysteroTransport } from '../sync/trysteroTransport'
import type { Transport } from '../sync/transport'
import { configureAudioSession, makeMeter, playRemote } from '../voice/browserAudio'
import { VoiceChat } from '../voice/voiceChat'
import { forgetShareUrls } from './useShareUrl'

/** How often the engine re-evaluates drift, buffering and heartbeats. */
const UPDATE_MS = 250
/** Voice metering wants finer granularity than sync does. */
const VOICE_UPDATE_MS = 100

export interface RoomHandle {
  engine: SyncEngine | null
  voice: VoiceChat | null
  /** Present when this transport can carry file bytes. Null in tests. */
  share: ShareSession | null
  /** The live peer connections, for the diagnostics panel. */
  peerConnections: () => Record<string, RTCPeerConnection>
  joinError: string | null
}

/** Stable identity, so it never re-triggers an effect that depends on it. */
const NO_CONNECTIONS = (): Record<string, RTCPeerConnection> => ({})

/** Remembers whether the user wants the microphone on when they join. */
const VOICE_PREF_KEY = 'wt.voice'

export function voiceWantedOnJoin(): boolean {
  try {
    // Default on: the point of the room is watching together and talking.
    // Turning it off is remembered, so a "no thanks" sticks.
    return localStorage.getItem(VOICE_PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

export function rememberVoicePreference(on: boolean): void {
  try {
    localStorage.setItem(VOICE_PREF_KEY, on ? 'on' : 'off')
  } catch {
    /* private browsing; the in-memory default still applies */
  }
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
    share: ShareSession | null
    connections: () => Record<string, RTCPeerConnection>
  } | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  /** Bumping this tears the connection down and builds a fresh one. */
  const [generation, setGeneration] = useState(0)
  // Lazily initialised once and never reassigned, so it survives reconnects
  // and keeps its backoff across them.
  const [watchdog] = useState(() => new ReconnectWatchdog())
  // Read at connect time only; later renames go through engine.setName.
  // Declared before the connect effect so the ref is current when it runs.
  const nameRef = useRef(initialName)
  useEffect(() => {
    nameRef.current = initialName
  }, [initialName])

  /**
   * The teardown of the previous connection.
   *
   * Trystero keys live rooms by id and *returns the existing one* if you join
   * an id it still has registered — it only deregisters inside `leave()`. So
   * reconnecting without waiting hands us back the very connection we are
   * trying to replace, and the rebuild silently does nothing.
   */
  const pendingLeave = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    let transport: Transport | null = null
    let engine: SyncEngine | null = null
    let voice: VoiceChat | null = null
    let share: ShareSession | null = null
    const timers: ReturnType<typeof setInterval>[] = []

    const connect = async () => {
      await pendingLeave.current.catch(() => {})
      if (cancelled) return
      transport = createTrysteroTransport({
        roomCode,
        onJoinError: (message) => {
          setJoinError(message)
          // Trystero only reports this after a peer has been found and the
          // connection to it has failed, so it is evidence that somebody is
          // waiting on the other side rather than that the room is empty.
          // Without telling the watchdog, the first attempt was also the last.
          watchdog.noteJoinFailure(Date.now())
        },
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

      // Files shared straight from a disk ride the same peer connections. The
      // two halves are independent: this browser answers other people's
      // requests for a file it is sharing, and asks for one it is watching.
      if (transport.files) {
        transport.files.onRequest((req) => fileHost.serve(req))
        share = new ShareSession(new FileClient(transport.files))
      }

      const e = engine
      const v = voice
      timers.push(
        setInterval(() => {
          e.update()
          const connected = e.getSnapshot().connected
          // Connecting to one peer can fail while another succeeds. Once anyone
          // is on the line, retire the earlier complaint.
          if (connected) setJoinError(null)
          // A suspended phone comes back with connections that are dead but
          // never reported as closed. Rebuilding is the only way back.
          if (watchdog.shouldReconnect(connected, Date.now())) {
            setGeneration((g) => g + 1)
          }
        }, UPDATE_MS),
        setInterval(() => v.update(), VOICE_UPDATE_MS),
      )
      const t = transport
      setRoom({
        engine,
        voice,
        share,
        connections: () => t.media?.connections() ?? {},
      })
      setJoinError(null)

      // Ask for the microphone as part of joining, rather than making people
      // find a button once the film has already started. Starts unmuted.
      // Browsers that insist on a user gesture will refuse, and the panel then
      // shows a Turn on button — so this can only ever save a step, not cost one.
      if (voiceWantedOnJoin()) void voice.enable()
    }

    connect().catch((err: unknown) => {
      if (cancelled) return
      setJoinError(
        err instanceof Error ? err.message : 'Could not connect to the room.',
      )
    })

    return () => {
      cancelled = true
      for (const t of timers) clearInterval(t)
      voice?.destroy()
      engine?.destroy()
      share?.destroy()
      // Recorded so the next connection waits for this to finish deregistering.
      pendingLeave.current = transport?.leave() ?? Promise.resolve()
      // Deliberately *not* clearing the room here. A rebuild would otherwise
      // drop the app back to "Joining…" and then rebuild the whole room view,
      // which reads as the page reloading itself every few seconds — reported
      // as exactly that. The outgoing engine is destroyed but still answers
      // getSnapshot, so the room stays on screen, frozen, until the new one
      // replaces it a moment later. Only leaving the room unmounts this.
    }
  }, [roomCode, generation, watchdog])

  // Files and downloaded copies belong to the room, not to one connection, so
  // they survive a reconnect and are released only on leaving. Nothing here is
  // written to disk; closing the tab ends the share.
  useEffect(
    () => () => {
      fileHost.clear()
      forgetShareUrls()
    },
    [roomCode],
  )

  // Waking from sleep is the moment the connection is most likely to be a
  // corpse, so tell the watchdog to stop being patient.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState === 'visible') {
        watchdog.noteResume(Date.now())
      }
    }
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('pageshow', onResume)
    window.addEventListener('focus', onResume)
    window.addEventListener('online', onResume)
    return () => {
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('pageshow', onResume)
      window.removeEventListener('focus', onResume)
      window.removeEventListener('online', onResume)
    }
  }, [watchdog])

  return {
    engine: room?.engine ?? null,
    voice: room?.voice ?? null,
    share: room?.share ?? null,
    peerConnections: room?.connections ?? NO_CONNECTIONS,
    joinError,
  }
}
