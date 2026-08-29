import { describe, expect, it } from 'vitest'
import {
  bandFloorPaise,
  bandOf,
  compositionEligible,
  eInvoiceMandatory,
  EINVOICE_THRESHOLD_PAISE,
  minHsnDigits,
  qrmpEligible,
  TURNOVER_BANDS,
  turnoverObligations
} from './turnover'

describe('turnover bands', () => {
  it('tiles the whole range with no gap and no overlap', () => {
    // A gap would silently answer "up to ₹50 lakh" for a figure in it, which is the wrong
    // answer in the direction that lets an obligation be missed.
    for (let i = 1; i < TURNOVER_BANDS.length; i++) {
      expect(TURNOVER_BANDS[i]!.fromPaise).toBe(TURNOVER_BANDS[i - 1]!.toPaise)
    }
    expect(TURNOVER_BANDS[0]!.fromPaise).toBe(0)
    expect(TURNOVER_BANDS[TURNOVER_BANDS.length - 1]!.toPaise).toBeNull()
  })

  it('places a boundary exactly on the e-invoice threshold, so no band straddles it', () => {
    // This is what makes every threshold test below exact rather than approximate.
    expect(TURNOVER_BANDS.some((b) => b.fromPaise === EINVOICE_THRESHOLD_PAISE)).toBe(true)
  })

  it('classifies a figure into its band, inclusive at the bottom and exclusive at the top', () => {
    expect(bandOf(0)).toBe('upto-50L')
    expect(bandOf(49_99_99_900)).toBe('upto-50L') // ₹49,99,999
    expect(bandOf(50_00_00_000)).toBe('50L-1.5Cr') // exactly ₹50 lakh
    expect(bandOf(150_00_00_000)).toBe('1.5Cr-5Cr') // exactly ₹1.5 crore
    expect(bandOf(500_00_00_000)).toBe('5Cr-10Cr') // exactly ₹5 crore
    expect(bandOf(1000_00_00_000)).toBe('10Cr-plus') // exactly ₹10 crore
    expect(bandOf(50_000_00_00_000)).toBe('10Cr-plus') // ₹500 crore
  })

  it('reads a band as its lower bound', () => {
    expect(bandFloorPaise('upto-50L')).toBe(0)
    expect(bandFloorPaise('5Cr-10Cr')).toBe(EINVOICE_THRESHOLD_PAISE)
  })
})

describe('e-invoicing', () => {
  it('is mandatory only over ₹5 crore', () => {
    expect(eInvoiceMandatory('5Cr-10Cr')).toBe(true)
    expect(eInvoiceMandatory('10Cr-plus')).toBe(true)
    expect(eInvoiceMandatory('1.5Cr-5Cr')).toBe(false)
    expect(eInvoiceMandatory('upto-50L')).toBe(false)
  })

  it('says nothing when turnover has not been declared', () => {
    // An unprompted warning about a threshold the user never mentioned is noise.
    expect(eInvoiceMandatory(null)).toBe(false)
  })
})

describe('QRMP eligibility', () => {
  it('is available up to ₹5 crore and not above it', () => {
    expect(qrmpEligible('1.5Cr-5Cr')).toBe(true)
    expect(qrmpEligible('5Cr-10Cr')).toBe(false)
  })

  it('does not block an undeclared business from a scheme it may well qualify for', () => {
    expect(qrmpEligible(null)).toBe(true)
  })
})

describe('minimum HSN digits (rule 46)', () => {
  it('wants six digits over ₹5 crore and four at or under it', () => {
    expect(minHsnDigits('5Cr-10Cr')).toBe(6)
    expect(minHsnDigits('1.5Cr-5Cr')).toBe(4)
    expect(minHsnDigits(null)).toBe(4)
  })
})

describe('composition eligibility', () => {
  it('allows goods and restaurants up to ₹1.5 crore', () => {
    expect(compositionEligible('50L-1.5Cr', 'trader')).toBe(true)
    expect(compositionEligible('50L-1.5Cr', 'restaurant')).toBe(true)
    expect(compositionEligible('1.5Cr-5Cr', 'trader')).toBe(false)
  })

  it('holds service providers to their own ₹50 lakh ceiling', () => {
    // Section 10(2A). A business in the ₹50 lakh–₹1.5 crore band could be at ₹1.4 crore, which
    // is fine for goods and nearly three times the service cap — so the band is not eligible.
    expect(compositionEligible('upto-50L', 'service')).toBe(true)
    expect(compositionEligible('50L-1.5Cr', 'service')).toBe(false)
  })

  it('does not pre-judge an undeclared business', () => {
    expect(compositionEligible(null, 'service')).toBe(true)
  })
})

describe('turnoverObligations', () => {
  it('states the whole set for a large business', () => {
    expect(turnoverObligations('5Cr-10Cr')).toEqual({
      band: '5Cr-10Cr',
      eInvoice: true,
      qrmp: false,
      minHsnDigits: 6
    })
  })

  it('states the whole set for a small one', () => {
    expect(turnoverObligations('upto-50L')).toEqual({
      band: 'upto-50L',
      eInvoice: false,
      qrmp: true,
      minHsnDigits: 4
    })
  })
})
