// WP 7.3 review: the fsync-off test pragma can never reach real books.
import { describe, expect, it } from 'vitest'
import { testSynchronous } from './testPragmas'

describe('testSynchronous', () => {
  const scratch = { TOTAL_DATA_DIR: '/tmp/x', VITEST: 'true' }
  it('applies inside a vitest worker with a data dir', () => {
    expect(testSynchronous({ ...scratch, TOTAL_TEST_DB_SYNCHRONOUS: 'off' })).toBe('OFF')
    expect(testSynchronous({ ...scratch, TOTAL_TEST_DB_SYNCHRONOUS: 'NORMAL' })).toBe('NORMAL')
    expect(testSynchronous({ ...scratch, TOTAL_TEST_DB_SYNCHRONOUS: 'full' })).toBeNull()
    expect(testSynchronous(scratch)).toBeNull()
  })
  it('never applies outside vitest — the app or the CLI (which sets TOTAL_DATA_DIR to the real folder)', () => {
    expect(testSynchronous({ TOTAL_DATA_DIR: 'C:\\Users\\a\\Documents\\total', TOTAL_TEST_DB_SYNCHRONOUS: 'off' })).toBeNull()
    expect(testSynchronous({ VITEST: 'true', TOTAL_TEST_DB_SYNCHRONOUS: 'off' })).toBeNull()
  })
})
