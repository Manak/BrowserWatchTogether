import { describe, expect, it, vi } from 'vitest'
import {
  CREDENTIAL_TTL_SECONDS,
  handleTurn,
  turnKeyFromEnv,
  type TurnCredentials,
} from './turn'

/**
 * The credentials endpoint stands between an account secret and a browser. The
 * two things worth testing are that it hands over something usable, and that it
 * never hands over anything else — including when the provider misbehaves.
 */

const KEY = { keyId: 'key-1', apiToken: 'secret-token' }
const NOW = 1_700_000_000_000
const now = () => NOW

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function body(res: { body: string }): TurnCredentials & { error?: string } {
  return JSON.parse(res.body) as TurnCredentials & { error?: string }
}

const CLOUDFLARE_REPLY = {
  iceServers: {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ],
    username: 'user-abc',
    credential: 'pass-xyz',
  },
}

describe('handleTurn', () => {
  it('mints credentials and says when they die', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(CLOUDFLARE_REPLY))

    const res = await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

    expect(res.status).toBe(200)
    expect(body(res).iceServers).toEqual([
      {
        urls: CLOUDFLARE_REPLY.iceServers.urls,
        username: 'user-abc',
        credential: 'pass-xyz',
      },
    ])
    expect(body(res).expiresAt).toBe(NOW + CREDENTIAL_TTL_SECONDS * 1000)
  })

  it('asks the provider with the key and a ttl', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(CLOUDFLARE_REPLY))

    await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/turn/keys/key-1/credentials/generate-ice-servers')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-token',
    )
    expect(JSON.parse(init.body as string)).toEqual({ ttl: CREDENTIAL_TTL_SECONDS })
  })

  it('never caches a credential that expires', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(CLOUDFLARE_REPLY))

    const res = await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

    expect(res.headers['Cache-Control']).toBe('no-store')
  })

  it('accepts a list as readily as a single server', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        iceServers: [
          { urls: 'turn:one.example:3478', username: 'a', credential: 'b' },
          { urls: ['turn:two.example:3478'] },
        ],
      }),
    )

    const res = await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

    expect(body(res).iceServers).toEqual([
      { urls: ['turn:one.example:3478'], username: 'a', credential: 'b' },
      { urls: ['turn:two.example:3478'] },
    ])
  })

  it('drops a server the browser could not use', async () => {
    // One bad entry fails the whole RTCPeerConnection, not just itself, so a
    // half-usable reply has to arrive here as its usable half.
    const fetcher = vi.fn().mockResolvedValue(
      json({
        iceServers: [
          { username: 'no urls at all' },
          { urls: [] },
          { urls: 'turn:good.example:3478' },
        ],
      }),
    )

    const res = await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

    expect(body(res).iceServers).toEqual([{ urls: ['turn:good.example:3478'] }])
  })

  describe('when it cannot mint anything', () => {
    it('says so plainly with no key configured', async () => {
      const fetcher = vi.fn()

      const res = await handleTurn(null, fetcher as unknown as typeof fetch, now)

      // A deployment without a TURN account is a supported state, not a fault.
      expect(res.status).toBe(503)
      expect(fetcher).not.toHaveBeenCalled()
    })

    it('does not echo the provider back to the browser', async () => {
      // The upstream body is the one place an account id could surface.
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response('{"error":"key 1234abcd is over quota"}', { status: 429 }))

      const res = await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

      expect(res.status).toBe(502)
      expect(res.body).not.toContain('1234abcd')
      expect(body(res).error).toBe('The TURN provider said 429.')
    })

    it('survives the provider being unreachable', async () => {
      const fetcher = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))

      const res = await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

      expect(res.status).toBe(502)
    })

    it('survives the provider talking nonsense', async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))

      const res = await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

      expect(res.status).toBe(502)
    })

    it('refuses a reply with nothing usable in it', async () => {
      const fetcher = vi.fn().mockResolvedValue(json({ iceServers: [{ urls: [] }] }))

      const res = await handleTurn(KEY, fetcher as unknown as typeof fetch, now)

      expect(res.status).toBe(502)
    })
  })
})

describe('turnKeyFromEnv', () => {
  it('reads both halves', () => {
    expect(
      turnKeyFromEnv({ TURN_KEY_ID: 'a', TURN_KEY_API_TOKEN: 'b' }),
    ).toEqual({ keyId: 'a', apiToken: 'b' })
  })

  it('treats half a key as no key', () => {
    // Half-configured is the likeliest deployment mistake, and it must fail the
    // same soft way as not configured at all rather than sending a bad request.
    expect(turnKeyFromEnv({ TURN_KEY_ID: 'a' })).toBeNull()
    expect(turnKeyFromEnv({ TURN_KEY_API_TOKEN: 'b' })).toBeNull()
    expect(turnKeyFromEnv({})).toBeNull()
  })
})
