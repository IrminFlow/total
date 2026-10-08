/**
 * Where the WP 5.5 assistants' rules come from (the sourcing rule: tax rules are never written
 * from memory). Each entry names the official text read, the URL and the date; `verified: false`
 * marks what could not be confirmed against an official text — those are listed in
 * ASSISTANT_UNVERIFIED and shown on the Assistants screen.
 *
 * The CBIC texts below were read on 2026-10-08 (taxinformation.cbic.gov.in, the CBIC tax
 * information portal). The deposit due dates for TDS / TCS reuse the WP 3.2 / 3.3 sourced helpers
 * (src/shared/tdsInterest.ts depositDueDate, src/shared/tcs.ts tcsDepositDueDate) — not repeated.
 */

export interface AssistantSource {
  id: string
  title: string
  url: string
  accessed: string
  verified: boolean
  /** The words relied on, quoted. */
  quote?: string
  note?: string
}

const ACCESSED = '2026-10-08'

export const ASSISTANT_SOURCES = {
  s16_2aa: {
    id: 's16_2aa',
    title: 'Section 16(2)(aa) CGST Act — ITC only when the supplier has furnished the invoice / debit note and it is communicated to the recipient',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter5/section16_v1.00.html',
    accessed: ACCESSED,
    verified: true,
    quote:
      '(aa) the details of the invoice or debit note referred to in clause (a) has been furnished by the supplier in the statement of outward supplies and such details have been communicated to the recipient of such invoice or debit note in the manner specified under section 37'
  },
  s16_4: {
    id: 's16_4',
    title: 'Section 16(4) CGST Act — time limit for taking ITC (30 November after the FY, or the annual return if earlier)',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter5/section16_v1.00.html',
    accessed: ACCESSED,
    verified: true,
    quote:
      'A registered person shall not be entitled to take input tax credit in respect of any invoice or debit note for supply of goods or services or both after the thirtieth day of November following the end of financial year to which such invoice or debit note pertains or furnishing of the relevant annual return, whichever is earlier.'
  },
  rule36_4: {
    id: 'rule36_4',
    title: 'Rule 36(4) CGST Rules — no ITC unless furnished in GSTR-1 / IFF and communicated in FORM GSTR-2B (rule 60(7))',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter5/rule36_v1.00.html',
    accessed: ACCESSED,
    verified: true,
    quote:
      'No input tax credit shall be availed by a registered person in respect of invoices or debit notes … unless,- (a) the details of such invoices or debit notes have been furnished by the supplier in the statement of outward supplies in FORM GSTR-1 … and (b) the details of input tax credit in respect of such invoices or debit notes have been communicated to the registered person in FORM GSTR-2B under sub-rule (7) of rule 60.'
  },
  rule60_7: {
    id: 'rule60_7',
    title: 'Rule 60(7) CGST Rules — GSTR-2B for a month carries what suppliers furnished between the previous and the current GSTR-1 due dates',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter8/rule60_v1.00.html',
    accessed: ACCESSED,
    verified: true,
    quote:
      'An auto-generated statement containing the details of input tax credit shall be made available to the registered person in FORM GSTR-2B, for every month … (i) the details of outward supplies furnished by his supplier … in FORM GSTR-1, between the day immediately after the due date of furnishing of FORM GSTR-1 for the previous month to the due date of furnishing of FORM GSTR-1 for the month',
    note: 'Why an invoice can sit in a later month’s 2B than its date: the "period differs" category.'
  },
  s37_1: {
    id: 's37_1',
    title: 'Section 37(1) CGST Act — GSTR-1 "on or before the tenth day of the month succeeding the said tax period", extendable by notification',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter9/section37_v1.00.html',
    accessed: ACCESSED,
    verified: true,
    quote: 'the details of outward supplies of goods or services or both effected during a tax period on or before the tenth day of the month succeeding the said tax period'
  },
  gstr1_11th: {
    id: 'gstr1_11th',
    title: 'GSTR-1 due on the 11th of the next month for monthly filers (time limit extended under the proviso to s.37(1))',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter9/section37_v1.00.html',
    accessed: ACCESSED,
    verified: false,
    note: 'The 11th comes from the extending notification (Notification 83/2020-CT as understood) — the notification text itself was not read; the app’s compliance calendar (src/shared/compliance.ts) already uses the 11th.'
  },
  rule61: {
    id: 'rule61',
    title: 'Rule 61 CGST Rules — GSTR-3B by the 20th of the next month (monthly filers)',
    url: 'https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter8/rule61_v1.00.html',
    accessed: '2026-10-07',
    verified: true,
    note: 'Read for WP 3.4 (src/shared/gst/sources.ts). Quarterly (QRMP) filers’ 22nd / 24th are not modelled — the checklist assumes monthly returns.'
  },
  gstr2bJson: {
    id: 'gstr2bJson',
    title: 'GSTR-2B JSON download (GST portal: Returns → GSTR-2B → Download) — fields read: data.rtnprd, docdata.b2b[].ctin / inv[].inum / idt / val / items[].txval / iamt / camt / samt / csamt, docdata.cdnr[].nt[].nt_num / nt_dt / typ',
    url: 'https://tutorial.gst.gov.in/userguide/returns/index.htm#t=Manual_GSTR2B.htm',
    accessed: ACCESSED,
    verified: false,
    note: 'GSTN publishes the 2B JSON schema only on the API developer portal (login); the field names are the ones the WP 3.4 parser (src/shared/gst/recon2b.ts) reads from real downloads. The user-guide page did not load (HTTP 404) on 2026-10-08.'
  }
} satisfies Record<string, AssistantSource>

export type AssistantSourceId = keyof typeof ASSISTANT_SOURCES

export const ASSISTANT_UNVERIFIED: { id: string; text: string; sources: AssistantSourceId[] }[] = [
  { id: 'gstr1-11th', text: 'GSTR-1 due on the 11th (monthly) rests on the extending notification, not read here; quarterly filers are not modelled.', sources: ['gstr1_11th', 's37_1'] },
  { id: 'gstr3b-qrmp', text: 'GSTR-3B due on the 20th applies to monthly filers; QRMP due dates (22nd / 24th) are not modelled.', sources: ['rule61'] },
  { id: 'gstr2b-schema', text: 'The GSTR-2B JSON field names follow real downloads; the official schema (API portal) was not read.', sources: ['gstr2bJson'] },
  { id: '2b-actions', text: 'Suggested 2B actions (record the purchase, debit note for an overstated entry, follow up the supplier) are bookkeeping suggestions, not tax advice — the ITC conditions are s.16(2)(aa) and rule 36(4).', sources: ['s16_2aa', 'rule36_4'] }
]

export const sourcesOf = (ids: readonly AssistantSourceId[]): AssistantSource[] => ids.map((id) => ASSISTANT_SOURCES[id])
