import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { dryRunTallyXml, importTallyXml, previewTallyXml, tallySemanticHash } from './tallyImport'

// A minimal but representative Tally masters+vouchers export: one new group under an existing
// system group, one ledger under it, and one journal voucher between two ledgers.
const SAMPLE_XML = `<ENVELOPE>
  <TALLYMESSAGE>
    <GROUP NAME="Office Expenses"><PARENT>Indirect Expenses</PARENT></GROUP>
    <LEDGER NAME="Rent Paid">
      <PARENT>Office Expenses</PARENT>
      <OPENINGBALANCE>0</OPENINGBALANCE>
    </LEDGER>
    <LEDGER NAME="Cash">
      <PARENT>Cash-in-hand</PARENT>
      <OPENINGBALANCE>0</OPENINGBALANCE>
    </LEDGER>
  </TALLYMESSAGE>
  <TALLYMESSAGE>
    <VOUCHER VCHTYPE="Payment">
      <DATE>20260801</DATE>
      <VOUCHERNUMBER>1</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>Rent Paid</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>-5000.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>Cash</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>5000.00</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
    </VOUCHER>
  </TALLYMESSAGE>
</ENVELOPE>`

function counts(db: ReturnType<typeof seededDb>): { groups: number; ledgers: number; vouchers: number } {
  return {
    groups: (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n,
    ledgers: (db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n,
    vouchers: (db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n
  }
}

describe('dryRunTallyXml', () => {
  it('reports parse-level counts without touching the database at all', () => {
    const db = seededDb()
    const before = counts(db)

    const summary = dryRunTallyXml(SAMPLE_XML)

    expect(summary).toEqual({
      groups: 1,
      ledgers: 2,
      units: 0,
      items: 0,
      vouchers: 1,
      skipped: 0,
      warnings: []
    })

    // Zero DB writes: voucher/ledger/group counts are exactly what they were before the dry run.
    expect(counts(db)).toEqual(before)
  })

  it('is idempotent — running it twice on the same open company changes nothing', () => {
    const db = seededDb()
    dryRunTallyXml(SAMPLE_XML)
    const after1 = counts(db)
    dryRunTallyXml(SAMPLE_XML)
    expect(counts(db)).toEqual(after1)
  })
})

describe('importTallyXml (contrast case)', () => {
  it('actually writes — the dry run above genuinely differs from apply', () => {
    const db = seededDb()
    const before = counts(db)

    const summary = importTallyXml(db, SAMPLE_XML)

    // Unlike dryRunTallyXml's raw parse counts, importTallyXml's counts are "actually created"
    // counts — "Cash" already exists in the seeded company, so only "Rent Paid" is new.
    expect(summary.groups).toBe(1)
    expect(summary.ledgers).toBe(1)
    expect(summary.vouchers).toBe(1)
    const after = counts(db)
    expect(after.groups).toBe(before.groups + 1)
    expect(after.ledgers).toBe(before.ledgers + 1)
    expect(after.vouchers).toBe(before.vouchers + 1)
  })

  it('records an immutable batch fingerprint and refuses an exact replay', () => {
    const db = seededDb()
    const first = importTallyXml(db, SAMPLE_XML)
    expect(first.batchId).toBeGreaterThan(0)
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(() => importTallyXml(db, SAMPLE_XML)).toThrow(/already imported/i)
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_batches WHERE kind = 'tally'").get()).toMatchObject({ n: 1 })
  })

  it('refuses a semantically equivalent export despite BOM and formatting differences', () => {
    const db = seededDb()
    const identified = SAMPLE_XML
      .replace('<GROUP NAME="Office Expenses">', '<GROUP NAME="Office Expenses" GUID="group-guid"><MASTERID>41</MASTERID><ALTERID>7</ALTERID>')
      .replace('<VOUCHER VCHTYPE="Payment">', '<VOUCHER VCHTYPE="Payment" GUID="voucher-guid"><MASTERID>91</MASTERID><ALTERID>4</ALTERID>')
    const formatted = `\uFEFF  ${identified.replace(/>\s+</g, '>\n\n<')}  `
    expect(tallySemanticHash(formatted)).toBe(tallySemanticHash(identified))
    const first = importTallyXml(db, identified)
    expect(first.semanticHash).toBe(tallySemanticHash(identified))
    expect(() => importTallyXml(db, formatted)).toThrow(/equivalent Tally export was already imported/i)
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_batches WHERE kind='tally'").get()).toEqual({ n: 1 })
    expect(db.prepare("SELECT semantic_hash AS semanticHash FROM import_batches WHERE id=?").get(first.batchId)).toEqual({ semanticHash: first.semanticHash })
  })

  it('reports and rejects inventory whose item or unit master is unknown', () => {
    const db = seededDb()
    const xml = `<ENVELOPE>
      <TALLYMESSAGE><STOCKITEM NAME="Mystery Item"><BASEUNITS>Unknown UOM</BASEUNITS></STOCKITEM></TALLYMESSAGE>
      <TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20260802</DATE><VOUCHERNUMBER>INV-2</VOUCHERNUMBER>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Suspense A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Mystery Item</STOCKITEMNAME><ACTUALQTY>1 Nos</ACTUALQTY><AMOUNT>100</AMOUNT></ALLINVENTORYENTRIES.LIST>
      </VOUCHER></TALLYMESSAGE>
    </ENVELOPE>`
    const preview = previewTallyXml(db, xml)
    expect(preview.skipped).toBe(2)
    expect(preview.warnings).toEqual([
      'Item "Mystery Item" requires unknown unit "Unknown UOM"',
      'Voucher INV-2 requires unknown stock item "Mystery Item"',
    ])
    const before = counts(db)
    const result = importTallyXml(db, xml)
    expect(result).toMatchObject({ items: 0, vouchers: 0, skipped: 2 })
    expect(result.warnings).toEqual([
      'Item "Mystery Item" skipped: unknown unit "Unknown UOM"',
      'Voucher INV-2 skipped: unknown stock item "Mystery Item"',
    ])
    expect(counts(db)).toEqual(before)
    expect(db.prepare("SELECT source_rows AS sourceRows,accepted_rows AS acceptedRows,rejected_rows AS rejectedRows FROM import_batches WHERE id=?").get(result.batchId)).toEqual({
      sourceRows: 2,
      acceptedRows: 0,
      rejectedRows: 2,
    })
  })

  it('rejects a voucher that references an absent stock item instead of dropping its line', () => {
    const db = seededDb()
    const xml = `<ENVELOPE><TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20260803</DATE><VOUCHERNUMBER>INV-3</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-50</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Suspense A/c</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>50</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Not Exported</STOCKITEMNAME><ACTUALQTY>1 Nos</ACTUALQTY><AMOUNT>50</AMOUNT></ALLINVENTORYENTRIES.LIST>
    </VOUCHER></TALLYMESSAGE></ENVELOPE>`
    expect(previewTallyXml(db, xml)).toMatchObject({ skipped: 1, warnings: ['Voucher INV-3 requires unknown stock item "Not Exported"'] })
    const result = importTallyXml(db, xml)
    expect(result).toMatchObject({ vouchers: 0, skipped: 1 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM inventory_lines").get()).toEqual({ n: 0 })
  })
})
