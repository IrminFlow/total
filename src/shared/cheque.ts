import { amountInWords, formatPaise } from './money'

export interface ChequeFieldsInput {
  /** ISO 'YYYY-MM-DD'. */
  date: string
  payee: string
  /** Paise. */
  amount: number
}

export interface ChequeFields {
  /** 8 digits, DDMMYYYY, one per CTS date box — no separators. */
  dateBoxes: string
  payee: string
  /** amountInWords already appends " Only" — passed through as-is, no double-append. */
  words: string
  /** Grouped Indian digits, no ₹ symbol, with the conventional "/-" suffix. */
  figures: string
}

/** Pure formatting for the fields printed onto a cheque — no DB, no PDF. */
export function chequeFields(input: ChequeFieldsInput): ChequeFields {
  const [y, m, d] = input.date.split('-') as [string, string, string]
  return {
    dateBoxes: `${d}${m}${y}`,
    payee: input.payee,
    words: amountInWords(input.amount),
    figures: `${formatPaise(input.amount)}/-`
  }
}
