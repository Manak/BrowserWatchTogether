/**
 * Every peer connection this page builds, including the ones that never work.
 *
 * The diagnostics panel used to be fed by Trystero's `getPeers()`, which returns
 * the *connected* peers — so the panel that exists to explain a failure could
 * only ever show successes. A room that could not connect reported "no peer
 * connection has been attempted yet" and "candidates gathered: none" directly
 * underneath an error naming the peer it had just failed to reach. Both lines
 * were true about the map it was reading and useless about the problem.
 *
 * Trystero takes an `rtcPolyfill`, which is the seam: hand it a subclass that
 * writes itself down on construction, and the panel sees the whole set —
 * connections that failed, connections still negotiating, and the pooled offers
 * that gather candidates before anybody has joined. That last one is worth more
 * than it sounds: it is how you find out whether STUN and TURN work at all
 * without needing a second person on the other end.
 */

/** The subset of `RTCPeerConnection`'s constructor this needs to stand in for. */
type PeerConnectionClass = typeof RTCPeerConnection

/**
 * Marks a connection that reached `failed`, for as long as we hold it.
 *
 * `connectionState` does not keep the news. A connection fails, something closes
 * it, and it reports `closed` from then on — indistinguishable from a peer who
 * simply left, or from the last room this page was in. Which made the two
 * verdicts that matter unreachable in practice: by the time anybody opened the
 * panel, the evidence had been overwritten by an ordinary shutdown.
 *
 * So it is latched at the moment it happens, on the connection itself. A symbol
 * because this is our note about somebody else's object.
 */
const EVER_FAILED = Symbol('everFailed')

/** Did this connection ever reach `failed`, whatever it says now? */
export function hasEverFailed(pc: RTCPeerConnection): boolean {
  return (pc as unknown as Record<symbol, boolean>)[EVER_FAILED] === true
}

export interface PeerRegistry {
  /**
   * Pass to Trystero as `rtcPolyfill`. Null when the browser has no WebRTC at
   * all, which the caller should treat as "leave it to Trystero".
   */
  readonly connectionClass: PeerConnectionClass | null
  /** Everything built so far, oldest first. */
  built(): RTCPeerConnection[]
}

/**
 * How many connections to hold on to.
 *
 * Trystero keeps a pool of twenty ready offers, so the floor is twenty before a
 * single real peer exists; this leaves room for a mesh and for whatever a
 * reconnect rebuilt on top. There is a cap at all because these are strong
 * references and an `RTCPeerConnection` is not free — this is a diagnostics
 * buffer, not a log. Eviction is oldest-first, which spends the pool entries
 * before it touches anything anybody wants to read.
 */
const KEEP = 40

/**
 * A pooled offer that was closed without ever meeting anybody.
 *
 * Live pool entries are worth keeping — they are what proves this browser can
 * gather a relay candidate before a second person has joined — but one that has
 * been used up and closed says nothing at all, and a roomful of them buries the
 * single failed connection somebody opened the panel to find.
 *
 * A connection that failed is closed too, and is deliberately *not* caught by
 * this: it has a remote description, because it got far enough to have one.
 */
function isSpentOffer(pc: RTCPeerConnection): boolean {
  return pc.signalingState === 'closed' && !pc.remoteDescription
}

let shared: PeerRegistry | null = null

/**
 * The registry, which belongs to the page rather than to a room.
 *
 * It was per-transport, and that lost the record on every rebuild — which is
 * precisely when somebody opens the panel. Two ways it went wrong, both seen:
 * a reconnect started the history over, and Trystero's offer pool is
 * module-global, so a rebuilt room reuses connections the new registry never
 * watched being constructed and reports having built almost nothing.
 *
 * One per page fixes both. `rtcPolyfill` wants a stable class anyway, and the
 * cap still bounds what is held. The one thing it does introduce is a room's
 * connections outliving the room, which `labelConnections` deals with — see the
 * note there on why only the still-connected ones are dropped.
 */
export function sharedPeerRegistry(): PeerRegistry {
  return (shared ??= createPeerRegistry())
}

/** Test seam: a registry of its own, over an injected connection class. */
export function createPeerRegistry(
  base: PeerConnectionClass | undefined = globalThis.RTCPeerConnection,
): PeerRegistry {
  if (!base) return { connectionClass: null, built: () => [] }

  let built: RTCPeerConnection[] = []

  class Recorded extends base {
    constructor(config?: RTCConfiguration) {
      super(config)

      const latch = () => {
        if (this.connectionState === 'failed' || this.iceConnectionState === 'failed') {
          ;(this as unknown as Record<symbol, boolean>)[EVER_FAILED] = true
        }
      }
      // Both, because they do not always arrive together: ICE can fail while
      // `connectionState` is still catching up, and a connection torn down
      // quickly enough can skip straight past the state we were watching for.
      this.addEventListener?.('connectionstatechange', latch)
      this.addEventListener?.('iceconnectionstatechange', latch)

      built.push(this)
      // Sweep on the way in rather than on a timer: the pool creates a
      // connection roughly as often as it retires one, so this keeps up without
      // anything having to run while nothing is happening.
      built = built.filter((pc) => !isSpentOffer(pc))
      // Oldest first out. The newest connections are the ones being asked about.
      if (built.length > KEEP) built = built.slice(built.length - KEEP)
    }
  }

  return { connectionClass: Recorded, built: () => built.filter((pc) => !isSpentOffer(pc)) }
}

/**
 * Name what can be named.
 *
 * Trystero knows the peer id only for connections that completed, and those are
 * the least interesting ones here. The rest are numbered instead — the number is
 * only there to keep two failures apart in a report read off a phone.
 */
export function labelConnections(
  named: Record<string, RTCPeerConnection>,
  built: readonly RTCPeerConnection[],
): Record<string, RTCPeerConnection> {
  const idFor = new Map<RTCPeerConnection, string>()
  for (const [peerId, pc] of Object.entries(named)) idFor.set(pc, peerId.slice(0, 6))

  const out: Record<string, RTCPeerConnection> = {}
  let unnamed = 0
  for (const pc of built) {
    const id = idFor.get(pc)
    // Connected, and this room has never heard of it: it belongs to the room
    // this page was in before. The registry is per page on purpose — a rebuild
    // must not erase the history of what went wrong — but another room's live
    // connection is not history, it is a different conversation, and reported
    // here it holds the verdict on "still negotiating" indefinitely.
    //
    // Only the connected ones. Anything that failed or closed stays, because
    // that is precisely the history worth keeping.
    if (!id && pc.connectionState === 'connected') continue
    out[id ?? `attempt ${++unnamed}`] = pc
  }

  // A connection Trystero knows about but the registry does not means the
  // polyfill was not used — an older Trystero, or a browser that refused the
  // subclass. Better a report with no attempts in it than one missing the peer
  // that is actually connected.
  for (const [peerId, pc] of Object.entries(named)) {
    if (!built.includes(pc)) out[peerId.slice(0, 6)] = pc
  }

  return out
}
