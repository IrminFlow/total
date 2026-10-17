// To-do §4 / WP 4.4 — foreign-currency openings entered in their currency: the rupee opening =
// foreign amount × the rate on the books-begin day (through masters), the foreign amount kept in
// fx_ledger_currency.opening_fc; the revaluation folds it in first; statements show both
// currencies; opening bills of a foreign party each carry their share at that one rate.
// Figures are worked by hand in the comments. Books begin 1 Apr 2025 (TEST_INFO).
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import type { VoucherInput } from '@shared/schemas'
import { createLedger, getLedger } from './masters'
import { getVoucher, saveVoucher } from './vouchers'
import { ledgerStatement } from './reports'
import { outstandings } from './analysis'
import { replaceOpeningBills } from './openingBills'
import { openBills, postRevaluation, revaluationPreview, saveRate, setForeignOpening, settle } from './forex'

const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const lid = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
const ledger = (db: DB, name: string, group: string, openingBalance = 0): number => createLedger(db, { name, groupId: gid(db, group), openingBalance }).id
const vt = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
const L = (ledgerId: number, drCr: 'dr' | 'cr', amount: number) => ({ ledgerId, drCr, amount, costAllocations: [] })
const post = (db: DB, kind: string, date: string, lines: VoucherInput['lines'], extra: Partial<VoucherInput> = {}): number =>
  saveVoucher(db, { voucherTypeId: vt(db, kind), date, partyLedgerId: null, narration: null, reference: null, lines, inventory: [], billRefs: [], tds: null, ...extra }).id

function books() {
  const db = seededDb()
  const bank = ledger(db, 'HDFC', 'Bank Accounts', 5_00_000_00)
  const cust = ledger(db, 'Globex', 'Sundry Debtors')
  const supp = ledger(db, 'Initech', 'Sundry Creditors')
  const sales = ledger(db, 'Export Sales', 'Sales Accounts')
  return { db, bank, cust, supp, sales }
}

describe('foreign opening entered in its currency', () => {
  it('a customer: USD 1,000 at ₹82 on the books-begin day + a USD 500 invoice at ₹84, revalued at ₹83 = a ₹500 gain', () => {
    const { db, cust, sales } = books()
    saveRate(db, { date: '2025-04-01', currencyCode: 'USD', rateMicro: 82_000_000 })
    // No rate given: the one stored on the books-begin day. 1,000.00 × 82 = ₹82,000.
    const r = setForeignOpening(db, { ledgerId: cust, currencyCode: 'USD', fc: 1000_00 })
    expect(r).toMatchObject({ openingInr: 82_000_00, rateMicro: 82_000_000, rateDate: '2025-04-01', booksBegin: '2025-04-01' })
    expect(getLedger(db, cust)!.openingBalance).toBe(82_000_00)
    // USD 500 at ₹84 = ₹42,000.
    post(db, 'journal', '2025-06-10', [L(cust, 'dr', 42_000_00), L(sales, 'cr', 42_000_00)], { partyLedgerId: cust, currencyCode: 'USD', exchangeRate: 84 })
    saveRate(db, { date: '2025-09-30', currencyCode: 'USD', rateMicro: 83_000_000 })
    // Hand: opening 1,000 × (83 − 82) = +₹1,000; invoice 500 × (83 − 84) = −₹500; net gain ₹500.
    // Equivalently 1,500 × 83 = ₹1,24,500 against a book value of ₹82,000 + ₹42,000 = ₹1,24,000.
    const p = revaluationPreview(db, '2025-09-30')
    expect(p.rows).toHaveLength(1)
    expect(p.rows[0]).toMatchObject({ ledgerId: cust, fcBalance: 1500_00, inrBook: 1_24_000_00, target: 1_24_500_00, gainLoss: 500_00, rupeeLines: 0 })
    const rev = postRevaluation(db, { asOf: '2025-09-30', autoReverse: true })
    const j = getVoucher(db, rev.voucherId!)!
    expect(j.lines.find((l) => l.ledgerId === cust)).toMatchObject({ drCr: 'dr', amount: 500_00 })
    expect(j.lines.find((l) => l.ledgerId === lid(db, 'Unrealised Forex Gain'))).toMatchObject({ drCr: 'cr', amount: 500_00 })
    // The statement shows the opening in both currencies.
    const st = ledgerStatement(db, cust, '2025-04-01', '2025-09-30')
    expect(st.opening).toBe(82_000_00)
    expect(st.foreignOpening).toEqual({ currencyCode: 'USD', fc: 1000_00, inr: 82_000_00, rateMicro: 82_000_000 })
    // A later period's opening includes movements: the stored opening is still the books-begin one.
    expect(ledgerStatement(db, cust, '2025-07-01', '2025-09-30').foreignOpening).toMatchObject({ fc: 1000_00, inr: 82_000_00 })
  })

  it('a supplier: USD 2,000 Cr at a typed ₹80, revalued at ₹81 = a ₹2,000 loss', () => {
    const { db, supp } = books()
    const r = setForeignOpening(db, { ledgerId: supp, currencyCode: 'USD', fc: -2000_00, rateMicro: 80_000_000 })
    expect(r).toMatchObject({ openingInr: -1_60_000_00, rateDate: null })
    saveRate(db, { date: '2025-12-31', currencyCode: 'USD', rateMicro: 81_000_000 })
    // Hand: owe 2,000 × 81 = ₹1,62,000 against ₹1,60,000 booked → the liability grows ₹2,000.
    expect(revaluationPreview(db, '2025-12-31').rows[0]).toMatchObject({ kind: 'payable', fcBalance: -2000_00, inrBook: -1_60_000_00, gainLoss: -2_000_00 })
    expect(revaluationPreview(db, '2025-12-31')).toMatchObject({ gain: 0, loss: 2_000_00 })
  })

  it('opening bills each carry their share at the opening rate; settling one is bill-wise and Outstandings agree', () => {
    const { db, cust, bank } = books()
    setForeignOpening(db, { ledgerId: cust, currencyCode: 'USD', fc: 1000_00, rateMicro: 82_000_000 })
    replaceOpeningBills(db, cust, [
      { name: 'EX-7', date: '2025-03-01', dueDate: null, amount: 50_000_00 },
      { name: 'EX-9', date: '2025-03-15', dueDate: null, amount: 32_000_00 }
    ])
    // Hand: EX-7 = 1,000.00 × 50,000 / 82,000 = 609.756… → USD 609.76; EX-9 takes the rest, 390.24.
    expect(openBills(db, cust, '2025-05-01').bills).toEqual([
      { name: 'EX-7', voucherId: null, date: '2025-03-01', fcOpen: 609_76, bookOpen: 50_000_00 },
      { name: 'EX-9', voucherId: null, date: '2025-03-15', fcOpen: 390_24, bookOpen: 32_000_00 }
    ])
    // Settle EX-7 in full at ₹85: bank 609.76 × 85 = ₹51,829.60, book ₹50,000 → realised gain ₹1,829.60.
    const s = settle(db, { partyLedgerId: cust, bankLedgerId: bank, date: '2025-05-01', bills: [{ name: 'EX-7', fc: 609_76 }], settleRateMicro: 85_000_000 })
    expect(s).toMatchObject({ bankInr: 51_829_60, partyInr: 50_000_00, gainLoss: 1_829_60 })
    const out = outstandings(db, 'receivable', '2025-05-01').find((p) => p.ledgerId === cust)!
    expect(out.bills.map((b) => [b.number, b.pending])).toEqual([['EX-9', 32_000_00]])
    expect(openBills(db, cust, '2025-05-01').bills.map((b) => [b.name, b.fcOpen])).toEqual([['EX-9', 390_24]])
    // Re-entering the opening at another rate would move the rupee opening under a bill in use: refused.
    expect(() => setForeignOpening(db, { ledgerId: cust, currencyCode: 'USD', fc: 1000_00, rateMicro: 83_000_000 })).toThrow(/already has a payment/)
    expect(getLedger(db, cust)!.openingBalance).toBe(82_000_00)
  })

  it('bills no longer fitting a changed opening are cleared (audited), as for any opening change', () => {
    const { db, cust } = books()
    setForeignOpening(db, { ledgerId: cust, currencyCode: 'USD', fc: 1000_00, rateMicro: 82_000_000 })
    replaceOpeningBills(db, cust, [{ name: 'EX-7', date: '2025-03-01', dueDate: null, amount: 82_000_00 }])
    setForeignOpening(db, { ledgerId: cust, currencyCode: 'USD', fc: 1000_00, rateMicro: 83_000_000 })
    expect(getLedger(db, cust)!.openingBalance).toBe(83_000_00)
    expect(db.prepare('SELECT COUNT(*) AS n FROM opening_bills').get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'opening_bills' AND action = 'delete'").get()).toEqual({ n: 1 })
    expect(openBills(db, cust, '2025-05-01').bills).toEqual([{ name: 'Opening', voucherId: null, date: '0000-01-01', fcOpen: 1000_00, bookOpen: 83_000_00 }])
    // audited: the ledger's opening + the foreign amount
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'ledger' AND entity_id = ? AND action = 'update'").get(cust) as { n: number }).n).toBe(2)
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'fx_ledger_currency' AND entity_id = ?").get(cust) as { n: number }).n).toBe(2)
  })

  it('refuses a non-party / non-bank ledger and a missing rate, leaving nothing behind', () => {
    const { db, cust, sales } = books()
    expect(() => setForeignOpening(db, { ledgerId: sales, currencyCode: 'USD', fc: 100_00, rateMicro: 80_000_000 })).toThrow(/not a customer, supplier or bank/)
    expect(() => setForeignOpening(db, { ledgerId: cust, currencyCode: 'USD', fc: 100_00 })).toThrow(/rate on 01/)
    expect(getLedger(db, cust)!.openingBalance).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM fx_ledger_currency').get()).toEqual({ n: 0 })
  })

  it('a ledger without a foreign opening is unchanged: no foreignOpening on its statement, one rupee-free exposure as before', () => {
    const { db, cust, sales } = books()
    post(db, 'journal', '2025-06-10', [L(cust, 'dr', 42_000_00), L(sales, 'cr', 42_000_00)], { partyLedgerId: cust, currencyCode: 'USD', exchangeRate: 84 })
    const st = ledgerStatement(db, cust, '2025-04-01', '2025-09-30')
    expect('foreignOpening' in st).toBe(false)
    expect(openBills(db, cust, '2025-09-30').bills.map((b) => b.name)).toEqual(['1'])
  })
})
