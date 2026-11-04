// PR #191 review (fix-first), on src/shared/fixtures/tally/opening-bills-physical-stock.xml:
//   1. a receipt "Agst Ref INV/24-25/88" was held as unapplied credit because the ledger master's
//      opening bill-wise details were not imported (the opening stayed one "Opening" bill, shown
//      overdue); an Agst Ref naming a bill that isn't open must settle oldest first, as before;
//   2. a Physical Stock voucher (a count of 10) was saved as 10 OUT;
//   3. stock-journal godowns were saved as none;
//   4. "Sales-Return" (a hyphen) mapped to sales without voucher-type masters.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import { importTallyXml, kindForName } from './tallyImport'
import { getVoucher } from './vouchers'
import { outstandingsWithAdvances, partyAllocation } from './analysis'
import { openingBillsByParty, openingBillMismatches } from './openingBills'
import { closingBalances } from './reports'
import * as stock from './stockAnalysis'

const XML = readFileSync(join(__dirname, '../../shared/fixtures/tally/opening-bills-physical-stock.xml'), 'utf8')
const AS_ON = '2026-08-31'

function imported(xml = XML) {
  const db = seededDb()
  const summary = importTallyXml(db, xml)
  const v = (number: string) => {
    const row = db.prepare('SELECT v.id, vt.kind, vt.name FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.number = ?').get(number) as { id: number; kind: string; name: string } | undefined
    return row ? { ...row, v: getVoucher(db, row.id)! } : null
  }
  const L = (name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
  const G = (name: string): number | undefined => (db.prepare('SELECT id FROM godowns WHERE name = ?').get(name) as { id: number } | undefined)?.id
  return { db, summary, v, L, G }
}

describe('Tally import: opening bill-wise details', () => {
  it('stores each party master\'s opening bills (adding up to its opening)', () => {
    const { db, L } = imported()
    const bills = openingBillsByParty(db)
    expect(bills.get(L('Ramesh Traders'))).toEqual([
      { name: 'INV/24-25/71', date: '2025-02-10', dueDate: '2025-03-12', amount: 50_000 },
      { name: 'INV/24-25/88', date: '2025-03-15', dueDate: '2025-04-14', amount: 100_000 }
    ])
    expect(bills.get(L('Kumar Steel'))).toEqual([
      { name: 'KS/101', date: '2025-02-05', dueDate: '2025-02-20', amount: 200_000 },
      { name: 'KS/102', date: '2025-03-25', dueDate: '2025-04-15', amount: 300_000 }
    ])
    expect(bills.get(L('Mehta Stores'))).toBeUndefined()
    expect(openingBillMismatches(db)).toEqual([])
  })

  it('an opening that carries an advance keeps the single opening, and says so', () => {
    const { db, summary, L } = imported()
    expect(openingBillsByParty(db).get(L('Patel & Co'))).toBeUndefined()
    expect(partyAllocation(db, L('Patel & Co'), AS_ON).bills.map((b) => [b.number, b.pending])).toEqual([['Opening', 80_000]])
    expect(summary.warnings.some((w) => w.includes('Patel & Co') && w.includes('ADV/3'))).toBe(true)
  })

  it('the receipt Agst Ref INV/24-25/88 settles that opening bill — nothing held as credit', () => {
    const { db, v, L } = imported()
    expect(v('R-1')!.v.billRefs).toEqual([{ kind: 'against', name: 'INV/24-25/88', amount: 100_000, dueDate: null }])
    const ramesh = partyAllocation(db, L('Ramesh Traders'), AS_ON)
    expect(ramesh.bills.map((b) => [b.number, b.pending])).toEqual([['INV/24-25/71', 50_000]])
    expect(ramesh.unappliedCredit).toBe(0)
    expect(ramesh.warnings).toEqual([])
    // The payment Agst Ref KS/102 leaves KS/101 open.
    expect(partyAllocation(db, L('Kumar Steel'), AS_ON).bills.map((b) => [b.number, b.pending])).toEqual([['KS/101', 200_000]])
  })

  it('an Agst Ref naming a bill that is not open settles oldest first (and says so)', () => {
    const { db, summary, v, L } = imported()
    expect(v('R-2')!.v.billRefs).toEqual([{ kind: 'against', name: 'Opening', amount: 150_000, dueDate: null }])
    const mehta = partyAllocation(db, L('Mehta Stores'), AS_ON)
    expect(mehta.bills.map((b) => [b.number, b.pending])).toEqual([['Opening', 50_000]])
    expect(mehta.unappliedCredit).toBe(0)
    expect(summary.warnings.some((w) => w.includes('R-2') && w.includes('MS/12'))).toBe(true)
  })

  it('Outstandings = each party\'s ledger balance', () => {
    const { db } = imported()
    const bal = closingBalances(db, AS_ON)
    for (const side of ['receivable', 'payable'] as const) {
      const { parties, advances } = outstandingsWithAdvances(db, side, AS_ON)
      expect(advances).toBe(0)
      for (const p of parties) expect([p.name, p.pending]).toEqual([p.name, (side === 'receivable' ? 1 : -1) * bal.get(p.ledgerId)!])
    }
    const rec = outstandingsWithAdvances(db, 'receivable', AS_ON).parties.map((p) => [p.name, p.pending])
    expect(rec).toEqual(expect.arrayContaining([['Ramesh Traders', 50_000], ['Mehta Stores', 50_000], ['Patel & Co', 80_000]]))
  })

  it('without the masters\' bill-wise details, the receipt settles the opening oldest first', () => {
    const noBills = XML.replace(/(<LEDGER NAME="Ramesh Traders"[\s\S]*?<OPENINGBALANCE>-1500.00<\/OPENINGBALANCE>)[\s\S]*?(<\/LEDGER>)/, '$1\n     $2')
    const { db, summary, v, L } = imported(noBills)
    expect(openingBillsByParty(db).get(L('Ramesh Traders'))).toBeUndefined()
    expect(v('R-1')!.v.billRefs).toEqual([{ kind: 'against', name: 'Opening', amount: 100_000, dueDate: null }])
    const ramesh = partyAllocation(db, L('Ramesh Traders'), AS_ON)
    expect(ramesh.bills.map((b) => [b.number, b.pending])).toEqual([['Opening', 50_000]])
    expect(ramesh.unappliedCredit).toBe(0)
    expect(summary.warnings.some((w) => w.includes('R-1') && w.includes('INV/24-25/88'))).toBe(true)
  })
})

describe('Tally import: physical stock, godowns, return names', () => {
  it('a Physical Stock voucher (predefined or custom type) is a count, not a movement', () => {
    const { db, summary, v } = imported()
    expect(summary).toMatchObject({ vouchers: 7, skipped: 0 })
    expect([v('PS-1')!.name, v('PS-1')!.kind]).toEqual(['Physical Stock', 'physical_stock'])
    expect(v('PS-1')!.v.inventory.map((l) => [l.isAbsolute, l.qtyMilli, l.amount])).toEqual([[true, 10_000, 0]])
    expect([v('SC-1')!.name, v('SC-1')!.kind]).toEqual(['Stock Count', 'physical_stock'])
    expect(v('SC-1')!.v.inventory.map((l) => [l.isAbsolute, l.qtyMilli])).toEqual([[true, 18_000]])
    const qty = (name: string): number => stock.stockSummary(db, AS_ON).find((r) => r.name === name)!.closingQtyMilli
    // Bracket: 10 opening - 3 sold, counted at 10. Steel Rod: 20, moved between godowns, counted at 18.
    expect(qty('Bracket')).toBe(10_000)
    expect(qty('Steel Rod')).toBe(18_000)
  })

  it('stock-journal lines keep their godowns (a missing godown is created)', () => {
    const { v, G } = imported()
    expect(G('Back Store')).toBeDefined()
    expect(v('SJ-1')!.v.inventory.map((l) => [l.direction, l.godownId])).toEqual([['in', G('Back Store')], ['out', G('Main Location')]])
    expect(v('PS-1')!.v.inventory[0]!.godownId).toBe(G('Main Location'))
  })

  it('return type names read the same with any separator or case', () => {
    expect(kindForName('Sales-Return')).toBe('credit_note')
    expect(kindForName('SALES_RETURNS')).toBe('credit_note')
    expect(kindForName('Sales.Return (GST)')).toBe('credit_note')
    expect(kindForName('SalesReturn')).toBe('credit_note')
    expect(kindForName('Purchase-Return')).toBe('debit_note')
    expect(kindForName('purchase_return')).toBe('debit_note')
    expect(kindForName('Return-Outward')).toBe('debit_note')
    expect(kindForName('Physical Stock')).toBe('physical_stock')
    expect(kindForName('Physical-Stock')).toBe('physical_stock')
    expect(kindForName('Sales')).toBe('sales')
    expect(kindForName('Receipt-Note')).toBe('receipt_note')
  })
})
