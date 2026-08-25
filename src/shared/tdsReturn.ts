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
 *     LAYOUT — which fields, in which order, how many of them — is published by Protean (formerly
 *     NSDL) in a File Format document that is revised most quarters.
 *     ** THE LAYOUT ENCODED IN `FILE_FORMAT` BELOW HAS NOT BEEN VERIFIED AGAINST ANY PUBLISHED
 *        FILE FORMAT DOCUMENT BY THIS AUTHOR. It is the mechanism, not the answer. **
 *     The file it produces must be run through the FVU before it goes anywhere, the UI says so,
 *     and the export is deliberately behind an acknowledgement. When somebody does check it, the
 *     fix is one array in this file rather than a rewrite.
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

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1))
}

// ---------- the flat file ----------

/**
 * The '^'-separated e-TDS record layout.
 *
 * ** UNVERIFIED — see the header of this file. ** Each entry names the fields, in order, that the
 * record is understood to carry. The serialiser is driven entirely by these arrays, so correcting
 * the layout against a published File Format document is an edit here and nowhere else.
 *
 * Fields the books cannot supply are written empty rather than filled with a plausible value.
 */
export const FILE_FORMAT = {
  /** Revision of the layout below. Bumped by whoever verifies or corrects it. */
  version: '0-unverified',
  fileHeader: ['recordType', 'lineNumber', 'batchCount', 'uploadType', 'fileFormatVersion', 'fileCreationDate'],
  batchHeader: [
    'recordType', 'lineNumber', 'batchNumber', 'challanCount', 'formCode', 'tan', 'pan',
    'financialYear', 'assessmentYear', 'quarter', 'deductorName', 'deductorType', 'deductorAddress',
    'deductorEmail', 'deductorPhone', 'responsiblePerson', 'responsibleDesignation', 'statementType'
  ],
  challan: [
    'recordType', 'lineNumber', 'batchNumber', 'challanSerialInFile', 'deducteeCount', 'sectionCode',
    'tax', 'surcharge', 'cess', 'interest', 'fee', 'total', 'bsrCode', 'challanDate', 'challanSerial',
    'bookEntryFlag'
  ],
  deductee: [
    'recordType', 'lineNumber', 'batchNumber', 'challanSerialInFile', 'deducteeSerial', 'deducteeCode',
    'pan', 'deducteeName', 'amountPaid', 'tds', 'surcharge', 'cess', 'total', 'paidOn', 'deductedOn',
    'rate', 'reasonCode'
  ]
} as const

/** Paise to the rupees-with-two-decimals string the file carries. Integer arithmetic throughout. */
function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** ISO 'YYYY-MM-DD' to the 'DDMMYYYY' the file carries. */
function fileDate(iso: string): string {
  return `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`
}

export interface FlatFileResult {
  text: string
  /** Always true while FILE_FORMAT.version starts with '0-'. Carried so no caller can lose it. */
  unverifiedFormat: boolean
  lineCount: number
}

/**
 * Serialise a quarter into the e-TDS text file.
 *
 * Deductions are grouped under their challan and under the section within it, which is how the
 * return is structured: one challan record per (challan, section) pair, with its deductees under
 * it. A deduction with no challan is DROPPED and reported by `validateReturn` as blocking —
 * writing it into the file under a made-up challan is how an unfileable return gets filed.
 */
export function toFlatFile(working: TdsReturnWorking, header: ReturnHeader, createdOn: string): FlatFileResult {
  const lines: string[] = []
  let lineNumber = 0
  const emit = (fields: (string | number)[]): void => {
    lineNumber += 1
    lines.push(fields.map(String).join('^'))
  }

  const fy = `${working.fyStartYear}${String(working.fyStartYear + 1).slice(2)}`
  const ay = `${working.fyStartYear + 1}${String(working.fyStartYear + 2).slice(2)}`

  emit(['FH', lineNumber + 1, 1, 'R', FILE_FORMAT.version, fileDate(createdOn)])
  emit([
    'BH', lineNumber + 1, 1, working.challans.length, working.form, header.tan ?? '', header.pan ?? '',
    fy, ay, `Q${working.quarter}`, header.deductorName, header.deductorType, header.address,
    header.email ?? '', header.phone ?? '', header.responsiblePerson ?? '', header.responsibleDesignation ?? '',
    'Regular'
  ])

  let challanSerialInFile = 0
  for (const challan of working.challans) {
    const under = working.deductions.filter((d) => d.challanId === challan.id)
    const sections = [...new Set(under.map((d) => d.sectionCode))].sort()
    for (const section of sections) {
      const forSection = under.filter((d) => d.sectionCode === section)
      challanSerialInFile += 1
      emit([
        'CD', lineNumber + 1, 1, challanSerialInFile, forSection.length, section,
        rupees(challan.tax), rupees(challan.surcharge), rupees(challan.cess), rupees(challan.interest),
        rupees(challan.fee), rupees(challanTotal(challan)),
        challan.bookEntry ? '' : challan.bsrCode, fileDate(challan.paidOn),
        challan.bookEntry ? '' : challan.serial, challan.bookEntry ? 'Y' : 'N'
      ])
      forSection.forEach((d, i) => {
        emit([
          'DD', lineNumber + 1, 1, challanSerialInFile, i + 1, d.deducteeCode,
          d.pan && PAN_RE.test(d.pan) ? d.pan : 'PANNOTAVBL', d.deducteeName,
          rupees(d.amountPaid), rupees(d.tds), rupees(d.surcharge), rupees(d.cess),
          rupees(d.tds + d.surcharge + d.cess), fileDate(d.paidOn), fileDate(d.deductedOn),
          d.rate.toFixed(2),
          // Reason code: 'C' is the higher-rate-for-no-PAN case under 206AA. Left empty otherwise
          // rather than guessed — the other reason codes cover situations these books do not model.
          !d.pan || !PAN_RE.test(d.pan) ? 'C' : ''
        ])
      })
    }
  }

  return {
    text: lines.join('\n') + '\n',
    unverifiedFormat: FILE_FORMAT.version.startsWith('0-'),
    lineCount: lines.length
  }
}
