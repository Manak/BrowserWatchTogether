import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Relative base so the same build works on GitHub Pages project sites
// (https://user.github.io/repo/) and on Netlify / any static host.
export default defineConfig({
  base: './',
  plugins: [react()],
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
