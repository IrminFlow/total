// PR #191, CodeRabbit review: import findings (each a regression test).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import { importTallyXml } from './tallyImport'
import { getVoucher, saveVoucher } from './vouchers'
import { partyAllocation } from './analysis'
import { openingBillsByParty } from './openingBills'
import * as stock from './stockAnalysis'
import type { DB } from '../db/connection'
import {
  tallyBaseMasters, tallyCashSale, tallyCreditSale, tallyEnvelope, tallyItem, tallyLedger, tallyPhysicalStock, tallyPurchase, tallyReceipt, tallyVoucherType
} from '../../shared/fixtures/tally/tallyXml'

const FIXTURES = join(__dirname, '../../shared/fixtures/tally')
const L = (db: DB, name: string): number => (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number }).id
const V = (db: DB, number: string) => getVoucher(db, (db.prepare('SELECT id FROM vouchers WHERE number = ? AND deleted_at IS NULL').get(number) as { id: number }).id)!
const has = (db: DB, number: string): boolean => !!db.prepare('SELECT 1 FROM vouchers WHERE number = ? AND deleted_at IS NULL').get(number)
const closing = (db: DB, item: string): number => stock.stockSummary(db, '2026-04-30').find((r) => r.name === item)!.closingQtyMilli
const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const xml = (msgs: string[]) => tallyEnvelope([...tallyBaseMasters, ...msgs])

describe('Tally import: CodeRabbit findings', () => {
  it('(1) an existing ledger that already has Tally\'s opening (and no bills) takes the opening bills', () => {
    const db = seededDb()
    db.prepare('INSERT INTO ledgers (name, group_id, opening_balance) VALUES (?, ?, ?)').run('Ramesh Traders', groupId(db, 'Sundry Debtors'), 150_000)
    importTallyXml(db, readFileSync(join(FIXTURES, 'opening-bills-physical-stock.xml'), 'utf8'))
    expect(openingBillsByParty(db).get(L(db, 'Ramesh Traders'))!.map((b) => [b.name, b.amount])).toEqual([['INV/24-25/71', 50_000], ['INV/24-25/88', 100_000]])
    expect(partyAllocation(db, L(db, 'Ramesh Traders'), '2026-08-31').bills.map((b) => [b.number, b.pending])).toEqual([['INV/24-25/71', 50_000]])
  })

  it('(2) an unused voucher type with the wrong stored kind is corrected; one in use keeps it, and says so', () => {
    const file = readFileSync(join(FIXTURES, 'daybook-returns-stock-bills.xml'), 'utf8')
    const unused = seededDb()
    unused.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES ('Sales Return', 'sales', 'manual', '', 0)").run()
    const s1 = importTallyXml(unused, file)
    expect(unused.prepare("SELECT kind FROM voucher_types WHERE name = 'Sales Return'").get()).toEqual({ kind: 'credit_note' })
    expect(V(unused, 'SR-1').inventory.map((l) => l.direction)).toEqual(['in'])
    expect(s1.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Sales Return.*sales.*credit note/i)]))
    expect(unused.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'voucherType' AND action = 'update'").get()).toEqual({ n: 1 })

    const used = seededDb()
    const t = used.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES ('Sales Return', 'sales', 'manual', '', 0)").run()
    const sales = used.prepare('INSERT INTO ledgers (name, group_id) VALUES (?, ?)').run('Sales Account', groupId(used, 'Sales Accounts'))
    saveVoucher(used, { voucherTypeId: Number(t.lastInsertRowid), date: '2026-04-02', number: 'X-1', partyLedgerId: L(used, 'Cash'), narration: null, lines: [{ ledgerId: L(used, 'Cash'), drCr: 'dr', amount: 100, costAllocations: [] }, { ledgerId: Number(sales.lastInsertRowid), drCr: 'cr', amount: 100, costAllocations: [] }], inventory: [], billRefs: [], tds: null } as never)
    const s2 = importTallyXml(used, file)
    expect(used.prepare("SELECT kind FROM voucher_types WHERE name = 'Sales Return'").get()).toEqual({ kind: 'sales' })
    expect(s2.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Sales Return.*already used.*sales.*credit note/i)]))
  })

  it('(3) a custom type made from Rejections Out is a rejection (purpose non-supply), not a supply', () => {
    const db = seededDb()
    importTallyXml(db, xml([tallyVoucherType('Goods Back', 'Rejections Out'), tallyLedger('Kumar Steel', 'Sundry Creditors'), tallyItem('Widget', 10, 1000),
      `     <VOUCHER VCHTYPE="Goods Back" ACTION="Create">\n      <DATE>20260405</DATE>\n      <VOUCHERTYPENAME>Goods Back</VOUCHERTYPENAME>\n      <VOUCHERNUMBER>GB-1</VOUCHERNUMBER>\n      <PARTYLEDGERNAME>Kumar Steel</PARTYLEDGERNAME>\n      <ALLINVENTORYENTRIES.LIST>\n       <STOCKITEMNAME>Widget</STOCKITEMNAME>\n       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n       <AMOUNT>200.00</AMOUNT>\n       <ACTUALQTY> 2 Nos</ACTUALQTY>\n      </ALLINVENTORYENTRIES.LIST>\n     </VOUCHER>`]))
    expect(V(db, 'GB-1').trade).toEqual({ purpose: 'non_supply' })
  })

  it('(4) a receipt back-dated before a bill already in the books does not take that bill as open', () => {
    const db = seededDb()
    importTallyXml(db, xml([tallyLedger('Cust', 'Sundry Debtors'), tallyCreditSale('S-9', '20260420', 'Cust', 500, [{ name: 'S-9', type: 'New Ref', rupees: 500 }])]))
    const s = importTallyXml(db, xml([tallyLedger('Cust', 'Sundry Debtors'), tallyReceipt('R-1', '20260405', 'Cust', 500, [{ name: 'S-9', type: 'Agst Ref', rupees: 500 }])]))
    expect(V(db, 'R-1').billRefs).toEqual([])
    expect(s.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/R-1.*S-9.*as of this import/)]))
    const a = partyAllocation(db, L(db, 'Cust'), '2026-04-30')
    expect([a.bills, a.unappliedCredit, a.warnings]).toEqual([[], 0, []])
  })

  it('(10) vouchers are imported in date order: a receipt listed before the earlier-dated bill it settles keeps its ref', () => {
    const db = seededDb()
    importTallyXml(db, xml([tallyLedger('Cust', 'Sundry Debtors'),
      tallyCreditSale('S-1', '20260401', 'Cust', 500, [{ name: 'S-1', type: 'New Ref', rupees: 500 }]),
      tallyReceipt('R-1', '20260415', 'Cust', 500, [{ name: 'S-2', type: 'Agst Ref', rupees: 500 }]),
      tallyCreditSale('S-2', '20260410', 'Cust', 500, [{ name: 'S-2', type: 'New Ref', rupees: 500 }])]))
    expect(V(db, 'R-1').billRefs).toEqual([{ kind: 'against', name: 'S-2', amount: 50_000, dueDate: null }])
    const a = partyAllocation(db, L(db, 'Cust'), '2026-04-30')
    expect([a.bills.map((b) => [b.number, b.pending]), a.warnings]).toEqual([[['S-1', 50_000]], []])
  })

  it('(5) Main Location created by the file itself still holds the stock without a godown', () => {
    const db = seededDb()
    db.prepare("DELETE FROM godowns WHERE name = 'Main Location'").run()
    const s = importTallyXml(db, xml([tallyItem('Widget', 4, 400), tallyPurchase('P-1', '20260401', 'Widget', 10, 1000, [{ godown: 'Main Location', qty: 10 }]),
      tallyPhysicalStock('PS-1', '20260410', [{ item: 'Widget', counts: [{ godown: 'Main Location', qty: 12 }] }])]))
    expect(s.skipped).toBe(0)
    expect(closing(db, 'Widget')).toBe(12_000)
  })

  it('(6) bill allocations on a ledger other than the voucher\'s party are reported', () => {
    const db = seededDb()
    const s = importTallyXml(db, xml([tallyLedger('Cust', 'Sundry Debtors'), tallyLedger('Other Party', 'Sundry Debtors'),
      tallyReceipt('R-1', '20260405', 'Other Party', 500, [{ name: 'S-1', type: 'Agst Ref', rupees: 500 }]).replace('<PARTYLEDGERNAME>Other Party</PARTYLEDGERNAME>', '<PARTYLEDGERNAME>Cust</PARTYLEDGERNAME>')]))
    expect(V(db, 'R-1').billRefs).toEqual([])
    expect(s.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/R-1.*Other Party.*Cust/)]))
  })

  it('(7) a Physical Stock voucher counting an item not in the masters is skipped, not saved without it', () => {
    const db = seededDb()
    const s = importTallyXml(db, xml([tallyItem('Widget', 4, 400),
      tallyPhysicalStock('PS-1', '20260410', [{ item: 'Widget', counts: [{ godown: 'Main Location', qty: 3 }] }, { item: 'Gadget', counts: [{ godown: 'Main Location', qty: 1 }] }])]))
    expect(has(db, 'PS-1')).toBe(false)
    expect(s.skipped).toBe(1)
    expect(s.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/PS-1.*Gadget/)]))
    expect(closing(db, 'Widget')).toBe(4_000)
  })

  it('(8) a refused count never leaves behind a godown it named', () => {
    const db = seededDb()
    const s = importTallyXml(db, xml([tallyItem('Widget'), tallyPurchase('P-1', '20260401', 'Widget', 10, 1000, [{ godown: 'Godown A', qty: 10 }]),
      tallyPhysicalStock('PS-1', '20260410', [{ item: 'Widget', counts: [{ godown: 'Godown Z', qty: 3 }] }])]))
    expect(s.skipped).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM godowns WHERE name = 'Godown Z'").get()).toEqual({ n: 0 })
    // An accepted count of a new godown creates it.
    const ok = seededDb()
    importTallyXml(ok, xml([tallyItem('Widget'), tallyPhysicalStock('PS-1', '20260410', [{ item: 'Widget', counts: [{ godown: 'Godown Z', qty: 3 }] }])]))
    expect(ok.prepare("SELECT COUNT(*) AS n FROM godowns WHERE name = 'Godown Z'").get()).toEqual({ n: 1 })
    expect(closing(ok, 'Widget')).toBe(3_000)
  })

  it('(9) a count joined over several godowns says godown-wise stock keeps its pre-count split (one count line per item)', () => {
    const db = seededDb()
    const s = importTallyXml(db, xml([tallyItem('Widget'),
      tallyPurchase('P-1', '20260401', 'Widget', 10, 1000, [{ godown: 'Godown A', qty: 10 }]),
      tallyPurchase('P-2', '20260401', 'Widget', 5, 500, [{ godown: 'Godown B', qty: 5 }]),
      tallyPhysicalStock('PS-1', '20260410', [{ item: 'Widget', counts: [{ godown: 'Godown A', qty: 8 }, { godown: 'Godown B', qty: 5 }] }])]))
    expect(closing(db, 'Widget')).toBe(13_000)
    expect(V(db, 'PS-1').inventory.map((l) => [l.isAbsolute, l.qtyMilli, l.godownId])).toEqual([[true, 13_000, null]])
    expect(s.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/PS-1.*Widget.*as a whole.*godown-wise/)]))
  })

  it('(2, final check) a type Tally says nothing about keeps its stored kind: a masterless "Cash Sale" stays a sale', () => {
    const db = seededDb()
    db.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES ('Cash Sale', 'sales', 'manual', '', 0)").run()
    const s = importTallyXml(db, xml([tallyItem('Widget', 10, 1000), tallyCashSale('CS-1', '20260405', 'Widget', 5, 500, 'Main Location').replace(/"Sales"/, '"Cash Sale"').replace('<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>', '<VOUCHERTYPENAME>Cash Sale</VOUCHERTYPENAME>')]))
    expect(db.prepare("SELECT kind FROM voucher_types WHERE name = 'Cash Sale'").get()).toEqual({ kind: 'sales' })
    expect(s.warnings.filter((w) => w.includes('Cash Sale'))).toEqual([])
    expect(V(db, 'CS-1').inventory.map((l) => [l.direction, l.qtyMilli])).toEqual([['out', 5_000]])
    expect(closing(db, 'Widget')).toBe(5_000)
    // A name that says a kind ("Sales-Return") still corrects an unused type without masters.
    const ret = seededDb()
    ret.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES ('Sales-Return', 'sales', 'manual', '', 0)").run()
    importTallyXml(ret, xml([tallyItem('Widget', 10, 1000), tallyCashSale('CS-2', '20260405', 'Widget', 1, 100, 'Main Location').replace(/"Sales"/, '"Sales-Return"').replace('<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>', '<VOUCHERTYPENAME>Sales-Return</VOUCHERTYPENAME>')]))
    expect(ret.prepare("SELECT kind FROM voucher_types WHERE name = 'Sales-Return'").get()).toEqual({ kind: 'credit_note' })
  })
})
