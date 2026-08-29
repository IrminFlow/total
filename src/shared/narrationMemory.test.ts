import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CONFIDENCE_THRESHOLD, significantWords, suggestFromMemory, type MemoryEntry
} from './narrationMemory'

const learned = (keyword: string, ledgerId: number, hits: number, kind: 'payment' | 'receipt' = 'payment'): MemoryEntry =>
  ({ keyword, ledgerId, kind, hits })

describe('significantWords', () => {
  it('keeps the counterparty and drops the bank plumbing', () => {
    expect(significantWords('NEFT DR-ACME SUPPLIES-N123456')).toEqual(['acme', 'supplies'])
  })

  it('drops every token carrying a digit, because a UTR never repeats', () => {
    expect(significantWords('UPI/9988/MAHANAGAR GAS/15082026')).toEqual(['mahanagar', 'gas'])
  })

  it('de-duplicates and caps how much one narration can contribute', () => {
    expect(significantWords('ALPHA ALPHA BETA')).toEqual(['alpha', 'beta'])
    expect(significantWords('one two three four five six seven eight').length).toBe(6)
  })

  it('returns nothing for a narration that is all plumbing', () => {
    expect(significantWords('NEFT TRF CHARGES 123')).toEqual([])
  })
})

describe('suggestFromMemory', () => {
  it('offers nothing when nothing has been learned', () => {
    expect(suggestFromMemory('ACME SUPPLIES', 'payment', [])).toBeNull()
  })

  it('will not sound confident about a single observation', () => {
    const one = suggestFromMemory('ACME SUPPLIES', 'payment', [learned('acme', 7, 1), learned('supplies', 7, 1)])
    expect(one!.ledgerId).toBe(7)
    expect(one!.confidence).toBe(40)
    expect(one!.confidence).toBeLessThan(DEFAULT_CONFIDENCE_THRESHOLD)
  })

  it('speaks up once the same words have been seen three times', () => {
    const s = suggestFromMemory('ACME SUPPLIES', 'payment', [learned('acme', 7, 3), learned('supplies', 7, 3)])
    expect(s).toMatchObject({ ledgerId: 7, confidence: 100, ambiguous: false })
    expect(s!.matched).toEqual(['acme', 'supplies'])
  })

  it('scales confidence down when only part of the narration is recognised', () => {
    // One of four known words, well observed: a weak hint, and it reads as one.
    const s = suggestFromMemory('ACME SUPPLIES MUMBAI DEPOT', 'payment', [learned('acme', 7, 5)])
    expect(s!.confidence).toBe(25)
  })

  it('halves confidence and flags a tie when two ledgers match equally', () => {
    const s = suggestFromMemory('ACME SUPPLIES', 'payment', [
      learned('acme', 7, 4), learned('supplies', 7, 4),
      learned('acme', 9, 4), learned('supplies', 9, 4)
    ])
    expect(s!.ambiguous).toBe(true)
    expect(s!.confidence).toBe(50)
    // Deterministic winner, so the same books always answer the same way.
    expect(s!.ledgerId).toBe(7)
  })

  it('prefers the ledger the narration points at hardest', () => {
    const s = suggestFromMemory('ACME SUPPLIES', 'payment', [
      learned('acme', 7, 4), learned('supplies', 7, 4),
      learned('acme', 9, 4)
    ])
    expect(s).toMatchObject({ ledgerId: 7, ambiguous: false, confidence: 100 })
  })

  it('never crosses direction: a name learned from payments says nothing about a deposit', () => {
    const memory = [learned('acme', 7, 5), learned('supplies', 7, 5)]
    expect(suggestFromMemory('ACME SUPPLIES', 'receipt', memory)).toBeNull()
  })

  it('offers nothing for a narration with no significant words at all', () => {
    expect(suggestFromMemory('NEFT CHARGES 0912', 'payment', [learned('acme', 7, 5)])).toBeNull()
  })
})
