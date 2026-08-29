import { describe, it, expect } from 'vitest'
import { seededDb, postSimpleVoucher } from '../db/testdb'
import { dailyDigest } from './audit'
import { deleteVoucher, restoreVoucher } from './vouchers'
import { createLedger } from './masters'
import { runAsAuditUser, setAuditContext } from './audit'
import { todayISO } from '@shared/dates'

// audit_log stamps `datetime('now')`, so the day under test is today's — the digest's own date
// arithmetic (yesterday, by default) is decided in ipc.ts and tested there through the UI.
const TODAY = todayISO()

describe('the daily digest', () => {
  it('says plainly that nothing happened', () => {
    const db = seededDb()
    // seedCompany writes nothing to the audit log, so a fresh company has a genuinely quiet day.
    const digest = dailyDigest(db, TODAY)
    expect(digest.quiet).toBe(true)
    expect(digest.totalEvents).toBe(0)
  })

  it('reports what was entered, by whom, and for how much', () => {
    const db = seededDb()
    setAuditContext({ appVersion: 'test', getUserName: () => null })
    runAsAuditUser('Arun', () => postSimpleVoucher(db, { date: TODAY, amount: 250000, kind: 'receipt' }))

    const digest = dailyDigest(db, TODAY)
    const entered = digest.sections.find((s) => s.key === 'entered')!
    expect(entered.count).toBe(1)
    expect(digest.enteredValue).toBe(250000)
    // Two events under Arun's name, not one: posting the first voucher also created the ledger
    // it credits. Attribution counts everything a person did, which is the point.
    expect(digest.people).toEqual([{ userName: 'Arun', events: 2 }])
  })

  it('separates a master edit from an entry', () => {
    const db = seededDb()
    const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
    createLedger(db, { name: 'Kumar Traders', groupId: group.id })
    postSimpleVoucher(db, { date: TODAY, amount: 100000, kind: 'receipt' })

    const keys = dailyDigest(db, TODAY).sections.map((s) => s.key)
    expect(keys).toContain('entered')
    expect(keys).toContain('masters')
  })

  it('tells the bin apart from an edit, in both directions', () => {
    const db = seededDb()
    const v = postSimpleVoucher(db, { date: TODAY, amount: 100000, kind: 'receipt' })
    deleteVoucher(db, v.id)
    restoreVoucher(db, v.id)

    const digest = dailyDigest(db, TODAY)
    expect(digest.sections.find((s) => s.key === 'binned')!.count).toBe(1)
    expect(digest.sections.find((s) => s.key === 'restored')!.count).toBe(1)
  })

  it('says nothing about a day that had nothing on it', () => {
    const db = seededDb()
    postSimpleVoucher(db, { date: TODAY, amount: 100000, kind: 'receipt' })
    expect(dailyDigest(db, '2001-01-01').quiet).toBe(true)
  })
})
