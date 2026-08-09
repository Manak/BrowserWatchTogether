import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { signalDevMiddleware } from './src/signal/devMiddleware.ts'

/**
 * The signalling relay is a Netlify function in production. Dev serves the same
 * handler from the same path, so `npm run dev` joins rooms for real rather than
 * needing the Netlify CLI in front of it.
 */
const signalRelay: Plugin = {
  name: 'watch-together-signal-relay',
  configureServer(server) {
    server.middlewares.use(signalDevMiddleware())
  },
  configurePreviewServer(server) {
    server.middlewares.use(signalDevMiddleware())
  },
}

// Relative base so the same build works from a subpath and on any static host.
export default defineConfig({
  base: './',
  plugins: [react(), signalRelay],
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
})
