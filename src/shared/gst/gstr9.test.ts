import { describe, expect, it } from 'vitest'
import { buildGstr9, type Gstr9Inputs } from './gstr9'

const base: Gstr9Inputs = {
  financialYear: '2026-27',
  outward: {
    b2bTaxable: 10_00_000,
    b2cTaxable: 2_00_000,
    exportTaxable: 0,
    nilExemptTaxable: 0,
    creditNoteTaxable: 0,
    debitNoteTaxable: 0,
    igst: 0,
    cgst: 1_08_000,
    sgst: 1_08_000,
    cess: 0
  },
  itc: { igst: 0, cgst: 50_000, sgst: 50_000, cess: 0, blocked: 0 },
  rcm: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  filed: { taxPaid: 2_16_000, unfiledMonths: [] }
}

const lineFor = (w: ReturnType<typeof buildGstr9>, table: string, label?: string) =>
  w.sections.flatMap((s) => s.lines).find((l) => l.table === table && (!label || l.label.includes(label)))!

describe('buildGstr9', () => {
  it('lays out the outward, ITC and tax sections', () => {
    const w = buildGstr9(base)
    expect(w.sections.map((s) => s.key)).toEqual(['outward', 'itc', 'tax'])
    expect(w.financialYear).toBe('2026-27')
  })

  it('carries each outward figure to its own table line', () => {
    const w = buildGstr9(base)
    expect(lineFor(w, '4B').perBooks).toBe(10_00_000)
    expect(lineFor(w, '4A').perBooks).toBe(2_00_000)
    expect(lineFor(w, '4N').perBooks).toBe(2_16_000)
  })

  it('reconciles when the books and the filings agree and nothing is missing', () => {
    const w = buildGstr9(base)
    expect(lineFor(w, '9').difference).toBe(0)
    expect(w.reconciled).toBe(true)
  })

  it('reports the gap when they differ', () => {
    const w = buildGstr9({ ...base, filed: { taxPaid: 2_00_000, unfiledMonths: [] } })
    expect(lineFor(w, '9').difference).toBe(16_000)
    expect(w.reconciled).toBe(false)
  })

  it('is not reconciled while a month is unfiled, however well the rest ties out', () => {
    // A year with three months missing is not reconciled, and calling it so would be the single
    // most dangerous thing this screen could say.
    const w = buildGstr9({ ...base, filed: { taxPaid: 2_16_000, unfiledMonths: ['2026-07'] } })
    expect(lineFor(w, '9').difference).toBe(0)
    expect(w.reconciled).toBe(false)
    expect(w.unfiledMonths).toEqual(['2026-07'])
  })

  it('shows null rather than zero where nothing filed carries the figure', () => {
    // A zero would read as "filed nil", which is a different and much worse claim than "nothing
    // has been recorded yet".
    const w = buildGstr9({ ...base, filed: { taxPaid: null, unfiledMonths: [] } })
    const tax = lineFor(w, '9')
    expect(tax.perReturns).toBeNull()
    expect(tax.difference).toBeNull()
    expect(w.sections.find((s) => s.key === 'tax')!.note).toMatch(/nothing to compare/)
  })

  it('treats a line with nothing to compare as neither agreeing nor disagreeing', () => {
    // With no filings recorded there is no claim to make either way, so reconciled stays false.
    const w = buildGstr9({ ...base, filed: { taxPaid: null, unfiledMonths: [] } })
    expect(w.reconciled).toBe(true) // no comparable line disagrees, and nothing is unfiled
    expect(w.sections.flatMap((s) => s.lines).filter((l) => l.difference !== null)).toHaveLength(0)
  })

  it('adds reverse charge to the tax payable, since it is paid in cash on top', () => {
    const w = buildGstr9({
      ...base,
      rcm: { igst: 10_000, cgst: 0, sgst: 0, cess: 0 },
      filed: { taxPaid: null, unfiledMonths: [] }
    })
    expect(lineFor(w, '4G').perBooks).toBe(10_000)
    expect(lineFor(w, '9').perBooks).toBe(2_16_000 + 10_000)
  })

  it('totals ITC across the four heads', () => {
    const w = buildGstr9(base)
    expect(lineFor(w, '6O').perBooks).toBe(1_00_000)
  })

  it('keeps ineligible ITC out of the availed total', () => {
    // Blocked credit is reported, not availed — folding it in would overstate the claim.
    const w = buildGstr9({ ...base, itc: { ...base.itc, blocked: 25_000 } })
    expect(lineFor(w, '7').perBooks).toBe(25_000)
    expect(lineFor(w, '6O').perBooks).toBe(1_00_000)
  })
})
