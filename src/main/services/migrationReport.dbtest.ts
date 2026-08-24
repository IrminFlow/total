import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { importTallyXml } from './tallyImport'
import { migrationReportData, migrationReportBody } from './migrationReport'
import { runAsAuditUser } from './audit'

const XML = `<ENVELOPE>
  <TALLYMESSAGE>
    <LEDGER NAME="Kumar Traders"><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>-1000.00</OPENINGBALANCE></LEDGER>
    <LEDGER NAME="Owner Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>1000.00</OPENINGBALANCE></LEDGER>
  </TALLYMESSAGE>
</ENVELOPE>`

describe('the migration report', () => {
  it('reads the import out of the audit trail, not out of whatever the screen was holding', () => {
    const db = seededDb()
    runAsAuditUser('Priya Owner', () => importTallyXml(db, XML))

    const data = migrationReportData(db, '2027-03-31')
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0]!.ledgers).toBe(2)
    expect(data.runs[0]!.userName).toBe('Priya Owner')
  })

  it('shows the books balancing after an import that balances', () => {
    const db = seededDb()
    importTallyXml(db, XML)
    const body = migrationReportBody(db, '2027-03-31')
    expect(body.outOfBalance).toBe(0)
    expect(body.footNote).toContain('Membership no.')
  })

  it('refuses to look signable when the imported books do not balance', () => {
    // A one-sided opening balance is exactly how a half-finished migration presents itself.
    const db = seededDb()
    importTallyXml(
      db,
      `<ENVELOPE><TALLYMESSAGE>
        <LEDGER NAME="Kumar Traders"><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>-1000.00</OPENINGBALANCE></LEDGER>
      </TALLYMESSAGE></ENVELOPE>`
    )
    const body = migrationReportBody(db, '2027-03-31')
    expect(body.outOfBalance).not.toBe(0)
    expect(body.footNote.startsWith('THE BOOKS DO NOT BALANCE')).toBe(true)
  })

  it('records every import, not only the most recent', () => {
    const db = seededDb()
    importTallyXml(db, XML)
    importTallyXml(db, XML) // a second run: nothing new, but it happened and is on the record
    expect(migrationReportData(db, '2027-03-31').runs).toHaveLength(2)
  })

  it('says plainly that nothing was imported into a company nobody migrated', () => {
    const db = seededDb()
    const body = migrationReportBody(db, '2027-03-31')
    expect(body.rows.some((r) => r.cells[0]!.includes('No import has been run'))).toBe(true)
  })
})
