import { colorForId, formatTime, initials } from '../lib/format'
import type { PeerView, Snapshot } from '../sync/engine'
import type { VoiceSnapshot } from '../voice/voiceChat'

interface Props {
  snap: Snapshot
  voice: VoiceSnapshot | null
}

export function PeopleList({ snap, voice }: Props) {
  return (
    <ul className="people">
      {snap.peers.map((p) => (
        <li className="person" key={p.id}>
          <span
            className={`avatar ${micOf(p, voice)?.speaking ? 'avatar-speaking' : ''}`}
            style={{ background: colorForId(p.id) }}
            aria-hidden="true"
          >
            {initials(p.name)}
          </span>
          <span className="person-main">
            <span className="person-name">
              {p.name}
              {p.isSelf && <span className="tag">you</span>}
              {p.isLeader && (
                <span className="tag tag-quiet" title="Keeps the room's playback position">
                  host
                </span>
              )}
              <MicBadge mic={micOf(p, voice)} />
            </span>
            <span className="person-sub">{statusLine(p, snap)}</span>
          </span>
          <span className={`dot ${dotClass(p, snap)}`} aria-hidden="true" />
        </li>
      ))}
    </ul>
  )
}

/** This person's voice state, or null when nobody has voice chat on. */
function micOf(
  p: PeerView,
  voice: VoiceSnapshot | null,
): { on: boolean; muted: boolean; speaking: boolean } | null {
  if (!voice) return null
  if (p.isSelf) {
    return voice.state === 'on'
      ? { on: true, muted: voice.muted, speaking: voice.speaking }
      : null
  }
  const peer = voice.peers[p.id]
  return peer?.on ? peer : null
}

function MicBadge({
  mic,
}: {
  mic: { on: boolean; muted: boolean; speaking: boolean } | null
}) {
  if (!mic) return null
  if (mic.muted) {
    return (
      <span className="mic-badge mic-muted" title="Microphone muted">
        muted
      </span>
    )
  }
  return (
    <span
      className={`mic-badge ${mic.speaking ? 'mic-speaking' : ''}`}
      title={mic.speaking ? 'Talking' : 'Microphone on'}
    >
      {mic.speaking ? 'talking' : 'mic'}
    </span>
  )
}

function dotClass(p: PeerView, snap: Snapshot): string {
  if (p.stale) return 'dot-stale'
  if (!snap.media) return 'dot-ok'
  if (p.fetching) return 'dot-busy'
  return p.ready ? 'dot-ok' : 'dot-busy'
}

function statusLine(p: PeerView, snap: Snapshot): string {
  if (p.stale) return 'Reconnecting…'
  if (!snap.media) return 'Waiting for a video'
  // Nobody is waiting for this person, so "buffering" would be doubly wrong:
  // it is not a stall, and it is not holding anyone up.
  if (p.fetching) return 'Copying the film across'
  const bits: string[] = []
  // An ad is not a stall, and telling someone their friend is "buffering" when
  // they are sitting through a pre-roll sends them to check their Wi-Fi.
  bits.push(p.inAd ? 'Watching an ad' : p.ready ? formatTime(p.time) : 'Buffering…')
  if (p.ready && p.buffered > 0) bits.push(`${Math.round(p.buffered)}s buffered`)
  if (!p.isSelf && p.rttMs !== null) bits.push(`${Math.round(p.rttMs)}ms`)
  return bits.join(' · ')
}
