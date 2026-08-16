import { describe, it, expect } from 'vitest'
import { chequeFields, mmToInches } from './cheque'
import { amountInWords, formatPaise } from './money'

describe('chequeFields', () => {
  it('splits the date into an 8-digit DDMMYYYY box string', () => {
    const f = chequeFields({ date: '2026-08-16', payee: 'Acme Traders', amount: 100000 })
    expect(f.dateBoxes).toBe('16082026')
    expect(f.dateBoxes).toHaveLength(8)
  })

  it('passes the payee through untouched', () => {
    const f = chequeFields({ date: '2026-01-05', payee: '  Acme Traders  ', amount: 100000 })
    expect(f.payee).toBe('  Acme Traders  ')
  })

  it('words matches amountInWords exactly — no double "Only" append', () => {
    const amount = 1234556
    const f = chequeFields({ date: '2026-01-05', payee: 'X', amount })
    expect(f.words).toBe(amountInWords(amount))
    expect(f.words.endsWith('Only')).toBe(true)
    expect(f.words.endsWith('Only Only')).toBe(false)
  })

  it('figures use grouped Indian formatting with no symbol, suffixed "/-"', () => {
    const f = chequeFields({ date: '2026-01-05', payee: 'X', amount: 123456789 })
    expect(f.figures).toBe(`${formatPaise(123456789)}/-`)
    expect(f.figures).toBe('12,34,567.89/-')
  })

  it('handles a zero-paise amount', () => {
    const f = chequeFields({ date: '2026-01-05', payee: 'X', amount: 0 })
    expect(f.words).toBe('Zero Rupees Only')
    expect(f.figures).toBe('0.00/-')
  })
})

describe('mmToInches', () => {
  it('converts a standard CTS-2010 cheque leaf (202×92mm) to inches', () => {
    expect(mmToInches(202)).toBeCloseTo(7.9528, 4)
    expect(mmToInches(92)).toBeCloseTo(3.6220, 4)
  })

  it('converts A4 (210×297mm) close to the familiar 8.27×11.69in', () => {
    expect(mmToInches(210)).toBeCloseTo(8.2677, 4)
    expect(mmToInches(297)).toBeCloseTo(11.6929, 4)
  })

  it('zero stays zero', () => {
    expect(mmToInches(0)).toBe(0)
  })
})
