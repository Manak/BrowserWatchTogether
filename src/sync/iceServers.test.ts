import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ICE_SERVERS,
  forgetIceServers,
  loadIceServers,
} from './iceServers'

/**
 * The one property that matters here is that a room always gets *something*.
 * TURN is a rescue for the minority of pairs that cannot connect directly, and
 * every way it can fail has to end with the majority still joining.
 */

const TURN: RTCIceServer = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
  username: 'user',
  credential: 'pass',
}

let clock = 1_000_000
const now = () => clock

function ok(expiresAt: number): Response {
  return new Response(JSON.stringify({ iceServers: [TURN], expiresAt }), { status: 200 })
}

beforeEach(() => {
  clock = 1_000_000
  forgetIceServers()
})

describe('loadIceServers', () => {
  it('offers TURN alongside the STUN servers, never instead of them', async () => {
    // Both matter: ICE prefers a direct path and only falls back to the relay,
    // so dropping STUN would push every room through TURN.
    const fetcher = vi.fn().mockResolvedValue(ok(clock + 3_600_000))

    const servers = await loadIceServers(fetcher as unknown as typeof fetch, now)

    expect(servers).toEqual([...DEFAULT_ICE_SERVERS, TURN])
  })

  it('asks once and serves the rest from memory', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok(clock + 3_600_000))

    await loadIceServers(fetcher as unknown as typeof fetch, now)
    clock += 1000
    await loadIceServers(fetcher as unknown as typeof fetch, now)

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('shares one request between peers built in the same tick', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok(clock + 3_600_000))

    await Promise.all([
      loadIceServers(fetcher as unknown as typeof fetch, now),
      loadIceServers(fetcher as unknown as typeof fetch, now),
      loadIceServers(fetcher as unknown as typeof fetch, now),
    ])

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('re-mints before the credential expires, not after', async () => {
    // A credential that dies mid-film takes the connection with it, and the
    // room cannot tell that apart from the network going away.
    const fetcher = vi.fn().mockResolvedValue(ok(clock + 3_600_000))
    await loadIceServers(fetcher as unknown as typeof fetch, now)

    // Inside the refresh margin, still short of the stated expiry.
    clock += 3_600_000 - 60_000
    await loadIceServers(fetcher as unknown as typeof fetch, now)

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  describe('when TURN is unavailable', () => {
    it('joins on STUN alone rather than failing', async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 503 }))

      const servers = await loadIceServers(fetcher as unknown as typeof fetch, now)

      expect(servers).toEqual(DEFAULT_ICE_SERVERS)
    })

    it('survives the endpoint being unreachable', async () => {
      const fetcher = vi.fn().mockRejectedValue(new Error('offline'))

      const servers = await loadIceServers(fetcher as unknown as typeof fetch, now)

      expect(servers).toEqual(DEFAULT_ICE_SERVERS)
    })

    it('survives a reply with no servers in it', async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ iceServers: [] }), { status: 200 }))

      const servers = await loadIceServers(fetcher as unknown as typeof fetch, now)

      expect(servers).toEqual(DEFAULT_ICE_SERVERS)
    })

    it('does not re-ask on every reconnect', async () => {
      // A waking phone rebuilds the transport several times a minute, and each
      // rebuild asks for ICE servers. Without a floor that is a request loop
      // against an endpoint already known to be unhappy.
      const fetcher = vi.fn().mockRejectedValue(new Error('offline'))

      await loadIceServers(fetcher as unknown as typeof fetch, now)
      clock += 5000
      await loadIceServers(fetcher as unknown as typeof fetch, now)

      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('tries again once the floor has passed', async () => {
      const fetcher = vi.fn().mockRejectedValue(new Error('offline'))
      await loadIceServers(fetcher as unknown as typeof fetch, now)

      clock += 61_000
      await loadIceServers(fetcher as unknown as typeof fetch, now)

      expect(fetcher).toHaveBeenCalledTimes(2)
    })
  })
})
