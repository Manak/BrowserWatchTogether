import { useCallback, useEffect, useState } from 'react'
import { Lobby } from './components/Lobby'
import { NameGate } from './components/NameGate'
import { RoomView } from './components/RoomView'
import { useLocalStorage } from './hooks/useLocalStorage'
import { useRoom } from './hooks/useRoom'
import { roomCodeFromHash } from './lib/roomCode'

const NAME_KEY = 'wt.name'

export function App() {
  const [name, setName] = useLocalStorage(NAME_KEY, '')
  const [editingName, setEditingName] = useState(false)
  const [roomCode, setRoomCode] = useState<string | null>(() =>
    roomCodeFromHash(location.hash),
  )

  // The hash is the router: back/forward and a pasted invite both work.
  useEffect(() => {
    const onHash = () => setRoomCode(roomCodeFromHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const enterRoom = useCallback((code: string) => {
    location.hash = `#/room/${code}`
    setRoomCode(code)
  }, [])

  const leaveRoom = useCallback(() => {
    location.hash = ''
    setRoomCode(null)
  }, [])

  // A name is required before entering a room, even when arriving via an invite.
  if (!name || editingName) {
    return (
      <NameGate
        initial={name}
        roomCode={roomCode}
        onSubmit={(n) => {
          setName(n)
          setEditingName(false)
        }}
      />
    )
  }

  if (!roomCode) {
    return (
      <Lobby name={name} onEnter={enterRoom} onChangeName={() => setEditingName(true)} />
    )
  }

  return (
    <RoomConnection
      // Remounting on a code change guarantees a clean transport per room.
      key={roomCode}
      roomCode={roomCode}
      name={name}
      onLeave={leaveRoom}
    />
  )
}

function RoomConnection({
  roomCode,
  name,
  onLeave,
}: {
  roomCode: string
  name: string
  onLeave: () => void
}) {
  const { engine, joinError } = useRoom(roomCode, name)

  // Renames propagate to the room without reconnecting.
  useEffect(() => {
    engine?.setName(name)
  }, [engine, name])

  if (!engine) {
    return (
      <main className="screen">
        <div className="card">
          <h1 className="title">Joining {roomCode}…</h1>
          {joinError ? (
            <>
              <p className="error" role="alert">
                Couldn&rsquo;t reach the other person. Some networks block direct
                connections between browsers — try a different Wi-Fi network or a
                phone hotspot.
              </p>
              <p className="footnote">{joinError}</p>
              <button className="btn btn-block" type="button" onClick={onLeave}>
                Back
              </button>
            </>
          ) : (
            <p className="subtitle">Finding the others.</p>
          )}
        </div>
      </main>
    )
  }

  return (
    <RoomView
      engine={engine}
      roomCode={roomCode}
      name={name}
      joinError={joinError}
      onLeave={onLeave}
    />
  )
}
