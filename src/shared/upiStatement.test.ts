import { describe, expect, it } from 'vitest'
import { extractUtr, extractVpa, isUpiNarration, learnableNarration, upiCounterparty } from './upiStatement'

const HDFC = 'UPI/DR/451234567890/ACME TRADERS/HDFC/acmetraders@okhdfc/Invoice 41'
const SBI = 'UPI-RAVI KUMAR-RAVI@YBL-SBIN0001234-451234567890-RENT AUG'
const AXIS = 'UPI/CR/312345678901/SHREE ENTERPRISES/UTIB/shree.ent@axl/Payment'

describe('extractUtr', () => {
  it('finds the twelve-digit RRN in each bank\'s wording', () => {
    expect(extractUtr(HDFC)).toBe('451234567890')
    expect(extractUtr(SBI)).toBe('451234567890')
    expect(extractUtr(AXIS)).toBe('312345678901')
  })

  it('will not take twelve digits out of the middle of a longer number', () => {
    // A fifteen-digit internal serial is not a UTR, and treating it as one would match a voucher
    // that has nothing to do with this row.
    expect(extractUtr('NEFT 123456789012345 ACME')).toBeNull()
  })

  it('rejects an eleven- or thirteen-digit number', () => {
    expect(extractUtr('REF 12345678901')).toBeNull()
    expect(extractUtr('REF 1234567890123')).toBeNull()
  })

  it('returns null when there is no reference at all', () => {
    expect(extractUtr('CASH DEPOSIT')).toBeNull()
  })
})

describe('extractVpa', () => {
  it('reads the handle, lower-cased', () => {
    expect(extractVpa(HDFC)).toBe('acmetraders@okhdfc')
    expect(extractVpa(SBI)).toBe('ravi@ybl')
  })

  it('returns null when the narration carries no handle', () => {
    expect(extractVpa('NEFT DR-ACME TRADERS')).toBeNull()
  })
})

describe('isUpiNarration', () => {
  it('recognises the UPI marker and a bare handle', () => {
    expect(isUpiNarration(HDFC)).toBe(true)
    expect(isUpiNarration('PAID TO ravi@ybl')).toBe(true)
  })

  it('does not fire on a word that merely contains those letters', () => {
    expect(isUpiNarration('OCCUPIED PREMISES RENT')).toBe(false)
  })
})

describe('upiCounterparty', () => {
  it('picks the party name out of each layout', () => {
    expect(upiCounterparty(HDFC)).toBe('ACME TRADERS')
    expect(upiCounterparty(SBI)).toBe('RAVI KUMAR')
    expect(upiCounterparty(AXIS)).toBe('SHREE ENTERPRISES')
  })

  it('never returns the UTR, the handle or a bank code', () => {
    const name = upiCounterparty('UPI/DR/451234567890/HDFC/ab@okhdfc')
    expect(name).toBeNull()
  })

  it('returns null when nothing in it looks like a name', () => {
    expect(upiCounterparty('UPI/DR/451234567890')).toBeNull()
  })
})

describe('learnableNarration', () => {
  it('strips the once-only UTR so the memory has something that repeats', () => {
    expect(learnableNarration(HDFC)).toBe('ACME TRADERS')
    // Two payments from the same party in different months learn as the same thing.
    expect(learnableNarration('UPI/DR/999888777666/ACME TRADERS/HDFC/acmetraders@okhdfc/Inv 52'))
      .toBe('ACME TRADERS')
  })

  it('leaves a non-UPI narration exactly as it was, so nothing already learned is invalidated', () => {
    const neft = 'NEFT DR-HDFC0000123-ACME TRADERS-N123456789'
    expect(learnableNarration(neft)).toBe(neft)
  })

  it('falls back to the whole narration when no name can be read out of it', () => {
    expect(learnableNarration('UPI/DR/451234567890')).toBe('UPI/DR/451234567890')
  })
})
