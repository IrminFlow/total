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
    setupFiles: ['./vitest.renderer.setup.ts'],
    include: ['src/renderer/src/**/*.test.{ts,tsx}']
  }
})
