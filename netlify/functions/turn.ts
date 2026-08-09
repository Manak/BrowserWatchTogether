import { handleTurn, turnKeyFromEnv } from '../../src/signal/turn'

/**
 * TURN credentials, deployed.
 *
 * All the logic lives in `src/signal/turn.ts`, which knows nothing about
 * Netlify or about where its key came from; this file is the few lines that
 * connect it to a request and to the environment. The same handler runs under
 * `npm run dev` through a Vite middleware, so there is one implementation.
 *
 * TURN_KEY_ID and TURN_KEY_API_TOKEN are set in Netlify's environment, not in
 * this repository. Without them the handler answers 503 and the app runs on
 * STUN alone, which is the correct behaviour for a fork or a preview deploy
 * that has no TURN account of its own.
 */

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }

  const res = await handleTurn(turnKeyFromEnv(process.env))
  return new Response(res.body, { status: res.status, headers: res.headers })
}

// Routed by netlify.toml rather than by a `config.path` here, to keep it next
// to the SPA catch-all it has to beat — the same ordering trap the signalling
// route documents.
