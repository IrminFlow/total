// Lane Q, task Q3 #99: registry write lock (lockfile beside registry.json). Runs under the
// dbtest suite because registry.ts sits behind paths.ts (Electron import) — TOTAL_DATA_DIR keeps
// everything inside a scratch dir, mirroring how the app's hermetic drivers run.
import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readRegistry,
  removeCompany,
  requireRegisteredCompany,
  touchLastOpened,
  upsertCompany,
  withRegistryLock
} from './registry'
import { companiesDir, companyDir, registryPath } from './paths'

function summary(slug: string) {
  return { slug, name: slug.toUpperCase(), stateCode: '27', gstin: null, lastOpenedAt: null }
}

describe('registry write lock', () => {
  beforeEach(() => {
    process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-registry-'))
  })

  it('read-modify-write helpers work and clean up the lockfile afterwards', () => {
    upsertCompany(summary('alpha'))
    touchLastOpened('alpha')
    upsertCompany(summary('beta'))
    removeCompany('beta')

    const reg = readRegistry()
    expect(reg.companies.map((c) => c.slug)).toEqual(['alpha'])
    expect(reg.lastOpened).toBe('alpha')
    expect(existsSync(`${registryPath()}.lock`)).toBe(false)
  })

  it('a fresh lock held by another process blocks the write until the wait deadline', () => {
    const lock = `${registryPath()}.lock`
    writeFileSync(lock, '99999', { flag: 'wx' })

    const started = Date.now()
    expect(() => upsertCompany(summary('gamma'))).toThrow(/registry is locked/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    // The foreign lock was NOT clobbered.
    expect(readFileSync(lock, 'utf8')).toBe('99999')
    expect(readRegistry().companies).toHaveLength(0)
  })

  it('a stale lock (crashed writer) is broken and the write proceeds', () => {
    const lock = `${registryPath()}.lock`
    writeFileSync(lock, '99999', { flag: 'wx' })
    const past = (Date.now() - 60_000) / 1000
    utimesSync(lock, past, past)

    upsertCompany(summary('delta'))
    expect(readRegistry().companies.map((c) => c.slug)).toEqual(['delta'])
    expect(existsSync(lock)).toBe(false)
  })

  it('withRegistryLock releases the lock even when the callback throws', () => {
    expect(() =>
      withRegistryLock(() => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(existsSync(`${registryPath()}.lock`)).toBe(false)
    // And a subsequent locked write still works.
    upsertCompany(summary('epsilon'))
    expect(readRegistry().companies).toHaveLength(1)
  })

  it('rejects traversal and unregistered on-disk company identifiers', () => {
    expect(() => companyDir('../outside')).toThrow('Invalid company identifier')
    const unregistered = companyDir('not-registered')
    mkdirSync(unregistered, { recursive: true })
    writeFileSync(join(unregistered, 'company.db'), 'placeholder')
    expect(() => requireRegisteredCompany('not-registered')).toThrow('Company not found')
  })

  it('resolves a canonical registered company only when its DB path is contained and regular', () => {
    const directory = companyDir('alpha')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'company.db'), 'placeholder')
    upsertCompany(summary('alpha'))
    expect(requireRegisteredCompany('alpha').paths.database).toBe(join(directory, 'company.db'))

    const outside = mkdtempSync(join(tmpdir(), 'total-registry-outside-'))
    writeFileSync(join(outside, 'company.db'), 'outside')
    symlinkSync(outside, join(companiesDir(), 'linked-company'))
    upsertCompany(summary('linked-company'))
    expect(() => requireRegisteredCompany('linked-company')).toThrow('regular directory')
  })
})
