import { defineConfig } from 'vitest/config'
import { loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { signalDevMiddleware, turnDevMiddleware } from './src/signal/devMiddleware.ts'

/**
 * The signalling relay and the TURN credentials endpoint are Netlify functions
 * in production. Dev serves the same handlers from the same paths, so
 * `npm run dev` joins rooms for real rather than needing the Netlify CLI in
 * front of it.
 */
function apiRoutes(env: Record<string, string>): Plugin {
  const use = (server: { middlewares: { use: (fn: never) => unknown } }) => {
    server.middlewares.use(signalDevMiddleware() as never)
    server.middlewares.use(turnDevMiddleware(env) as never)
  }
  return {
    name: 'watch-together-api',
    configureServer: use,
    configurePreviewServer: use,
  }
}

// Relative base so the same build works from a subpath and on any static host.
export default defineConfig(({ mode }) => {
  /**
   * Every name, not just the `VITE_` ones — the TURN key is deliberately
   * unprefixed so that Vite will not expose it to client code even by accident.
   * It is read here and handed straight to the dev middleware, which runs in
   * the Node process; nothing in this object reaches `define` or the bundle.
   */
  const env = loadEnv(mode, process.cwd(), '')

  return {
    base: './',
    plugins: [react(), apiRoutes(env)],
    build: {
      target: 'es2020',
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      coverage: {
        reporter: ['text', 'lcov'],
        include: ['src/lib/**', 'src/sync/**'],
      },
    },
  }
})
