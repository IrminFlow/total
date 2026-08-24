import { describe, expect, it } from 'vitest'
import { type Deadline, upcomingDeadlines } from './compliance'

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

  it('omits GSTR-1/3B for composition dealers, who file CMP-08 instead', () => {
    const d = upcomingDeadlines('2026-01-01', 'composition', false, 30)
    const forms = d.filter((x) => x.kind === 'gst').map((x) => x.form)
    expect(forms).not.toContain('GSTR-1')
    expect(forms).not.toContain('GSTR-3B')
    // January follows Q3, so the quarterly statement is due.
    expect(forms).toContain('CMP-08')
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

describe('QRMP (quarterly returns, monthly payment)', () => {
  // Most small businesses qualify for QRMP -- aggregate turnover up to Rs 5 crore -- and before
  // this the calendar showed them monthly GSTR-1 and GSTR-3B dates that do not apply to them.
  const qrmp = (today: string, horizon = 40, stateCode = '27'): Deadline[] =>
    upcomingDeadlines(today, 'regular', false, horizon, 'quarterly', stateCode)

  const forms = (ds: Deadline[]): string[] => ds.filter((d) => d.kind === 'gst').map((d) => d.form)

  it('does not show the monthly GSTR-1 and GSTR-3B a QRMP filer never files', () => {
    // April is month 1 of Q1, so the only GST items due in May are the challan and the IFF.
    const may = forms(qrmp('2026-05-01'))
    expect(may).not.toContain('GSTR-1')
    expect(may).not.toContain('GSTR-3B')
  })

  it('asks for a PMT-06 challan in the first two months of the quarter', () => {
    // Tax is still monthly under QRMP; this is the part filers most often miss.
    expect(forms(qrmp('2026-05-01'))).toContain('PMT-06')
    expect(forms(qrmp('2026-06-01'))).toContain('PMT-06')
    const pmt = qrmp('2026-05-01').find((d) => d.form === 'PMT-06')!
    expect(pmt.date).toBe('2026-05-25')
    expect(pmt.title).toContain('April 2026')
  })

  it('offers the optional IFF alongside it', () => {
    const iff = qrmp('2026-05-01').find((d) => d.form === 'IFF')
    expect(iff?.date).toBe('2026-05-13')
    expect(iff?.title).toMatch(/optional/)
  })

  it('files both returns in the month after the quarter closes', () => {
    // Q1 is Apr-Jun, so both fall due in July and are labelled as the quarter, not the month.
    const july = qrmp('2026-07-01')
    const gstr1 = july.find((d) => d.form === 'GSTR-1')!
    expect(gstr1.date).toBe('2026-07-13')
    expect(gstr1.title).toContain('Q1')
    expect(july.find((d) => d.form === 'PMT-06')).toBeUndefined()
    expect(july.find((d) => d.form === 'IFF')).toBeUndefined()
  })

  it('staggers GSTR-3B by state: the 22nd for one group, the 24th for the rest', () => {
    expect(qrmp('2026-07-01', 40, '27').find((d) => d.form === 'GSTR-3B')!.date).toBe('2026-07-22')
    expect(qrmp('2026-07-01', 40, '09').find((d) => d.form === 'GSTR-3B')!.date).toBe('2026-07-24')
  })

  it('gets every quarter boundary right across a full year', () => {
    // Returns are due in July, October, January and April; nothing quarterly in any other month.
    const returnMonths: string[] = []
    for (let m = 1; m <= 12; m++) {
      const found = qrmp(`2026-${String(m).padStart(2, '0')}-01`, 20).some((d) => d.form === 'GSTR-1')
      if (found) returnMonths.push(String(m))
    }
    expect(returnMonths).toEqual(['1', '4', '7', '10'])
  })

  it('leaves a monthly filer exactly as it was', () => {
    const monthly = upcomingDeadlines('2026-05-01', 'regular', false, 40, 'monthly', '27')
    expect(forms(monthly)).toContain('GSTR-1')
    expect(forms(monthly)).toContain('GSTR-3B')
    expect(forms(monthly)).not.toContain('PMT-06')
    // The default argument must also mean monthly, so existing callers do not change behaviour.
    expect(upcomingDeadlines('2026-05-01', 'regular', false, 40)).toEqual(
      upcomingDeadlines('2026-05-01', 'regular', false, 40, 'monthly', '')
    )
  })

  it('ignores the frequency for a composition dealer, who is on their own schedule', () => {
    // CMP-08 either way; the QRMP branch must not leak into a scheme it does not apply to.
    const asQuarterly = forms(upcomingDeadlines('2026-07-01', 'composition', false, 40, 'quarterly', '27'))
    const asMonthly = forms(upcomingDeadlines('2026-07-01', 'composition', false, 40, 'monthly', '27'))
    expect(asQuarterly).toEqual(['CMP-08'])
    expect(asMonthly).toEqual(asQuarterly)
  })
})

describe('composition scheme', () => {
  // Composition dealers previously had no GST deadlines at all, which reads as "nothing to file"
  // rather than "your scheme is unsupported".
  const comp = (today: string, horizon = 40): Deadline[] =>
    upcomingDeadlines(today, 'composition', false, horizon)

  it('asks for CMP-08 in the month after each quarter', () => {
    const cmp = comp('2026-07-01').find((d) => d.form === 'CMP-08')
    expect(cmp?.date).toBe('2026-07-18')
    expect(cmp?.title).toContain('Q1')
  })

  it('asks for it in exactly the four months that follow a quarter', () => {
    const months: string[] = []
    for (let m = 1; m <= 12; m++) {
      if (comp(`2026-${String(m).padStart(2, '0')}-01`, 20).some((d) => d.form === 'CMP-08')) {
        months.push(String(m))
      }
    }
    expect(months).toEqual(['1', '4', '7', '10'])
  })

  it('asks for the annual GSTR-4 after the financial year closes', () => {
    const gstr4 = comp('2027-06-10', 40).find((d) => d.form === 'GSTR-4')
    expect(gstr4?.date).toBe('2027-06-30')
    expect(gstr4?.title).toMatch(/annual return/)
  })

  it('never asks a composition dealer for GSTR-1 or GSTR-3B', () => {
    for (let m = 1; m <= 12; m++) {
      const forms = comp(`2026-${String(m).padStart(2, '0')}-01`, 40).map((d) => d.form)
      expect(forms).not.toContain('GSTR-1')
      expect(forms).not.toContain('GSTR-3B')
      expect(forms).not.toContain('PMT-06')
    }
  })

  it('still tracks the non-GST deadlines every business has', () => {
    // TDS and advance tax are not scheme-dependent.
    expect(comp('2026-07-01').map((d) => d.form)).toContain('TDS Challan')
  })
})
