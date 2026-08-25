import { describe, it, expect } from 'vitest'
import { describeDraft, draftTotals, reviewDraft, type VoucherDraftProposal } from './draft'

const LEDGERS = new Map([
  [1, 'Cash'],
  [2, 'Sharma Traders'],
  [3, 'Rent']
])

const ctx = { today: '2026-08-24', knownLedgers: LEDGERS }

function proposal(over: Partial<VoucherDraftProposal> = {}): VoucherDraftProposal {
  return {
    kind: 'payment',
    date: '2026-08-20',
    narration: 'March rent',
    lines: [
      { ledgerId: 3, ledgerName: 'Rent', drCr: 'dr', amountPaise: 1_250_000 },
      { ledgerId: 1, ledgerName: 'Cash', drCr: 'cr', amountPaise: 1_250_000 }
    ],
    ...over
  }
}

describe('draft review', () => {
  it('passes a balanced, well-formed draft', () => {
    const review = reviewDraft(proposal(), ctx)
    expect(review.issues).toEqual([])
    expect(review.balanced).toBe(true)
    expect(review.openable).toBe(true)
  })

  it('blocks a draft that does not balance, and says by how much', () => {
    const review = reviewDraft(
      proposal({
        lines: [
          { ledgerId: 3, ledgerName: 'Rent', drCr: 'dr', amountPaise: 1_250_000 },
          { ledgerId: 1, ledgerName: 'Cash', drCr: 'cr', amountPaise: 1_200_000 }
        ]
      }),
      ctx
    )
    expect(review.openable).toBe(false)
    expect(review.issues.map((i) => i.message).join(' ')).toMatch(/out by 500\.00/)
  })

  it('refuses a fractional amount rather than rounding it', () => {
    // A silently rounded draft is a rounding error somebody signs.
    const review = reviewDraft(
      proposal({
        lines: [
          { ledgerId: 3, ledgerName: 'Rent', drCr: 'dr', amountPaise: 416_666.67 },
          { ledgerId: 1, ledgerName: 'Cash', drCr: 'cr', amountPaise: 416_666.67 }
        ]
      }),
      ctx
    )
    expect(review.openable).toBe(false)
    expect(review.issues.some((i) => /whole number of paise/.test(i.message))).toBe(true)
  })

  it('blocks a ledger the model invented', () => {
    const review = reviewDraft(
      proposal({
        lines: [
          { ledgerId: 99, ledgerName: 'Marketing', drCr: 'dr', amountPaise: 100 },
          { ledgerId: 1, ledgerName: 'Cash', drCr: 'cr', amountPaise: 100 }
        ]
      }),
      ctx
    )
    expect(review.issues.some((i) => /does not exist/.test(i.message))).toBe(true)
  })

  it('warns when a real id is labelled with the wrong name — the sign of a mismatched party', () => {
    const review = reviewDraft(
      proposal({
        lines: [
          { ledgerId: 2, ledgerName: 'Verma Traders', drCr: 'dr', amountPaise: 100 },
          { ledgerId: 1, ledgerName: 'Cash', drCr: 'cr', amountPaise: 100 }
        ]
      }),
      ctx
    )
    expect(review.openable).toBe(true)
    expect(review.issues).toEqual([
      { severity: 'warning', message: 'Ledger 2 is "Sharma Traders", not "Verma Traders".' }
    ])
  })

  it('blocks a draft dated into locked books', () => {
    const review = reviewDraft(proposal(), { ...ctx, lockedUpTo: '2026-08-31' })
    expect(review.openable).toBe(false)
    expect(review.issues.some((i) => /locked/.test(i.message))).toBe(true)
  })

  it('warns but allows a future date — a post-dated cheque is legitimate', () => {
    const review = reviewDraft(proposal({ date: '2026-09-01' }), ctx)
    expect(review.openable).toBe(true)
    expect(review.issues.some((i) => i.severity === 'warning' && /future/.test(i.message))).toBe(true)
  })

  it('blocks a one-sided draft and a negative amount', () => {
    const single = reviewDraft(
      proposal({ lines: [{ ledgerId: 1, ledgerName: 'Cash', drCr: 'dr', amountPaise: 100 }] }),
      ctx
    )
    expect(single.openable).toBe(false)
    const negative = reviewDraft(
      proposal({
        lines: [
          { ledgerId: 3, ledgerName: 'Rent', drCr: 'dr', amountPaise: -100 },
          { ledgerId: 1, ledgerName: 'Cash', drCr: 'cr', amountPaise: -100 }
        ]
      }),
      ctx
    )
    expect(negative.openable).toBe(false)
  })

  it('rejects a kind Total does not have', () => {
    const review = reviewDraft(proposal({ kind: 'invoice' as never }), ctx)
    expect(review.openable).toBe(false)
  })
})

describe('draft description', () => {
  it('is built from the same object the button opens, so the two cannot disagree', () => {
    expect(describeDraft(proposal())).toBe('payment on 2026-08-20: 12,500.00, Rent to Cash')
  })

  it('totals each side independently', () => {
    expect(draftTotals(proposal().lines)).toEqual({ debit: 1_250_000, credit: 1_250_000 })
  })
})
