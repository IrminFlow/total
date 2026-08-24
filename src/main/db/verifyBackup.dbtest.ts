import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { snapshotSync, verifyBackup } from './backup'
import { seededDb } from './testdb'
import { createLedger } from '../services/masters'
import { saveVoucher } from '../services/vouchers'
import type { DrCr } from '@shared/domain'

/**
 * Proving a backup.
 *
 * A backup button that has never been proved is a promise, and a business finds out whether it
 * was true on the worst day of its year. These tests are about what the claim actually covers:
 * not that the file exists, not that SQLite can read it, but that the books inside it foot.
 */
function dir(): string {
  return mkdtempSync(join(tmpdir(), 'total-verify-'))
}

function booksWithVouchers(count: number) {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const sales = createLedger(db, { name: 'Sales', groupId: groupId('Sales Accounts') }).id

  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = [
      { ledgerId: cash, drCr: 'dr', amount: 100000 },
      { ledgerId: sales, drCr: 'cr', amount: 100000 }
    ]
    ids.push(
      saveVoucher(db, {
        voucherTypeId: vtId('receipt'), date: '2026-05-01', partyLedgerId: null, posOverride: null,
        lines: lines.map((l) => ({ ...l, costAllocations: [] })),
        inventory: [], billRefs: [], tds: null
      }).id
    )
  }
  return { db, ids }
}

describe('verifyBackup', () => {
  it('passes a real backup and reports what is in it', () => {
    const { db } = booksWithVouchers(3)
    const dest = join(dir(), 'backup.db')
    snapshotSync(db, dest)

    const v = verifyBackup(dest)
    expect(v.integrityOk).toBe(true)
    expect(v.opensAsCompany).toBe(true)
    expect(v.voucherCount).toBe(3)
    expect(v.balanced).toBe(true)
    expect(v.totalDebit).toBe(v.totalCredit)
    expect(v.problem).toBeNull()
  })

  it('excludes binned vouchers from the count, matching what a restore would show', () => {
    const { db, ids } = booksWithVouchers(3)
    db.prepare("UPDATE vouchers SET deleted_at = '2026-06-01T00:00:00Z' WHERE id = ?").run(ids[0])
    const dest = join(dir(), 'backup.db')
    snapshotSync(db, dest)
    expect(verifyBackup(dest).voucherCount).toBe(2)
  })

  it('reports books that do not balance, which quick_check would call fine', () => {
    // This is the whole point of the feature. A structurally valid SQLite file can still hold
    // books that do not add up, and only footing them finds that.
    const { db } = booksWithVouchers(1)
    db.prepare("UPDATE voucher_lines SET amount = amount + 1 WHERE dr_cr = 'dr'").run()
    const dest = join(dir(), 'backup.db')
    snapshotSync(db, dest)

    const v = verifyBackup(dest)
    expect(v.integrityOk).toBe(true)
    expect(v.opensAsCompany).toBe(true)
    expect(v.balanced).toBe(false)
    expect(v.problem).toMatch(/do not balance/)
  })

  it('refuses a file that is not a database at all', () => {
    const path = join(dir(), 'notadb.db')
    writeFileSync(path, 'this is not a database')
    const v = verifyBackup(path)
    expect(v.integrityOk).toBe(false)
    expect(v.problem).toBeTruthy()
  })

  it('refuses a file that does not exist', () => {
    const v = verifyBackup(join(dir(), 'missing.db'))
    expect(v.integrityOk).toBe(false)
    expect(v.problem).toMatch(/Could not open/)
  })

  it('distinguishes a valid database that is not a Total company', () => {
    // A sound SQLite file with the wrong contents must not be reported as a usable backup.
    const path = join(dir(), 'other.db')
    const other = seededDb()
    other.prepare("DELETE FROM meta WHERE key = 'company'").run()
    snapshotSync(other, path)

    const v = verifyBackup(path)
    expect(v.integrityOk).toBe(true)
    expect(v.opensAsCompany).toBe(false)
    expect(v.problem).toMatch(/not a Total company/)
  })

  it('never writes to the file it verifies', () => {
    // Read-only throughout: verifying a backup must not be able to damage it.
    const { db } = booksWithVouchers(2)
    const dest = join(dir(), 'backup.db')
    snapshotSync(db, dest)

    const before = require('fs').statSync(dest).mtimeMs as number
    verifyBackup(dest)
    verifyBackup(dest)
    expect(require('fs').statSync(dest).mtimeMs).toBe(before)
  })
})
