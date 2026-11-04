// WP 4.4 review fixes: revaluation / settlement vouchers are bin-only and restore safely;
// rupee entries on a foreign party are not revalued; foreign openings; bill-wise settlement with
// bill references; challans in the forecast.
import { describe, expect, it } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import type { VoucherInput } from '@shared/schemas'
import { createLedger } from './masters'
import { deleteVoucher, getVoucher, restoreVoucher, saveVoucher } from './vouchers'
import { closingBalances } from './reports'
import { outstandings } from './analysis'
import { listRevaluations, openBills } from './forex'
// The forex writes went in the 1.0 cleanup; the legacy fixture writes what an older Total wrote.
import { postRevaluation, revaluationPreview, saveRate, setLedgerCurrency, settle } from './forexLegacy.testutil'
import { forecastBase } from './cashForecast'
import { dc, item, tradeBooks } from './tradeFixture.testutil'

const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const lid = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
function ledger(db: DB, name: string, group: string, openingBalance = 0): number {
  return createLedger(db, {
    name, groupId: gid(db, group), openingBalance, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}
const vt = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
const L = (ledgerId: number, drCr: 'dr' | 'cr', amount: number) => ({ ledgerId, drCr, amount, costAllocations: [] })
function post(db: DB, kind: string, date: string, lines: VoucherInput['lines'], extra: Partial<VoucherInput> = {}): number {
  return saveVoucher(db, { voucherTypeId: vt(db, kind), date, partyLedgerId: null, narration: null, reference: null, lines, inventory: [], billRefs: [], tds: null, ...extra }).id
}
const editAttempt = (db: DB, id: number): void => {
  const v = getVoucher(db, id)!
  saveVoucher(db, { ...v, narration: 'changed', lines: v.lines.map((l) => ({ ...l, costAllocations: [] })), inventory: [], billRefs: [], tds: null } as unknown as VoucherInput, id)
}

function usdBooks() {
  const db = seededDb()
  const bank = ledger(db, 'HDFC', 'Bank Accounts', 5_00_000_00)
  const cust = ledger(db, 'Globex', 'Sundry Debtors')
  const sales = ledger(db, 'Sales', 'Sales Accounts')
  return { db, bank, cust, sales }
}
const usdInvoice = (db: DB, cust: number, sales: number, date: string, inr: number, rate: number, bill?: string): number =>
  post(db, 'journal', date, [L(cust, 'dr', inr), L(sales, 'cr', inr)], {
    partyLedgerId: cust, currencyCode: 'USD', exchangeRate: rate, billRefs: bill ? [{ kind: 'new', name: bill, amount: inr, dueDate: null }] : []
  })

describe('forex revaluation pairs', () => {
  it('binning the revaluation bins its reversal (and the other way round); restore brings both back', () => {
    const { db, cust, sales } = usdBooks()
    usdInvoice(db, cust, sales, '2026-03-10', 82_000_00, 82)
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 83_250_000 })
    const rev = postRevaluation(db, { asOf: '2026-03-31', autoReverse: true })
    expect(() => editAttempt(db, rev.voucherId!)).toThrow(/revaluation journal/)
    deleteVoucher(db, rev.voucherId!)
    expect(getVoucher(db, rev.reversalVoucherId!)!.deletedAt).not.toBeNull()
    expect(closingBalances(db, '2026-04-02').get(cust)).toBe(82_000_00)
    restoreVoucher(db, rev.reversalVoucherId!)
    expect(getVoucher(db, rev.voucherId!)!.deletedAt).toBeNull()
    expect(closingBalances(db, '2026-03-31').get(cust)).toBe(83_250_00)
    expect(closingBalances(db, '2026-04-02').get(cust)).toBe(82_000_00)
  })

  it('a second revaluation on the same date is allowed while the first is binned; restoring the first is then refused', () => {
    const { db, cust, sales } = usdBooks()
    usdInvoice(db, cust, sales, '2026-03-10', 82_000_00, 82)
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 83_250_000 })
    const first = postRevaluation(db, { asOf: '2026-03-31', autoReverse: true })
    deleteVoucher(db, first.voucherId!)
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 83_000_000 })
    const second = postRevaluation(db, { asOf: '2026-03-31', autoReverse: true })
    expect(second.gain).toBe(1_000_00)
    expect(() => restoreVoucher(db, first.voucherId!)).toThrow(/newer revaluation/)
    expect(listRevaluations(db).filter((r) => r.live)).toHaveLength(1)
  })
})

describe('revaluations leave bill-wise ageing alone', () => {
  it('revaluation + reversal on a bill-tracked customer: Outstandings bills and buckets unchanged', () => {
    const { db, cust, sales } = usdBooks()
    usdInvoice(db, cust, sales, '2026-01-10', 80_000_00, 80, 'E1')
    usdInvoice(db, cust, sales, '2026-03-10', 82_000_00, 82, 'E2')
    const snap = (asOn: string) => {
      const p = outstandings(db, 'receivable', asOn).find((x) => x.ledgerId === cust)!
      return { bills: p.bills.map((b) => [b.number, b.date, b.pending]), buckets: p.buckets, pending: p.pending }
    }
    const before31 = snap('2026-03-31')
    const beforeApr = snap('2026-04-15')
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 83_000_000 })
    const rev = postRevaluation(db, { asOf: '2026-03-31', autoReverse: true })
    expect(rev.gain).toBe(1_000_00 + 3_000_00)
    expect(snap('2026-03-31')).toEqual(before31)
    expect(snap('2026-04-15')).toEqual(beforeApr)
    expect(snap('2026-04-15').bills).toEqual([['E1', '2026-01-10', 80_000_00], ['E2', '2026-03-10', 82_000_00]])
    // the ledger itself is restated on 31 March and back the next day
    expect(closingBalances(db, '2026-03-31').get(cust)).toBe(1_66_000_00)
    expect(closingBalances(db, '2026-04-15').get(cust)).toBe(1_62_000_00)
  })
})

describe('rupee entries and foreign openings', () => {
  it('a rupee sale before the USD invoice is not revalued (review case)', () => {
    const { db, cust, sales } = usdBooks()
    post(db, 'journal', '2026-03-01', [L(cust, 'dr', 50_000_00), L(sales, 'cr', 50_000_00)], { partyLedgerId: cust })
    usdInvoice(db, cust, sales, '2026-03-10', 82_000_00, 82)
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 83_000_000 })
    const p = revaluationPreview(db, '2026-03-31')
    expect(p.rows[0]).toMatchObject({ fcBalance: 1000_00, inrBook: 82_000_00, gainLoss: 1_000_00, rupeeLines: 1 })
  })

  it('a rupee receipt after the USD invoice leaves the foreign balance alone', () => {
    const { db, cust, sales, bank } = usdBooks()
    usdInvoice(db, cust, sales, '2026-03-10', 82_000_00, 82)
    post(db, 'receipt', '2026-03-20', [L(bank, 'dr', 10_000_00), L(cust, 'cr', 10_000_00)], { partyLedgerId: cust })
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 83_000_000 })
    expect(revaluationPreview(db, '2026-03-31').rows[0]).toMatchObject({ fcBalance: 1000_00, inrBook: 82_000_00, rupeeLines: 1 })
  })

  it('a Tally-style rupee opening counts as foreign money once its foreign amount is entered', () => {
    const db = seededDb()
    const cust = ledger(db, 'Imported Debtor', 'Sundry Debtors', 41_000_00)
    setLedgerCurrency(db, cust, 'USD', 500_00)
    saveRate(db, { date: '2026-03-31', currencyCode: 'USD', rateMicro: 84_000_000 })
    expect(revaluationPreview(db, '2026-03-31').rows[0]).toMatchObject({ fcBalance: 500_00, inrBook: 41_000_00, gainLoss: 1_000_00 })
    expect(() => setLedgerCurrency(db, cust, 'USD', -500_00)).toThrow(/same side/)
    expect(openBills(db, cust, '2026-03-31').bills[0]).toMatchObject({ name: 'Opening', fcOpen: 500_00, bookOpen: 41_000_00 })
  })
})

describe('bill-wise settlement', () => {
  it('relieves each invoice at its own rate, with bill refs so Outstandings agree; edit and double restore refused', () => {
    const { db, cust, sales, bank } = usdBooks()
    usdInvoice(db, cust, sales, '2026-01-10', 80_000_00, 80, 'E1')
    usdInvoice(db, cust, sales, '2026-02-10', 84_000_00, 84, 'E2')
    const r = settle(db, { partyLedgerId: cust, bankLedgerId: bank, date: '2026-03-01', bills: [{ name: 'E2', fc: 1000_00 }], settleRateMicro: 83_000_000 })
    expect(r).toMatchObject({ bankInr: 83_000_00, partyInr: 84_000_00, gainLoss: -1_000_00 })
    // a receipt at a loss puts the loss on the money side → posted as one journal
    const v = getVoucher(db, r.voucherId)!
    expect(v.lines.find((l) => l.ledgerId === lid(db, 'Realised Forex Loss'))).toMatchObject({ drCr: 'dr', amount: 1_000_00 })
    expect(v.billRefs).toEqual([expect.objectContaining({ kind: 'against', name: 'E2', amount: 84_000_00 })])
    const out = outstandings(db, 'receivable', '2026-03-01').find((p) => p.ledgerId === cust)!
    expect(out.bills.map((b) => [b.number, b.pending])).toEqual([['E1', 80_000_00]])
    expect(openBills(db, cust, '2026-03-01').bills.map((b) => b.name)).toEqual(['E1'])
    expect(() => editAttempt(db, r.voucherId)).toThrow(/forex settlement/)
    deleteVoucher(db, r.voucherId)
    settle(db, { partyLedgerId: cust, bankLedgerId: bank, date: '2026-03-02', bills: [{ name: 'E2', fc: 1000_00 }], settleRateMicro: 85_000_000 })
    expect(() => restoreVoucher(db, r.voucherId)).toThrow(/settled again/)
  })

  it('a gain on a receipt stays a Receipt voucher', () => {
    const { db, cust, sales, bank } = usdBooks()
    usdInvoice(db, cust, sales, '2026-01-10', 80_000_00, 80, 'E1')
    const r = settle(db, { partyLedgerId: cust, bankLedgerId: bank, date: '2026-03-01', fcAmount: 1000_00, settleRateMicro: 83_000_000 })
    expect(r.gainLoss).toBe(3_000_00)
    const kind = db.prepare('SELECT vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = ?').get(r.voucherId) as { kind: string }
    expect(kind.kind).toBe('receipt')
    expect(closingBalances(db, '2026-03-01').get(cust)).toBe(0)
  })

  it('the gain ledger is not a same-named balance-sheet ledger', () => {
    const { db, cust, sales, bank } = usdBooks()
    ledger(db, 'Realised Forex Gain', 'Current Liabilities')
    usdInvoice(db, cust, sales, '2026-01-10', 80_000_00, 80, 'E1')
    const r = settle(db, { partyLedgerId: cust, bankLedgerId: bank, date: '2026-03-01', fcAmount: 1000_00, settleRateMicro: 83_000_000 })
    const gainLine = getVoucher(db, r.voucherId)!.lines.find((l) => l.drCr === 'cr' && l.ledgerId !== cust)!
    expect(gainLine.ledgerId).toBe(lid(db, 'Realised Forex Gain (forex)'))
  })
})

describe('forecast', () => {
  it('a challan delivered but not invoiced is an expected receipt', () => {
    const b = tradeBooks()
    const widget = item(b.db, 'Widget', { opening: [10, 10_000_00] })
    dc(b, '2026-06-01', [{ item: widget, qty: 2, amount: 3_000_00 }], { purpose: 'supply' })
    const base = forecastBase(b.db, TEST_INFO, '2026-06-05', '2026-09-01')
    const f = base.flows.find((x) => x.label.includes('not invoiced'))!
    expect(f).toMatchObject({ source: 'receivable', direction: 'in', amount: 3_000_00, ledgerId: b.buyer })
  })
})
