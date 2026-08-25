import { describe, it, expect } from 'vitest'
import {
  applicableCertificate,
  deductionWithCertificate,
  type LowerDeductionCertificate
} from './lowerDeduction'

const cert = (over: Partial<LowerDeductionCertificate> = {}): LowerDeductionCertificate => ({
  certificateNumber: 'CERT-1',
  pan: 'AAAPA1234A',
  sectionId: '194C',
  ratePercent: 2,
  validFrom: '2025-04-01',
  validTo: '2026-03-31',
  ceilingPaise: 10_000_00,
  ...over
})

describe('applicableCertificate', () => {
  it('finds nothing when the payee holds no certificate', () => {
    expect(applicableCertificate([], { pan: 'AAAPA1234A', sectionId: '194C', date: '2025-06-01' })).toBeNull()
  })

  it('returns the certificate in force on the payment date', () => {
    const c = cert()
    expect(applicableCertificate([c], { pan: 'aaapa1234a', sectionId: '194c', date: '2025-06-01' })).toBe(c)
  })

  it('ignores a certificate that expired before the payment date', () => {
    const c = cert({ validTo: '2025-05-31' })
    expect(applicableCertificate([c], { pan: 'AAAPA1234A', sectionId: '194C', date: '2025-06-01' })).toBeNull()
  })

  it('ignores a certificate not yet in force on the payment date', () => {
    const c = cert({ validFrom: '2025-07-01' })
    expect(applicableCertificate([c], { pan: 'AAAPA1234A', sectionId: '194C', date: '2025-06-01' })).toBeNull()
  })

  it('keeps a PAN\'s certificates for two different sections apart', () => {
    const c194c = cert({ certificateNumber: 'C-194C', sectionId: '194C', ratePercent: 2 })
    const c194j = cert({ certificateNumber: 'C-194J', sectionId: '194J', ratePercent: 1 })
    const certs = [c194c, c194j]
    expect(applicableCertificate(certs, { pan: 'AAAPA1234A', sectionId: '194J', date: '2025-06-01' })).toBe(c194j)
    expect(applicableCertificate(certs, { pan: 'AAAPA1234A', sectionId: '194C', date: '2025-06-01' })).toBe(c194c)
    expect(applicableCertificate(certs, { pan: 'AAAPA1234A', sectionId: '194I', date: '2025-06-01' })).toBeNull()
  })

  it('prefers the later-issued of two overlapping certificates, then the higher rate', () => {
    const older = cert({ certificateNumber: 'OLD', validFrom: '2025-04-01', ratePercent: 1 })
    const newer = cert({ certificateNumber: 'NEW', validFrom: '2025-08-01', ratePercent: 3 })
    expect(applicableCertificate([older, newer], { pan: 'AAAPA1234A', sectionId: '194C', date: '2025-09-01' }))
      .toBe(newer)
    // Before the newer one starts, the older is still the one in force.
    expect(applicableCertificate([older, newer], { pan: 'AAAPA1234A', sectionId: '194C', date: '2025-06-01' }))
      .toBe(older)
    // Same validFrom: the higher rate wins, because under-deduction is the deductor's liability.
    const twinLow = cert({ certificateNumber: 'A', ratePercent: 1 })
    const twinHigh = cert({ certificateNumber: 'B', ratePercent: 4 })
    expect(applicableCertificate([twinLow, twinHigh], { pan: 'AAAPA1234A', sectionId: '194C', date: '2025-06-01' }))
      .toBe(twinHigh)
  })
})

describe('deductionWithCertificate', () => {
  it('deducts the normal rate when there is no certificate', () => {
    const r = deductionWithCertificate({
      amountPaise: 1_00_000_00,
      normalRatePercent: 10,
      certificate: null,
      alreadyPaidUnderCertificatePaise: 0
    })
    expect(r).toMatchObject({ atCertificateRatePaise: 0, atNormalRatePaise: 10_000_00, tdsPaise: 10_000_00 })
    expect(r.certificateExhausted).toBe(false)
    expect(r.ratesApplied).toEqual([
      { ratePercent: 10, basePaise: 1_00_000_00, tdsPaise: 10_000_00, underCertificate: false }
    ])
  })

  it('deducts the certificate rate on a payment entirely under the ceiling', () => {
    const r = deductionWithCertificate({
      amountPaise: 5_000_00,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 2, ceilingPaise: 10_000_00 }),
      alreadyPaidUnderCertificatePaise: 0
    })
    expect(r.atCertificateRatePaise).toBe(100_00)
    expect(r.atNormalRatePaise).toBe(0)
    expect(r.tdsPaise).toBe(100_00)
    expect(r.certificateExhausted).toBe(false)
    expect(r.ratesApplied).toHaveLength(1)
  })

  it('deducts nothing under a nil-rate certificate (s.197A / Form 15G-15H)', () => {
    const r = deductionWithCertificate({
      amountPaise: 5_000_00,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 0, ceilingPaise: 10_000_00 }),
      alreadyPaidUnderCertificatePaise: 0
    })
    expect(r.tdsPaise).toBe(0)
    expect(r.ratesApplied).toEqual([
      { ratePercent: 0, basePaise: 5_000_00, tdsPaise: 0, underCertificate: true }
    ])
  })

  it('never exhausts an uncapped certificate, however much has been paid', () => {
    const r = deductionWithCertificate({
      amountPaise: 1_00_000_00,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 1, ceilingPaise: null }),
      alreadyPaidUnderCertificatePaise: 99_00_00_000,
      panAvailable: true
    })
    expect(r.atCertificateRatePaise).toBe(1_000_00)
    expect(r.atNormalRatePaise).toBe(0)
    expect(r.certificateExhausted).toBe(false)
  })

  it('splits a payment that straddles the ceiling across both rates', () => {
    const r = deductionWithCertificate({
      amountPaise: 3_00_000_00,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 2, ceilingPaise: 10_00_000_00 }),
      alreadyPaidUnderCertificatePaise: 9_00_000_00
    })
    // ₹1,00,000 of headroom at 2% = ₹2,000; the remaining ₹2,00,000 at 10% = ₹20,000.
    expect(r.atCertificateRatePaise).toBe(2_000_00)
    expect(r.atNormalRatePaise).toBe(20_000_00)
    expect(r.atCertificateRatePaise + r.atNormalRatePaise).toBe(r.tdsPaise)
    expect(r.tdsPaise).toBe(22_000_00)
    expect(r.certificateExhausted).toBe(true)
    expect(r.ratesApplied).toEqual([
      { ratePercent: 2, basePaise: 1_00_000_00, tdsPaise: 2_000_00, underCertificate: true },
      { ratePercent: 10, basePaise: 2_00_000_00, tdsPaise: 20_000_00, underCertificate: false }
    ])
  })

  it('falls back to the normal rate once the ceiling is already exhausted', () => {
    const r = deductionWithCertificate({
      amountPaise: 50_000_00,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 2, ceilingPaise: 10_00_000_00 }),
      alreadyPaidUnderCertificatePaise: 10_00_000_00
    })
    expect(r.atCertificateRatePaise).toBe(0)
    expect(r.atNormalRatePaise).toBe(5_000_00)
    expect(r.certificateExhausted).toBe(true)
    expect(r.ratesApplied).toEqual([
      { ratePercent: 10, basePaise: 50_000_00, tdsPaise: 5_000_00, underCertificate: false }
    ])
  })

  it('treats a zero ceiling as spent, not as uncapped', () => {
    const zero = deductionWithCertificate({
      amountPaise: 10_000_00,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 2, ceilingPaise: 0 }),
      alreadyPaidUnderCertificatePaise: 0
    })
    const uncapped = deductionWithCertificate({
      amountPaise: 10_000_00,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 2, ceilingPaise: null }),
      alreadyPaidUnderCertificatePaise: 0
    })
    expect(zero.tdsPaise).toBe(1_000_00)
    expect(uncapped.tdsPaise).toBe(200_00)
  })

  it('applies s.206AA (20%) only to the portion beyond the ceiling', () => {
    // Rule 28AA(2) means a certificate cannot exist without a PAN, so its own leg is never
    // pushed to 20% — but a caller insisting the PAN is missing must not lower the other leg.
    const r = deductionWithCertificate({
      amountPaise: 2_00_000_00,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 2, ceilingPaise: 1_00_000_00 }),
      alreadyPaidUnderCertificatePaise: 0,
      panAvailable: false
    })
    expect(r.atCertificateRatePaise).toBe(2_000_00)
    expect(r.atNormalRatePaise).toBe(20_000_00) // 20%, not 10%
    expect(r.tdsPaise).toBe(22_000_00)
  })

  it('rounds each leg to the nearest rupee, and the total is the sum of the legs', () => {
    const r = deductionWithCertificate({
      amountPaise: 6_666_50,
      normalRatePercent: 10,
      certificate: cert({ ratePercent: 10, ceilingPaise: 3_333_50 }),
      alreadyPaidUnderCertificatePaise: 0
    })
    expect(r.atCertificateRatePaise % 100).toBe(0)
    expect(r.atNormalRatePaise % 100).toBe(0)
    expect(r.tdsPaise).toBe(r.atCertificateRatePaise + r.atNormalRatePaise)
  })
})
