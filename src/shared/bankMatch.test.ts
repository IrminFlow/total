import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MATCH_OPTIONS, learn, narrationTokens, proposeMatches, refDigits, renderNarration, ruleConfidence, scorePair, suggestLearned,
  tokenSignature, validateGroup, type LearnedRule, type MatchEntry, type MatchLine
} from './bankMatch'

const line = (id: number, date: string, amount: number, side: 'deposit' | 'withdrawal' = 'deposit', description = '', reference = ''): MatchLine => ({
  id, date, amount, side, description, reference
})
const entry = (id: number, date: string, amount: number, side: 'deposit' | 'withdrawal' = 'deposit', extra: Partial<MatchEntry> = {}): MatchEntry => ({
  id, voucherId: id + 100, date, amount, side, instrumentNo: null, partyName: null, partyKey: null, ...extra
})

describe('narration tokens', () => {
  it('strips rail prefixes, IFSC codes, reference numbers and VPA bank handles', () => {
    expect(narrationTokens('NEFT CR-ICIC0000104-ACME TRADERS PVT LTD-NETBANK')).toEqual(['ACME', 'TRADERS'])
    expect(narrationTokens('UPI-RAVI KUMAR-ravi.kumar@okhdfcbank-HDFC0001234-321456789012-RENT')).toEqual(['RAVI', 'KUMAR', 'RENT'])
    expect(narrationTokens('IMPS/P2A/321987654321/GUPTA STORES/SBIN0001234/INV44')).toEqual(['GUPTA', 'STORES', 'INV44'])
    expect(narrationTokens('CHQ PAID-MICR CTS-CH-000123-SHREE PACKAGING')).toEqual(['CH', 'SHREE', 'PACKAGING'])
    expect(narrationTokens('BY TRANSFER-NEFT*HDFC0000001*N213456*MEHTA ENTERPRISES')).toEqual(['MEHTA', 'ENTERPRISES'])
    expect(narrationTokens('ATM WDL 12345 ')).toEqual(['WDL'])
    expect(narrationTokens('  ')).toEqual([])
  })
  it('signature is order-free; refDigits drops non-digits and leading zeros', () => {
    expect(tokenSignature(['B', 'A', 'B'])).toBe('A B')
    expect(refDigits('CHQ 000123')).toBe('123')
  })
})

describe('scoring pairs', () => {
  it('needs the same side, an amount within tolerance and a date within the window', () => {
    expect(scorePair(line(1, '2026-08-02', 1000), entry(1, '2026-08-02', 1000, 'withdrawal'))).toBeNull()
    expect(scorePair(line(1, '2026-08-02', 1000), entry(1, '2026-08-02', 1001))).toBeNull()
    expect(scorePair(line(1, '2026-08-02', 1000), entry(1, '2026-08-02', 1001), { ...DEFAULT_MATCH_OPTIONS, amountTolerance: 100 })).not.toBeNull()
    expect(scorePair(line(1, '2026-08-20', 1000), entry(1, '2026-08-02', 1000))).toBeNull()
  })
  it('rewards exact amounts, close dates, cheque numbers and party names', () => {
    const exactSameDay = scorePair(line(1, '2026-08-02', 1000), entry(1, '2026-08-02', 1000))!.score
    const exactLater = scorePair(line(1, '2026-08-05', 1000), entry(1, '2026-08-02', 1000))!.score
    const withCheque = scorePair(line(1, '2026-08-05', 1000, 'deposit', 'CLG', '000457'), entry(1, '2026-08-02', 1000, 'deposit', { instrumentNo: '457' }))
    const withName = scorePair(line(1, '2026-08-05', 1000, 'deposit', 'NEFT ACME TRADERS'), entry(1, '2026-08-02', 1000, 'deposit', { partyName: 'Acme Traders' }))
    expect(exactSameDay).toBeGreaterThan(exactLater)
    expect(withCheque!.score).toBeGreaterThan(exactLater)
    expect(withCheque!.reasons).toContain('cheque / reference number agrees')
    expect(withName!.reasons).toContain('party name in narration')
  })
})

describe('proposals', () => {
  it('assigns one-to-one greedily and flags ties as ambiguous', () => {
    const p = proposeMatches(
      [line(1, '2026-08-02', 5000), line(2, '2026-08-03', 7000)],
      [entry(10, '2026-08-01', 5000), entry(11, '2026-08-03', 7000), entry(12, '2026-08-03', 7000)]
    )
    expect(p.map((x) => [x.kind, x.lineIds, x.entryIds, x.ambiguous])).toEqual([
      ['one_to_one', [2], [11], true],
      ['one_to_one', [1], [10], false]
    ])
  })

  it('one bank credit vs several receipts of the same party (entries_to_line)', () => {
    const p = proposeMatches(
      [line(1, '2026-08-05', 30000)],
      [
        entry(10, '2026-08-03', 10000, 'deposit', { partyKey: 7 }),
        entry(11, '2026-08-04', 20000, 'deposit', { partyKey: 7 }),
        entry(12, '2026-08-04', 20000, 'deposit', { partyKey: 8 })
      ]
    )
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ kind: 'entries_to_line', lineIds: [1], entryIds: [10, 11], ambiguous: false })
  })

  it('one book entry vs several bank lines (lines_to_entry)', () => {
    const p = proposeMatches(
      [line(1, '2026-08-05', 4000, 'withdrawal'), line(2, '2026-08-06', 6000, 'withdrawal')],
      [entry(10, '2026-08-05', 10000, 'withdrawal')]
    )
    expect(p).toEqual([expect.objectContaining({ kind: 'lines_to_entry', lineIds: [1, 2], entryIds: [10] })])
  })

  it('validates a user-confirmed group', () => {
    expect(validateGroup([line(1, 'x', 100)], [entry(1, 'x', 100)], 0)).toBeNull()
    expect(validateGroup([line(1, 'x', 100)], [entry(1, 'x', 90)], 0)).toMatch(/differ/)
    expect(validateGroup([line(1, 'x', 100)], [entry(1, 'x', 90)], 1000)).toBeNull()
    expect(validateGroup([line(1, 'x', 100), line(2, 'x', 1)], [entry(1, 'x', 50), entry(2, 'x', 51)], 0)).toMatch(/many-to-many/)
    expect(validateGroup([line(1, 'x', 100)], [entry(1, 'x', 100, 'withdrawal')], 0)).toMatch(/Deposits/)
  })
})

describe('learning', () => {
  const base: Omit<LearnedRule, 'id' | 'tokens' | 'ledgerId'> = {
    direction: 'withdrawal', partyLedgerId: null, voucherKind: 'payment', narrationTemplate: null, hits: 1, applied: 0, rejected: 0, status: 'candidate'
  }

  it('creates a candidate from the first observation and reinforces it with the shared tokens', () => {
    const first = learn([], { direction: 'withdrawal', narration: 'UPI-RAVI KUMAR-ravi@okhdfc-321456789012-RENT AUG', ledgerId: 5, partyLedgerId: null, voucherKind: 'payment' })
    expect(first).toEqual([{ op: 'create', rule: expect.objectContaining({ tokens: ['RAVI', 'KUMAR', 'RENT', 'AUG'], ledgerId: 5 }) }])
    const rules: LearnedRule[] = [{ ...base, id: 1, tokens: ['RAVI', 'KUMAR', 'RENT', 'AUG'], ledgerId: 5 }]
    const second = learn(rules, { direction: 'withdrawal', narration: 'UPI-RAVI KUMAR-ravi@okhdfc-999456789012-RENT SEP', ledgerId: 5, partyLedgerId: null, voucherKind: 'payment' })
    expect(second).toEqual([{ op: 'reinforce', ruleId: 1, tokens: ['RAVI', 'KUMAR', 'RENT'] }])
  })

  it('contradicts a rule that would have sent the same narration elsewhere', () => {
    const rules: LearnedRule[] = [{ ...base, id: 1, tokens: ['RAVI', 'KUMAR'], ledgerId: 5 }]
    const ops = learn(rules, { direction: 'withdrawal', narration: 'UPI RAVI KUMAR LOAN', ledgerId: 9, partyLedgerId: null, voucherKind: 'payment' })
    expect(ops).toEqual([expect.objectContaining({ op: 'create' }), { op: 'contradict', ruleId: 1 }])
  })

  it('learns nothing from narrations without identifying tokens', () => {
    expect(learn([], { direction: 'deposit', narration: 'NEFT 123456 CR', ledgerId: 1, partyLedgerId: null, voucherKind: 'receipt' })).toEqual([])
  })

  it('confidence grows with evidence and falls with contradictions', () => {
    const c1 = ruleConfidence({ hits: 1, applied: 0, rejected: 0, status: 'candidate' })
    const c12 = ruleConfidence({ hits: 12, applied: 0, rejected: 0, status: 'candidate' })
    const c12bad = ruleConfidence({ hits: 12, applied: 0, rejected: 6, status: 'candidate' })
    expect(c1).toBeLessThan(0.6)
    expect(c12).toBeGreaterThan(0.9)
    expect(c12bad).toBeLessThan(c12)
    expect(ruleConfidence({ hits: 1, applied: 0, rejected: 0, status: 'accepted' })).toBe(0.9)
    expect(ruleConfidence({ hits: 50, applied: 0, rejected: 0, status: 'ignored' })).toBe(0)
  })

  it('suggests the most specific confident rule for the right direction', () => {
    const rules: LearnedRule[] = [
      { ...base, id: 1, tokens: ['RAVI', 'KUMAR'], ledgerId: 5, hits: 12 },
      { ...base, id: 2, tokens: ['RAVI', 'KUMAR', 'LOAN'], ledgerId: 9, hits: 12 },
      { ...base, id: 3, tokens: ['RAVI', 'KUMAR'], ledgerId: 7, hits: 40, direction: 'deposit' }
    ]
    expect(suggestLearned({ description: 'UPI RAVI KUMAR RENT', side: 'withdrawal' }, rules)?.rule.id).toBe(1)
    expect(suggestLearned({ description: 'UPI RAVI KUMAR LOAN EMI', side: 'withdrawal' }, rules)?.rule.id).toBe(2)
    expect(suggestLearned({ description: 'UPI RAVI KUMAR', side: 'deposit' }, rules)?.rule.id).toBe(3)
    expect(suggestLearned({ description: 'UPI SOMEONE ELSE', side: 'withdrawal' }, rules)).toBeNull()
    // a one-off candidate is below the default threshold only when contradicted
    const weak: LearnedRule[] = [{ ...base, id: 4, tokens: ['ZED'], ledgerId: 1, hits: 1, rejected: 5 }]
    expect(suggestLearned({ description: 'ZED', side: 'withdrawal' }, weak)).toBeNull()
  })

  it('renders narration templates', () => {
    const l = { description: 'UPI RAVI RENT', reference: 'R1', date: '2026-08-03' }
    expect(renderNarration(null, l)).toBe('UPI RAVI RENT')
    expect(renderNarration('Office rent — {narration} ({reference})', l)).toBe('Office rent — UPI RAVI RENT (R1)')
  })
})
