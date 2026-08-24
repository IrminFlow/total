/**
 * The migration report a CA signs (roadmap O #298).
 *
 * When a business moves its books, somebody has to be able to say — on paper, with a date and a
 * signature — that what is in the new system is what was in the old one. The app already knows
 * every fact needed for that: what was imported, when, by whom, how much was refused, and what
 * the books add up to now. What it has never done is put them on one page.
 *
 * Deliberately built from the AUDIT TRAIL rather than from whatever the import screen last had on
 * it. A report the renderer can dictate the numbers of is a report that proves nothing; this one
 * says only what the books can be made to say again tomorrow.
 */

export interface MigrationRun {
  /** When the import ran, as stamped in the audit log. */
  at: string
  userName: string | null
  appVersion: string | null
  groups: number
  ledgers: number
  units: number
  items: number
  vouchers: number
  skipped: number
  duplicates: number
  warnings: number
}

export interface MigrationReportInput {
  runs: MigrationRun[]
  /** Trial balance as on the report date, in paise. */
  totalDebit: number
  totalCredit: number
  /** Vouchers in the books right now — the number a reader can check against the day book. */
  vouchersInBooks: number
  ledgerCount: number
  /** 'YYYY-MM-DD'. */
  asOn: string
}

export interface MigrationReportRow {
  cells: string[]
  bold?: boolean
  rule?: boolean
  indent?: number
}

export interface MigrationReportBody {
  rows: MigrationReportRow[]
  /** Set when the imported books do not balance — the one thing that must not be signed off
   *  quietly. */
  outOfBalance: number
  footNote: string
}

const SIGN_OFF =
  'Prepared from the application’s own audit trail. The figures above are the books as they stand on the ' +
  'date shown and can be reproduced from the Trial Balance at any time.\n\n' +
  'Migration reviewed by ______________________________    Membership no. ______________    ' +
  'Date ____________    Signature ______________________'

/**
 * Shape the report. Pure: takes the facts, returns the rows.
 *
 * `formatMoney` is injected rather than imported so this module makes no assumption about how
 * paise are rendered — the same reason every other report builder here does it.
 */
export function buildMigrationReport(
  input: MigrationReportInput,
  formatMoney: (paise: number) => string
): MigrationReportBody {
  const rows: MigrationReportRow[] = []

  rows.push({ cells: ['Imports run', '', ''], bold: true })
  if (input.runs.length === 0) {
    // Said plainly rather than left blank: a report with an empty table looks like a report that
    // failed to load, and this one may be the only record that no import ever happened.
    rows.push({ cells: ['No import has been run against this company.', '', ''], indent: 1 })
  }
  for (const run of input.runs) {
    rows.push({
      cells: [`${run.at}${run.userName ? ` — ${run.userName}` : ''}`, 'Vouchers imported', String(run.vouchers)],
      indent: 1
    })
    rows.push({ cells: ['', 'Ledgers / groups / units / items', `${run.ledgers} / ${run.groups} / ${run.units} / ${run.items}`], indent: 1 })
    if (run.duplicates > 0) {
      rows.push({
        cells: ['', 'Already present, not imported again', String(run.duplicates)],
        indent: 1
      })
    }
    if (run.skipped > 0) {
      rows.push({ cells: ['', 'Refused (see warnings at the time)', String(run.skipped)], indent: 1 })
    }
    if (run.appVersion) rows.push({ cells: ['', 'Software version', run.appVersion], indent: 1 })
  }

  const totals = input.runs.reduce(
    (sum, run) => ({
      vouchers: sum.vouchers + run.vouchers,
      skipped: sum.skipped + run.skipped,
      duplicates: sum.duplicates + run.duplicates
    }),
    { vouchers: 0, skipped: 0, duplicates: 0 }
  )
  rows.push({ cells: ['Total imported', 'Vouchers', String(totals.vouchers)], bold: true, rule: true })
  if (totals.skipped > 0) rows.push({ cells: ['', 'Refused in total', String(totals.skipped)] })
  if (totals.duplicates > 0) rows.push({ cells: ['', 'Recognised as already imported', String(totals.duplicates)] })

  rows.push({ cells: ['The books as they stand', '', ''], bold: true, rule: true })
  rows.push({ cells: ['', `Vouchers in the books on ${input.asOn}`, String(input.vouchersInBooks)], indent: 1 })
  rows.push({ cells: ['', 'Ledgers', String(input.ledgerCount)], indent: 1 })
  rows.push({ cells: ['', 'Trial balance — debit', formatMoney(input.totalDebit)], indent: 1 })
  rows.push({ cells: ['', 'Trial balance — credit', formatMoney(input.totalCredit)], indent: 1 })

  const outOfBalance = input.totalDebit - input.totalCredit
  rows.push({
    cells: [
      outOfBalance === 0 ? 'Balanced' : 'OUT OF BALANCE',
      outOfBalance === 0 ? 'Debits equal credits' : 'Difference',
      outOfBalance === 0 ? '—' : formatMoney(Math.abs(outOfBalance))
    ],
    bold: true,
    rule: true
  })

  const footNote =
    outOfBalance === 0
      ? SIGN_OFF
      : // Never buried in a footnote of caveats: a set of books that does not balance is the one
        // thing nobody should be asked to sign, and the sentence has to be the first one read.
        `THE BOOKS DO NOT BALANCE. The difference is ${formatMoney(Math.abs(outOfBalance))}. ` +
        `This must be resolved before the migration is signed off.\n\n${SIGN_OFF}`

  return { rows, outOfBalance, footNote }
}
