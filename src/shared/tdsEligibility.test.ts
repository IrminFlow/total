import { describe, it, expect } from 'vitest'
import {
  addTdsToLines, candidateSections, classifyTdsVoucher, priorAggregate, removeTdsFromLines, tdsTargetIndex, undeductedCreditsBefore,
  walkTdsEvents, type TdsLedgerFacts, type WalkEvent
} from './tdsEligibility'
import type { TdsRateRow } from './tds'

const C194 = 7
const J194 = 8
const facts = (over: Partial<TdsLedgerFacts> = {}): TdsLedgerFacts => ({
  isDeducteeCandidate: false, tdsSectionId: null, deducteeKnown: false, defaultSectionId: null, isTax: false,
  isTdsPayable: false, isCashBank: false, ...over
})
const LEDGERS: Record<number, TdsLedgerFacts> = {
  1: facts({ isDeducteeCandidate: true, tdsSectionId: C194, deducteeKnown: true }), // contractor
  2: facts({ isDeducteeCandidate: true, deducteeKnown: true }), // consultant (no own section)
  3: facts({ isDeducteeCandidate: true }), // supplier, no PAN / type
  10: facts(), // labour expense
  11: facts({ defaultSectionId: J194 }), // professional fees
  20: facts({ isTax: true }), // CGST
  30: facts({ isCashBank: true }), // bank
  40: facts({ isTdsPayable: true })
}
const f = (id: number): TdsLedgerFacts | null => LEDGERS[id] ?? null

const row = (over: Partial<TdsRateRow> = {}): TdsRateRow => ({
  id: 1, sectionId: C194, effectiveFrom: '2025-04-01', effectiveTo: null, deducteeType: 'any', rateBp: 200,
  thresholdSinglePaise: 3000000, thresholdAnnualPaise: 10000000, thresholdBasis: 'fy', thresholdExcessOnly: false,
  returnCode: '94C', noPanRateBp: 2000, source: null, ...over
})
const ev = (voucherId: number, date: string, kind: WalkEvent['kind'], base: number, over: Partial<WalkEvent> = {}): WalkEvent => ({
  voucherId, date, kind, basePaise: base, grossPaise: base, entryBasePaise: null, exempt: false, ...over
})

describe('classifyTdsVoucher', () => {
  it('purchase to a flagged party: base = non-tax debits, gross = party credit', () => {
    const c = classifyTdsVoucher({
      kind: 'purchase', partyLedgerId: 1,
      lines: [{ ledgerId: 10, drCr: 'dr', amount: 1000 }, { ledgerId: 20, drCr: 'dr', amount: 180 }, { ledgerId: 1, drCr: 'cr', amount: 1180 }]
    }, f)
    expect(c).toMatchObject({ eventKind: 'credit', partyLedgerId: 1, sectionId: C194, sectionFrom: 'party', basePaise: 1000, grossPaise: 1180, expenseLedgerId: 10 })
  })

  it('journal: section from the debited ledger needs a known deductee type; payment debits the party', () => {
    const lines = [{ ledgerId: 11, drCr: 'dr' as const, amount: 5000 }, { ledgerId: 10, drCr: 'dr' as const, amount: 100 }, { ledgerId: 2, drCr: 'cr' as const, amount: 5100 }]
    expect(classifyTdsVoucher({ kind: 'journal', partyLedgerId: null, lines }, f)).toMatchObject({ sectionId: J194, sectionFrom: 'ledger', basePaise: 5000 })
    const noType = lines.map((l) => (l.ledgerId === 2 ? { ...l, ledgerId: 3 } : l))
    expect(classifyTdsVoucher({ kind: 'journal', partyLedgerId: null, lines: noType }, f)).toBeNull()
    expect(classifyTdsVoucher({ kind: 'payment', partyLedgerId: 2, lines: [{ ledgerId: 2, drCr: 'dr', amount: 900 }, { ledgerId: 30, drCr: 'cr', amount: 900 }] }, f))
      .toMatchObject({ eventKind: 'payment', sectionId: null, sectionFrom: 'credits', basePaise: 900 })
    expect(classifyTdsVoucher({ kind: 'sales', partyLedgerId: 1, lines }, f)).toBeNull()
  })

  it('a section override wins; candidates list the party section then ledger defaults', () => {
    const lines = [{ ledgerId: 11, drCr: 'dr' as const, amount: 5000 }, { ledgerId: 1, drCr: 'cr' as const, amount: 5000 }]
    expect(classifyTdsVoucher({ kind: 'journal', partyLedgerId: 1, lines }, f, J194)).toMatchObject({ sectionId: J194, sectionFrom: 'ledger' })
    expect(candidateSections({ kind: 'journal', lines }, 1, f)).toEqual([{ sectionId: C194, from: 'party' }, { sectionId: J194, from: 'ledger' }])
  })
})

describe('walkTdsEvents — eligibility reasons', () => {
  const rows = (): TdsRateRow | null => row()
  it('single, aggregate and aggregate-crossed-later', () => {
    const r = walkTdsEvents([ev(1, '2025-04-10', 'credit', 2500000), ev(2, '2025-05-10', 'credit', 3500000), ev(3, '2025-06-10', 'credit', 2000000), ev(4, '2025-07-10', 'credit', 2500000)], rows)
    expect(r.map((x) => x.reason)).toEqual(['aggregate_later', 'single', 'aggregate_later', 'aggregate'])
    expect(r.map((x) => x.priorPaise)).toEqual([0, 2500000, 6000000, 8000000])
    expect(priorAggregate(r, 'fy', '2025-07-10', 4)).toBe(8000000)
    // A new voucher on the same date counts every event of that date.
    expect(priorAggregate(r, 'fy', '2025-07-10')).toBe(10500000)
  })

  it('below all limits: nothing; no thresholds: everything ("none")', () => {
    expect(walkTdsEvents([ev(1, '2025-04-10', 'credit', 100)], rows).every((x) => x.reason === null)).toBe(true)
    expect(walkTdsEvents([ev(1, '2025-04-10', 'credit', 100)], () => row({ thresholdSinglePaise: 0, thresholdAnnualPaise: 0 }))[0]!.reason).toBe('none')
  })

  it('exempt events add nothing; deducted events count but are not eligible', () => {
    const r = walkTdsEvents([ev(1, '2025-04-10', 'credit', 9000000, { exempt: true }), ev(2, '2025-05-10', 'credit', 9000000, { entryBasePaise: 9000000 }), ev(3, '2025-06-10', 'credit', 2000000)], rows)
    expect(r.map((x) => [x.eventBasePaise, x.reason])).toEqual([[0, null], [9000000, null], [2000000, 'aggregate']])
  })

  it('a payment that deducts covers undeducted bills oldest first; an advance consumes later credits', () => {
    const covered = walkTdsEvents([ev(1, '2025-04-10', 'credit', 4000000), ev(2, '2025-05-10', 'payment', 4000000, { entryBasePaise: 4000000 })], rows)
    expect(covered.map((x) => x.eligibleBasePaise)).toEqual([0, 0])
    expect(undeductedCreditsBefore(covered, '2025-06-01')).toBe(0)
    const adv = walkTdsEvents([ev(1, '2025-04-10', 'payment', 4000000), ev(2, '2025-05-10', 'credit', 4000000)], rows)
    expect(adv.map((x) => [x.reason, x.eventBasePaise])).toEqual([['advance', 4000000], [null, 0]])
  })

  it('excess-only rows (194Q) never back-fill earlier purchases and only the excess is liable', () => {
    const q = (): TdsRateRow => row({ rateBp: 10, thresholdSinglePaise: 0, thresholdAnnualPaise: 500000000, thresholdExcessOnly: true })
    const r = walkTdsEvents([ev(1, '2025-04-10', 'credit', 400000000), ev(2, '2025-05-10', 'credit', 200000000)], q)
    expect(r.map((x) => [x.reason, x.eligibleBasePaise])).toEqual([[null, 0], ['aggregate', 100000000]])
  })

  it('month basis (194-I): the aggregate restarts each month', () => {
    const m = (): TdsRateRow => row({ thresholdSinglePaise: 0, thresholdAnnualPaise: 5000000, thresholdBasis: 'month' })
    const r = walkTdsEvents([ev(1, '2025-04-10', 'credit', 3000000), ev(2, '2025-04-20', 'credit', 3000000), ev(3, '2025-05-10', 'credit', 3000000)], m)
    expect(r.map((x) => x.reason)).toEqual(['aggregate_later', 'aggregate', null])
  })
})

describe('add / remove TDS on lines — the per-kind rule', () => {
  const isCash = (id: number): boolean => id === 30
  it('purchase/journal reduce the party credit and its new bill; payment reduces the bank', () => {
    const lines = [{ ledgerId: 10, drCr: 'dr' as const, amount: 1180 }, { ledgerId: 1, drCr: 'cr' as const, amount: 1180 }]
    const refs = [{ kind: 'new' as const, name: 'B1', amount: 1180, dueDate: null }]
    const a = addTdsToLines('purchase', lines, refs, { partyLedgerId: 1, tdsPaise: 20, isCashBank: isCash })
    expect(a).toMatchObject({ ok: true, lines: [{ amount: 1180 }, { amount: 1160 }], billRefs: [{ amount: 1160 }], targetLedgerId: 1 })
    const pay = [{ ledgerId: 1, drCr: 'dr' as const, amount: 1000 }, { ledgerId: 30, drCr: 'cr' as const, amount: 1000 }]
    expect(addTdsToLines('payment', pay, [], { partyLedgerId: 1, tdsPaise: 20, isCashBank: isCash })).toMatchObject({ ok: true, lines: [{ amount: 1000 }, { amount: 980 }] })
    expect(tdsTargetIndex('payment', pay, 1, isCash)).toBe(1)
  })

  it('refuses what it cannot do safely', () => {
    const lines = [{ ledgerId: 10, drCr: 'dr' as const, amount: 100 }, { ledgerId: 1, drCr: 'cr' as const, amount: 100 }]
    expect(addTdsToLines('purchase', lines, [], { partyLedgerId: 1, tdsPaise: 100, isCashBank: isCash })).toMatchObject({ ok: false })
    expect(addTdsToLines('sales', lines, [], { partyLedgerId: 1, tdsPaise: 1, isCashBank: isCash })).toMatchObject({ ok: false })
    const alloc = [{ ...lines[0]! }, { ...lines[1]!, costAllocations: [{ costCentreId: 1, amount: 100 }] }]
    expect(addTdsToLines('journal', alloc, [], { partyLedgerId: 1, tdsPaise: 1, isCashBank: isCash })).toMatchObject({ ok: false, error: expect.stringMatching(/cost-centre/) })
  })

  it('remove gives the payable credit back to the same line', () => {
    const lines = [{ ledgerId: 10, drCr: 'dr' as const, amount: 1180 }, { ledgerId: 1, drCr: 'cr' as const, amount: 1160 }, { ledgerId: 40, drCr: 'cr' as const, amount: 20 }]
    const refs = [{ kind: 'new' as const, name: 'B1', amount: 1160, dueDate: null }]
    const r = removeTdsFromLines('purchase', lines, refs, { partyLedgerId: 1, isPayableLine: (l) => l.ledgerId === 40, isCashBank: isCash })
    expect(r).toMatchObject({ ok: true, lines: [{ amount: 1180 }, { amount: 1180 }], billRefs: [{ amount: 1180 }], restoredPaise: 20 })
    expect(removeTdsFromLines('purchase', lines.slice(0, 2), refs, { partyLedgerId: 1, isPayableLine: (l) => l.ledgerId === 40, isCashBank: isCash })).toMatchObject({ ok: false })
  })
})
