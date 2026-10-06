/**
 * Year-opening rules for ledger balances (WP 1.3).
 *
 * Asset and liability ledgers carry their balance forever: balance on a date = stored opening
 * balance + every in-books movement up to that date.
 *
 * Income and expense ledgers start every financial year at zero, as in Tally: their balance on a
 * date = movements from 1 April of the FY containing that date up to the date, plus the stored
 * opening balance only when that FY is the first FY of the books (`booksFrom`). Earlier years'
 * net profit/loss does not sit in the P&L ledgers — it is either carried to Retained Earnings by a
 * posted year-end closing journal (dated 31 Mar, so inside the earlier FY and never in this
 * window) or, if no close was posted, shown by the trial balance as a computed
 * "Profit & Loss A/c (opening)" line so the books still balance.
 *
 * Profit for a period (P&L, year-end close, balance-sheet P&L, cash flow, dashboard, CA pack,
 * consolidated) = movements of income/expense ledgers in [from, to], plus their stored openings
 * only when the period contains the first day of the books (1 April of `booksFrom`). Stored
 * openings belong to the opening of the books: a sub-period of the first FY that starts later
 * than 1 April (say Q2) does not show them — they are in that sub-period's opening (the ledger
 * statement's opening), exactly like Q1's movements are. The year-end close of the books' first
 * FY therefore transfers the stored openings too, leaving its P&L ledgers at exactly zero.
 *
 * Pure date arithmetic only — callers do the SQL.
 */
import type { Nature } from './domain'
import { fyFromStartYear, fyOf } from './dates'

/** Income and expense ledgers reset at each financial-year start. */
export function resetsEachYear(nature: Nature): boolean {
  return nature === 'income' || nature === 'expense'
}

export interface BalanceBasis {
  /** Whether the ledger's stored opening balance counts towards the balance. */
  includeStored: boolean
  /** Earliest voucher date (inclusive) whose movement counts; null = all history. */
  movementsFrom: string | null
}

/**
 * Where a ledger's balance on `date` starts accumulating. The balance at the close of `date` is
 * `(includeStored ? stored : 0) + movements in [movementsFrom, date]`; the opening of a period
 * starting on `date` uses the same basis with movements up to the day before `date`.
 *
 * `booksFromYear` is the company's first FY start year (CompanyInfo.booksFrom).
 */
export function balanceBasis(nature: Nature, date: string, booksFromYear: number): BalanceBasis {
  if (!resetsEachYear(nature)) return { includeStored: true, movementsFrom: null }
  const fy = fyOf(date)
  return { includeStored: fy.startYear === booksFromYear, movementsFrom: fy.from }
}

/** Whether a profit period [from, to] includes the stored opening balances of income/expense
 *  ledgers: only when it contains the first day of the books. */
export function periodIncludesStoredPnl(from: string, to: string, booksFromYear: number): boolean {
  const booksStart = fyFromStartYear(booksFromYear).from
  return from <= booksStart && booksStart <= to
}
