// GST golden fixtures (Phase 2a) — the shape of one hand-worked bill.
//
// A fixture states its INPUTS (what the user types: the bill's rows in the invoice editor, or the
// lines of an accounting-form entry) and the EXPECTED figures worked out by hand, with the
// arithmetic in a comment above it. The expected figures are never produced by running the app.
// All amounts are in rupees (numbers with at most two decimals); the test converts to paise.

import type { CompanyKey, ItemKey, LedgerKey, PartyKey } from './masters'

/** One row of the invoice editor: item, quantity as typed, rate per unit, line discount (₹). */
export interface RowIn {
  item: ItemKey
  qty: string
  rate: number
  discount?: number
}

/** One line of an accounting-form entry, typed as is. `party` = the document's party ledger. */
export interface LineIn {
  ledger: LedgerKey | 'party'
  side: 'dr' | 'cr'
  amount: number
}

export type DocKind = 'sales' | 'credit_note' | 'debit_note' | 'purchase' | 'receipt'

export interface DocIn {
  kind: DocKind
  date: string
  number: string
  party: PartyKey
  /** Invoice editor: the bill's rows (the sales / purchase ledger is `account`, default Sales / Purchases). */
  rows?: RowIn[]
  account?: LedgerKey
  /** Accounting form: the entry's lines (no invoice computation — the user typed every amount). */
  lines?: LineIn[]
  reference?: string
  posOverride?: string
  billRefs?: { kind: 'new' | 'against'; name: string; amount: number }[]
  /** Shipping bill for an export (voucher_transport doc no / date). */
  shippingBill?: { num: string; date: string }
}

/** The hand-worked figures of one line of the bill (₹). Heads not given are 0. */
export interface ExpectedLine {
  taxable: number
  /** The GST rate the line is reported at. */
  rate: number
  cgst?: number
  sgst?: number
  igst?: number
  cess?: number
  cessRate?: number
  /** Before the line discount (e-invoice TotAmt); default = taxable. */
  gross?: number
  discount?: number
}

/**
 * Where the document belongs in GSTR-1, decided by hand from the rules:
 * b2b (4A / 6B SEZ, incl. inv_typ SEWP / SEWOP), b2cl (5), b2cs (7), exp (6A), cdnr / cdnur (9B),
 * none = no invoice / note table (an inward document, an advance), not-filed = a composition or
 * unregistered business files no GSTR-1 — no tax may appear anywhere.
 */
export type Gstr1Section = 'b2b' | 'b2cl' | 'b2cs' | 'exp' | 'cdnr' | 'cdnur' | 'none' | 'not-filed'

export interface Heads { txval?: number; iamt?: number; camt?: number; samt?: number; csamt?: number }

export interface Expected {
  /** Per line, in the bill's order. A rate-0 line is nil-rated (Table 8 / 3B 3.1(c)) unless zero-rated. */
  lines: ExpectedLine[]
  /** Round off on the bill (+ = rounded up). */
  roundOff: number
  /** The bill's total — what the buyer owes. */
  total: number
  gstr1: Gstr1Section
  /** CDNUR note type when gstr1 = 'cdnur'. */
  cdnurTyp?: 'B2CL' | 'EXPWP' | 'EXPWOP'
  /** GSTR-1 tables stated outright (replace the derived one of that key), e.g. at / txpd. */
  gstr1Tables?: Record<string, unknown>
  /** GSTR-3B figures stated outright for this document's month (replace the derived ones). */
  gstr3b?: {
    osup_det?: Heads
    osup_zero?: Heads
    osup_nil_exmp?: Heads
    isup_rev?: Heads
    itc_net?: Heads
    itc_avl?: Partial<Record<'IMPG' | 'ISRC' | 'OTH', Heads>>
    itc_rev_rul?: Heads
    unreg_details?: { pos: string; txval: number; iamt: number }[]
  }
  /** An e-invoice (IRN) is required for this document: B2B / SEZ / export by a regular business. */
  einvoice: boolean
}

export interface GoldenFixture {
  id: string
  title: string
  company?: CompanyKey
  /** Documents entered before this one (originals of a note, an advance), in earlier months. */
  before?: DocIn[]
  doc: DocIn
  expect: Expected
  /** The app disagrees with the hand-worked figure (a bug reported to the owner, not "fixed" in
   *  the fixture): those outputs' tests are expected to FAIL until the app is corrected (it.fails). */
  knownBug?: { in: GoldenOutput[]; reason: string }
}

/** The four outputs every fixture pins. */
export type GoldenOutput = 'invoice' | 'gstr1' | 'gstr3b' | 'einvoice'
