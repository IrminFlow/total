import { describe, expect, it } from 'vitest'
import { upcomingDeadlines } from './compliance'

describe('upcomingDeadlines', () => {
  it('rolls a December period over into January GSTR-1/3B deadlines', () => {
    // 2025-12-25, horizon 30 -> window runs to 2026-01-24, so the Jan 11/20 deadlines
    // (for the December period) are in range but Feb's are not.
    const d = upcomingDeadlines('2025-12-25', 'regular', false, 30)
    const gstr1 = d.find((x) => x.kind === 'gst' && x.form === 'GSTR-1')
    const gstr3b = d.find((x) => x.kind === 'gst' && x.form === 'GSTR-3B')
    expect(gstr1?.date).toBe('2026-01-11')
    expect(gstr3b?.date).toBe('2026-01-20')
    expect(gstr1?.title).toContain('December 2025')
  })

  it('carries the March advance-tax instalment across the FY boundary correctly', () => {
    // Today just before the FY closes; the Q4 advance-tax instalment (15 Mar) of the
    // *same* calendar year should show up, not next year's.
    const d = upcomingDeadlines('2026-03-01', 'regular', false, 30)
    const advTax = d.filter((x) => x.kind === 'advance-tax')
    expect(advTax).toHaveLength(1)
    expect(advTax[0]!.date).toBe('2026-03-15')
  })

  it('finds the correct Jun/Sep/Dec/Mar instalment regardless of which year it falls in', () => {
    // Late Feb 2027 with a wide horizon crosses into the new FY: 15 Mar 2027 is the next
    // instalment date and must resolve to 2027, not 2026.
    const d = upcomingDeadlines('2027-02-20', 'regular', false, 30)
    const advTax = d.filter((x) => x.kind === 'advance-tax')
    expect(advTax).toHaveLength(1)
    expect(advTax[0]!.date).toBe('2027-03-15')
  })

  it('omits GSTR-1/3B for composition dealers', () => {
    const d = upcomingDeadlines('2026-01-01', 'composition', false, 30)
    expect(d.some((x) => x.kind === 'gst')).toBe(false)
    // TDS and advance tax rules are unaffected by registration type.
    expect(d.some((x) => x.kind === 'tds')).toBe(true)
  })

  it('omits GSTR-1/3B for unregistered businesses', () => {
    const d = upcomingDeadlines('2026-01-01', 'unregistered', false, 30)
    expect(d.some((x) => x.kind === 'gst')).toBe(false)
  })

  it('includes PF/ESI only when hasPayroll is true', () => {
    const withoutPayroll = upcomingDeadlines('2026-01-01', 'regular', false, 30)
    expect(withoutPayroll.some((x) => x.kind === 'pf' || x.kind === 'esi')).toBe(false)

    const withPayroll = upcomingDeadlines('2026-01-01', 'regular', true, 30)
    const pf = withPayroll.find((x) => x.kind === 'pf')
    const esi = withPayroll.find((x) => x.kind === 'esi')
    expect(pf?.date).toBe('2026-01-15')
    expect(esi?.date).toBe('2026-01-15')
  })

  it('clips to the horizon window — nothing before today, nothing past today+horizon', () => {
    const d = upcomingDeadlines('2026-01-01', 'regular', true, 5)
    for (const item of d) {
      expect(item.date >= '2026-01-01').toBe(true)
      expect(item.date <= '2026-01-06').toBe(true)
    }
    // Within the 5-day window from Jan 1: TDS on the 7th is just outside; nothing should be found.
    expect(d).toHaveLength(0)
  })

  it('picks up a nearby deadline once the horizon is widened to include it', () => {
    // TDS due 2026-01-07 — an 8-day horizon from Jan 1 should catch it.
    const d = upcomingDeadlines('2026-01-01', 'regular', false, 8)
    const tds = d.find((x) => x.kind === 'tds')
    expect(tds?.date).toBe('2026-01-07')
  })

  it('sorts all deadlines by date ascending', () => {
    const d = upcomingDeadlines('2026-01-01', 'regular', true, 30)
    const dates = d.map((x) => x.date)
    const sorted = [...dates].sort()
    expect(dates).toEqual(sorted)
  })

  it('defaults horizonDays to 30 when omitted', () => {
    const withDefault = upcomingDeadlines('2026-01-01', 'regular', true)
    const explicit30 = upcomingDeadlines('2026-01-01', 'regular', true, 30)
    expect(withDefault).toEqual(explicit30)
  })
})
