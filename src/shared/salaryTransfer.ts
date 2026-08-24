/**
 * The bulk salary transfer file.
 *
 * Paying salaries one transfer at a time is how a business with fifteen people spends an hour
 * every month typing account numbers into a banking portal, and how one of them eventually goes
 * to the wrong account. Every bank accepts a bulk upload; what differs is the column order and
 * the header text.
 *
 * This produces the common shape — beneficiary name, account, IFSC, amount, reference — as plain
 * CSV. It is deliberately NOT branded as any one bank's format: the formats differ in ways this
 * cannot verify without a real portal to test against, and a file labelled "HDFC format" that the
 * portal rejects is worse than an unlabelled one the user maps once. Per-bank profiles belong
 * behind a real upload that someone has actually run.
 */

export interface TransferRow {
  employeeName: string
  bankAccount: string | null
  ifsc: string | null
  /** Net pay in paise. */
  netPaise: number
}

export interface TransferFile {
  csv: string
  /** Rows written. */
  count: number
  /** Total transferred, in paise. */
  totalPaise: number
  /** Employees left out, and why — never silently dropped. */
  skipped: { employeeName: string; reason: string }[]
}

/** Rupees with two decimals from integer paise — banks reject anything else. */
function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** CSV field escaping: a beneficiary name with a comma in it must not become two columns. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export const TRANSFER_HEADERS = ['Beneficiary Name', 'Account Number', 'IFSC', 'Amount', 'Reference']

/**
 * Build the file.
 *
 * An employee with no account, no IFSC, or nothing to pay is skipped WITH a reason rather than
 * dropped. A transfer file that silently omits someone is how a person does not get paid, and the
 * business finds out from them rather than from the file.
 */
export function buildTransferFile(rows: TransferRow[], reference: string): TransferFile {
  const skipped: TransferFile['skipped'] = []
  const lines: string[] = [TRANSFER_HEADERS.join(',')]
  let totalPaise = 0
  let count = 0

  for (const row of rows) {
    if (row.netPaise <= 0) {
      skipped.push({ employeeName: row.employeeName, reason: 'nothing payable this month' })
      continue
    }
    if (!row.bankAccount?.trim()) {
      skipped.push({ employeeName: row.employeeName, reason: 'no bank account on record' })
      continue
    }
    if (!row.ifsc?.trim()) {
      skipped.push({ employeeName: row.employeeName, reason: 'no IFSC on record' })
      continue
    }
    lines.push(
      [
        csvField(row.employeeName),
        csvField(row.bankAccount.trim()),
        csvField(row.ifsc.trim().toUpperCase()),
        rupees(row.netPaise),
        csvField(reference)
      ].join(',')
    )
    totalPaise += row.netPaise
    count++
  }

  return { csv: lines.join('\n'), count, totalPaise, skipped }
}
