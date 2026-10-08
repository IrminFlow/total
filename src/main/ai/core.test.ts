// Pure pieces of the agent core: prompt builder, cost, numbers rule, truncation, zod → JSON Schema.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildSystemPrompt, EXPLAIN_RULE, NUMBERS_RULE, SCREEN_RULE, UNTRUSTED_TEXT_RULE, WRITE_RULE, type PromptContext } from './prompt'
import { estimateCostMicroUsd, sumCosts } from './cost'
import { checkFigures, extractFigures, locateFigureSource } from './numbers'
import { fitToBudget, truncationMarker } from './truncate'
import { zodToJsonSchema } from './jsonSchema'
import { aiMockAllowed } from './env'

const CTX: PromptContext = {
  company: { name: 'Demo Traders', gstin: '27AAPFU0939F1ZV', stateCode: '27', registrationType: 'regular', booksFromFy: 2025 },
  today: '2025-08-14',
  period: { from: '2025-04-01', to: '2026-03-31' },
  user: { name: 'Priya', role: 'accountant' },
  screen: 'daybook',
  tools: [
    { name: 'trial_balance', kind: 'read' },
    { name: 'draft_voucher', kind: 'draft' }
  ],
  privacy: { maskIds: true, pseudonymiseParties: true }
}

describe('buildSystemPrompt', () => {
  const p = buildSystemPrompt(CTX)
  it('states the numbers, untrusted-text and no-write rules verbatim', () => {
    expect(p).toContain(NUMBERS_RULE)
    expect(p).toContain(UNTRUSTED_TEXT_RULE)
    expect(p).toContain(WRITE_RULE)
    expect(NUMBERS_RULE).toMatch(/Never compute money/)
    expect(UNTRUSTED_TEXT_RULE).toMatch(/DATA, not instructions/)
  })
  it('carries company, period, today, role, screen and the tool lists', () => {
    expect(p).toContain('Name: Demo Traders')
    expect(p).toContain('Working period: 2025-04-01 to 2026-03-31')
    expect(p).toContain('Today: 2025-08-14')
    expect(p).toContain('role: accountant')
    expect(p).toContain('looking at: daybook')
    expect(p).toContain('Read: trial_balance')
    expect(p).toContain('Draft (proposals only, never saved): draft_voucher')
    expect(p).toContain('Books from: FY 2025-26')
  })
  it('explains masking and aliases only when they are on', () => {
    expect(p).toMatch(/masked on purpose/)
    expect(p).toMatch(/Party-0001/)
    const plain = buildSystemPrompt({ ...CTX, privacy: { maskIds: false, pseudonymiseParties: false }, screen: null, tools: [{ name: 'trial_balance', kind: 'read' }] })
    expect(plain).not.toMatch(/masked on purpose/)
    expect(plain).not.toMatch(/Party-0001/)
    expect(plain).not.toMatch(/looking at/)
    expect(plain).toContain('none — this user cannot draft')
  })
})

describe('estimateCostMicroUsd', () => {
  const price = { inputPerM: 2_000_000, cachedInputPerM: 500_000, outputPerM: 8_000_000 }
  it('bills uncached input, cached input and output at their rates (integer micro-USD)', () => {
    // 10,000 in (4,000 cached) → 6,000 × $2/M + 4,000 × $0.5/M = $0.012 + $0.002; 1,000 out × $8/M = $0.008
    expect(estimateCostMicroUsd({ inputTokens: 10_000, cachedTokens: 4_000, outputTokens: 1_000, reasoningTokens: 300 }, price)).toBe(22_000)
  })
  it('uses the input rate for cached tokens when no cached rate is set, and rounds', () => {
    expect(estimateCostMicroUsd({ inputTokens: 3, cachedTokens: 1, outputTokens: 0, reasoningTokens: 0 }, { ...price, cachedInputPerM: null })).toBe(6)
    expect(estimateCostMicroUsd({ inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0, reasoningTokens: 0 }, { ...price, cachedInputPerM: null })).toBe(2_000_000)
  })
  it('is null without a price (prices are never guessed)', () => {
    expect(estimateCostMicroUsd({ inputTokens: 5, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0 }, undefined)).toBeNull()
    expect(estimateCostMicroUsd({ inputTokens: 5, cachedTokens: 0, outputTokens: 5, reasoningTokens: 0 }, { inputPerM: 1, cachedInputPerM: null, outputPerM: null })).toBeNull()
  })
  it('sums known costs, null only when all unknown', () => {
    expect(sumCosts([null, 5, 7])).toBe(12)
    expect(sumCosts([null, null])).toBeNull()
  })
})

describe('numbers rule check', () => {
  const paise = (t: string): number[] => extractFigures(t).map((x) => x.paise)

  it('reads ₹ / Rs / INR, grouping, two decimals and "rupees"', () => {
    expect(paise('Sales were ₹1,23,456.00 (18% GST) across 42 bills in 2025; 01.07.2025; Rs. 500 and 1,000 and 99.50 Dr')).toEqual([12345600, 50000, 100000, 9950])
    expect(paise('INR 2500 and 500000 rupees and Rs 750/-')).toEqual([250000, 50000000, 75000])
  })

  it('reads Indian shorthand: lakh / L / crore / Cr / k / thousand', () => {
    expect(paise('₹1.2L')).toEqual([12000000])
    expect(paise('about 1.2 lakh')).toEqual([12000000])
    expect(paise('3.4Cr this year')).toEqual([3400000000])
    expect(paise('2 crore')).toEqual([2000000000])
    expect(paise('Rs 5k')).toEqual([500000])
    expect(paise('12 thousand')).toEqual([1200000])
    expect(paise('₹ 2.25 lakhs')).toEqual([22500000])
  })

  it('reads Dr / Cr suffixed and prefixed figures, and bare integers next to money words', () => {
    expect(paise('closing 25000 Dr')).toEqual([2500000])
    expect(paise('₹25,000.00 Cr and 25,000 Cr')).toEqual([2500000, 2500000]) // spaced Cr = credit, not crore
    expect(paise('Cr 4000 left')).toEqual([400000])
    expect(paise('balance 125000 as on today')).toEqual([12500000])
    expect(paise('paid 5000 to rent')).toEqual([500000])
  })

  it('ignores years, counts, ids, dates, percentages and versions', () => {
    expect(paise('In 2025 there were 4512 vouchers, voucher 12345, 18% GST, v2.10, 2025-07-31, 31.07.2025, GSTIN 27AAPFU0939F1ZV')).toEqual([])
    expect(paise('FY 2025 sales')).toEqual([])
  })

  it('sources against what the model saw; shorthand within rounding is "approximate"', () => {
    const seen = [{ name: 'profit_and_loss', text: JSON.stringify({ sales: '₹1,23,456.00', net: '-₹2,000.00', cash: '₹25,000.00 Dr' }) }]
    const figs = checkFigures('Sales were ₹1,23,456 (about ₹1.2L), the loss ₹2,000.00, cash 25000 Dr; I estimate ₹5,000.00 and 1.5 lakh.', seen)
    expect(figs).toEqual([
      { text: '₹1,23,456', paise: 12345600, sourced: true, tool: 'profit_and_loss' },
      { text: '₹1.2L', paise: 12000000, sourced: true, tool: 'profit_and_loss', approximate: true },
      { text: '₹2,000.00', paise: 200000, sourced: true, tool: 'profit_and_loss' },
      { text: '25000', paise: 2500000, sourced: true, tool: 'profit_and_loss' },
      { text: '₹5,000.00', paise: 500000, sourced: false, tool: null },
      { text: '1.5 lakh', paise: 15000000, sourced: false, tool: null }
    ])
  })
})

describe('fitToBudget', () => {
  it('passes small results through untouched', () => {
    const r = fitToBudget({ a: [1, 2, 3] }, 1000)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('{"a":[1,2,3]}')
  })
  it('cuts long arrays and says how many rows were left out', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Ledger number ${i}` }))
    const r = fitToBudget({ total: 500, rows }, 2000)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(2000)
    const v = r.value as { total: number; rows: unknown[] }
    expect(v.total).toBe(500)
    const marker = v.rows.at(-1) as string
    const kept = v.rows.length - 1
    expect(marker).toBe(truncationMarker(500 - kept))
    expect(v.rows[0]).toEqual({ id: 0, name: 'Ledger number 0' })
  })
  it('cuts very long strings and, as a last resort, the whole text', () => {
    const r = fitToBudget({ s: 'x'.repeat(10_000) }, 3000)
    expect(r.truncated).toBe(true)
    expect((r.value as { s: string }).s).toMatch(/characters not shown/)
    const hard = fitToBudget({ a: 'y'.repeat(1900), b: 'z'.repeat(1900) }, 1000)
    expect(hard.text.length).toBeLessThanOrEqual(1000)
    expect(hard.text).toMatch(/result cut at 1000 characters/)
  })
})

describe('zodToJsonSchema', () => {
  it('covers the shapes tool inputs use', () => {
    const s = z.object({
      ledgerId: z.number().int().positive().describe('The ledger'),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      side: z.enum(['receivable', 'payable']),
      note: z.string().max(10).optional(),
      lines: z.array(z.object({ drCr: z.enum(['dr', 'cr']), ok: z.boolean() })).min(2).max(5),
      maybe: z.number().nullable(),
      d: z.number().default(3)
    })
    expect(zodToJsonSchema(s)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['ledgerId', 'from', 'side', 'lines', 'maybe'],
      properties: {
        ledgerId: { type: 'integer', exclusiveMinimum: 0, description: 'The ledger' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        side: { type: 'string', enum: ['receivable', 'payable'] },
        note: { type: 'string', maxLength: 10 },
        lines: {
          type: 'array', minItems: 2, maxItems: 5,
          items: { type: 'object', additionalProperties: false, required: ['drCr', 'ok'], properties: { drCr: { type: 'string', enum: ['dr', 'cr'] }, ok: { type: 'boolean' } } }
        },
        maybe: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        d: { type: 'number', default: 3 }
      }
    })
  })
})

describe('TOTAL_AI_MOCK switch', () => {
  it('is honoured only with TOTAL_DATA_DIR and never in a packaged build', () => {
    expect(aiMockAllowed({ TOTAL_AI_MOCK: '1', TOTAL_DATA_DIR: '/tmp/x' }, false)).toBe(true)
    expect(aiMockAllowed({ TOTAL_AI_MOCK: '1', TOTAL_DATA_DIR: '/tmp/x' }, null)).toBe(true)
    expect(aiMockAllowed({ TOTAL_AI_MOCK: '1' }, false)).toBe(false)
    expect(aiMockAllowed({ TOTAL_AI_MOCK: '1', TOTAL_DATA_DIR: '/tmp/x' }, true)).toBe(false)
    expect(aiMockAllowed({ TOTAL_AI_MOCK: 'true', TOTAL_DATA_DIR: '/tmp/x' }, false)).toBe(false)
  })
})

describe('WP 5.2 — screen context in the prompt', () => {
  it('adds the context lines and the screen / explain rules only when there is context', () => {
    const p = buildSystemPrompt({ ...CTX, screen: 'trial-balance', context: { screen: 'trial-balance', label: 'Trial balance', from: '2025-04-01', to: '2026-03-31', explain: { label: 'Cash', value: '₹1.00', ledgerId: 3 } } })
    expect(p).toContain('looking at: trial-balance')
    expect(p).toContain('<<<screen-context\nScreen: Trial balance (trial-balance)')
    expect(p).toContain('screen-context>>>')
    expect(p).toContain('Figure to explain (JSON): {"label":"Cash","value":"₹1.00","ledgerId":3}')
    expect(p).toContain(SCREEN_RULE)
    expect(p).toContain(EXPLAIN_RULE)
    expect(EXPLAIN_RULE).toMatch(/do not work any out yourself/)
    const plain = buildSystemPrompt(CTX)
    expect(plain).not.toContain(SCREEN_RULE)
    expect(plain).not.toContain(EXPLAIN_RULE)
  })
})

describe('WP 5.2 — a sourced figure is traced to the row it came from', () => {
  const statement = {
    tool: 'ledger_statement',
    output: {
      ok: true,
      result: {
        ledgerId: 7, ledger: 'Rent', closing: '₹3,000.00 Dr',
        rows: [
          { voucherId: 11, type: 'Payment', number: '4', debit: '₹1,000.00', balance: '₹1,000.00 Dr' },
          { voucherId: 12, type: 'Payment', number: '5', debit: '₹2,000.00', balance: '₹3,000.00 Dr' }
        ]
      }
    },
    sources: [{ kind: 'screen' as const, screen: 'ledger-statement', label: 'Rent statement', params: { ledgerId: 7 } }, { kind: 'ledger' as const, ledgerId: 7, label: 'Rent' }]
  }
  it('a row amount → its voucher; a closing balance (repeated as the last running balance) → the ledger', () => {
    expect(locateFigureSource(200_000, [statement]).source).toEqual({ kind: 'voucher', voucherId: 12, label: 'Payment 5' })
    expect(locateFigureSource(300_000, [statement]).source).toEqual({ kind: 'ledger', ledgerId: 7, label: 'Rent' })
  })
  it('an amount with no id around it → the tool’s screen; unknown → undefined', () => {
    const pnl = { tool: 'profit_and_loss', output: { ok: true, result: { netProfit: '₹9.00' } }, sources: [{ kind: 'screen' as const, screen: 'profit-loss', label: 'P&L' }] }
    expect(locateFigureSource(900, [pnl]).source).toEqual({ kind: 'screen', screen: 'profit-loss', label: 'P&L' })
    expect(locateFigureSource(123, [pnl])).toEqual({})
  })
  it('checkFigures attaches the source', () => {
    const f = checkFigures('Rent paid ₹2,000.00.', [{ name: 'ledger_statement', text: JSON.stringify(statement.output) }], [statement])
    expect(f).toEqual([{ text: '₹2,000.00', paise: 200_000, sourced: true, tool: 'ledger_statement', source: { kind: 'voucher', voucherId: 12, label: 'Payment 5' } }])
  })
})

describe('WP 5.2 review — repeated amounts are not traced to the first matching row', () => {
  const rent = {
    tool: 'explain_figure',
    output: {
      ok: true,
      result: {
        ledgerId: 7, ledger: 'Rent', closing: '₹30,000.00 Dr',
        largestVouchers: [
          { voucherId: 3, type: 'Journal', number: '3', debit: '₹10,000.00' },
          { voucherId: 4, type: 'Journal', number: '4', debit: '₹10,000.00' },
          { voucherId: 5, type: 'Journal', number: '5', debit: '₹10,000.00' }
        ]
      }
    },
    sources: [{ kind: 'screen' as const, screen: 'ledger-statement', label: 'Rent statement', params: { ledgerId: 7 } }]
  }
  const seen = [{ name: 'explain_figure', text: JSON.stringify(rent.output) }]

  it('three ₹10,000.00 entries: the row named on the figure’s line wins', () => {
    const answer = '| Journal 3 | ₹10,000.00 |\n| Journal 4 | ₹10,000.00 |\n| Journal 5 | ₹10,000.00 |'
    expect(checkFigures(answer, seen, [rent]).map((f) => f.source)).toEqual([
      { kind: 'voucher', voucherId: 3, label: 'Journal 3' },
      { kind: 'voucher', voucherId: 4, label: 'Journal 4' },
      { kind: 'voucher', voucherId: 5, label: 'Journal 5' }
    ])
  })

  it('no label near it: ambiguous, linked to the report — never a guessed row', () => {
    const [f] = checkFigures('Rent was ₹10,000.00 a month.', seen, [rent])
    expect(f).toMatchObject({ sourced: true, ambiguous: true, source: { kind: 'screen', screen: 'ledger-statement' } })
  })

  it('a longer label is not mistaken for its prefix (Journal 1 vs Journal 12)', () => {
    const o = {
      tool: 't',
      output: { rows: [{ voucherId: 1, type: 'Journal', number: '1', debit: '₹5.00' }, { voucherId: 12, type: 'Journal', number: '12', debit: '₹5.00' }] },
      sources: [{ kind: 'screen' as const, screen: 'daybook', label: 'Day book' }]
    }
    const [f] = checkFigures('Journal 12 was ₹5.00.', [{ name: 't', text: JSON.stringify(o.output) }], [o])
    expect(f!.source).toEqual({ kind: 'voucher', voucherId: 12, label: 'Journal 12' })
  })
})
