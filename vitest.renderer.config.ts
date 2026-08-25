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
    include: ['src/renderer/src/**/*.test.{ts,tsx}'],
    /**
     * A floor, not a target (roadmap Q #333).
     *
     * The number exists to catch one specific thing: a change that adds a screen's worth of
     * untested logic and quietly drags the whole figure down. It is set just under where the
     * suite actually sits, so it fails on a real drop and not on a rounding difference between
     * two machines.
     *
     * Deliberately not raised to something aspirational. A coverage floor nobody can meet gets
     * lowered the first time it blocks somebody, and then it is a number that means nothing.
     * The screens are covered by the E2E suite, which drives the real built app — measuring them
     * here would count lines that jsdom executes and a user never does.
     *
     * `lib/` and `state/` are what this suite is for: the hooks, the client, the stores and the
     * pure helpers, where a bug is invisible until it is in front of somebody.
     */
    coverage: {
      provider: 'v8',
      include: ['src/renderer/src/lib/**/*.ts', 'src/renderer/src/state/**/*.ts'],
      // Type-only modules and the generated client surface have no branches worth counting.
      exclude: ['**/*.d.ts', 'src/renderer/src/lib/client.ts'],
      reporter: ['text-summary'],
      // Measured at 66.5% lines, 84.3% branches, 49.5% functions. The floors sit a few points
      // under each, which is the margin between "somebody deleted a test" and "two machines
      // disagree about one line". Functions is the lowest of the three because a store's
      // setters are one-liners that a hook test exercises through the hook, never by name.
      thresholds: { lines: 62, statements: 62, functions: 45, branches: 78 }
    }
  }
})
