/**
 * GSTR-2B reconciliation — matches purchase-side books against the GST portal's auto-drafted
 * ITC statement (GSTR-2B JSON). Pure: the main process extracts PurchaseDoc rows from vouchers
 * (SQL) and parses the portal JSON; this module does the matching.
 */

/** One invoice or credit/debit note line from the downloaded GSTR-2B JSON. */
export interface PortalInvoice {
  gstin: string
  number: string
  /** ISO date. */
  date: string
  /** Invoice/note value in paise. */
  value: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  kind: 'b2b' | 'cdnr'
  /** Only set for cdnr entries: 'C' (credit note) or 'D' (debit note), as published by the portal. */
  noteType?: 'C' | 'D'
}

/** One purchase or debit-note voucher from the books, extracted for the same period. */
export interface PurchaseDoc {
  voucherId: number
  kind: 'purchase' | 'debit_note'
  date: string
  /** Our own voucher number. */
  number: string
  /** The supplier's invoice number as entered on the voucher (vouchers.reference). */
  supplierRef: string | null
  partyName: string | null
  partyGstin: string | null
  invoiceValue: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export type Recon2bBucket = 'matched' | 'amountMismatch' | 'taxMismatch' | 'missingInBooks' | 'missingInPortal'

export interface Recon2bPair {
  bucket: Recon2bBucket
  portal: PortalInvoice | null
  book: PurchaseDoc | null
  /** portal.value - book.invoiceValue, in paise. Null when either side is missing. */
  valueDiffPaise: number | null
  taxDiffPaise: { igst: number; cgst: number; sgst: number; cess: number } | null
}

export interface Recon2bBucketTotals {
  count: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export interface Recon2bResult {
  pairs: Recon2bPair[]
  buckets: Record<Recon2bBucket, Recon2bBucketTotals>
}

export interface Recon2bOptions {
  amountTolerancePaise: number
  dateWindowDays: number
}

// ---------- number/date/amount tolerance helpers ----------

/**
 * Normalize an invoice number for matching: uppercase, strip everything that isn't a letter or
 * digit, then strip leading zeros from the FINAL contiguous digit run (so 'INV-007' and 'inv007'
 * and 'INV7' all normalize the same way).
 */
export function normalizeInvoiceNumber(raw: string): string {
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const m = stripped.match(/^(.*?)(\d+)$/)
  if (!m) return stripped
  const [, prefix, digits] = m as [string, string, string]
  const trimmed = digits.replace(/^0+(?=\d)/, '')
  return prefix + trimmed
}

function toPaise(x: unknown): number {
  const n = Number(x ?? 0)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

/** 'DD-MM-YYYY' (portal format) -> ISO 'YYYY-MM-DD'. Returns null if unparseable. */
function fromPortalDate(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/)
  if (!m) return null
  const [, d, mo, y] = m as [string, string, string, string]
  return `${y}-${mo}-${d}`
}

/**
 * A portal 'b2b' entry (invoice) can only correspond to a book 'purchase' voucher; a portal
 * 'cdnr' entry (credit/debit note) can only correspond to a book 'debit_note' voucher. Without
 * this guard, a same-normalized-number collision across kinds (e.g. an invoice and an unrelated
 * debit note sharing a number) would pair incompatible documents.
 */
function kindsCompatible(portal: PortalInvoice, book: PurchaseDoc): boolean {
  return (portal.kind === 'b2b' && book.kind === 'purchase') || (portal.kind === 'cdnr' && book.kind === 'debit_note')
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)
  return Math.round(Math.abs(ms) / 86_400_000)
}

interface ItemSums {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

function sumItems(items: unknown): ItemSums {
  const out: ItemSums = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
  if (!Array.isArray(items)) return out
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const d = 'itm_det' in raw && (raw as Record<string, unknown>).itm_det
      ? ((raw as Record<string, unknown>).itm_det as Record<string, unknown>)
      : (raw as Record<string, unknown>)
    out.taxable += toPaise(d.txval)
    out.igst += toPaise(d.iamt)
    out.cgst += toPaise(d.camt)
    out.sgst += toPaise(d.samt)
    out.cess += toPaise(d.csamt)
  }
  return out
}

// ---------- parsing ----------

export interface ParseGstr2bResult {
  period: string | null
  invoices: PortalInvoice[]
  errors: string[]
}

/**
 * Parse a GSTR-2B JSON export (as downloaded from the GST portal). Tolerant of the JSON being
 * wrapped in a top-level `data` key or not, of `items`/`itms` naming, and of missing tax keys
 * (treated as 0). Never throws — malformed entries are skipped and recorded in `errors`.
 */
export function parseGstr2b(jsonText: string): ParseGstr2bResult {
  const errors: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch (err) {
    return { period: null, invoices: [], errors: [`Invalid JSON: ${(err as Error).message}`] }
  }
  if (!raw || typeof raw !== 'object') {
    return { period: null, invoices: [], errors: ['GSTR-2B JSON: expected an object at the top level'] }
  }

  const root = raw as Record<string, unknown>
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>
  const docdata = (data.docdata && typeof data.docdata === 'object' ? data.docdata : {}) as Record<string, unknown>
  const period = typeof data.rtnprd === 'string' ? data.rtnprd : null

  const invoices: PortalInvoice[] = []

  const b2bGroups = Array.isArray(docdata.b2b) ? docdata.b2b : []
  for (const grp of b2bGroups) {
    if (!grp || typeof grp !== 'object') { errors.push('b2b: skipped a malformed supplier group'); continue }
    const g = grp as Record<string, unknown>
    const gstinRaw = typeof g.ctin === 'string' ? g.ctin : typeof g.gstin === 'string' ? g.gstin : null
    if (!gstinRaw) { errors.push('b2b: skipped a supplier group with no GSTIN (ctin)'); continue }
    const gstin = gstinRaw.toUpperCase()
    const invList = Array.isArray(g.inv) ? g.inv : []
    for (const inv of invList) {
      try {
        if (!inv || typeof inv !== 'object') { errors.push(`b2b/${gstin}: skipped a malformed invoice`); continue }
        const iv = inv as Record<string, unknown>
        const number = typeof iv.inum === 'string' && iv.inum.trim() ? iv.inum : null
        const date = fromPortalDate(iv.idt)
        if (!number || !date) {
          errors.push(`b2b/${gstin}: skipped invoice with missing/invalid number or date`)
          continue
        }
        const items = iv.items ?? iv.itms
        const sums = sumItems(items)
        invoices.push({
          gstin,
          number,
          date,
          value: toPaise(iv.val),
          taxable: sums.taxable,
          igst: sums.igst,
          cgst: sums.cgst,
          sgst: sums.sgst,
          cess: sums.cess,
          kind: 'b2b'
        })
      } catch (err) {
        errors.push(`b2b/${gstin}: ${(err as Error).message}`)
      }
    }
  }

  const cdnrGroups = Array.isArray(docdata.cdnr) ? docdata.cdnr : []
  for (const grp of cdnrGroups) {
    if (!grp || typeof grp !== 'object') { errors.push('cdnr: skipped a malformed supplier group'); continue }
    const g = grp as Record<string, unknown>
    const gstinRaw = typeof g.ctin === 'string' ? g.ctin : typeof g.gstin === 'string' ? g.gstin : null
    if (!gstinRaw) { errors.push('cdnr: skipped a supplier group with no GSTIN (ctin)'); continue }
    const gstin = gstinRaw.toUpperCase()
    const ntList = Array.isArray(g.nt) ? g.nt : []
    for (const nt of ntList) {
      try {
        if (!nt || typeof nt !== 'object') { errors.push(`cdnr/${gstin}: skipped a malformed note`); continue }
        const n = nt as Record<string, unknown>
        const number = typeof n.nt_num === 'string' && n.nt_num.trim() ? n.nt_num : null
        const date = fromPortalDate(n.nt_dt)
        if (!number || !date) {
          errors.push(`cdnr/${gstin}: skipped note with missing/invalid number or date`)
          continue
        }
        const items = n.items ?? n.itms
        const sums = sumItems(items)
        const noteType: 'C' | 'D' = n.typ === 'D' ? 'D' : 'C'
        if (n.typ !== 'C' && n.typ !== 'D') {
          errors.push(`cdnr/${gstin}: note ${number} has unrecognized typ ${JSON.stringify(n.typ)} — defaulted to 'C'`)
        }
        invoices.push({
          gstin,
          number,
          date,
          value: toPaise(n.val),
          taxable: sums.taxable,
          igst: sums.igst,
          cgst: sums.cgst,
          sgst: sums.sgst,
          cess: sums.cess,
          kind: 'cdnr',
          noteType
        })
      } catch (err) {
        errors.push(`cdnr/${gstin}: ${(err as Error).message}`)
      }
    }
  }

  return { period, invoices, errors }
}

// ---------- reconciliation ----------

function classify(p: PortalInvoice, b: PurchaseDoc, tolerance: number): Recon2bBucket {
  const valueDiff = Math.abs(p.value - b.invoiceValue)
  const taxOk =
    Math.abs(p.igst - b.igst) <= tolerance &&
    Math.abs(p.cgst - b.cgst) <= tolerance &&
    Math.abs(p.sgst - b.sgst) <= tolerance &&
    Math.abs(p.cess - b.cess) <= tolerance
  if (valueDiff <= tolerance && taxOk) return 'matched'
  if (!taxOk) return 'taxMismatch'
  return 'amountMismatch'
}

function makePair(bucket: Recon2bBucket, p: PortalInvoice | null, b: PurchaseDoc | null): Recon2bPair {
  return {
    bucket,
    portal: p,
    book: b,
    valueDiffPaise: p && b ? p.value - b.invoiceValue : null,
    taxDiffPaise: p && b
      ? { igst: p.igst - b.igst, cgst: p.cgst - b.cgst, sgst: p.sgst - b.sgst, cess: p.cess - b.cess }
      : null
  }
}

const emptyTotals = (): Recon2bBucketTotals => ({ count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 })

/**
 * Match portal (GSTR-2B) invoices/notes against book purchase docs, one-to-one, within GSTIN.
 * Pass 1: exact normalized-number match. Pass 2: fuzzy match among what's left, greedily taking
 * the closest (smallest value diff, then smallest date diff) candidate pairs first.
 */
export function reconcile2b(portal: PortalInvoice[], books: PurchaseDoc[], opts: Recon2bOptions): Recon2bResult {
  const { amountTolerancePaise: tol, dateWindowDays } = opts
  const consumedPortal = new Set<PortalInvoice>()
  const consumedBooks = new Set<PurchaseDoc>()
  const pairs: Recon2bPair[] = []

  // Pass 1: exact normalized-number match within GSTIN, greedy one-to-one.
  for (const p of portal) {
    const key = normalizeInvoiceNumber(p.number)
    const match = books.find(
      (b) =>
        !consumedBooks.has(b) &&
        (b.partyGstin ?? '') === p.gstin &&
        kindsCompatible(p, b) &&
        normalizeInvoiceNumber(b.supplierRef ?? b.number) === key
    )
    if (match) {
      consumedPortal.add(p)
      consumedBooks.add(match)
      pairs.push(makePair(classify(p, match, tol), p, match))
    }
  }

  // Pass 2: fuzzy match (date window + value tolerance) among what's left, best-first.
  const candidates: { p: PortalInvoice; b: PurchaseDoc; valueDiff: number; dateDiff: number }[] = []
  for (const p of portal) {
    if (consumedPortal.has(p)) continue
    for (const b of books) {
      if (consumedBooks.has(b) || (b.partyGstin ?? '') !== p.gstin || !kindsCompatible(p, b)) continue
      const valueDiff = Math.abs(p.value - b.invoiceValue)
      const dateDiff = daysBetween(p.date, b.date)
      if (valueDiff <= tol && dateDiff <= dateWindowDays) candidates.push({ p, b, valueDiff, dateDiff })
    }
  }
  candidates.sort((x, y) => x.valueDiff - y.valueDiff || x.dateDiff - y.dateDiff)
  for (const c of candidates) {
    if (consumedPortal.has(c.p) || consumedBooks.has(c.b)) continue
    consumedPortal.add(c.p)
    consumedBooks.add(c.b)
    pairs.push(makePair(classify(c.p, c.b, tol), c.p, c.b))
  }

  // Leftovers.
  for (const p of portal) if (!consumedPortal.has(p)) pairs.push(makePair('missingInBooks', p, null))
  for (const b of books) if (!consumedBooks.has(b)) pairs.push(makePair('missingInPortal', null, b))

  const buckets: Record<Recon2bBucket, Recon2bBucketTotals> = {
    matched: emptyTotals(),
    amountMismatch: emptyTotals(),
    taxMismatch: emptyTotals(),
    missingInBooks: emptyTotals(),
    missingInPortal: emptyTotals()
  }
  for (const pair of pairs) {
    const t = buckets[pair.bucket]
    const src = pair.portal ?? pair.book
    t.count += 1
    if (src) {
      t.taxable += src.taxable
      t.igst += src.igst
      t.cgst += src.cgst
      t.sgst += src.sgst
      t.cess += src.cess
    }
  }

  return { pairs, buckets }
}
