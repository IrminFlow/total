import { describe, expect, it } from 'vitest'
import { upcomingDeadlines } from '../compliance'
import {
  emptySetupDraft, setupCompanyInfo, setupPayload, setupStepErrors, setupUi, simpleSetupSchema, startDateOf, type SetupDraft
} from './setup'

const TODAY = '2026-10-13'
const GSTIN_MH = '27AAPFU0939F1ZV'

const draft = (over: Partial<SetupDraft> = {}): SetupDraft => ({
  ...emptySetupDraft(), name: 'Ramesh Kirana', businessType: 'retail', gst: 'no', stock: true, fresh: true, ...over
})

describe('setup wizard checks', () => {
  it('each step names the field to fix', () => {
    expect(setupStepErrors({ ...draft(), name: '  ' }, 'business', TODAY)).toEqual({ name: 'errors.setup.nameNeeded' })
    expect(setupStepErrors({ ...draft(), businessType: null }, 'type', TODAY)).toEqual({ businessType: 'errors.setup.typeNeeded' })
    expect(setupStepErrors({ ...draft(), gst: null }, 'gst', TODAY)).toEqual({ gst: 'errors.setup.gstNeeded' })
    expect(setupStepErrors(draft({ gst: 'regular' }), 'gst', TODAY)).toEqual({ gstin: 'errors.setup.gstinNeeded', filing: 'errors.setup.filingNeeded' })
    expect(setupStepErrors(draft({ gst: 'regular', gstin: '27AAPFU0939F1ZX', filing: 'monthly' }), 'gst', TODAY)).toEqual({ gstin: 'errors.setup.gstinInvalid' })
    expect(setupStepErrors(draft({ gst: 'regular', gstin: GSTIN_MH, filing: 'monthly', stateCode: '29' }), 'gst', TODAY)).toEqual({ gstin: 'errors.setup.gstinOtherState' })
    expect(setupStepErrors(draft({ gst: 'regular', gstin: GSTIN_MH.toLowerCase(), filing: 'quarterly' }), 'gst', TODAY)).toEqual({})
    // Composition: the GSTIN may come later; "not sure" asks nothing more.
    expect(setupStepErrors(draft({ gst: 'composition' }), 'gst', TODAY)).toEqual({})
    expect(setupStepErrors(draft({ gst: 'not_sure' }), 'gst', TODAY)).toEqual({})
    expect(setupStepErrors({ ...draft(), stock: null }, 'stock', TODAY)).toEqual({ stock: 'errors.setup.stockNeeded' })
    expect(setupStepErrors(draft({ start: 'earlier', earlierDate: '' }), 'start', TODAY)).toEqual({ earlierDate: 'errors.setup.startDateNeeded' })
    expect(setupStepErrors(draft({ start: 'earlier', earlierDate: '2026-12-01' }), 'start', TODAY)).toEqual({ earlierDate: 'errors.setup.startInFuture' })
    expect(setupStepErrors({ ...draft(), fresh: null }, 'start', TODAY)).toEqual({ fresh: 'errors.setup.freshNeeded' })
  })

  it('start choices in plain words → dates', () => {
    expect(startDateOf({ start: 'fy', earlierDate: '' }, TODAY)).toBe('2026-04-01')
    expect(startDateOf({ start: 'fy', earlierDate: '' }, '2027-02-01')).toBe('2026-04-01')
    expect(startDateOf({ start: 'today', earlierDate: '' }, TODAY)).toBe(TODAY)
    expect(startDateOf({ start: 'earlier', earlierDate: '2025-07-01' }, TODAY)).toBe('2025-07-01')
  })
})

describe('setup → company', () => {
  it('unregistered and "not sure" mean no GST anywhere, from the start date', () => {
    for (const gst of ['no', 'not_sure'] as const) {
      const s = simpleSetupSchema.parse(setupPayload(draft({ gst, start: 'earlier', earlierDate: '2025-07-01' }), TODAY))
      const info = setupCompanyInfo(s)
      expect(info).toMatchObject({ gstRegistrationType: 'unregistered', gstin: null, gstRegistrationSince: '2025-07-01', gstPreviousRegistrationType: null, booksFrom: 2025 })
      expect(setupUi(s)).toEqual({ mode: 'simple', setup: { businessType: 'retail', gst, stock: true }, startedFresh: true })
    }
  })

  it('a regular registration needs its GSTIN and filing frequency; a GSTIN of another state is refused', () => {
    expect(simpleSetupSchema.safeParse(setupPayload(draft({ gst: 'regular' }), TODAY)).success).toBe(false)
    expect(simpleSetupSchema.safeParse({ ...setupPayload(draft({ gst: 'regular', gstin: GSTIN_MH, filing: 'monthly' }), TODAY), stateCode: '29' }).success).toBe(false)
    const s = simpleSetupSchema.parse(setupPayload(draft({ gst: 'regular', gstin: GSTIN_MH, filing: 'quarterly' }), TODAY, 'accountant'))
    expect(setupCompanyInfo(s)).toMatchObject({ gstRegistrationType: 'regular', gstin: GSTIN_MH, booksFrom: 2026, gstRegistrationSince: '2026-04-01' })
    expect(setupUi(s).mode).toBe('accountant')
  })

  it('a GSTIN typed before switching to "No" is dropped, never stored', () => {
    expect(setupPayload(draft({ gst: 'no', gstin: GSTIN_MH }), TODAY).gstin).toBeNull()
  })
})

describe('GSTR-1 due date follows the filing frequency', () => {
  it('monthly on the 11th; quarterly (QRMP) on the 13th after the quarter only', () => {
    const monthly = upcomingDeadlines('2026-09-20', 'regular', false, 60).filter((d) => d.form === 'GSTR-1').map((d) => d.date)
    expect(monthly).toEqual(['2026-10-11', '2026-11-11'])
    const quarterly = upcomingDeadlines('2026-09-20', 'regular', false, 60, { gstFiling: 'quarterly' }).filter((d) => d.form === 'GSTR-1')
    expect(quarterly.map((d) => [d.date, d.title])).toEqual([['2026-10-13', 'GSTR-1 — outward supplies (quarter Jul–Sep 2026)']])
    // Jan–Mar files in April, across the year end.
    expect(upcomingDeadlines('2027-04-01', 'regular', false, 20, { gstFiling: 'quarterly' }).filter((d) => d.form === 'GSTR-1').map((d) => d.date)).toEqual(['2027-04-13'])
    // GSTR-3B is unchanged (monthly 20th — quarterly 3B is UNVERIFIED / not modelled).
    expect(upcomingDeadlines('2026-09-20', 'regular', false, 30, { gstFiling: 'quarterly' }).filter((d) => d.form === 'GSTR-3B').map((d) => d.date)).toEqual(['2026-09-20', '2026-10-20'])
  })
})
