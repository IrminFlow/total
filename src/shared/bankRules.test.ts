import { describe, it, expect } from 'vitest'
import { matchRules, suggestPattern, type RuleRow, type StatementLike } from './bankRules'

const deposit = (description: string, amount: number): StatementLike => ({ description, deposit: amount, withdrawal: 0 })
const withdrawal = (description: string, amount: number): StatementLike => ({ description, deposit: 0, withdrawal: amount })

describe('matchRules', () => {
  it('matches case-insensitively', () => {
    const rules: RuleRow[] = [{ id: 1, pattern: 'acme supplies', ledgerId: 10, kind: 'payment' }]
    const rows = [withdrawal('ACME SUPPLIES LTD PAYMENT', 5000)]
    const result = matchRules(rows, rules)
    expect(result).toHaveLength(1)
    expect(result[0]!.rule.id).toBe(1)
  })

  it('deposits only match receipt rules; withdrawals only match payment rules', () => {
    const rules: RuleRow[] = [
      { id: 1, pattern: 'acme', ledgerId: 10, kind: 'payment' },
      { id: 2, pattern: 'acme', ledgerId: 20, kind: 'receipt' }
    ]
    const depositResult = matchRules([deposit('ACME REFUND', 1000)], rules)
    expect(depositResult).toHaveLength(1)
    expect(depositResult[0]!.rule.id).toBe(2)

    const withdrawalResult = matchRules([withdrawal('ACME INVOICE', 1000)], rules)
    expect(withdrawalResult).toHaveLength(1)
    expect(withdrawalResult[0]!.rule.id).toBe(1)
  })

  it('among matching rules the longest pattern wins', () => {
    const rules: RuleRow[] = [
      { id: 1, pattern: 'acme', ledgerId: 10, kind: 'payment' },
      { id: 2, pattern: 'acme supplies', ledgerId: 20, kind: 'payment' }
    ]
    const result = matchRules([withdrawal('ACME SUPPLIES LTD', 1000)], rules)
    expect(result).toHaveLength(1)
    expect(result[0]!.rule.id).toBe(2)
  })

  it('rows with no matching rule are excluded from the output', () => {
    const rules: RuleRow[] = [{ id: 1, pattern: 'acme', ledgerId: 10, kind: 'payment' }]
    const rows = [withdrawal('UNKNOWN VENDOR', 1000), withdrawal('ACME SUPPLIES', 2000)]
    const result = matchRules(rows, rules)
    expect(result).toHaveLength(1)
    expect(result[0]!.row.description).toBe('ACME SUPPLIES')
  })

  it('inactive rules never match', () => {
    const rules: RuleRow[] = [{ id: 1, pattern: 'acme', ledgerId: 10, kind: 'payment', active: false }]
    const result = matchRules([withdrawal('ACME SUPPLIES', 1000)], rules)
    expect(result).toHaveLength(0)
  })
})

describe('suggestPattern', () => {
  it('strips a leading NEFT reference and a trailing date, keeping the vendor name', () => {
    expect(suggestPattern('NEFT-000123 ACME SUPPLIES 15/08')).toBe('ACME SUPPLIES')
  })

  it('strips an RTGS reference token generically (same digit-token rule, no RTGS special-casing)', () => {
    expect(suggestPattern('RTGS-000456 GLOBAL TRADERS 20/08')).toBe('GLOBAL TRADERS')
  })

  it('strips leading/trailing dash and slash noise around otherwise-alpha tokens', () => {
    expect(suggestPattern('NEFT-000123 -ACME- SUPPLIES/ 15/08')).toBe('ACME SUPPLIES')
  })

  it('returns the longest run when multiple alpha runs remain', () => {
    expect(suggestPattern('AB 12345 ACME GLOBAL SUPPLIES 67890 XY')).toBe('ACME GLOBAL SUPPLIES')
  })

  it('collapses to empty string when nothing alpha remains', () => {
    expect(suggestPattern('000123 15/08/2026')).toBe('')
  })
})
