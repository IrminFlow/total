import type { DB } from '../db/connection'
import { fyOf, todayISO } from '@shared/dates'
import { IN_BOOKS } from './vouchers'

/**
 * The start year of the company's first financial year (CompanyInfo.booksFrom, stored as JSON in
 * `meta`) — drives the year-opening rule (@shared/yearOpening). Tolerant, unlike readCompanyInfo
 * (which throws on a missing row), because read-only callers such as the consolidated report open
 * other companies' files directly.
 *
 * Fallback when the value is missing/unreadable: the FY of the earliest in-books voucher; with no
 * vouchers at all, the current FY. Either way stored income/expense openings count in exactly one
 * year, never in every year.
 */
export function booksFromYear(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'company'").get() as { value: string } | undefined
  if (row) {
    try {
      const v = (JSON.parse(row.value) as { booksFrom?: unknown }).booksFrom
      if (typeof v === 'number' && Number.isInteger(v)) return v
    } catch {
      // fall through to the voucher-based fallback
    }
  }
  const earliest = db.prepare(`SELECT MIN(v.date) AS d FROM vouchers v WHERE ${IN_BOOKS}`).get() as { d: string | null }
  return fyOf(earliest.d ?? todayISO()).startYear
}
