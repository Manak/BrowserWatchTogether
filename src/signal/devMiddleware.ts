import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleSignal } from './relay.ts'
import { MemoryStore } from './store.ts'

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
