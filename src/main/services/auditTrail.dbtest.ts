// WP 3.8 — audit trail: migration 031's backfill, the hash chain's tamper evidence, the
// append-only triggers, retention under the audit-trail-required flag, clock-skew notes, user
// attribution, the edit-log export and the CA pack's audit files.
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { freshPartialDb, postSimpleVoucher, seededDb, TEST_INFO } from '../db/testdb'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { seedCompany } from '../db/seed'
import { snapshotSync } from '../db/backup'
import { createGroup, updateGroup } from './masters'
import { deleteVoucher, purgeVoucher } from './vouchers'
import {
  editLogExport, getAuditTrailRequired, listAudit, pruneAudit, runAsAuditUser, setAuditContext, setAuditTrailRequired, verifyAudit, writeAudit
} from './audit'
import { setAuditKeepDays } from './config'
import { GENESIS_HASH } from '@shared/auditChain'

type DB = Database.Database

/** Index of migration 031 (WP 3.8) — found by content, never by position (030 is a parallel WP). */
const M031 = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TRIGGER audit_log_append_only'))

const capitalId = (db: DB): number => (db.prepare("SELECT id FROM groups WHERE name = 'Capital Account'").get() as { id: number }).id
const count = (db: DB, where = '1'): number => (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`).get() as { n: number }).n

beforeEach(() => {
  setAuditContext({ appVersion: '0.7.0-test', getUserName: () => 'Test User', getUserId: () => 7 })
})

describe('migration 031 backfill', () => {
  it('is migration 031, after 030 (WP 2.6)', () => {
    expect(M031).toBeGreaterThan(MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE price_list_rates_030')))
    expect(M031 + 1).toBe(31)
    expect(M031).toBeLessThan(MIGRATIONS.length) // 032 (WP 4.1) and later append after it
  })

  it('seals every pre-existing row in id order into a chain that verifies; keeps users as recorded', () => {
    const db = freshPartialDb(M031)
    seedCompany(db, TEST_INFO)
    // A legacy log: masters, vouchers, a row without user, an old migration row (018 etc. are there already).
    const g = createGroup(db, { name: 'Legacy', parentId: capitalId(db) })
    updateGroup(db, g.id, { name: 'Legacy 2', parentId: capitalId(db) })
    postSimpleVoucher(db, { date: '2025-04-10', amount: 10000, kind: 'receipt' })
    db.prepare("INSERT INTO audit_log (entity, entity_id, action, after_json) VALUES ('ledger', 99, 'create', '{\"name\":\"no user\"}')").run()
    // the old retention setting pruned the oldest rows once — a pre-chain gap
    db.prepare('DELETE FROM audit_log WHERE id = (SELECT MIN(id) FROM audit_log WHERE entity <> ?)').run('migration')
    const before = db.prepare('SELECT id, entity, action, user_name AS u, before_json AS b, after_json AS a FROM audit_log ORDER BY id').all() as {
      id: number; entity: string; u: string | null
    }[]

    migrate(db)

    const after = db.prepare('SELECT id, entity, action, user_name AS u, before_json AS b, after_json AS a, prev_hash, row_hash FROM audit_log ORDER BY id').all() as {
      id: number; entity: string; u: string | null; prev_hash: string; row_hash: string
    }[]
    // every row preserved with its id; plus the 031 trace row
    expect(after.slice(0, before.length).map((r) => ({ ...r, prev_hash: undefined, row_hash: undefined, u: r.entity === 'migration' ? null : r.u }))).toEqual(
      before.map((r) => ({ ...r, prev_hash: undefined, row_hash: undefined, u: r.entity === 'migration' ? null : r.u }))
    )
    expect(after).toHaveLength(before.length + 1)
    expect(after.every((r) => /^[0-9a-f]{64}$/.test(r.row_hash))).toBe(true)
    expect(after[0]!.prev_hash).toBe(GENESIS_HASH)
    for (let i = 1; i < after.length; i++) expect(after[i]!.prev_hash).toBe(after[i - 1]!.row_hash)
    // migration rows → 'system'; a pre-attribution row stays NULL (never invented)
    expect(after.filter((r) => r.entity === 'migration').every((r) => r.u === 'system')).toBe(true)
    expect(after.find((r) => r.entity === 'ledger' && r.id === before.find((b) => b.entity === 'ledger' && b.u === null)?.id)?.u).toBeNull()

    const trace = JSON.parse((db.prepare("SELECT after_json AS j FROM audit_log WHERE entity = 'migration' AND entity_id = 31").get() as { j: string }).j)
    expect(trace).toMatchObject({ migration: 31, rowsBackfilled: before.length, missingIdsBefore: 1 })

    const v = verifyAudit(db)
    expect(v).toMatchObject({ ok: true, rows: after.length, headId: after.at(-1)!.id, firstBreak: null })

    // and a normal write after the migration chains on
    writeAudit(db, 'group', 1, 'update', { a: 1 }, { a: 2 })
    expect(verifyAudit(db).ok).toBe(true)
  })
})

describe('tamper evidence', () => {
  function companyWithLog(): DB {
    const db = seededDb()
    for (let i = 0; i < 4; i++) postSimpleVoucher(db, { date: '2025-04-1' + i, amount: 1000 * (i + 1), kind: 'receipt' })
    expect(verifyAudit(db).ok).toBe(true)
    return db
  }
  const ids = (db: DB): number[] => (db.prepare("SELECT id FROM audit_log WHERE entity = 'voucher' ORDER BY id").all() as { id: number }[]).map((r) => r.id)

  it('the database itself refuses edits and deletes of sealed rows', () => {
    const db = companyWithLog()
    const [first] = ids(db)
    expect(() => db.prepare("UPDATE audit_log SET user_name = 'mallory' WHERE id = ?").run(first)).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(first)).toThrow(/cannot be deleted/)
    expect(() => db.prepare("DELETE FROM audit_log WHERE entity = 'migration'").run()).toThrow(/cannot be deleted/)
  })

  it('detects an edited row (after the triggers are dropped with a SQLite tool)', () => {
    const db = companyWithLog()
    const target = ids(db)[1]!
    db.exec('DROP TRIGGER audit_log_append_only')
    db.prepare("UPDATE audit_log SET after_json = replace(after_json, '2000', '9000') WHERE id = ?").run(target)
    const v = verifyAudit(db)
    expect(v.ok).toBe(false)
    expect(v.firstBreak).toMatchObject({ rowId: target, kind: 'altered' })
  })

  it('detects a deleted row in the middle, and deleted newest rows', () => {
    const db = companyWithLog()
    const vs = ids(db)
    db.exec('DROP TRIGGER audit_log_no_delete')
    db.prepare('DELETE FROM audit_log WHERE id = ?').run(vs[1])
    const v = verifyAudit(db)
    expect(v.firstBreak).toMatchObject({ rowId: vs[2], kind: 'link_broken' })
    expect(v.firstBreak!.message).toContain(`row ${vs[1]} is missing`)

    const db2 = companyWithLog()
    db2.exec('DROP TRIGGER audit_log_no_delete')
    const last = (db2.prepare('SELECT MAX(id) AS m FROM audit_log').get() as { m: number }).m
    db2.prepare('DELETE FROM audit_log WHERE id = ?').run(last)
    expect(verifyAudit(db2).firstBreak).toMatchObject({ kind: 'missing_tail' })
  })

  it('a row inserted outside the app is flagged, and the app keeps chaining past it', () => {
    const db = companyWithLog()
    db.prepare("INSERT INTO audit_log (entity, entity_id, action, user_name) VALUES ('voucher', 1, 'delete', 'mallory')").run()
    const forged = (db.prepare('SELECT MAX(id) AS m FROM audit_log').get() as { m: number }).m
    writeAudit(db, 'group', 1, 'update', null, { x: 1 })
    const v = verifyAudit(db)
    expect(v.issues).toEqual([expect.objectContaining({ rowId: forged, kind: 'unsealed' })])
  })

  it('restoring a backup restores its chain (verify after restore)', () => {
    const db = companyWithLog()
    const dir = mkdtempSync(join(tmpdir(), 'audit-backup-'))
    const file = join(dir, 'b.db')
    snapshotSync(db, file)
    writeAudit(db, 'group', 1, 'update', null, { later: true })
    const restored = new Database(file)
    try {
      const v = verifyAudit(restored)
      expect(v.ok).toBe(true)
      expect(v.headId).toBe(verifyAudit(db).headId! - 1)
    } finally {
      restored.close()
    }
  })
})

describe('retention', () => {
  it('defaults to audit-trail-required: nothing is ever pruned, whatever the age', () => {
    const db = seededDb()
    expect(getAuditTrailRequired(db)).toBe(true)
    db.prepare("INSERT INTO audit_log (entity, entity_id, action, at) VALUES ('ledger', 1, 'create', '2001-01-01 00:00:00')").run()
    const n = count(db)
    expect(pruneAudit(db, 2922, '2026-10-07')).toBe(0)
    expect(count(db)).toBe(n)
    expect(() => setAuditKeepDays(db, 3000)).toThrow(/audit trail required/)
  })

  it('with the flag off: prunes only before the s.128(5) floor, never migration or prune rows, and the chain still verifies', () => {
    const db = freshPartialDb(M031)
    seedCompany(db, TEST_INFO)
    // ancient rows written before the chain, so the backfill hashes them in
    for (const e of ['ledger', 'group', 'migration']) {
      db.prepare("INSERT INTO audit_log (entity, entity_id, action, at, user_name) VALUES (?, 1, 'create', '2012-06-01 10:00:00', 'old')").run(e)
    }
    migrate(db)
    writeAudit(db, 'ledger', 2, 'update', null, { recent: true })
    setAuditTrailRequired(db, false)
    setAuditKeepDays(db, 3000)
    const pruned = pruneAudit(db, 3000, '2026-10-07')
    expect(pruned).toBe(2)
    expect(count(db, "at LIKE '2012-%'")).toBe(1) // the migration row stays
    const prune = db.prepare("SELECT user_name AS u, after_json AS j FROM audit_log WHERE action = 'prune'").get() as { u: string; j: string }
    expect(prune.u).toBe('system')
    expect(JSON.parse(prune.j)).toMatchObject({ count: 2, cutoff: '2018-04-01' })
    const v = verifyAudit(db)
    expect(v.ok).toBe(true)
    expect(v.prunedRows).toBe(2)
    // a prune row can never be deleted itself
    db.prepare("INSERT INTO meta (key, value) VALUES ('audit.pruneWindowOpen', '1')").run()
    expect(() => db.prepare("DELETE FROM audit_log WHERE action = 'prune'").run()).toThrow(/cannot be deleted/)
  })

  it('the bin permanent delete leaves the audit rows', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: '2025-04-05', amount: 5000, kind: 'receipt' })
    deleteVoucher(db, v.id)
    purgeVoucher(db, v.id)
    expect(listAudit(db, { voucherId: v.id }).rows.map((r) => r.action)).toEqual(['purge', 'delete', 'create'])
  })
})

describe('attribution and timestamps', () => {
  it('stamps user id + name, local ISO with offset, UTC at and app version; system for jobs; OS login with no session', () => {
    const db = seededDb()
    writeAudit(db, 'group', 1, 'update', null, { a: 1 })
    runAsAuditUser('system', () => writeAudit(db, 'group', 1, 'update', null, { a: 2 }))
    setAuditContext({ appVersion: '0.7.0-test', getUserName: () => null })
    writeAudit(db, 'group', 1, 'update', null, { a: 3 })
    const rows = db.prepare("SELECT user_name AS u, user_id AS uid, at, at_iso AS iso, app_version AS v FROM audit_log WHERE entity = 'group' ORDER BY id").all() as {
      u: string; uid: number | null; at: string; iso: string; v: string
    }[]
    expect(rows.map((r) => [r.u.replace(/^os:.+/, 'os:*'), r.uid])).toEqual([['Test User', 7], ['system', null], ['os:*', null]])
    for (const r of rows) {
      expect(r.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
      expect(Date.parse(r.iso)).toBe(Date.parse(`${r.at.replace(' ', 'T')}Z`) + Number(r.iso.slice(20, 23)))
      expect(r.v).toBe('0.7.0-test')
    }
  })

  it('records a clock-skew note when the clock goes backwards between rows', () => {
    const db = seededDb()
    db.exec('DROP TRIGGER audit_log_append_only')
    // pretend the previous row was written an hour in the future
    db.prepare("UPDATE audit_log SET at_iso = '2999-01-01T00:00:00.000+05:30' WHERE id = (SELECT MAX(id) FROM audit_log)").run()
    writeAudit(db, 'group', 1, 'update', null, { a: 1 })
    const note = (db.prepare('SELECT clock_skew_note AS n FROM audit_log ORDER BY id DESC LIMIT 1').get() as { n: string }).n
    expect(note).toMatch(/System clock went backwards/)
  })
})

describe('edit-log export and the CA pack', () => {
  it('has the auditor header (company, period, generation time, verification) and field-level changes', () => {
    const db = seededDb()
    const g = createGroup(db, { name: 'Rent', parentId: capitalId(db) })
    updateGroup(db, g.id, { name: 'Rent & rates', parentId: capitalId(db) })
    const r = editLogExport(db, { name: 'Test Co', gstin: null }, { from: '2000-01-01', to: '2999-12-31', entity: 'group' })
    expect(r.header[0]).toBe('Company: Test Co')
    expect(r.header[1]).toMatch(/^Period: 2000-01-01 to 2999-12-31 · filters: entity Group/)
    expect(r.header[2]).toMatch(/^Generated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    expect(r.header[4]).toMatch(/^Chain verified/)
    const update = r.rows.find((row) => row[5] === 'Update')!
    expect(update[2]).toBe('Test User')
    expect(update[4]).toBe(`${g.id} · Rent & rates`)
    expect(update[6]).toContain('name: Rent → Rent & rates')
    expect(update[8]).toBe('verified')
  })

  it('the CA pack carries audit-trail.csv and a verification summary', async () => {
    process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'audit-capack-'))
    const { exportCaPack } = await import('./caPack')
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-04-10', amount: 10000, kind: 'receipt' })
    const { path } = exportCaPack(db, TEST_INFO, 'test-co', '2025-04-01', '2026-03-31')
    expect(existsSync(join(path, 'audit-trail.csv'))).toBe(true)
    const summary = readFileSync(join(path, 'audit-trail-verification.txt'), 'utf8')
    expect(summary).toContain('Result: VERIFIED')
    expect(summary).toMatch(/Chain head hash \(SHA-256\): [0-9a-f]{64}/)
  })
})

describe('WP 2.6 pricing and counter billing write their own entities', () => {
  it('party rates, schemes, counter sales and held bills', async () => {
    const { pricingFixture } = await import('./pricingFixture.testutil')
    const { savePartyRate, deletePartyRate, saveScheme } = await import('./pricing')
    const { counterCheckout, holdBill, recallHeldBill, discardHeldBill } = await import('./counter')
    const { db, umbrella, pen } = pricingFixture()
    const rows = (entity: string): { action: string; entity_id: number }[] =>
      db.prepare('SELECT action, entity_id FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as { action: string; entity_id: number }[]

    const r = savePartyRate(db, { ledgerId: umbrella, stockItemId: pen, ratePaise: 900 })
    deletePartyRate(db, r.id)
    expect(rows('partyRate').map((x) => x.action)).toEqual(['create', 'delete'])
    saveScheme(db, { name: 'Diwali 10%', kind: 'flat', appliesTo: 'all', slabs: [{ discountBp: 1000 }] })
    expect(rows('discountScheme').map((x) => x.action)).toEqual(['create'])

    const sale = counterCheckout(db, TEST_INFO, {
      date: '2025-10-07', lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }], payments: [{ mode: 'cash', amountPaise: 1200 }]
    })
    expect(rows('counter_sale')).toEqual([{ action: 'create', entity_id: sale.invoiceId }])
    expect(listAudit(db, { voucherId: sale.invoiceId }).rows.map((x) => x.entity)).toContain('counter_sale')

    const a = holdBill(db, { lines: [{ itemId: pen, qtyMilli: 1000, ratePaise: 1000 }] })
    const b = holdBill(db, { lines: [{ itemId: pen, qtyMilli: 2000, ratePaise: 1000 }] })
    recallHeldBill(db, a.id)
    discardHeldBill(db, b.id)
    expect(rows('held_bill').map((x) => x.action)).toEqual(['create', 'create', 'delete', 'delete'])
    expect(verifyAudit(db).ok).toBe(true)
  })
})
