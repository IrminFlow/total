// WP 2.5a — the Tally import voucher-type mapping bug: "Receipt Note" used to become a cash/bank
// receipt and "Delivery Note" a journal; "Sales Order" / "Purchase Order" became real sales and
// purchases. Now: the notes map to the stock-only kinds, orders are skipped with a warning.
import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { importTallyXml, kindForName, isOrderTypeName } from './tallyImport'
import { getVoucher } from './vouchers'
import * as stock from './stockAnalysis'

const MASTERS = `
  <TALLYMESSAGE>
    <LEDGER NAME="Acme Retail"><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
    <LEDGER NAME="Steel Supplies"><PARENT>Sundry Creditors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
    <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
    <UNIT NAME="Nos"><DECIMALPLACES>0</DECIMALPLACES></UNIT>
    <STOCKITEM NAME="Bolt"><BASEUNITS>Nos</BASEUNITS><OPENINGBALANCE>100 Nos</OPENINGBALANCE><OPENINGVALUE>-1000.00</OPENINGVALUE></STOCKITEM>
  </TALLYMESSAGE>`

const note = (type: string, no: string, party: string, qty: number, withLedger = false): string => `
  <TALLYMESSAGE>
    <VOUCHER VCHTYPE="${type}">
      <DATE>20250510</DATE>
      <VOUCHERNUMBER>${no}</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
      ${withLedger ? `<LEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-50.00</AMOUNT></LEDGERENTRIES.LIST>` : ''}
      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>Bolt</STOCKITEMNAME>
        <ACTUALQTY>${qty} Nos</ACTUALQTY>
        <AMOUNT>50.00</AMOUNT>
      </ALLINVENTORYENTRIES.LIST>
    </VOUCHER>
  </TALLYMESSAGE>`

const order = (type: string): string => `
  <TALLYMESSAGE>
    <VOUCHER VCHTYPE="${type}">
      <DATE>20250510</DATE>
      <VOUCHERNUMBER>SO/1</VOUCHERNUMBER>
      <PARTYLEDGERNAME>Acme Retail</PARTYLEDGERNAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Retail</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>
  </TALLYMESSAGE>`

const kindOf = (db: ReturnType<typeof seededDb>, name: string): string | undefined =>
  (db.prepare('SELECT kind FROM voucher_types WHERE name = ? COLLATE NOCASE').get(name) as { kind: string } | undefined)?.kind

describe('Tally voucher-type mapping', () => {
  it('kindForName matches the stock notes before receipt / journal', () => {
    expect(kindForName('Receipt Note')).toBe('receipt_note')
    expect(kindForName('Delivery Note')).toBe('delivery_note')
    expect(kindForName('Delivery Challan')).toBe('delivery_note')
    expect(kindForName('Rejections In')).toBe('receipt_note')
    expect(kindForName('Rejections Out')).toBe('delivery_note')
    expect(kindForName('Receipt')).toBe('receipt')
    expect(kindForName('Bank Receipt')).toBe('receipt')
    expect(kindForName('Journal')).toBe('journal')
    expect(isOrderTypeName('Sales Order')).toBe(true)
    expect(isOrderTypeName('Purchase Order')).toBe(true)
    expect(isOrderTypeName('Job Work Out Order')).toBe(true)
    expect(isOrderTypeName('Sales')).toBe(false)
    expect(isOrderTypeName('Disorder Expenses')).toBe(false)
  })

  it('imports Tally delivery / receipt notes as challans / GRNs that move stock but post nothing', () => {
    // A fresh company already has "Delivery Note" / "Receipt Note" types (migration 024) — the
    // import reuses them by name.
    const db = seededDb()
    const xml = `<ENVELOPE>${MASTERS}${note('Delivery Note', 'DN/1', 'Acme Retail', 10)}${note('Receipt Note', 'RN/1', 'Steel Supplies', 4, true)}</ENVELOPE>`
    const summary = importTallyXml(db, xml)
    expect(summary.vouchers).toBe(2)
    expect(summary.skipped).toBe(0)
    expect(summary.warnings).toEqual([expect.stringMatching(/RN\/1.*ledger entries on a receipt note were not imported/)])
    const rows = db.prepare('SELECT v.id, v.number, vt.kind FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id ORDER BY v.id').all() as { id: number; number: string; kind: string }[]
    expect(rows.map((r) => [r.number, r.kind])).toEqual([['DN/1', 'delivery_note'], ['RN/1', 'receipt_note']])
    const dn = getVoucher(db, rows[0]!.id)!
    expect(dn.lines).toEqual([])
    expect(dn.inventory.map((l) => [l.direction, l.qtyMilli])).toEqual([['out', 10000]])
    expect(dn.trade).toEqual({ purpose: 'supply' })
    expect(getVoucher(db, rows[1]!.id)!.inventory.map((l) => l.direction)).toEqual(['in'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM voucher_lines').get()).toEqual({ n: 0 })
    const bolt = stock.stockSummary(db, '2025-05-31').find((r) => r.name === 'Bolt')!
    expect(bolt.closingQtyMilli).toBe(100000 - 10000 + 4000)
  })

  it('a type created by the import gets the corrected kind (a company without the system types)', () => {
    const db = seededDb()
    db.prepare("DELETE FROM voucher_types WHERE kind IN ('delivery_note', 'receipt_note')").run()
    importTallyXml(db, `<ENVELOPE>${MASTERS}${note('Rejections In', 'RJ/1', 'Acme Retail', 2)}${note('Delivery Note', 'DN/9', 'Acme Retail', 1)}</ENVELOPE>`)
    expect(kindOf(db, 'Rejections In')).toBe('receipt_note')
    expect(kindOf(db, 'Delivery Note')).toBe('delivery_note')
    const rj = db.prepare("SELECT id FROM vouchers WHERE number = 'RJ/1'").get() as { id: number }
    expect(getVoucher(db, rj.id)!.trade).toEqual({ purpose: 'return' })
  })

  it('skips Tally sales / purchase orders with a warning instead of posting them', () => {
    const db = seededDb()
    const summary = importTallyXml(db, `<ENVELOPE>${MASTERS}${order('Sales Order')}${order('Purchase Order')}</ENVELOPE>`)
    expect(summary.vouchers).toBe(0)
    expect(summary.skipped).toBe(2)
    expect(summary.warnings.filter((w) => /is an order/.test(w))).toHaveLength(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
    expect(kindOf(db, 'Sales Order')).toBeUndefined()
  })

  it('a pre-existing Tally "Delivery Note" journal type keeps importing as a journal (existing types win by name)', () => {
    const db = seededDb()
    db.prepare("UPDATE voucher_types SET name = 'Delivery Challan' WHERE kind = 'delivery_note'").run()
    db.prepare("INSERT INTO voucher_types (name, kind, numbering) VALUES ('Delivery Note', 'journal', 'manual')").run()
    const summary = importTallyXml(db, `<ENVELOPE>${MASTERS}${note('Delivery Note', 'DN/2', 'Acme Retail', 1, true)}</ENVELOPE>`)
    // A journal needs balanced ledger lines; this one has a single party entry, so it's skipped
    // with the validation reason — exactly the old behaviour for such a type.
    expect(summary.skipped).toBe(1)
    expect(kindOf(db, 'Delivery Note')).toBe('journal')
  })
})
