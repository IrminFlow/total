import { describe, it, expect } from 'vitest'
import { parseWindow, resolveAsk } from './askbar'

const TODAY = '2026-08-24' // a Monday in FY 2026-27, Q2

describe('deterministic ask resolution', () => {
  it('routes the questions people actually type to the report that answers them', () => {
    const cases: [string, string][] = [
      ['who owes me', 'outstandings'],
      ['trial balance', 'trial-balance'],
      ['show me the p&l', 'profit-loss'],
      ['balance sheet', 'balance-sheet'],
      ['cash flow', 'cash-flow'],
      ['what is blocking gstr-1', 'gstr1'],
      ['gstr 3b', 'gstr3b'],
      ['day book', 'daybook'],
      ['bank reconciliation', 'banking'],
      ['depreciation', 'assets'],
      ['payslips', 'payroll']
    ]
    for (const [question, screen] of cases) {
      expect(resolveAsk(question, TODAY)?.screen, question).toBe(screen)
    }
  })

  it('knows which side of the outstandings a question is about', () => {
    expect(resolveAsk('who owes me the most', TODAY)?.side).toBe('receivable')
    expect(resolveAsk('what do i owe my creditors', TODAY)?.side).toBe('payable')
  })

  it('hands anything asking for a reason to the assistant, report name or not', () => {
    // The screen is not an answer to "why". This is the ordering the whole module is about.
    expect(resolveAsk('why is my cash flow worse than last month', TODAY)).toBeNull()
    expect(resolveAsk('explain the trial balance', TODAY)).toBeNull()
    expect(resolveAsk('is this payment unusual', TODAY)).toBeNull()
  })

  it('refuses an ambiguous question rather than guessing between two reports', () => {
    // "stock" and "sales register" both fire; a silently wrong report is the worst outcome.
    expect(resolveAsk('sales register and stock', TODAY)).toBeNull()
  })

  it('says nothing about a question it has no report for', () => {
    expect(resolveAsk('should I buy a delivery van', TODAY)).toBeNull()
    expect(resolveAsk('hi', TODAY)).toBeNull()
  })
})

describe('period parsing', () => {
  it('reads the ordinary relative windows', () => {
    expect(parseWindow('day book today', TODAY)).toEqual({ from: TODAY, to: TODAY, label: 'Today' })
    expect(parseWindow('day book yesterday', TODAY)).toMatchObject({ from: '2026-08-23', to: '2026-08-23' })
    expect(parseWindow('this month', TODAY)).toMatchObject({ from: '2026-08-01', to: '2026-08-31' })
    expect(parseWindow('last month', TODAY)).toMatchObject({ from: '2026-07-01', to: '2026-07-31' })
  })

  it('rolls a January "last month" back into the previous calendar year', () => {
    expect(parseWindow('last month', '2026-01-15')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('uses financial-year quarters, because that is the only quarter this user means', () => {
    // August 2026 is Q2 of FY 2026-27: July to September.
    expect(parseWindow('this quarter', TODAY)).toMatchObject({ from: '2026-07-01', to: '2026-09-30' })
    expect(parseWindow('last quarter', TODAY)).toMatchObject({ from: '2026-04-01', to: '2026-06-30' })
  })

  it('rolls "last quarter" in Q1 back into the previous financial year', () => {
    expect(parseWindow('last quarter', '2026-05-10')).toMatchObject({ from: '2026-01-01', to: '2026-03-31' })
  })

  it('reads the financial year, not the calendar year', () => {
    expect(parseWindow('this year', TODAY)).toMatchObject({ from: '2026-04-01', to: '2027-03-31' })
    expect(parseWindow('last financial year', TODAY)).toMatchObject({ from: '2025-04-01', to: '2026-03-31' })
  })

  it('reads a named month as the most recent one that has happened', () => {
    expect(parseWindow('sales in march', TODAY)).toMatchObject({ from: '2026-03-01', to: '2026-03-31' })
    // December has not happened yet in August 2026, so it means last December.
    expect(parseWindow('sales in december', TODAY)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('labels the window it found, so the palette row says which month it will open', () => {
    const match = resolveAsk('day book last month', TODAY)
    expect(match?.span).toMatchObject({ from: '2026-07-01' })
    expect(match?.label).toContain('Last month')
  })
})
