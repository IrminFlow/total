// WP 8.5 grouped undo: the save card's Undo bins an intent's vouchers (a sale + the money taken
// with it) as one group, restoring either brings both back, every step is audited, and it is
// refused once a voucher was edited since, inside the lock, or after its year was closed. The
// save card's figures come from the saved vouchers + the party's allocation.
import { describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, listBin, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { restoreFromBin, saveSummary, undoSave, undoState, UNDO_WINDOW_MS } from './undo'
import { trialBalance } from './reports'
import { postClose } from './yearEnd'
import { AppError } from '@shared/errors'
import { MIGRATIONS } from '../db/migrations'

const typeId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const ledger = (db: DB, name: string, group: string): number =>
  createLedger(db, {
    name, groupId: groupId(db, group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
const cashId = (db: DB): number => (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

function setup(): { db: DB; ramesh: number; sales: number; upi: number } {
  const db = seededDb()
  return { db, ramesh: ledger(db, 'Ramesh', 'Sundry Debtors'), sales: ledger(db, 'Sales', 'Sales Accounts'), upi: ledger(db, 'UPI', 'Bank Accounts') }
}

const base = { partyLedgerId: null, narration: null, reference: null, inventory: [], billRefs: [], tds: null }

/** The intent pair: a ₹1,180 bill to Ramesh and ₹500 received by UPI with it. */
function saveIntent(f: ReturnType<typeof setup>, date = '2026-10-01'): [number, number] {
  const { db, ramesh, sales, upi } = f
  const bill = saveVoucher(db, {
    ...base, voucherTypeId: typeId(db, 'sales'), date, partyLedgerId: ramesh,
    lines: [{ ledgerId: ramesh, drCr: 'dr', amount: 118000 }, { ledgerId: sales, drCr: 'cr', amount: 118000 }]
  })
  const receipt = saveVoucher(db, {
    ...base, voucherTypeId: typeId(db, 'receipt'), date, partyLedgerId: ramesh,
    lines: [{ ledgerId: upi, drCr: 'dr', amount: 50000 }, { ledgerId: ramesh, drCr: 'cr', amount: 50000 }]
  })
  return [bill.id, receipt.id]
}

const audits = (db: DB, entity: string): { entity_id: number; action: string; before_json: string | null; after_json: string | null }[] =>
  db.prepare('SELECT entity_id, action, before_json, after_json FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as never

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (err) {
    return err instanceof AppError ? err.code : `plain: ${(err as Error).message}`
  }
  return undefined
}

describe('undo migration', () => {
  it('comes right before WP 8.3 simple_category (046; number by position)', () => {
    expect(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE undo_groups'))).toBe(MIGRATIONS.findIndex((sql) => sql.includes('ADD COLUMN simple_category')) - 1)
  })
})

describe('save card figures', () => {
  it('come from the saved vouchers and the party allocation', () => {
    const f = setup()
    const ids = saveIntent(f)
    const s = saveSummary(f.db, ids)
    expect(s.entries.map((e) => [e.kind, e.amount, e.money])).toEqual([
      ['sales', 118000, null],
      ['receipt', 50000, { name: 'UPI', isCash: false, amount: 50000 }]
    ])
    expect(s.parties).toEqual([{ ledgerId: f.ramesh, name: 'Ramesh', side: 'customer', balance: 68000 }])
    expect(s.undo).toEqual({ undoable: true, reason: null })
  })

  it('cash money is told as cash', () => {
    const f = setup()
    const r = saveVoucher(f.db, {
      ...base, voucherTypeId: typeId(f.db, 'receipt'), date: '2026-10-01', partyLedgerId: f.ramesh,
      lines: [{ ledgerId: cashId(f.db), drCr: 'dr', amount: 2500 }, { ledgerId: f.ramesh, drCr: 'cr', amount: 2500 }]
    })
    const s = saveSummary(f.db, [r.id])
    expect(s.entries[0]!.money).toEqual({ name: 'Cash', isCash: true, amount: 2500 })
    expect(s.parties.map((p) => p.balance)).toEqual([-2500]) // paid ahead
  })
})

describe('grouped undo', () => {
  it('bins an intent pair as one group; restoring either brings both back — audited', () => {
    const f = setup()
    const [bill, receipt] = saveIntent(f)
    const tbBefore = trialBalance(f.db, '2027-03-31')
    const r = undoSave(f.db, [bill, receipt])
    expect(r.binned).toEqual([bill, receipt])
    expect(getVoucher(f.db, bill)!.deletedAt).not.toBeNull()
    expect(getVoucher(f.db, receipt)!.deletedAt).not.toBeNull()
    expect(trialBalance(f.db, '2027-03-31').totalDebit).toBe(0)
    // Each voucher's own bin row (unchanged single-voucher semantics) + one group row.
    expect(audits(f.db, 'voucher').filter((a) => a.action === 'delete').map((a) => a.entity_id)).toEqual([bill, receipt])
    const created = audits(f.db, 'undo_group')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ entity_id: r.groupId, action: 'create' })
    expect(JSON.parse(created[0]!.after_json!)).toMatchObject({ voucherIds: [bill, receipt] })
    // The bin shows them as undone together.
    const bin = listBin(f.db)
    expect(bin.map((b) => [b.id, b.undoGroupId, b.undoGroupSize]).sort()).toEqual([[bill, r.groupId, 2], [receipt, r.groupId, 2]].sort())
    expect(undoState(f.db, [bill, receipt])).toEqual({ undoable: false, reason: 'binned' })
    expect(code(() => undoSave(f.db, [bill, receipt]))).toBe('undo_nothing')

    // Restore the receipt → the bill comes back with it.
    expect(restoreFromBin(f.db, receipt).restored.sort()).toEqual([bill, receipt].sort())
    expect(getVoucher(f.db, bill)!.deletedAt).toBeNull()
    expect(getVoucher(f.db, receipt)!.deletedAt).toBeNull()
    expect(trialBalance(f.db, '2027-03-31')).toEqual(tbBefore)
    expect(listBin(f.db)).toEqual([])
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM undo_group_vouchers').get()).toEqual({ n: 0 })
    const restoredRow = audits(f.db, 'undo_group')[1]!
    expect(restoredRow).toMatchObject({ entity_id: r.groupId, action: 'restore' })
    expect(audits(f.db, 'voucher').filter((a) => a.action === 'restore').map((a) => a.entity_id).sort()).toEqual([bill, receipt].sort())
    // Restored = touched since the save: no second Undo.
    expect(undoState(f.db, [bill, receipt])).toEqual({ undoable: false, reason: 'edited' })
  })

  it('a voucher binned on its own restores on its own (bin semantics unchanged)', () => {
    const f = setup()
    const [bill, receipt] = saveIntent(f)
    deleteVoucher(f.db, bill)
    deleteVoucher(f.db, receipt)
    expect(listBin(f.db).every((b) => b.undoGroupId === null)).toBe(true)
    expect(restoreFromBin(f.db, bill).restored).toEqual([bill])
    expect(getVoucher(f.db, receipt)!.deletedAt).not.toBeNull()
    expect(audits(f.db, 'undo_group')).toEqual([])
  })

  it('is refused once a voucher was edited since its save — nothing is binned', () => {
    const f = setup()
    const [bill, receipt] = saveIntent(f)
    const v = getVoucher(f.db, receipt)!
    saveVoucher(f.db, { ...base, voucherTypeId: v.voucherTypeId, date: v.date, partyLedgerId: f.ramesh, narration: 'edited', lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })) }, receipt)
    expect(undoState(f.db, [bill, receipt])).toEqual({ undoable: false, reason: 'edited' })
    expect(code(() => undoSave(f.db, [bill, receipt]))).toBe('undo_edited')
    expect(getVoucher(f.db, bill)!.deletedAt).toBeNull()
    expect(audits(f.db, 'undo_group')).toEqual([])
    // The untouched one alone still undoes.
    expect(undoSave(f.db, [bill]).binned).toEqual([bill])
  })

  it('respects the lock date', () => {
    const f = setup()
    const ids = saveIntent(f, '2026-06-15')
    setLockDate(f.db, '2026-06-30')
    expect(undoState(f.db, ids)).toEqual({ undoable: false, reason: 'locked' })
    expect(code(() => undoSave(f.db, ids))).toBe('books_locked')
    expect(ids.every((id) => getVoucher(f.db, id)!.deletedAt === null)).toBe(true)
  })

  it('never re-opens a closed year: refused for a year closed after the save, and for the closing entry', () => {
    const f = setup()
    const ids = saveIntent(f, '2025-05-01')
    const close = postClose(f.db, TEST_INFO, 2025)
    setLockDate(f.db, null) // the close locks the year; without the lock the close itself must still hold
    expect(undoState(f.db, ids)).toEqual({ undoable: false, reason: 'closed_year' })
    expect(code(() => undoSave(f.db, ids))).toBe('undo_closed_year')
    expect(code(() => undoSave(f.db, [close.voucherId]))).toBe('undo_closing_entry')
    expect(ids.every((id) => getVoucher(f.db, id)!.deletedAt === null)).toBe(true)
  })

  it('a member restore refused (lock) rolls the whole group back into the bin', () => {
    const f = setup()
    const ids = saveIntent(f, '2026-06-15')
    undoSave(f.db, ids)
    setLockDate(f.db, '2026-06-30')
    expect(code(() => restoreFromBin(f.db, ids[0]!))).toBe('books_locked')
    expect(ids.every((id) => getVoucher(f.db, id)!.deletedAt !== null)).toBe(true)
  })
})

describe('save card figures — every party, as on the saved date', () => {
  it('a cash sale and a party voucher in one call: cash is never a party, the party is', () => {
    const f = setup()
    const cash = cashId(f.db)
    const sale = saveVoucher(f.db, {
      ...base, voucherTypeId: typeId(f.db, 'sales'), date: '2026-10-01', partyLedgerId: cash,
      lines: [{ ledgerId: cash, drCr: 'dr', amount: 9000 }, { ledgerId: f.sales, drCr: 'cr', amount: 9000 }]
    })
    const [bill] = saveIntent(f)
    const s = saveSummary(f.db, [sale.id, bill])
    expect(s.entries.map((e) => e.voucherId)).toEqual([sale.id, bill])
    expect(s.parties.map((p) => p.name)).toEqual(['Ramesh'])
  })

  it('two parties in one intent are both on the card', () => {
    const f = setup()
    const gupta = ledger(f.db, 'Gupta', 'Sundry Creditors')
    const purchases = ledger(f.db, 'Purchases', 'Purchase Accounts')
    const [bill] = saveIntent(f)
    const buy = saveVoucher(f.db, {
      ...base, voucherTypeId: typeId(f.db, 'purchase'), date: '2026-10-01', partyLedgerId: gupta,
      lines: [{ ledgerId: purchases, drCr: 'dr', amount: 4000 }, { ledgerId: gupta, drCr: 'cr', amount: 4000 }]
    })
    expect(saveSummary(f.db, [bill, buy.id]).parties.map((p) => [p.name, p.side, p.balance])).toEqual([
      ['Ramesh', 'customer', 68000],
      ['Gupta', 'supplier', 4000]
    ])
  })

  it('a credit note lowers what the customer owes', () => {
    const f = setup()
    saveIntent(f)
    const note = saveVoucher(f.db, {
      ...base, voucherTypeId: typeId(f.db, 'credit_note'), date: '2026-10-02', partyLedgerId: f.ramesh,
      lines: [{ ledgerId: f.sales, drCr: 'dr', amount: 18000 }, { ledgerId: f.ramesh, drCr: 'cr', amount: 18000 }]
    })
    const s = saveSummary(f.db, [note.id])
    expect(s.entries[0]).toMatchObject({ kind: 'credit_note', amount: 18000 })
    expect(s.parties).toEqual([{ ledgerId: f.ramesh, name: 'Ramesh', side: 'customer', balance: 50000 }])
  })

  it('is as on the latest saved voucher’s date — a later payment is not counted', () => {
    const f = setup()
    const [bill] = saveIntent(f, '2026-10-01')
    saveVoucher(f.db, {
      ...base, voucherTypeId: typeId(f.db, 'receipt'), date: '2026-10-20', partyLedgerId: f.ramesh,
      lines: [{ ledgerId: f.upi, drCr: 'dr', amount: 68000 }, { ledgerId: f.ramesh, drCr: 'cr', amount: 68000 }]
    })
    // As on 1 Oct the bill is open; the receipt saved with it (same date) counts, the 20 Oct one doesn't.
    expect(saveSummary(f.db, [bill]).parties[0]!.balance).toBe(68000)
  })
})

describe('undo safety', () => {
  const billWithRef = (f: ReturnType<typeof setup>): number =>
    saveVoucher(f.db, {
      ...base, voucherTypeId: typeId(f.db, 'sales'), date: '2026-10-01', partyLedgerId: f.ramesh,
      lines: [{ ledgerId: f.ramesh, drCr: 'dr', amount: 118000 }, { ledgerId: f.sales, drCr: 'cr', amount: 118000 }],
      billRefs: [{ kind: 'new', name: 'S-1', amount: 118000, dueDate: null }]
    }).id
  const receiptAgainst = (f: ReturnType<typeof setup>): number =>
    saveVoucher(f.db, {
      ...base, voucherTypeId: typeId(f.db, 'receipt'), date: '2026-10-02', partyLedgerId: f.ramesh,
      lines: [{ ledgerId: f.upi, drCr: 'dr', amount: 50000 }, { ledgerId: f.ramesh, drCr: 'cr', amount: 50000 }],
      billRefs: [{ kind: 'against', name: 'S-1', amount: 50000, dueDate: null }]
    }).id

  it('refuses a bill a later voucher has settled against — unless they are undone together', () => {
    const f = setup()
    const bill = billWithRef(f)
    const receipt = receiptAgainst(f)
    expect(undoState(f.db, [bill])).toEqual({ undoable: false, reason: 'linked' })
    expect(code(() => undoSave(f.db, [bill]))).toBe('undo_linked')
    expect(getVoucher(f.db, bill)!.deletedAt).toBeNull()
    expect(undoSave(f.db, [bill, receipt]).binned).toEqual([bill, receipt])
  })

  it('refuses a voucher matched to a bank statement line', () => {
    const f = setup()
    const [, receipt] = saveIntent(f)
    const imp = Number(f.db.prepare("INSERT INTO bank_statement_imports (bank_ledger_id, format) VALUES (?, 'csv')").run(f.upi).lastInsertRowid)
    const line = Number(
      f.db
        .prepare("INSERT INTO bank_statement_lines (import_id, bank_ledger_id, line_no, date, deposit, import_hash) VALUES (?, ?, 1, '2026-10-01', 50000, 'h1')")
        .run(imp, f.upi).lastInsertRowid
    )
    f.db.prepare('INSERT INTO bank_statement_matches (statement_line_id, voucher_id) VALUES (?, ?)').run(line, receipt)
    expect(undoState(f.db, [receipt])).toEqual({ undoable: false, reason: 'linked' })
    expect(code(() => undoSave(f.db, [receipt]))).toBe('undo_linked')
  })

  it('refuses a voucher another document draws on (line links)', () => {
    const f = setup()
    const [bill, receipt] = saveIntent(f)
    f.db
      .prepare("INSERT INTO line_links (link_type, from_voucher_id, from_line_uid, to_voucher_id, to_line_uid, qty_milli) VALUES ('fulfil', ?, 'a', ?, 'b', 1000)")
      .run(bill, receipt)
    expect(undoState(f.db, [bill])).toEqual({ undoable: false, reason: 'linked' })
    expect(undoState(f.db, [bill, receipt]).undoable).toBe(true) // the drawing voucher goes with it
  })

  it('is offered for 24 hours after the save, then says edit instead', () => {
    const f = setup()
    const ids = saveIntent(f)
    const later = (ms: number): Date => new Date(Date.now() + ms)
    expect(undoState(f.db, ids, { now: later(UNDO_WINDOW_MS - 60_000) }).undoable).toBe(true)
    expect(undoState(f.db, ids, { now: later(UNDO_WINDOW_MS + 60_000) })).toEqual({ undoable: false, reason: 'expired' })
    expect(code(() => undoSave(f.db, ids, { now: later(UNDO_WINDOW_MS + 60_000) }))).toBe('undo_expired')
  })

  it('a closing journal restored after the save blocks undo (audit order, not voucher id)', () => {
    const f = setup()
    saveIntent(f, '2025-05-01')
    const close = postClose(f.db, TEST_INFO, 2025)
    setLockDate(f.db, null)
    deleteVoucher(f.db, close.voucherId) // year re-opened
    const [late] = saveIntent(f, '2025-06-01') // saved after the closing journal's id
    expect(late).toBeGreaterThan(close.voucherId)
    expect(undoState(f.db, [late]).undoable).toBe(true)
    restoreVoucher(f.db, close.voucherId) // the year is closed again after the save
    expect(undoState(f.db, [late])).toEqual({ undoable: false, reason: 'closed_year' })
    expect(code(() => undoSave(f.db, [late]))).toBe('undo_closed_year')
  })
})

