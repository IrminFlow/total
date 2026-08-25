import { describe, expect, it } from 'vitest'
import {
  CATEGORY_LABEL,
  CHARGE_PHRASES,
  classifyBankLine,
  narrationTokens,
  voucherKindFor
} from './bankCharges'

describe('narrationTokens', () => {
  it('splits on punctuation banks glue to words', () => {
    expect(narrationTokens('INT.PD:262850:01-04-2026')).toEqual(['int', 'pd'])
  })

  it('drops pure-digit tokens so a reference number is never read as a word', () => {
    expect(narrationTokens('NEFT 12345 AMC 2026')).toEqual(['neft', 'amc'])
  })

  it('is empty for a narration with nothing but digits', () => {
    expect(narrationTokens('  0091 / 22 ')).toEqual([])
  })
})

describe('classifyBankLine', () => {
  it('recognises a quarterly maintenance charge', () => {
    expect(classifyBankLine('AMC CHRG 062026', 'withdrawal')).toEqual({ category: 'charge', phrase: 'chrg' })
    expect(classifyBankLine('ANNUAL MAINTENANCE 062026', 'withdrawal')).toEqual({
      category: 'charge',
      phrase: 'annual maintenance'
    })
  })

  it('recognises OD interest as interest paid', () => {
    expect(classifyBankLine('OD INTEREST FOR JUN 2026', 'withdrawal')?.category).toBe('interest_paid')
  })

  it('recognises credited savings interest as interest earned', () => {
    expect(classifyBankLine('CREDIT INTEREST CAPITALISED', 'deposit')?.category).toBe('interest_earned')
  })

  // The whole reason this module is not a list of substring bank rules.
  it('does not read a mobile RECHARGE as a bank charge', () => {
    expect(classifyBankLine('BILLDESK RECHARGE JIO PREPAID', 'withdrawal')).toBeNull()
  })

  it('does not read RETURNCHARGES glued into a party name as a charge', () => {
    expect(classifyBankLine('NEFT DR-RECHARGEWALA PVT LTD', 'withdrawal')).toBeNull()
  })

  it('refuses a charge wording on the wrong side — a credit is a refund, not an expense', () => {
    expect(classifyBankLine('REVERSAL OF SMS ALERT CHARGES', 'deposit')).toBeNull()
  })

  it('reads the bank GST line as input tax rather than as another charge', () => {
    const hit = classifyBankLine('GST ON CHRG 18PCT', 'withdrawal')
    expect(hit?.category).toBe('gst_on_charge')
  })

  it('prefers the longest phrase when two fit', () => {
    // 'cheque return' (13) beats 'chrg' (4) on a narration carrying both.
    const hit = classifyBankLine('CHEQUE RETURN CHRG', 'withdrawal')
    expect(hit?.phrase).toBe('cheque return')
  })

  it('returns null for an ordinary supplier payment', () => {
    expect(classifyBankLine('NEFT DR-HDFC0000123-ACME TRADERS-N123456789', 'withdrawal')).toBeNull()
  })

  it('returns null for an empty narration', () => {
    expect(classifyBankLine('', 'withdrawal')).toBeNull()
    expect(classifyBankLine('   ', 'deposit')).toBeNull()
  })
})

describe('voucherKindFor', () => {
  it('posts a charge as a payment and interest earned as a receipt', () => {
    expect(voucherKindFor('charge')).toBe('payment')
    expect(voucherKindFor('gst_on_charge')).toBe('payment')
    expect(voucherKindFor('interest_paid')).toBe('payment')
    expect(voucherKindFor('interest_earned')).toBe('receipt')
  })
})

describe('the phrase list itself', () => {
  it('gives every category a ledger label', () => {
    for (const p of CHARGE_PHRASES) expect(CATEGORY_LABEL[p.category]).toBeTruthy()
  })

  it('has no duplicate phrases', () => {
    const seen = new Set(CHARGE_PHRASES.map((p) => p.phrase))
    expect(seen.size).toBe(CHARGE_PHRASES.length)
  })
})
