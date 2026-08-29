/**
 * Bulk edit of narration and cost centre (#39).
 *
 * The properties worth pinning are the refusals: this touches two annotation fields and must
 * never touch anything that changes what the books say, and it must never apply to half a
 * selection.
 */
import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { listAudit, setAuditContext } from './audit'
import { bulkEditVouchers, deleteVoucher, getVoucher, saveVoucher, setLockDate } from './vouchers'

type Db = ReturnType<typeof seededDb>

function ledgerIn(db: Db, group: string, name: string): { id: number } {
  const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(group) as { id: number }
  return createLedger(db, { name, groupId: g.id })
}

function centre(db: Db, name: string): number {
  const res = db.prepare('INSERT INTO cost_centres (name, parent_id) VALUES (?, NULL)').run(name)
  return Number(res.lastInsertRowid)
}

/** A payment: expense debited, bank credited, optionally against a party. */
function payment(db: Db, opts: { date?: string; narration?: string | null; partyId?: number } = {}): number {
  const bank = ledgerIn(db, 'Bank Accounts', `Bank ${Math.random().toString(36).slice(2, 7)}`)
  const expense = ledgerIn(db, 'Indirect Expenses', `Rent ${Math.random().toString(36).slice(2, 7)}`)
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }
  const lines = [
    { ledgerId: expense.id, drCr: 'dr' as const, amount: 10_000_00 },
    { ledgerId: bank.id, drCr: 'cr' as const, amount: 10_000_00 }
  ]
  if (opts.partyId) {
    lines[0] = { ledgerId: opts.partyId, drCr: 'dr', amount: 6_000_00 }
    lines.splice(1, 0, { ledgerId: expense.id, drCr: 'dr', amount: 4_000_00 })
  }
  const v = saveVoucher(db, {
    voucherTypeId: vt.id,
    date: opts.date ?? '2026-08-05',
    partyLedgerId: opts.partyId ?? null,
    narration: opts.narration ?? null,
    reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
    vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines, inventory: [], billRefs: [], tds: null
  })
  return v.id
}

describe('bulkEditVouchers (#39)', () => {
  it('sets the narration on every selected voucher and nothing else', () => {
    const db = seededDb()
    const a = payment(db)
    const b = payment(db, { narration: 'old wording' })
    const beforeA = getVoucher(db, a)!

    const result = bulkEditVouchers(db, [a, b], { narration: '  Q2 branch rent  ' })
    expect(result).toEqual({ vouchers: 2, linesAllocated: 0 })
    expect(getVoucher(db, a)!.narration).toBe('Q2 branch rent')
    expect(getVoucher(db, b)!.narration).toBe('Q2 branch rent')

    // Amounts, ledgers, sides, dates and the number are untouched.
    const afterA = getVoucher(db, a)!
    expect(afterA.date).toBe(beforeA.date)
    expect(afterA.number).toBe(beforeA.number)
    expect(afterA.lines.map((l) => [l.ledgerId, l.drCr, l.amount]))
      .toEqual(beforeA.lines.map((l) => [l.ledgerId, l.drCr, l.amount]))
  })

  it('clears the narration when given null', () => {
    const db = seededDb()
    const a = payment(db, { narration: 'something' })
    bulkEditVouchers(db, [a], { narration: null })
    expect(getVoucher(db, a)!.narration).toBeNull()
    // An all-whitespace narration is a cleared one, not a narration of three spaces.
    const b = payment(db, { narration: 'something' })
    bulkEditVouchers(db, [b], { narration: '   ' })
    expect(getVoucher(db, b)!.narration).toBeNull()
  })

  it('allocates every line that can carry a cost centre, at the line’s full amount', () => {
    const db = seededDb()
    const pune = centre(db, 'Pune')
    const a = payment(db)
    const result = bulkEditVouchers(db, [a], { costCentreId: pune })

    // The expense line only — not the bank side, which belongs to all centres at once.
    expect(result.linesAllocated).toBe(1)
    const v = getVoucher(db, a)!
    const allocated = v.lines.filter((l) => l.costAllocations.length > 0)
    expect(allocated).toHaveLength(1)
    expect(allocated[0]!.costAllocations).toEqual([{ costCentreId: pune, amount: 10_000_00 }])
  })

  it('leaves the party line out of the allocation', () => {
    const db = seededDb()
    const pune = centre(db, 'Pune')
    const party = ledgerIn(db, 'Sundry Creditors', 'Acme Traders')
    const a = payment(db, { partyId: party.id })
    bulkEditVouchers(db, [a], { costCentreId: pune })

    const v = getVoucher(db, a)!
    const partyLine = v.lines.find((l) => l.ledgerId === party.id)!
    expect(partyLine.costAllocations).toEqual([])
    // The one expense line did get it.
    expect(v.lines.filter((l) => l.costAllocations.length > 0)).toHaveLength(1)
  })

  it('replaces an existing split rather than adding to it', () => {
    const db = seededDb()
    const mumbai = centre(db, 'Mumbai')
    const pune = centre(db, 'Pune')
    const a = payment(db)
    bulkEditVouchers(db, [a], { costCentreId: mumbai })
    bulkEditVouchers(db, [a], { costCentreId: pune })

    const alloc = getVoucher(db, a)!.lines.flatMap((l) => l.costAllocations)
    expect(alloc).toEqual([{ costCentreId: pune, amount: 10_000_00 }])
  })

  it('removes every allocation when the cost centre is explicitly null', () => {
    const db = seededDb()
    const pune = centre(db, 'Pune')
    const a = payment(db)
    bulkEditVouchers(db, [a], { costCentreId: pune })
    bulkEditVouchers(db, [a], { costCentreId: null })
    expect(getVoucher(db, a)!.lines.flatMap((l) => l.costAllocations)).toEqual([])
  })

  it('changes both fields in one pass, and leaves an unmentioned field alone', () => {
    const db = seededDb()
    const pune = centre(db, 'Pune')
    const a = payment(db, { narration: 'keep me' })
    bulkEditVouchers(db, [a], { costCentreId: pune })
    expect(getVoucher(db, a)!.narration).toBe('keep me')

    bulkEditVouchers(db, [a], { narration: 'both', costCentreId: pune })
    const v = getVoucher(db, a)!
    expect(v.narration).toBe('both')
    expect(v.lines.flatMap((l) => l.costAllocations)).toHaveLength(1)
  })

  it('refuses the whole run when one voucher is inside the locked period', () => {
    const db = seededDb()
    const open = payment(db, { date: '2026-08-05', narration: 'before' })
    const locked = payment(db, { date: '2026-03-05', narration: 'before' })
    setLockDate(db, '2026-03-31')

    expect(() => bulkEditVouchers(db, [open, locked], { narration: 'after' })).toThrow(/locked up to 2026-03-31/)
    // Nothing was written, including the voucher that was legal on its own — a bulk edit that
    // did some of the selection is one nobody can reconcile afterwards.
    expect(getVoucher(db, open)!.narration).toBe('before')
    expect(getVoucher(db, locked)!.narration).toBe('before')
  })

  it('refuses a binned voucher, a missing one, an empty selection and an empty change', () => {
    const db = seededDb()
    const a = payment(db)
    const binned = payment(db)
    deleteVoucher(db, binned)

    expect(() => bulkEditVouchers(db, [a, binned], { narration: 'x' })).toThrow(/in the bin/)
    expect(() => bulkEditVouchers(db, [a, 99999], { narration: 'x' })).toThrow(/not found/)
    expect(() => bulkEditVouchers(db, [], { narration: 'x' })).toThrow(/Nothing selected/)
    expect(() => bulkEditVouchers(db, [a], {})).toThrow(/Nothing to change/)
    expect(() => bulkEditVouchers(db, [a], { costCentreId: 4242 })).toThrow(/Cost centre not found/)
  })

  it('audits one narrow row per voucher, not a whole-voucher rewrite', () => {
    setAuditContext({ appVersion: '1.0.0', getUserName: () => 'Tester' })
    const db = seededDb()
    const a = payment(db)
    const b = payment(db)
    const beforeCount = listAudit(db, { entity: 'voucher' }).total

    bulkEditVouchers(db, [a, b], { narration: 'swept' })
    const rows = listAudit(db, { entity: 'voucher' })
    expect(rows.total).toBe(beforeCount + 2)
    const latest = rows.rows[0]!
    expect(latest.action).toBe('update')
    expect(JSON.parse(latest.afterJson ?? '{}')).toMatchObject({ bulkEdit: true, narration: 'swept' })
  })
})
