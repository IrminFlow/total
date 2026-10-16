// To-do §8 test gap (GPT review): an upgrade over SEVERAL migrations that fails midway. The runner
// commits each migration on its own, so the file is left at the last migration that fully applied
// (nothing of the failing one), the pre-upgrade copy taken before the first one stays, and the
// next open — once the fault is gone — applies the rest.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { testFileDb } from './testdb'

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-interrupted-upgrade-'))
const { openCompanyDb } = await import('./connection')
const { companyBackupsDir, companyDbPath, ensureCompanyTree } = await import('../paths')
const { migrate, readSchemaVersion } = await import('./migrate')
const { MIGRATIONS } = await import('./migrations')
const { seedCompany } = await import('./seed')
const { TEST_INFO, postSimpleVoucher } = await import('./testdb')
const { FOREIGN_KEYS_OFF_MARKER } = await import('./migrate')
const { preUpgradeOf } = await import('./preUpgrade')
const { bookFacts } = await import('../services/dbEncryption')

const N = MIGRATIONS.length
const BEHIND = 3
/** The pending migration (0-based index) that fails: the second of the three. */
const FAULTY = N - BEHIND + 1
const ORIGINAL = MIGRATIONS[FAULTY]!
const AS_ON = '2026-03-31'

afterEach(() => {
  MIGRATIONS[FAULTY] = ORIGINAL
})
afterAll(() => {
  MIGRATIONS[FAULTY] = ORIGINAL
  rmSync(process.env.TOTAL_DATA_DIR!, { recursive: true, force: true })
})

function readOnly<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** Every schema object (type, name, sql), sorted — what "no partial migration" is compared on. */
const schemaOf = (db: Database.Database): unknown[] =>
  db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()

describe('an upgrade interrupted midway', () => {
  it('stops at the last whole migration, keeps the pre-upgrade copy, and the next open finishes the job', () => {
    const slug = 'interrupted'
    ensureCompanyTree(slug)
    const path = companyDbPath(slug)
    const raw = testFileDb(path)
    try {
      raw.pragma('journal_mode = WAL')
      raw.pragma('foreign_keys = ON')
      migrate(raw, MIGRATIONS.slice(0, N - BEHIND))
      seedCompany(raw, TEST_INFO)
      postSimpleVoucher(raw, { date: '2025-05-01', amount: 12_345, kind: 'receipt' })
    } finally {
      raw.close()
    }
    const factsBefore = readOnly(path, (db) => bookFacts(db, AS_ON))
    expect(factsBefore.movementDebit).toBeGreaterThan(0)

    // The reference: the same file with only the migrations before the faulty one.
    const refPath = join(process.env.TOTAL_DATA_DIR!, 'reference.db')
    const ref = testFileDb(refPath)
    try {
      migrate(ref, MIGRATIONS.slice(0, FAULTY))
    } finally {
      ref.close()
    }

    // The faulty migration does its own work first, then a statement fails.
    MIGRATIONS[FAULTY] = `${ORIGINAL}\nINSERT INTO no_such_table_upgrade_fault VALUES (1);\n`
    expect(() => openCompanyDb(slug)).toThrow(/no_such_table_upgrade_fault/)

    // Left at the last migration that applied whole — and nothing of the failing one.
    expect(readOnly(path, readSchemaVersion)).toBe(FAULTY)
    expect(readOnly(path, schemaOf)).toEqual(readOnly(refPath, schemaOf))
    // The books are as they were: every table holds what it held, the trial balance moves the same.
    const factsMid = readOnly(path, (db) => bookFacts(db, AS_ON))
    for (const [table, count] of Object.entries(factsBefore.tables)) {
      expect([table, factsMid.tables[table]]).toEqual([table, table === 'migrations' ? count + 1 : count])
    }
    expect([factsMid.movementDebit, factsMid.movementCredit]).toEqual([factsBefore.movementDebit, factsBefore.movementCredit])

    // The copy taken before the first migration is there, at the old version.
    const copies = readdirSync(companyBackupsDir(slug)).filter((f) => preUpgradeOf(f)).sort()
    expect(copies).toHaveLength(1)
    expect(preUpgradeOf(copies[0]!)).toMatchObject({ from: N - BEHIND, to: N })
    expect(readOnly(join(companyBackupsDir(slug), copies[0]!), readSchemaVersion)).toBe(N - BEHIND)

    // Fault removed: the next open applies the remaining migrations.
    MIGRATIONS[FAULTY] = ORIGINAL
    const db = openCompanyDb(slug)
    try {
      expect(readSchemaVersion(db)).toBe(N)
      expect(db.prepare('SELECT id FROM migrations ORDER BY id').all().map((r) => (r as { id: number }).id)).toEqual(Array.from({ length: N }, (_, i) => i + 1))
      expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    } finally {
      db.close()
    }
    const factsAfter = readOnly(path, (d) => bookFacts(d, AS_ON))
    expect([factsAfter.movementDebit, factsAfter.movementCredit]).toEqual([factsBefore.movementDebit, factsBefore.movementCredit])
    expect(factsAfter.migrations).toBe(N)
    // That open was an upgrade too (from FAULTY): it took its own copy; both stay (PRE_UPGRADE_KEEP = 2).
    const after = readdirSync(companyBackupsDir(slug)).filter((f) => preUpgradeOf(f))
    expect(after.map((f) => preUpgradeOf(f)!.from).sort()).toEqual([N - BEHIND, FAULTY].sort())
  })

  it('retries that fail again never prune the copy taken at the old version', () => {
    // Each failed open (and the one that finally succeeds) takes a copy from the half-upgraded
    // version; keep-newest-2 must not push out the only copy the previous Total can open.
    const slug = 'interrupted-twice'
    ensureCompanyTree(slug)
    const raw = testFileDb(companyDbPath(slug))
    try {
      raw.pragma('journal_mode = WAL')
      migrate(raw, MIGRATIONS.slice(0, N - BEHIND))
      seedCompany(raw, TEST_INFO)
    } finally {
      raw.close()
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      MIGRATIONS[FAULTY] = `${ORIGINAL}\nINSERT INTO no_such_table_upgrade_fault VALUES (1);\n`
      for (const [i, t] of ['2026-10-01T09:00:00', '2026-10-01T09:05:00'].entries()) {
        vi.setSystemTime(new Date(t))
        expect(() => openCompanyDb(slug), `attempt ${i + 1}`).toThrow(/no_such_table_upgrade_fault/)
      }
      MIGRATIONS[FAULTY] = ORIGINAL
      vi.setSystemTime(new Date('2026-10-01T09:10:00'))
      openCompanyDb(slug).close()
    } finally {
      vi.useRealTimers()
    }
    const froms = readdirSync(companyBackupsDir(slug)).map((f) => preUpgradeOf(f)?.from).filter((f) => f !== undefined)
    expect(froms).toContain(N - BEHIND)
    expect(froms).toContain(FAULTY)
  })

  it('a failing table-rebuild migration (foreign keys off) rolls back whole and turns enforcement back on', () => {
    // The last migration that rebuilds a table, with the one before it still pending too.
    const rebuild = MIGRATIONS.map((m, i) => (m.trimStart().startsWith(FOREIGN_KEYS_OFF_MARKER) ? i : -1)).filter((i) => i > 0).pop()!
    const original = MIGRATIONS[rebuild]!
    const path = join(process.env.TOTAL_DATA_DIR!, 'rebuild.db')
    const refPath = join(process.env.TOTAL_DATA_DIR!, 'rebuild-ref.db')
    const ref = testFileDb(refPath)
    try {
      migrate(ref, MIGRATIONS.slice(0, rebuild))
    } finally {
      ref.close()
    }
    const db = testFileDb(path)
    try {
      db.pragma('foreign_keys = ON')
      migrate(db, MIGRATIONS.slice(0, rebuild - 1))
      const faulty = [...MIGRATIONS]
      faulty[rebuild] = `${original}\nINSERT INTO no_such_table_upgrade_fault VALUES (1);\n`
      expect(() => migrate(db, faulty)).toThrow(/no_such_table_upgrade_fault/)
      expect(readSchemaVersion(db)).toBe(rebuild)
      expect(schemaOf(db)).toEqual(readOnly(refPath, schemaOf))
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(db.pragma('foreign_key_check')).toEqual([])
      migrate(db)
      expect(readSchemaVersion(db)).toBe(N)
    } finally {
      db.close()
    }
  })
})
