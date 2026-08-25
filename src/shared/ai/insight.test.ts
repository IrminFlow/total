import { describe, it, expect } from 'vitest'
import { GST_ISSUE_EXPLANATIONS, explainIssues, summariseIssues } from './gstExplain'
import { closeChecklist, type CloseInputs } from './closeCheck'
import { findAnomalies, madZScore, type HistoryEntry } from './anomaly'
import { formatPaise } from '../money'
import type { GstIssue } from '../gst/validate'

describe('GST issue explanations', () => {
  it('covers every code the validator can raise', () => {
    // The Record type makes this a compile error too; the test states the intent for a reader,
    // and catches a code added with a placeholder rather than an explanation.
    for (const [code, explanation] of Object.entries(GST_ISSUE_EXPLANATIONS)) {
      expect(explanation.what.length, code).toBeGreaterThan(20)
      expect(explanation.why.length, code).toBeGreaterThan(20)
      expect(explanation.fix.length, code).toBeGreaterThan(10)
      expect(explanation.checked, code).toMatch(/^\d{4}-\d{2}$/)
    }
  })

  it('cites the provision where the rule has one', () => {
    expect(GST_ISSUE_EXPLANATIONS.zero_rated_intra_tax.why).toMatch(/7\(5\)\(b\)/)
    expect(GST_ISSUE_EXPLANATIONS.hsn_too_short.why).toMatch(/[Rr]ule 46/)
    expect(GST_ISSUE_EXPLANATIONS.composition.why).toMatch(/CMP-08/)
  })

  it('puts blocking issues first and attaches the written explanation', () => {
    const issues: GstIssue[] = [
      { code: 'hsn_too_short', severity: 'warning', message: 'w', voucherIds: [] },
      { code: 'missing_hsn', severity: 'blocking', message: 'b', voucherIds: [1] }
    ]
    const explained = explainIssues(issues)
    expect(explained[0]!.code).toBe('missing_hsn')
    expect(explained[0]!.explanation.fix).toMatch(/HSN/)
  })

  it('summarises a period in one sentence, computed from the counts', () => {
    expect(summariseIssues([])).toMatch(/Nothing is blocking/)
    expect(
      summariseIssues([
        { code: 'missing_hsn', severity: 'blocking', message: '', voucherIds: [] },
        { code: 'b2cl_edge', severity: 'warning', message: '', voucherIds: [] }
      ])
    ).toBe('1 issue blocking the export and 1 warning. Blocking issues must be cleared before the return can be exported.')
  })
})

describe('month-end close checklist', () => {
  const clean: CloseInputs = {
    from: '2026-07-01',
    to: '2026-07-31',
    unbalancedVouchers: 0,
    negativeStockItems: 0,
    unreconciledBankLines: 0,
    bankLedgers: 1,
    gstBlockingIssues: 0,
    gstWarnings: 0,
    pendingApprovals: 0,
    recurringDue: 0,
    suspensePaise: 0,
    lastBackupDaysAgo: 1,
    lockedUpTo: '2026-07-31',
    overdue90Paise: 0,
    payrollPosted: true,
    money: formatPaise
  }

  it('passes a clean month', () => {
    const list = closeChecklist(clean)
    expect(list.blocked).toBe(0)
    expect(list.attention).toBe(0)
    expect(list.readyToLock).toBe(true)
  })

  it('blocks on an unbalanced voucher — every report is computed from those lines', () => {
    const list = closeChecklist({ ...clean, unbalancedVouchers: 2 })
    expect(list.readyToLock).toBe(false)
    expect(list.items.find((i) => i.id === 'unbalanced')).toMatchObject({ status: 'blocked', detail: '2 unbalanced' })
  })

  it('blocks a month that has never been backed up', () => {
    expect(closeChecklist({ ...clean, lastBackupDaysAgo: null }).readyToLock).toBe(false)
  })

  it('skips rather than fails the checks whose feature is off', () => {
    const list = closeChecklist({ ...clean, payrollPosted: null, bankLedgers: 0 })
    expect(list.items.find((i) => i.id === 'payroll')?.status).toBe('skipped')
    expect(list.items.find((i) => i.id === 'bank')?.status).toBe('skipped')
    expect(list.readyToLock).toBe(true)
  })

  it('raises attention, not a block, for the judgement calls', () => {
    const list = closeChecklist({ ...clean, suspensePaise: 500_000, overdue90Paise: 100_000, recurringDue: 1 })
    expect(list.readyToLock).toBe(true)
    expect(list.attention).toBe(3)
    expect(list.items.find((i) => i.id === 'suspense')?.detail).toContain('5,000.00')
  })

  it('gives every item a reason a first-time closer can read', () => {
    for (const item of closeChecklist(clean).items) {
      expect(item.why.length, item.id).toBeGreaterThan(30)
    }
  })
})

describe('anomaly watch', () => {
  const money = formatPaise
  const history = (amounts: number[], partyLedgerId: number | null = 2): HistoryEntry[] =>
    amounts.map((amountPaise, i) => ({
      voucherId: i + 1,
      date: `2026-0${(i % 6) + 1}-10`,
      voucherTypeId: 1,
      partyLedgerId,
      amountPaise
    }))

  it('uses a median so one past outlier does not hide the next one', () => {
    // A mean over these is dragged upward by the 50 lakh; the median is not.
    const amounts = [2_000_000, 2_100_000, 1_900_000, 2_050_000, 2_000_000, 1_950_000, 500_000_000]
    expect(madZScore(amounts, 45_000_000)).toBeGreaterThan(3.5)
  })

  it('says nothing on too little history to say anything', () => {
    expect(madZScore([100, 200], 900_000)).toBe(0)
    // Two past payments to this party is not a distribution; a huge third one is not yet a fact
    // about anything. (It is still a first-time party for nobody, so nothing is flagged.)
    const candidate: HistoryEntry = { voucherId: 99, date: '2026-08-01', voucherTypeId: 1, partyLedgerId: 2, amountPaise: 80_000_000 }
    expect(findAnomalies(history([2_000_000, 2_100_000]), [candidate], { money })).toEqual([])
  })

  it('flags an amount far outside what this party has ever been paid, and shows the comparison', () => {
    const past = history([2_000_000, 2_100_000, 1_900_000, 2_050_000, 2_000_000, 1_950_000])
    const candidate: HistoryEntry = { voucherId: 99, date: '2026-08-01', voucherTypeId: 1, partyLedgerId: 2, amountPaise: 45_000_000 }
    const [finding] = findAnomalies(past, [candidate], { money })
    expect(finding?.reasons).toContain('amount-outlier')
    expect(finding?.explanation).toContain('4,50,000.00')
    expect(finding?.explanation).toContain('20,000.00')
  })

  it('flags a party never seen before', () => {
    const past = history([2_000_000, 2_100_000, 1_900_000, 2_050_000, 2_000_000, 1_950_000], 2)
    const candidate: HistoryEntry = { voucherId: 99, date: '2026-08-01', voucherTypeId: 1, partyLedgerId: 7, amountPaise: 2_000_000 }
    expect(findAnomalies(past, [candidate], { money })[0]?.reasons).toContain('first-time-party')
  })

  it('flags the same amount to the same party days apart', () => {
    const past = history([2_000_000, 2_100_000, 1_900_000, 2_050_000, 2_000_000, 1_950_000])
    const twin: HistoryEntry = { voucherId: 50, date: '2026-08-01', voucherTypeId: 1, partyLedgerId: 2, amountPaise: 2_000_000 }
    const candidate: HistoryEntry = { ...twin, voucherId: 51, date: '2026-08-02' }
    expect(findAnomalies([...past, twin], [candidate], { money })[0]?.reasons).toContain('possible-duplicate')
  })

  it('ignores small amounts — a ₹200 outlier is noise, not a finding', () => {
    const past = history([100, 110, 90, 105, 100, 95])
    const candidate: HistoryEntry = { voucherId: 99, date: '2026-08-01', voucherTypeId: 1, partyLedgerId: 2, amountPaise: 90_000 }
    expect(findAnomalies(past, [candidate], { money })).toEqual([])
  })

  it('leaves an ordinary entry alone', () => {
    const past = history([2_000_000, 2_100_000, 1_900_000, 2_050_000, 2_000_000, 1_950_000])
    const candidate: HistoryEntry = { voucherId: 99, date: '2026-08-01', voucherTypeId: 1, partyLedgerId: 2, amountPaise: 2_020_000 }
    expect(findAnomalies(past, [candidate], { money })).toEqual([])
  })
})
