// TEMPORARY WP 7.3 diagnostic (removed before merge): how long the demo seed takes per
// PRAGMA synchronous mode, and the ipc import, on this machine.
import { describe, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('timing', () => {
  it('demo company per synchronous mode', async () => {
    const { createDemoCompany } = await import('./services/demo')
    for (const mode of ['', 'normal', 'off', '', 'normal', 'off']) {
      process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'zz-timing-'))
      if (mode) process.env.TOTAL_TEST_DB_SYNCHRONOUS = mode
      else delete process.env.TOTAL_TEST_DB_SYNCHRONOUS
      const t = performance.now()
      createDemoCompany()
      console.log(`TIMING demo synchronous=${mode || 'FULL(default)'} ${Math.round(performance.now() - t)} ms`)
    }
    delete process.env.TOTAL_TEST_DB_SYNCHRONOUS
  }, 300000)
})
