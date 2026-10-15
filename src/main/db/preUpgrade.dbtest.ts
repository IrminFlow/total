// Upgrade guard + safe copy before an upgrade: openCompanyDb refuses a file from a NEWER Total
// (db_newer_version, the file left byte-identical) and, before migrating an EXISTING file, writes
// one pre-upgrade copy (encrypted like the books) — no copy, no migration (db_upgrade_copy_failed).
import { afterAll, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'

process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-pre-upgrade-'))
const { openCompanyDb } = await import('./connection')
const { companyBackupsDir, companyDbPath, companyDir, ensureCompanyTree } = await import('../paths')
const { migrate, readSchemaVersion } = await import('./migrate')
const { MIGRATIONS } = await import('./migrations')
const { seedCompany } = await import('./seed')
const { TEST_INFO } = await import('./testdb')
const { assertValidCompanyDb, listBackupsIn } = await import('./backup')
const { forgetAllKeys, isEncryptedFile, openDb, rekeyFile, rememberFolderKey } = await import('./encryption')
const { newDataKey } = await import('./keyEnvelope')
const { bookFacts, removeLeftoverCopies } = await import('../services/dbEncryption')
const { preUpgradeOf, prunePreUpgradeCopies, writePreUpgradeCopy } = await import('./preUpgrade')
const { verifyBackupFile } = await import('../services/backupVerify')
const { userBackupsOf } = await import('../services/dashboard')

afterAll(() => {
  forgetAllKeys()
  rmSync(process.env.TOTAL_DATA_DIR!, { recursive: true, force: true })
})

const N = MIGRATIONS.length
const AS_ON = '2026-03-31'
let n = 0

/** A seeded company file at schema version `version` (the first `version` migrations). */
function companyAt(version: number): string {
  const slug = `co-${++n}`
  ensureCompanyTree(slug)
  const db = new Database(companyDbPath(slug))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db, MIGRATIONS.slice(0, version))
  seedCompany(db, TEST_INFO)
  db.close()
  return slug
}

const preUpgradeFiles = (slug: string): string[] => readdirSync(companyBackupsDir(slug)).filter((f) => preUpgradeOf(f)).sort()

function versionOf(path: string, key?: Buffer): number {
  const db = openDb(path, { readonly: true, fileMustExist: true, ...(key ? { key } : {}) })
  try {
    return readSchemaVersion(db)
  } finally {
    db.close()
  }
}

function factsOf(path: string, key?: Buffer): ReturnType<typeof bookFacts> {
  const db = openDb(path, { readonly: true, fileMustExist: true, ...(key ? { key } : {}) })
  try {
    return bookFacts(db, AS_ON)
  } finally {
    db.close()
  }
}

describe('newer-file guard', () => {
  it('a file with one migration more than this build knows is refused (db_newer_version) and left byte-identical', () => {
    const slug = companyAt(N)
    const raw = new Database(companyDbPath(slug))
    raw.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(N + 1, new Date().toISOString())
    raw.close()
    const before = readFileSync(companyDbPath(slug))
    expect(() => openCompanyDb(slug)).toThrow(expect.objectContaining({ code: 'db_newer_version', message: expect.stringMatching(/newer Total/) }))
    expect(readFileSync(companyDbPath(slug)).equals(before)).toBe(true)
    expect(preUpgradeFiles(slug)).toEqual([])
    // A restore of such a file (and the restore check) refuses it too.
    expect(() => assertValidCompanyDb(companyDbPath(slug))).toThrow(expect.objectContaining({ code: 'db_newer_version' }))
    expect(verifyBackupFile(companyDbPath(slug), { asOn: AS_ON }).ok).toBe(false)
    // migrate() itself refuses (CLI, evals, every other caller).
    const db = new Database(companyDbPath(slug))
    try {
      expect(() => migrate(db)).toThrow(expect.objectContaining({ code: 'db_newer_version' }))
    } finally {
      db.close()
    }
  })
})

describe('safe copy before an upgrade', () => {
  it('a file one version behind gets exactly one copy, at the old version with the same facts; the original is then current', () => {
    const slug = companyAt(N - 1)
    const factsBefore = factsOf(companyDbPath(slug))
    const db = openCompanyDb(slug)
    expect(readSchemaVersion(db)).toBe(N)
    db.close()
    const copies = preUpgradeFiles(slug)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(new RegExp(`^pre-upgrade-${N - 1}-to-${N}-\\d{8}-\\d{6}\\.db$`))
    const copy = join(companyBackupsDir(slug), copies[0]!)
    expect(versionOf(copy)).toBe(N - 1)
    expect(factsOf(copy)).toEqual(factsBefore)
    expect(versionOf(companyDbPath(slug))).toBe(N)
    // Listed with Settings → Backups, labelled by kind.
    const listed = listBackupsIn(companyBackupsDir(slug)).find((b) => b.file === copies[0])
    expect(listed).toMatchObject({ tag: 'pre-upgrade', upgrade: { from: N - 1, to: N } })
    // No temp file left behind.
    expect(readdirSync(companyBackupsDir(slug)).filter((f) => f.includes('tmp'))).toEqual([])
    // Reopening a current file writes no further copy.
    openCompanyDb(slug).close()
    expect(preUpgradeFiles(slug)).toHaveLength(1)
    // The restore check (migrates a scratch copy) still passes on the copy.
    expect(verifyBackupFile(copy, { asOn: AS_ON }).ok).toBe(true)
  })

  it('an encrypted business gets an encrypted copy that opens with its key', () => {
    const slug = companyAt(N - 1)
    const key = newDataKey()
    rekeyFile(companyDbPath(slug), null, key)
    rememberFolderKey(companyDir(slug), key)
    const factsBefore = factsOf(companyDbPath(slug), key)
    openCompanyDb(slug).close()
    const copies = preUpgradeFiles(slug)
    expect(copies).toHaveLength(1)
    const copy = join(companyBackupsDir(slug), copies[0]!)
    expect(isEncryptedFile(copy)).toBe(true)
    expect(() => new Database(copy, { readonly: true }).prepare('SELECT 1 FROM meta').get()).toThrow(/not a database/)
    expect(versionOf(copy, key)).toBe(N - 1)
    expect(factsOf(copy, key)).toEqual(factsBefore)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a copy that cannot be written leaves the original unmigrated and fails the open (db_upgrade_copy_failed)', () => {
    const slug = companyAt(N - 1)
    const before = readFileSync(companyDbPath(slug))
    chmodSync(companyBackupsDir(slug), 0o500) // read-only folder: the copy can't be written
    try {
      expect(() => openCompanyDb(slug)).toThrow(expect.objectContaining({ code: 'db_upgrade_copy_failed', message: expect.stringMatching(/safe copy/) }))
    } finally {
      chmodSync(companyBackupsDir(slug), 0o700)
    }
    expect(versionOf(companyDbPath(slug))).toBe(N - 1)
    expect(readFileSync(companyDbPath(slug)).equals(before)).toBe(true)
    expect(readdirSync(companyBackupsDir(slug))).toEqual([])
  })

  it('a copy that cannot be written (every platform: the target folder is a plain file) throws db_upgrade_copy_failed and leaves no trace', () => {
    const slug = companyAt(N - 1)
    const notAFolder = join(companyDir(slug), 'not-a-folder')
    writeFileSync(notAFolder, 'x')
    const db = new Database(companyDbPath(slug))
    try {
      expect(() => writePreUpgradeCopy(db, notAFolder, N - 1, N)).toThrow(expect.objectContaining({ code: 'db_upgrade_copy_failed', message: expect.stringMatching(/safe copy/) }))
      // The handle is still usable and the file untouched (the open would close it and rethrow).
      expect(readSchemaVersion(db)).toBe(N - 1)
    } finally {
      db.close()
    }
    expect(readFileSync(notAFolder, 'utf8')).toBe('x')
    expect(readdirSync(companyDir(slug)).filter((f) => f.includes('vacuum-tmp') || preUpgradeOf(f))).toEqual([])
    expect(preUpgradeFiles(slug)).toEqual([])
  })

  it('a half-written copy (crash during VACUUM INTO) is swept before the next open and never counts as a copy', () => {
    const slug = companyAt(N - 1)
    const dir = companyBackupsDir(slug)
    const stale = join(dir, `pre-upgrade-${N - 1}-to-${N}-20250101-090000.db.vacuum-tmp`)
    writeFileSync(stale, 'half')
    expect(listBackupsIn(dir)).toEqual([])
    expect(prunePreUpgradeCopies(dir, 0)).toEqual([])
    removeLeftoverCopies(companyDbPath(slug), dir, join(companyDir(slug), 'exports'))
    expect(readdirSync(dir)).toEqual([])
  })

  it('is listed as an automatic backup — never the user\'s (Home\'s nudge and the setup step ignore it)', () => {
    const slug = companyAt(N - 1)
    openCompanyDb(slug).close()
    const listed = listBackupsIn(companyBackupsDir(slug))
    expect(listed.map((b) => b.tag)).toEqual(['pre-upgrade'])
    expect(userBackupsOf(listed)).toEqual([])
  })

  it('keeps only the newest 2 pre-upgrade copies (other backups untouched)', () => {
    const slug = companyAt(N - 1)
    const dir = companyBackupsDir(slug)
    const old = ['pre-upgrade-40-to-45-20250101-090000.db', 'pre-upgrade-45-to-48-20250601-090000.db', 'pre-upgrade-48-to-50-20251001-090000.db']
    for (const [i, f] of old.entries()) {
      writeFileSync(join(dir, f), 'x')
      const t = new Date(2025, i * 4, 1)
      utimesSync(join(dir, f), t, t)
    }
    copyFileSync(companyDbPath(slug), join(dir, '2025-01-01T09-00-00-manual.db'))
    openCompanyDb(slug).close()
    const kept = preUpgradeFiles(slug)
    expect(kept).toHaveLength(2)
    expect(kept).toContain('pre-upgrade-48-to-50-20251001-090000.db')
    expect(kept.some((f) => f.startsWith(`pre-upgrade-${N - 1}-to-${N}-`))).toBe(true)
    expect(readdirSync(dir)).toContain('2025-01-01T09-00-00-manual.db')
    // The pruner alone, too.
    expect(prunePreUpgradeCopies(dir, 1)).toEqual(['pre-upgrade-48-to-50-20251001-090000.db'])
  })

  it('a brand-new file and a current file get no copy', () => {
    const slug = `fresh-${++n}`
    openCompanyDb(slug).close() // version 0 → migrated from scratch
    expect(preUpgradeFiles(slug)).toEqual([])
    const current = companyAt(N)
    openCompanyDb(current).close()
    expect(preUpgradeFiles(current)).toEqual([])
  })

  it('the restore path (preUpgradeCopy: false) migrates without a copy', () => {
    const slug = companyAt(N - 1)
    openCompanyDb(slug, { preUpgradeCopy: false }).close()
    expect(versionOf(companyDbPath(slug))).toBe(N)
    expect(preUpgradeFiles(slug)).toEqual([])
  })
})
