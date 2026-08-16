import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { dryRunTallyXml, importTallyXml } from './tallyImport'

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
})
