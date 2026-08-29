import { describe, it, expect } from 'vitest'
import { binPurgeCandidates, purgeOldDeleted, setLockDate } from './vouchers'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import type { DrCr } from '@shared/domain'

/**
 * The bin's auto-purge policy.
 *
 * A policy that silently deletes is a policy nobody can check, so what it would take has to be
 * knowable before it takes it. And zero has to mean "never" rather than "immediately", because
 * the difference between those two readings is a business under audit losing its evidence.
 */
function books() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const sales = createLedger(db, { name: 'Sales', groupId: groupId('Sales Accounts') }).id

  const post = (date: string): number => {
    const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = [
      { ledgerId: cash, drCr: 'dr', amount: 1000 },
      { ledgerId: sales, drCr: 'cr', amount: 1000 }
    ]
    return saveVoucher(db, {
      voucherTypeId: vtId('receipt'), date, partyLedgerId: null, posOverride: null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    }).id
  }

  /** Bin a voucher and backdate when it was binned, so the age window can be exercised. */
  const binLongAgo = (id: number, daysAgo: number): void => {
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now', ?) WHERE id = ?").run(`-${daysAgo} days`, id)
  }

  return { db, post, binLongAgo }
}

describe('bin auto-purge', () => {
  it('purges nothing at all without a books lock date', () => {
    // Binned vouchers in an unlocked period are still needed — GSTR-1 reports them as cancelled
    // documents and numbering relies on them so a deleted number is never reissued.
    const b = books()
    b.binLongAgo(b.post('2026-05-01'), 400)
    expect(binPurgeCandidates(b.db, 30).count).toBe(0)
    expect(purgeOldDeleted(b.db, 30)).toBe(0)
  })

  it('names what it would take, before taking it', () => {
    const b = books()
    const old = b.post('2026-05-01')
    b.binLongAgo(old, 400)
    setLockDate(b.db, '2026-12-31')

    const candidates = binPurgeCandidates(b.db, 30)
    expect(candidates.count).toBe(1)
    expect(candidates.oldestDate).toBe('2026-05-01')
    // And nothing has actually gone yet.
    expect(
      (b.db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE id = ?').get(old) as { n: number }).n
    ).toBe(1)
  })

  it('takes exactly what it named', () => {
    const b = books()
    b.binLongAgo(b.post('2026-05-01'), 400)
    setLockDate(b.db, '2026-12-31')

    const expected = binPurgeCandidates(b.db, 30).count
    expect(purgeOldDeleted(b.db, 30)).toBe(expected)
    expect(binPurgeCandidates(b.db, 30).count).toBe(0)
  })

  it('treats zero days as never, not as immediately', () => {
    // The difference between those two readings is a business under audit losing its evidence.
    const b = books()
    b.binLongAgo(b.post('2026-05-01'), 400)
    setLockDate(b.db, '2026-12-31')

    expect(binPurgeCandidates(b.db, 0).count).toBe(0)
    expect(purgeOldDeleted(b.db, 0)).toBe(0)
    // The voucher is still there.
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(1)
  })

  it('leaves a voucher binned more recently than the window', () => {
    const b = books()
    b.binLongAgo(b.post('2026-05-01'), 5)
    setLockDate(b.db, '2026-12-31')
    expect(binPurgeCandidates(b.db, 30).count).toBe(0)
  })

  it('leaves a voucher dated after the lock, however long it has been binned', () => {
    const b = books()
    b.binLongAgo(b.post('2027-01-15'), 400)
    setLockDate(b.db, '2026-12-31')
    expect(binPurgeCandidates(b.db, 30).count).toBe(0)
    expect(purgeOldDeleted(b.db, 30)).toBe(0)
  })

  it('never touches a voucher that is not in the bin', () => {
    const b = books()
    b.post('2026-05-01')
    setLockDate(b.db, '2026-12-31')
    expect(binPurgeCandidates(b.db, 30).count).toBe(0)
  })
})
