/**
 * What the connection is actually doing, in the words WebRTC uses for it.
 *
 * This exists because "it will not connect" has several causes that look
 * identical from the outside and need completely different fixes, and guessing
 * between them from a screenshot wastes an evening each time. The three that
 * matter:
 *
 *   - **No `srflx` candidate at all** — STUN was blocked or never answered, so
 *     this browser does not know its own public address. Nothing can connect.
 *   - **`srflx` on both sides, pair never succeeds** — each side knows its
 *     public address and still cannot be reached at it. That is a symmetric
 *     NAT, and it is the one case that genuinely requires a TURN relay.
 *   - **A pair succeeded** — the connection is up, and any remaining problem is
 *     not the network.
 *
 * Read off a phone, so it has to be short and copyable rather than pretty.
 */

export interface PeerDiagnostics {
  peerId: string
  /** RTCPeerConnection.connectionState: new/connecting/connected/failed/… */
  connection: string
  ice: string
  gathering: string
  /** Candidate types in the pair that actually carries traffic, if any. */
  localType: string | null
  remoteType: string | null
}

export interface Diagnostics {
  peers: PeerDiagnostics[]
  /**
   * Candidate types this browser gathered for itself, across all connections.
   * `host` alone means STUN did not answer.
   */
  gathered: string[]
}

export async function collectDiagnostics(
  connections: Record<string, RTCPeerConnection>,
): Promise<Diagnostics> {
  const gathered = new Set<string>()
  const peers: PeerDiagnostics[] = []

  for (const [peerId, pc] of Object.entries(connections)) {
    const view: PeerDiagnostics = {
      peerId: peerId.slice(0, 6),
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
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

    peers.push(view)
  }

  return { peers, gathered: [...gathered].sort() }
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
  if (d.peers.length === 0) return 'No peer connection has been attempted yet.'
  if (d.gathered.length > 0 && !d.gathered.includes('srflx') && !d.gathered.includes('relay')) {
    return 'Only local addresses were found — STUN did not answer, so this network is blocking it.'
  }
  if (d.peers.every((p) => p.connection === 'failed' || p.ice === 'failed')) {
    return 'Both sides know their public address and still cannot reach each other. That is a symmetric NAT, and it needs a TURN relay.'
  }
  return 'Still negotiating.'
}
