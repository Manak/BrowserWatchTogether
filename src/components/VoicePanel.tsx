import { useSyncExternalStore } from 'react'
import type { VoiceChat, VoiceSnapshot } from '../voice/voiceChat'

interface Props {
  voice: VoiceChat
}

/** Voice controls and status, shown under the participant list. */
export function VoicePanel({ voice }: Props) {
  const snap = useSyncExternalStore(voice.subscribe, voice.getSnapshot)

  return (
    <div className="voice-panel">
      <div className="voice-row">
        <div className="voice-title">
          Voice chat
          <span className="voice-state">{stateLabel(snap)}</span>
        </div>
        {snap.state === 'on' ? (
          <div className="voice-actions">
            <button
              className="btn btn-small"
              type="button"
              onClick={() => voice.toggleMuted()}
            >
              {snap.muted ? 'Unmute' : 'Mute'}
            </button>
            <button className="btn btn-small" type="button" onClick={() => voice.disable()}>
              Turn off
            </button>
          </div>
        ) : (
          <button
            className="btn btn-small btn-primary"
            type="button"
            disabled={snap.state === 'starting'}
            onClick={() => void voice.enable()}
          >
            {snap.state === 'starting' ? 'Starting…' : 'Turn on'}
          </button>
        )}
      </div>

      {snap.error && (
        <p className="error" role="alert">
          {snap.error}
        </p>
      )}

      <p className="footnote">
        Your microphone is echo-cancelled, so the film does not come back to the
        other person. Nobody&rsquo;s video volume is turned down when someone
        talks — the two just mix.
      </p>
    </div>
  )
}

function stateLabel(snap: VoiceSnapshot): string {
  switch (snap.state) {
    case 'on':
      return snap.muted ? 'muted' : snap.speaking ? 'you’re talking' : 'live'
    case 'starting':
      return 'starting…'
    case 'denied':
      return 'blocked'
    case 'unavailable':
      return 'unavailable'
    case 'error':
      return 'error'
    default:
      return snap.anyoneElseOn ? 'others are on' : 'off'
  }
}
