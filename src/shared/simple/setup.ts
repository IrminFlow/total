// The setup wizard's answers (WP 8.3, plan 2026-10-13 §4) and what they mean for the company.
// Pure: the schema `simple:setup` parses, the per-step checks the wizard shows under each field,
// and the mapping to CompanyInfo / features / meta `ui` the setup service writes.
//
// GST (§4.2): regular → GSTIN required + filing frequency; composition → GSTIN required too (a
// composition dealer is a registered person under s.10, and rule 49 prints the GSTIN on the bill of
// supply); "no" and "not sure" → unregistered (not sure is treated as no,
// with a "you can change this later" note and a Home card in WP 8.6). The registration takes
// effect from the start date (`gstRegistrationSince`), and the WP 8.0 rule (shared/gst/
// registration.ts) does the rest: only a regular registration charges GST.
import { z } from 'zod'
import { gstinSchema, isoDate, stateCodeSchema } from '../schemas'
import { validateGstin } from '../gst/validate'
import { GST_FILING_FREQUENCIES, type GstProfile } from '../gst/filing'
import { fyFromStartYear, fyOf } from '../dates'
import type { CompanyInfo } from '../domain'
import type { CompanyFeatures } from '../features'
import { UI_GST_ANSWERS, UI_MODES, type UiSettings } from './uiMode'
import { BUSINESS_TYPES, presetFeatures, type BusinessType } from './presets'

export type GstAnswer = (typeof UI_GST_ANSWERS)[number]

export const simpleSetupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    stateCode: stateCodeSchema,
    businessType: z.enum(BUSINESS_TYPES),
    gst: z.enum(UI_GST_ANSWERS),
    gstin: gstinSchema.nullable().default(null),
    filing: z.enum(GST_FILING_FREQUENCIES).nullable().default(null),
    stock: z.boolean(),
    /** The first day the books record (ISO). Never after today (checked by the service). */
    startDate: isoDate,
    /** A new business (nothing to bring in) vs one already running (WP 8.7 asks for openings). */
    fresh: z.boolean(),
    /** "I have an accountant — show the full app" picks accountant; the default is simple (D2). */
    mode: z.enum(UI_MODES).default('simple'),
    /** "Coming from Tally? — yes": the Tally books become the chart, so the preset seeds NO
     *  accounts (a same-named preset account would otherwise shadow a Tally ledger). */
    fromTally: z.boolean().default(false)
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.gst === 'regular' || v.gst === 'composition') && !v.gstin) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'A GST registration (regular or composition) needs its GSTIN' })
    if (v.gst === 'regular' && !v.filing) ctx.addIssue({ code: 'custom', path: ['filing'], message: 'Choose how often you file GST returns' })
    if ((v.gst === 'no' || v.gst === 'not_sure') && v.gstin) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'A business not registered for GST has no GSTIN' })
    if (v.gstin && v.gstin.slice(0, 2) !== v.stateCode) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'The GSTIN belongs to another state' })
  })
export type SimpleSetupInput = z.input<typeof simpleSetupSchema>
export type SimpleSetup = z.infer<typeof simpleSetupSchema>

export function registrationFor(gst: GstAnswer): CompanyInfo['gstRegistrationType'] {
  return gst === 'regular' ? 'regular' : gst === 'composition' ? 'composition' : 'unregistered'
}

/** The company's details as setup writes them. */
export function setupCompanyInfo(s: SimpleSetup): CompanyInfo {
  const registered = s.gst === 'regular' || s.gst === 'composition'
  return {
    name: s.name,
    stateCode: s.stateCode,
    gstin: registered ? s.gstin : null,
    gstRegistrationType: registrationFor(s.gst),
    gstRegistrationSince: s.startDate,
    gstPreviousRegistrationType: null,
    address: '',
    booksFrom: fyOf(s.startDate).startYear,
    // The chosen day itself — "Today" for a continuing business is today, not 1 April (WP 8.7
    // dates the openings on it); booksFrom stays the FY that contains it (the year-opening rule).
    booksBeginDate: s.startDate,
    email: null,
    phone: null,
    pan: null,
    tan: null
  }
}

export function setupFeatures(s: SimpleSetup): CompanyFeatures {
  return presetFeatures(s.businessType, s.stock)
}

export function setupUi(s: SimpleSetup): UiSettings {
  return { mode: s.mode, setup: { businessType: s.businessType, gst: s.gst, stock: s.stock }, startedFresh: s.fresh }
}

/** Only a regular registration files GSTR-1, so only it gets a filing frequency. */
export function setupGstProfile(s: SimpleSetup): GstProfile | null {
  return s.gst === 'regular' && s.filing ? { filing: s.filing } : null
}

// ---------- the wizard's steps and their checks ----------

export const SETUP_STEPS = ['business', 'type', 'gst', 'stock', 'start', 'tally'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export type StartChoice = 'fy' | 'today' | 'earlier'

/** What the wizard holds while the user answers (strings as typed). */
export interface SetupDraft {
  name: string
  stateCode: string
  businessType: BusinessType | null
  gst: GstAnswer | null
  gstin: string
  filing: (typeof GST_FILING_FREQUENCIES)[number] | null
  stock: boolean | null
  start: StartChoice
  earlierDate: string
  fresh: boolean | null
}

export function emptySetupDraft(): SetupDraft {
  return { name: '', stateCode: '27', businessType: null, gst: null, gstin: '', filing: null, stock: null, start: 'fy', earlierDate: '', fresh: null }
}

/** The start date a choice means. */
export function startDateOf(d: Pick<SetupDraft, 'start' | 'earlierDate'>, today: string): string {
  if (d.start === 'fy') return fyFromStartYear(fyOf(today).startYear).from
  if (d.start === 'today') return today
  return d.earlierDate
}

/** Error message keys (errors.* in the en catalogue) by field, for one step. Empty = can go on. */
export type SetupErrorKey =
  | 'errors.setup.nameNeeded'
  | 'errors.setup.typeNeeded'
  | 'errors.setup.gstNeeded'
  | 'errors.setup.gstinNeeded'
  | 'errors.setup.gstinInvalid'
  | 'errors.setup.gstinOtherState'
  | 'errors.setup.filingNeeded'
  | 'errors.setup.stockNeeded'
  | 'errors.setup.startDateNeeded'
  | 'errors.setup.startInFuture'
  | 'errors.setup.freshNeeded'

export function setupStepErrors(d: SetupDraft, step: SetupStep, today: string): Partial<Record<keyof SetupDraft, SetupErrorKey>> {
  const e: Partial<Record<keyof SetupDraft, SetupErrorKey>> = {}
  if (step === 'business') {
    if (!d.name.trim()) e.name = 'errors.setup.nameNeeded'
  } else if (step === 'type') {
    if (!d.businessType) e.businessType = 'errors.setup.typeNeeded'
  } else if (step === 'gst') {
    if (!d.gst) e.gst = 'errors.setup.gstNeeded'
    const registered = d.gst === 'regular' || d.gst === 'composition'
    const gstin = d.gstin.trim().toUpperCase()
    if (registered && gstin) {
      if (!validateGstin(gstin).valid) e.gstin = 'errors.setup.gstinInvalid'
      else if (gstin.slice(0, 2) !== d.stateCode) e.gstin = 'errors.setup.gstinOtherState'
    } else if (registered) e.gstin = 'errors.setup.gstinNeeded'
    if (d.gst === 'regular' && !d.filing) e.filing = 'errors.setup.filingNeeded'
  } else if (step === 'stock') {
    if (d.stock == null) e.stock = 'errors.setup.stockNeeded'
  } else if (step === 'start') {
    if (d.start === 'earlier') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.earlierDate)) e.earlierDate = 'errors.setup.startDateNeeded'
      else if (d.earlierDate > today) e.earlierDate = 'errors.setup.startInFuture'
    }
    if (d.fresh == null) e.fresh = 'errors.setup.freshNeeded'
  }
  return e
}

/** The answers → the `simple:setup` payload (call once every step is clean). */
export function setupPayload(d: SetupDraft, today: string, mode: 'simple' | 'accountant' = 'simple', fromTally = false): SimpleSetupInput {
  const registered = d.gst === 'regular' || d.gst === 'composition'
  return {
    name: d.name.trim(),
    stateCode: d.stateCode,
    businessType: d.businessType ?? 'other',
    gst: d.gst ?? 'no',
    gstin: registered && d.gstin.trim() ? d.gstin.trim().toUpperCase() : null,
    filing: d.gst === 'regular' ? d.filing : null,
    stock: d.stock ?? false,
    startDate: startDateOf(d, today),
    fresh: d.fresh ?? true,
    mode,
    fromTally
  }
}
