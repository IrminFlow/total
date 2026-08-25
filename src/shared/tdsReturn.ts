/**
 * The quarterly TDS returns, 24Q and 26Q (roadmap #360).
 *
 * The app already holds every deduction. What it did not do was emit the quarterly return, which
 * is the step a business pays somebody else to do four times a year — and the reason it is worth
 * paying for is not the arithmetic, it is that the return needs facts the books do not naturally
 * record: which challan each deduction was paid under, the BSR code of the branch it was paid at,
 * the date of deduction as distinct from the date of payment, and a PAN for every deductee.
 *
 * So most of this file is about the seams. `validateReturn` refuses nothing and reports
 * everything, because a return that will be rejected by the FVU is better found here than after
 * an afternoon at the TIN facilitation centre.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS SAFE HERE AND WHAT IS NOT.
 *
 *   - `returnWorking`, `challanSummary` and the CSV the service writes from them are FACTS out of
 *     the books, arranged the way the NSDL Return Preparation Utility asks for them on screen.
 *     Nothing about them depends on a file format. This is the part to rely on.
 *
 *   - `toFlatFile` writes the '^'-separated e-TDS text file that the FVU validates. The RECORD
 *     LAYOUT is published by Protean eGov Technologies (formerly NSDL) in a "File Format" workbook
 *     revised most quarters.
 *     ** THE LAYOUT THIS FILE USED TO CARRY WAS WRONG. ** It was written from memory: an 18-field
 *     File Header instead of 18 in a completely different order, an 18-field Batch Header where the
 *     real one has 72, a 16-field Challan Detail against 41, a 17-field Deductee Detail against 54,
 *     and '194C' written into a Section field that wants the three-character code '94C'. A file in
 *     that shape does not fail the FVU on a technicality; it fails on the first delimiter count.
 *     `FILE_FORMAT` below is now read out of the published workbooks — see `FILE_FORMAT.source`.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THE FLAT FILE IS AND IS NOT, NOW THAT THE LAYOUT IS RIGHT.
 *
 * The layout is checked. The FILE IS STILL NOT FILEABLE, and that is not the same thing. A regular
 * statement's Batch Header has mandatory fields these books have never held — the deductor's State
 * code and PIN, the responsible person's own PAN, address, State, PIN and mobile number, the
 * deductor category code, whether the address changed since the last return, whether a regular
 * statement was filed for an earlier period. `toFlatFile` writes them EMPTY rather than inventing
 * them, `blankMandatoryFields` names every one it left empty, and the export stays behind an
 * acknowledgement and keeps the `.unverified.txt` name. The FVU will reject the file until a person
 * fills those in. That is the correct behaviour: the alternative is a file that validates because
 * the app made something up.
 *
 * AND THE FORMS CHANGE ON 1 APRIL 2026. Protean's own download page says the 24Q/26Q formats apply
 * up to FY 2025-26; from tax year 2026-27 the salary statement becomes FORM NUMBER 138 and the
 * non-salary statement FORM NUMBER 140, with new formats (CD drops to 30 fields, DD to 45) and a
 * new FVU. `validateReturn` refuses a quarter from FY 2026-27 onwards rather than writing a 26Q for
 * it. The 138 Q4 format is not published yet — Protean's page says "Expected to be released soon" —
 * so the Q4 salary annexure for the new regime is genuinely unknown, and this file says so instead
 * of guessing.
 *
 *   - Section numbers on the return are dated: see itAct2025.ts. A return for a quarter beginning
 *     on or after 1 April 2026 carries Income-tax Act 2025 references, and this module asks for
 *     them rather than assuming the 1961 numbers.
 *
 * CHECKED AGAINST (August 2026):
 *   - Rule 31A, Income-tax Rules 1962: quarterly statements in Form 24Q (salary) and Form 26Q
 *     (payments other than salary), due on the 31st of the month following the quarter, except
 *     the quarter ended 31 March which is due on 31 May.
 *   - Form 16A is issued within fifteen days of the due date of the statement (rule 31(3)) — see
 *     the Form 16A builder, which is where that matters.
 */

export type TdsFormCode = '24Q' | '26Q'

export interface TdsChallan {
  id: number
  /** Bank Branch Serial code — seven digits, identifies the branch the tax was paid at. */
  bsrCode: string
  /** Date the challan was tendered. */
  paidOn: string
  /** Challan serial number given by the bank, five digits. */
  serial: string
  /** Tax, surcharge, cess, interest, fee — all paise. */
  tax: number
  surcharge: number
  cess: number
  interest: number
  fee: number
  /** True for a book-adjustment (government deductor) entry, which has no BSR code. */
  bookEntry: boolean
}

export function challanTotal(c: TdsChallan): number {
  return c.tax + c.surcharge + c.cess + c.interest + c.fee
}

export interface TdsDeduction {
  entryId: number
  challanId: number | null
  deducteeName: string
  pan: string | null
  /** '01' company, '02' other than company — the deductee code the return carries. */
  deducteeCode: '01' | '02'
  /** Section reference to print, already resolved for the payment date (see itAct2025.ts). */
  sectionCode: string
  /** True when `sectionCode` is a proposed Income-tax Act 2025 reference nobody has verified. */
  sectionUnverified: boolean
  /** Date the amount was paid or credited. */
  paidOn: string
  /** Date the tax was deducted. Same as `paidOn` in these books — the deduction is posted on the
   *  voucher that creates the liability — and stated separately because the return asks for both. */
  deductedOn: string
  amountPaid: number
  tds: number
  surcharge: number
  cess: number
  /** Rate actually applied, percent. Carries the 206AA 20% where no PAN was on file. */
  rate: number
  voucherNumber: string
}

export interface TdsReturnWorking {
  form: TdsFormCode
  fyStartYear: number
  quarter: 1 | 2 | 3 | 4
  /** 'Q1 FY2026-27'. */
  label: string
  from: string
  to: string
  /** Statutory due date of the statement — rule 31A. */
  dueDate: string
  challans: TdsChallan[]
  deductions: TdsDeduction[]
  totalPaid: number
  totalTds: number
  /** Deductions not linked to any challan. The return cannot be filed while this is non-zero. */
  unlinkedTds: number
  issues: TdsReturnIssue[]
}

export interface TdsReturnIssue {
  severity: 'blocking' | 'warning'
  /** What to fix, in the words the fixer needs. */
  message: string
  /** Deduction entry ids or challan ids the issue is about, for the UI to jump to. */
  entryIds: number[]
}

/**
 * Due date of the quarterly statement under rule 31A.
 *
 * Q4 is the exception and the one people miss: 31 May, not 30 April, because the fourth quarter's
 * statement carries the annual salary annexure.
 */
export function statementDueDate(fyStartYear: number, quarter: 1 | 2 | 3 | 4): string {
  switch (quarter) {
    case 1:
      return `${fyStartYear}-07-31`
    case 2:
      return `${fyStartYear}-10-31`
    case 3:
      return `${fyStartYear + 1}-01-31`
    case 4:
      return `${fyStartYear + 1}-05-31`
  }
}

/**
 * Form 16A is due within fifteen days of the statement's due date (rule 31(3)).
 *
 * Fifteen days from the DUE date, not from the date the statement was actually filed — filing
 * late does not buy time to issue the certificate.
 */
export function form16aDueDate(fyStartYear: number, quarter: 1 | 2 | 3 | 4): string {
  const due = statementDueDate(fyStartYear, quarter)
  const d = new Date(`${due}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 15)
  return d.toISOString().slice(0, 10)
}

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/
const BSR_RE = /^\d{7}$/

export interface ReturnHeader {
  /** The deductor's TAN. Without it there is no return at all. */
  tan: string | null
  pan: string | null
  deductorName: string
  /** 'A' company, 'S' other. Only two of the many codes matter to this app's users. */
  deductorType: 'A' | 'S'
  responsiblePerson: string | null
  responsibleDesignation: string | null
  address: string
  email: string | null
  phone: string | null
}

/**
 * Everything wrong with a return, in one pass.
 *
 * Ordered blocking-first because that is the order they have to be fixed in, and because a user
 * who fixes six warnings and then discovers there is no TAN has wasted the afternoon.
 */
export function validateReturn(working: TdsReturnWorking, header: ReturnHeader): TdsReturnIssue[] {
  const issues: TdsReturnIssue[] = []

  if (!header.tan || !TAN_RE.test(header.tan)) {
    issues.push({
      severity: 'blocking',
      message: 'The company has no valid TAN on record. A TDS statement is filed against a TAN, not a PAN or a GSTIN.',
      entryIds: []
    })
  }
  if (!header.responsiblePerson) {
    issues.push({
      severity: 'blocking',
      message: 'No person responsible for deduction is named. The return requires their name and designation.',
      entryIds: []
    })
  }

  const unlinked = working.deductions.filter((d) => d.challanId === null)
  if (unlinked.length > 0) {
    issues.push({
      severity: 'blocking',
      message:
        `${unlinked.length} deduction${unlinked.length === 1 ? '' : 's'} are not linked to a challan. Every deduction ` +
        'in a statement has to sit under the challan the tax was paid with.',
      entryIds: unlinked.map((d) => d.entryId)
    })
  }

  for (const c of working.challans) {
    if (!c.bookEntry && !BSR_RE.test(c.bsrCode)) {
      issues.push({
        severity: 'blocking',
        message: `Challan paid on ${c.paidOn} has no valid seven-digit BSR code.`,
        entryIds: []
      })
    }
    const linked = working.deductions.filter((d) => d.challanId === c.id)
    const claimed = linked.reduce((s, d) => s + d.tds + d.surcharge + d.cess, 0)
    if (claimed > challanTotal(c)) {
      issues.push({
        severity: 'blocking',
        message:
          `Deductions of ${claimed} paise are linked to the challan paid on ${c.paidOn}, which is only ` +
          `${challanTotal(c)} paise. A challan cannot cover more tax than was paid with it.`,
        entryIds: linked.map((d) => d.entryId)
      })
    }
  }

  const noPan = working.deductions.filter((d) => !d.pan || !PAN_RE.test(d.pan))
  if (noPan.length > 0) {
    // Not blocking: a return can be filed with PANNOTAVBL, up to a proportion of deductees, and
    // the price is the 206AA rate rather than a rejection. But it is the single most common
    // reason a return is later revised, so it says so plainly.
    issues.push({
      severity: 'warning',
      message:
        `${noPan.length} deductee${noPan.length === 1 ? ' has' : 's have'} no valid PAN. Section 206AA forces the ` +
        'higher of the section rate or 20% on them, and the deductee cannot claim the credit until the PAN is ' +
        'reported.',
      entryIds: noPan.map((d) => d.entryId)
    })
  }

  const unverifiedSections = working.deductions.filter((d) => d.sectionUnverified)
  if (unverifiedSections.length > 0) {
    issues.push({
      severity: 'warning',
      message:
        'This quarter falls under the Income-tax Act 2025 and the section references shown are proposed rather ' +
        'than verified. Confirm them on the TDS section masters before filing.',
      entryIds: unverifiedSections.map((d) => d.entryId)
    })
  }

  if (working.deductions.length === 0) {
    issues.push({
      severity: 'warning',
      message:
        'No deductions in this quarter. A nil statement is not required where there is nothing to report, but a ' +
        'declaration on the TRACES portal is — otherwise the quarter shows as pending.',
      entryIds: []
    })
  }

  // The forms themselves change on 1 April 2026, and this is the one issue that no amount of
  // fixing the data will clear. Protean's download page states the 24Q/26Q formats apply up to
  // FY 2025-26; from tax year 2026-27 the salary statement is FORM NUMBER 138 and the non-salary
  // statement FORM NUMBER 140, with their own formats and their own FVU. Writing a 26Q for FY
  // 2026-27 produces a file for a form that no longer exists.
  if (working.fyStartYear > FILE_FORMAT.lastFyStartYear) {
    issues.push({
      severity: 'blocking',
      message:
        `Form ${working.form} does not exist for FY ${working.fyStartYear}-${String(working.fyStartYear + 1).slice(2)}. ` +
        'From tax year 2026-27 the quarterly statements are Form Number 138 (salary, replacing 24Q) and Form Number ' +
        '140 (non-salary, replacing 26Q), with a new file format and a new FVU. This build writes the 24Q/26Q ' +
        'format, which Protean states applies up to FY 2025-26 only. The figures below are still the figures; the ' +
        'file is not. (The Q4 format for Form 138 had not been published when this was written.)',
      entryIds: []
    })
  }

  // 24Q Q4 carries Annexure II — the annual salary detail, an 88-field SD record with its own
  // section-16 and Chapter VI-A children. This app does not build it, and a 24Q Q4 without it is
  // not a statement, it is half of one.
  if (working.form === '24Q' && working.quarter === 4) {
    issues.push({
      severity: 'blocking',
      message:
        'A 24Q for the fourth quarter carries Annexure II, the annual salary statement for every employee. This ' +
        'build does not produce Annexure II, so the file would be incomplete. Use the challan and deductee CSVs ' +
        'with the Return Preparation Utility for this quarter.',
      entryIds: []
    })
  }

  // The section field of a Challan Detail and a Deductee Detail record takes the three-character
  // code of Annexure 2 — '94C', not '194C'. A code with no Annexure 2 entry cannot be written, and
  // guessing one reports the deduction under a provision it was not made under.
  const unmapped = working.deductions.filter((d) => returnSectionCode(d.sectionCode) === null)
  if (unmapped.length > 0) {
    const codes = [...new Set(unmapped.map((d) => d.sectionCode))].sort()
    issues.push({
      severity: 'blocking',
      message:
        `The return has no section code for ${codes.join(', ')}. The statement carries the three-character code of ` +
        "Annexure 2 of the file format ('94C' for 194C, '4JB' for 194J(b)), not the section number. Sections 194I " +
        'and 194J have to say which limb they are — 194I(a) or 194I(b), 194J(a) or 194J(b) — because the return has ' +
        'a separate code for each and the amount does not say which.',
      entryIds: unmapped.map((d) => d.entryId)
    })
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1))
}

// ---------- the flat file ----------

/**
 * The '^'-separated e-TDS record layout, as published.
 *
 * READ IN, not remembered from. Every field name below is the "Field" column of the published
 * workbook, in the workbook's own Sr. No. order, so a person with the workbook open can check this
 * array line by line. An empty string marks a slot the format calls "Not applicable" or "Filler" —
 * the delimiter has to be there and no value may be.
 *
 * Sources, downloaded from Protean's TIN site (tinpan.proteantech.in/downloads/e-tds/):
 *   - "File Format for Non-Salary TDS File - Form 26Q - Q1 to Q4 (Version 7.8)"
 *   - "File Format for Salary TDS File - Form 24Q - Q1 to Q3 (Version 6.3)"
 *   - "File Format for Salary TDS File - Form 24Q - Q4 (Version 7.5)"
 * all revised 27 May 2025, and validated by FVU 9.5 / RPU 6.0, which the same page states apply up
 * to FY 2025-26.
 *
 * The envelope is the same for both forms: FH 18 fields, BH 72, CD 41, DD 54. What differs is the
 * File Header's File Type ('SL1' salary, 'NS1' non-salary), the Batch Header's Form Number, and the
 * MEANING of several DD slots at the same position — field 8 Deductee Code and field 26 Rate are
 * live in 26Q and Not-applicable in 24Q; field 25 Date of Deposit is the other way round.
 *
 * Rules from the workbooks' General Notes, all of which this file now obeys:
 *   Note 1  - ASCII, ".txt" extension.
 *   Note 2  - "Each Record (including last record) must start on new line and must end with a
 *             newline character. Hex Values : '0D' and '0A'." That is CRLF, on every line including
 *             the last. This file used to write a bare LF.
 *   Note 9  - "This is a ^ delimited variable field width file", so no padding.
 *   Note 10 - "The total number of delimiters ... should be one less than the total number of
 *             fields in the respective record." The same note goes on to say the File Header has 16
 *             fields. It is stale: the FH table lists 18, and every published sample file carries
 *             17 carets. The table and the samples win over the note.
 *
 * ONE RECORD TYPE IS DELIBERATELY ABSENT. 24Q Q4 additionally carries SD (Salary Detail, 88
 * fields), its S16 and C6A children, and the 94P/P16/P6A section-194P records. This app does not
 * build the annual salary annexure, so `validateReturn` refuses a 24Q Q4 rather than writing a file
 * that is missing Annexure II.
 */
export const FILE_FORMAT = {
  /**
   * Revision of the layout below.
   *
   * The leading '0-' was the marker for "not checked against anything". It is gone. What replaces
   * it names the documents; `unverifiedFormat` on the result no longer means the layout is a guess
   * — see `FlatFileResult`.
   */
  version: '26Q-7.8/24Q-6.3 (Protean, 27 May 2025)',
  source:
    'Protean eGov (formerly NSDL) File Formats: Form 26Q Q1-Q4 v7.8, Form 24Q Q1-Q3 v6.3, ' +
    'Form 24Q Q4 v7.5, all dated 27 May 2025, for FVU 9.5 / RPU 6.0, applicable up to FY 2025-26.',
  /** The last financial year (start year) these formats cover. FY 2026-27 is Form 138 and 140. */
  lastFyStartYear: 2025,
  /** Record separator. General Note 2 — CR LF, on every record including the last. */
  lineEnding: '\r\n',
  fileHeader: [
    'lineNumber', 'recordType', 'fileType', 'uploadType', 'fileCreationDate', 'fileSequenceNo',
    'uploaderType', 'tan', 'totalBatches', 'returnPreparationUtility',
    '', '', '', '', '', '', '', ''
  ],
  batchHeader: [
    'lineNumber', 'recordType', 'batchNumber', 'challanCount', 'formNumber', '', '', '',
    'previousTokenNumber', '', '', '', 'tan', '', 'deductorPan', 'assessmentYear', 'financialYear',
    'period', 'deductorName', 'deductorBranch', 'deductorAddress1', 'deductorAddress2',
    'deductorAddress3', 'deductorAddress4', 'deductorAddress5', 'deductorStateCode',
    'deductorPincode', 'deductorEmail', 'deductorStdCode', 'deductorPhone', 'deductorAddressChanged',
    'deductorType', 'responsiblePerson', 'responsibleDesignation', 'responsibleAddress1',
    'responsibleAddress2', 'responsibleAddress3', 'responsibleAddress4', 'responsibleAddress5',
    'responsibleStateCode', 'responsiblePincode', 'responsibleEmail', 'responsibleMobile',
    'responsibleStdCode', 'responsiblePhone', 'responsibleAddressChanged', 'batchTotalDeposit',
    'unmatchedChallanCount', 'salaryDetailCount', 'batchTotalGrossSalary', 'aoApproval',
    'earlierStatementFiled', '', 'stateName', 'paoCode', 'ddoCode', 'ministryName',
    'ministryNameOther', 'responsiblePan', 'paoRegistrationNo', 'ddoRegistrationNo',
    'deductorStdCodeAlt', 'deductorPhoneAlt', 'deductorEmailAlt', 'responsibleStdCodeAlt',
    'responsiblePhoneAlt', 'responsibleEmailAlt', 'ain', 'gstin', 'section194pCount',
    'batchTotalGross194p', ''
  ],
  challan: [
    'lineNumber', 'recordType', 'batchNumber', 'challanRecordNumber', 'deducteeCount',
    'nilChallanIndicator', '', '', '', '', '', 'bankChallanNo', '', 'ddoSerialNo24g', '',
    'bsrCodeOr24gReceipt', '', 'challanDate', '', '', '', 'oltasTax', 'oltasSurcharge', 'oltasCess',
    'oltasInterest', 'oltasOthers', 'oltasTotal', '', 'deducteeTotalDeposited', 'deducteeTax',
    'deducteeSurcharge', 'deducteeCess', 'deducteeTotalTds', 'interestAmount', 'othersAmount',
    'chequeOrDdNo', 'byBookEntryOrCash', 'remarks', 'fee', 'minorHead', ''
  ],
  deductee: [
    'lineNumber', 'recordType', 'batchNumber', 'challanRecordNumber', 'deducteeRecordNumber', 'mode',
    'employeeSerialNo', 'deducteeCode', '', 'deducteePan', '', 'deducteeRefNo', 'deducteeName',
    'tax', 'surcharge', 'cess', 'totalTds', '', 'totalDeposited', '', '', 'amountPaid', 'paidOn',
    'deductedOn', 'dateOfDeposit', 'rate', '', 'bookEntryOrCashIndicator', '', 'remarks1',
    'remarks2', 'remarks3', 'sectionCode', 'certificateNumber197', '', '', '', '', '', '', '', '',
    'cash194n', 'cash194nB', 'cash194nC', 'cash194nD', 'cash194nE', 'cash194nF', '', '', '', '', '',
    ''
  ]
} as const

/** Field counts asserted against the published workbooks, so a bad edit fails a test not a filing. */
export const FILE_FORMAT_FIELD_COUNTS = { fileHeader: 18, batchHeader: 72, challan: 41, deductee: 54 } as const

/**
 * Annexure 2 of the file format: "Section under which Tax has been deducted" against "Section code
 * to be used in the return".
 *
 * This is the correction with the sharpest edge. The return does NOT carry '194C'; it carries
 * '94C', three characters, and the mapping is not mechanical — 192A becomes '2AA', 194IA becomes
 * '9IA', 194LBB becomes 'LBB'. Writing the master's own code into that field produced a value the
 * FVU has never accepted.
 *
 * Only the entries reproduced in the 26Q v7.8 workbook are here, and nothing is inferred. A section
 * with no entry gets no code and `validateReturn` reports it, because a guessed three-letter code
 * is a deduction reported under the wrong provision.
 */
export const RETURN_SECTION_CODES: Record<string, string> = {
  '193': '193',
  '194': '194',
  '194A': '94A',
  '194B': '94B',
  '194BP': '4BP',
  '194BB': '4BB',
  '194C': '94C',
  '194D': '94D',
  '194EE': '4EE',
  '194F': '94F',
  '194G': '94G',
  '194H': '94H',
  '194LA': '94L',
  '194DA': '4DA',
  '194LBA': '4BA',
  '192A': '2AA',
  '194LBB': 'LBB',
  '194IA': '9IA',
  '194LBC': 'LBC',
  '194IC': '4IC',
  '194N': '94N',
  '194K': '94K',
  '194J(A)': '4JA',
  '194J(B)': '4JB',
  '194I(A)': '4IA',
  '194I(B)': '4IB',
  '194LBA(A)': 'BA1',
  '194LBA(B)': 'BA2',
  '194NF': '4NF',
  '194O': '94O',
  '194Q': '94Q',
  '194R': '94R',
  '194RP': '4RP',
  '194S': '94S',
  '194SP': '4SP',
  '194BA': '9BA',
  '194BAP': '4AP',
  '194NC': '4NC',
  '194NFT': '9FT',
  '194T': '94T'
}

/**
 * A master's section code, in the spelling `RETURN_SECTION_CODES` is keyed on.
 *
 * Parentheses are KEPT, and that is the whole point of doing this by hand rather than by stripping
 * everything that is not alphanumeric: strip the brackets from '194I(a)' and you get '194IA', which
 * is a different section — transfer of immovable property, return code '9IA', not rent on plant and
 * machinery, return code '4IA'. Two provisions collapsing onto one key is exactly how a deduction
 * gets reported under the wrong section.
 */
export function normaliseForReturn(sectionCode: string): string {
  return sectionCode
    .toUpperCase()
    .replace(/^SEC(TION)?\.?\s*/, '')
    .replace(/[^0-9A-Z()]/g, '')
}

/**
 * The three-character code a section goes into the return under, or null when there is no entry.
 *
 * Bare '194I' and bare '194J' return null deliberately rather than defaulting. Annexure 2 lists
 * 194I only "(Applicable upto FY 2012-13)"; from FY 2013-14 the return wants '4IA' for 194I(a) —
 * plant, machinery, equipment — or '4IB' for 194I(b) — land, building, furniture, fittings. It
 * lists 194J only as 194J(a) at 2% and 194J(b) at 10%. Which limb a payment falls in cannot be read
 * off the amount, so the app asks rather than picking: the master should carry '194I(a)', '194I(b)',
 * '194J(a)' or '194J(b)'.
 */
export function returnSectionCode(sectionCode: string): string | null {
  const key = normaliseForReturn(sectionCode)
  return RETURN_SECTION_CODES[key] ?? null
}

export interface FlatFileResult {
  text: string
  /**
   * True while the file must not be filed as it stands.
   *
   * It no longer means "the layout is a guess" — the layout is `FILE_FORMAT.version`, read out of
   * the published workbook. It means what `blankMandatoryFields` says: the file carries empty slots
   * in fields the format marks mandatory, because these books do not hold them. It is permanently
   * true while any of those fields exists, which is every file this app can currently write, and it
   * is what keeps the export behind an acknowledgement and named `.unverified.txt`.
   */
  unverifiedFormat: boolean
  /** The mandatory fields left empty, named as the format names them. The list to hand a person. */
  blankMandatoryFields: string[]
  lineCount: number
}

/**
 * Batch Header fields the format marks mandatory that no part of these books can supply.
 *
 * Named here rather than discovered at write time so the list is auditable against the workbook,
 * and so the UI can show it before a user spends an afternoon on the FVU.
 */
const BATCH_HEADER_UNSUPPLIED = [
  "Deductor's Branch/Division",
  "Deductor's Address - State (Annexure 1 code)",
  "Deductor's Address - Pincode",
  'Change of Address of Deductor since last Return',
  "Responsible Person's Address1",
  "Responsible Person's State (Annexure 1 code)",
  "Responsible Person's PIN",
  "Responsible Person's Email ID -1",
  'Mobile number',
  'Change of Address of Responsible person since last Return',
  'PAN of Responsible Person',
  'Whether regular statement filed for earlier period'
]

/** Paise to the rupees-with-two-decimals string the file carries. Integer arithmetic throughout. */
function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** ISO 'YYYY-MM-DD' to the 'DDMMYYYY' the file carries (General Note 8). */
function fileDate(iso: string): string {
  return `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`
}

/**
 * Serialise a quarter into the e-TDS text file.
 *
 * Every record is built as a sparse map from the field names in `FILE_FORMAT` and then flattened
 * against that array, so a field can never drift out of position: if a name is not in the layout the
 * value is silently dropped, and if a slot has no value it is written empty and the delimiter is
 * still there. That is the whole reason the layout is an array of names rather than a serialiser
 * with 72 arguments.
 *
 * Deductions are grouped under their challan and under the section within it, which is how the
 * return is structured: one Challan Detail record per (challan, section) pair, with its Deductee
 * Detail records under it. A deduction with no challan is DROPPED and reported by `validateReturn`
 * as blocking — writing it into the file under a made-up challan is how an unfileable return gets
 * filed.
 */
export function toFlatFile(working: TdsReturnWorking, header: ReturnHeader, createdOn: string): FlatFileResult {
  const lines: string[] = []
  let lineNumber = 0

  const emit = (layout: readonly string[], values: Record<string, string | number>): void => {
    lineNumber += 1
    const row = layout.map((name, i) => {
      if (i === 0) return String(lineNumber)
      if (name === '') return ''
      const v = values[name]
      return v === undefined || v === null ? '' : String(v)
    })
    lines.push(row.join('^'))
  }

  const fy = `${working.fyStartYear}${String(working.fyStartYear + 1).slice(2)}`
  const ay = `${working.fyStartYear + 1}${String(working.fyStartYear + 2).slice(2)}`
  const salary = working.form === '24Q'

  emit(FILE_FORMAT.fileHeader, {
    recordType: 'FH',
    // Annexure-free constants, straight out of the FH table: "Value should be 'NS1'" / 'SL1',
    // "Value should be R", "Value should be D".
    fileType: salary ? 'SL1' : 'NS1',
    uploadType: 'R',
    fileCreationDate: fileDate(createdOn),
    fileSequenceNo: 1,
    uploaderType: 'D',
    tan: header.tan ?? '',
    totalBatches: 1,
    returnPreparationUtility: 'Total'
  })

  emit(FILE_FORMAT.batchHeader, {
    recordType: 'BH',
    batchNumber: 1,
    challanCount: working.challans.length,
    formNumber: working.form,
    tan: header.tan ?? '',
    deductorPan: header.pan ?? '',
    assessmentYear: ay,
    financialYear: fy,
    period: `Q${working.quarter}`,
    deductorName: header.deductorName,
    deductorAddress1: header.address,
    deductorEmail: header.email ?? '',
    deductorPhone: header.phone ?? '',
    // Annexure 4 category code. 'A' Central Government and 'S' State Government are what
    // `ReturnHeader` carries; a company would be 'K'. Written through untouched — inventing a
    // category is inventing the deductor's legal form.
    deductorType: header.deductorType,
    responsiblePerson: header.responsiblePerson ?? '',
    responsibleDesignation: header.responsibleDesignation ?? '',
    batchTotalDeposit: rupees(working.challans.reduce((t, c) => t + challanTotal(c), 0)),
    // "Value should be 'N'" — the only permitted value in the AO Approval field.
    aoApproval: 'N'
  })

  let challanRecordNumber = 0
  for (const challan of working.challans) {
    const under = working.deductions.filter((d) => d.challanId === challan.id)
    const sections = [...new Set(under.map((d) => d.sectionCode))].sort()
    for (const section of sections) {
      const forSection = under.filter((d) => d.sectionCode === section)
      challanRecordNumber += 1
      const deducteeTax = forSection.reduce((t, d) => t + d.tds, 0)
      const deducteeSurcharge = forSection.reduce((t, d) => t + d.surcharge, 0)
      const deducteeCess = forSection.reduce((t, d) => t + d.cess, 0)
      const deducteeTotal = deducteeTax + deducteeSurcharge + deducteeCess

      emit(FILE_FORMAT.challan, {
        recordType: 'CD',
        batchNumber: 1,
        challanRecordNumber,
        deducteeCount: forSection.length,
        // "Value should be 'N'. In cases where no tax has been deposited in bank, value should be
        // 'Y'". This app never writes a nil challan — a challan record exists because a challan does.
        nilChallanIndicator: 'N',
        bankChallanNo: challan.bookEntry ? '' : challan.serial,
        // Field 16 is one slot for two things: the BSR code of the receiving branch for a challan,
        // or the seven-digit Form 24G receipt number for a book entry. The books hold the first.
        bsrCodeOr24gReceipt: challan.bookEntry ? '' : challan.bsrCode,
        challanDate: fileDate(challan.paidOn),
        oltasTax: rupees(challan.tax),
        oltasSurcharge: rupees(challan.surcharge),
        oltasCess: rupees(challan.cess),
        oltasInterest: rupees(challan.interest),
        oltasOthers: rupees(0),
        oltasTotal: rupees(challanTotal(challan)),
        deducteeTotalDeposited: rupees(deducteeTotal),
        deducteeTax: rupees(deducteeTax),
        deducteeSurcharge: rupees(deducteeSurcharge),
        deducteeCess: rupees(deducteeCess),
        deducteeTotalTds: rupees(deducteeTotal),
        interestAmount: rupees(challan.interest),
        othersAmount: rupees(0),
        byBookEntryOrCash: challan.bookEntry ? 'Y' : 'N',
        fee: rupees(challan.fee),
        // Annexure 7 minor head: 200 is "TDS payable by taxpayer", which is what a deductor pays.
        minorHead: '200'
      })

      forSection.forEach((d, i) => {
        const noPan = !d.pan || !PAN_RE.test(d.pan)
        emit(FILE_FORMAT.deductee, {
          recordType: 'DD',
          batchNumber: 1,
          challanRecordNumber,
          deducteeRecordNumber: i + 1,
          // "Value should be O" — the Mode field of a regular statement.
          mode: 'O',
          // Field 8 is live in 26Q and Not-applicable in 24Q; field 26 (Rate) likewise.
          deducteeCode: salary ? '' : d.deducteeCode,
          deducteePan: noPan ? 'PANNOTAVBL' : (d.pan as string),
          // "Mandatory to mention deductee reference number, in case of invalid PAN".
          deducteeRefNo: noPan ? String(d.entryId) : '',
          deducteeName: d.deducteeName,
          tax: rupees(d.tds),
          surcharge: rupees(d.surcharge),
          cess: rupees(d.cess),
          totalTds: rupees(d.tds + d.surcharge + d.cess),
          totalDeposited: rupees(d.tds + d.surcharge + d.cess),
          amountPaid: rupees(d.amountPaid),
          paidOn: fileDate(d.paidOn),
          deductedOn: fileDate(d.deductedOn),
          // "decimal precision of 4 point. E.g. if the rate is 2 then ... 2.0000".
          rate: salary ? '' : d.rate.toFixed(4),
          // Annexure 6: 'C' is deduction at a higher rate for want of a PAN, and the workbook says
          // it "is allowed only if deductee PAN quoted is structurally invalid" — which is exactly
          // when this app writes PANNOTAVBL. Every other Annexure 6 code covers a situation these
          // books do not model, so nothing else is ever written here.
          remarks1: noPan ? 'C' : '',
          sectionCode: returnSectionCode(d.sectionCode) ?? ''
        })
      })
    }
  }

  const blankMandatoryFields = [...BATCH_HEADER_UNSUPPLIED]

  return {
    text: lines.length === 0 ? '' : lines.join(FILE_FORMAT.lineEnding) + FILE_FORMAT.lineEnding,
    unverifiedFormat: blankMandatoryFields.length > 0,
    blankMandatoryFields,
    lineCount: lines.length
  }
}
