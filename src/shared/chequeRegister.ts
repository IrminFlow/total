/**
 * Cheque register helpers (WP 4.1). Pure. A cheque book is a numbered range of leaves per bank
 * account; a leaf becomes a `cheques` row only when something happens to it (issued against a
 * payment voucher, cancelled, stop-payment). "Cleared" is never stored: an issued cheque is
 * cleared when its voucher's bank line has a bank date (the reconciliation is the truth).
 */

export interface ChequeBookRange {
  id: number
  fromNo: number
  toNo: number
  /** Digits printed (CTS cheques carry 6-digit numbers: 000457). */
  width: number
  active: boolean
}

export type StoredChequeStatus = 'issued' | 'cancelled' | 'stopped'
export type ChequeStatus = 'available' | 'issued' | 'cleared' | 'cancelled' | 'stopped'

export const CHEQUE_STATUS_LABELS: Record<ChequeStatus, string> = {
  available: 'Available',
  issued: 'Issued',
  cleared: 'Cleared',
  cancelled: 'Cancelled',
  stopped: 'Stop payment'
}

export const formatLeaf = (n: number, width: number): string => String(n).padStart(width, '0')

/** Integer value of a leaf number as typed ('000457' → 457); null when not a plain number. */
export function leafValue(s: string | null | undefined): number | null {
  const t = (s ?? '').trim()
  return /^\d{1,12}$/.test(t) ? Number(t) : null
}

/** The book a leaf belongs to, if any. */
export function bookFor(books: ChequeBookRange[], leaf: number): ChequeBookRange | null {
  return books.find((b) => leaf >= b.fromNo && leaf <= b.toNo) ?? null
}

/** Lowest unused leaf across active books (ordered by their first leaf), or null when exhausted. */
export function nextAvailableLeaf(books: ChequeBookRange[], used: Set<number>): { bookId: number; leaf: number; label: string } | null {
  for (const b of [...books].filter((x) => x.active).sort((a, z) => a.fromNo - z.fromNo || a.id - z.id)) {
    for (let n = b.fromNo; n <= b.toNo; n++) if (!used.has(n)) return { bookId: b.id, leaf: n, label: formatLeaf(n, b.width) }
  }
  return null
}

/** Status as shown: stored status, upgraded to 'cleared' when the bank line is reconciled. */
export function displayStatus(stored: StoredChequeStatus | null, bankDate: string | null): ChequeStatus {
  if (stored == null) return 'available'
  if (stored === 'issued' && bankDate) return 'cleared'
  return stored
}

/** Overlap check for a new / edited book against the others of the same bank account. */
export function overlappingBook(books: ChequeBookRange[], fromNo: number, toNo: number, exceptId?: number): ChequeBookRange | null {
  return books.find((b) => b.id !== exceptId && fromNo <= b.toNo && toNo >= b.fromNo) ?? null
}
