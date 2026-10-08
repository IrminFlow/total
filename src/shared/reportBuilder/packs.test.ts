import { describe, expect, it } from 'vitest'
import { nextDueAt, packDue, packInputSchema, parseStamp } from './packs'
import { computeRatioSet, formatRatio, RATIO_DEFS, RATIO_KEYS } from '../ratios'

describe('pack schedule', () => {
  const at = (s: string): Date => new Date(s)
  it('daily: due from the next calendar day', () => {
    const p = { active: true, frequency: 'daily' as const, lastRunAt: '2025-06-03T22:00:00.000Z', createdAt: '2025-01-01 00:00:00' }
    expect(packDue(p, at('2025-06-03T23:59:00Z'))).toBe(false)
    expect(packDue(p, at('2025-06-04T00:00:00Z'))).toBe(true)
  })
  it('weekly: seven days after the last run; monthly: the 1st of the next month', () => {
    expect(nextDueAt('weekly', '2025-06-03T10:00:00Z')).toBe(Date.parse('2025-06-10T10:00:00Z'))
    expect(nextDueAt('monthly', '2025-01-31 18:00:00')).toBe(Date.parse('2025-02-01T00:00:00Z'))
  })
  it('a never-run pack counts from its creation; missed periods collapse into one due run; inactive never runs', () => {
    const p = { active: true, frequency: 'monthly' as const, lastRunAt: null, createdAt: '2025-03-02 10:00:00' }
    expect(packDue(p, at('2025-03-30T00:00:00Z'))).toBe(false)
    expect(packDue(p, at('2025-06-03T00:00:00Z'))).toBe(true)
    expect(packDue({ ...p, active: false }, at('2026-01-01T00:00:00Z'))).toBe(false)
  })
  it('a last run in the future (clock set back) is due, not stalled', () => {
    expect(packDue({ active: true, frequency: 'monthly', lastRunAt: '2030-01-01T00:00:00Z', createdAt: '2025-01-01 00:00:00' }, at('2025-06-03T00:00:00Z'))).toBe(true)
  })
  it('parses SQLite and ISO stamps as UTC', () => {
    expect(parseStamp('2025-06-03 10:00:00')).toBe(Date.parse('2025-06-03T10:00:00Z'))
    expect(parseStamp('2025-06-03T10:00:00.000Z')).toBe(Date.parse('2025-06-03T10:00:00Z'))
  })
  it('validates a pack definition', () => {
    const ok = packInputSchema.safeParse({ name: 'Month end', reports: [{ kind: 'builtin', key: 'trialBalance' }], periodRule: 'lastMonth', frequency: 'monthly', formats: ['pdf'] })
    expect(ok.success && ok.data).toMatchObject({ outputDir: null, active: true })
    const bad = packInputSchema.safeParse({ name: '', reports: [], periodRule: 'lastMonth', frequency: 'monthly', formats: [], outputDir: 'relative/dir' })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['Give the pack a name', 'Add at least one report', 'Pick at least one format', 'Choose an absolute folder']))
  })
})

describe('ratio set', () => {
  const base = {
    currentAssets: 1_800_000, currentLiabilities: 400_000, stock: 300_000, cashBank: 1_000_000, receivables: 500_000, payables: 400_000,
    totalAssets: 2_000_000, equity: 1_200_000, debt: 400_000, openingReceivables: 300_000, openingPayables: 200_000,
    openingTotalAssets: 1_600_000, openingEquity: 1_000_000, sales: 1_200_000, purchases: 800_000, openingStock: 100_000,
    closingStock: 300_000, grossProfit: 600_000, netProfit: 200_000, periodDays: 90
  }
  it('computes every ratio from its formula (and the dashboard seven via computeRatios)', () => {
    expect(computeRatioSet(base)).toEqual({
      currentRatio: 4.5, quickRatio: 3.75, cashRatio: 2.5,
      grossMarginPct: 50, netMarginPct: 16.67, returnOnEquityPct: 18.18, returnOnAssetsPct: 11.11,
      debtEquity: 0.33, equityRatio: 0.6,
      // COGS = 100,000 + 800,000 − 300,000 = 600,000; average stock 200,000.
      inventoryTurnover: 3, receivablesTurnover: 3, payablesTurnover: 2.67, netCapitalTurnover: 0.86, assetTurnover: 0.67,
      debtorDays: 30, creditorDays: 33.75, inventoryDays: 30, cashConversionDays: 26.25
    })
  })
  it('null when a denominator is zero or owners’ funds are not positive', () => {
    const r = computeRatioSet({ ...base, currentLiabilities: 0, sales: 0, equity: -5, openingEquity: -5 })
    expect(r.currentRatio).toBeNull()
    expect(r.netMarginPct).toBeNull()
    expect(r.debtEquity).toBeNull()
    expect(r.returnOnEquityPct).toBeNull()
    expect(r.cashConversionDays).toBeNull()
    // No stock either side → no inventory turnover → no inventory days (not 0).
    const noStock = computeRatioSet({ ...base, openingStock: 0, closingStock: 0, stock: 0 })
    expect(noStock.inventoryTurnover).toBeNull()
    expect(noStock.inventoryDays).toBeNull()
  })
  it('every ratio has a definition with a formula, an explanation and a source', () => {
    expect(RATIO_DEFS.map((d) => d.key).sort()).toEqual([...RATIO_KEYS].sort())
    for (const d of RATIO_DEFS) {
      expect(d.formula.length).toBeGreaterThan(5)
      expect(d.explain.length).toBeGreaterThan(20)
      expect(d.source).toMatch(/\[(S3|GN|FM)\]/)
    }
    expect(formatRatio(4.5, 'x')).toBe('4.50×')
    expect(formatRatio(16.666, '%')).toBe('16.7%')
    expect(formatRatio(37.5, 'days')).toBe('38 days')
    expect(formatRatio(null, 'x')).toBe('—')
  })
})
