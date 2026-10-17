import { defineConfig, configDefaults } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    // hi / hinglish are registered catalogues (the renderer loads them on demand); tests see all three.
    setupFiles: ['src/shared/i18n/all.ts'],
    // WP 7.4: like the renderer / DB configs — property tests, source lints and scrypt PIN hashing
    // passed alone but hit vitest's 5 s default in a loaded full run (valuationPass, simpleLint,
    // authcrypt); they are correctness-, not latency-, sensitive.
    testTimeout: 30000,
    include: ['src/shared/**/*.test.ts', 'src/main/**/*.test.ts', 'src/preload/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.dbtest.ts']
  }
})
