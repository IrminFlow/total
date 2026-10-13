// WP 8.3: how often a regular GST registration files GSTR-1 (company meta `gstProfile`, written by
// setup and Settings; `gstProfile:set`, audited as a company update). Missing = monthly — every
// company before WP 8.3 keeps the dates it always had.
//
// Sources (accessed 2026-10-13):
//  - Notification 83/2020-Central Tax (10 Nov 2020, in force 1 Jan 2021), issued under the proviso
//    to s.37(1) CGST Act: GSTR-1 by the eleventh day of the following month for monthly filers and,
//    for registered persons who opted for quarterly furnishing under the proviso to rule 59(1)
//    (QRMP), "the thirteenth day of the month succeeding such tax period" (the quarter). Read in
//    the ICMAI copy: https://icmai.in/upload/Taxation/Top_Stories/ITN/ITN_12012021_83.pdf.filepart
//  - Rule 59 CGST Rules as substituted by Notification 82/2020-CT (QRMP, the invoice furnishing
//    facility for the first two months of a quarter). UNVERIFIED — wording not re-read here.
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
  'Rule 59 (QRMP, invoice furnishing facility) as substituted by Notification 82/2020-CT — not re-read in an official copy',
  'Amendments to Notification 83/2020-CT after 09/2024-CT, and one-off extensions (e.g. the 15 Jan 2025 date for Oct–Dec 2024), are not modelled',
  'Quarterly GSTR-3B (22nd / 24th by state) and the monthly PMT-06 payment under QRMP are not modelled — GSTR-3B is still listed monthly on the 20th'
]
