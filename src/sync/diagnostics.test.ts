import { describe, expect, it } from 'vitest'
import { collectDiagnostics, summarise, type Diagnostics } from './diagnostics'

/**
 * A peer connection is only ever read here, so a literal is enough. The two
 * fields that decide everything are `remoteDescription` — did this connection
 * ever meet anybody — and whatever `getStats` reports.
 */
function fakeConnection(opts: {
  connectionState?: string
  iceConnectionState?: string
  iceGatheringState?: string
  metSomebody?: boolean
  localCandidates?: string[]
  succeededPair?: { local: string; remote: string }
  statsThrow?: boolean
}): RTCPeerConnection {
  const stats: Record<string, unknown>[] = (opts.localCandidates ?? []).map(
    (candidateType, i) => ({ id: `local-${i}`, type: 'local-candidate', candidateType }),
  )
  if (opts.succeededPair) {
    stats.push(
      { id: 'l', type: 'local-candidate', candidateType: opts.succeededPair.local },
      { id: 'r', type: 'remote-candidate', candidateType: opts.succeededPair.remote },
      { id: 'p', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' },
    )
  }

  return {
    connectionState: opts.connectionState ?? 'new',
    iceConnectionState: opts.iceConnectionState ?? 'new',
    iceGatheringState: opts.iceGatheringState ?? 'gathering',
    remoteDescription: opts.metSomebody ? ({ type: 'answer' } as RTCSessionDescription) : null,
    getStats: () =>
      opts.statsThrow
        ? Promise.reject(new Error('closing'))
        : Promise.resolve({
            forEach: (fn: (s: unknown) => void) => stats.forEach(fn),
          } as unknown as RTCStatsReport),
  } as unknown as RTCPeerConnection
}

describe('collectDiagnostics', () => {
  it('reports a connection that failed after finding somebody', async () => {
    // The case the panel exists for, and the case it used to show nothing at
    // all: Trystero's connected-peers map is empty here.
    const d = await collectDiagnostics({
      'attempt 1': fakeConnection({
        metSomebody: true,
        connectionState: 'failed',
        iceConnectionState: 'failed',
        localCandidates: ['host', 'srflx', 'relay'],
      }),
    })
    expect(d.peers).toHaveLength(1)
    // The label is passed through, not re-shortened: this used to arrive as
    // "attemp", which reads like a truncated peer id rather than a count.
    expect(d.peers[0]?.peerId).toBe('attempt 1')
    expect(d.peers[0]?.connection).toBe('failed')
    expect(d.gathered).toEqual(['host', 'relay', 'srflx'])
    expect(d.waiting).toBe(0)
  })

  it('counts an offer nobody answered as waiting, not as a failure', async () => {
    const d = await collectDiagnostics({
      'attempt 1': fakeConnection({ localCandidates: ['host', 'srflx'] }),
      'attempt 2': fakeConnection({ localCandidates: ['host'] }),
    })
    expect(d.peers).toEqual([])
    expect(d.waiting).toBe(2)
    // Still worth reading: this is how a room alone can tell STUN is working.
    expect(d.gathered).toEqual(['host', 'srflx'])
  })

  it('names the candidate types of the pair actually carrying traffic', async () => {
    const d = await collectDiagnostics({
      abcdef: fakeConnection({
        metSomebody: true,
        connectionState: 'connected',
        succeededPair: { local: 'srflx', remote: 'host' },
      }),
    })
    expect(d.peers[0]?.localType).toBe('srflx')
    expect(d.peers[0]?.remoteType).toBe('host')
  })

  it('still reports the states when getStats rejects', async () => {
    const d = await collectDiagnostics({
      abcdef: fakeConnection({ metSomebody: true, connectionState: 'closed', statsThrow: true }),
    })
    expect(d.peers[0]?.connection).toBe('closed')
    expect(d.gathered).toEqual([])
  })

  it('has nothing to say about no connections', async () => {
    expect(await collectDiagnostics({})).toEqual({ peers: [], gathered: [], waiting: 0 })
  })
})

const diag = (over: Partial<Diagnostics> = {}): Diagnostics => ({
  peers: [],
  gathered: [],
  waiting: 0,
  ...over,
})

const failedPeer = {
  peerId: 'abcdef',
  connection: 'failed',
  ice: 'failed',
  gathering: 'complete',
  failed: true,
  localType: null,
  remoteType: null,
}

describe('summarise', () => {
  it('says how a working connection is carried', () => {
    const d = diag({
      peers: [{ ...failedPeer, connection: 'connected', ice: 'connected', localType: 'srflx', remoteType: 'srflx' }],
    })
    expect(summarise(d, true)).toBe('Connected via srflx ↔ srflx.')
  })

  it('distinguishes nothing attempted from nobody having joined', () => {
    expect(summarise(diag(), false)).toBe('No peer connection has been attempted yet.')
    expect(summarise(diag({ waiting: 3, gathered: ['host', 'relay', 'srflx'] }), false)).toContain(
      'Nobody has joined yet',
    )
  })

  it('blames the signalling relay when a relay candidate was offered and still failed', () => {
    // The failure this whole panel was rewritten for. A relay candidate pairs
    // with anything, so if one is on offer and nothing pairs, the other side
    // never got it — and saying "symmetric NAT, get TURN" here sends the next
    // person to debug it straight past the actual cause.
    const d = diag({ peers: [failedPeer], gathered: ['host', 'relay', 'srflx'] })
    expect(summarise(d, false)).toContain('never received it')
    expect(summarise(d, false)).not.toContain('symmetric NAT')
  })

  it('calls a symmetric NAT when there was no relay to fall back on', () => {
    const d = diag({ peers: [failedPeer], gathered: ['host', 'srflx'] })
    expect(summarise(d, false)).toContain('symmetric NAT')
  })

  it('calls out a blocked STUN before anything else', () => {
    expect(summarise(diag({ peers: [failedPeer], gathered: ['host'] }), false)).toContain(
      'STUN did not answer',
    )
    expect(summarise(diag({ waiting: 2, gathered: ['host'] }), false)).toContain(
      'STUN did not answer',
    )
  })

  it('refuses to guess while a connection is still in progress', () => {
    const d = diag({
      peers: [{ ...failedPeer, connection: 'connecting', ice: 'checking', failed: false }],
      gathered: ['host', 'srflx'],
    })
    expect(summarise(d, false)).toBe('Still negotiating.')
  })

  it('still reads a failure that has since been closed as a failure', () => {
    // `connectionState` does not keep the news — a failure that gets cleaned up
    // reports `closed` afterwards. Without the latch, the two verdicts above
    // were unreachable by the time anybody opened the panel.
    const d = diag({
      peers: [{ ...failedPeer, connection: 'closed', ice: 'closed', failed: true }],
      gathered: ['host', 'relay', 'srflx'],
    })
    expect(summarise(d, false)).toContain('never received it')
  })

  it('does not treat a peer who left as a connection in trouble', () => {
    // Closed and never failed: somebody left, or this page switched rooms. Left
    // in the reckoning it pinned the verdict on "Still negotiating" forever.
    const d = diag({
      peers: [{ ...failedPeer, connection: 'closed', ice: 'closed', failed: false }],
      waiting: 20,
      gathered: ['host', 'relay', 'srflx'],
    })
    expect(summarise(d, false)).toBe(
      'Nobody is connected. This browser can offer host, relay, srflx, so its half is working.',
    )
  })
})
