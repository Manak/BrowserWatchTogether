import { useSyncExternalStore } from 'react'
import { rememberVoicePreference } from '../hooks/useRoom'
import { VOICE_OFF, type VoiceChat } from '../voice/voiceChat'

interface Props {
  voice: VoiceChat | null
}

/**
 * One control with two jobs: turn the microphone on, and once it is on, mute it.
 * Tapping toggles mute (the common action); holding is not required, and the
 * long-press-to-turn-off case lives in the people panel instead.
 */
export function VoiceButton({ voice }: Props) {
  const snap = useSyncExternalStore(
    voice ? voice.subscribe : noopSubscribe,
    voice ? voice.getSnapshot : offSnapshot,
  )

  if (!voice) return null
  const on = snap.state === 'on'
  const starting = snap.state === 'starting'
  const live = on && !snap.muted

  const label = !on
    ? 'Turn on voice chat'
    : snap.muted
      ? 'Unmute microphone'
      : 'Mute microphone'

  return (
    <button
      className={`btn-icon voice-btn ${live ? 'voice-live' : ''} ${
        live && snap.speaking ? 'voice-speaking' : ''
      } ${on && snap.muted ? 'voice-muted' : ''}`}
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      disabled={starting}
      onClick={() => {
        if (on) {
          voice.toggleMuted()
        } else {
          rememberVoicePreference(true)
          void voice.enable()
        }
      }}
    >
      {on && !snap.muted ? <IconMic /> : <IconMicOff />}
    </button>
  )
}

const noopSubscribe = () => () => {}
// Must return the same object every call, or useSyncExternalStore loops.
const offSnapshot = () => VOICE_OFF

const S = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'currentColor' } as const

const IconMic = () => (
  <svg {...S} aria-hidden="true">
    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
  </svg>
)

const IconMicOff = () => (
  <svg {...S} aria-hidden="true">
    <path d="M15 11V6a3 3 0 0 0-5.9-.75l5.8 5.8A3 3 0 0 0 15 11ZM4.3 3 3 4.3l6 6V11a3 3 0 0 0 4.5 2.6l1.3 1.3A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 2.9-1.13L19.7 20 21 18.7 4.3 3Z" />
  </svg>
)
