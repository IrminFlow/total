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

export const GST_FILING_FREQUENCIES = ['monthly', 'quarterly'] as const
export type GstFilingFrequency = (typeof GST_FILING_FREQUENCIES)[number]

export const gstProfileSchema = z.object({ filing: z.enum(GST_FILING_FREQUENCIES) }).strict()
export type GstProfile = z.infer<typeof gstProfileSchema>

export const DEFAULT_GST_PROFILE: GstProfile = { filing: 'monthly' }

/** Stored value → profile; missing / malformed = monthly. Never throws. */
export function normalizeGstProfile(raw: unknown): GstProfile {
  const p = gstProfileSchema.safeParse(raw)
  return p.success ? p.data : { ...DEFAULT_GST_PROFILE }
}

export const GST_FILING_UNVERIFIED: readonly string[] = [
  'Amendments to Notification 83/2020-CT (12/2021, 17/2021, 09/2024-CT, state-specific provisos) and one-off extensions (e.g. the 15 Jan 2025 date for Oct–Dec 2024) were not read and are not modelled',
  'The invoice furnishing facility (IFF) for the first two months of a quarter is not modelled',
  'Quarterly GSTR-3B is due the 22nd or 24th depending on the state — not re-read in an official text; listed on the earlier 22nd after each quarter. The monthly PMT-06 payment under QRMP is not modelled'
]
