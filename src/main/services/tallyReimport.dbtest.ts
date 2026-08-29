import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { diffTallyXml, importTallyXml, importTallyXmlStreaming } from './tallyImport'
import { deleteVoucher } from './vouchers'
import { trialBalance } from './reports'

const MASTERS = `<ENVELOPE><TALLYMESSAGE>
  <LEDGER NAME="Kumar Traders"><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
  <LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT><OPENINGBALANCE>0</OPENINGBALANCE></LEDGER>
</TALLYMESSAGE></ENVELOPE>`

const voucherXml = (number: string, amount = '1000.00', guid?: string): string => `
  <TALLYMESSAGE><VOUCHER VCHTYPE="Sales">
    ${guid ? `<GUID>${guid}</GUID>` : ''}
    <DATE>20260410</DATE><VOUCHERNUMBER>${number}</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Kumar Traders</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER></TALLYMESSAGE>`

const file = (...vouchers: string[]): string => `<ENVELOPE>${MASTERS}${vouchers.join('')}</ENVELOPE>`

const voucherCount = (db: DB): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL').get() as { n: number }).n

describe('re-import safety', () => {
  it('does not double the books when the same file is imported twice', () => {
    // The commonest migration accident: import the vouchers, notice April is missing, export
    // again with a wider range, import that. A trial balance that ties at twice the size is the
    // worst possible failure, because it looks right.
    const db = seededDb()
    const xml = file(voucherXml('INV-1'), voucherXml('INV-2'))

    const first = importTallyXml(db, xml)
    expect(first.vouchers).toBe(2)
    const tbAfterFirst = trialBalance(db, '2027-03-31').totalDebit

    const second = importTallyXml(db, xml)
    expect(second.vouchers).toBe(0)
    expect(second.duplicates).toBe(2)
    expect(voucherCount(db)).toBe(2)
    expect(trialBalance(db, '2027-03-31').totalDebit).toBe(tbAfterFirst)
  })

  it('imports the new vouchers out of a wider re-export and skips the rest', () => {
    const db = seededDb()
    importTallyXml(db, file(voucherXml('INV-1')))
    const again = importTallyXml(db, file(voucherXml('INV-1'), voucherXml('INV-2')))
    expect(again.vouchers).toBe(1)
    expect(again.duplicates).toBe(1)
    expect(voucherCount(db)).toBe(2)
  })

  it('recognises the same voucher after it was edited in Tally, when the export carries a GUID', () => {
    const db = seededDb()
    importTallyXml(db, file(voucherXml('INV-1', '1000.00', 'abc-123')))
    const again = importTallyXml(db, file(voucherXml('INV-9', '2500.00', 'abc-123')))
    expect(again.duplicates).toBe(1)
    expect(voucherCount(db)).toBe(1)
  })

  it('lets a deliberately binned voucher be imported again', () => {
    // The bin is a decision. Refusing to honour it would leave the user unable to undo an import
    // except by deleting the company — which is why import_key is indexed and not UNIQUE.
    const db = seededDb()
    importTallyXml(db, file(voucherXml('INV-1')))
    const id = (db.prepare('SELECT id FROM vouchers ORDER BY id DESC LIMIT 1').get() as { id: number }).id
    deleteVoucher(db, id)

    const again = importTallyXml(db, file(voucherXml('INV-1')))
    expect(again.vouchers).toBe(1)
    expect(again.duplicates).toBe(0)
    expect(voucherCount(db)).toBe(1)
  })

  it('treats a voucher that differs by one paisa as a different voucher', () => {
    const db = seededDb()
    importTallyXml(db, file(voucherXml('INV-1', '1000.00')))
    const again = importTallyXml(db, file(voucherXml('INV-1', '1000.01')))
    expect(again.vouchers).toBe(1)
    expect(again.duplicates).toBe(0)
  })
})

describe('the dry-run diff', () => {
  it('says what would be created against THESE books, not what is in the file', () => {
    const db = seededDb()
    const diff = diffTallyXml(db, file(voucherXml('INV-1'), voucherXml('INV-2')))
    const ledgers = diff.masters.find((m) => m.label === 'Ledgers')!
    expect(ledgers.create).toBe(2)
    expect(diff.vouchers).toEqual({ create: 2, duplicate: 0, blocked: 0 })
    expect(diff.samples.some((s) => s.label === 'Kumar Traders')).toBe(true)
  })

  it('counts what is already there as existing, not as a change', () => {
    const db = seededDb()
    importTallyXml(db, file(voucherXml('INV-1')))
    const diff = diffTallyXml(db, file(voucherXml('INV-1'), voucherXml('INV-2')))
    const ledgers = diff.masters.find((m) => m.label === 'Ledgers')!
    expect(ledgers.create).toBe(0)
    expect(ledgers.exists).toBe(2)
    expect(diff.vouchers).toEqual({ create: 1, duplicate: 1, blocked: 0 })
  })

  it('writes nothing at all — run it twice and the books have not moved', () => {
    const db = seededDb()
    const xml = file(voucherXml('INV-1'))
    diffTallyXml(db, xml)
    diffTallyXml(db, xml)
    expect(voucherCount(db)).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n).toBe(1) // just seeded Cash
  })

  it('flags a voucher whose ledger the file never defines as blocked', () => {
    const db = seededDb()
    const orphan = `<ENVELOPE><TALLYMESSAGE><VOUCHER VCHTYPE="Sales">
      <DATE>20260410</DATE><VOUCHERNUMBER>X-1</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Nobody At All</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></TALLYMESSAGE></ENVELOPE>`
    expect(diffTallyXml(db, orphan).vouchers.blocked).toBe(1)
  })

  it('does not count a master listed twice in one file as two creations', () => {
    const db = seededDb()
    const twice = `<ENVELOPE>${MASTERS}${MASTERS}</ENVELOPE>`
    expect(diffTallyXml(db, twice).masters.find((m) => m.label === 'Ledgers')!.create).toBe(2)
  })
})

describe('progress and cancel', () => {
  it('reports progress and leaves the books exactly as they were when cancelled', async () => {
    const db = seededDb()
    const xml = file(...Array.from({ length: 60 }, (_, i) => voucherXml(`INV-${i + 1}`)))
    const seen: number[] = []

    const summary = await importTallyXmlStreaming(db, xml, {
      onProgress: (p) => seen.push(p.done),
      // Cancel at the first opportunity — after one chunk of vouchers is already written.
      isCancelled: () => true
    })

    expect(summary.cancelled).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    // Everything or nothing. Masters included: a half-migrated company is not a state anyone
    // asked for when they pressed Cancel.
    expect(voucherCount(db)).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE name = 'Kumar Traders'").get() as { n: number }).n).toBe(0)
  })

  it('commits everything when it is allowed to finish', async () => {
    const db = seededDb()
    const xml = file(...Array.from({ length: 30 }, (_, i) => voucherXml(`INV-${i + 1}`)))
    const summary = await importTallyXmlStreaming(db, xml, { isCancelled: () => false })
    expect(summary.vouchers).toBe(30)
    expect(voucherCount(db)).toBe(30)
  })

  it('is still safe against a re-import when run the streaming way', async () => {
    const db = seededDb()
    const xml = file(voucherXml('INV-1'))
    await importTallyXmlStreaming(db, xml)
    const again = await importTallyXmlStreaming(db, xml)
    expect(again.duplicates).toBe(1)
    expect(voucherCount(db)).toBe(1)
  })
})
