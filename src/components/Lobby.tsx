import { useState } from 'react'
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from '../lib/roomCode'

interface Props {
  name: string
  onEnter: (roomCode: string) => void
  onChangeName: () => void
}

export function Lobby({ name, onEnter, onChangeName }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const join = () => {
    const normalized = normalizeRoomCode(code)
    if (!isValidRoomCode(normalized)) {
      setError('That room code does not look right. It looks like "sunny-otter-42".')
      return
    }
    onEnter(normalized)
  }

  return (
    <main className="screen">
      <div className="card">
        <h1 className="title">Watch Together</h1>
        <p className="subtitle">
          Hi {name}.{' '}
          <button className="link" type="button" onClick={onChangeName}>
            Not you?
          </button>
        </p>

        <button
          className="btn btn-primary btn-block"
          type="button"
          onClick={() => onEnter(generateRoomCode())}
        >
          Start a new room
        </button>

        <div className="divider">
          <span>or join one</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            join()
          }}
        >
          <label className="label" htmlFor="code">
            Room code
          </label>
          <input
            id="code"
            className="input"
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              setError(null)
            }}
            placeholder="sunny-otter-42"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-block" type="submit" disabled={!code.trim()}>
            Join room
          </button>
        </form>

        <p className="footnote">
          Rooms are peer-to-peer: there is no server and nothing is stored. Whoever has
          the code can join, so only share it with the people you want in the room.
        </p>
      </div>
    </main>
  )
}
