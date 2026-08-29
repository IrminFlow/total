import { describe, it, expect, beforeEach } from 'vitest'
import { seededDb } from '../db/testdb'
import { createGroup, updateGroup, deleteGroup } from './masters'
import { setAuditContext, writeAudit, listAudit, pruneAudit, verifyAuditChain } from './audit'

describe('audit trail', () => {
  beforeEach(() => {
    setAuditContext({ appVersion: '1.2.3-test', getUserName: () => 'Test User' })
  })

  it('records create/update/delete on a master with correct before/after and app_version stamped', () => {
    const db = seededDb()
    const capital = db.prepare("SELECT id FROM groups WHERE name = 'Capital Account'").get() as { id: number }

    const created = createGroup(db, { name: 'Share Capital', parentId: capital.id })
    updateGroup(db, created.id, { name: 'Share Capital (Preference)', parentId: capital.id })
    deleteGroup(db, created.id)

    const rows = db
      .prepare("SELECT * FROM audit_log WHERE entity = 'group' AND entity_id = ? ORDER BY id")
      .all(created.id) as {
      action: string
      before_json: string | null
      after_json: string | null
      app_version: string | null
      user_name: string | null
    }[]

    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'delete'])

    expect(rows[0]!.before_json).toBeNull()
    expect(JSON.parse(rows[0]!.after_json!)).toMatchObject({ name: 'Share Capital' })

    expect(JSON.parse(rows[1]!.before_json!)).toMatchObject({ name: 'Share Capital' })
    expect(JSON.parse(rows[1]!.after_json!)).toMatchObject({ name: 'Share Capital (Preference)' })

    expect(JSON.parse(rows[2]!.before_json!)).toMatchObject({ name: 'Share Capital (Preference)' })
    expect(rows[2]!.after_json).toBeNull()

    for (const r of rows) {
      expect(r.app_version).toBe('1.2.3-test')
      expect(r.user_name).toBe('Test User')
    }
  })

  it('writeAudit keeps before_json/after_json null (not the string "null") when before/after are null', () => {
    const db = seededDb()
    writeAudit(db, 'thing', 1, 'create', null, { a: 1 })
    writeAudit(db, 'thing', 1, 'delete', { a: 1 }, null)
    const rows = db.prepare("SELECT before_json, after_json FROM audit_log WHERE entity = 'thing' ORDER BY id").all() as {
      before_json: string | null
      after_json: string | null
    }[]
    expect(rows[0]!.before_json).toBeNull()
    expect(rows[0]!.after_json).toBe('{"a":1}')
    expect(rows[1]!.before_json).toBe('{"a":1}')
    expect(rows[1]!.after_json).toBeNull()
  })

  it('chains rows and verifies contents, order, anchor and stored head', () => {
    const db = seededDb()
    writeAudit(db, 'thing', 1, 'create', null, { a: 1 })
    writeAudit(db, 'thing', 1, 'update', { a: 1 }, { a: 2 })
    writeAudit(db, 'thing', 1, 'delete', { a: 2 }, null)
    const status = verifyAuditChain(db)
    expect(status).toMatchObject({ ok: true, rowsChecked: 3, firstBrokenId: null, reason: null })
    const hashes = db.prepare('SELECT prev_hash AS prevHash, row_hash AS rowHash FROM audit_log ORDER BY id').all() as { prevHash: string; rowHash: string }[]
    expect(hashes[1]!.prevHash).toBe(hashes[0]!.rowHash)
    expect(hashes[2]!.prevHash).toBe(hashes[1]!.rowHash)
  })

  it('detects altered contents, missing middle rows and a truncated tail', () => {
    const altered = seededDb()
    writeAudit(altered, 'thing', 1, 'create', null, { a: 1 })
    writeAudit(altered, 'thing', 1, 'update', { a: 1 }, { a: 2 })
    altered.prepare("UPDATE audit_log SET after_json = '{\"a\":999}' WHERE entity_id = 1 AND action = 'update'").run()
    expect(verifyAuditChain(altered)).toMatchObject({ ok: false, reason: 'row_hash_mismatch' })

    const missing = seededDb()
    for (let i = 1; i <= 3; i++) writeAudit(missing, 'thing', i, 'create', null, { i })
    const middleId = (missing.prepare('SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 1').get() as { id: number }).id
    missing.prepare('DELETE FROM audit_log WHERE id = ?').run(middleId)
    expect(verifyAuditChain(missing)).toMatchObject({ ok: false, reason: 'previous_hash_mismatch' })

    const truncated = seededDb()
    writeAudit(truncated, 'thing', 1, 'create', null, { a: 1 })
    writeAudit(truncated, 'thing', 2, 'create', null, { a: 2 })
    truncated.prepare('DELETE FROM audit_log WHERE id = (SELECT MAX(id) FROM audit_log)').run()
    expect(verifyAuditChain(truncated)).toMatchObject({ ok: false, reason: 'head_mismatch' })
  })

  it('keeps the retained chain valid after configured prefix pruning', () => {
    const db = seededDb()
    writeAudit(db, 'thing', 1, 'create', null, { a: 1 })
    writeAudit(db, 'thing', 2, 'create', null, { a: 2 })
    const first = (db.prepare('SELECT id FROM audit_log ORDER BY id LIMIT 1').get() as { id: number }).id
    db.prepare("UPDATE audit_log SET at = datetime('now', '-400 days') WHERE id = ?").run(first)
    // Updating the timestamp is deliberate test setup; the deleted row is outside the retained
    // chain and pruneAudit advances the authenticated anchor to the next row's prev_hash.
    expect(pruneAudit(db, 365)).toBe(1)
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, rowsChecked: 1 })
  })

  it('listAudit pages server-side at 100 rows, newest first, with a correct total', () => {
    const db = seededDb()
    for (let i = 1; i <= 150; i++) {
      writeAudit(db, 'seed', i, 'create', null, { i })
    }

    const page0 = listAudit(db, { entity: 'seed', page: 0 })
    expect(page0.total).toBe(150)
    expect(page0.rows).toHaveLength(100)
    // Newest first: the last-written row (entityId 150) comes first.
    expect(page0.rows[0]!.entityId).toBe(150)
    expect(page0.rows[99]!.entityId).toBe(51)

    const page1 = listAudit(db, { entity: 'seed', page: 1 })
    expect(page1.total).toBe(150)
    expect(page1.rows).toHaveLength(50)
    expect(page1.rows[0]!.entityId).toBe(50)
    expect(page1.rows[49]!.entityId).toBe(1)
  })

  it('listAudit filters by entity', () => {
    const db = seededDb()
    writeAudit(db, 'alpha', 1, 'create', null, { x: 1 })
    writeAudit(db, 'beta', 2, 'create', null, { x: 2 })
    writeAudit(db, 'alpha', 3, 'create', null, { x: 3 })

    const alphaOnly = listAudit(db, { entity: 'alpha' })
    expect(alphaOnly.total).toBe(2)
    expect(alphaOnly.rows.every((r) => r.entity === 'alpha')).toBe(true)
  })

  it('listAudit filters by date range, inclusive of the to-date', () => {
    const db = seededDb()
    writeAudit(db, 'dated', 1, 'create', null, { d: 1 })
    writeAudit(db, 'dated', 2, 'create', null, { d: 2 })
    writeAudit(db, 'dated', 3, 'create', null, { d: 3 })

    const rows = db.prepare("SELECT id FROM audit_log WHERE entity = 'dated' ORDER BY id").all() as { id: number }[]
    db.prepare("UPDATE audit_log SET at = '2024-01-05 10:00:00' WHERE id = ?").run(rows[0]!.id)
    db.prepare("UPDATE audit_log SET at = '2024-01-10 23:59:59' WHERE id = ?").run(rows[1]!.id)
    db.prepare("UPDATE audit_log SET at = '2024-01-15 09:00:00' WHERE id = ?").run(rows[2]!.id)

    const inRange = listAudit(db, { entity: 'dated', from: '2024-01-05', to: '2024-01-10' })
    expect(inRange.total).toBe(2)
    expect(inRange.rows.map((r) => r.entityId).sort()).toEqual([1, 2])

    const onlyLast = listAudit(db, { entity: 'dated', from: '2024-01-15', to: '2024-01-15' })
    expect(onlyLast.total).toBe(1)
    expect(onlyLast.rows[0]!.entityId).toBe(3)
  })
})
