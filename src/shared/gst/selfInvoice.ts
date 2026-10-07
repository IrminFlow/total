/**
 * Reverse-charge self-invoice numbering and status (WP 3.4). Sources: SELF_INVOICE_RULES in
 * ./sources.ts — s.31(3)(f) CGST Act, rule 47A (within 30 days of receipt, from 01-11-2024),
 * rule 46(b) (consecutive serial, at most 16 characters of letters, digits, '-' and '/', unique
 * for the financial year).
 */
import { SELF_INVOICE_RULES } from './sources'

export type SelfInvoiceStatus = 'generated' | 'generated_late' | 'due' | 'overdue' | 'cancelled'

export const SELF_INVOICE_STATUS_LABELS: Record<SelfInvoiceStatus, string> = {
  generated: 'Generated',
  generated_late: 'Generated late',
  due: 'Due',
  overdue: 'Overdue',
  cancelled: 'Purchase binned'
}

export interface SelfInvoiceRow {
  voucherId: number
  voucherNumber: string
  /** Purchase date = the date of receipt in the books. */
  date: string
  supplierRef: string | null
  partyLedgerId: number
  partyName: string
  taxable: number
  /** Tax payable on reverse charge (master rates). */
  tax: number
  selfInvoiceNumber: string | null
  selfInvoiceDate: string | null
  status: SelfInvoiceStatus
  /** Rule 47A due date; null before 01-11-2024 (no fixed period then). */
  dueDate: string | null
  /** Days left to the due date (negative = overdue); null when generated or no due date. */
  daysLeft: number | null
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

/** "SI/26-27/0007": prefix + FY short label + 4-digit serial. Throws past rule 46(b)'s 16 chars. */
export function selfInvoiceNumber(prefix: string, fyLabel: string, seq: number): string {
  const short = fyLabel.length === 7 ? fyLabel.slice(2) : fyLabel // '2026-27' → '26-27'
  const n = `${prefix}${short}/${String(seq).padStart(4, '0')}`
  if (!isValidSelfInvoiceNumber(n)) throw new Error(`Self-invoice number “${n}” breaks rule 46(b) (max ${SELF_INVOICE_RULES.maxNumberLength} characters: letters, digits, - and /)`)
  return n
}

export function isValidSelfInvoiceNumber(n: string): boolean {
  return n.length > 0 && n.length <= SELF_INVOICE_RULES.maxNumberLength && /^[A-Za-z0-9/-]+$/.test(n)
}

export function selfInvoiceDueDate(receiptDate: string): string | null {
  return receiptDate >= SELF_INVOICE_RULES.effectiveFrom ? addDays(receiptDate, SELF_INVOICE_RULES.dueDays) : null
}

export function selfInvoiceStatus(
  receiptDate: string,
  generatedOn: string | null,
  today: string,
  binned = false
): { status: SelfInvoiceStatus; dueDate: string | null; daysLeft: number | null } {
  const dueDate = selfInvoiceDueDate(receiptDate)
  if (binned) return { status: 'cancelled', dueDate, daysLeft: null }
  if (generatedOn) return { status: dueDate && generatedOn > dueDate ? 'generated_late' : 'generated', dueDate, daysLeft: null }
  if (!dueDate) return { status: 'due', dueDate, daysLeft: null }
  const left = daysBetween(today, dueDate)
  return { status: left < 0 ? 'overdue' : 'due', dueDate, daysLeft: left }
}
