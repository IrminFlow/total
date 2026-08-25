/**
 * The Form 3CD data pack (roadmap #362).
 *
 * A tax audit report is the auditor's to sign and the client's to supply the data for, and the
 * week in which that data is assembled is the worst week of the year in a small accounts
 * department. Almost all of it is already in these books; none of it is in the shape Form 3CD
 * asks for. So this is clause-wise extracts, not a filled form: the numbers, with the arithmetic
 * visible, under the clause they answer.
 *
 * Nothing here is an opinion and nothing here is a certificate. Where a clause needs a fact the
 * books do not hold — whether a payment was for a personal purpose, whether a related party was
 * paid more than the fair value — the clause appears with `providedBy: 'auditor'` and says what
 * it needs, rather than being silently missing.
 *
 * ---------------------------------------------------------------------------------------------
 * CHECKED AGAINST (August 2026), and where the check stopped:
 *   - Form 3CD as prescribed by rule 6G, Income-tax Rules 1962. The clause numbers below are from
 *     the form as this author understands it.
 *     ** FORM 3CD IS AMENDED ALMOST EVERY YEAR — clauses are inserted, renumbered and suspended.
 *        The clause NUMBERS here have not been verified against the form notified for the year
 *        being audited. Every extract states what it contains in words as well as by number, so a
 *        renumbered clause is still usable; check the numbers before transcribing. **
 *   - Section 40A(3): ₹10,000 per person per day for payments otherwise than by an account-payee
 *     cheque or draft or electronic mode, ₹35,000 where the payment is for plying, hiring or
 *     leasing goods carriages. Limits as amended by the Finance Act 2017.
 *   - Sections 269SS and 269T: ₹20,000 for loans and deposits accepted or repaid otherwise than
 *     by account-payee instrument or electronic mode.
 *   - Section 269ST: ₹2,00,000 received from a person in a day / in respect of a transaction /
 *     in respect of one event, in force from 1 April 2017.
 *   - Section 23 of the MSMED Act: interest payable to a micro or small enterprise is not an
 *     allowable deduction. That is clause 22, and it is computed from the same MSME machinery
 *     section 43B(h) uses (roadmap #351).
 *
 * All limits are DATED DATA below, not constants, for the reason the whole app treats them that
 * way: a pack produced for FY 2024-25 next year must still use the limits of FY 2024-25.
 */

export interface DatedLimit {
  /** ISO date this limit took effect. */
  effectiveFrom: string
  /** Paise. */
  limit: number
  note: string
}

/** Section 40A(3) — cash payments to one person in one day. */
export const CASH_PAYMENT_LIMIT: DatedLimit[] = [
  { effectiveFrom: '2009-04-01', limit: 20_000_00, note: 'Section 40A(3): ₹20,000 per person per day.' },
  {
    effectiveFrom: '2017-04-01',
    limit: 10_000_00,
    note: 'Section 40A(3) as amended by the Finance Act 2017: ₹10,000 per person per day.'
  }
]

/** Section 40A(3) proviso — goods carriage payments. */
export const CASH_PAYMENT_LIMIT_TRANSPORT: DatedLimit[] = [
  {
    effectiveFrom: '2015-04-01',
    limit: 35_000_00,
    note: 'Section 40A(3) proviso: ₹35,000 for plying, hiring or leasing goods carriages.'
  }
]

/** Sections 269SS and 269T — loans and deposits taken or repaid in cash. */
export const LOAN_CASH_LIMIT: DatedLimit[] = [
  { effectiveFrom: '2003-06-01', limit: 20_000_00, note: 'Sections 269SS and 269T: ₹20,000.' }
]

/** Section 269ST — cash received from a person. */
export const CASH_RECEIPT_LIMIT: DatedLimit[] = [
  { effectiveFrom: '2017-04-01', limit: 2_00_000_00, note: 'Section 269ST: ₹2,00,000, in force from 1 April 2017.' }
]

/** The limit in force on a date. Dates before the first entry get the first entry. */
export function limitOn(history: DatedLimit[], date: string): DatedLimit {
  let current = history[0] as DatedLimit
  for (const l of history) {
    if (l.effectiveFrom <= date) current = l
    else break
  }
  return current
}

// ---------- the clause catalogue ----------

export type ClauseSource =
  /** Every figure comes from the books. */
  | 'books'
  /** The books produce a list; somebody has to decide what is on it. */
  | 'booksWithJudgement'
  /** The books hold nothing relevant. Listed so its absence is deliberate. */
  | 'auditor'

export interface ClauseSpec {
  /** Form 3CD clause, e.g. '21(d)'. See the header: numbers move. */
  clause: string
  title: string
  /** What the clause actually asks for, in the words the person assembling the pack needs. */
  asks: string
  source: ClauseSource
  /** The section it implements, cited. */
  authority: string
}

/**
 * The clauses this app can say something about.
 *
 * A short list on purpose. Form 3CD has forty-four clauses and this covers the ones whose answer
 * is genuinely in a set of books; reproducing the rest as empty headings would make the pack look
 * complete and be the opposite.
 */
export const CLAUSES: ClauseSpec[] = [
  {
    clause: '14(a)',
    title: 'Method of valuation of closing stock',
    asks: 'The method employed, and any deviation from section 145A with its effect on the profit.',
    source: 'books',
    authority: 'Section 145A'
  },
  {
    clause: '18',
    title: 'Depreciation under section 32',
    asks: 'Block-wise opening written-down value, additions with dates put to use, deletions, rate, and depreciation allowable.',
    source: 'books',
    authority: 'Section 32 read with rule 5 and the Appendix I rates'
  },
  {
    clause: '21(d)',
    title: 'Payments otherwise than by account-payee instrument',
    asks: 'Payments exceeding the section 40A(3) limit to one person in one day, otherwise than by account-payee cheque, draft or electronic mode.',
    source: 'booksWithJudgement',
    authority: 'Section 40A(3) and 40A(3A)'
  },
  {
    clause: '22',
    title: 'Interest inadmissible under section 23 of the MSMED Act',
    asks: 'Interest payable to a micro or small enterprise on payments beyond the section 15 limit, which is not deductible.',
    source: 'books',
    authority: 'Section 23, Micro, Small and Medium Enterprises Development Act 2006'
  },
  {
    clause: '23',
    title: 'Payments to persons specified in section 40A(2)(b)',
    asks: 'Every payment to a related person, so the assessing officer can test it for excessiveness.',
    source: 'books',
    authority: 'Section 40A(2)(b)'
  },
  {
    clause: '26',
    title: 'Sums referred to in section 43B',
    asks: 'Statutory dues and, since FY 2023-24, sums payable to micro and small enterprises: what was outstanding, what was paid by the due date, and what is disallowed.',
    source: 'books',
    authority: 'Section 43B, including clause (h) inserted by the Finance Act 2023'
  },
  {
    clause: '31(a)',
    title: 'Loans or deposits accepted',
    asks: 'Loans or deposits above the limit accepted otherwise than by account-payee instrument or electronic mode.',
    source: 'booksWithJudgement',
    authority: 'Section 269SS'
  },
  {
    clause: '31(c)',
    title: 'Loans or deposits repaid',
    asks: 'Repayments above the limit made otherwise than by account-payee instrument or electronic mode.',
    source: 'booksWithJudgement',
    authority: 'Section 269T'
  },
  {
    clause: '34(a)',
    title: 'Tax deducted at source',
    asks: 'Section-wise: what was liable to deduction, what was deducted, what was paid, and the shortfall.',
    source: 'books',
    authority: 'Chapter XVII-B'
  },
  {
    clause: '40',
    title: 'Accounting ratios',
    asks: 'Stock-in-trade to turnover, gross profit to turnover, net profit to turnover, material consumed to finished goods — for this year and the last.',
    source: 'books',
    authority: 'Form 3CD clause 40'
  },
  {
    clause: '44',
    title: 'Break-up of total expenditure',
    asks: 'Total expenditure split between entities registered under GST and those not, with the registered part further split.',
    source: 'booksWithJudgement',
    authority: 'Form 3CD clause 44'
  }
]

export interface ClauseRow {
  cells: string[]
}

export interface ClauseExtract {
  clause: string
  title: string
  authority: string
  source: ClauseSource
  columns: string[]
  rows: ClauseRow[]
  /** Totals row, when the clause has one. */
  total: string[] | null
  /**
   * What this extract does NOT establish.
   *
   * Present on nearly every clause, and the most important field on the object: clause 21(d) can
   * list every cash payment over the limit but cannot know which of them went through an account
   * payee instrument, and a pack that did not say so would be read as a finding.
   */
  caveats: string[]
}

export interface Form3cdPack {
  fyStartYear: number
  fyLabel: string
  from: string
  to: string
  extracts: ClauseExtract[]
  /** Clauses in the catalogue that produced nothing, with the reason. A blank is not an answer. */
  empty: { clause: string; title: string; reason: string }[]
}

/** The catalogue entry for a clause, so an extract can be built without repeating its metadata. */
export function clauseSpec(clause: string): ClauseSpec {
  const spec = CLAUSES.find((c) => c.clause === clause)
  if (!spec) throw new Error(`No Form 3CD clause spec for ${clause}`)
  return spec
}

/** An extract that carries its clause's metadata, so a caller only supplies data. */
export function extract(
  clause: string,
  columns: string[],
  rows: ClauseRow[],
  opts: { total?: string[]; caveats?: string[] } = {}
): ClauseExtract {
  const spec = clauseSpec(clause)
  return {
    clause: spec.clause,
    title: spec.title,
    authority: spec.authority,
    source: spec.source,
    columns,
    rows,
    total: opts.total ?? null,
    caveats: opts.caveats ?? []
  }
}
