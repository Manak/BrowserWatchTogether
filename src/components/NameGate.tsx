import { useState } from 'react'
import { sanitizeName } from '../lib/format'

interface Props {
  initial: string
  /** Shown when we already know which room they are heading into. */
  roomCode?: string | null
  onSubmit: (name: string) => void
}

/**
 * Nobody reaches a room without a name — it is how everyone else identifies
 * you in the participant list and in "waiting for …" messages.
 */
export function NameGate({ initial, roomCode, onSubmit }: Props) {
  const [value, setValue] = useState(initial)
  const [touched, setTouched] = useState(false)
  const clean = sanitizeName(value)
  const valid = clean.length >= 1

  return (
    <main className="screen">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          setTouched(true)
          if (valid) onSubmit(clean)
        }}
      >
        <h1 className="title">Watch Together</h1>
        <p className="subtitle">
          {roomCode ? (
            <>
              You&rsquo;re joining <strong className="code-inline">{roomCode}</strong>.
              What should everyone call you?
            </>
          ) : (
            'Watch a Google Drive video in sync with someone else. First, your name.'
          )}
        </p>

        <label className="label" htmlFor="name">
          Your name
        </label>
        <input
          id="name"
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="e.g. Sam"
          maxLength={24}
          autoComplete="nickname"
          autoCapitalize="words"
          enterKeyHint="go"
          // Autofocus is unhelpful on mobile: it forces the keyboard open
          // before the user has read anything.
          autoFocus={!isTouchDevice()}
        />
        {touched && !valid && (
          <p className="error" role="alert">
            Please enter a name so everyone knows who you are.
          </p>
        )}

        <button className="btn btn-primary btn-block" type="submit" disabled={!valid}>
          {roomCode ? 'Join room' : 'Continue'}
        </button>
      </form>
    </main>
  )
}

function isTouchDevice(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
}
