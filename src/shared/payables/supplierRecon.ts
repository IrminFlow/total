/**
 * Supplier reconciliation (WP 4.3) — pure. The supplier's ledger of our account (pasted or
 * imported CSV) is matched one-to-one against our ledger of the supplier: bills against bills,
 * payments / notes against payments / notes, by invoice number (strict, then the fuzzy core —
 * the same normalisation as the GSTR-2B match, src/shared/gst/recon2b.ts), then by amount within
 * a date window. Differences are listed; nothing is posted.
 *
 * Sides mirror: a bill is a DEBIT in the supplier's books (we owe them) and a CREDIT in ours; a
 * payment is a credit in theirs and a debit in ours.
 */
import { parseCsv } from '../csv'
import { parseRupees } from '../money'
import { isValidISODate } from '../dates'
import { invoiceNumberCore, normalizeInvoiceNumber, toleranceFor } from '../gst/recon2b'
import { daysBetween } from './msme'

/** One line of the supplier's statement, in THEIR terms. */
export interface SupplierLedgerLine {
  /** 1-based CSV line. */
  line: number
  date: string
  docNo: string
  narration: string
  /** They billed us (raises what we owe). */
  debit: number
  /** They received money / gave credit (reduces what we owe). */
  credit: number
}

/** One line of OUR ledger of the supplier. */
export interface BookLedgerLine {
  voucherId: number
  date: string
  /** Our voucher number. */
  number: string
  /** The supplier's invoice number as entered on the voucher (vouchers.reference), if any. */
  supplierRef: string | null
  voucherType: string
  /** Debit to the supplier's ledger in our books (payments, debit notes). */
  debit: number
  /** Credit to the supplier's ledger (bills). */
  credit: number
}

export interface ReconTolerances {
  /** Allowed amount difference, paise. */
  amountPaise: number
  /** Allowed date difference for an amount-only match, days. */
  dateDays: number
}

export const DEFAULT_RECON_TOLERANCES: ReconTolerances = { amountPaise: 100, dateDays: 7 }

export type ReconStatus = 'matched' | 'amount_diff' | 'only_supplier' | 'only_books'
export type ReconMatchedBy = 'number' | 'number_core' | 'amount_date'

export interface ReconPair {
  status: ReconStatus
  matchedBy: ReconMatchedBy | null
  supplier: SupplierLedgerLine | null
  book: BookLedgerLine | null
  /** 'bill' = supplier debit / our credit; 'payment' = supplier credit / our debit. */
  side: 'bill' | 'payment'
  /** Supplier amount − book amount on the matched side, paise; null when one side is missing. */
  amountDiff: number | null
  /** Book date − supplier date, days; null when one side is missing. */
  dateDiffDays: number | null
}

export interface ReconResult {
  pairs: ReconPair[]
  /** Supplier's closing as they show it: Σ debit − Σ credit (what they say we owe). */
  supplierBalance: number
  /** Ours: Σ credit − Σ debit of the supplier ledger lines given (what we say we owe). */
  bookBalance: number
  counts: Record<ReconStatus, number>
}

const lineAmount = (side: 'bill' | 'payment', s: SupplierLedgerLine): number => (side === 'bill' ? s.debit - s.credit : s.credit - s.debit)
const bookAmount = (side: 'bill' | 'payment', b: BookLedgerLine): number => (side === 'bill' ? b.credit - b.debit : b.debit - b.credit)
const supplierSide = (s: SupplierLedgerLine): 'bill' | 'payment' => (s.debit - s.credit >= 0 ? 'bill' : 'payment')
const bookSide = (b: BookLedgerLine): 'bill' | 'payment' => (b.credit - b.debit >= 0 ? 'bill' : 'payment')

/**
 * Match the supplier's lines against ours, one-to-one, within the same side:
 *  1. strict invoice number (normalised) — the supplier's doc no. against our supplier ref, then
 *     our own voucher number;
 *  2. the fuzzy number core (FY tokens, series prefixes, leading zeros dropped);
 *  3. amount within tolerance and date within ±dateDays (closest date first) — how payments
 *     usually pair, since the supplier's receipt number is never ours.
 * A number match with an amount beyond tolerance is 'amount_diff'; leftovers are 'only_supplier'
 * (in their books, not ours) or 'only_books'.
 */
export function reconcileSupplier(
  supplierLines: readonly SupplierLedgerLine[],
  bookLines: readonly BookLedgerLine[],
  tol: ReconTolerances = DEFAULT_RECON_TOLERANCES
): ReconResult {
  const pairs: ReconPair[] = []
  const usedS = new Set<number>()
  const usedB = new Set<number>()
  const within = (a: number, b: number): boolean => Math.abs(a - b) <= toleranceFor(a, tol.amountPaise)

  const pair = (si: number, bi: number, by: ReconMatchedBy): void => {
    const s = supplierLines[si]!
    const b = bookLines[bi]!
    const side = supplierSide(s)
    const sa = lineAmount(side, s)
    const ba = bookAmount(side, b)
    usedS.add(si)
    usedB.add(bi)
    pairs.push({
      status: within(sa, ba) ? 'matched' : 'amount_diff',
      matchedBy: by,
      supplier: s,
      book: b,
      side,
      amountDiff: sa - ba,
      dateDiffDays: daysBetween(s.date, b.date)
    })
  }

  const numberPass = (norm: (raw: string) => string, by: ReconMatchedBy): void => {
    for (let si = 0; si < supplierLines.length; si++) {
      if (usedS.has(si)) continue
      const s = supplierLines[si]!
      if (!s.docNo.trim()) continue
      const key = norm(s.docNo)
      if (!key) continue
      const side = supplierSide(s)
      let best = -1
      let bestScore = Infinity
      for (let bi = 0; bi < bookLines.length; bi++) {
        if (usedB.has(bi)) continue
        const b = bookLines[bi]!
        if (bookSide(b) !== side) continue
        const refHit = b.supplierRef != null && b.supplierRef.trim() !== '' && norm(b.supplierRef) === key
        const numHit = norm(b.number) === key
        if (!refHit && !numHit) continue
        // Prefer the supplier-ref hit, then the closest amount, then the closest date.
        const score = (refHit ? 0 : 1e15) + Math.abs(lineAmount(side, s) - bookAmount(side, b)) * 1000 + Math.abs(daysBetween(s.date, b.date))
        if (score < bestScore) {
          bestScore = score
          best = bi
        }
      }
      if (best !== -1) pair(si, best, by)
    }
  }

  numberPass(normalizeInvoiceNumber, 'number')
  numberPass(invoiceNumberCore, 'number_core')

  // Pass 3: amount + date window, greedily closest date first.
  const candidates: { si: number; bi: number; days: number }[] = []
  for (let si = 0; si < supplierLines.length; si++) {
    if (usedS.has(si)) continue
    const s = supplierLines[si]!
    const side = supplierSide(s)
    for (let bi = 0; bi < bookLines.length; bi++) {
      if (usedB.has(bi)) continue
      const b = bookLines[bi]!
      if (bookSide(b) !== side) continue
      const days = Math.abs(daysBetween(s.date, b.date))
      if (days <= tol.dateDays && within(lineAmount(side, s), bookAmount(side, b))) candidates.push({ si, bi, days })
    }
  }
  candidates.sort((a, b) => a.days - b.days || a.si - b.si || a.bi - b.bi)
  for (const c of candidates) if (!usedS.has(c.si) && !usedB.has(c.bi)) pair(c.si, c.bi, 'amount_date')

  supplierLines.forEach((s, si) => {
    if (!usedS.has(si)) pairs.push({ status: 'only_supplier', matchedBy: null, supplier: s, book: null, side: supplierSide(s), amountDiff: null, dateDiffDays: null })
  })
  bookLines.forEach((b, bi) => {
    if (!usedB.has(bi)) pairs.push({ status: 'only_books', matchedBy: null, supplier: null, book: b, side: bookSide(b), amountDiff: null, dateDiffDays: null })
  })

  const dateOf = (p: ReconPair): string => p.supplier?.date ?? p.book?.date ?? ''
  pairs.sort((a, b) => dateOf(a).localeCompare(dateOf(b)))
  const counts: Record<ReconStatus, number> = { matched: 0, amount_diff: 0, only_supplier: 0, only_books: 0 }
  for (const p of pairs) counts[p.status]++
  return {
    pairs,
    supplierBalance: supplierLines.reduce((s, l) => s + l.debit - l.credit, 0),
    bookBalance: bookLines.reduce((s, l) => s + l.credit - l.debit, 0),
    counts
  }
}

// ---------------------------------------------------------------------------------------------
// CSV → supplier lines
// ---------------------------------------------------------------------------------------------

export interface ParseSupplierCsvResult {
  lines: SupplierLedgerLine[]
  /** Lines skipped and why (opening / closing / total rows, unparseable dates or amounts). */
  skipped: { line: number; reason: string }[]
  /** Column mapping found in the header (for display). */
  columns: { date: number; docNo: number; narration: number; debit: number; credit: number; amount: number; drCr: number } | null
  error: string | null
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }

/** ISO, dd/mm/yyyy, dd-mm-yyyy, dd.mm.yy, dd-Mon-yyyy, "1 Apr 2026" → ISO; null when unreadable. */
export function parseStatementDate(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]))
  m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (m) return iso(year(m[3]!), Number(m[2]), Number(m[1]))
  m = t.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{2,4})$/)
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, 3)]
    return mon ? iso(year(m[3]!), mon, Number(m[1])) : null
  }
  return null
}

function year(s: string): number {
  const n = Number(s)
  return s.length <= 2 ? 2000 + n : n
}

function iso(y: number, m: number, d: number): string | null {
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return isValidISODate(s) ? s : null
}

function amountOf(raw: string | undefined): number | null {
  const t = (raw ?? '').trim().replace(/\s*(dr|cr)\.?$/i, '').replace(/^\((.*)\)$/, '-$1')
  if (t === '' || t === '-') return 0
  return parseRupees(t)
}

/**
 * Read a supplier's ledger exported to CSV. The header row is found by name: a date column, a
 * document / invoice / voucher / reference number column, particulars, and either Debit + Credit
 * columns or an Amount column with a Dr/Cr column (or "1,000.00 Dr" amounts). Opening, closing and
 * total rows are skipped.
 */
export function parseSupplierStatementCsv(text: string): ParseSupplierCsvResult {
  const records = parseCsv(text.replace(/^﻿/, ''))
  const norm = (s: string): string => s.trim().toLowerCase().replace(/[^a-z/]/g, ' ').replace(/\s+/g, ' ').trim()
  let headerIdx = -1
  let cols: NonNullable<ParseSupplierCsvResult['columns']> | null = null
  for (let i = 0; i < Math.min(records.length, 30) && !cols; i++) {
    const h = records[i]!.cells.map(norm)
    const find = (re: RegExp, not?: RegExp): number => h.findIndex((c) => re.test(c) && !(not && not.test(c)))
    const date = find(/^(date|txn date|voucher date|doc date|invoice date|bill date|posting date)$|\bdate\b/)
    const debit = find(/^(debit|dr|debit amount|dr amount|withdrawal)$|\bdebit\b/)
    const credit = find(/^(credit|cr|credit amount|cr amount|deposit)$|\bcredit\b/)
    const amount = find(/\bamount\b|\bvalue\b/, /debit|credit/)
    const drCr = find(/^(dr\/cr|dr cr|type|dr or cr|d\/c)$/)
    if (date === -1 || ((debit === -1 || credit === -1) && amount === -1)) continue
    const docNo = find(/(doc|document|invoice|inv|bill|voucher|vch|ref|reference)\s*(no|num|number)?\b|^no$|^number$/, /date|amount|type/)
    const narration = find(/particular|narration|description|details|remarks/)
    headerIdx = i
    cols = { date, docNo, narration, debit, credit, amount, drCr }
  }
  if (!cols) {
    return { lines: [], skipped: [], columns: null, error: 'No header row found — the CSV needs a Date column and Debit / Credit columns (or Amount with Dr/Cr)' }
  }
  const lines: SupplierLedgerLine[] = []
  const skipped: ParseSupplierCsvResult['skipped'] = []
  for (const rec of records.slice(headerIdx + 1)) {
    const cell = (i: number): string => (i >= 0 ? (rec.cells[i] ?? '').trim() : '')
    const narration = cell(cols.narration)
    const docNo = cell(cols.docNo)
    if (/^(opening|closing|total|balance\s*(b\/f|c\/f|brought|carried))/i.test(narration) || /^(opening|closing|total)/i.test(cell(cols.date))) {
      skipped.push({ line: rec.line, reason: narration || cell(cols.date) })
      continue
    }
    const date = parseStatementDate(cell(cols.date))
    if (!date) {
      if (rec.cells.some((c) => c.trim() !== '')) skipped.push({ line: rec.line, reason: `unreadable date "${cell(cols.date)}"` })
      continue
    }
    let debit = 0
    let credit = 0
    if (cols.debit !== -1 && cols.credit !== -1) {
      const d = amountOf(cell(cols.debit))
      const c = amountOf(cell(cols.credit))
      if (d == null || c == null) {
        skipped.push({ line: rec.line, reason: 'unreadable amount' })
        continue
      }
      debit = Math.abs(d)
      credit = Math.abs(c)
    } else {
      const rawAmt = cell(cols.amount)
      const a = amountOf(rawAmt)
      if (a == null) {
        skipped.push({ line: rec.line, reason: 'unreadable amount' })
        continue
      }
      const tag = (cell(cols.drCr) || (rawAmt.match(/(dr|cr)\.?$/i)?.[1] ?? '')).toLowerCase()
      const isCr = tag.startsWith('c') || (tag === '' && a < 0)
      if (isCr) credit = Math.abs(a)
      else debit = Math.abs(a)
    }
    if (debit === 0 && credit === 0) {
      skipped.push({ line: rec.line, reason: 'zero amount' })
      continue
    }
    lines.push({ line: rec.line, date, docNo, narration, debit, credit })
  }
  return { lines, skipped, columns: cols, error: null }
}
