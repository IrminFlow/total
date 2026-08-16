import { defineConfig, configDefaults } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['src/shared/**/*.test.ts', 'src/main/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.dbtest.ts']
  }
})
