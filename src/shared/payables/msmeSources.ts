/**
 * Where every MSME rule in ./msme.ts comes from (WP 4.3, checked 2026-10-07). Shown on the MSME
 * report's Options drawer, so a user (or their CA) can see the basis of each figure. Items marked
 * UNVERIFIED were not read in the official text — confirm them before relying on them.
 */
export interface MsmeSource {
  rule: string
  citation: string
  url: string
  /** Date of the document read. */
  dated: string
  verified: boolean
  note?: string
}

export const MSME_SOURCES: readonly MsmeSource[] = [
  {
    rule: 'Payment deadline (agreed period, max 45 days; 15 days with no written agreement)',
    citation: 'MSMED Act 2006 (No. 27 of 2006) s.15 and s.2(b) "appointed day", Explanation (day of acceptance / deemed acceptance)',
    url: 'https://dcmsme.gov.in/MSMED2006.pdf',
    dated: '2006-06-16 (Gazette, as enacted)',
    verified: true,
    note: 'Read in the enacted text; later amendments not consolidated in that copy.'
  },
  {
    rule: 'Only micro and small enterprises are "suppliers" (medium excluded from ss.15–24)',
    citation: 'MSMED Act 2006 s.2(n)',
    url: 'https://dcmsme.gov.in/MSMED2006.pdf',
    dated: '2006-06-16',
    verified: true
  },
  {
    rule: 'Interest on late payment: compound, monthly rests, three times the RBI bank rate',
    citation: 'MSMED Act 2006 s.16 (and s.17 recovery, s.22 disclosure in audited accounts, s.23 interest not deductible)',
    url: 'https://dcmsme.gov.in/MSMED2006.pdf',
    dated: '2006-06-16',
    verified: true,
    note: 'The Act prescribes no day-count; the figure here is indicative (monthly rests, remaining days at /365).'
  },
  {
    rule: 'RBI Bank Rate 5.75 % from 7 Oct 2026 (s.16 rate 17.25 %)',
    citation: 'RBI press release 2026-2027/1264 (63rd MPC): "the MSF rate and the Bank Rate at 5.75 per cent"',
    url: 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63742',
    dated: '2026-10-07',
    verified: true
  },
  {
    rule: 'RBI Bank Rate 5.50 % from 5 Dec 2025',
    citation: 'RBI MPC 5 Dec 2025 (repo 5.25 %); confirmed in force by press release prid=62169 (6 Feb 2026, Bank Rate "remains" 5.50 %) and prid=63287 (5 Aug 2026)',
    url: 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=62169',
    dated: '2026-02-06',
    verified: true,
    note: 'The 5 Dec 2025 release itself was read only through secondary sources.'
  },
  {
    rule: 'RBI Bank Rate 5.75 % in force on 1 Oct 2025',
    citation: 'RBI press release prid=61332 (57th MPC, 1 Oct 2025)',
    url: 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=61332',
    dated: '2025-10-01',
    verified: true,
    note: 'Its start date (6 Jun 2025, repo 5.50 %) and the earlier rows (7 Feb 2025 6.50 %, 9 Apr 2025 6.25 %, 8 Feb 2023 6.75 %) are UNVERIFIED — edit them in Options if you rely on interest before Oct 2025.'
  },
  {
    rule: 'Income-tax: deduction only on actual payment when paid to a micro / small enterprise beyond the s.15 limit (to tax year 2025-26)',
    citation: 'Income-tax Act 1961 s.43B(h), inserted by Finance Act 2023 s.13 w.e.f. 1 Apr 2024 (AY 2024-25); the proviso\'s return-due-date relief does not apply to clause (h)',
    url: 'https://egazette.gov.in/WriteReadData/2023/244830.pdf',
    dated: '2023-03-31',
    verified: true
  },
  {
    rule: 'Income-tax: the same rule from tax year 2026-27',
    citation: 'Income-tax Act 2025 s.37(1) with s.37(2)(g); s.37(3) relief excludes clause (g)',
    url: 'https://egazette.gov.in/WriteReadData/2025/265620.pdf',
    dated: '2025-08-21',
    verified: true,
    note: 'Verified as enacted; any Finance Act 2026 amendment to s.37 is UNVERIFIED.'
  },
  {
    rule: 'Traders on Udyam count for priority-sector lending only',
    citation: 'MSME Ministry OM No. 5/2(2)/2021-E/P & G/Policy, 2 Jul 2021 (via RBI FAQ)',
    url: 'https://www.rbi.org.in/Scripts/FAQView.aspx?Id=84',
    dated: '2021-07-02',
    verified: true,
    note: 'That s.43B(h) therefore excludes traders is a reading of the OM, not a CBDT circular — UNVERIFIED. Mark such a supplier as not covered if your CA agrees.'
  },
  {
    rule: 'MSME Form 1: half-yearly, Apr–Sep due 31 Oct, Oct–Mar due 30 Apr',
    citation: 'Specified Companies (Furnishing of information about payment to micro and small enterprise suppliers) Order, 2019 — S.O. 368(E), 22 Jan 2019 (Companies Act 2013 s.405)',
    url: 'https://cdn.taxguru.in/wp-content/uploads/2019/01/Payment-to-micro-and-small-enterprise-suppliers-Order-2019.pdf',
    dated: '2019-01-22',
    verified: true
  },
  {
    rule: 'MSME Form 1 (revised): only companies with dues outstanding > 45 days file; per supplier: name, PAN, paid within / after 45 days, outstanding ≤ / > 45 days, reason for delay',
    citation: 'MCA amendment order S.O. 2751(E), 15 Jul 2024 (F. No. 17/6/2017-CL-V)',
    url: 'https://ca2013.com/wp-content/uploads/2024/09/Form-MSME-1_15.07.2024.pdf',
    dated: '2024-07-15',
    verified: true,
    note: 'Form content read from the Gazette pages; the S.O. number itself is from a secondary source (UNVERIFIED). The form has no Udyam or acceptance-date fields — the bill detail here is for your working.'
  },
  {
    rule: 'Udyam Registration Number format UDYAM-XX-00-0000000 (19 characters)',
    citation: 'Udyam Registration portal; registration under MSME notification S.O. 2119(E), 26 Jun 2020',
    url: 'https://udyamregistration.gov.in/Udyam_Login.aspx',
    dated: '2026-10-07 (portal)',
    verified: true,
    note: 'That XX is the state and 00 the district is UNVERIFIED (no official text says so).'
  },
  {
    rule: 'Classification limits from 1 Apr 2025: micro ≤ ₹2.5 cr investment / ₹10 cr turnover; small ≤ ₹25 cr / ₹100 cr; medium ≤ ₹125 cr / ₹500 cr',
    citation: 'MSME notification S.O. 1364(E), 21 Mar 2025 (amending S.O. 2119(E))',
    url: 'https://udyamregistration.gov.in/docs/261838_220191.pdf',
    dated: '2025-03-21',
    verified: true
  }
]

/** The Income-tax provision that carries the MSME disallowance for a financial year. */
export function disallowanceSection(fyStartYear: number): string {
  // The Income-tax Act 2025 applies from 1 April 2026 (tax year 2026-27).
  return fyStartYear >= 2026 ? 'Income-tax Act 2025 s.37(2)(g)' : 'Income-tax Act 1961 s.43B(h)'
}
