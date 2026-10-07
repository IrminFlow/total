/**
 * Where every WP 3.4 GST rule, figure and layout comes from (Phase 3 sourcing rule: nothing from
 * memory). Each entry carries the URL read and the date it was accessed; `verified: false` marks
 * an entry that rests on a secondary copy or that could not be confirmed against an official
 * text — those are listed in GST_UNVERIFIED and shown on screen next to the figure.
 *
 * All URLs accessed 2026-10-07. Figures are kept here (not inline) so they are user-visible,
 * effective-dated and easy to re-check before 1.0 (roadmap: "should be checked by a CA").
 */

export interface GstSource {
  id: string
  title: string
  url: string
  accessed: string
  /** true = read in an official text (CBIC / GSTN / GST Council / gazette) or a faithful mirror
   *  of one on a State GST site; false = secondary copy only or not confirmed. */
  verified: boolean
  note?: string
}

const ACCESSED = '2026-10-07'

export const GST_SOURCES = {
  rule80: {
    id: 'rule80', title: 'Rule 80 CGST Rules — annual return (GSTR-9 due 31 December; GSTR-9C self-certified above ₹5 crore)',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter8/rule80_v1.00.html', accessed: ACCESSED, verified: true
  },
  gstr9Form: {
    id: 'gstr9Form', title: 'FORM GSTR-9 table structure (consolidated text) as amended by Notification 13/2025-CT (17-09-2025)',
    url: 'https://gstgyaan.com/pdf/form-gstr-9.pdf', accessed: ACCESSED, verified: false,
    note: 'Consolidated form is a secondary copy; Notification 13/2025-CT read at https://gstlearn.com/wp-content/uploads/2025/09/centaltax-13-2025.pdf (CBIC original unreachable).'
  },
  n20_2024: {
    id: 'n20_2024', title: 'Notification 20/2024-CT (08-10-2024) — GSTR-9 Table 8A from GSTR-2B; rule 47A (self-invoice within 30 days)',
    url: 'https://gstcouncil.gov.in/sites/default/files/2024-10/ct-20-2024.pdf', accessed: ACCESSED, verified: true
  },
  n15_2025: {
    id: 'n15_2025', title: 'Notification 15/2025-CT — GSTR-9 exemption up to ₹2 crore aggregate turnover, FY 2024-25 onwards',
    url: 'https://taxo.online/wp-content/uploads/2025/09/centaltax-15-2025.pdf', accessed: ACCESSED, verified: false, note: 'Read in a secondary copy.'
  },
  rule45: {
    id: 'rule45', title: 'Rule 45 CGST Rules — ITC-04 by the 25th of the month after the specified period',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter5/rule45_v1.00.html', accessed: ACCESSED, verified: true
  },
  n35_2021: {
    id: 'n35_2021', title: 'Notification 35/2021-CT (24-09-2021) — ITC-04 specified period: half-yearly above ₹5 crore AATO, else annual',
    url: 'https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-35-central-tax-english-2021.pdf', accessed: ACCESSED, verified: true
  },
  itc04Form: {
    id: 'itc04Form', title: 'FORM GST ITC-04 (as substituted by Notification 39/2018-CT) — Table 4, 5A, 5B, 5C columns',
    url: 'https://gstgyaan.com/pdf/form-gst-itc-04.pdf', accessed: ACCESSED, verified: false, note: 'Form copy; GSTN manual: https://tutorial.gst.gov.in/userguide/inputtaxcredit/Manual_itc04.htm'
  },
  imsFaq: {
    id: 'imsFaq', title: 'GSTN FAQs on the Invoice Management System (22-09-2024) and revised advisory',
    url: 'https://tutorial.gst.gov.in/downloads/news/final_faqs_on_ims_22_09_2024.pdf', accessed: ACCESSED, verified: true
  },
  ims2025: {
    id: 'ims2025', title: 'GSTN advisories on IMS changes from the October 2025 tax period (pending for credit notes, one tax period)',
    url: 'https://www.mahagst.gov.in/public/uploads/gstnadvisory/1768890634_378%20Introduction%20of%20Pending%20Option%20for%20Credit%20Notes%20and%20declaration%20of%20Reversal%20amount%20in.pdf',
    accessed: ACCESSED, verified: true, note: 'State GST mirror of the GSTN advisory.'
  },
  imsOffline: {
    id: 'imsOffline', title: 'GSTN advisory on the IMS Offline Tool (23-04-2026) — JSON download / Excel tool / JSON upload',
    url: 'https://tutorial.gst.gov.in/downloads/news/advisory_on_ims_offline_tool_23rd_april_2026.pdf', accessed: ACCESSED, verified: true,
    note: 'The tool’s JSON field schema is not published — the app’s export is its own layout.'
  },
  s31: {
    id: 's31', title: 'Section 31(3)(f)/(g) CGST Act — self-invoice for supplies from unregistered suppliers; payment voucher',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter7/section31_v1.00.html', accessed: ACCESSED, verified: true
  },
  rule46: {
    id: 'rule46', title: 'Rule 46 CGST Rules — tax invoice particulars (serial ≤ 16 characters, unique per FY; (p) reverse charge)',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html', accessed: ACCESSED, verified: true
  },
  s12s13: {
    id: 's12s13', title: 'Sections 12(3) and 13(3) CGST Act — time of supply under reverse charge',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter4/section13_v1.00.html', accessed: ACCESSED, verified: true
  },
  rule37: {
    id: 'rule37', title: 'Rule 37 CGST Rules (substituted by Notification 19/2022-CT, from 01-10-2022) — reversal for non-payment within 180 days',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter5/rule37_v1.00.html', accessed: ACCESSED, verified: true
  },
  rule37A: {
    id: 'rule37A', title: 'Rule 37A CGST Rules — reversal when the supplier has not filed GSTR-3B by 30 September',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter5/rule37a_v1.00.html', accessed: ACCESSED, verified: true
  },
  rule42: {
    id: 'rule42', title: 'Rule 42 CGST Rules — common credit on inputs / input services (D1 = E/F × C2, D2 = 5% of C2, annual true-up)',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter5/rule42_v1.00.html', accessed: ACCESSED, verified: true
  },
  rule43: {
    id: 'rule43', title: 'Rule 43 CGST Rules — common credit on capital goods (Tm = Tc/60, Te = E/F × Tm)',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter5/rule43_v1.00.html', accessed: ACCESSED, verified: true
  },
  s17: {
    id: 's17', title: 'Section 17(5) CGST Act — blocked credits',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter5/section17_v1.00.html', accessed: ACCESSED, verified: true
  },
  s50: {
    id: 's50', title: 'Section 50 CGST Act — interest (rate notified: 18% p.a.)',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter10/section50_v1.00.html', accessed: ACCESSED, verified: false,
    note: 'Section text official; the notified 18% rate (Notification 13/2017-CT as amended) confirmed only in secondary sources.'
  },
  circular170: {
    id: 'circular170', title: 'Circular 170/02/2022-GST (06-07-2022) — GSTR-3B 4(B)(1) permanent reversals (rules 38/42/43, s.17(5)), 4(B)(2) reclaimable (rule 37), reclaim in 4(A)(5) + 4(D)(1)',
    url: 'https://statetax.goa.gov.in/PDF/state_notif/Circulars/No.01-2022-23-GST.pdf', accessed: ACCESSED, verified: true, note: 'Goa State mirror (Circular 01/2022-23-GST).'
  },
  rule61: {
    id: 'rule61', title: 'Rule 61 CGST Rules — GSTR-3B by the 20th (monthly)',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter8/rule61_v1.00.html', accessed: ACCESSED, verified: true
  }
} satisfies Record<string, GstSource>

export type GstSourceId = keyof typeof GST_SOURCES

/** Items implemented but NOT confirmed against an official text — shown on screen and in the
 *  WP 3.4 report. Keep in step with the code that relies on each. */
export const GST_UNVERIFIED: { id: string; text: string; sources: GstSourceId[] }[] = [
  { id: 'gstr9-layout', text: 'GSTR-9 row labels follow a consolidated secondary copy of the form plus Notification 13/2025-CT (read in a secondary copy).', sources: ['gstr9Form'] },
  { id: 'gstr9-json', text: 'No GSTR-9 offline-tool JSON schema is published — the GSTR-9 JSON export is the app’s own layout (for review, not upload).', sources: ['gstr9Form'] },
  { id: 'gstr9-exempt', text: 'GSTR-9 exemption up to ₹2 crore (Notification 15/2025-CT) read in a secondary copy.', sources: ['n15_2025'] },
  { id: 'itc04-json', text: 'No ITC-04 offline-tool JSON schema is published — the ITC-04 JSON export is the app’s own layout mirroring the form’s columns.', sources: ['itc04Form'] },
  { id: 'itc04-hsn', text: 'FORM ITC-04 has no HSN column; HSN is shown from the rule 55 challan particulars only.', sources: ['itc04Form'] },
  { id: 'ims-json', text: 'The IMS Offline Tool’s JSON schema is not published — the IMS action export is the app’s own JSON / CSV.', sources: ['imsOffline'] },
  { id: 'ims-key', text: 'An IMS record is identified by supplier GSTIN + document type + number (+ date, value) — taken from the portal views, not an official spec.', sources: ['imsFaq'] },
  { id: 's50-rate', text: 'Interest at 18% p.a. (s.50) — the notified rate was confirmed only in secondary sources; interest assumes the credit was utilised.', sources: ['s50'] },
  { id: '3b-labels', text: 'GSTR-3B 4(B)/4(D) row wording per Notification 14/2022-CT from secondary sources; their meaning is from Circular 170/02/2022-GST.', sources: ['circular170'] }
]

// ---------- sourced figures ----------

/** ITC-04 (rule 45(3) as amended by Notification 35/2021-CT). */
export const ITC04_RULES = {
  /** Half-yearly above this aggregate turnover in the preceding FY, else annual. ₹5 crore. */
  halfYearlyAboveAatoPaise: 5_00_00_000 * 100,
  /** MM-DD due dates: Apr–Sep by 25 October, Oct–Mar by 25 April, annual by 25 April. */
  h1Due: '10-25',
  h2Due: '04-25',
  annualDue: '04-25',
  sources: ['rule45', 'n35_2021', 'itc04Form'] as GstSourceId[]
}

/** GSTR-9 (rule 80; Notification 15/2025-CT). */
export const GSTR9_RULES = {
  /** MM-DD of the year after the FY ends. */
  due: '12-31',
  /** Exempt (optional) up to this aggregate turnover, FY 2024-25 onwards. ₹2 crore. */
  exemptUptoPaise: 2_00_00_000 * 100,
  /** GSTR-9C (self-certified reconciliation) above this turnover — out of scope here. ₹5 crore. */
  gstr9cAbovePaise: 5_00_00_000 * 100,
  sources: ['rule80', 'gstr9Form', 'n15_2025'] as GstSourceId[]
}

/** Self-invoice on reverse charge (s.31(3)(f); rule 47A; rule 46(b)). */
export const SELF_INVOICE_RULES = {
  /** Rule 47A: within 30 days from the date of receipt of the supply (from 01-11-2024). */
  dueDays: 30,
  effectiveFrom: '2024-11-01',
  /** Rule 46(b): consecutive serial, at most 16 characters, unique for the FY. */
  maxNumberLength: 16,
  sources: ['s31', 'rule46', 'n20_2024', 's12s13'] as GstSourceId[]
}

/** Rule 37 / s.50 interest. */
export const RULE37_RULES = {
  /** Reverse when not paid within 180 days of the invoice date. */
  days: 180,
  /** Interest, % p.a. (s.50; rate UNVERIFIED — see GST_UNVERIFIED 's50-rate'). */
  interestPctPa: 18,
  sources: ['rule37', 's50', 'circular170'] as GstSourceId[]
}

/** Rule 42 / 43. */
export const RULE42_RULES = {
  /** D2 — 5% of common credit attributed to non-business use (rule 42(1)(i)), only when the
   *  user says inputs are partly used for non-business purposes. */
  nonBusinessPct: 5,
  /** Rule 43: useful life of capital goods, months (Tm = Tc / 60). */
  capitalGoodsLifeMonths: 60,
  sources: ['rule42', 'rule43'] as GstSourceId[]
}

export function sourceList(ids: readonly GstSourceId[]): GstSource[] {
  return ids.map((id) => GST_SOURCES[id])
}
