/**
 * What the connection is actually doing, in the words WebRTC uses for it.
 *
 * This exists because "it will not connect" has several causes that look
 * identical from the outside and need completely different fixes, and guessing
 * between them from a screenshot wastes an evening each time. The four that
 * matter:
 *
 *   - **No `srflx` candidate at all** — STUN was blocked or never answered, so
 *     this browser does not know its own public address. Nothing can connect.
 *   - **A `relay` candidate, and the pair still never succeeds** — a relay
 *     candidate works against anybody, so if one is on offer and nothing pairs,
 *     the other side never saw it. That is signalling losing candidates, not the
 *     network refusing them, and no amount of TURN fixes it.
 *   - **`srflx` on both sides, pair never succeeds, and no relay to fall back
 *     on** — each side knows its public address and still cannot be reached at
 *     it. That is a symmetric NAT, and it is what a TURN relay is for.
 *   - **A pair succeeded** — the connection is up, and any remaining problem is
 *     not the network.
 *
 * All four need the connections that failed, not only the ones that worked,
 * which is what `peerRegistry.ts` is for. Fed on Trystero's `getPeers()` alone
 * this panel could describe successes and nothing else, and printed "no peer
 * connection has been attempted yet" directly under an error naming the peer it
 * had just failed to reach.
 *
 * Read off a phone, so it has to be short and copyable rather than pretty.
 */

import { hasEverFailed } from './peerRegistry'

export interface PeerDiagnostics {
  /** Display label, not an identifier: a shortened peer id, or "attempt 2". */
  peerId: string
  /** RTCPeerConnection.connectionState: new/connecting/connected/failed/… */
  connection: string
  ice: string
  gathering: string
  /**
   * Reached `failed` at some point, even if it has since been closed.
   *
   * Not the same as `connection === 'failed'`, and the difference is the whole
   * reason it is here: a failure that gets cleaned up reports `closed`
   * afterwards, which is also what a peer who simply left looks like.
   */
  failed: boolean
  /** Candidate types in the pair that actually carries traffic, if any. */
  localType: string | null
  remoteType: string | null
}

export interface Diagnostics {
  /** Connections that got as far as exchanging SDP with somebody. */
  peers: PeerDiagnostics[]
  /**
   * Candidate types this browser gathered for itself, across all connections.
   * `host` alone means STUN did not answer.
   */
  gathered: string[]
  /**
   * Connections built and offered, with nobody on the other end yet.
   *
   * Trystero keeps a pool of twenty, so this sits at twenty in a healthy room
   * that is simply empty. The number is not the point; zero is. Zero means
   * nothing was ever built, which is a different problem entirely from an offer
   * nobody has answered. What these are really for is their candidates: they are
   * how the panel can say whether STUN and TURN work at all before a second
   * person has joined to test it against.
   */
  waiting: number
}

export async function collectDiagnostics(
  connections: Record<string, RTCPeerConnection>,
): Promise<Diagnostics> {
  const gathered = new Set<string>()
  const peers: PeerDiagnostics[] = []
  let waiting = 0

  for (const [peerId, pc] of Object.entries(connections)) {
    const view: PeerDiagnostics = {
      // Already shortened by whoever labelled these — see `labelConnections`.
      // Truncating again here turned "attempt 1" into "attemp".
      peerId,
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      failed:
        hasEverFailed(pc) ||
        pc.connectionState === 'failed' ||
        pc.iceConnectionState === 'failed',
      localType: null,
      remoteType: null,
    }

    try {
      const stats = await pc.getStats()
      const byId = new Map<string, RTCStats>()
      stats.forEach((s) => byId.set(s.id, s))

      stats.forEach((s) => {
        const stat = s as RTCStats & { type: string; candidateType?: string }
        if (stat.type === 'local-candidate' && stat.candidateType) {
          gathered.add(stat.candidateType)
        }
      })

      stats.forEach((s) => {
        const pair = s as RTCStats & {
          type: string
          state?: string
          nominated?: boolean
          localCandidateId?: string
          remoteCandidateId?: string
        }
        if (pair.type !== 'candidate-pair') return
        if (pair.state !== 'succeeded') return
        const local = byId.get(pair.localCandidateId ?? '') as
          | { candidateType?: string }
          | undefined
        const remote = byId.get(pair.remoteCandidateId ?? '') as
          | { candidateType?: string }
          | undefined
        view.localType = local?.candidateType ?? null
        view.remoteType = remote?.candidateType ?? null
      })
    } catch {
      // getStats can reject on a connection that is already closing; the
      // states above are still worth reporting.
    }

    // A remote description is the line between "offered into an empty room" and
    // "found somebody and could not reach them". Only the second is a failure,
    // and listing the first alongside it would drown the one peer that matters
    // in half a dozen pooled offers that are behaving exactly as intended.
    if (pc.remoteDescription) peers.push(view)
    else waiting++
  }

  return { peers, gathered: [...gathered].sort(), waiting }
}

/**
 * The one-line verdict, which is the part worth reading first.
 *
 * Deliberately says "cannot tell yet" rather than picking a likely answer:
 * every wrong guess here costs a change to something that was not broken.
 */
export function summarise(d: Diagnostics, connected: boolean): string {
  if (connected && d.peers.some((p) => p.localType)) {
    const via = d.peers.find((p) => p.localType)
    return `Connected via ${via?.localType} ↔ ${via?.remoteType}.`
  }

  const blocked =
    d.gathered.length > 0 &&
    !d.gathered.includes('srflx') &&
    !d.gathered.includes('relay')

  // A connection that is merely closed and never failed is somebody who left,
  // or the room this page was in before this one. Still listed below, because it
  // happened, but it must not be read as a connection in trouble — left in, it
  // holds the verdict on "still negotiating" forever after a room switch.
  const live = d.peers.filter((p) => p.failed || p.connection !== 'closed')

  if (live.length === 0) {
    if (d.waiting === 0 && d.peers.length === 0) {
      return 'No peer connection has been attempted yet.'
    }
    // "Nobody here" rather than "nobody yet" once a connection has come and
    // gone: after somebody leaves, or after switching rooms, "yet" is a lie and
    // reads as though the room never worked.
    const nobody = d.peers.length > 0 ? 'Nobody is connected' : 'Nobody has joined yet'
    if (blocked) {
      return `${nobody}, and this browser only found local addresses — STUN did not answer, so this network is blocking it.`
    }
    return `${nobody}. This browser can offer ${d.gathered.join(', ') || 'nothing yet'}, so its half is working.`
  }

  if (blocked) {
    return 'Only local addresses were found — STUN did not answer, so this network is blocking it.'
  }

  const allFailed = live.every((p) => p.failed)
  if (allFailed && d.gathered.includes('relay')) {
    // A relay candidate pairs with anything, including a peer with no TURN of
    // its own. Offering one and still pairing with nothing means it never
    // arrived — signalling dropped the candidates after carrying the offer. A
    // public relay that rate-limits a burst does exactly this, and every hour
    // spent on TURN after seeing this line is an hour spent on the wrong thing.
    return 'This browser offered a TURN relay and the connection still failed, so the other side never received it. That is the signalling relay dropping candidates, not the network.'
  }
  if (allFailed) {
    return 'Both sides know their public address and still cannot reach each other. That is a symmetric NAT, and it needs a TURN relay.'
  }
  return 'Still negotiating.'
}
