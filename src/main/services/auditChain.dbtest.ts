import { describe, it, expect, beforeEach } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { setAuditContext, verifyAuditChain, pruneAudit } from './audit'
import { CHAIN_HEAD_META_KEY } from './auditChain'
import { createGroup, updateGroup } from './masters'

/** Books with a handful of real, audited writes in them. */
function bookedDb(): ReturnType<typeof seededDb> {
  const db = seededDb()
  const capital = db.prepare("SELECT id FROM groups WHERE name = 'Capital Account'").get() as { id: number }
  const group = createGroup(db, { name: 'Share Capital', parentId: capital.id })
  updateGroup(db, group.id, { name: 'Share Capital (A)', parentId: capital.id })
  postSimpleVoucher(db, { date: '2026-04-01', amount: 250000, kind: 'receipt' })
  postSimpleVoucher(db, { date: '2026-04-02', amount: 175000, kind: 'payment' })
  return db
}

describe('audit trail tamper evidence', () => {
  beforeEach(() => {
    setAuditContext({ appVersion: '0.4.0-test', getUserName: () => 'Asha' })
  })

  it('chains every row it writes, and verifies clean when nobody has touched it', () => {
    const db = bookedDb()
    const unhashed = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE row_hash IS NULL').get() as { n: number }
    expect(unhashed.n).toBe(0)

    const result = verifyAuditChain(db)
    expect(result.ok).toBe(true)
    expect(result.checked).toBeGreaterThan(3)
    expect(result.problems).toEqual([])
  })

  it('detects a row edited behind the app back', () => {
    const db = bookedDb()
    const target = db.prepare("SELECT id FROM audit_log WHERE entity = 'voucher' ORDER BY id LIMIT 1").get() as {
      id: number
    }

    // Exactly what someone with sqlite3 and a motive would do: change what the entry says.
    db.prepare("UPDATE audit_log SET after_json = '{\"amount\":1}' WHERE id = ?").run(target.id)

    const result = verifyAuditChain(db)
    expect(result.ok).toBe(false)
    expect(result.problems.some((p) => p.kind === 'altered' && p.id === target.id)).toBe(true)
  })

  it('detects the user name on an entry being swapped', () => {
    const db = bookedDb()
    const target = db.prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1').get() as { id: number }
    db.prepare("UPDATE audit_log SET user_name = 'Someone Else' WHERE id = ?").run(target.id)
    expect(verifyAuditChain(db).ok).toBe(false)
  })

  it('detects a row deleted out of the middle', () => {
    const db = bookedDb()
    const rows = db.prepare('SELECT id FROM audit_log ORDER BY id').all() as { id: number }[]
    db.prepare('DELETE FROM audit_log WHERE id = ?').run(rows[1]!.id)

    const result = verifyAuditChain(db)
    expect(result.ok).toBe(false)
    expect(result.problems.some((p) => p.kind === 'broken-link')).toBe(true)
  })

  it('detects the newest entries being deleted, which a chain alone would not', () => {
    const db = bookedDb()
    const last = db.prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1').get() as { id: number }
    db.prepare('DELETE FROM audit_log WHERE id = ?').run(last.id)

    const result = verifyAuditChain(db)
    expect(result.ok).toBe(false)
    expect(result.problems.some((p) => p.kind === 'truncated')).toBe(true)
  })

  it('detects a row inserted by hand, however plausible it looks', () => {
    const db = bookedDb()
    db.prepare(
      `INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
       VALUES ('voucher', 999, 'delete', NULL, NULL, 'Asha', '0.4.0-test')`
    ).run()

    const result = verifyAuditChain(db)
    expect(result.ok).toBe(false)
    // The forged row carries no hash at all, and it sits after rows that do.
    expect(result.problems.some((p) => p.kind === 'inserted')).toBe(true)
    expect(result.unchained).toBe(1)
  })

  it('still verifies after retention prunes the oldest rows', () => {
    const db = bookedDb()
    // Age everything but the newest row, then prune. Retention deleting the front of the chain
    // is a policy, not tampering, and must not read as a break.
    const newest = db.prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1').get() as { id: number }
    db.prepare("UPDATE audit_log SET at = datetime('now', '-400 days') WHERE id < ?").run(newest.id)
    const pruned = pruneAudit(db, 30)
    expect(pruned).toBeGreaterThan(0)

    const result = verifyAuditChain(db)
    expect(result.ok).toBe(true)
  })

  it('keeps verifying as new rows are appended after a check', () => {
    const db = bookedDb()
    expect(verifyAuditChain(db).ok).toBe(true)
    postSimpleVoucher(db, { date: '2026-04-03', amount: 5000, kind: 'receipt' })
    const result = verifyAuditChain(db)
    expect(result.ok).toBe(true)
    const head = JSON.parse(
      (db.prepare('SELECT value FROM meta WHERE key = ?').get(CHAIN_HEAD_META_KEY) as { value: string }).value
    ) as { id: number }
    expect(head.id).toBe(result.headId)
  })

  it('treats rows written before the chain existed as unproved, not as tampering', () => {
    const db = bookedDb()
    // Simulate a company upgraded from an older build: its existing rows have no hashes.
    db.prepare('UPDATE audit_log SET prev_hash = NULL, row_hash = NULL').run()
    db.prepare('DELETE FROM meta WHERE key = ?').run(CHAIN_HEAD_META_KEY)

    const result = verifyAuditChain(db)
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(0)
    expect(result.unchained).toBeGreaterThan(0)

    // And from the first new write on, the trail is chained again.
    postSimpleVoucher(db, { date: '2026-04-04', amount: 1000, kind: 'receipt' })
    const after = verifyAuditChain(db)
    expect(after.ok).toBe(true)
    expect(after.checked).toBeGreaterThan(0)
  })
})
