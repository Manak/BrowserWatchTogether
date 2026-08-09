import { getStore } from '@netlify/blobs'
import { handleSignal } from '../../src/signal/relay'
import type { SignalStore } from '../../src/signal/store'

/**
 * The signalling relay, deployed.
 *
 * All the logic lives in `src/signal/relay.ts`, which knows nothing about
 * Netlify; this file is the thirty lines that connect it to a request and to
 * Netlify Blobs. The same handler runs under `npm run dev` through a Vite
 * middleware, so there is one implementation and no "works in dev only".
 *
 * Blobs rather than memory because every invocation is potentially a different
 * process: a peer's offer must be readable by an invocation that did not write
 * it, which is the entire job. Strong consistency for the same reason — an
 * offer that has not propagated yet is an offer that was never made.
 */

const store: SignalStore = {
  async put(key, value) {
    await blobs().set(key, value)
  },
  async list(prefix) {
    const { blobs: found } = await blobs().list({ prefix })
    return found.map((b) => b.key)
  },
  async get(key) {
    return (await blobs().get(key, { type: 'text' })) ?? null
  },
  async delete(key) {
    await blobs().delete(key)
  },
}

function blobs() {
  return getStore({ name: 'signal', consistency: 'strong' })
}

export default async (req: Request): Promise<Response> => {
  const res = await handleSignal(
    {
      method: req.method,
      url: req.url,
      body: req.method === 'POST' ? await req.text() : undefined,
    },
    store,
  )
  return new Response(res.body, { status: res.status, headers: res.headers })
}

// Routed by netlify.toml rather than by a `config.path` here, so that the rule
// sits next to the catch-all it has to beat and the ordering is visible in one
// file. Served from the app's own origin, so the client needs no configuration
// and there is no CORS.
