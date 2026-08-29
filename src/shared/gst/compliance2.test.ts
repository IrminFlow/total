import { describe, expect, it } from 'vitest'
import {
  reportingBacklog,
  reportingWindow,
  windowApplies,
  REPORTING_WINDOW_DAYS,
  type WindowRow
} from './eInvoiceWindow'
import { lutStatus, lutValidFrom, lutValidTo, LUT_WARN_DAYS, type Lut } from './lut'

describe('the e-invoice reporting window', () => {
  it('applies only to the bands at or above ten crore', () => {
    expect(windowApplies(null)).toBe(false)
    expect(windowApplies('5Cr-10Cr')).toBe(false)
    expect(windowApplies('10Cr-plus')).toBe(true)
    expect(windowApplies('upto-50L')).toBe(false)
  })

  it('counts thirty days from the invoice date', () => {
    const w = reportingWindow('2026-06-01', '2026-06-01', false)
    expect(w.deadline).toBe('2026-07-01')
    expect(w.daysLeft).toBe(REPORTING_WINDOW_DAYS)
  })

  it('escalates as the window closes', () => {
    expect(reportingWindow('2026-06-01', '2026-06-02', false).urgency).toBe('fine')
    expect(reportingWindow('2026-06-01', '2026-06-25', false).urgency).toBe('due')
    expect(reportingWindow('2026-06-01', '2026-06-29', false).urgency).toBe('critical')
    expect(reportingWindow('2026-06-01', '2026-07-02', false).urgency).toBe('expired')
  })

  it('answers a reported invoice without arithmetic', () => {
    const w = reportingWindow('2026-01-01', '2026-12-31', true)
    expect(w.urgency).toBe('reported')
    expect(w.label).toBe('Reported')
  })

  it('says how long ago a closed window closed', () => {
    expect(reportingWindow('2026-06-01', '2026-07-11', false).label).toBe('Window closed 10 days ago')
  })

  const row = (over: Partial<WindowRow> = {}): WindowRow => ({
    voucherId: 1,
    number: 'INV-1',
    date: '2026-06-01',
    party: 'A Customer',
    value: 1_00_000_00,
    irn: null,
    ...over
  })

  it('drops reported invoices — a to-do list with done things stops being read', () => {
    const r = reportingBacklog([row({ irn: 'IRN123' }), row({ voucherId: 2, number: 'INV-2' })], '2026-06-10', '10Cr-plus')
    expect(r.rows.map((x) => x.number)).toEqual(['INV-2'])
  })

  it('ranks the least time left first', () => {
    const r = reportingBacklog(
      [
        row({ voucherId: 1, number: 'NEW', date: '2026-06-20' }),
        row({ voucherId: 2, number: 'OLD', date: '2026-05-20' })
      ],
      '2026-06-25',
      '10Cr-plus'
    )
    expect(r.rows.map((x) => x.number)).toEqual(['OLD', 'NEW'])
  })

  it('counts what can no longer be reported at all, and what it is worth', () => {
    const r = reportingBacklog(
      [row({ date: '2026-01-01', value: 5_00_000_00 }), row({ voucherId: 2, date: '2026-06-24' })],
      '2026-06-25',
      '10Cr-plus'
    )
    expect(r.expired).toBe(1)
    expect(r.expiredValue).toBe(5_00_000_00)
    expect(r.critical).toBe(0)
  })

  it('still lists the backlog for a registration the window does not apply to, but says so', () => {
    const r = reportingBacklog([row()], '2026-06-25', 'upto-50L')
    expect(r.applies).toBe(false)
    expect(r.rows).toHaveLength(1)
  })
})

describe('LUT tracking', () => {
  const lut = (fyStartYear: number): Lut => ({ arn: `AD${fyStartYear}0001`, fyStartYear, filedOn: `${fyStartYear}-04-05` })

  it('covers a financial year and dies with it, whenever it was filed', () => {
    expect(lutValidFrom(2026)).toBe('2026-04-01')
    expect(lutValidTo(2026)).toBe('2027-03-31')
  })

  it('is loud about having none', () => {
    const s = lutStatus([], '2026-06-01')
    expect(s.state).toBe('missing')
    expect(s.message).toContain('taxable')
    expect(s.lut).toBeNull()
  })

  it('is valid mid-year', () => {
    const s = lutStatus([lut(2026)], '2026-06-01')
    expect(s.state).toBe('valid')
    expect(s.validTo).toBe('2027-03-31')
    expect(s.daysLeft).toBeGreaterThan(LUT_WARN_DAYS)
  })

  it('warns before the year ends, with enough notice to file the next one', () => {
    const s = lutStatus([lut(2026)], '2027-03-01')
    expect(s.state).toBe('expiring')
    expect(s.daysLeft).toBe(30)
    expect(s.message).toContain('before 1 April')
  })

  it('says plainly what an expired one means', () => {
    const s = lutStatus([lut(2026)], '2027-04-02')
    expect(s.state).toBe('expired')
    expect(s.daysLeft).toBeLessThan(0)
    expect(s.message).toContain('taxable until a new one is filed')
  })

  it('takes the newest one that has actually started', () => {
    const s = lutStatus([lut(2026), lut(2027)], '2027-06-01')
    expect(s.lut!.fyStartYear).toBe(2027)
    expect(s.state).toBe('valid')

    // One filed for next year does not make this year covered.
    const early = lutStatus([lut(2027)], '2027-03-01')
    expect(early.state).toBe('missing')
  })
})
