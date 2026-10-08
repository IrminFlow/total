import { describe, expect, it } from 'vitest'
import { addMonths, buildCloseChecklist, CLOSE_CHECK_KEYS, missingRegulars, monthBounds, nextMonthDay, progressOf, type CloseFacts } from './closeChecklist'

const clean = (): CloseFacts => ({
  bank: [{ ledgerId: 2, name: 'HDFC', unreconciled: [], openStatementLines: [] }],
  unallocated: [],
  overdue: [],
  gst: { gstr1ExportedAt: '2026-06-10T10:00:00Z', gstr3bExportedAt: '2026-06-18T10:00:00Z' },
  withholding: [],
  withholdingMissed: [],
  negativeStock: [],
  unbilled: [],
  suspense: [],
  pdcs: [],
  depreciation: { assetsInService: 0, coveredThrough: null },
  accruals: [],
  blankNarration: [],
  roundOff: [],
  unbalanced: [],
  drafts: [],
  optionalVouchers: [],
  lockDate: '2026-05-31'
})

const status = (c: ReturnType<typeof buildCloseChecklist>, key: string): string => c.checks.find((x) => x.key === key)!.effective

describe('date helpers', () => {
  it('month bounds, month arithmetic, due days', () => {
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2025-12', 1)).toBe('2026-01')
    expect(nextMonthDay('2026-12', 11)).toBe('2027-01-11')
  })
})

describe('buildCloseChecklist', () => {
  it('a clean month: every check cleared (or not applicable), 100%', () => {
    const c = buildCloseChecklist(clean(), { period: '2026-05', today: '2026-06-25' })
    expect(c.checks.map((x) => x.key)).toEqual([...CLOSE_CHECK_KEYS])
    expect(c.checks.filter((x) => x.effective === 'warn' || x.effective === 'fail')).toEqual([])
    expect(c.progress.pct).toBe(100)
    expect(c.label).toBe('May 2026')
  })

  it('bank: open statement lines fail, unreconciled book entries only warn', () => {
    const f = clean()
    f.bank[0]!.unreconciled = [{ voucherId: 9, label: 'Payment 9', date: '2026-05-30', amount: 500_00 }]
    expect(status(buildCloseChecklist(f, { period: '2026-05', today: '2026-06-02' }), 'bank_reconciliation')).toBe('warn')
    f.bank[0]!.openStatementLines = [{ date: '2026-05-29', description: 'NEFT IN', amount: 900_00 }]
    const c = buildCloseChecklist(f, { period: '2026-05', today: '2026-06-02' })
    const b = c.checks.find((x) => x.key === 'bank_reconciliation')!
    expect(b.effective).toBe('fail')
    expect(b.amount).toBe(1400_00)
    expect(b.rows.map((r) => r.voucherId ?? null)).toEqual([null, 9])
  })

  it('GST: not prepared before the due date warns, after it fails; not regular → n/a', () => {
    const f = clean()
    f.gst = { gstr1ExportedAt: null, gstr3bExportedAt: '2026-06-18T00:00:00Z' }
    expect(status(buildCloseChecklist(f, { period: '2026-05', today: '2026-06-05' }), 'gst_returns')).toBe('warn')
    const late = buildCloseChecklist(f, { period: '2026-05', today: '2026-06-12' })
    expect(status(late, 'gst_returns')).toBe('fail')
    expect(late.checks.find((x) => x.key === 'gst_returns')!.dueDate).toBe('2026-06-11')
    f.gst = null
    expect(status(buildCloseChecklist(f, { period: '2026-05', today: '2026-06-12' }), 'gst_returns')).toBe('na')
  })

  it('TDS outstanding: warn before the 7th, fail after; March is due 30 April', () => {
    const f = clean()
    f.withholding = [{ kind: 'tds', ledgerId: 30, name: 'TDS Payable 194C', outstanding: 2000_00 }]
    expect(status(buildCloseChecklist(f, { period: '2026-05', today: '2026-06-06' }), 'withholding')).toBe('warn')
    expect(status(buildCloseChecklist(f, { period: '2026-05', today: '2026-06-08' }), 'withholding')).toBe('fail')
    const march = buildCloseChecklist(f, { period: '2026-03', today: '2026-04-20' })
    expect(march.checks.find((x) => x.key === 'withholding')!.dueDate).toBe('2026-04-30')
    expect(status(march, 'withholding')).toBe('warn')
  })

  it('depreciation: monthly pattern missing this month fails; yearly is fine until March', () => {
    const f = clean()
    f.depreciation = { assetsInService: 3, coveredThrough: '2026-04-30' }
    expect(status(buildCloseChecklist(f, { period: '2026-05', today: '2026-06-02' }), 'depreciation')).toBe('fail')
    f.depreciation = { assetsInService: 3, coveredThrough: null }
    expect(status(buildCloseChecklist(f, { period: '2026-05', today: '2026-06-02' }), 'depreciation')).toBe('ok')
    expect(status(buildCloseChecklist(f, { period: '2027-03', today: '2027-04-02' }), 'depreciation')).toBe('fail')
    f.depreciation = { assetsInService: 3, coveredThrough: '2026-05-31' }
    expect(status(buildCloseChecklist(f, { period: '2026-05', today: '2026-06-02' }), 'depreciation')).toBe('ok')
  })

  it('negative stock, suspense and unbalanced vouchers fail; drafts and narration warn', () => {
    const f = clean()
    f.negativeStock = [{ itemId: 4, name: 'Widget', qtyText: '-2 nos' }]
    f.suspense = [{ ledgerId: 50, name: 'Suspense', balance: -100_00 }]
    f.unbalanced = [{ voucherId: 7, label: 'Journal 7', date: '2026-05-03', amount: 1_00 }]
    f.drafts = [{ draftId: 3, summary: 'Payment of ₹500', date: '2026-05-10' }]
    f.blankNarration = [{ voucherId: 8, label: 'Payment 8', date: '2026-05-04', amount: 10_00 }]
    const c = buildCloseChecklist(f, { period: '2026-05', today: '2026-06-02' })
    expect(status(c, 'negative_stock')).toBe('fail')
    expect(status(c, 'suspense')).toBe('fail')
    expect(status(c, 'rounding')).toBe('fail')
    expect(status(c, 'drafts')).toBe('warn')
    expect(status(c, 'narration')).toBe('warn')
    expect(c.checks.find((x) => x.key === 'drafts')!.rows[0]).toMatchObject({ draftId: 3 })
    expect(c.checks.find((x) => x.key === 'suspense')!.rows[0]!.detail).toBe('balance ₹100.00 Cr')
    expect(c.progress).toMatchObject({ fail: 3, warn: 2 })
  })

  it('marks: done / n/a override the computed status and count as cleared', () => {
    const f = clean()
    f.negativeStock = [{ itemId: 4, name: 'Widget', qtyText: '-2 nos' }]
    f.lockDate = null
    const marks = new Map([
      ['negative_stock', { status: 'done' as const, note: 'GRN entered late', by: 'Priya', at: '2026-06-02T10:00:00Z' }],
      ['lock', { status: 'na' as const, note: null, by: 'Priya', at: '2026-06-02T10:00:00Z' }]
    ])
    const c = buildCloseChecklist(f, { period: '2026-05', today: '2026-06-02' }, marks)
    const n = c.checks.find((x) => x.key === 'negative_stock')!
    expect(n.status).toBe('fail')
    expect(n.effective).toBe('done')
    expect(status(c, 'lock')).toBe('na')
    expect(c.progress).toMatchObject({ pct: 100, done: 1, na: 2 })
  })

  it('caps the rows but keeps the count', () => {
    const f = clean()
    f.blankNarration = Array.from({ length: 130 }, (_, i) => ({ voucherId: i + 1, label: `Payment ${i + 1}`, date: '2026-05-04', amount: 100 }))
    const n = buildCloseChecklist(f, { period: '2026-05', today: '2026-06-02' }).checks.find((x) => x.key === 'narration')!
    expect(n.rows).toHaveLength(100)
    expect(n.more).toBe(30)
    expect(n.count).toBe(130)
  })

  it('progressOf rounds down', () => {
    expect(progressOf([{ effective: 'ok' }, { effective: 'warn' }, { effective: 'fail' }]).pct).toBe(33)
  })
})

describe('missingRegulars', () => {
  it('ledgers posted in each of the three previous months but not in this one', () => {
    const monthly = new Map([
      [1, new Map([['2026-02', 100], ['2026-03', 100], ['2026-04', 120]])], // rent: missing in May
      [2, new Map([['2026-03', 50], ['2026-04', 50]])], // only two months: not regular
      [3, new Map([['2026-02', 10], ['2026-03', 10], ['2026-04', 10], ['2026-05', 10]])] // present
    ])
    expect(missingRegulars('2026-05', monthly, new Map([[1, 'Rent'], [2, 'Repairs'], [3, 'Salary']]))).toEqual([{ ledgerId: 1, name: 'Rent', lastMonth: '2026-04', lastAmount: 120 }])
  })
})
