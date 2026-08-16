// Lane Q, task Q1: audit completeness — login success/fail audits + persistent PIN throttle,
// Tally import single-transaction + summary audit, batched bin purge, audit retention pruning,
// year-end close and bank statement-import audit rows.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { freshDb, seededDb, postSimpleVoucher, TEST_INFO } from '../db/testdb'
import { seedCompany } from '../db/seed'
import { saveUser, login } from './users'
import { setAuditContext, writeAudit, pruneAudit } from './audit'
import { getAuditKeepDays, setAuditKeepDays } from './config'
import { importTallyXml, dryRunTallyXml } from './tallyImport'
import { deleteVoucher, purgeOldDeleted, setLockDate } from './vouchers'
import { importStatement } from './banking'
import { postClose } from './yearEnd'
import type { CompanyInfo } from '@shared/domain'

type DB = Database.Database

function auditRows(db: DB, entity: string): { entity_id: number; action: string; before_json: string | null; after_json: string | null }[] {
  return db
    .prepare('SELECT entity_id, action, before_json, after_json FROM audit_log WHERE entity = ? ORDER BY id')
    .all(entity) as { entity_id: number; action: string; before_json: string | null; after_json: string | null }[]
}

beforeEach(() => {
  setAuditContext({ appVersion: '0.0.0-test', getUserName: () => 'Test User' })
})

describe('login audit + persistent PIN throttle (Q1 #90/#93)', () => {
  it('audits failed attempts as login_failed (before/after null) and successes as login', () => {
    const db = freshDb()
    const user = saveUser(db, { name: 'Priya', role: 'owner', pin: '4242' })

    expect(() => login(db, user.id, '0000')).toThrow('Wrong PIN')
    login(db, user.id, '4242')

    const rows = auditRows(db, 'user').filter((r) => r.action === 'login_failed' || r.action === 'login')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ entity_id: user.id, action: 'login_failed', before_json: null, after_json: null })
    expect(rows[1]!.action).toBe('login')
    expect(rows[1]!.entity_id).toBe(user.id)
  })

  it('persists the throttle state in meta (auth.fails.<id>) and clears it on success', () => {
    const db = freshDb()
    const user = saveUser(db, { name: 'Priya', role: 'owner', pin: '4242' })
    const metaKey = `auth.fails.${user.id}`
    const readMeta = (): { fails: number; until: number } | null => {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(metaKey) as { value: string } | undefined
      return row ? (JSON.parse(row.value) as { fails: number; until: number }) : null
    }

    expect(() => login(db, user.id, '0000')).toThrow('Wrong PIN')
    expect(() => login(db, user.id, '0000')).toThrow('Wrong PIN')
    expect(readMeta()).toMatchObject({ fails: 2, until: 0 })

    for (let i = 0; i < 3; i++) expect(() => login(db, user.id, '0000')).toThrow('Wrong PIN')
    const locked = readMeta()
    expect(locked!.fails).toBe(5)
    expect(locked!.until).toBeGreaterThan(Date.now())

    // The lockout lives in the DB, not process memory — a "restarted app" (same DB, fresh module
    // state is irrelevant since there is no module state anymore) still refuses the right PIN.
    expect(() => login(db, user.id, '4242')).toThrow('Too many attempts — wait 30 seconds')

    // Simulate the lockout window elapsing, then a successful login clears the meta row.
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify({ fails: 5, until: Date.now() - 1000 }), metaKey)
    login(db, user.id, '4242')
    expect(readMeta()).toBeNull()
  })
})

const TALLY_XML = `<ENVELOPE>
  <TALLYMESSAGE>
    <GROUP NAME="Office Expenses"><PARENT>Indirect Expenses</PARENT></GROUP>
    <LEDGER NAME="Rent Paid">
      <PARENT>Office Expenses</PARENT>
      <OPENINGBALANCE>0</OPENINGBALANCE>
    </LEDGER>
  </TALLYMESSAGE>
</ENVELOPE>`

const TALLY_XML_WITH_ITEM = `<ENVELOPE>
  <TALLYMESSAGE>
    <GROUP NAME="Office Expenses"><PARENT>Indirect Expenses</PARENT></GROUP>
    <LEDGER NAME="Rent Paid">
      <PARENT>Office Expenses</PARENT>
      <OPENINGBALANCE>0</OPENINGBALANCE>
    </LEDGER>
    <STOCKITEM NAME="Widget"><BASEUNITS>Nos</BASEUNITS></STOCKITEM>
  </TALLYMESSAGE>
</ENVELOPE>`

describe('tallyImport transaction + summary audit (Q1 #90/#94)', () => {
  it('writes one tally_import summary audit row with the counts', () => {
    const db = seededDb()
    const summary = importTallyXml(db, TALLY_XML)
    expect(summary.groups).toBe(1)
    expect(summary.ledgers).toBe(1)

    const rows = auditRows(db, 'tally_import')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('import')
    expect(JSON.parse(rows[0]!.after_json!)).toMatchObject({ groups: 1, ledgers: 1, vouchers: 0, skipped: 0 })
  })

  it('dry run writes nothing at all', () => {
    const db = seededDb()
    dryRunTallyXml(TALLY_XML)
    expect(auditRows(db, 'tally_import')).toHaveLength(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = 'Office Expenses'").get()).toMatchObject({ n: 0 })
  })

  it('a hard failure mid-import rolls back everything written so far (one transaction)', () => {
    const db = seededDb()
    // Sabotage the item insert — the group and ledger above it in the import order will have
    // already been written when this fires, so only a wrapping transaction can undo them.
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON stock_items BEGIN SELECT RAISE(ABORT, 'boom'); END;")

    expect(() => importTallyXml(db, TALLY_XML_WITH_ITEM)).toThrow(/boom/)

    expect(db.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = 'Office Expenses'").get()).toMatchObject({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE name = 'Rent Paid'").get()).toMatchObject({ n: 0 })
    expect(auditRows(db, 'tally_import')).toHaveLength(0)
  })
})

describe('purgeOldDeleted writes one summary audit row (Q1 #92, lock-gated by F1 #6)', () => {
  it('purges every over-age LOCKED-period binned voucher with a single summary audit row', () => {
    const db = seededDb()
    const v1 = postSimpleVoucher(db, { date: '2025-04-10', amount: 10000, kind: 'receipt' })
    const v2 = postSimpleVoucher(db, { date: '2025-04-11', amount: 20000, kind: 'receipt' })
    const keep = postSimpleVoucher(db, { date: '2025-04-12', amount: 30000, kind: 'receipt' })
    deleteVoucher(db, v1.id)
    deleteVoucher(db, v2.id)
    deleteVoucher(db, keep.id)
    // Backdate two of the three past the 30-day window.
    db.prepare("UPDATE vouchers SET deleted_at = datetime('now', '-45 days') WHERE id IN (?, ?)").run(v1.id, v2.id)
    // Auto-purge only touches vouchers in the locked (closed/filed) period — see F1 #6.
    setLockDate(db, '2025-04-30')

    const auditCountBefore = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    const purged = purgeOldDeleted(db, 30)
    expect(purged).toBe(2)

    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE id IN (?, ?)').get(v1.id, v2.id)).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE id = ?').get(keep.id)).toMatchObject({ n: 1 })
    // Lines cascaded away with the vouchers.
    expect(db.prepare('SELECT COUNT(*) AS n FROM voucher_lines WHERE voucher_id IN (?, ?)').get(v1.id, v2.id)).toMatchObject({ n: 0 })

    // Exactly ONE summary row, not one per voucher.
    const auditCountAfter = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    expect(auditCountAfter - auditCountBefore).toBe(1)
    const summaryRow = auditRows(db, 'voucher').at(-1)!
    expect(summaryRow.action).toBe('delete')
    expect(JSON.parse(summaryRow.before_json!)).toMatchObject({ autoPurgedFromBin: 2, olderThanDays: 30 })
  })

  it('writes no audit row when nothing was purged', () => {
    const db = seededDb()
    const before = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    expect(purgeOldDeleted(db, 30)).toBe(0)
    const after = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    expect(after).toBe(before)
  })
})

describe('audit retention (Q1 #92)', () => {
  it('auditKeepDays round-trips through config, defaults to null (keep forever)', () => {
    const db = seededDb()
    expect(getAuditKeepDays(db)).toBeNull()
    expect(setAuditKeepDays(db, 365)).toBe(365)
    expect(getAuditKeepDays(db)).toBe(365)
    expect(setAuditKeepDays(db, null)).toBeNull()
    expect(getAuditKeepDays(db)).toBeNull()
  })

  it('pruneAudit deletes only rows older than the window', () => {
    const db = seededDb()
    writeAudit(db, 'old_thing', 1, 'create', null, { i: 1 })
    writeAudit(db, 'new_thing', 2, 'create', null, { i: 2 })
    db.prepare("UPDATE audit_log SET at = datetime('now', '-400 days') WHERE entity = 'old_thing'").run()

    const pruned = pruneAudit(db, 365)
    expect(pruned).toBeGreaterThanOrEqual(1)
    expect(auditRows(db, 'old_thing')).toHaveLength(0)
    expect(auditRows(db, 'new_thing')).toHaveLength(1)
  })
})

describe('year-end close + bank statement import audit rows (Q1 #90)', () => {
  it('postClose writes a year_end summary audit row', () => {
    const info: CompanyInfo = { ...TEST_INFO, booksFrom: 2024 }
    const db = freshDb()
    seedCompany(db, info)
    postSimpleVoucher(db, { date: '2024-06-01', amount: 50000, kind: 'receipt' })

    const result = postClose(db, info, 2024)

    const rows = auditRows(db, 'year_end')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entity_id).toBe(2024)
    expect(rows[0]!.action).toBe('create')
    expect(JSON.parse(rows[0]!.after_json!)).toMatchObject({
      voucherId: result.voucherId,
      netProfit: result.netProfit,
      lockedUpTo: '2025-03-31'
    })
  })

  it('importStatement writes a bank_statement summary audit row', () => {
    const db = seededDb()
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const csv = 'Date,Description,Debit,Credit\n2025-04-10,UPI RENT,500.00,\n'

    const result = importStatement(db, cash.id, csv)
    expect(result.statementRows).toBe(1)

    const rows = auditRows(db, 'bank_statement')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entity_id).toBe(cash.id)
    expect(rows[0]!.action).toBe('import')
    expect(JSON.parse(rows[0]!.after_json!)).toMatchObject({ statementRows: 1, unmatched: 1 })
  })
})
