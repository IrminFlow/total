import { describe, it, expect } from 'vitest'
import { filingLiability, filingPeriodBounds, filingRegister, recordFiling } from './filings'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { CompanyInfo } from '@shared/domain'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'

/**
 * The filing register.
 *
 * The schedule half is pure and tested in compliance.test.ts; the late-fee maths is pure and
 * tested in lateFee.test.ts. What can only be tested here is the join: that a recorded filing
 * lands on the right row, that the status reflects where today sits relative to the period and
 * the due date, and that the charge is recomputed from the dates rather than trusted.
 */
const MONTHLY: CompanyInfo = { ...TEST_INFO, gstin: '27AAPFU0939F1ZV', booksFrom: 2026 }
const QRMP: CompanyInfo = { ...MONTHLY, gstFilingFrequency: 'quarterly' }

describe('filing register — schedule joined to what was filed', () => {
  it('lists every obligation for the year, all unfiled to begin with', () => {
    const db = seededDb()
    const rows = filingRegister(db, MONTHLY, 2026, '2027-04-30')
    expect(rows).toHaveLength(24) // twelve GSTR-1 + twelve GSTR-3B
    expect(rows.every((r) => r.record === null)).toBe(true)
    expect(rows.every((r) => r.projected)).toBe(true)
  })

  it('calls a period that has not ended yet upcoming, not overdue', () => {
    // Mid-August 2026. April to July are past due; August is still running, and calling it
    // overdue would be a false alarm every single month.
    const db = seededDb()
    const rows = filingRegister(db, MONTHLY, 2026, '2026-08-15')
    const aug = rows.find((r) => r.form === 'GSTR-1' && r.period === '2026-08')!
    const apr = rows.find((r) => r.form === 'GSTR-1' && r.period === '2026-04')!
    const sep = rows.find((r) => r.form === 'GSTR-1' && r.period === '2026-09')!
    expect(aug.status).toBe('upcoming')
    expect(apr.status).toBe('overdue')
    expect(sep.status).toBe('upcoming')
  })

  it('calls a closed period due while its date has not passed, and overdue after', () => {
    const db = seededDb()
    // July's GSTR-1 is due 11 August. On the 5th it is due; on the 12th it is overdue.
    const on = (today: string) =>
      filingRegister(db, MONTHLY, 2026, today).find((r) => r.form === 'GSTR-1' && r.period === '2026-07')!
    expect(on('2026-08-05').status).toBe('due')
    expect(on('2026-08-11').status).toBe('due') // the due date itself is still in time
    expect(on('2026-08-12').status).toBe('overdue')
  })

  it('projects what an overdue return costs if filed today', () => {
    const db = seededDb()
    // April's GSTR-3B was due 20 May; on 30 May that is 10 days at the nil rate of ₹20/day.
    const row = filingRegister(db, MONTHLY, 2026, '2026-05-30').find(
      (r) => r.form === 'GSTR-3B' && r.period === '2026-04'
    )!
    expect(row.projected).toBe(true)
    expect(row.charge.daysLate).toBe(10)
    expect(row.charge.lateFeePaise).toBe(200 * 100)
  })

  it('records a filing against the right row and stops projecting', () => {
    const db = seededDb()
    const before = filingRegister(db, MONTHLY, 2026, '2026-08-15').find(
      (r) => r.form === 'GSTR-1' && r.period === '2026-04'
    )!

    recordFiling(db, {
      form: 'GSTR-1',
      period: '2026-04',
      dueDate: before.date,
      filedAt: '2026-05-11',
      arn: 'AA270526000001X',
      taxPaid: 0,
      notes: null
    })

    const rows = filingRegister(db, MONTHLY, 2026, '2026-08-15')
    const filed = rows.find((r) => r.form === 'GSTR-1' && r.period === '2026-04')!
    expect(filed.status).toBe('filed')
    expect(filed.projected).toBe(false)
    expect(filed.record?.arn).toBe('AA270526000001X')
    // Filed on the due date, so nothing is owed.
    expect(filed.charge.totalPaise).toBe(0)

    // And nothing else moved.
    expect(rows.filter((r) => r.record !== null)).toHaveLength(1)
  })

  it('recomputes the fee from the dates instead of trusting what it is handed', () => {
    // A register that stores a hand-supplied figure next to inputs that contradict it lies.
    const db = seededDb()
    const rec = recordFiling(db, {
      form: 'GSTR-3B',
      period: '2026-04',
      dueDate: '2026-05-20',
      filedAt: '2026-06-19', // 30 days late
      arn: 'AA270526000002X',
      taxPaid: 10_00_000, // ₹10,000
      notes: null
    })
    expect(rec.lateFee).toBe(30 * 50 * 100) // ₹50/day × 30
    // ₹10,000 at 18% for 30 days = 10,00,000 × 18 × 30 / 36,500 = 14794 paise (floored).
    expect(rec.interest).toBe(14_794)
  })

  it('clears a filing back to outstanding, and zeroes what it cost', () => {
    const db = seededDb()
    recordFiling(db, {
      form: 'GSTR-3B', period: '2026-04', dueDate: '2026-05-20',
      filedAt: '2026-06-19', arn: 'AA1', taxPaid: 10_00_000, notes: null
    })
    const cleared = recordFiling(db, {
      form: 'GSTR-3B', period: '2026-04', dueDate: '2026-05-20',
      filedAt: null, arn: null, taxPaid: 0, notes: 'filed in error'
    })
    expect(cleared.filedAt).toBeNull()
    expect(cleared.lateFee).toBe(0)
    expect(cleared.interest).toBe(0)
    expect(cleared.notes).toBe('filed in error')

    const row = filingRegister(db, MONTHLY, 2026, '2026-08-15').find(
      (r) => r.form === 'GSTR-3B' && r.period === '2026-04'
    )!
    expect(row.status).toBe('overdue')
  })

  it('keeps one row per (form, period) however many times it is written', () => {
    const db = seededDb()
    for (const arn of ['AA1', 'AA2', 'AA3']) {
      recordFiling(db, {
        form: 'GSTR-1', period: '2026-04', dueDate: '2026-05-11',
        filedAt: '2026-05-11', arn, taxPaid: 0, notes: null
      })
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM gst_filings').get() as { n: number }
    expect(count.n).toBe(1)
    expect(
      filingRegister(db, MONTHLY, 2026, '2026-08-15').find((r) => r.period === '2026-04' && r.form === 'GSTR-1')!
        .record?.arn
    ).toBe('AA3')
  })

  it('audits a filing, so the register itself has a trail', () => {
    const db = seededDb()
    recordFiling(db, {
      form: 'GSTR-1', period: '2026-04', dueDate: '2026-05-11',
      filedAt: '2026-05-11', arn: 'AA1', taxPaid: 0, notes: null
    })
    recordFiling(db, {
      form: 'GSTR-1', period: '2026-04', dueDate: '2026-05-11',
      filedAt: '2026-05-12', arn: 'AA2', taxPaid: 0, notes: null
    })
    const rows = db
      .prepare("SELECT action FROM audit_log WHERE entity = 'gst_filing' ORDER BY id")
      .all() as { action: string }[]
    expect(rows.map((r) => r.action)).toEqual(['create', 'update'])
  })

  it('gives a QRMP filer challans and quarterly returns, keyed by quarter', () => {
    const db = seededDb()
    const rows = filingRegister(db, QRMP, 2026, '2027-04-30')
    expect(rows.filter((r) => r.form === 'PMT-06')).toHaveLength(8)
    expect(rows.filter((r) => r.form === 'GSTR-3B').map((r) => r.period)).toEqual([
      '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'
    ])
    // A quarter still running is upcoming, same rule as a month.
    const midQ2 = filingRegister(db, QRMP, 2026, '2026-08-15').find(
      (r) => r.form === 'GSTR-3B' && r.period === '2026-Q2'
    )!
    expect(midQ2.status).toBe('upcoming')
  })

  it('resolves a period key of any granularity back to its dates', () => {
    expect(filingPeriodBounds('2026-04')).toEqual({ from: '2026-04-01', to: '2026-04-30' })
    expect(filingPeriodBounds('2026-Q1')).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    expect(filingPeriodBounds('2026-FY')).toEqual({ from: '2026-04-01', to: '2027-03-31' })
  })
})

describe('filing register — nil periods and what the books say is payable', () => {
  function withOneSale() {
    const db = seededDb()
    const groupId = (name: string): number =>
      (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const vtId = (kind: string): number =>
      (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
    const L = (input: Parameters<typeof createLedger>[1]): number => createLedger(db, input).id

    const buyer = L({ name: 'Buyer', groupId: groupId('Sundry Debtors'), stateCode: '27' })
    const sales = L({ name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18, hsn: '998314' })
    const cgst = L({ name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' })
    const sgst = L({ name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' })

    // One intra-state sale of Rs 1,00,000 + 18% in May 2026: CGST 9,000 + SGST 9,000.
    saveVoucher(db, {
      voucherTypeId: vtId('sales'), date: '2026-05-10', partyLedgerId: buyer, posOverride: null,
      lines: [
        { ledgerId: buyer, drCr: 'dr', amount: 11800000, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 10000000, costAllocations: [] },
        { ledgerId: cgst, drCr: 'cr', amount: 900000, costAllocations: [] },
        { ledgerId: sgst, drCr: 'cr', amount: 900000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    })
    return db
  }

  it('marks only the periods that have entries', () => {
    const db = withOneSale()
    const rows = filingRegister(db, MONTHLY, 2026, '2027-04-30')
    expect(rows.filter((r) => r.hasEntries).map((r) => r.period)).toEqual(['2026-05', '2026-05'])
    // Every other month is nil, which is what makes the one-click nil return safe to offer.
    expect(rows.filter((r) => !r.hasEntries)).toHaveLength(22)
  })

  it('treats a quarter with one busy month as not nil', () => {
    // A quarterly return covering one busy month is not a nil return.
    const db = withOneSale()
    const rows = filingRegister(db, QRMP, 2026, '2027-04-30')
    const q1 = rows.filter((r) => r.period === '2026-Q1')
    expect(q1.length).toBeGreaterThan(0)
    expect(q1.every((r) => r.hasEntries)).toBe(true)
    expect(rows.filter((r) => r.period === '2026-Q2').every((r) => !r.hasEntries)).toBe(true)
  })

  it('ignores a soft-deleted voucher when deciding whether a period is nil', () => {
    const db = withOneSale()
    db.prepare("UPDATE vouchers SET deleted_at = '2026-06-01T00:00:00Z'").run()
    expect(filingRegister(db, MONTHLY, 2026, '2027-04-30').every((r) => !r.hasEntries)).toBe(true)
  })

  it('reports what the books say is payable for a GSTR-3B month', () => {
    const db = withOneSale()
    const l = filingLiability(db, MONTHLY, 'GSTR-3B', '2026-05')
    expect(l.source).toBe('GSTR-3B')
    // Rs 18,000 output tax, no ITC in these books, so the whole lot is payable in cash.
    expect(l.taxPayable).toBe(1800000)
  })

  it('answers the same figure for the PMT-06 challan behind a QRMP month', () => {
    // The challan is a payment against the same computation — that is what a filer is trying to
    // work out when they open it.
    const db = withOneSale()
    expect(filingLiability(db, QRMP, 'PMT-06', '2026-05').taxPayable).toBe(1800000)
  })

  it('answers null for a form that carries no payment, rather than zero', () => {
    // "Nothing is payable" and "this form takes no payment" are different facts.
    const db = withOneSale()
    for (const form of ['GSTR-1', 'IFF']) {
      const l = filingLiability(db, MONTHLY, form, '2026-05')
      expect(l.taxPayable).toBeNull()
      expect(l.source).toBeNull()
    }
  })

  it('reports zero for a month with no entries, which is a real answer', () => {
    const db = withOneSale()
    expect(filingLiability(db, MONTHLY, 'GSTR-3B', '2026-06').taxPayable).toBe(0)
  })
})
