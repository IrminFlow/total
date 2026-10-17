// WP 8.3: how often a regular GST registration files GSTR-1 (company meta `gstProfile`, written by
// setup and Settings; `gstProfile:set`, audited as a company update). Missing = monthly — every
// company before WP 8.3 keeps the dates it always had.
//
// Sources (accessed 2026-10-13):
//  - Notification 83/2020-Central Tax, 10 Nov 2020, in force 1 Jan 2021 — the GST Council's copy:
//    https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-83-central-tax-english-2020.pdf
//    "…extends the time limit for furnishing the details of outward supplies in FORM GSTR-1 …
//    for each of the tax periods, till the eleventh day of the month succeeding such tax period:
//    Provided that the time limit … for the class of registered persons required to furnish return
//    for every quarter under proviso to sub-section (1) of section 39 of the said Act, shall be
//    extended till the thirteenth day of the month succeeding such tax period."
//    So a quarterly filer is one filing under the proviso to s.39(1) CGST Act (QRMP), and its tax
//    period for GSTR-1 is the quarter.
//  - Later amendments to that notification (12/2021, 17/2021, 09/2024-CT and state-specific
//    provisos) were not read — UNVERIFIED below.
import { z } from 'zod'
import { EINVOICE_EXEMPTIONS, gstTurnoverSchema } from './einvoiceApplicability'

export const GST_FILING_FREQUENCIES = ['monthly', 'quarterly'] as const
export type GstFilingFrequency = (typeof GST_FILING_FREQUENCIES)[number]

/** The stored profile. To-do §4 (e-invoice applicability): `turnover` — the PAN-level aggregate
 *  turnover per FY the owner enters — and `einvoiceExemption` — a registrant type Notification
 *  13/2020-CT leaves out (shared/gst/einvoiceApplicability.ts). Both optional: absent = not
 *  entered, so every existing profile reads exactly as before. */
export const gstProfileSchema = z
  .object({
    filing: z.enum(GST_FILING_FREQUENCIES),
    turnover: gstTurnoverSchema.optional(),
    einvoiceExemption: z.enum(EINVOICE_EXEMPTIONS).optional()
  })
  .strict()
export type GstProfile = z.infer<typeof gstProfileSchema>

/** `gstProfile:set`'s payload: a patch — a key left out keeps its stored value, `null` clears an
 *  optional one (so Company details' filing picker never wipes the turnover, and back). */
export const gstProfilePatchSchema = z
  .object({
    filing: z.enum(GST_FILING_FREQUENCIES).optional(),
    turnover: gstTurnoverSchema.nullable().optional(),
    einvoiceExemption: z.enum(EINVOICE_EXEMPTIONS).nullable().optional()
  })
  .strict()
export type GstProfilePatch = z.infer<typeof gstProfilePatchSchema>

export const DEFAULT_GST_PROFILE: GstProfile = { filing: 'monthly' }

/** Stored value → profile; missing / malformed = monthly. Never throws. A malformed turnover /
 *  exemption is dropped on its own (the filing frequency survives it). */
export function normalizeGstProfile(raw: unknown): GstProfile {
  const p = gstProfileSchema.safeParse(raw)
  if (p.success) return p.data
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const filing = z.enum(GST_FILING_FREQUENCIES).safeParse(r.filing)
  const out: GstProfile = { filing: filing.success ? filing.data : DEFAULT_GST_PROFILE.filing }
  const turnover = gstTurnoverSchema.safeParse(r.turnover)
  if (turnover.success) out.turnover = turnover.data
  const exemption = z.enum(EINVOICE_EXEMPTIONS).safeParse(r.einvoiceExemption)
  if (exemption.success) out.einvoiceExemption = exemption.data
  return out
}

/** Apply a patch (absent = keep, null = clear) — key order filing, turnover, exemption. */
export function applyGstProfilePatch(before: GstProfile, patch: GstProfilePatch): GstProfile {
  const out: GstProfile = { filing: patch.filing ?? before.filing }
  const turnover = patch.turnover === undefined ? before.turnover : patch.turnover ?? undefined
  if (turnover) out.turnover = turnover
  const exemption = patch.einvoiceExemption === undefined ? before.einvoiceExemption : patch.einvoiceExemption ?? undefined
  if (exemption) out.einvoiceExemption = exemption
  return out
}

export const GST_FILING_UNVERIFIED: readonly string[] = [
  'Amendments to Notification 83/2020-CT (12/2021, 17/2021, 09/2024-CT, state-specific provisos) and one-off extensions (e.g. the 15 Jan 2025 date for Oct–Dec 2024) were not read and are not modelled',
  'The invoice furnishing facility (IFF) for the first two months of a quarter is not modelled',
  'A quarterly filer’s GSTR-1 / GSTR-3B files are prepared month by month (each file’s return period = its own month, as the monthly export writes it) and the three are put in one folder; whether the GST portal’s offline tools accept these for a quarterly (QRMP) return, or need ONE file for the quarter named by its last month, was not checked — the simple Taxes screen says to ask the CA how to upload them',
  'Quarterly GSTR-3B is the 22nd or 24th by the state of the principal place of business (rule 61(1)(ii), read 2026-10-14); a state code in neither entry of the Table (97 Other Territory, a missing state) is listed on the earlier 22nd and flagged',
  'The monthly PMT-06 payment under QRMP (rule 61(3), by the 25th) is named but its amount is not worked out',
  'Due-date extensions notified for a particular month or state (after portal outages, floods …) are not modelled — the dates are the rules’ own'
]

// ---------------------------------------------------------------------------------------------
// WP 9.9: due dates, read from the official text (CBIC tax information portal, accessed
// 2026-10-14; the portal's TLS certificate chain did not verify from this machine, so the pages
// were fetched with verification off — the text is the CBIC copy all the same):
//
//  - Rule 61(1) CGST Rules (as substituted by Notification 82/2020-CT):
//    https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter8/rule61_v1.00.html
//    "(i) sub-section (1) of section 39, for each month, or part thereof, on or before the
//    twentieth day of the month succeeding such month: (ii) proviso to sub-section (1) of section
//    39, for each quarter, or part thereof, for the class of registered persons mentioned in
//    column (2) of the Table … 1. Registered persons whose principal place of business is in the
//    States of Chhattisgarh, Madhya Pradesh, Gujarat, Maharashtra, Karnataka, Goa, Kerala, Tamil
//    Nadu, Telangana, Andhra Pradesh, the Union territories of Daman and Diu and Dadra and Nagar
//    Haveli, Puducherry, Andaman and Nicobar Islands or Lakshadweep. twenty-second day of the month
//    succeeding such quarter. 2. Registered persons whose principal place of business is in the
//    States of Himachal Pradesh, Punjab, Uttarakhand, Haryana, Rajasthan, Uttar Pradesh, Bihar,
//    Sikkim, Arunachal Pradesh, Nagaland, Manipur, Mizoram, Tripura, Meghalaya, Assam, West
//    Bengal, Jharkhand or Odisha, the Union territories of Jammu and Kashmir, Ladakh, Chandigarh
//    or Delhi. twenty-fourth day of the month succeeding such quarter."
//  - Rule 61(3): a quarterly filer pays the tax for each of the first two months of the quarter
//    "in FORM GST PMT-06, by the twenty fifth day of the month succeeding such month" — Total
//    names the date but does not work out that monthly amount (not modelled).
//  - Rule 62(1) CGST Rules (composition, s.10):
//    https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter8/rule62_v1.00.html
//    "(i) furnish a statement, every quarter … in FORM GST CMP-08, till the 18th day of the month
//    succeeding such quarter; and (ii) furnish a return for every financial year … in FORM
//    GSTR-4, till the thirtieth day of April following the end of such financial year … Provided
//    that the return in FORM GSTR-4 for a financial year from FY 2024-25 onwards shall be required
//    to be furnished by the registered person till the thirtieth day of June following the end of
//    such financial year."
//  - GSTR-1: the 11th (monthly) / 13th after the quarter (QRMP) — Notification 83/2020-CT, quoted
//    at the top of this file.
// Pure date arithmetic; the dates are the rules' own, never extensions notified for a particular
// month (not modelled — GST_FILING_UNVERIFIED).

/** State codes (GSTIN prefixes, shared/gst/states.ts) in the rule 61(1)(ii) Table, entry 1
 *  (22nd) and entry 2 (24th). 25 / 26 = Daman and Diu / Dadra and Nagar Haveli (merged as 26 in
 *  2020; both listed). 96 / 97 (Other Country / Territory) are in neither entry. */
const QRMP_3B_22ND = new Set(['22', '23', '24', '27', '29', '30', '32', '33', '36', '37', '25', '26', '34', '35', '31'])
const QRMP_3B_24TH = new Set(['02', '03', '05', '06', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '01', '38', '04', '07'])

/** The quarterly GSTR-3B day for a principal place of business in `stateCode` (rule 61(1)(ii)
 *  Table), or null when the state is in neither entry (or unknown). */
export function qrmp3bDay(stateCode: string | null | undefined): 22 | 24 | null {
  if (!stateCode) return null
  if (QRMP_3B_22ND.has(stateCode)) return 22
  if (QRMP_3B_24TH.has(stateCode)) return 24
  return null
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** The `day` of the month after 'YYYY-MM'. */
function nextMonthDay(ym: string, day: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01-${pad2(day)}` : `${y}-${pad2(m + 1)}-${pad2(day)}`
}

/** True for the last month of an Indian FY quarter (Jun / Sep / Dec / Mar). */
export const isQuarterEndMonth = (ym: string): boolean => Number(ym.slice(5, 7)) % 3 === 0

/** A return's due date; `unverified` only for a quarterly GSTR-3B whose state is in neither
 *  entry of the rule 61 Table (listed on the earlier 22nd). */
export interface ReturnDue {
  date: string
  unverified: boolean
}

/** GSTR-1 for the period ending in 'YYYY-MM': the 11th of the next month (monthly), the 13th
 *  after the quarter (quarterly; `lastMonth` is the quarter's last month). */
export function gstr1DueDate(lastMonth: string, filing: GstFilingFrequency): string {
  return nextMonthDay(lastMonth, filing === 'quarterly' ? 13 : 11)
}

/** GSTR-3B for the period ending in 'YYYY-MM': the 20th of the next month (monthly, rule
 *  61(1)(i)); the 22nd / 24th after the quarter by the state of the principal place of business
 *  (quarterly, rule 61(1)(ii)). */
export function gstr3bDueDate(lastMonth: string, filing: GstFilingFrequency, stateCode: string | null | undefined): ReturnDue {
  if (filing === 'monthly') return { date: nextMonthDay(lastMonth, 20), unverified: false }
  const day = qrmp3bDay(stateCode)
  return { date: nextMonthDay(lastMonth, day ?? 22), unverified: day == null }
}

/** PMT-06 (rule 61(3)): a quarterly filer's payment for the first or second month of a quarter,
 *  by the 25th of the next month. Null for a quarter's last month (paid with the GSTR-3B). */
export function pmt06DueDate(month: string): string | null {
  return isQuarterEndMonth(month) ? null : nextMonthDay(month, 25)
}

/** Composition (rule 62(1)(i)): CMP-08 for the quarter ending in `quarterLastMonth`, by the 18th
 *  of the next month. */
export function cmp08DueDate(quarterLastMonth: string): string {
  return nextMonthDay(quarterLastMonth, 18)
}

/** Composition (rule 62(1)(ii) + proviso): GSTR-4 for the FY starting `fyStartYear` — 30 April
 *  after it, 30 June from FY 2024-25 onwards. */
export function gstr4DueDate(fyStartYear: number): string {
  return fyStartYear >= 2024 ? `${fyStartYear + 1}-06-30` : `${fyStartYear + 1}-04-30`
}
