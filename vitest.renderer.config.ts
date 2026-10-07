// Renderer (React) test config — `npm run test:renderer`. jsdom + React Testing Library for
// hook/helper tests under src/renderer/src/**/*.test.{ts,tsx}. Kept separate from the engine
// config (vitest.config.ts) so `npm test` stays pure-TS with no DOM, and from the DB config
// (vitest.db.config.ts) which runs under Electron-as-Node.
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'jsdom',
    // jsdom + React render tests flake past vitest's 5s default when the machine is loaded
    // (parallel gates, e2e running alongside); they are correctness-, not latency-, sensitive.
    testTimeout: 30000,
    include: ['src/renderer/src/**/*.test.{ts,tsx}']
  }
})
