import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, updateLedger } from './masters'
import { saveVoucher } from './vouchers'
import { auditTrailStatement, currentLut, deleteLut, listLuts, relatedPartyReport, saveLut } from './disclosure'

type Db = ReturnType<typeof seededDb>

const groupId = (db: Db, name: string): number =>
  (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id

function party(db: Db, name: string, extra: Record<string, unknown> = {}) {
  return createLedger(db, { name, groupId: groupId(db, 'Sundry Debtors'), ...extra } as never)
}

function sale(db: Db, partyLedgerId: number, date: string, number: string, amount: number) {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
  const salesLedger =
    (db.prepare("SELECT id FROM ledgers WHERE name = 'Sales Account'").get() as { id: number } | undefined)?.id ??
    createLedger(db, { name: 'Sales Account', groupId: groupId(db, 'Sales Accounts') } as never).id
  return saveVoucher(db, {
    voucherTypeId: vt.id, date, number, partyLedgerId,
    lines: [
      { ledgerId: partyLedgerId, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: salesLedger, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  } as never)
}

describe('related-party transactions', () => {
  it('lists only the parties somebody flagged', () => {
    const db = seededDb()
    const director = party(db, "Director's Company", { relatedParty: true, relationship: 'Company under common control' })
    const ordinary = party(db, 'Ordinary Customer')
    sale(db, director.id, '2026-06-01', 'S-1', 1_00_000_00)
    sale(db, ordinary.id, '2026-06-01', 'S-2', 5_00_000_00)

    const r = relatedPartyReport(db, '2026-04-01', '2027-03-31')
    expect(r.rows.map((x) => x.name)).toEqual(["Director's Company"])
    expect(r.rows[0]!.relationship).toBe('Company under common control')
    expect(r.rows[0]!.debits).toBe(1_00_000_00)
    expect(r.totalDebits).toBe(1_00_000_00)
  })

  it('keeps a flagged party with no transactions — a nil disclosure is still a disclosure', () => {
    const db = seededDb()
    party(db, 'Dormant Relative', { relatedParty: true, relationship: 'Relative of director' })
    const r = relatedPartyReport(db, '2026-04-01', '2027-03-31')
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.transactions).toEqual([])
    expect(r.dormant).toBe(1)
  })

  it('separates what went out from what came in, and reports the closing balance', () => {
    const db = seededDb()
    const p = party(db, 'Related Co', { relatedParty: true })
    sale(db, p.id, '2026-06-01', 'S-1', 3_00_000_00)
    const receipt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    saveVoucher(db, {
      voucherTypeId: receipt.id, date: '2026-07-01', number: 'R-1', partyLedgerId: p.id,
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 1_00_000_00, costAllocations: [] },
        { ledgerId: p.id, drCr: 'cr', amount: 1_00_000_00, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    } as never)

    const r = relatedPartyReport(db, '2026-04-01', '2027-03-31')
    expect(r.rows[0]!.debits).toBe(3_00_000_00)
    expect(r.rows[0]!.credits).toBe(1_00_000_00)
    expect(r.rows[0]!.closingBalance).toBe(2_00_000_00)
    expect(r.rows[0]!.transactions).toHaveLength(2)
  })

  it('leaves the period alone — a transaction outside it is not disclosed in it', () => {
    const db = seededDb()
    const p = party(db, 'Related Co', { relatedParty: true })
    sale(db, p.id, '2025-06-01', 'OLD', 1_00_000_00)
    const r = relatedPartyReport(db, '2026-04-01', '2027-03-31')
    expect(r.rows[0]!.transactions).toEqual([])
    // The balance is still as at the period end, which is what a balance means.
    expect(r.rows[0]!.closingBalance).toBe(1_00_000_00)
  })

  it('says nothing at all when nobody is flagged', () => {
    const db = seededDb()
    party(db, 'Ordinary')
    expect(relatedPartyReport(db, '2026-04-01', '2027-03-31').rows).toEqual([])
  })

  it('round-trips the flag through the party master', () => {
    const db = seededDb()
    const p = party(db, 'Flagged', { relatedParty: true, relationship: 'Director' })
    expect(p.relatedParty).toBe(true)
    expect(p.relationship).toBe('Director')
    const off = updateLedger(db, p.id, { name: 'Flagged', groupId: groupId(db, 'Sundry Debtors'), relatedParty: false } as never)
    expect(off.relatedParty).toBe(false)
  })
})

describe('the audit trail, about itself', () => {
  it('measures its own coverage rather than asserting it', () => {
    const db = seededDb()
    const p = party(db, 'Somebody')
    sale(db, p.id, '2026-06-01', 'S-1', 1_00_000_00)

    const today = new Date().toISOString().slice(0, 10)
    const s = auditTrailStatement(db, '2000-01-01', today, null)
    expect(s.entries).toBeGreaterThan(0)
    expect(s.firstEntry).not.toBeNull()
    expect(s.lastEntry).not.toBeNull()
    expect(s.entities.some((e) => e.entity === 'ledger')).toBe(true)
    expect(s.entities.some((e) => e.entity === 'voucher')).toBe(true)
    expect(s.entities.reduce((t, e) => t + e.entries, 0)).toBe(s.entries)
    expect(s.users.reduce((t, u) => t + u.entries, 0)).toBe(s.entries)
  })

  it('states plainly that it cannot be switched off', () => {
    const db = seededDb()
    expect(auditTrailStatement(db, '2000-01-01', '2030-01-01', null).canBeDisabled).toBe(false)
  })

  it('warns when retention would have eaten into the period being reported', () => {
    const db = seededDb()
    const today = new Date().toISOString().slice(0, 10)
    expect(auditTrailStatement(db, '2000-01-01', today, 90).retentionAffectsPeriod).toBe(true)
    expect(auditTrailStatement(db, today, today, 90).retentionAffectsPeriod).toBe(false)
    expect(auditTrailStatement(db, '2000-01-01', today, null).retentionAffectsPeriod).toBe(false)
  })

  it('counts nothing for a period with no activity', () => {
    const db = seededDb()
    const s = auditTrailStatement(db, '1990-01-01', '1990-12-31', null)
    expect(s.entries).toBe(0)
    expect(s.entities).toEqual([])
  })
})

describe('LUT tracking', () => {
  it('is missing until one is filed, and says what that means', () => {
    const db = seededDb()
    const s = currentLut(db, '2026-06-01')
    expect(s.state).toBe('missing')
    expect(s.message).toContain('taxable')
  })

  it('round-trips, and replaces rather than duplicates a year', () => {
    const db = seededDb()
    saveLut(db, { arn: 'AD2026001', fyStartYear: 2026, filedOn: '2026-04-05' })
    saveLut(db, { arn: 'AD2026002', fyStartYear: 2026, filedOn: '2026-04-08' })
    const all = listLuts(db)
    expect(all).toHaveLength(1)
    expect(all[0]!.arn).toBe('AD2026002')
  })

  it('reports validity against a date, not against today', () => {
    const db = seededDb()
    saveLut(db, { arn: 'AD2026001', fyStartYear: 2026, filedOn: '2026-04-05' })
    expect(currentLut(db, '2026-06-01').state).toBe('valid')
    expect(currentLut(db, '2027-03-10').state).toBe('expiring')
    expect(currentLut(db, '2027-04-10').state).toBe('expired')
  })

  it('can be removed', () => {
    const db = seededDb()
    saveLut(db, { arn: 'AD2026001', fyStartYear: 2026, filedOn: '2026-04-05' })
    expect(deleteLut(db, 2026)).toEqual([])
  })

  it('is written to the audit log like everything else', () => {
    const db = seededDb()
    saveLut(db, { arn: 'AD2026001', fyStartYear: 2026, filedOn: '2026-04-05' })
    const n = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'lut'").get() as { n: number }
    expect(n.n).toBe(1)
  })
})
