import { colorForId, formatTime, initials } from '../lib/format'
import type { PeerView, Snapshot } from '../sync/engine'

interface Props {
  snap: Snapshot
}

export function PeopleList({ snap }: Props) {
  return (
    <ul className="people">
      {snap.peers.map((p) => (
        <li className="person" key={p.id}>
          <span className="avatar" style={{ background: colorForId(p.id) }} aria-hidden="true">
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
            </span>
            <span className="person-sub">{statusLine(p, snap)}</span>
          </span>
          <span className={`dot ${dotClass(p, snap)}`} aria-hidden="true" />
        </li>
      ))}
    </ul>
  )
}

function dotClass(p: PeerView, snap: Snapshot): string {
  if (p.stale) return 'dot-stale'
  if (!snap.media) return 'dot-ok'
  return p.ready ? 'dot-ok' : 'dot-busy'
}

function statusLine(p: PeerView, snap: Snapshot): string {
  if (p.stale) return 'Reconnecting…'
  if (!snap.media) return 'Waiting for a video'
  const bits: string[] = []
  bits.push(p.ready ? formatTime(p.time) : 'Buffering…')
  if (p.ready && p.buffered > 0) bits.push(`${Math.round(p.buffered)}s buffered`)
  if (!p.isSelf && p.rttMs !== null) bits.push(`${Math.round(p.rttMs)}ms`)
  return bits.join(' · ')
}
