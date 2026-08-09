import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleSignal } from './relay.ts'
import { MemoryStore } from './store.ts'
import { handleTurn, turnKeyFromEnv } from './turn.ts'

/**
 * The signalling relay under `npm run dev`.
 *
 * Running the same handler the deployed function runs, so a room joins locally
 * exactly as it joins in production and "it worked in dev" cannot happen. The
 * store is in memory, which is correct here for the reason it would be wrong
 * there: one dev server is one process, and two browser windows on one laptop
 * are the whole audience.
 */
export function signalDevMiddleware(path = '/api/signal') {
  const store = new MemoryStore()

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = req.url ?? ''
    if (!url.startsWith(path)) {
      next()
      return
    }

    const body =
      req.method === 'POST'
        ? await new Promise<string>((resolve) => {
            let raw = ''
            req.on('data', (chunk) => (raw += chunk))
            req.on('end', () => resolve(raw))
          })
        : undefined

    const result = await handleSignal({ method: req.method ?? 'GET', url, body }, store)
    res.statusCode = result.status
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
    res.end(result.body)
  }
}

/**
 * TURN credentials under `npm run dev`.
 *
 * Running the same handler the deployed function runs. Nothing is required:
 * with no TURN_KEY_ID set this answers 503, the app falls back to STUN, and
 * local development carries on exactly as it did before TURN existed — which is
 * what you want, since two browsers on one laptop have never needed a relay to
 * find each other.
 *
 * The environment is passed in rather than read from `process.env`, because
 * under Vite it is not there: Vite reads `.env` files into its own object and
 * only exposes prefixed names to client code. The config calls `loadEnv` and
 * hands the result here, which also keeps the key on one path — into this
 * server-side handler — with no route by which it could reach the bundle.
 */
export function turnDevMiddleware(
  env: Record<string, string | undefined>,
  path = '/api/turn',
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    if (!(req.url ?? '').startsWith(path)) {
      next()
      return
    }

    const result = await handleTurn(turnKeyFromEnv(env))
    res.statusCode = result.status
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
    res.end(result.body)
  }
}
