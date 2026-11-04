// Bug hunt 2026-11 — Tally import, three losses on a realistic TallyPrime day book
// (src/shared/fixtures/tally/daybook-returns-stock-bills.xml):
//   (a) a custom "Sales Return" / "Purchase Return" type (VOUCHERTYPE PARENT Credit / Debit Note)
//       imported as a SALE / PURCHASE, its goods moving the wrong way;
//   (b) stock / manufacturing journals (no ledger entries) were dropped, and item lines listed as
//       INVENTORYENTRIES.LIST (voucher mode) were lost;
//   (c) bill-wise allocations (BILLALLOCATIONS.LIST) were not imported.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import { importTallyXml, kindForName } from './tallyImport'
import { getVoucher } from './vouchers'
import { partyAllocation } from './analysis'
import * as stock from './stockAnalysis'

const XML = readFileSync(join(__dirname, '../../shared/fixtures/tally/daybook-returns-stock-bills.xml'), 'utf8')

function imported() {
  const db = seededDb()
  const summary = importTallyXml(db, XML)
  const v = (number: string) => {
    const row = db.prepare('SELECT v.id, vt.kind, vt.name FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.number = ?').get(number) as { id: number; kind: string; name: string } | undefined
    return row ? { ...row, v: getVoucher(db, row.id)! } : null
  }
  const L = (name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
  return { db, summary, v, L }
}

describe('Tally import: returns, stock journals, bill-wise details', () => {
  it('(a) custom return types import as credit / debit notes with goods moving back', () => {
    const { v } = imported()
    expect([v('SR-1')!.name, v('SR-1')!.kind]).toEqual(['Sales Return', 'credit_note'])
    expect(v('SR-1')!.v.inventory.map((l) => [l.direction, l.qtyMilli])).toEqual([['in', 1000]])
    expect([v('PR-1')!.name, v('PR-1')!.kind]).toEqual(['Purchase Return', 'debit_note'])
    expect(v('PR-1')!.v.inventory.map((l) => [l.direction, l.qtyMilli])).toEqual([['out', 5000]])
    // Without the masters, the name alone says it.
    expect(kindForName('Sales Return')).toBe('credit_note')
    expect(kindForName('Purchase Returns')).toBe('debit_note')
    expect(kindForName('Return Inward')).toBe('credit_note')
    expect(kindForName('Manufacturing Journal')).toBe('stock_journal')
  })

  it('(b) stock / manufacturing journals and voucher-mode item lines are imported, each line its own way', () => {
    const { summary, v } = imported()
    expect(summary).toMatchObject({ vouchers: 7, skipped: 0 })
    expect(v('P-1')!.v.inventory.map((l) => [l.direction, l.qtyMilli, l.amount])).toEqual([['in', 30_000, 300_000]])
    expect(v('MJ-1')!.kind).toBe('stock_journal')
    expect(v('MJ-1')!.v.lines).toEqual([])
    expect(v('MJ-1')!.v.inventory.map((l) => [l.direction, l.qtyMilli, l.amount])).toEqual([['in', 2_000, 40_000], ['out', 4_000, 40_000]])
    expect([v('AS-1')!.name, v('AS-1')!.kind]).toEqual(['Assembly', 'stock_journal'])
    expect(v('AS-1')!.v.inventory.map((l) => [l.direction, l.qtyMilli])).toEqual([['out', 2_000], ['in', 1_000]])
  })

  it('(b) closing stock = Tally\'s: openings + purchase - return + made - used - sold + returned', () => {
    const { db } = imported()
    const qty = (name: string): number => stock.stockSummary(db, '2026-08-31').find((r) => r.name === name)!.closingQtyMilli
    // Steel Rod: 20 + 30 bought - 5 returned - 4 (MJ-1) - 2 (AS-1) = 39.
    expect(qty('Steel Rod')).toBe(39_000)
    // Bracket: 10 - 4 sold + 1 back + 2 made (MJ-1) + 1 made (AS-1) = 10.
    expect(qty('Bracket')).toBe(10_000)
  })

  it('(c) bill-wise allocations become bill references; Outstandings follows them', () => {
    const { db, v, L } = imported()
    expect(v('S-1')!.v.billRefs).toEqual([{ kind: 'new', name: 'S-1', amount: 100_000, dueDate: '2026-09-04' }])
    expect(v('SR-1')!.v.billRefs).toEqual([{ kind: 'against', name: 'S-1', amount: 25_000, dueDate: null }])
    expect(v('R-1')!.v.billRefs).toEqual([
      { kind: 'against', name: 'S-1', amount: 50_000, dueDate: null },
      { kind: 'new', name: 'R-1', amount: 20_000, dueDate: null }
    ])
    expect(v('P-1')!.v.billRefs).toEqual([{ kind: 'new', name: 'KS/771', amount: 300_000, dueDate: '2026-08-18' }])
    // Ramesh: S-1 1,000 - 250 returned - 500 received = 250 open; the ₹200 advance is a credit.
    const ramesh = partyAllocation(db, L('Ramesh Traders'), '2026-08-31')
    expect(ramesh.bills.map((b) => [b.number, b.pending])).toEqual([['S-1', 25_000]])
    expect(ramesh.unappliedCredit).toBe(20_000)
    // Kumar: KS/771 3,000 - 500 returned = 2,500.
    expect(partyAllocation(db, L('Kumar Steel'), '2026-08-31').bills.map((b) => [b.number, b.pending])).toEqual([['KS/771', 250_000]])
  })

  it('an On Account part keeps the voucher without bill references (and says so)', () => {
    const db = seededDb()
    importTallyXml(db, XML.replace('<BILLTYPE>Advance</BILLTYPE>', '<BILLTYPE>On Account</BILLTYPE>'))
    const r = db.prepare("SELECT id FROM vouchers WHERE number = 'R-1'").get() as { id: number }
    expect(getVoucher(db, r.id)!.billRefs).toEqual([])
  })
})
