import { describe, expect, it } from 'vitest'
import { chequeNumberOf } from './chequeRegister'

const f = (instrumentNo: string | null, reference: string | null = null, narration: string | null = null) => ({ instrumentNo, reference, narration })

describe('chequeNumberOf (register backfill)', () => {
  it('reads the instrument number with the print rule (digits only, leading zeros kept as text)', () => {
    expect(chequeNumberOf(f('000457'))).toEqual({ source: 'instrument', text: '000457', leaf: 457 })
    expect(chequeNumberOf(f(' 457 '))).toEqual({ source: 'instrument', text: '457', leaf: 457 })
  })
  it('an instrument number that is not a plain number stops there (never falls through to a guess)', () => {
    expect(chequeNumberOf(f('UTR123', '000458', 'chq 459'))).toBeNull()
  })
  it('then a digits-only reference, then a cheque word in the narration', () => {
    expect(chequeNumberOf(f(null, '000458'))).toEqual({ source: 'reference', text: '000458', leaf: 458 })
    expect(chequeNumberOf(f(null, 'INV-12', 'Paid by Chq No. 000459 to Acme'))).toEqual({ source: 'narration', text: '000459', leaf: 459 })
    expect(chequeNumberOf(f(null, null, 'cheque #460'))).toMatchObject({ leaf: 460 })
    expect(chequeNumberOf(f(null, null, 'CHK-461'))).toMatchObject({ leaf: 461 })
  })
  it('narration numbers without a cheque word are not cheque numbers', () => {
    expect(chequeNumberOf(f(null, null, 'Rent for 2026 room 457'))).toBeNull()
    expect(chequeNumberOf(f(null, null, null))).toBeNull()
  })
})
