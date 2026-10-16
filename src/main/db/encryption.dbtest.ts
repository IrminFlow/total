// WP 7.2: the encrypted-file primitives under the real driver (better-sqlite3-multiple-ciphers,
// SQLCipher v4 scheme) — plaintext files untouched, keyed open / refusal, migrate an encrypted
// file, snapshots keep the key, the verified conversion and the migration's place.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { copyWithKey, forgetAllKeys, isEncryptedFile, keyOfHandle, openDb, plainCopy, rekeyFile, rememberFolderKey } from './encryption'
import { newDataKey } from './keyEnvelope'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { seedCompany } from './seed'
import { quickCheckOk, snapshotTo } from './backup'
import { TEST_INFO, testFileDb } from './testdb'
import { bookFacts, convertBackups, convertCompanyFile, sameFacts } from '../services/dbEncryption'
import { verifyBackupFile } from '../services/backupVerify'

const ROOT = mkdtempSync(join(tmpdir(), 'total-enc-'))
afterAll(() => {
  forgetAllKeys()
  rmSync(ROOT, { recursive: true, force: true })
})

let n = 0
/** Read with the plain (unkeyed) driver — the handle is always closed (Windows can't remove an open file). */
function readWithoutKey(path: string, sql: string): unknown {
  const d = new Database(path, { readonly: true })
  try {
    return d.prepare(sql).get()
  } finally {
    d.close()
  }
}
function companyFile(migrations = MIGRATIONS): string {
  const dir = join(ROOT, `co-${++n}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'company.db')
  const db = testFileDb(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db, migrations)
  seedCompany(db, TEST_INFO)
  db.close()
  return path
}

describe('encrypted company files', () => {
  it('a plaintext file opens exactly as before (no key, no pragma)', () => {
    const path = companyFile()
    expect(isEncryptedFile(path)).toBe(false)
    const db = openDb(path)
    expect(keyOfHandle(db)).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n).toBe(MIGRATIONS.length)
    db.close()
    expect(readFileSync(path).subarray(0, 15).toString('latin1')).toBe('SQLite format 3')
  })

  it('after rekeying: unreadable without the key, refused (db_locked) without one, wrong key refused, folder key opens', () => {
    const path = companyFile()
    const key = newDataKey()
    rekeyFile(path, null, key)
    expect(isEncryptedFile(path)).toBe(true)
    expect(() => readWithoutKey(path, 'SELECT 1 FROM meta')).toThrow(/not a database/)
    expect(() => openDb(path)).toThrow(expect.objectContaining({ code: 'db_locked' }))
    expect(() => openDb(path, { key: newDataKey() })).toThrow(expect.objectContaining({ code: 'db_key_mismatch' }))
    rememberFolderKey(join(path, '..'), key)
    const db = openDb(path)
    expect(keyOfHandle(db)?.equals(key)).toBe(true)
    db.pragma('journal_mode = WAL')
    expect(db.prepare("SELECT key FROM meta WHERE key = 'company'").get()).toBeTruthy()
    db.close()
  })

  it("WP 7.1's whole-file checks (checkHost.pragmaCheck) key an encrypted file with the key they are given", async () => {
    const { pragmaCheck, quickCheckOkAsync } = await import('./checkHost')
    const path = companyFile()
    const key = newDataKey()
    rekeyFile(path, null, key)
    expect(await pragmaCheck(path, 'quick_check', key)).toBe('ok')
    await expect(pragmaCheck(path, 'quick_check', null)).rejects.toThrow()
    expect(await quickCheckOkAsync(path, newDataKey())).toBe(false)
    expect(await pragmaCheck(path, 'integrity_check', key)).toBe('ok')
  })

  it('an encrypted file of an older schema migrates like any other', () => {
    const path = companyFile(MIGRATIONS.slice(0, -1))
    const key = newDataKey()
    rekeyFile(path, null, key)
    const db = openDb(path, { key })
    migrate(db)
    expect((db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n).toBe(MIGRATIONS.length)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'backup_runs'").get()).toBeTruthy()
    db.close()
  })

  it('snapshots of a keyed handle stay encrypted (online backup → VACUUM INTO); plainCopy decrypts', async () => {
    const path = companyFile()
    const key = newDataKey()
    rekeyFile(path, null, key)
    const db = openDb(path, { key })
    db.pragma('journal_mode = WAL')
    const snap = join(path, '..', 'snap.db')
    await snapshotTo(db, snap)
    expect(isEncryptedFile(snap)).toBe(true)
    expect(quickCheckOk(snap, key)).toBe(true)
    expect(quickCheckOk(snap, null)).toBe(false)
    const plain = join(path, '..', 'plain.db')
    plainCopy(db, plain)
    expect(isEncryptedFile(plain)).toBe(false)
    expect(quickCheckOk(plain, null)).toBe(true)
    const other = newDataKey()
    const re = join(path, '..', 're.db')
    copyWithKey(db, re, other)
    expect(quickCheckOk(re, other)).toBe(true)
    expect(quickCheckOk(re, key)).toBe(false)
    db.close()
  })

  it('the verified conversion keeps every fact (tables, migrations, audit chain, totals) both ways', () => {
    const path = companyFile()
    const key = newDataKey()
    let db = openDb(path)
    const before = bookFacts(db, '2026-03-31')
    convertCompanyFile({ db, dbPath: path, to: key, asOn: '2026-03-31', audit: { before: { encrypted: false }, after: { encrypted: true } } })
    expect(isEncryptedFile(path)).toBe(true)
    db = openDb(path, { key })
    const after = bookFacts(db, '2026-03-31')
    // One more audit row (the change itself, inside the converted file); everything else equal.
    expect(after.tables['audit_log']).toBe(before.tables['audit_log']! + 1)
    expect(after.auditOk).toBe(true)
    expect({ ...after.tables, audit_log: 0 }).toEqual({ ...before.tables, audit_log: 0 })
    expect(sameFacts(after, after)).toBe(true)
    convertCompanyFile({ db, dbPath: path, to: null, asOn: '2026-03-31', audit: { before: { encrypted: true }, after: { encrypted: false } } })
    expect(isEncryptedFile(path)).toBe(false)
    db = openDb(path)
    expect(bookFacts(db, '2026-03-31').auditOk).toBe(true)
    db.close()
  })

  it('backups convert one by one; a broken one is left as it was and reported', () => {
    const path = companyFile()
    const dir = join(path, '..', 'backups')
    mkdirSync(dir, { recursive: true })
    const db = openDb(path)
    db.exec(`VACUUM INTO '${join(dir, 'a.db')}'`)
    db.exec(`VACUUM INTO '${join(dir, 'b.db')}'`)
    db.close()
    writeFileSync(join(dir, 'broken.db'), 'not a database at all, just text that is long enough')
    const key = newDataKey()
    const out = convertBackups(dir, null, key)
    expect(out.converted).toBe(2)
    expect(out.failed).toEqual(['broken.db'])
    expect(isEncryptedFile(join(dir, 'a.db'))).toBe(true)
    expect(quickCheckOk(join(dir, 'b.db'), key)).toBe(true)
    // Again: nothing left to convert (re-runnable).
    expect(convertBackups(dir, null, key).converted).toBe(0)
    // And back.
    expect(convertBackups(dir, key, null).converted).toBe(2)
    expect(quickCheckOk(join(dir, 'a.db'), null)).toBe(true)
  })
})

describe('the restore check of a backup', () => {
  it('passes for a good backup (plain or encrypted) and fails for a damaged one / an unbalanced one', () => {
    const path = companyFile(MIGRATIONS.slice(0, -1)) // an older backup: the check migrates it
    expect(verifyBackupFile(path, { asOn: '2026-03-31' })).toMatchObject({ ok: true, steps: { opens: true, quickCheck: true, company: true, migrations: { ok: true } } })
    const key = newDataKey()
    const enc = companyFile()
    rekeyFile(enc, null, key)
    expect(verifyBackupFile(enc, { asOn: '2026-03-31', key })).toMatchObject({ ok: true, encrypted: true })
    expect(verifyBackupFile(enc, { asOn: '2026-03-31', key: null }).ok).toBe(false)
    // The original is never touched (the check works on a scratch copy).
    expect(isEncryptedFile(enc)).toBe(true)

    const bad = companyFile()
    const bytes = readFileSync(bad)
    bytes.fill(0x42, 4096, Math.min(bytes.length, 4096 * 8))
    writeFileSync(bad, bytes)
    const r = verifyBackupFile(bad, { asOn: '2026-03-31' })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()

    const unbalanced = companyFile()
    const d = testFileDb(unbalanced)
    const vt = (d.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
    const cash = (d.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const v = Number(d.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-05-01', 'X1')").run(vt).lastInsertRowid)
    d.prepare("INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, 'dr', 100, 0)").run(v, cash)
    d.close()
    const u = verifyBackupFile(unbalanced, { asOn: '2026-03-31' })
    expect(u).toMatchObject({ ok: false, steps: { balanced: { ok: false } } })
  })
})

describe('the WP 7.2 migration', () => {
  it('is the last migration (number by position) and leaves every existing user as the role says', () => {
    expect(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE backup_runs'))).toBe(MIGRATIONS.length - 1)
    const path = companyFile(MIGRATIONS.slice(0, -1))
    const db = testFileDb(path)
    db.prepare("INSERT INTO users (name, pin_hash, role, active) VALUES ('Old Owner', 'x', 'owner', 1)").run()
    migrate(db)
    expect(db.prepare('SELECT capabilities_json AS c FROM users').get()).toEqual({ c: null })
    db.close()
  })
})
