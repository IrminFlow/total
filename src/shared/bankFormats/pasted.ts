/**
 * "Copy from PDF" statement reader (WP 4.1). Total has no PDF-input library (Electron's
 * printToPDF is output-only and pdfjs-dist is not a dependency), so a PDF statement is imported
 * by selecting its text in any PDF viewer, copying, and pasting it here. No OCR: a scanned
 * (image-only) PDF has no text to copy and cannot be imported this way.
 *
 * Tolerant line parser: a transaction starts with a date (optionally followed by a value date);
 * the trailing money tokens are the amount and, usually, the running balance. Direction comes
 * from, in order: the balance moving by exactly the amount since the previous line (most
 * reliable — survives viewers that drop the empty debit/credit column), an explicit Dr/Cr marker
 * on the amount, then a single leading +/- sign. Lines with no date are narration continuations
 * (joined to the line above) unless they are page furniture ("Page 2 of 5", repeated headers).
 * Anything still ambiguous is imported as a withdrawal and counted in a warning so the preview
 * can be checked before committing.
 */
import { parseBankAmount, parseBankDate } from './quirks'
import type { DateFormat, ParsedStatement, StatementLine } from './types'

const DATE_RE = /^(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[- ][A-Za-z]{3,9}[- ,]+\d{2,4}|\d{4}-\d{2}-\d{2})\b/
const MONEY_TAIL = /\s(\(?[-+]?(?:₹|Rs\.?|INR)?\s?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})|\(?[-+]?\d+\.\d{2}\)?)\)?(\s?(?:Cr|Dr|CR|DR|C|D)\.?)?\s*$/
const FURNITURE = /^(page\s+\d+(\s+of\s+\d+)?|date\s+(narration|description|particulars)|statement of account|generated on|this is a computer generated|\*+)/i

export function parsePastedStatement(text: string, dateFormat: DateFormat = 'auto'): ParsedStatement {
  const lines: StatementLine[] = []
  const warnings: string[] = []
  let prevBalance: number | null = null
  let openingBalance: number | null = null
  let ambiguous = 0
  let lastWasTxn = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, ' ').replace(/\s{2,}/g, '  ').trim()
    if (!line) continue
    if (/^(opening|brought forward|b\/f)\b/i.test(line)) {
      const m = (' ' + line).match(MONEY_TAIL)
      const amt = m ? parseBankAmount(m[1]! + (m[2] ?? '')) : null
      if (amt) {
        prevBalance = amt.flag === 'dr' ? -Math.abs(amt.paise) : amt.paise
        openingBalance = openingBalance ?? prevBalance
      }
      lastWasTxn = false
      continue
    }
    const dm = line.match(DATE_RE)
    const date = dm ? parseBankDate(dm[1]!, dateFormat) : null
    if (!date) {
      if (FURNITURE.test(line) || /^(closing|carried forward|c\/f|total)\b/i.test(line)) {
        lastWasTxn = false
        continue
      }
      if (lastWasTxn && lines.length > 0 && !(' ' + line).match(MONEY_TAIL)) {
        const prev = lines[lines.length - 1]!
        prev.description = `${prev.description} ${line}`.replace(/\s+/g, ' ').trim()
      }
      continue
    }
    let rest = ' ' + line.slice(dm![0].length).trim()
    let valueDate: string | null = null
    const vd = rest.trim().match(DATE_RE)
    if (vd) {
      valueDate = parseBankDate(vd[1]!, dateFormat)
      if (valueDate) rest = ' ' + rest.trim().slice(vd[0].length).trim()
    }
    const amounts: { paise: number; flag: 'dr' | 'cr' | null; signed: boolean }[] = []
    for (let k = 0; k < 3; k++) {
      const m = rest.match(MONEY_TAIL)
      if (!m) break
      const parsed = parseBankAmount(m[1]! + (m[2] ?? ''))
      if (!parsed) break
      amounts.unshift({ ...parsed, signed: /^[(\-+]/.test(m[1]!) })
      rest = rest.slice(0, rest.length - m[0].length)
    }
    if (amounts.length === 0) {
      lastWasTxn = false
      continue
    }
    let amount = amounts[0]!
    let balance: number | null = null
    if (amounts.length >= 2) {
      const b = amounts[amounts.length - 1]!
      balance = b.flag === 'dr' ? -Math.abs(b.paise) : b.paise
      const moving = amounts.slice(0, -1).filter((a) => a.paise !== 0)
      amount = moving[0] ?? amounts[0]!
    }
    const size = Math.abs(amount.paise)
    let credit: boolean | null = null
    if (balance != null && prevBalance != null && Math.abs(balance - prevBalance) === size && size > 0) credit = balance > prevBalance
    else if (amount.flag) credit = amount.flag === 'cr'
    else if (amount.signed) credit = amount.paise > 0
    if (credit == null) {
      ambiguous++
      credit = false
    }
    if (balance != null) prevBalance = balance
    // A value-date column printed after the reference: '… N2142628 02/08/26 25,000.00 …'.
    const tailDate = rest.match(/\s(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\s*$/)
    if (tailDate && parseBankDate(tailDate[1]!, dateFormat)) {
      valueDate = valueDate ?? parseBankDate(tailDate[1]!, dateFormat)
      rest = rest.slice(0, rest.length - tailDate[0].length)
    }
    const description = rest.replace(/\s+/g, ' ').trim()
    const chq = description.match(/\b(?:chq|cheque|chq\.?\s*no\.?)\s*[:#-]?\s*(\d{6})\b/i)
    lines.push({
      date,
      valueDate,
      description,
      reference: chq ? chq[1]! : '',
      deposit: credit ? size : 0,
      withdrawal: credit ? 0 : size,
      balance
    })
    lastWasTxn = true
  }
  if (ambiguous) {
    warnings.push(
      `${ambiguous} ${ambiguous === 1 ? 'line has' : 'lines have'} no running balance or Dr/Cr marker to tell the direction — imported as withdrawals; check them in the preview`
    )
  }
  return { format: 'pasted', lines, warnings, account: null, currency: null, openingBalance, closingBalance: prevBalance }
}
