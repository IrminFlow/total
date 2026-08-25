import { describe, expect, it } from 'vitest'
import { buildForm16a, type Form16aDeduction, type Form16aInput } from './form16a'

const deduction = (over: Partial<Form16aDeduction> = {}): Form16aDeduction => ({
  sectionCode: '194C',
  sectionUnverified: false,
  paidOn: '2026-06-10',
  amountPaid: 5_00_000_00,
  tds: 5_000_00,
  rate: 1,
  voucherNumber: 'PMT-3',
  challan: { bsrCode: '0004329', paidOn: '2026-07-07', serial: '00021' },
  ...over
})

const input = (over: Partial<Form16aInput> = {}): Form16aInput => ({
  deducteeLedgerId: 4,
  deducteeName: 'Ram Contractors',
  deducteePan: 'AAAPA0000A',
  deductorName: 'Demo Traders',
  deductorTan: 'PNET12345B',
  deductorPan: 'AAAPA1111A',
  fyStartYear: 2026,
  quarter: 1,
  from: '2026-04-01',
  to: '2026-06-30',
  dueDate: '2026-08-15',
  deductions: [deduction()],
  ...over
})

describe('buildForm16a', () => {
  it('summarises by section, which is the face of the certificate', () => {
    const f = buildForm16a(input({ deductions: [deduction(), deduction({ sectionCode: '194J', tds: 2_000_00, amountPaid: 20_000_00 })] }))
    expect(f.bySection.map((s) => s.sectionCode)).toEqual(['194C', '194J'])
    expect(f.totalTds).toBe(7_000_00)
    expect(f.totalPaid).toBe(5_20_000_00)
  })

  it('labels the year and the assessment year', () => {
    const f = buildForm16a(input())
    expect(f.fyLabel).toBe('FY 2026-27')
    expect(f.ayLabel).toBe('AY 2027-28')
  })

  it('always says first that this is not the TRACES certificate', () => {
    // A deductor who sends this instead of the TRACES download has given their vendor something
    // the vendor cannot use.
    expect(buildForm16a(input()).warnings[0]).toContain('TRACES')
  })

  it('refuses to produce a certificate for a quarter with no deduction', () => {
    // A nil Form 16A is not a nil certificate — it tells a vendor to look for credit that is not
    // there.
    expect(() => buildForm16a(input({ deductions: [] }))).toThrow(/no certificate to issue/i)
  })

  it('warns when the deductee has no PAN', () => {
    const f = buildForm16a(input({ deducteePan: null }))
    expect(f.warnings.join(' ')).toContain('26AS')
  })

  it('treats a malformed PAN as no PAN', () => {
    expect(buildForm16a(input({ deducteePan: 'NOTAPAN' })).warnings.join(' ')).toContain('26AS')
  })

  it('warns when the company has no TAN', () => {
    expect(buildForm16a(input({ deductorTan: null })).warnings.join(' ')).toContain('TAN')
  })

  it('warns about deductions with no challan behind them', () => {
    const f = buildForm16a(input({ deductions: [deduction({ challan: null })] }))
    expect(f.warnings.join(' ')).toContain('not linked to a challan')
  })

  it('warns when a section reference is an unverified 2025 Act number', () => {
    const f = buildForm16a(input({ deductions: [deduction({ sectionCode: '393', sectionUnverified: true })] }))
    expect(f.warnings.join(' ')).toContain('Income-tax Act 2025')
    expect(f.bySection[0]!.unverified).toBe(true)
  })

  it('orders the deductions by the date of payment', () => {
    const f = buildForm16a(input({ deductions: [deduction({ paidOn: '2026-06-20' }), deduction({ paidOn: '2026-04-02' })] }))
    expect(f.deductions.map((d) => d.paidOn)).toEqual(['2026-04-02', '2026-06-20'])
  })
})
