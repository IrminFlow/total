import { describe, expect, it } from 'vitest'
import {
  EINVOICE_APPLICABILITY_SOURCES,
  EINVOICE_APPLICABILITY_UNVERIFIED,
  EINVOICE_EXEMPTIONS,
  EINVOICE_THRESHOLDS,
  describeEinvoiceApplicability,
  einvoiceApplicability,
  einvoiceThresholdOn,
  gstTurnoverSchema,
  irpDaysLeft,
  irpLastReportingDay,
  reportingWindowApplies,
  type EinvoiceProfile
} from './einvoiceApplicability'
import { applyGstProfilePatch, gstProfilePatchSchema, normalizeGstProfile } from './filing'
import { einvoiceTurnOnNotice } from '../compliance'

const CR = 1_000_000_000 // ₹1 crore in paise
const regular = (years: { fy: string; paise: number }[], extra: Partial<EinvoiceProfile> = {}): EinvoiceProfile => ({
  gstRegistrationType: 'regular',
  turnover: { years },
  ...extra
})

describe('thresholds, as notified (Notification 13/2020-CT and amendments)', () => {
  it('lists every threshold with its effective date', () => {
    expect(EINVOICE_THRESHOLDS.map((t) => [t.from, t.exceedsPaise / CR, t.notification])).toEqual([
      ['2020-10-01', 500, '13/2020-CT as amended by 61/2020-CT'],
      ['2021-01-01', 100, '88/2020-CT'],
      ['2021-04-01', 50, '05/2021-CT'],
      ['2022-04-01', 20, '01/2022-CT'],
      ['2022-10-01', 10, '17/2022-CT'],
      ['2023-08-01', 5, '10/2023-CT']
    ])
  })

  it('switches threshold exactly on each effective date', () => {
    expect(einvoiceThresholdOn('2020-09-30')).toBeUndefined()
    const cases: [string, string, number, number][] = [
      ['2020-10-01', '2020-12-31', 500, 100],
      ['2021-01-01', '2021-03-31', 100, 50],
      ['2021-04-01', '2022-03-31', 50, 20],
      ['2022-04-01', '2022-09-30', 20, 10],
      ['2022-10-01', '2023-07-31', 10, 5]
    ]
    for (const [first, dayBefore, now, next] of cases) {
      expect(einvoiceThresholdOn(first)!.exceedsPaise).toBe(now * CR)
      expect(einvoiceThresholdOn(dayBefore)!.exceedsPaise).toBe(now * CR)
      expect(einvoiceThresholdOn(addOne(dayBefore))!.exceedsPaise).toBe(next * CR)
    }
    expect(einvoiceThresholdOn('2026-10-17')!.exceedsPaise).toBe(5 * CR)
  })

  it('every source is an official text, read on a date', () => {
    for (const s of EINVOICE_APPLICABILITY_SOURCES) {
      expect(s.url).toMatch(/^https:\/\/(gstcouncil\.gov\.in|taxinformation\.cbic\.gov\.in|www\.mahagst\.gov\.in)\//)
      expect(s.accessed).toBe('2026-10-17')
    }
    expect(EINVOICE_APPLICABILITY_UNVERIFIED.length).toBeGreaterThan(0)
  })
})

function addOne(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

describe('einvoiceApplicability', () => {
  it('only a regular registration e-invoices', () => {
    for (const t of ['composition', 'unregistered'] as const) {
      expect(einvoiceApplicability({ gstRegistrationType: t, turnover: { years: [{ fy: '2024-25', paise: 900 * CR }] } }, '2026-10-17')).toEqual({ required: false, reason: 'not_regular' })
    }
  })

  it('no turnover entered → nothing decided', () => {
    expect(einvoiceApplicability({ gstRegistrationType: 'regular' }, '2026-10-17')).toEqual({ required: false, reason: 'no_turnover' })
    expect(einvoiceApplicability(regular([]), '2026-10-17').reason).toBe('no_turnover')
  })

  it('"exceeds" is strict: exactly ₹5 crore is not over ₹5 crore, one paisa more is', () => {
    expect(einvoiceApplicability(regular([{ fy: '2024-25', paise: 5 * CR }]), '2026-10-17')).toEqual({ required: false, reason: 'below_threshold' })
    const r = einvoiceApplicability(regular([{ fy: '2024-25', paise: 5 * CR + 1 }]), '2026-10-17')
    expect(r).toMatchObject({ required: true, reason: 'exceeded', since: '2025-04-01', fy: '2024-25', thresholdPaise: 5 * CR, notification: '10/2023-CT' })
  })

  it('₹5 crore applies from 1 Aug 2023 for an older year over ₹5 crore (but not ₹10 crore)', () => {
    const p = regular([{ fy: '2019-20', paise: 6 * CR }])
    expect(einvoiceApplicability(p, '2023-07-31').required).toBe(false)
    expect(einvoiceApplicability(p, '2023-07-31')).toMatchObject({ reason: 'exceeded_from_later', since: '2023-08-01' })
    expect(einvoiceApplicability(p, '2023-08-01')).toMatchObject({ required: true, since: '2023-08-01', notification: '10/2023-CT' })
  })

  it('each threshold step: a turnover just over it, from a year long past, applies from that step', () => {
    const steps: [number, string, string][] = [
      [500, '2020-10-01', '13/2020-CT as amended by 61/2020-CT'],
      [100, '2021-01-01', '88/2020-CT'],
      [50, '2021-04-01', '05/2021-CT'],
      [20, '2022-04-01', '01/2022-CT'],
      [10, '2022-10-01', '17/2022-CT'],
      [5, '2023-08-01', '10/2023-CT']
    ]
    for (const [crore, from, notification] of steps) {
      const p = regular([{ fy: '2018-19', paise: crore * CR + 1 }])
      expect(einvoiceApplicability(p, addDays(from, -1)).required).toBe(false)
      expect(einvoiceApplicability(p, from)).toMatchObject({ required: true, since: from, notification, thresholdPaise: crore * CR })
    }
  })

  it('any preceding FY from 2017-18 onwards counts; 2016-17 does not', () => {
    expect(einvoiceApplicability(regular([{ fy: '2017-18', paise: 600 * CR }]), '2020-10-01')).toMatchObject({ required: true, since: '2020-10-01', fy: '2017-18' })
    expect(einvoiceApplicability(regular([{ fy: '2016-17', paise: 600 * CR }]), '2026-10-17').reason).toBe('below_threshold')
    // A later fall in turnover does not undo it ("any preceding financial year")
    expect(einvoiceApplicability(regular([{ fy: '2022-23', paise: 6 * CR }, { fy: '2024-25', paise: 1 * CR }, { fy: '2025-26', paise: 0 }]), '2026-10-17')).toMatchObject({ required: true, since: '2023-08-01', fy: '2022-23' })
  })

  it('FY crossing: the current year’s turnover counts only from the next 1 April', () => {
    const p = regular([{ fy: '2025-26', paise: 7 * CR }])
    expect(einvoiceApplicability(p, '2026-03-31')).toEqual({ required: false, reason: 'exceeded_from_later', since: '2026-04-01', fy: '2025-26', thresholdPaise: 5 * CR, notification: '10/2023-CT' })
    expect(einvoiceApplicability(p, '2026-04-01')).toMatchObject({ required: true, since: '2026-04-01' })
  })

  it('a year that crossed a higher threshold dates from that threshold, not the later lower one', () => {
    // FY 2020-21 at ₹60 cr: over ₹50 cr in force from 1 Apr 2021 = the year's next-FY start
    expect(einvoiceApplicability(regular([{ fy: '2020-21', paise: 60 * CR }]), '2026-10-17')).toMatchObject({ since: '2021-04-01', notification: '05/2021-CT' })
    // FY 2021-22 at ₹15 cr: counts from 1 Apr 2022 but ₹20 cr is in force then → from 1 Oct 2022 (₹10 cr)
    expect(einvoiceApplicability(regular([{ fy: '2021-22', paise: 15 * CR }]), '2026-10-17')).toMatchObject({ since: '2022-10-01', notification: '17/2022-CT', fy: '2021-22' })
    // Two years: the earliest date wins
    expect(einvoiceApplicability(regular([{ fy: '2023-24', paise: 800 * CR }, { fy: '2021-22', paise: 15 * CR }]), '2026-10-17')).toMatchObject({ since: '2022-10-01', fy: '2021-22' })
  })

  it('exempt registrant types are never required, whatever the turnover', () => {
    for (const e of EINVOICE_EXEMPTIONS) {
      expect(einvoiceApplicability(regular([{ fy: '2022-23', paise: 900 * CR }], { einvoiceExemption: e }), '2026-10-17')).toEqual({ required: false, reason: 'exempt', exemption: e })
    }
  })

  it('the 30-day IRP window: AATO ≥ ₹10 crore (inclusive) of the FY before, from 1 April 2025', () => {
    const at10 = regular([{ fy: '2024-25', paise: 10 * CR }])
    expect(einvoiceApplicability(at10, '2025-04-01').reportingWindowDays).toBe(30)
    expect(einvoiceApplicability(regular([{ fy: '2024-25', paise: 10 * CR - 1 }]), '2025-04-01').reportingWindowDays).toBeUndefined()
    // before 1 April 2025 the advisory's window does not apply (the ₹100 cr one is UNVERIFIED)
    expect(einvoiceApplicability(regular([{ fy: '2023-24', paise: 200 * CR }]), '2025-03-31').reportingWindowDays).toBeUndefined()
    // the FY before today's — not an older year
    expect(einvoiceApplicability(regular([{ fy: '2023-24', paise: 20 * CR }, { fy: '2024-25', paise: 6 * CR }]), '2025-06-01').reportingWindowDays).toBeUndefined()
    expect(reportingWindowApplies({ years: [{ fy: '2025-26', paise: 12 * CR }] }, '2026-04-01')).toBe(true)
    expect(reportingWindowApplies({ years: [{ fy: '2025-26', paise: 12 * CR }] }, '2026-03-31')).toBe(false)
    expect(reportingWindowApplies(null, '2026-04-01')).toBe(false)
  })

  it('IRP deadline: dated 1 April → not after 30 April (the advisory’s example)', () => {
    expect(irpLastReportingDay('2025-04-01')).toBe('2025-04-30')
    expect(irpDaysLeft('2025-04-01', '2025-04-01')).toBe(29)
    expect(irpDaysLeft('2025-04-01', '2025-04-30')).toBe(0)
    expect(irpDaysLeft('2025-04-01', '2025-05-01')).toBe(-1)
  })

  it('describes each result in the accountant screens’ words', () => {
    const d = (iso: string): string => iso
    expect(describeEinvoiceApplicability(einvoiceApplicability(regular([{ fy: '2024-25', paise: 6 * CR }]), '2026-10-17'), d)).toContain('Required since 2025-04-01')
    expect(describeEinvoiceApplicability({ required: false, reason: 'exempt', exemption: 'sez_unit' }, d)).toContain('61/2020-CT')
  })
})

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

describe('the turn-on notice (shared/compliance.ts)', () => {
  const req = einvoiceApplicability(regular([{ fy: '2024-25', paise: 6 * CR }]), '2026-10-17')
  it('shows only while required and the switch is off', () => {
    expect(einvoiceTurnOnNotice(req, false)).toEqual({ since: '2025-04-01', fy: '2024-25', thresholdPaise: 5 * CR, notification: '10/2023-CT' })
    expect(einvoiceTurnOnNotice(req, true)).toBeNull()
    expect(einvoiceTurnOnNotice(einvoiceApplicability(regular([{ fy: '2025-26', paise: 6 * CR }]), '2026-03-01'), false)).toBeNull()
  })
})

describe('gstProfile turnover (shared/gst/filing.ts)', () => {
  it('validates FY labels, integer paise and one row per year', () => {
    expect(gstTurnoverSchema.safeParse({ years: [{ fy: '2024-25', paise: 1 }] }).success).toBe(true)
    expect(gstTurnoverSchema.safeParse({ years: [{ fy: '2024-26', paise: 1 }] }).success).toBe(false)
    expect(gstTurnoverSchema.safeParse({ years: [{ fy: '2024-25', paise: 1.5 }] }).success).toBe(false)
    expect(gstTurnoverSchema.safeParse({ years: [{ fy: '2024-25', paise: -1 }] }).success).toBe(false)
    expect(gstTurnoverSchema.safeParse({ years: [{ fy: '2024-25', paise: 1 }, { fy: '2024-25', paise: 2 }] }).success).toBe(false)
    expect(gstTurnoverSchema.safeParse({ years: [], extra: 1 }).success).toBe(false)
  })

  it('a patch keeps what it leaves out and clears on null', () => {
    const before = { filing: 'quarterly' as const, turnover: { years: [{ fy: '2024-25', paise: 6 * CR }], otherGstins: true } }
    expect(applyGstProfilePatch(before, { filing: 'monthly' })).toEqual({ ...before, filing: 'monthly' })
    expect(applyGstProfilePatch(before, { turnover: null })).toEqual({ filing: 'quarterly' })
    expect(gstProfilePatchSchema.safeParse({ einvoiceExemption: 'gta' }).success).toBe(false)
    expect(applyGstProfilePatch(before, { einvoiceExemption: 'goods_transport_agency' })).toEqual({ ...before, einvoiceExemption: 'goods_transport_agency' })
  })

  it('an old profile reads as before; a malformed turnover drops alone', () => {
    expect(normalizeGstProfile({ filing: 'quarterly' })).toEqual({ filing: 'quarterly' })
    expect(normalizeGstProfile(null)).toEqual({ filing: 'monthly' })
    expect(normalizeGstProfile({ filing: 'quarterly', turnover: { years: 'x' } })).toEqual({ filing: 'quarterly' })
  })
})
