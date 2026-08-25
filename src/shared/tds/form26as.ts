/**
 * Form 26AS / AIS reconciliation — the credit side of TDS (roadmap D-91).
 *
 * Everywhere else in the TDS engine we are the deductor. Here we are the deductee: Form 26AS
 * (Rule 31AB, now served as the Annual Information Statement on the e-filing portal) is the
 * department's own record of tax deducted *against* this taxpayer by their customers, built from
 * the customers' quarterly statements. Credit is granted under section 199 read with Rule 37BA
 * from that record — not from our books.
 *
 * Which makes both directions of a difference a finding, and neither one optional:
 *   • in the books but not in 26AS — the customer has not filed, or filed against the wrong PAN.
 *     The taxpayer will not get this credit. That is cash, and the only remedy is chasing the
 *     deductor before their correction window closes.
 *   • in 26AS but not in the books — someone paid us and we have not recorded the income. That
 *     is a bigger problem than the credit: it is an under-reported receipt the department can
 *     already see.
 * A tool that reports only one side lets the other rot silently, so `reconcile26as` reports both.
 *
 * Checked against the TRACES Form 26AS (Part A) layout and Rule 37BA as at 2026-08-25. Nothing
 * statutory is hard-coded here — the file is a parser and a matcher.
 *
 * Shape, vocabulary and matching strategy follow ../gst/recon2b.ts (the GSTR-2B reconciliation):
 * greedy one-to-one passes from strict to loose, pairs carrying both sides plus a bucket, and
 * per-bucket totals. Name comparison is literally reused from there.
 */
import { parseCsv } from '../csv'
import { parseRupees } from '../money'
import { isValidISODate } from '../dates'
import { nameSimilarity } from '../gst/recon2b'
import { tdsQuarterOf } from '../tds'

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One Part-A row of a 26AS statement, normalised. All money is INTEGER PAISE. */
export interface Statement26asRow {
  /** 1-based physical line in the source file, so a problem can be pointed at. */
  line: number
  deductorName: string
  /** The deductor's TAN, uppercased. The only reliable join key between the two sides. */
  deductorTan: string
  /** Section as printed, e.g. '194C', '194J', uppercased with spaces stripped. */
  section: string
  /** ISO 'YYYY-MM-DD', or null when the column was absent or unparseable. */
  date: string | null
  /** Amount paid/credited to us, paise. */
  amountPaidPaise: number
  /** Tax deducted, paise. */
  taxDeductedPaise: number
  /** Tax deposited — what section 199 credit is actually granted on, paise. */
  taxDepositedPaise: number
}

export interface Parse26asResult {
  rows: Statement26asRow[]
  /** Human-readable, one per skipped or suspect line. Never thrown — a bad line is a finding. */
  problems: string[]
}

/**
 * Column matchers, in priority order. TRACES has changed its wording more than once and users
 * also paste the AIS/TIS variants, so each column is found by pattern rather than by position.
 * Ordered because the patterns overlap: 'Amount of tax deposited' must be claimed by `deposited`
 * before the looser 'tax'-ish rules get to it.
 */
const COLUMN_RULES: { key: keyof ColumnMap; test: RegExp }[] = [
  { key: 'tan', test: /\btan\b|tan of (the )?deductor|deductor.*tan/ },
  { key: 'deposited', test: /deposit/ },
  { key: 'deducted', test: /tax deducted|tds deducted|amount of tax|tax ded/ },
  { key: 'amount', test: /amount paid|amount credited|paid.*credit|amount of payment|amount paid.*credited/ },
  { key: 'section', test: /section/ },
  { key: 'date', test: /date/ },
  { key: 'name', test: /name of (the )?deductor|deductor.*name|name/ }
]

interface ColumnMap {
  name: number | null
  tan: number | null
  section: number | null
  date: number | null
  amount: number | null
  deducted: number | null
  deposited: number | null
}

const emptyMap = (): ColumnMap => ({
  name: null, tan: null, section: null, date: null, amount: null, deducted: null, deposited: null
})

function normHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Try to read a record as the header row. Returns null unless it names, at minimum, a TAN column
 * and a tax-deducted column — the two fields without which a row cannot be reconciled at all.
 * That minimum is also what lets us skip the TRACES preamble (the "File Format", PAN, name and
 * assessment-year banner rows that sit above the table) without hard-coding its shape.
 */
function readHeader(cells: string[]): ColumnMap | null {
  const map = emptyMap()
  const taken = new Set<number>()
  for (const rule of COLUMN_RULES) {
    for (let i = 0; i < cells.length; i++) {
      if (taken.has(i)) continue
      if (rule.test.test(normHeader(cells[i] ?? ''))) {
        map[rule.key] = i
        taken.add(i)
        break
      }
    }
  }
  return map.tan !== null && map.deducted !== null ? map : null
}

/** 26AS prints dates as DD-MMM-YYYY or DD/MM/YYYY; AIS exports sometimes give ISO. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export function parse26asDate(raw: string): string | null {
  const s = raw.trim()
  if (s === '') return null
  if (isValidISODate(s)) return s
  const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,}|\d{1,2})[-/ ](\d{2,4})$/)
  if (!m) return null
  const [, dRaw, moRaw, yRaw] = m as [string, string, string, string]
  const month = /^\d+$/.test(moRaw) ? Number(moRaw) : MONTHS.indexOf(moRaw.slice(0, 3).toLowerCase()) + 1
  if (month < 1 || month > 12) return null
  const year = yRaw.length <= 2 ? 2000 + Number(yRaw) : Number(yRaw)
  const iso = `${year}-${String(month).padStart(2, '0')}-${dRaw.padStart(2, '0')}`
  return isValidISODate(iso) ? iso : null
}

/**
 * 26AS prints money in RUPEES with two decimals ("1234.56"). It is converted to integer paise
 * exactly ONCE, here at the parse boundary, through `parseRupees` — nothing downstream ever sees
 * a rupee decimal. This is not a stylistic rule: a figure that skips this conversion is out by a
 * factor of 100 against the books, and a reconciliation that is out by 100x still *runs*, it just
 * reports every single row as a mismatch (or, worse, matches a ₹12.34 row to a ₹1,234 entry).
 */
function parseAmountPaise(raw: string | undefined): number | null {
  const s = (raw ?? '').trim()
  if (s === '') return 0
  return parseRupees(s.replace(/^\(|\)$/g, '').replace(/[^0-9.,-]/g, ''))
}

/** Summary/footer lines TRACES appends under the table; not data rows. */
const TOTAL_ROW = /^(grand )?total\b|^total of/i

/**
 * Parse a Form 26AS text/CSV export saved from TRACES. Tolerant by design: the preamble is
 * skipped, header naming variation is matched by pattern, and a malformed line is reported in
 * `problems` rather than thrown — a user reconciling a year's credit should get the 300 rows that
 * parsed plus a list of the four that did not, never an exception and nothing.
 */
export function parse26asCsv(text: string): Parse26asResult {
  const problems: string[] = []
  const rows: Statement26asRow[] = []
  const records = parseCsv(text)

  let map: ColumnMap | null = null
  let headerLine = 0
  for (const rec of records) {
    if (!map) {
      const candidate = readHeader(rec.cells)
      if (candidate) {
        map = candidate
        headerLine = rec.line
      }
      continue // preamble, or the header itself
    }

    const cells = rec.cells
    const first = (cells[0] ?? '').trim()
    if (cells.every((c) => c.trim() === '')) continue
    if (TOTAL_ROW.test(first)) continue

    const at = (i: number | null): string => (i === null ? '' : (cells[i] ?? '').trim())
    const tan = at(map.tan).toUpperCase().replace(/\s+/g, '')
    if (tan === '') {
      // A second header repeated per deductor block is common; don't report it as a bad row.
      if (readHeader(cells)) continue
      problems.push(`Line ${rec.line}: skipped — no deductor TAN`)
      continue
    }

    const amountPaise = parseAmountPaise(at(map.amount))
    const deductedPaise = parseAmountPaise(at(map.deducted))
    const depositedRaw = at(map.deposited)
    const depositedPaise = parseAmountPaise(depositedRaw)
    if (amountPaise === null || deductedPaise === null || depositedPaise === null) {
      problems.push(`Line ${rec.line}: skipped — could not read an amount (${cells.join(' | ')})`)
      continue
    }

    const dateRaw = at(map.date)
    const date = dateRaw === '' ? null : parse26asDate(dateRaw)
    if (dateRaw !== '' && date === null) {
      problems.push(`Line ${rec.line}: unreadable date ${JSON.stringify(dateRaw)} — row kept without a date`)
    }

    rows.push({
      line: rec.line,
      deductorName: at(map.name),
      deductorTan: tan,
      section: at(map.section).toUpperCase().replace(/\s+/g, ''),
      date,
      amountPaidPaise: amountPaise,
      taxDeductedPaise: deductedPaise,
      // A blank deposited column means the export didn't carry one, not that nothing was
      // deposited — treating it as zero would report the taxpayer's whole credit as at risk.
      taxDepositedPaise: depositedRaw === '' ? deductedPaise : depositedPaise
    })
  }

  if (!map) problems.push('No 26AS table found: no header row naming a deductor TAN and a tax-deducted column')
  else if (rows.length === 0) problems.push(`Header found on line ${headerLine}, but no data rows below it`)

  return { rows, problems }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** One TDS-receivable entry from our own books (a sales/receipt voucher's TDS deducted by us). */
export interface Book26asEntry {
  /** Whatever the caller keys rows by — a voucher id, usually. */
  id: number | string
  deductorName: string | null
  /** The customer's TAN as recorded on the ledger master. Often absent; see the name pass. */
  deductorTan: string | null
  section: string
  /** ISO 'YYYY-MM-DD'. */
  date: string
  /** Amount paid/credited to us on which tax was deducted, paise. */
  amountPaise: number
  /** TDS credit claimed in the books, paise. */
  tdsPaise: number
}

export type Recon26asBucket =
  | 'matched'
  | 'amountMismatch'
  /** Same deductor and amount, but the 26AS date sits outside the tolerance window. Matters
   *  because Rule 37BA grants the credit in the year the income is assessable, so a drift across
   *  31 March moves the credit to another return entirely. */
  | 'dateDrift'
  /** In 26AS, absent from the books — income possibly never recorded. */
  | 'missingInBooks'
  /** In the books, absent from 26AS — credit the taxpayer will not get. */
  | 'missingInStatement'

export interface Recon26asPair {
  bucket: Recon26asBucket
  statement: Statement26asRow | null
  book: Book26asEntry | null
  /** statement.taxDeducted − book.tds, paise. Null when either side is missing. */
  tdsDiffPaise: number | null
  /** statement.amountPaid − book.amount, paise. Null when either side is missing. */
  amountDiffPaise: number | null
  /** Days between the two dates; null when either date is missing. */
  dateDiffDays: number | null
  /** Why this pair is where it is — 'matched on name', 'section differs', 'deposited < deducted'. */
  notes: string[]
}

export interface Recon26asBucketTotals {
  count: number
  amountPaise: number
  tdsPaise: number
}

export interface Recon26asResult {
  pairs: Recon26asPair[]
  buckets: Record<Recon26asBucket, Recon26asBucketTotals>
  /**
   * Total TDS credit in the books that 26AS does not currently support, in paise: everything in
   * `missingInStatement`, plus, on every pair, the shortfall of tax actually DEPOSITED against
   * the credit claimed. Deposited rather than deducted, because section 199 credit follows the
   * deposit — a deductor who deducted and never paid leaves the credit just as unavailable.
   */
  creditAtRiskPaise: number
  /** TDS shown in 26AS with no book entry behind it — the possibly-unrecorded-income figure. */
  unrecordedCreditPaise: number
}

export interface Recon26asOptions {
  /** Paise a TDS figure may differ by and still count as the same deduction. */
  amountTolerancePaise: number
  /** Days the two dates may differ by before a pair is called a date drift. */
  dateWindowDays: number
  /** Name similarity (0–1) required to pair a book entry that carries no TAN. Default 0.8. */
  nameMatchThreshold?: number
}

function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)
}

const normSection = (s: string | null | undefined): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const normTan = (s: string | null | undefined): string => (s ?? '').toUpperCase().replace(/\s+/g, '')

function makePair(
  bucket: Recon26asBucket,
  s: Statement26asRow | null,
  b: Book26asEntry | null,
  notes: string[] = []
): Recon26asPair {
  const extra = [...notes]
  if (s && b) {
    if (normSection(s.section) !== normSection(b.section) && s.section !== '') {
      extra.push(`section differs: 26AS ${s.section}, books ${b.section}`)
    }
    const q1 = tdsQuarterOf(b.date)
    if (s.date) {
      const q2 = tdsQuarterOf(s.date)
      if (q1.label !== q2.label) extra.push(`different TDS quarter: books ${q1.label}, 26AS ${q2.label}`)
    }
  }
  if (s && s.taxDepositedPaise < s.taxDeductedPaise) {
    extra.push('26AS shows less tax deposited than deducted')
  }
  return {
    bucket,
    statement: s,
    book: b,
    tdsDiffPaise: s && b ? s.taxDeductedPaise - b.tdsPaise : null,
    amountDiffPaise: s && b ? s.amountPaidPaise - b.amountPaise : null,
    dateDiffDays: s && b ? daysApart(s.date, b.date) : null,
    notes: extra
  }
}

function classify(s: Statement26asRow, b: Book26asEntry, opts: Recon26asOptions): Recon26asBucket {
  const tdsDiff = Math.abs(s.taxDeductedPaise - b.tdsPaise)
  const amountDiff = Math.abs(s.amountPaidPaise - b.amountPaise)
  const drift = daysApart(s.date, b.date)
  if (tdsDiff > opts.amountTolerancePaise || amountDiff > opts.amountTolerancePaise) return 'amountMismatch'
  if (drift !== null && drift > opts.dateWindowDays) return 'dateDrift'
  return 'matched'
}

const emptyTotals = (): Recon26asBucketTotals => ({ count: 0, amountPaise: 0, tdsPaise: 0 })

/**
 * Match 26AS statement rows against book TDS-receivable entries, one-to-one, strictest first.
 *
 * Pass 1 — TAN + section + same date + identical tax: the unambiguous case.
 * Pass 2 — TAN + section, tax within tolerance, date within the window: the near match.
 * Pass 3 — TAN + identical tax, any date drift and any section: the deduction plainly happened,
 *          the date (or the section the deductor filed it under) is what disagrees.
 * Pass 4 — TAN + section + the same payment, dates close, but the tax figures disagree beyond
 *          tolerance: the short deduction itself, which is the whole point of the exercise.
 * Pass 5 — no TAN in the books: pair on deductor name similarity, reusing the GSTR-2B name
 *          comparison, with the tax still required to agree within tolerance. A book entry with
 *          no TAN is common (the master was created from an invoice, not a TDS certificate) and
 *          would otherwise report perfectly good credit as missing.
 * Whatever is left over is a one-sided finding, in the direction that says which.
 */
export function reconcile26as(
  bookEntries: Book26asEntry[],
  statementRows: Statement26asRow[],
  opts: Recon26asOptions
): Recon26asResult {
  const nameThreshold = opts.nameMatchThreshold ?? 0.8
  const usedStatement = new Set<Statement26asRow>()
  const usedBooks = new Set<Book26asEntry>()
  const pairs: Recon26asPair[] = []

  const take = (s: Statement26asRow, b: Book26asEntry, notes: string[] = []): void => {
    usedStatement.add(s)
    usedBooks.add(b)
    pairs.push(makePair(classify(s, b, opts), s, b, notes))
  }

  // Pass 1: exact.
  for (const s of statementRows) {
    if (usedStatement.has(s)) continue
    const b = bookEntries.find(
      (x) =>
        !usedBooks.has(x) &&
        normTan(x.deductorTan) === s.deductorTan &&
        normTan(x.deductorTan) !== '' &&
        normSection(x.section) === normSection(s.section) &&
        x.date === s.date &&
        x.tdsPaise === s.taxDeductedPaise
    )
    if (b) take(s, b)
  }

  // Pass 2: same TAN + section, tax within tolerance, date within the window.
  interface Cand { s: Statement26asRow; b: Book26asEntry; tdsDiff: number; dateDiff: number }
  const near: Cand[] = []
  for (const s of statementRows) {
    if (usedStatement.has(s)) continue
    for (const b of bookEntries) {
      if (usedBooks.has(b)) continue
      if (s.deductorTan === '' || normTan(b.deductorTan) !== s.deductorTan) continue
      if (normSection(b.section) !== normSection(s.section)) continue
      const tdsDiff = Math.abs(s.taxDeductedPaise - b.tdsPaise)
      const dateDiff = daysApart(s.date, b.date) ?? 0
      if (tdsDiff > opts.amountTolerancePaise || dateDiff > opts.dateWindowDays) continue
      near.push({ s, b, tdsDiff, dateDiff })
    }
  }
  near.sort((x, y) => x.tdsDiff - y.tdsDiff || x.dateDiff - y.dateDiff)
  for (const c of near) {
    if (usedStatement.has(c.s) || usedBooks.has(c.b)) continue
    take(c.s, c.b)
  }

  // Pass 3: same TAN + identical tax, whatever the date or the section says.
  const drifted: Cand[] = []
  for (const s of statementRows) {
    if (usedStatement.has(s)) continue
    for (const b of bookEntries) {
      if (usedBooks.has(b)) continue
      if (s.deductorTan === '' || normTan(b.deductorTan) !== s.deductorTan) continue
      if (s.taxDeductedPaise !== b.tdsPaise) continue
      drifted.push({ s, b, tdsDiff: 0, dateDiff: daysApart(s.date, b.date) ?? 0 })
    }
  }
  drifted.sort((x, y) => x.dateDiff - y.dateDiff)
  for (const c of drifted) {
    if (usedStatement.has(c.s) || usedBooks.has(c.b)) continue
    take(c.s, c.b)
  }

  // Pass 4: same TAN, section and payment, but the tax figures disagree beyond tolerance.
  //
  // Without this pass the single most important finding — the deductor deducted ₹900 where the
  // books claim ₹1,000 — would split into a book-only row and a statement-only row, and the
  // ₹100 shortfall would never be named as a shortfall. The gross amount paid is required to
  // agree within tolerance, which is what keeps this from pairing two unrelated deductions.
  const taxDisagrees: Cand[] = []
  for (const s of statementRows) {
    if (usedStatement.has(s)) continue
    for (const b of bookEntries) {
      if (usedBooks.has(b)) continue
      if (s.deductorTan === '' || normTan(b.deductorTan) !== s.deductorTan) continue
      if (normSection(b.section) !== normSection(s.section)) continue
      const dateDiff = daysApart(s.date, b.date) ?? 0
      if (dateDiff > opts.dateWindowDays) continue
      if (Math.abs(s.amountPaidPaise - b.amountPaise) > opts.amountTolerancePaise) continue
      taxDisagrees.push({ s, b, tdsDiff: Math.abs(s.taxDeductedPaise - b.tdsPaise), dateDiff })
    }
  }
  taxDisagrees.sort((x, y) => x.tdsDiff - y.tdsDiff || x.dateDiff - y.dateDiff)
  for (const c of taxDisagrees) {
    if (usedStatement.has(c.s) || usedBooks.has(c.b)) continue
    take(c.s, c.b)
  }

  // Pass 5: book entry with no TAN — pair on deductor name.
  interface NameCand extends Cand { score: number }
  const byName: NameCand[] = []
  for (const s of statementRows) {
    if (usedStatement.has(s)) continue
    for (const b of bookEntries) {
      if (usedBooks.has(b) || normTan(b.deductorTan) !== '') continue
      const tdsDiff = Math.abs(s.taxDeductedPaise - b.tdsPaise)
      if (tdsDiff > opts.amountTolerancePaise) continue
      const score = nameSimilarity(s.deductorName, b.deductorName)
      if (score < nameThreshold) continue
      byName.push({ s, b, tdsDiff, dateDiff: daysApart(s.date, b.date) ?? 0, score })
    }
  }
  byName.sort((x, y) => y.score - x.score || x.tdsDiff - y.tdsDiff || x.dateDiff - y.dateDiff)
  for (const c of byName) {
    if (usedStatement.has(c.s) || usedBooks.has(c.b)) continue
    take(c.s, c.b, ['book entry has no TAN — matched on deductor name'])
  }

  for (const s of statementRows) if (!usedStatement.has(s)) pairs.push(makePair('missingInBooks', s, null))
  for (const b of bookEntries) if (!usedBooks.has(b)) pairs.push(makePair('missingInStatement', null, b))

  const buckets: Record<Recon26asBucket, Recon26asBucketTotals> = {
    matched: emptyTotals(),
    amountMismatch: emptyTotals(),
    dateDrift: emptyTotals(),
    missingInBooks: emptyTotals(),
    missingInStatement: emptyTotals()
  }
  let creditAtRiskPaise = 0
  let unrecordedCreditPaise = 0
  for (const p of pairs) {
    const t = buckets[p.bucket]
    t.count += 1
    t.amountPaise += p.statement?.amountPaidPaise ?? p.book?.amountPaise ?? 0
    t.tdsPaise += p.statement?.taxDeductedPaise ?? p.book?.tdsPaise ?? 0
    if (p.bucket === 'missingInStatement' && p.book) creditAtRiskPaise += p.book.tdsPaise
    if (p.bucket === 'missingInBooks' && p.statement) unrecordedCreditPaise += p.statement.taxDeductedPaise
    if (p.statement && p.book) {
      creditAtRiskPaise += Math.max(0, p.book.tdsPaise - p.statement.taxDepositedPaise)
    }
  }

  return { pairs, buckets, creditAtRiskPaise, unrecordedCreditPaise }
}
