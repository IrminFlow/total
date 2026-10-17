/**
 * Does the law require this business to e-invoice (rule 48(4) CGST Rules), and from when?
 *
 * Pure: the answer is worked out from the business profile the owner enters (company meta
 * `gstProfile.turnover` — the PAN-level aggregate turnover per financial year, and
 * `gstProfile.einvoiceExemption` — a registrant type the notification leaves out) and a date.
 * It never switches e-invoicing on: the company's switch (meta `einvoicing`, services/gst.ts
 * `einvoicingOn`) stays the owner's choice; the screens only say "E-invoicing applies to you from
 * <date> — turn it on".
 *
 * Sources — every quote below was read in the official text (accessed 2026-10-17; the GST
 * Council hosts the CBIC notifications as PDFs, the CBIC tax-information portal the rules):
 *
 *  - Notification 13/2020-Central Tax, 21 March 2020 (the principal notification):
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-13-central-tax-english-2020.pdf
 *    "…hereby notifies registered person, other than those referred to in sub-rules (2), (3), (4)
 *    and (4A) of rule 54 of the said rules, whose aggregate turnover in a financial year exceeds
 *    one hundred crore rupees, as a class of registered person who shall prepare invoice and
 *    other prescribed documents, in terms of sub-rule (4) of rule 48 of the said rules in respect
 *    of supply of goods or services or both to a registered person. 2. This notification shall
 *    come into force from the 1st October, 2020."
 *  - Notification 61/2020-CT, 30 July 2020:
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-61-central-tax-english-2020.pdf
 *    "(i) before the words “those referred to in sub-rules”, the words “a Special Economic Zone
 *    unit and” shall be inserted; (ii) for the words “one hundred crore rupees”, the words “five
 *    hundred crore rupees” shall be substituted." — so ₹500 crore from 1 October 2020.
 *  - Notification 70/2020-CT, 30 September 2020:
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-70-central-tax-english-2020.pdf
 *    "(i) for the words “a financial year”, the words and figures “any preceding financial year
 *    from 2017-18 onwards” shall be substituted; (ii) after the words “goods or services or both
 *    to a registered person”, the words “or for exports” shall be inserted."
 *  - Notification 88/2020-CT, 10 November 2020:
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-88-central-tax-english-2020.pdf
 *    "…with effect from the 1st day of January, 2021, for the words “five hundred crore rupees”,
 *    the words “one hundred crore rupees” shall be substituted."
 *  - Notification 05/2021-CT, 8 March 2021:
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-05-central-tax-english-2021.pdf
 *    "…with effect from the 1st day of April, 2021, for the words “one hundred crore rupees”, the
 *    words “fifty crore rupees” shall be substituted."
 *  - Notification 23/2021-CT, 1 June 2021:
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-23-central-tax-english-2021.pdf
 *    "…after the words “notifies registered person, other than”, the words “a government
 *    department, a local authority,” shall be inserted."
 *  - Notification 01/2022-CT, 24 February 2022 (GST Council node 4329):
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/nn_01_2022_english.pdf
 *    "…with effect from the 1st day of April, 2022, for the words “fifty crore rupees”, the words
 *    “twenty crore rupees” shall be substituted."
 *  - Notification 17/2022-CT, 1 August 2022 (node 4345):
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/17-2022-ct-eng_1_1.pdf
 *    "…with effect from the 1st day of October, 2022, for the words “twenty crore rupees”, the
 *    words “ten crore rupees” shall be substituted."
 *  - Notification 10/2023-CT, 10 May 2023 (node 4365):
 *    https://gstcouncil.gov.in/sites/default/files/2024-05/10ct_eng.pdf
 *    "…with effect from the 1st day of August, 2023, for the words “ten crore rupees”, the words
 *    “five crore rupees” shall be substituted."
 *  - Rule 54 CGST Rules (the sub-rules 13/2020 leaves out):
 *    https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule54_v1.00.html
 *    "(2) Where the supplier of taxable service is an insurer or a banking company or a financial
 *    institution, including a non-banking financial company … (3) Where the supplier of taxable
 *    service is a goods transport agency supplying services in relation to transportation of
 *    goods by road in a goods carriage … (4) Where the supplier of taxable service is supplying
 *    passenger transportation service … (4A) A registered person supplying services by way of
 *    admission to exhibition of cinematograph films in multiplex screens…"
 *
 * So, read together: a registered person (other than a SEZ unit, a government department, a local
 * authority and the rule 54(2)/(3)/(4)/(4A) suppliers) whose aggregate turnover in ANY preceding
 * financial year from 2017-18 onwards EXCEEDS the threshold in force on a date must e-invoice its
 * supplies to registered persons and exports on that date. "Exceeds" is strict — exactly ₹5 crore
 * is not over ₹5 crore; "preceding" means a year's turnover counts only from the next year's
 * 1 April.
 *
 * The 30-day reporting window is an IRP advisory, not a notification — GSTN, "Time Limit for
 * Reporting e-Invoice on the IRP Portal – Lowering of Threshold to AATO 10 Crores and Above",
 * 5 November 2024 (the GST portal's copy, as hosted by Maharashtra GST):
 *    https://www.mahagst.gov.in/public/uploads/gstnadvisory/1760531580_293%20Advisory%20Time%20Limit%20for%20Reporting%20e%20Invoice%20on%20the%20IRP%20Portal%20%20Lowering%20of%20Threshold%20to%20AATO%2010%20Crores%20and%20Above.pdf
 *    "2. Therefore, from 1st April 2025, taxpayers with an AATO of 10 crores and above would not
 *    be allowed to report e-Invoices older than 30 days from the date of reporting on IRP portals.
 *    3. This restriction would apply to all document types (Invoices/Credit Notes/Debit Notes) for
 *    which an IRN is to be generated. 4. For example, if an invoice is dated 1st April 2025, it
 *    cannot be reported after 30th April 2025. … 5. … there would be no such reporting
 *    restriction on taxpayers with an AATO of less than 10 crores as of now."
 *    The page states the date (1 April 2025), so that date is the advisory's own; what is NOT
 *    stated (which year's AATO; the earlier ₹100 crore window of the 13 Sep 2023 advisory) is in
 *    EINVOICE_APPLICABILITY_UNVERIFIED.
 */
import { z } from 'zod'
import { addDaysISO, fyOf } from '../dates'
import type { GstSource } from './sources'

const CRORE_PAISE = 1_000_000_000 // ₹1 crore = 1,00,00,000 rupees = 10^9 paise

export const EINVOICE_EXEMPTIONS = [
  'sez_unit',
  'government_department',
  'local_authority',
  'insurer_bank_fi',
  'goods_transport_agency',
  'passenger_transport',
  'cinema_multiplex'
] as const
export type EinvoiceExemption = (typeof EINVOICE_EXEMPTIONS)[number]

/** The words the accountant screen shows for each exemption (with the text it comes from). */
export const EINVOICE_EXEMPTION_LABELS: Record<EinvoiceExemption, { label: string; source: string }> = {
  sez_unit: { label: 'A Special Economic Zone unit', source: 'Notification 61/2020-CT' },
  government_department: { label: 'A government department', source: 'Notification 23/2021-CT' },
  local_authority: { label: 'A local authority', source: 'Notification 23/2021-CT' },
  insurer_bank_fi: { label: 'An insurer, banking company or financial institution (incl. an NBFC)', source: 'rule 54(2)' },
  goods_transport_agency: { label: 'A goods transport agency (goods by road)', source: 'rule 54(3)' },
  passenger_transport: { label: 'Passenger transportation service', source: 'rule 54(4)' },
  cinema_multiplex: { label: 'Admission to films in multiplex screens', source: 'rule 54(4A)' }
}

/** 'YYYY-YY' — the FY label shared/dates.ts writes (fyFromStartYear). */
const FY_RE = /^(\d{4})-(\d{2})$/
export function isFyLabel(s: string): boolean {
  const m = FY_RE.exec(s)
  return !!m && (Number(m[1]) + 1) % 100 === Number(m[2])
}
const fyStartYear = (label: string): number => Number(label.slice(0, 4))

/** meta `gstProfile.turnover`: the PAN-level aggregate turnover the owner enters per FY. */
export const gstTurnoverSchema = z
  .object({
    years: z
      .array(
        z
          .object({
            fy: z.string().refine(isFyLabel, 'Financial year as 2024-25'),
            /** Aggregate turnover of the PAN (every GSTIN together), integer paise. */
            paise: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
          })
          .strict()
      )
      .max(40)
      .refine((ys) => new Set(ys.map((y) => y.fy)).size === ys.length, 'Each financial year once'),
    /** The same PAN has other GSTINs (the figures must be all of them together). */
    otherGstins: z.boolean().optional()
  })
  .strict()
export type GstTurnover = z.infer<typeof gstTurnoverSchema>

export interface EinvoiceThreshold {
  /** First day this threshold is in force. */
  from: string
  /** E-invoicing applies above (strictly) this aggregate turnover, paise. */
  exceedsPaise: number
  notification: string
  url: string
}

/** The notified thresholds, oldest first (quotes in the header). */
export const EINVOICE_THRESHOLDS: readonly EinvoiceThreshold[] = [
  { from: '2020-10-01', exceedsPaise: 500 * CRORE_PAISE, notification: '13/2020-CT as amended by 61/2020-CT', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-61-central-tax-english-2020.pdf' },
  { from: '2021-01-01', exceedsPaise: 100 * CRORE_PAISE, notification: '88/2020-CT', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-88-central-tax-english-2020.pdf' },
  { from: '2021-04-01', exceedsPaise: 50 * CRORE_PAISE, notification: '05/2021-CT', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-05-central-tax-english-2021.pdf' },
  { from: '2022-04-01', exceedsPaise: 20 * CRORE_PAISE, notification: '01/2022-CT', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/nn_01_2022_english.pdf' },
  { from: '2022-10-01', exceedsPaise: 10 * CRORE_PAISE, notification: '17/2022-CT', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/17-2022-ct-eng_1_1.pdf' },
  { from: '2023-08-01', exceedsPaise: 5 * CRORE_PAISE, notification: '10/2023-CT', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/10ct_eng.pdf' }
]

/** 70/2020-CT: "any preceding financial year from 2017-18 onwards". */
export const EINVOICE_FIRST_COUNTED_FY = 2017

/** The IRP's 30-day reporting window (GSTN advisory, 5 Nov 2024): AATO ≥ ₹10 crore, from 1 April 2025. */
export const IRP_REPORTING_WINDOW = {
  days: 30 as const,
  from: '2025-04-01',
  /** "AATO of 10 crores and above" — inclusive, unlike the notification's "exceeds". */
  atLeastPaise: 10 * CRORE_PAISE
}

export const EINVOICE_APPLICABILITY_SOURCES: GstSource[] = [
  ...EINVOICE_THRESHOLDS.map((t, i) => ({ id: `threshold${i + 1}`, title: `Notification ${t.notification} — e-invoicing above ₹${t.exceedsPaise / CRORE_PAISE} crore from ${t.from}`, url: t.url, accessed: '2026-10-17', verified: true })),
  { id: 'n13_2020', title: 'Notification 13/2020-CT — the e-invoicing class of registered persons (rule 48(4))', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-13-central-tax-english-2020.pdf', accessed: '2026-10-17', verified: true },
  { id: 'n70_2020', title: 'Notification 70/2020-CT — "any preceding financial year from 2017-18 onwards"; exports', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-70-central-tax-english-2020.pdf', accessed: '2026-10-17', verified: true },
  { id: 'n23_2021', title: 'Notification 23/2021-CT — government departments and local authorities left out', url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-23-central-tax-english-2021.pdf', accessed: '2026-10-17', verified: true },
  { id: 'rule54', title: 'Rule 54(2), (3), (4), (4A) CGST Rules — insurers / banks / FIs, GTA, passenger transport, multiplex cinema', url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule54_v1.00.html', accessed: '2026-10-17', verified: true },
  { id: 'irp30', title: 'GSTN advisory 5 Nov 2024 — IRP 30-day reporting window for AATO ≥ ₹10 crore from 1 April 2025 (an advisory, not a notification)', url: 'https://www.mahagst.gov.in/public/uploads/gstnadvisory/1760531580_293%20Advisory%20Time%20Limit%20for%20Reporting%20e%20Invoice%20on%20the%20IRP%20Portal%20%20Lowering%20of%20Threshold%20to%20AATO%2010%20Crores%20and%20Above.pdf', accessed: '2026-10-17', verified: true, note: 'The GST portal advisory as copied on the Maharashtra GST site; einvoice.gst.gov.in did not serve it.' }
]

export const EINVOICE_APPLICABILITY_UNVERIFIED: readonly string[] = [
  'Amendments to Notification 13/2020-CT after 10/2023-CT (1 August 2023) were not searched for — a later change of the ₹5 crore threshold or of the exempt classes would not be known here',
  'The 30-day IRP window: the advisory does not say WHICH year’s AATO counts — Total uses the aggregate turnover of the financial year before the invoice date, as entered',
  'The earlier 30-day window for AATO ≥ ₹100 crore (GSTN advisory of 13 September 2023, referred to by the Nov 2024 advisory) was not read — its start date is not modelled, so no countdown shows for invoices dated before 1 April 2025',
  'Other exempt classes sometimes listed in secondary sources (e.g. OIDAR suppliers, a person registered under rule 14) are not in the notifications read here and are not offered',
  'Aggregate turnover (s.2(6) CGST Act: all supplies of the PAN across India, excluding taxes) is the owner’s figure — Total never works it out from the books, which hold one GSTIN only'
]

export type EinvoiceReason =
  /** Composition / unregistered: the IRP issues IRNs to regular registrations only. */
  | 'not_regular'
  /** The owner picked an exempt registrant type. */
  | 'exempt'
  /** No turnover entered — nothing to decide on. */
  | 'no_turnover'
  /** Entered, and no year exceeds the threshold in force (now or later). */
  | 'below_threshold'
  /** A year exceeded the threshold in force on `since` (≤ the date asked). */
  | 'exceeded'
  /** A year exceeds today's threshold but only counts from a later date (the next FY). */
  | 'exceeded_from_later'

export interface EinvoiceApplicability {
  required: boolean
  /** The first day the law requires e-invoicing (≤ the date asked when `required`; later when it
   *  starts next financial year). */
  since?: string
  reason: EinvoiceReason
  /** The FY whose turnover crossed the threshold and the threshold that applied. */
  fy?: string
  thresholdPaise?: number
  notification?: string
  exemption?: EinvoiceExemption
  /** The IRP accepts an invoice only within 30 days of its date (advisory, AATO ≥ ₹10 crore). */
  reportingWindowDays?: 30
}

export interface EinvoiceProfile {
  gstRegistrationType: 'regular' | 'composition' | 'unregistered'
  turnover?: GstTurnover | null
  einvoiceExemption?: EinvoiceExemption | null
}

/** Threshold in force on `date` (undefined before 1 October 2020). */
export function einvoiceThresholdOn(date: string): EinvoiceThreshold | undefined {
  let found: EinvoiceThreshold | undefined
  for (const t of EINVOICE_THRESHOLDS) if (t.from <= date) found = t
  return found
}

/** The earliest day the law requires e-invoicing for these turnovers, with the year and
 *  threshold that make it so; null when no entered year ever exceeds a threshold. */
function firstRequiredDay(years: GstTurnover['years']): { since: string; fy: string; t: EinvoiceThreshold } | null {
  let best: { since: string; fy: string; t: EinvoiceThreshold } | null = null
  EINVOICE_THRESHOLDS.forEach((t, i) => {
    const until = EINVOICE_THRESHOLDS[i + 1]?.from // exclusive; undefined = still in force
    for (const y of years) {
      const start = fyStartYear(y.fy)
      if (start < EINVOICE_FIRST_COUNTED_FY || y.paise <= t.exceedsPaise) continue
      const counts = `${start + 1}-04-01` // "preceding": the year counts from the next FY
      const since = counts > t.from ? counts : t.from
      if (until && since >= until) continue // a lower threshold takes over first — found there
      if (!best || since < best.since) best = { since, fy: y.fy, t }
    }
  })
  return best
}

/** Aggregate turnover of the FY before `date`'s FY (the AATO the 30-day window reads), if entered. */
function previousFyTurnover(years: GstTurnover['years'], date: string): number | undefined {
  const prev = fyOf(date).startYear - 1
  return years.find((y) => fyStartYear(y.fy) === prev)?.paise
}

/** Does the 30-day IRP window apply to an invoice dated `date`? (advisory; UNVERIFIED which AATO). */
export function reportingWindowApplies(turnover: GstTurnover | null | undefined, date: string): boolean {
  if (!turnover || date < IRP_REPORTING_WINDOW.from) return false
  const aato = previousFyTurnover(turnover.years, date)
  return aato !== undefined && aato >= IRP_REPORTING_WINDOW.atLeastPaise
}

export function einvoiceApplicability(profile: EinvoiceProfile, today: string): EinvoiceApplicability {
  if (profile.gstRegistrationType !== 'regular') return { required: false, reason: 'not_regular' }
  if (profile.einvoiceExemption) return { required: false, reason: 'exempt', exemption: profile.einvoiceExemption }
  const years = profile.turnover?.years ?? []
  if (!years.length) return { required: false, reason: 'no_turnover' }
  const first = firstRequiredDay(years)
  if (!first) return { required: false, reason: 'below_threshold' }
  const facts = { since: first.since, fy: first.fy, thresholdPaise: first.t.exceedsPaise, notification: first.t.notification }
  if (first.since > today) return { required: false, reason: 'exceeded_from_later', ...facts }
  return {
    required: true,
    reason: 'exceeded',
    ...facts,
    ...(reportingWindowApplies(profile.turnover, today) ? { reportingWindowDays: IRP_REPORTING_WINDOW.days } : {})
  }
}

const crore = (paise: number): string => `₹${paise / CRORE_PAISE} crore`

/** The accountant screens' sentence for a result (English, as those screens are). */
export function describeEinvoiceApplicability(a: EinvoiceApplicability, fmtDate: (iso: string) => string): string {
  switch (a.reason) {
    case 'not_regular':
      return 'E-invoicing is for regular GST registrations only.'
    case 'exempt':
      return `Not required for this registrant type (${EINVOICE_EXEMPTION_LABELS[a.exemption!].label}): left out of Notification 13/2020-CT by ${EINVOICE_EXEMPTION_LABELS[a.exemption!].source}.`
    case 'no_turnover':
      return 'Enter the aggregate turnover per financial year to see whether e-invoicing applies.'
    case 'below_threshold':
      return 'Not required: no financial year entered exceeds the threshold in force (₹5 crore since 1 Aug 2023, Notification 10/2023-CT).'
    case 'exceeded_from_later':
      return `Required from ${fmtDate(a.since!)}: the FY ${a.fy} turnover exceeds ${crore(a.thresholdPaise!)} and counts from the next financial year (Notification ${a.notification}).`
    case 'exceeded':
      return `Required since ${fmtDate(a.since!)}: the FY ${a.fy} turnover exceeds ${crore(a.thresholdPaise!)} (Notification ${a.notification}).${a.reportingWindowDays ? ' Invoices must reach the IRP within 30 days of their date (GSTN advisory, AATO ₹10 crore and above).' : ''}`
  }
}

/** Last day the IRP accepts an invoice dated `docDate` (advisory: dated 1 April → not after 30 April). */
export function irpLastReportingDay(docDate: string): string {
  return addDaysISO(docDate, IRP_REPORTING_WINDOW.days - 1)
}

/** Days left to report an invoice to the IRP (0 = today is the last day, negative = window passed). */
export function irpDaysLeft(docDate: string, today: string): number {
  const last = Date.parse(irpLastReportingDay(docDate) + 'T00:00:00Z')
  const now = Date.parse(today + 'T00:00:00Z')
  return Math.round((last - now) / 86_400_000)
}
