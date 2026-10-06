import { describe, it, expect } from 'vitest'
import { balanceBasis, periodIncludesStoredPnl, resetsEachYear } from './yearOpening'

describe('resetsEachYear', () => {
  it('is true only for income and expense natures', () => {
    expect(resetsEachYear('income')).toBe(true)
    expect(resetsEachYear('expense')).toBe(true)
    expect(resetsEachYear('asset')).toBe(false)
    expect(resetsEachYear('liability')).toBe(false)
  })
})

describe('balanceBasis', () => {
  it('asset/liability ledgers keep the stored opening and all history', () => {
    expect(balanceBasis('asset', '2027-01-15', 2025)).toEqual({ includeStored: true, movementsFrom: null })
    expect(balanceBasis('liability', '2025-04-01', 2025)).toEqual({ includeStored: true, movementsFrom: null })
  })

  it('P&L ledgers in the first FY of the books keep the stored opening, from 1 April', () => {
    expect(balanceBasis('expense', '2025-04-01', 2025)).toEqual({ includeStored: true, movementsFrom: '2025-04-01' })
    expect(balanceBasis('income', '2026-03-31', 2025)).toEqual({ includeStored: true, movementsFrom: '2025-04-01' })
  })

  it('P&L ledgers in a later FY drop the stored opening and start at that FY’s 1 April', () => {
    expect(balanceBasis('expense', '2026-04-01', 2025)).toEqual({ includeStored: false, movementsFrom: '2026-04-01' })
    expect(balanceBasis('expense', '2026-07-01', 2025)).toEqual({ includeStored: false, movementsFrom: '2026-04-01' })
    // Jan–Mar belong to the FY that started the previous April.
    expect(balanceBasis('income', '2027-03-31', 2025)).toEqual({ includeStored: false, movementsFrom: '2026-04-01' })
  })

})

describe('periodIncludesStoredPnl', () => {
  it('includes stored P&L openings only when the period contains the books’ first day', () => {
    expect(periodIncludesStoredPnl('2025-04-01', '2026-03-31', 2025)).toBe(true) // first FY
    expect(periodIncludesStoredPnl('2025-04-01', '2025-04-01', 2025)).toBe(true)
    expect(periodIncludesStoredPnl('2025-04-01', '2027-03-31', 2025)).toBe(true) // since books began
    expect(periodIncludesStoredPnl('2025-01-01', '2025-06-30', 2025)).toBe(true)
    expect(periodIncludesStoredPnl('2025-07-01', '2025-09-30', 2025)).toBe(false) // Q2: in its opening
    expect(periodIncludesStoredPnl('2026-04-01', '2027-03-31', 2025)).toBe(false) // later FY
    expect(periodIncludesStoredPnl('2024-04-01', '2025-03-31', 2025)).toBe(false) // before books
  })
})
