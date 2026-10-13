// WP 8.7: the simple opening setup. After the user confirms, the opening balances agree (Dr = Cr)
// with the difference on the capital account; opening bills show in Outstandings one by one,
// aged from their own date (blank = the books-begin day, never the FY re-dated start); item
// openings feed the valuation pass (closing stock = qty × cost); a re-run of the same answers
// changes nothing; a row changed elsewhere is left alone with a warning; the preview writes
// nothing; refusals write nothing; audit rows are written and the chain stays valid.
import { describe, expect, it } from 'vitest'
import { freshDb, seededDb, postSimpleVoucher } from '../db/testdb'
import { applySetup } from './companySetup'
import { applyOpenings, openingsState, previewOpenings, skipOpenings } from './openings'
import { verifyAudit } from './audit'
import { balanceSheet, trialBalance } from './reports'
import { outstandings, partyAllocation } from './analysis'
import { stockSummary, stockValue } from './stockAnalysis'
import { openingTotals } from './dataImport'
import { getUi } from './config'
import { getLedger, listStockItems, updateLedger } from './masters'
import { stableBillKey } from '@shared/receivables/types'
import type { DB } from '../db/connection'
import type { SimpleOpeningsInput } from '@shared/simple/openings'

const TODAY = '2026-10-13'

function kirana(startDate = '2026-04-01'): DB {
  const db = freshDb()
  applySetup(db, { name: 'Ramesh Kirana', stateCode: '27', businessType: 'retail', gst: 'no', gstin: null, filing: null, stock: true, startDate, fresh: false }, TODAY)
  return db
}

const ledgerId = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
const opening = (db: DB, name: string): number => (db.prepare('SELECT opening_balance AS o FROM ledgers WHERE name = ?').get(name) as { o: number }).o
const count = (db: DB, table: string, where = '1'): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n
const kgUnit = (db: DB): number => (db.prepare("SELECT id FROM units WHERE symbol = 'Kg'").get() as { id: number }).id

function answers(db: DB): SimpleOpeningsInput {
  return {
    cash: { amount: 5_000_00, base: 0 },
    banks: [{ ledgerId: null, name: 'HDFC current', amount: 20_000_00, base: null }],
    customers: [{ ledgerId: null, name: 'Sharma Stores', base: null, bills: [{ ref: 'B-12', date: '2026-03-10', amount: 3_000_00 }, { ref: '', date: null, amount: 1_500_00 }] }],
    suppliers: [{ ledgerId: null, name: 'Gupta Traders', base: null, bills: [{ ref: 'GT-881', date: '2026-03-25', amount: 8_000_00 }] }],
    items: [
      { itemId: null, name: 'Rice 25 kg bag', unitId: null, qtyMilli: 10_000, ratePaise: 1_200_00, base: null },
      { itemId: null, name: 'Sugar', unitId: kgUnit(db), qtyMilli: 2_500, ratePaise: 45_00, base: null }
    ],
    others: [{ kind: 'loan_taken', ledgerId: null, name: 'Bank loan', amount: 10_000_00, base: null }]
  }
}
// have = 5,000 + 20,000 + 4,500 + 12,000 + 112.50 = 41,612.50; owe = 8,000 + 10,000 = 18,000.
const HAVE = 41_612_50
const OWE = 18_000_00

function confirmAndApply(db: DB, input: SimpleOpeningsInput): ReturnType<typeof applyOpenings> {
  const preview = previewOpenings(db, input)
  return applyOpenings(db, { ...input, confirmCapital: preview.capital.after })
}

describe('simple opening setup', () => {
  it('preview shows the difference and writes nothing', () => {
    const db = kirana()
    const before = { ledgers: count(db, 'ledgers'), items: count(db, 'stock_items'), audit: count(db, 'audit_log'), bills: count(db, 'opening_bills') }
    const p = previewOpenings(db, answers(db))
    expect(p).toMatchObject({ booksBegin: '2026-04-01', have: HAVE, owe: OWE, difference: HAVE - OWE, balanced: true, warnings: [] })
    expect(p.capital).toMatchObject({ name: "Owner's money", before: 0, after: -(HAVE - OWE) })
    expect({ ledgers: count(db, 'ledgers'), items: count(db, 'stock_items'), audit: count(db, 'audit_log'), bills: count(db, 'opening_bills') }).toEqual(before)
    expect(verifyAudit(db).ok).toBe(true)
  })

  it('after confirmation the openings balance (Dr = Cr) with the difference on the capital account', () => {
    const db = kirana()
    const r = confirmAndApply(db, answers(db))
    expect(r.balanced).toBe(true)
    expect(r.capital.after).toBe(-(HAVE - OWE))
    expect(opening(db, "Owner's money")).toBe(-(HAVE - OWE))
    expect(opening(db, 'Cash')).toBe(5_000_00)
    expect(opening(db, 'HDFC current')).toBe(20_000_00)
    expect(opening(db, 'Sharma Stores')).toBe(4_500_00)
    expect(opening(db, 'Gupta Traders')).toBe(-8_000_00)
    expect(opening(db, 'Bank loan')).toBe(-10_000_00)
    expect(openingTotals(db).difference).toBe(0)
    const tb = trialBalance(db, '2026-04-01')
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(tb.totalDebit).toBe(HAVE)
    // No suspense account and no "Difference in Opening Balances" on the balance sheet.
    expect(count(db, 'ledgers', "name LIKE '%uspense%'")).toBe(0)
    const bs = balanceSheet(db, '2026-04-01', '2026-04-01')
    expect(bs.liabilities.some((n) => n.name === 'Difference in Opening Balances')).toBe(false)
    expect(bs.totalAssets).toBe(bs.totalLiabilities)
    // The accounts sit where the accountant view expects them.
    const groupOf = (name: string): string => (db.prepare('SELECT g.name AS g FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = ?').get(name) as { g: string }).g
    expect([groupOf('HDFC current'), groupOf('Sharma Stores'), groupOf('Gupta Traders'), groupOf('Bank loan'), groupOf("Owner's money")]).toEqual(
      ['Bank Accounts', 'Sundry Debtors', 'Sundry Creditors', 'Loans (Liability)', 'Capital Account']
    )
  })

  it('opening bills appear in Outstandings, aged from their own date or the books-begin day', () => {
    const db = kirana()
    confirmAndApply(db, answers(db))
    const rec = outstandings(db, 'receivable', '2026-05-01')
    const sharma = rec.find((p) => p.name === 'Sharma Stores')!
    expect(sharma.pending).toBe(4_500_00)
    expect(sharma.bills.map((b) => ({ number: b.number, date: b.date, pending: b.pending, ageDays: b.ageDays, voucherId: b.voucherId }))).toEqual([
      { number: 'B-12', date: '2026-03-10', pending: 3_000_00, ageDays: 52, voucherId: null },
      { number: 'Opening', date: '2026-04-01', pending: 1_500_00, ageDays: 30, voucherId: null }
    ])
    expect(stableBillKey(null, 'B-12')).toBe('o:B-12')
    const pay = outstandings(db, 'payable', '2026-05-01').find((p) => p.name === 'Gupta Traders')!
    expect(pay.bills).toMatchObject([{ number: 'GT-881', date: '2026-03-25', pending: 8_000_00, ageDays: 37 }])
    // The same allocation feeds the receipt's "settle against" list.
    expect(partyAllocation(db, ledgerId(db, 'Sharma Stores'), '2026-05-01').bills.map((b) => b.number)).toEqual(['B-12', 'Opening'])
    // In the next year the dated bill keeps its date (no FY re-dating).
    const later = outstandings(db, 'receivable', '2027-05-01').find((p) => p.name === 'Sharma Stores')!
    expect(later.bills[0]).toMatchObject({ number: 'B-12', date: '2026-03-10' })
  })

  it('a mid-year start dates undated bills on that day', () => {
    const db = kirana('2026-06-15')
    const input = answers(db)
    input.customers![0]!.bills = [{ ref: '', date: null, amount: 2_000_00 }, { ref: '', date: '2026-06-01', amount: 1_000_00 }]
    input.suppliers![0]!.bills = [{ ref: 'GT-881', date: '2026-06-01', amount: 8_000_00 }]
    confirmAndApply(db, input)
    const sharma = outstandings(db, 'receivable', '2026-07-15').find((p) => p.name === 'Sharma Stores')!
    expect(sharma.bills.map((b) => [b.number, b.date, b.ageDays])).toEqual([
      ['Opening 2', '2026-06-01', 44],
      ['Opening', '2026-06-15', 30]
    ])
  })

  it('item openings feed the valuation pass: closing stock = quantity × cost', () => {
    const db = kirana()
    confirmAndApply(db, answers(db))
    const items = listStockItems(db)
    expect(items.find((i) => i.name === 'Rice 25 kg bag')).toMatchObject({ openingQtyMilli: 10_000, openingValue: 12_000_00 })
    expect(items.find((i) => i.name === 'Sugar')).toMatchObject({ openingQtyMilli: 2_500, openingValue: 112_50 })
    expect(stockValue(db, '2026-04-30')).toBe(12_112_50)
    const rows = stockSummary(db, '2026-04-30')
    expect(rows.find((r) => r.name === 'Rice 25 kg bag')).toMatchObject({ closingQtyMilli: 10_000, closingValue: 12_000_00 })
  })

  it('re-running the same answers changes nothing and writes no audit row', () => {
    const db = kirana()
    confirmAndApply(db, answers(db))
    const audit = count(db, 'audit_log')
    const again = confirmAndApply(db, answers(db))
    expect(again.changed).toBe(0)
    expect(again.warnings).toEqual([])
    expect(count(db, 'audit_log')).toBe(audit)
    expect(count(db, 'ledgers', "name = 'Sharma Stores'")).toBe(1)
    expect(count(db, 'opening_bills')).toBe(3)
  })

  it('re-running from the loaded figures replaces untouched rows and leaves one edited elsewhere alone', () => {
    const db = kirana()
    const first = answers(db)
    confirmAndApply(db, first)
    // Edited in the full app afterwards.
    const hdfc = getLedger(db, ledgerId(db, 'HDFC current'))!
    updateLedger(db, hdfc.id, { ...hdfc, openingBalance: 25_000_00 })
    // The answers as the screen had them (bank loaded at 20,000, cash at 5,000), with more cash:
    // the bank changed under the screen and is kept; cash is replaced.
    const stale: SimpleOpeningsInput = { ...first, cash: { amount: 6_000_00, base: 5_000_00 }, banks: [{ ledgerId: hdfc.id, amount: 20_000_00, base: 20_000_00 }] }
    const preview = previewOpenings(db, stale)
    expect(preview.warnings).toEqual([{ kind: 'account', name: 'HDFC current', kept: 25_000_00 }])
    // A cash figure loaded before the first run (base 0) is stale now too.
    expect(previewOpenings(db, { ...stale, cash: { amount: 6_000_00, base: 0 } }).warnings).toHaveLength(2)
    const r = applyOpenings(db, { ...stale, confirmCapital: preview.capital.after })
    expect(opening(db, 'HDFC current')).toBe(25_000_00)
    expect(opening(db, 'Cash')).toBe(6_000_00)
    expect(r.balanced).toBe(true)
    expect(opening(db, "Owner's money")).toBe(-(HAVE + 1_000_00 + 5_000_00 - OWE))
    expect(openingTotals(db).difference).toBe(0)

    // The screen's own load round-trips: state → same answers → nothing changes.
    const s = openingsState(db)
    expect(s.cash.amount).toBe(6_000_00)
    expect(s.customers[0]).toMatchObject({ name: 'Sharma Stores', amount: 4_500_00, bills: [{ ref: 'B-12', date: '2026-03-10', amount: 3_000_00 }, { ref: 'Opening', date: '2026-04-01', amount: 1_500_00 }] })
    expect(s.items.find((i) => i.name === 'Sugar')).toMatchObject({ qtyMilli: 2_500, value: 112_50, ratePaise: 45_00 })
    const reload: SimpleOpeningsInput = {
      cash: { amount: s.cash.amount, base: s.cash.amount },
      banks: s.banks.map((b) => ({ ledgerId: b.ledgerId, amount: b.amount, base: b.amount })),
      customers: s.customers.map((p) => ({ ledgerId: p.ledgerId, base: p.amount, bills: p.bills })),
      suppliers: s.suppliers.map((p) => ({ ledgerId: p.ledgerId, base: -p.amount, bills: p.bills })),
      items: s.items.map((i) => ({ itemId: i.itemId, qtyMilli: i.qtyMilli, ratePaise: i.ratePaise, base: { qtyMilli: i.qtyMilli, value: i.value } })),
      others: s.others.map((o) => ({ kind: o.kind, ledgerId: o.ledgerId, amount: o.amount, base: -o.amount }))
    }
    expect(confirmAndApply(db, reload).changed).toBe(0)
  })

  it('clearing a loaded row clears it; a party opening edited in the full app keeps its bills consistent', () => {
    const db = kirana()
    confirmAndApply(db, answers(db))
    const sharma = ledgerId(db, 'Sharma Stores')
    // Raised in the full app: the extra is an unnamed opening bill; lowered: bills settle oldest first.
    const l = getLedger(db, sharma)!
    updateLedger(db, sharma, { ...l, openingBalance: 5_000_00 })
    expect(outstandings(db, 'receivable', '2026-05-01').find((p) => p.ledgerId === sharma)!.bills.map((b) => [b.number, b.pending])).toEqual([
      ['B-12', 3_000_00], ['Opening', 1_500_00], ['Opening', 500_00]
    ])
    updateLedger(db, sharma, { ...l, openingBalance: 2_000_00 })
    expect(outstandings(db, 'receivable', '2026-05-01').find((p) => p.ledgerId === sharma)!.bills.map((b) => [b.number, b.pending])).toEqual([['B-12', 500_00], ['Opening', 1_500_00]])
    // Cleared from the screen (loaded at 2,000): opening 0, its bills gone.
    const input = answers(db)
    input.customers = [{ ledgerId: sharma, base: 2_000_00, bills: [] }]
    confirmAndApply(db, input)
    expect(opening(db, 'Sharma Stores')).toBe(0)
    expect(count(db, 'opening_bills', `party_ledger_id = ${sharma}`)).toBe(0)
    expect(outstandings(db, 'receivable', '2026-05-01').find((p) => p.ledgerId === sharma)).toBeUndefined()
  })

  it('refuses negative amounts, duplicate bill numbers per party, bills after the start, and a stale confirmation — writing nothing', () => {
    const db = kirana()
    const before = { ledgers: count(db, 'ledgers'), audit: count(db, 'audit_log') }
    const a = answers(db)
    expect(() => previewOpenings(db, { ...a, cash: { amount: -1, base: 0 } })).toThrow()
    expect(() => previewOpenings(db, { ...a, customers: [{ ledgerId: null, name: 'X', base: null, bills: [{ ref: 'B1', date: null, amount: 100 }, { ref: 'b1 ', date: null, amount: 200 }] }] })).toThrow(/same number/)
    expect(() => previewOpenings(db, { ...a, customers: [{ ledgerId: null, name: 'X', base: null, bills: [{ ref: '', date: '2026-04-02', amount: 100 }] }] })).toThrow(/after the day the books begin/)
    expect(() => previewOpenings(db, { ...a, customers: [{ ledgerId: null, name: 'Cash', base: null, bills: [{ ref: '', date: null, amount: 100 }] }] })).toThrow(/already used/)
    expect(() => applyOpenings(db, { ...a, confirmCapital: 123 })).toThrow(/changed since you checked/)
    expect(() => applyOpenings(db, a)).toThrow(/Check the difference/)
    expect({ ledgers: count(db, 'ledgers'), audit: count(db, 'audit_log') }).toEqual(before)
    expect(count(db, 'opening_bills')).toBe(0)
  })

  it('audits the run: one opening_batch row with every change, the services audit each account and item; chain valid', () => {
    const db = kirana()
    const auditBefore = count(db, 'audit_log')
    confirmAndApply(db, answers(db))
    const batch = db.prepare("SELECT action, before_json, after_json FROM audit_log WHERE entity = 'opening_batch'").all() as { action: string; before_json: string | null; after_json: string }[]
    expect(batch).toHaveLength(1)
    expect(batch[0]!.action).toBe('create')
    const after = JSON.parse(batch[0]!.after_json) as { have: number; owe: number; capital: number; changes: { kind: string; name: string }[] }
    expect(after).toMatchObject({ have: HAVE, owe: OWE, capital: -(HAVE - OWE) })
    expect(after.changes.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
      'account:Bank loan', 'account:Cash', 'account:Gupta Traders', "account:HDFC current", "account:Owner's money", 'account:Sharma Stores',
      'bills:Gupta Traders', 'bills:Sharma Stores', 'item:Rice 25 kg bag', 'item:Sugar'
    ])
    expect(count(db, 'audit_log', `id > ${auditBefore} AND entity = 'ledger'`)).toBe(6)
    expect(count(db, 'audit_log', `id > ${auditBefore} AND entity = 'stockItem'`)).toBe(2)
    expect(verifyAudit(db).ok).toBe(true)
    // A second, different run is an update of the batch.
    confirmAndApply(db, { ...answers(db), cash: { amount: 7_000_00, base: 5_000_00 } })
    expect(db.prepare("SELECT action FROM audit_log WHERE entity = 'opening_batch' ORDER BY id").all()).toEqual([{ action: 'create' }, { action: 'update' }])
    expect(verifyAudit(db).ok).toBe(true)
  })

  it('state: books-begin, progress, startedFresh; "I started fresh" is a company update', () => {
    const db = kirana('2026-06-15')
    let s = openingsState(db)
    expect(s).toMatchObject({ booksBegin: '2026-06-15', startedFresh: false, stockOn: true, appliedAt: null, progress: { done: 0, total: 4 } })
    expect(s.pick.units.length).toBeGreaterThan(0)
    confirmAndApply(db, { cash: { amount: 1_000_00, base: 0 } })
    s = openingsState(db)
    expect(s.progress).toEqual({ done: 1, total: 4 })
    expect(s.appliedAt).not.toBeNull()
    skipOpenings(db)
    expect(getUi(db).startedFresh).toBe(true)
    expect(verifyAudit(db).ok).toBe(true)
  })

  it('an accountant company (no setup): books-begin falls back to the first FY start; a capital account is created', () => {
    const db = seededDb()
    const s = openingsState(db)
    expect(s.booksBegin).toBe('2025-04-01')
    expect(s.startedFresh).toBeNull()
    postSimpleVoucher(db, { date: '2025-05-01', amount: 1000, kind: 'receipt' })
    const r = confirmAndApply(db, { cash: { amount: 2_500_00, base: 0 } })
    expect(r.capital).toMatchObject({ name: "Owner's money", before: 0, after: -2_500_00 })
    expect(openingTotals(db).difference).toBe(0)
  })
})
