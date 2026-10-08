// WP 6.4 — bulk edit: the preview (a rolled-back dry run) equals the apply; refusals come from the
// normal save paths (lock date, year-end closing journals, credit hold, the bin, posting rules,
// system ledgers, HSN); every applied record is audited; undo reverts records unchanged since and
// reports the rest.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import { createLedger, createStockItem, createVoucherType, getLedger, getStockItem } from './masters'
import { deleteVoucher, getVoucher, saveVoucher, setLockDate, YEAR_END_CLOSE_IMMUTABLE } from './vouchers'
import { saveCostCentre } from './costCentres'
import { applyBulk, getBulkBatch, listBulkBatches, previewBulk, undoBulk } from './bulkEdit'
import { voucherToPayload } from '@shared/voucherEdit'

function group(db: DB, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}
function ledger(db: DB, name: string, groupName: string): number {
  return createLedger(db, { name, groupId: group(db, groupName), openingBalance: 0 }).id
}
function typeId(db: DB, kind: VoucherKind): number {
  return (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
}
const header = {
  partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
  vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, inventory: [], billRefs: [], tds: null
}

function books(db: DB) {
  const rent = ledger(db, 'Rent', 'Indirect Expenses')
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const sales = ledger(db, 'Sales', 'Sales Accounts')
  const alpha = ledger(db, 'Alpha Traders', 'Sundry Debtors')
  const beta = ledger(db, 'Beta Stores', 'Sundry Debtors')
  const ccA = saveCostCentre(db, { name: 'Branch A', parentId: null, active: true }).id
  const ccB = saveCostCentre(db, { name: 'Branch B', parentId: null, active: true }).id
  const journal = (date: string, narration: string, amount = 10000, cc: number | null = null): number =>
    saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'journal'), date, narration,
      lines: [
        { ledgerId: rent, drCr: 'dr', amount, costAllocations: cc ? [{ costCentreId: cc, amount }] : [] },
        { ledgerId: cash, drCr: 'cr', amount, costAllocations: [] }
      ]
    }).id
  const sale = (date: string, party: number, amount = 50000): number =>
    saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'sales'), date, partyLedgerId: party, narration: 'Sale',
      lines: [
        { ledgerId: party, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }
      ]
    }).id
  return { rent, cash, sales, alpha, beta, ccA, ccB, journal, sale }
}

const auditCount = (db: DB, entity: string): number => (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE entity = ?').get(entity) as { n: number }).n

describe('bulk edit — vouchers', () => {
  it('preview is a dry run whose results equal the apply', () => {
    const db = seededDb()
    const b = books(db)
    const ids = [b.journal('2025-05-01', 'Rent May'), b.journal('2025-06-01', 'Rent June'), b.journal('2025-07-01', 'Rent July')]
    const req = { target: 'voucher' as const, ids, change: { field: 'narration' as const, mode: 'append' as const, text: '(checked)' } }
    const auditBefore = auditCount(db, 'voucher')
    const preview = previewBulk(db, req)
    // Nothing kept: narrations, audit rows, batches.
    expect(getVoucher(db, ids[0]!)!.narration).toBe('Rent May')
    expect(auditCount(db, 'voucher')).toBe(auditBefore)
    expect(listBulkBatches(db)).toEqual([])
    expect(preview.batchId).toBeNull()
    expect(preview.applied).toBe(3)

    const applied = applyBulk(db, req)
    expect(applied.batchId).not.toBeNull()
    expect({ ...applied, batchId: null }).toEqual(preview)
    expect(ids.map((id) => getVoucher(db, id)!.narration)).toEqual(['Rent May (checked)', 'Rent June (checked)', 'Rent July (checked)'])
    expect(auditCount(db, 'voucher')).toBe(auditBefore + 3)
    expect(auditCount(db, 'bulk_batch')).toBe(1)
    expect(applied.records[0]).toMatchObject({ status: 'applied', before: 'Rent May', after: 'Rent May (checked)' })
    expect(applied.summary).toContain('3 vouchers')
  })

  it('refuses with the normal save rules: lock date, closing journal, credit hold, the bin', () => {
    const db = seededDb()
    const b = books(db)
    const locked = b.journal('2025-04-10', 'Old')
    const closing = b.journal('2025-06-10', 'Closing')
    db.prepare('UPDATE vouchers SET is_year_end_close = 1 WHERE id = ?').run(closing)
    const binned = b.journal('2025-06-11', 'Binned')
    deleteVoucher(db, binned)
    const fine = b.journal('2025-06-12', 'Fine')
    setLockDate(db, '2025-04-30')
    const res = applyBulk(db, { target: 'voucher', ids: [locked, closing, binned, fine, 999999], change: { field: 'narration', mode: 'replace', text: 'Bulk' } })
    const by = new Map(res.records.map((r) => [r.id, r]))
    expect(by.get(locked)).toMatchObject({ status: 'refused', reason: 'Books are locked up to 2025-04-30' })
    expect(by.get(closing)).toMatchObject({ status: 'refused', reason: YEAR_END_CLOSE_IMMUTABLE })
    expect(by.get(binned)!.reason).toMatch(/in the bin/)
    expect(by.get(999999)!.reason).toBe('Voucher not found')
    expect(by.get(fine)!.status).toBe('applied')
    expect(getVoucher(db, fine)!.narration).toBe('Bulk')
    expect(getVoucher(db, locked)!.narration).toBe('Old')
    // A date moved into the locked period is refused too.
    const moved = applyBulk(db, { target: 'voucher', ids: [fine], change: { field: 'date', date: '2025-04-15' } })
    expect(moved.records[0]).toMatchObject({ status: 'refused', reason: 'Books are locked up to 2025-04-30' })
    expect(moved.batchId).toBeNull() // nothing applied → no batch

    // Credit hold: moving an invoice onto a held party creates new credit there.
    const inv = b.sale('2025-06-15', b.alpha)
    db.prepare("UPDATE ledgers SET credit_hold = 1, credit_hold_reason = '90+ days' WHERE id = ?").run(b.beta)
    const party = previewBulk(db, { target: 'voucher', ids: [inv], change: { field: 'party', from: null, to: b.beta } })
    expect(party.records[0]!.status).toBe('refused')
    expect(party.records[0]!.reason).toMatch(/^Credit hold: Beta Stores is on credit hold \(90\+ days\)/)
    db.prepare('UPDATE ledgers SET credit_hold = 0 WHERE id = ?').run(b.beta)
    const ok = applyBulk(db, { target: 'voucher', ids: [inv], change: { field: 'party', from: b.alpha, to: b.beta } })
    expect(ok.records[0]).toMatchObject({ status: 'applied', before: 'Alpha Traders', after: 'Beta Stores' })
    const after = getVoucher(db, inv)!
    expect(after.partyLedgerId).toBe(b.beta)
    expect(after.lines.find((l) => l.drCr === 'dr')!.ledgerId).toBe(b.beta)
  })

  it('voucher type: another series of the same kind, never across posting rules', () => {
    const db = seededDb()
    const b = books(db)
    const j = b.journal('2025-06-01', 'J')
    const s = b.sale('2025-06-02', b.alpha)
    const series = createVoucherType(db, { name: 'Branch journal', kind: 'journal', numbering: 'auto', prefix: 'BJ/', suffix: '', padWidth: 0, restartFy: true })
    const res = applyBulk(db, { target: 'voucher', ids: [j, s], change: { field: 'voucherType', voucherTypeId: series.id } })
    expect(res.records.find((r) => r.id === j)).toMatchObject({ status: 'applied', after: 'Branch journal' })
    expect(getVoucher(db, j)!.voucherTypeId).toBe(series.id)
    expect(getVoucher(db, j)!.number.startsWith('BJ/')).toBe(true)
    expect(res.records.find((r) => r.id === s)!.reason).toMatch(/can't become a journal/)
  })

  it('cost centre and unchanged records', () => {
    const db = seededDb()
    const b = books(db)
    const a = b.journal('2025-06-01', 'A', 10000, b.ccA)
    const none = b.journal('2025-06-02', 'none')
    const res = applyBulk(db, { target: 'voucher', ids: [a, none], change: { field: 'costCentre', from: b.ccA, to: b.ccB } })
    expect(res.records.find((r) => r.id === a)!.status).toBe('applied')
    expect(res.records.find((r) => r.id === none)).toMatchObject({ status: 'unchanged' })
    expect(getVoucher(db, a)!.lines[0]!.costAllocations.map((x) => x.costCentreId)).toEqual([b.ccB])
  })
})

describe('bulk edit — undo', () => {
  it('reverts records unchanged since and reports the rest (partial undo)', () => {
    const db = seededDb()
    const b = books(db)
    const ids = [b.journal('2025-05-01', 'One'), b.journal('2025-05-02', 'Two'), b.journal('2025-05-03', 'Three')]
    const res = applyBulk(db, { target: 'voucher', ids, change: { field: 'narration', mode: 'replace', text: 'Bulk' } })
    // Someone edits the second voucher after the bulk edit.
    const v2 = getVoucher(db, ids[1]!)!
    saveVoucher(db, { ...voucherToPayload(v2), narration: 'Edited by hand' }, v2.id)

    const undo = undoBulk(db, res.batchId!)
    expect(undo.undone).toBe(2)
    expect(undo.refused).toBe(1)
    expect(undo.status).toBe('partly_undone')
    expect(undo.records.find((r) => r.id === ids[1])!.reason).toMatch(/^Changed since the bulk edit \(update by /)
    expect(ids.map((id) => getVoucher(db, id)!.narration)).toEqual(['One', 'Edited by hand', 'Three'])
    // Lines identical to before the bulk edit.
    expect(getVoucher(db, ids[0]!)!.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[b.rent, 'dr', 10000], [b.cash, 'cr', 10000]])
    const detail = getBulkBatch(db, res.batchId!)
    expect(detail.records.map((r) => r.status)).toEqual(['undone', 'undo_refused', 'undone'])
    expect(auditCount(db, 'bulk_batch')).toBe(2)

    // Retrying refuses the same record again; the batch stays partly undone.
    const again = undoBulk(db, res.batchId!)
    expect(again.undone).toBe(0)
    expect(again.status).toBe('partly_undone')
  })

  it('a full undo marks the batch undone; undoing it again is refused', () => {
    const db = seededDb()
    const b = books(db)
    const id = b.journal('2025-05-01', 'One')
    const res = applyBulk(db, { target: 'voucher', ids: [id], change: { field: 'date', date: '2025-05-20' } })
    expect(getVoucher(db, id)!.date).toBe('2025-05-20')
    expect(undoBulk(db, res.batchId!).status).toBe('undone')
    expect(getVoucher(db, id)!.date).toBe('2025-05-01')
    expect(() => undoBulk(db, res.batchId!)).toThrow(/already been undone/)
    expect(listBulkBatches(db)[0]!.status).toBe('undone')
  })

  it('undo goes through the save rules too: a lock set since refuses it', () => {
    const db = seededDb()
    const b = books(db)
    const id = b.journal('2025-05-01', 'One')
    const res = applyBulk(db, { target: 'voucher', ids: [id], change: { field: 'narration', mode: 'replace', text: 'x' } })
    setLockDate(db, '2025-05-31')
    const undo = undoBulk(db, res.batchId!)
    expect(undo.records[0]).toMatchObject({ status: 'undo_refused', reason: 'Books are locked up to 2025-05-31' })
    expect(undo.status).toBe('applied')
  })
})

describe('bulk edit — masters', () => {
  it('ledgers: group, credit terms, price level; system ledgers keep their group; undo', () => {
    const db = seededDb()
    const b = books(db)
    const res = applyBulk(db, { target: 'ledger', ids: [b.alpha, b.beta, b.cash], change: { field: 'creditDays', creditDays: 45 } })
    expect(res.applied).toBe(3)
    expect(getLedger(db, b.alpha)!.creditDays).toBe(45)
    const g = applyBulk(db, { target: 'ledger', ids: [b.alpha, b.cash], change: { field: 'group', groupId: group(db, 'Sundry Creditors') } })
    expect(g.records.find((r) => r.id === b.cash)).toMatchObject({ status: 'refused', reason: 'A system ledger stays in its group' })
    expect(getLedger(db, b.alpha)!.groupId).toBe(group(db, 'Sundry Creditors'))
    // Alpha changed since (the group batch) — its credit terms stay; the other two revert.
    const undo = undoBulk(db, res.batchId!)
    expect(undo.undone).toBe(2)
    expect(undo.records.find((r) => r.id === b.alpha)!.status).toBe('undo_refused')
    expect(getLedger(db, b.beta)!.creditDays).toBeNull()
    expect(getLedger(db, b.alpha)!.creditDays).toBe(45)
    expect(getLedger(db, b.alpha)!.groupId).toBe(group(db, 'Sundry Creditors'))
    // Undoing the later batch is itself a change since the earlier one: the earlier batch still
    // leaves Alpha alone (strictly "unchanged since" — the trail decides, never a field compare).
    expect(undoBulk(db, g.batchId!).undone).toBe(1)
    expect(getLedger(db, b.alpha)).toMatchObject({ creditDays: 45, groupId: group(db, 'Sundry Debtors') })
    expect(undoBulk(db, res.batchId!).status).toBe('partly_undone')
  })

  it('items: GST rate applies, a bad HSN is refused', () => {
    const db = seededDb()
    const unit = (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }).id
    const mk = (name: string): number =>
      createStockItem(db, { name, groupId: null, unitId: unit, hsn: '8471', gstRate: 12, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null }).id
    const ids = [mk('Widget'), mk('Gadget')]
    const rate = applyBulk(db, { target: 'stockItem', ids, change: { field: 'gstRate', gstRate: 18 } })
    expect(rate.applied).toBe(2)
    expect(getStockItem(db, ids[0]!)!.gstRate).toBe(18)
    const hsn = previewBulk(db, { target: 'stockItem', ids, change: { field: 'hsn', hsn: '12x' } })
    expect(hsn.records.every((r) => r.status === 'refused' && r.reason === 'HSN must be digits only')).toBe(true)
    expect(auditCount(db, 'stockItem')).toBe(4) // 2 creates + 2 bulk updates
  })
})
