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

// ---------- register backfill (the upgrade check: entries saved before a book existed) ----------

export type ChequeNumberSource = 'instrument' | 'reference' | 'narration'

/** "Chq 000457", "cheque no. 457", "CHQ#457", "chk-457" — the digits after a cheque word. */
const NARRATION_CHEQUE = /\b(?:cheque|cheq|chq|chk)\.?\s*(?:no\.?|number|#)?\s*[:#.-]?\s*(\d{1,12})\b/i

/**
 * The cheque number an entry carries, read in the order the voucher editor fills them: the
 * instrument number (what Print cheque reads), then a reference that is only digits, then a
 * cheque word in the narration. Each candidate goes through `leafValue` — the same reading
 * Print cheque applies — so a number that would not issue on print is never picked here. Only the
 * FIRST field holding a number counts (a later field is never preferred to make a match).
 */
export function chequeNumberOf(fields: { instrumentNo: string | null; reference: string | null; narration: string | null }): {
  source: ChequeNumberSource
  text: string
  leaf: number
} | null {
  const instrument = (fields.instrumentNo ?? '').trim()
  if (instrument) {
    const leaf = leafValue(instrument)
    return leaf == null ? null : { source: 'instrument', text: instrument, leaf }
  }
  const reference = (fields.reference ?? '').trim()
  const refLeaf = leafValue(reference)
  if (refLeaf != null) return { source: 'reference', text: reference, leaf: refLeaf }
  const m = NARRATION_CHEQUE.exec(fields.narration ?? '')
  const narrLeaf = m ? leafValue(m[1]) : null
  return m && narrLeaf != null ? { source: 'narration', text: m[1]!, leaf: narrLeaf } : null
}

/** Width of a number outside every book that the backfill may still record (CTS leaves). */
export const OUTSIDE_BOOK_DIGITS = 6
