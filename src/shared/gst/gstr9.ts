/**
 * GSTR-9 annual-return WORKINGS (WP 3.4). Pure: the main process (services/gstExpansion.ts)
 * extracts the financial year's outward documents and ITC documents from the vouchers, builds
 * every month's GSTR-1 / GSTR-3B with the existing builders (or reads the figures snapshotted
 * when that month's JSON was exported), and this module lays out the GSTR-9 tables and the
 * year-vs-Σ-months comparison.
 *
 * Table structure: FORM GSTR-9 as notified (rule 80 CGST Rules), Parts II–VI, tables 4–19 — see
 * GST_SOURCES.gstr9Form in ./sources.ts. Rows the books cannot derive (amendments, Tran-1/2,
 * GSTR-2B-based Table 8A, demands/refunds) are emitted with zero and `source: 'na'` so the
 * screen says so instead of silently showing a confident zero.
 *
 * Money is integer paise throughout; credit notes reduce, debit notes add.
 */
import type { GstAdvanceAgg, GstDoc, Gst3bManual, InwardSummary, ItcBreakdown, TaxTotals } from './returns'
import { isZeroRatedTyp } from './returns'

export interface Gstr9Amounts {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export const ZERO9: Gstr9Amounts = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }

export const add9 = (...xs: Gstr9Amounts[]): Gstr9Amounts =>
  xs.reduce((a, b) => ({ taxable: a.taxable + b.taxable, igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst, cess: a.cess + b.cess }), { ...ZERO9 })
export const sub9 = (a: Gstr9Amounts, b: Gstr9Amounts): Gstr9Amounts => ({
  taxable: a.taxable - b.taxable, igst: a.igst - b.igst, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst, cess: a.cess - b.cess
})
const neg9 = (a: Gstr9Amounts): Gstr9Amounts => sub9(ZERO9, a)
const isZero9 = (a: Gstr9Amounts): boolean => !a.taxable && !a.igst && !a.cgst && !a.sgst && !a.cess
const fromItc = (p: InwardSummary, taxable = 0): Gstr9Amounts => ({ taxable, igst: p.igst, cgst: p.cgst, sgst: p.sgst, cess: p.cess })

/** A voucher behind a GSTR-9 row (drill-down). Amounts are the voucher's contribution to the
 *  row, signed as the row adds them up. */
export interface Gstr9DocRef extends Gstr9Amounts {
  voucherId: number
  number: string
  date: string
  kind: string
  partyName: string | null
  partyLedgerId: number | null
}

export type Gstr9Source = 'books' | 'returns' | 'manual' | 'na'

export interface Gstr9Row {
  /** Form row id: '4A', '4N', '6B-I', '7E', '17', … */
  id: string
  table: string
  label: string
  amounts: Gstr9Amounts
  /** Whether the taxable-value column applies (tables 6–8 carry tax only). */
  hasTaxable: boolean
  kind: 'row' | 'subtotal'
  /** books = computed from the year's vouchers; returns = Σ the monthly GSTR-3B; manual = Σ the
   *  manual 3B adjustments; na = not derivable offline (shown as 0, fill on the portal). */
  source: Gstr9Source
  docs: Gstr9DocRef[]
  note?: string
}

/** Table 9 — tax paid, one row per head. */
export interface Gstr9PaidRow {
  id: 'igst' | 'cgst' | 'sgst' | 'cess' | 'interest' | 'lateFee' | 'penalty' | 'other'
  label: string
  payable: number
  paidCash: number
  /** Paid through ITC, by the CREDIT head used (Table 9 columns). */
  paidItc: { igst: number; cgst: number; sgst: number; cess: number }
}

/** One year-vs-months comparison line (differences are highlighted on screen). */
export interface Gstr9Compare {
  id: string
  label: string
  /** The GSTR-9 figure (from the year's vouchers). */
  annual: Gstr9Amounts
  /** Σ of the monthly returns (exported snapshot where one exists, else rebuilt from the books). */
  monthly: Gstr9Amounts
  diff: Gstr9Amounts
  against: 'GSTR-1' | 'GSTR-3B'
  hasTaxable: boolean
}

// ---------- monthly figures ----------

/** Paise totals read back from one month's GSTR-1 JSON (as exported / as it would export). */
export interface Gstr1Totals {
  /** b2b + b2cl + b2cs + exp(WPAY) + notes, tax charged by the supplier (signed). */
  taxPayable: Gstr9Amounts
  /** Zero-rated without payment (exp WOPAY, SEWOP) and reverse-charge outward supplies (signed). */
  noTax: Gstr9Amounts
  /** Table 8 nil / exempt / non-GST (taxable only). */
  nil: number
  /** 11A − 11B. */
  advancesNet: Gstr9Amounts
  /** Table 12 total. */
  hsn: Gstr9Amounts
}

const p = (x: unknown): number => {
  const n = Number(x ?? 0)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}
const amt = (d: Record<string, unknown>): Gstr9Amounts => ({ taxable: p(d.txval), igst: p(d.iamt), cgst: p(d.camt), sgst: p(d.samt), cess: p(d.csamt) })
const scale = (a: Gstr9Amounts, k: number): Gstr9Amounts => ({ taxable: a.taxable * k, igst: a.igst * k, cgst: a.cgst * k, sgst: a.sgst * k, cess: a.cess * k })
const arr = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? (x as Record<string, unknown>[]) : [])
const itemAmounts = (items: unknown): Gstr9Amounts =>
  add9(...arr(items).map((it) => amt((it.itm_det as Record<string, unknown> | undefined) ?? it)))

/**
 * Sum a GSTR-1 JSON (the offline-tool schema returns.ts builds) back into paise. Routing mirrors
 * the GSTR-9 tables: an invoice whose tax the supplier does not pay (rchrg 'Y', SEWOP, exports
 * WOPAY) is `noTax`; credit notes (ntty 'C') subtract.
 */
export function gstr1JsonTotals(json: Record<string, unknown>): Gstr1Totals {
  let taxPayable = { ...ZERO9 }
  let noTax = { ...ZERO9 }
  const route = (a: Gstr9Amounts, paysTax: boolean, sign: number): void => {
    if (paysTax) taxPayable = add9(taxPayable, scale(a, sign))
    else noTax = add9(noTax, scale({ ...a, igst: 0, cgst: 0, sgst: 0, cess: 0 }, sign))
  }
  for (const g of arr(json.b2b)) {
    for (const inv of arr(g.inv)) route(itemAmounts(inv.itms), inv.rchrg !== 'Y' && inv.inv_typ !== 'SEWOP', 1)
  }
  for (const g of arr(json.b2cl)) for (const inv of arr(g.inv)) route(itemAmounts(inv.itms), true, 1)
  for (const r of arr(json.b2cs)) route(amt(r), true, 1)
  for (const g of arr(json.exp)) for (const inv of arr(g.inv)) route(itemAmounts(inv.itms), g.exp_typ === 'WPAY', 1)
  for (const g of arr(json.cdnr)) {
    for (const nt of arr(g.nt)) route(itemAmounts(nt.itms), nt.rchrg !== 'Y' && nt.inv_typ !== 'SEWOP', nt.ntty === 'C' ? -1 : 1)
  }
  for (const nt of arr(json.cdnur)) route(itemAmounts(nt.itms), nt.typ !== 'EXPWOP', nt.ntty === 'C' ? -1 : 1)
  const nilObj = (json.nil as Record<string, unknown> | undefined) ?? {}
  const nil = arr(nilObj.inv).reduce((s, r) => s + p(r.nil_amt) + p(r.expt_amt) + p(r.ngsup_amt), 0)
  const adv = (rows: unknown): Gstr9Amounts =>
    add9(...arr(rows).flatMap((g) => arr(g.itms).map((it) => ({ taxable: p(it.ad_amt), igst: p(it.iamt), cgst: p(it.camt), sgst: p(it.samt), cess: p(it.csamt) }))))
  const hsnObj = (json.hsn as Record<string, unknown> | undefined) ?? {}
  const hsn = add9(...[...arr(hsnObj.hsn_b2b), ...arr(hsnObj.hsn_b2c), ...arr(hsnObj.data)].map(amt))
  return { taxPayable, noTax, nil, advancesNet: sub9(adv(json.at), adv(json.txpd)), hsn }
}

/** The GSTR-3B figures GSTR-9 needs from one month (a subset of Gstr3bResult, paise). */
export interface Gstr3bFigures {
  outward: TaxTotals
  zeroRated: { taxable: number; igst: number; cess: number }
  nilExempt: { taxable: number }
  rcm: TaxTotals
  /** The return's 4(A) split as filed (Circular 170 shape: 4(A)(5) includes the s.17(5) credit
   *  and any reclaim; `blocked` is unused here — see blocked175). */
  itcParts: ItcBreakdown
  /** The manual adjustments as ENTERED (4(B) by hand, 5.1, 4(D)(1) reclaim) — without the
   *  automatic s.17(5) reversal. */
  manual: Gst3bManual & { itcReclaimed?: InwardSummary }
  /** s.17(5) blocked credit reversed automatically in 4(B)(1). */
  blocked175: InwardSummary
  netPayable: InwardSummary
  rcmPayable: InwardSummary
}

/** How a month's applied ITC-reversal workings split 4(B) by rule (Table 7 rows). */
export interface ReversalSplit {
  rule37: InwardSummary
  rule37A: InwardSummary
  rule42: InwardSummary
  rule43: InwardSummary
}

export interface Gstr9Month {
  period: string
  source: 'exported' | 'books'
  exportedAt: string | null
  gstr1: Gstr1Totals
  gstr3b: Gstr3bFigures
  /** Present when the month's ITC-reversal workings were applied to its 3B. */
  reversalSplit: ReversalSplit | null
}

// ---------- inputs ----------

export type ItcBucket = 'inputs' | 'capital_goods' | 'input_services'
export type ItcSourceKind = 'domestic' | 'import' | 'rcm_unregistered' | 'rcm_registered' | 'blocked'

/** One purchase-side voucher's ITC (paise; purchase-return debit notes negative). */
export interface Gstr9ItcDoc extends Gstr9DocRef {
  bucket: ItcBucket
  source: ItcSourceKind
}

/** Inward HSN line (Table 18). */
export interface Gstr9HsnInLine {
  voucherId: number
  hsn: string
  uqc: string
  qtyMilli: number
  rate: number
  amounts: Gstr9Amounts
}

export interface Gstr9Input {
  fyLabel: string
  gstin: string
  /** The year's outward documents (extractOutwardDocs over the FY). */
  docs: GstDoc[]
  /** The year's 11A / 11B aggregates. */
  advances: GstAdvanceAgg[]
  advanceAdjustments: GstAdvanceAgg[]
  /** The year's purchase-side ITC per voucher (RCM ones carry the tax payable/claimable). */
  itcDocs: Gstr9ItcDoc[]
  hsnInward: Gstr9HsnInLine[]
  months: Gstr9Month[]
}

export interface Gstr9Result {
  fyLabel: string
  gstin: string
  rows: Gstr9Row[]
  paid: Gstr9PaidRow[]
  compare: Gstr9Compare[]
  months: { period: string; source: 'exported' | 'books'; exportedAt: string | null }[]
  hsnOutward: { hsn: string; uqc: string; rate: number; qtyMilli: number; amounts: Gstr9Amounts; voucherIds: number[] }[]
  hsnInward: { hsn: string; uqc: string; rate: number; qtyMilli: number; amounts: Gstr9Amounts; voucherIds: number[] }[]
}

// ---------- set-off detail (Table 9 "paid through ITC") ----------

type Head = 'igst' | 'cgst' | 'sgst' | 'cess'

/**
 * The same utilisation order as returns.ts applySetOff (s.49/49A + rule 88A: IGST credit against
 * IGST, then CGST, then SGST; CGST credit against CGST then IGST; SGST credit against SGST then
 * IGST; cess only against cess), but returning WHO paid WHAT: used[credit][liability].
 */
export function setOffDetail(payable: InwardSummary, credit: InwardSummary): { used: Record<Head, Record<Head, number>>; residual: InwardSummary } {
  const need = { ...payable }
  const avail = { ...credit }
  const used: Record<Head, Record<Head, number>> = {
    igst: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, cgst: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
    sgst: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, cess: { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  }
  const use = (c: Head, l: Head): void => {
    const u = Math.max(0, Math.min(avail[c], need[l]))
    avail[c] -= u
    need[l] -= u
    used[c][l] += u
  }
  use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst')
  use('cgst', 'cgst'); use('cgst', 'igst')
  use('sgst', 'sgst'); use('sgst', 'igst')
  use('cess', 'cess')
  return { used, residual: need }
}

// ---------- the builder ----------

interface Bucket {
  amounts: Gstr9Amounts
  docs: Gstr9DocRef[]
}
const newBucket = (): Bucket => ({ amounts: { ...ZERO9 }, docs: [] })

/** Rate-0 items of a DOMESTIC document are nil-rated (Table 5E); a zero-rated document keeps
 *  them as its own (exports/SEZ at rt 0) — the same routing as returns.ts normalize(). */
function splitDoc(d: GstDoc): { rated: Gstr9Amounts; nil: number } {
  const zeroRated = isZeroRatedTyp(d.invTyp ?? 'R')
  let rated = { ...ZERO9 }
  let nil = 0
  for (const i of d.items) {
    if (i.rate === 0 && !zeroRated) nil += i.taxable
    else rated = add9(rated, { taxable: i.taxable, igst: i.igst, cgst: i.cgst, sgst: i.sgst, cess: i.cess })
  }
  for (const l of d.nilLines ?? []) {
    if (zeroRated) rated = add9(rated, { ...ZERO9, taxable: l.taxable })
    else nil += l.taxable
  }
  return { rated, nil }
}

const docRef = (d: GstDoc, a: Gstr9Amounts): Gstr9DocRef => ({
  voucherId: d.voucherId, number: d.number, date: d.date, kind: d.kind, partyName: d.partyName, partyLedgerId: null, ...a
})

export function buildGstr9(input: Gstr9Input): Gstr9Result {
  // ---------- Part II: outward (tables 4 and 5) ----------
  const b = {
    '4A': newBucket(), '4B': newBucket(), '4C': newBucket(), '4D': newBucket(), '4E': newBucket(), '4I': newBucket(), '4J': newBucket(),
    '5A': newBucket(), '5B': newBucket(), '5C': newBucket(), '5E': newBucket(), '5H': newBucket(), '5I': newBucket()
  }
  type Key = keyof typeof b
  const put = (key: Key, d: GstDoc, a: Gstr9Amounts): void => {
    if (isZero9(a)) return
    b[key].amounts = add9(b[key].amounts, a)
    b[key].docs.push(docRef(d, a))
  }
  /** Nil-rated part of credit/debit notes, kept apart for the GSTR-1 Table 8 comparison. */
  let nilNotes = 0
  /** Non-nil part of 5H/5I, for the "no tax" comparison. */
  for (const d of input.docs) {
    const typ = d.invTyp ?? 'R'
    const { rated, nil } = splitDoc(d)
    const untaxed = { ...rated, igst: 0, cgst: 0, sgst: 0, cess: 0 }
    const isNote = d.kind !== 'sales'
    const credit = d.kind === 'credit_note'
    // Where the document's rated value belongs on the invoice side.
    const taxableRow: Key | null =
      typ === 'EXPWP' ? '4C' : typ === 'SEWP' ? '4D' : typ === 'DE' ? '4E' : typ === 'R' && !d.rchrg ? (d.partyGstin ? '4B' : '4A') : null
    const untaxedRow: Key | null = typ === 'EXPWOP' ? '5A' : typ === 'SEWOP' ? '5B' : typ === 'R' && d.rchrg ? '5C' : null
    if (!isNote) {
      if (taxableRow) put(taxableRow, d, rated)
      else if (untaxedRow) put(untaxedRow, d, untaxed)
      put('5E', d, { ...ZERO9, taxable: nil })
      continue
    }
    // Notes. B2C notes are netted into 4A (GSTR-9 instructions: 4A is net of its notes); every
    // other taxable note is 4I (credit) / 4J (debit); notes on untaxed supplies 5H / 5I.
    if (taxableRow === '4A') put('4A', d, credit ? neg9(rated) : rated)
    else if (taxableRow) put(credit ? '4I' : '4J', d, rated)
    else if (untaxedRow) put(credit ? '5H' : '5I', d, untaxed)
    if (nil) {
      put(credit ? '5H' : '5I', d, { ...ZERO9, taxable: nil })
      nilNotes += credit ? -nil : nil
    }
  }

  // 4F — advances on which tax was paid but no invoice issued in the year (11A − 11B).
  const advAmt = (aggs: GstAdvanceAgg[]): Gstr9Amounts =>
    add9(...aggs.map((a) => ({ taxable: a.taxable, igst: a.igst, cgst: a.cgst, sgst: a.sgst, cess: a.cess })))
  const adv4F = sub9(advAmt(input.advances), advAmt(input.advanceAdjustments))

  // 4G — inward supplies on which tax is payable on reverse charge (the year's RCM purchases).
  const rcmDocs = input.itcDocs.filter((x) => x.source === 'rcm_unregistered' || x.source === 'rcm_registered')
  const rcm4G = add9(...rcmDocs.map((x) => ({ taxable: x.taxable, igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess })))

  const A = (k: Key): Gstr9Amounts => b[k].amounts
  const sub4H = add9(A('4A'), A('4B'), A('4C'), A('4D'), A('4E'), adv4F, rcm4G)
  const sub4M = sub9(A('4J'), A('4I')) // 4K / 4L amendments: none in the books
  const total4N = add9(sub4H, sub4M)
  const sub5G = add9(A('5A'), A('5B'), A('5C'), A('5E'))
  const sub5L = sub9(A('5I'), A('5H'))
  const total5M = add9(sub5G, sub5L)
  const total5N = sub9(add9(total4N, total5M), rcm4G)

  const rows: Gstr9Row[] = []
  const row = (id: string, table: string, label: string, amounts: Gstr9Amounts, o: Partial<Pick<Gstr9Row, 'kind' | 'source' | 'docs' | 'note' | 'hasTaxable'>> = {}): void => {
    rows.push({ id, table, label, amounts, hasTaxable: o.hasTaxable ?? true, kind: o.kind ?? 'row', source: o.source ?? 'books', docs: o.docs ?? [], ...(o.note ? { note: o.note } : {}) })
  }
  const bk = (id: Key, table: string, label: string, note?: string): void => row(id, table, label, A(id), { docs: b[id].docs, ...(note ? { note } : {}) })
  const na = (id: string, table: string, label: string, note: string, hasTaxable = true): void => row(id, table, label, { ...ZERO9 }, { source: 'na', note, hasTaxable })

  bk('4A', '4', 'Supplies made to un-registered persons (B2C)', 'Net of the credit / debit notes issued on them.')
  bk('4B', '4', 'Supplies made to registered persons (B2B)')
  bk('4C', '4', 'Zero rated supply (Export) on payment of tax (except supplies to SEZs)')
  bk('4D', '4', 'Supply to SEZs on payment of tax')
  bk('4E', '4', 'Deemed Exports', 'Parties cannot be flagged as deemed-export recipients yet — always 0.')
  row('4F', '4', 'Advances on which tax has been paid but invoice has not been issued (not covered under (B) to (E) above)', adv4F, {
    note: 'GSTR-1 11A advances received less 11B advances adjusted in the year.'
  })
  row('4G', '4', 'Inward supplies on which tax is to be paid on reverse charge basis', rcm4G, { docs: rcmDocs.map(stripItc) })
  row('4H', '4', 'Sub-total (A to G above)', sub4H, { kind: 'subtotal' })
  bk('4I', '4', 'Credit Notes issued in respect of transactions specified in (B) to (E) above (-)')
  bk('4J', '4', 'Debit Notes issued in respect of transactions specified in (B) to (E) above (+)')
  na('4K', '4', 'Supplies / tax declared through Amendments (+)', 'The books keep no return amendments — enter from the portal.')
  na('4L', '4', 'Supplies / tax reduced through Amendments (-)', 'The books keep no return amendments — enter from the portal.')
  row('4M', '4', 'Sub-total (I to L above)', sub4M, { kind: 'subtotal' })
  row('4N', '4', 'Supplies and advances on which tax is to be paid (H + M) above', total4N, { kind: 'subtotal' })

  bk('5A', '5', 'Zero rated supply (Export) without payment of tax')
  bk('5B', '5', 'Supply to SEZs without payment of tax')
  bk('5C', '5', 'Supplies on which tax is to be paid by the recipient on reverse charge basis')
  na('5D', '5', 'Exempted', 'Ledgers cannot be classified exempt yet — exempt supplies are reported as nil rated (5E).')
  bk('5E', '5', 'Nil Rated')
  na('5F', '5', 'Non-GST supply (includes "no supply")', 'Non-GST supplies are not classified in the books.')
  row('5G', '5', 'Sub-total (A to F above)', sub5G, { kind: 'subtotal' })
  bk('5H', '5', 'Credit Notes issued in respect of transactions specified in A to F above (-)')
  bk('5I', '5', 'Debit Notes issued in respect of transactions specified in A to F above (+)')
  na('5J', '5', 'Supplies declared through Amendments (+)', 'The books keep no return amendments — enter from the portal.')
  na('5K', '5', 'Supplies reduced through Amendments (-)', 'The books keep no return amendments — enter from the portal.')
  row('5L', '5', 'Sub-total (H to K above)', sub5L, { kind: 'subtotal' })
  row('5M', '5', 'Turnover on which tax is not to be paid (G + L) above', total5M, { kind: 'subtotal' })
  row('5N', '5', 'Total Turnover (including advances) (4N + 5M - 4G) above', total5N, { kind: 'subtotal' })

  // ---------- Part III: ITC (tables 6, 7, 8) ----------
  const months = input.months
  const sumMonths = (f: (m: Gstr9Month) => InwardSummary): InwardSummary =>
    months.reduce((t, m) => {
      const x = f(m)
      return { igst: t.igst + x.igst, cgst: t.cgst + x.cgst, sgst: t.sgst + x.sgst, cess: t.cess + x.cess }
    }, { igst: 0, cgst: 0, sgst: 0, cess: 0 })
  const addIs = (...xs: InwardSummary[]): InwardSummary =>
    xs.reduce((t, x) => ({ igst: t.igst + x.igst, cgst: t.cgst + x.cgst, sgst: t.sgst + x.sgst, cess: t.cess + x.cess }), { igst: 0, cgst: 0, sgst: 0, cess: 0 })
  const subIs = (a: InwardSummary, c: InwardSummary): InwardSummary => ({ igst: a.igst - c.igst, cgst: a.cgst - c.cgst, sgst: a.sgst - c.sgst, cess: a.cess - c.cess })

  const itc6A = sumMonths((m) => addIs(m.gstr3b.itcParts.impg, m.gstr3b.itcParts.isrc, m.gstr3b.itcParts.oth))
  row('6A', '6', 'Total amount of input tax credit availed through FORM GSTR-3B (sum total of Table 4A of FORM GSTR-3B)', fromItc(itc6A), { source: 'returns', hasTaxable: false })
  // 6A1 / 6A2 (Notification 13/2025-CT): the books record ITC in the purchase's own month, so no
  // preceding-year ITC is ever availed in this year's 3B — 6A1 is nil by construction.
  row('6A1', '6', 'ITC of preceding financial year availed in the financial year (included in 6A above) other than ITC reclaimed under rule 37 and rule 37A', { ...ZERO9 }, {
    hasTaxable: false, note: 'The books record ITC in the purchase’s own month — nil by construction.'
  })
  row('6A2', '6', 'Net ITC of the financial year (A − A1)', fromItc(itc6A), { kind: 'subtotal', source: 'returns', hasTaxable: false })

  const itcRows = (id: string, label: string, sources: ItcSourceKind[], buckets: ItcBucket[]): InwardSummary => {
    let total: InwardSummary = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
    for (const bucket of buckets) {
      const ds = input.itcDocs.filter((x) => sources.includes(x.source) && x.bucket === bucket)
      const a = add9(...ds.map((x) => ({ ...ZERO9, igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess })))
      total = addIs(total, a)
      row(`${id}-${BUCKET_CODE[bucket]}`, '6', `${label} — ${BUCKET_LABEL[bucket]}`, a, { hasTaxable: false, docs: ds.map(stripItc) })
    }
    return total
  }
  const i6B = itcRows('6B', 'Inward supplies (other than imports and inward supplies liable to reverse charge but includes services received from SEZs)', ['domestic', 'blocked'], ['inputs', 'capital_goods', 'input_services'])
  const i6C = itcRows('6C', 'Inward supplies received from unregistered persons liable to reverse charge (other than B above) on which tax is paid & ITC availed', ['rcm_unregistered'], ['inputs', 'capital_goods', 'input_services'])
  const i6D = itcRows('6D', 'Inward supplies received from registered persons liable to reverse charge (other than B above) on which tax is paid and ITC availed', ['rcm_registered'], ['inputs', 'capital_goods', 'input_services'])
  const i6E = itcRows('6E', 'Import of goods (including supplies from SEZs)', ['import'], ['inputs', 'capital_goods'])
  const imps = input.itcDocs.filter((x) => x.source === 'import' && x.bucket === 'input_services')
  const i6F = add9(...imps.map((x) => ({ ...ZERO9, igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess })))
  row('6F', '6', 'Import of services (excluding inward supplies from SEZs)', i6F, { hasTaxable: false, docs: imps.map(stripItc) })
  na('6G', '6', 'Input Tax credit received from ISD', 'Input Service Distributor credit is not modelled in the books.', false)
  const reclaimed = sumMonths((m) => m.gstr3b.manual.itcReclaimed ?? { igst: 0, cgst: 0, sgst: 0, cess: 0 })
  row('6H', '6', 'Amount of ITC reclaimed under the provisions of the Act', fromItc(reclaimed), {
    source: 'returns', hasTaxable: false, note: 'Σ GSTR-3B 4(D)(1): ITC re-availed after a rule 37 / 37A reversal (Notification 13/2025-CT: reclaims go here only).'
  })
  const i6I = addIs(i6B, i6C, i6D, i6E, i6F, reclaimed)
  row('6I', '6', 'Sub-total (B to H above)', fromItc(i6I), { kind: 'subtotal', hasTaxable: false })
  row('6J', '6', 'Difference (I − A2 above)', fromItc(subIs(i6I, itc6A)), { kind: 'subtotal', hasTaxable: false, note: 'Should be nil — a difference means the books changed after the monthly 3B figures.' })
  na('6K', '6', 'Transition Credit through TRAN-I (including revisions if any)', 'Transition credit is not modelled.', false)
  na('6L', '6', 'Transition Credit through TRAN-II', 'Transition credit is not modelled.', false)
  na('6M', '6', 'ITC availed through ITC-01, ITC-02 and ITC-02A (other than GSTR-3B and TRAN Forms)', 'ITC-01 / ITC-02 credit is not modelled.', false)
  row('6N', '6', 'Sub-total (K to M above)', { ...ZERO9 }, { kind: 'subtotal', hasTaxable: false })
  row('6O', '6', 'Total ITC availed (I + N) above', fromItc(i6I), { kind: 'subtotal', hasTaxable: false })

  // Table 7 — Σ the monthly 4(B) reversals. 7E is the s.17(5) blocked credit the 3B reverses in
  // 4(B)(1) automatically (Circular 170/02/2022-GST); rules 37 / 37A / 42 / 43 come from the
  // months whose ITC-reversal workings were applied; whatever else was entered by hand in 4(B)
  // is 7H "Other".
  const split = (f: (s: ReversalSplit) => InwardSummary): InwardSummary => sumMonths((m) => (m.reversalSplit ? f(m.reversalSplit) : { igst: 0, cgst: 0, sgst: 0, cess: 0 }))
  const r37 = split((s) => s.rule37), r37A = split((s) => s.rule37A), r42 = split((s) => s.rule42), r43 = split((s) => s.rule43)
  // 7E from the YEAR's vouchers (the 3B months reversed their own blocked175 — compared below).
  const blockedDocs = input.itcDocs.filter((x) => x.source === 'blocked')
  const r175 = addIs(...blockedDocs.map((x) => ({ igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess })))
  const r175Months = sumMonths((m) => m.gstr3b.blocked175)
  const manual4B = sumMonths((m) => addIs(m.gstr3b.manual.itcRevRul, m.gstr3b.manual.itcRevOth))
  const other7H = subIs(manual4B, addIs(r37, r37A, r42, r43))
  const rev = (id: string, label: string, v: InwardSummary, o: { note?: string; source?: Gstr9Source } = {}): void =>
    row(id, '7', label, fromItc(v), { source: o.source ?? 'manual', hasTaxable: false, ...(o.note ? { note: o.note } : {}) })
  rev('7A', 'As per Rule 37', r37)
  rev('7A1', 'As per Rule 37A', r37A)
  na('7A2', '7', 'As per rule 38', 'Banking-company credit reversals are not modelled.', false)
  na('7B', '7', 'As per Rule 39', 'Input Service Distributor reversals are not modelled.', false)
  rev('7C', 'As per Rule 42', r42)
  rev('7D', 'As per Rule 43', r43)
  row('7E', '7', 'As per section 17(5)', fromItc(r175), {
    source: 'books', hasTaxable: false, docs: blockedDocs.map(stripItc), note: 'Credit of parties marked “blocked” — availed in 3B 4(A)(5) and reversed in 4(B)(1).'
  })
  na('7F', '7', 'Reversal of TRAN-I credit', 'Transition credit is not modelled.', false)
  na('7G', '7', 'Reversal of TRAN-II credit', 'Transition credit is not modelled.', false)
  rev('7H', 'Other reversals (pl. specify)', other7H, { note: '4(B) amounts entered by hand, not split by rule.' })
  const total7I = addIs(manual4B, r175)
  row('7I', '7', 'Total ITC Reversed (Sum of A to H above)', fromItc(total7I), { kind: 'subtotal', hasTaxable: false })
  row('7J', '7', 'Net ITC Available for Utilization (6O - 7I)', fromItc(subIs(i6I, total7I)), { kind: 'subtotal', hasTaxable: false })

  // Table 8 — 8A is auto-populated on the portal from GSTR-2B; the books can give 8B and 8G/8H.
  na('8A', '8', 'ITC as per GSTR-2B (table 3 thereof)', 'Auto-populated on the portal from the year’s GSTR-2B (Notification 20/2024-CT) — not available offline.', false)
  row('8B', '8', 'ITC as per 6(B) above', fromItc(i6B), { kind: 'subtotal', hasTaxable: false })
  na('8C', '8', 'ITC on inward supplies (other than imports and inward supplies liable to reverse charge but includes services received from SEZs) received during the financial year but availed in the next financial year up to specified period', 'The books record ITC in the purchase’s own month.', false)
  na('8D', '8', 'Difference [A-(B+C)]', 'Needs 8A from the portal.', false)
  na('8E', '8', 'ITC available but not availed', 'Needs 8A from the portal.', false)
  na('8F', '8', 'ITC available but ineligible', 'Needs 8A from the portal.', false)
  const i8G = add9(...input.itcDocs.filter((x) => x.source === 'import' && x.bucket !== 'input_services').map((x) => ({ ...ZERO9, igst: x.igst, cess: x.cess })))
  row('8G', '8', 'IGST paid on import of goods (including supplies from SEZ)', i8G, { hasTaxable: false, note: 'As booked on import purchases (Bill of Entry figures on the portal may differ).' })
  row('8H', '8', 'IGST credit availed on import of goods (as per 6(E) above) in the financial year', fromItc(i6E), { hasTaxable: false })
  na('8H1', '8', 'IGST credit availed on import of goods in next financial year', 'Availed in the next financial year’s returns — not in this year’s books.', false)
  row('8I', '8', 'Difference [G − (H + H1)]', sub9(i8G, fromItc(i6E)), { kind: 'subtotal', hasTaxable: false })
  na('8J', '8', 'ITC available but not availed on import of goods (Equal to I)', 'Equal to 8I when positive.', false)
  na('8K', '8', 'Total ITC to be lapsed in current financial year (E + F + J)', 'Needs 8A from the portal.', false)

  // ---------- Part IV: Table 9 — tax paid (Σ months) ----------
  const liability = (m: Gstr9Month): InwardSummary => ({
    igst: m.gstr3b.outward.igst + m.gstr3b.zeroRated.igst,
    cgst: m.gstr3b.outward.cgst,
    sgst: m.gstr3b.outward.sgst,
    cess: m.gstr3b.outward.cess + m.gstr3b.zeroRated.cess
  })
  const paid: Gstr9PaidRow[] = []
  const usedTotal: Record<Head, Record<Head, number>> = {
    igst: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, cgst: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
    sgst: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, cess: { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  }
  let payable: InwardSummary = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  let cash: InwardSummary = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  for (const m of months) {
    const L = liability(m)
    const net = subIs(
      addIs(m.gstr3b.itcParts.impg, m.gstr3b.itcParts.isrc, m.gstr3b.itcParts.oth),
      addIs(m.gstr3b.manual.itcRevRul, m.gstr3b.manual.itcRevOth, m.gstr3b.blocked175)
    )
    const d = setOffDetail(L, net)
    for (const c of HEADS) for (const l of HEADS) usedTotal[c][l] += d.used[c][l]
    // RCM tax is payable in cash only (never from ITC) — 3.1(d) joins the payable and the cash.
    payable = addIs(payable, L, m.gstr3b.rcm)
    cash = addIs(cash, d.residual, m.gstr3b.rcmPayable)
  }
  const HEAD_LABEL: Record<Head, string> = { igst: 'Integrated Tax', cgst: 'Central Tax', sgst: 'State/UT Tax', cess: 'Cess' }
  for (const h of HEADS) {
    paid.push({ id: h, label: HEAD_LABEL[h], payable: payable[h], paidCash: cash[h], paidItc: { igst: usedTotal.igst[h], cgst: usedTotal.cgst[h], sgst: usedTotal.sgst[h], cess: usedTotal.cess[h] } })
  }
  const interest = sumMonths((m) => m.gstr3b.manual.interest)
  const lateFee = months.reduce((t, m) => t + m.gstr3b.manual.lateFee.camt + m.gstr3b.manual.lateFee.samt, 0)
  const zeroItc = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  const interestTotal = interest.igst + interest.cgst + interest.sgst + interest.cess
  paid.push({ id: 'interest', label: 'Interest', payable: interestTotal, paidCash: interestTotal, paidItc: zeroItc })
  paid.push({ id: 'lateFee', label: 'Late fee', payable: lateFee, paidCash: lateFee, paidItc: zeroItc })
  paid.push({ id: 'penalty', label: 'Penalty', payable: 0, paidCash: 0, paidItc: zeroItc })
  paid.push({ id: 'other', label: 'Other', payable: 0, paidCash: 0, paidItc: zeroItc })

  // ---------- Part V: tables 10–14 (amendments in the next FY's returns) ----------
  na('10', '10', 'Supplies / tax declared through Invoices / Debit Note / Amendments (+)', 'Declared in the next financial year’s returns (April–October, filed by 30 November) — not in this year’s books.')
  na('11', '11', 'Supplies / tax reduced through Amendments / Credit Note (-)', 'Declared in the next financial year’s returns — not in this year’s books.')
  na('12', '12', 'ITC of the financial year reversed in the next financial year', 'Reversed in the next financial year’s returns — not in this year’s books.', false)
  na('13', '13', 'ITC of the financial year availed in the next financial year', 'Availed in the next financial year’s returns — not in this year’s books.', false)
  na('14', '14', 'Differential tax paid on account of declaration in 10 & 11 above', 'Follows tables 10 and 11.', false)

  // ---------- Part VI: HSN summaries (tables 17 / 18) ----------
  const hsnOutward = aggregateHsn(
    input.docs.flatMap((d) => d.hsnLines.map((h) => {
      const sign = d.kind === 'credit_note' ? -1 : 1
      return { voucherId: d.voucherId, hsn: h.hsn, uqc: h.uqc, rate: h.rate, qtyMilli: sign * h.qtyMilli, amounts: scale({ taxable: h.taxable, igst: h.igst, cgst: h.cgst, sgst: h.sgst, cess: h.cess }, sign) }
    }))
  )
  const hsnInward = aggregateHsn(input.hsnInward)
  const hsnOutTotal = add9(...hsnOutward.map((h) => h.amounts))
  row('17', '17', 'HSN-wise summary of outward supplies (total)', hsnOutTotal, { note: 'Per-HSN rows below.' })
  row('18', '18', 'HSN-wise summary of inward supplies (total)', add9(...hsnInward.map((h) => h.amounts)), { note: 'Tax computed at the item master rate on each inward line.' })

  // ---------- comparison: the year vs Σ the months ----------
  const sumG1 = (f: (t: Gstr1Totals) => Gstr9Amounts): Gstr9Amounts => add9(...months.map((m) => f(m.gstr1)))
  const sum3b = (f: (g: Gstr3bFigures) => Gstr9Amounts): Gstr9Amounts => add9(...months.map((m) => f(m.gstr3b)))
  const taxPayableYear = add9(A('4A'), A('4B'), A('4C'), A('4D'), A('4E'), sub9(A('4J'), A('4I')))
  const noTaxYear = sub9(add9(A('5A'), A('5B'), A('5C'), A('5I')), A('5H'))
  // 5H / 5I carry both untaxed-supply notes and nil notes; split the nil part back out.
  const noTaxYearExNil = { ...noTaxYear, taxable: noTaxYear.taxable - nilNotes }
  const nilYear = A('5E').taxable + nilNotes
  const cmp = (id: string, label: string, annual: Gstr9Amounts, monthly: Gstr9Amounts, against: Gstr9Compare['against'], hasTaxable = true): Gstr9Compare => ({
    id, label, annual, monthly, diff: sub9(annual, monthly), against, hasTaxable
  })
  const compare: Gstr9Compare[] = [
    cmp('g1-taxable', 'Tax-paying outward supplies — 4A to 4E net of 4I/4J', taxPayableYear, sumG1((t) => t.taxPayable), 'GSTR-1'),
    cmp('g1-notax', 'Outward supplies without tax — 5A to 5C net of their notes', noTaxYearExNil, sumG1((t) => t.noTax), 'GSTR-1'),
    cmp('g1-nil', 'Nil rated / exempt / non-GST — 5D to 5F net of notes (GSTR-1 Table 8)', { ...ZERO9, taxable: nilYear }, { ...ZERO9, taxable: months.reduce((s, m) => s + m.gstr1.nil, 0) }, 'GSTR-1'),
    cmp('g1-adv', 'Advances — 4F (GSTR-1 11A − 11B)', adv4F, sumG1((t) => t.advancesNet), 'GSTR-1'),
    cmp('g1-hsn', 'HSN summary — Table 17 (GSTR-1 Table 12)', hsnOutTotal, sumG1((t) => t.hsn), 'GSTR-1'),
    cmp('3b-out', 'Outward taxable + zero rated — 4A–4E, 5A–5C net of notes (3B 3.1(a) + 3.1(b))', add9(taxPayableYear, noTaxYearExNil),
      sum3b((g) => ({ taxable: g.outward.taxable + g.zeroRated.taxable, igst: g.outward.igst + g.zeroRated.igst, cgst: g.outward.cgst, sgst: g.outward.sgst, cess: g.outward.cess + g.zeroRated.cess })), 'GSTR-3B'),
    cmp('3b-nil', 'Nil rated / exempt — 5D to 5F (3B 3.1(c))', { ...ZERO9, taxable: nilYear }, sum3b((g) => ({ ...ZERO9, taxable: g.nilExempt.taxable })), 'GSTR-3B'),
    cmp('3b-rcm', 'Inward reverse charge — 4G (3B 3.1(d))', rcm4G, sum3b((g) => ({ taxable: g.rcm.taxable, igst: g.rcm.igst, cgst: g.rcm.cgst, sgst: g.rcm.sgst, cess: g.rcm.cess })), 'GSTR-3B'),
    cmp('3b-itc', 'ITC availed — 6B to 6H (3B 4(A) = 6A)', fromItc(i6I), fromItc(itc6A), 'GSTR-3B', false),
    cmp('3b-rev', 'ITC reversed — 7I (3B 4(B))', fromItc(total7I), fromItc(addIs(manual4B, r175Months)), 'GSTR-3B', false),
    cmp('3b-paid', 'Tax payable — 4N less 4F (Table 9, Σ 3B)', { ...sub9(total4N, adv4F), taxable: 0 }, { ...ZERO9, ...payable }, 'GSTR-3B', false)
  ]

  return {
    fyLabel: input.fyLabel,
    gstin: input.gstin,
    rows,
    paid,
    compare,
    months: months.map((m) => ({ period: m.period, source: m.source, exportedAt: m.exportedAt })),
    hsnOutward,
    hsnInward
  }
}

const HEADS: Head[] = ['igst', 'cgst', 'sgst', 'cess']
const BUCKET_CODE: Record<ItcBucket, string> = { inputs: 'I', capital_goods: 'CG', input_services: 'IS' }
const BUCKET_LABEL: Record<ItcBucket, string> = { inputs: 'Inputs', capital_goods: 'Capital goods', input_services: 'Input services' }
const stripItc = (x: Gstr9ItcDoc): Gstr9DocRef => ({
  voucherId: x.voucherId, number: x.number, date: x.date, kind: x.kind, partyName: x.partyName, partyLedgerId: x.partyLedgerId,
  taxable: x.taxable, igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess
})

function aggregateHsn(lines: { voucherId: number; hsn: string; uqc: string; rate: number; qtyMilli: number; amounts: Gstr9Amounts }[]) {
  const agg = new Map<string, { hsn: string; uqc: string; rate: number; qtyMilli: number; amounts: Gstr9Amounts; voucherIds: number[] }>()
  for (const l of lines) {
    const key = `${l.hsn}|${l.uqc}|${l.rate}`
    const a = agg.get(key) ?? { hsn: l.hsn, uqc: l.uqc, rate: l.rate, qtyMilli: 0, amounts: { ...ZERO9 }, voucherIds: [] }
    a.qtyMilli += l.qtyMilli
    a.amounts = add9(a.amounts, l.amounts)
    if (!a.voucherIds.includes(l.voucherId)) a.voucherIds.push(l.voucherId)
    agg.set(key, a)
  }
  return [...agg.values()].sort((x, y) => x.hsn.localeCompare(y.hsn) || x.rate - y.rate)
}

// ---------- export ----------

const rupees = (paise: number): number => Math.round(paise) / 100
const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV of every table row, the Table 9 rows and the comparison, plain rupee decimals. */
export function gstr9Csv(r: Gstr9Result): string {
  const out: string[] = []
  out.push(['Table', 'Row', 'Particulars', 'Taxable value', 'Integrated tax', 'Central tax', 'State/UT tax', 'Cess', 'Source', 'Note'].map(csvCell).join(','))
  for (const x of r.rows) {
    out.push([x.table, x.id, x.label, x.hasTaxable ? rupees(x.amounts.taxable).toFixed(2) : '', rupees(x.amounts.igst).toFixed(2), rupees(x.amounts.cgst).toFixed(2),
      rupees(x.amounts.sgst).toFixed(2), rupees(x.amounts.cess).toFixed(2), x.source === 'na' ? 'Not derivable offline' : x.source, x.note ?? ''].map(csvCell).join(','))
  }
  out.push('')
  out.push(['Table 9', 'Head', 'Tax payable', 'Paid in cash', 'Paid through ITC — Integrated', 'Central', 'State/UT', 'Cess'].map(csvCell).join(','))
  for (const x of r.paid) {
    out.push(['9', x.label, rupees(x.payable).toFixed(2), rupees(x.paidCash).toFixed(2), rupees(x.paidItc.igst).toFixed(2), rupees(x.paidItc.cgst).toFixed(2),
      rupees(x.paidItc.sgst).toFixed(2), rupees(x.paidItc.cess).toFixed(2)].map(csvCell).join(','))
  }
  out.push('')
  out.push(['Comparison', 'Against', 'Particulars', 'Annual taxable', 'Monthly taxable', 'Diff taxable', 'Diff IGST', 'Diff CGST', 'Diff SGST', 'Diff cess'].map(csvCell).join(','))
  for (const c of r.compare) {
    out.push([c.id, c.against, c.label, rupees(c.annual.taxable).toFixed(2), rupees(c.monthly.taxable).toFixed(2), rupees(c.diff.taxable).toFixed(2), rupees(c.diff.igst).toFixed(2),
      rupees(c.diff.cgst).toFixed(2), rupees(c.diff.sgst).toFixed(2), rupees(c.diff.cess).toFixed(2)].map(csvCell).join(','))
  }
  return out.join('\n')
}

/**
 * GSTR-9 JSON — the app's own layout keyed by the form's row ids (table4.a … table18). The GSTN
 * GSTR-9 offline tool's JSON schema is not published as a citable document (UNVERIFIED — see
 * ./sources.ts), so this file is for review / hand entry, NOT a portal upload.
 */
export function gstr9Json(r: Gstr9Result): Record<string, unknown> {
  const tables: Record<string, Record<string, unknown>> = {}
  for (const x of r.rows) {
    const t = (tables[`table${x.table}`] ??= {})
    t[x.id.toLowerCase().replace(/^\d+/, '') || 'total'] = {
      ...(x.hasTaxable ? { txval: rupees(x.amounts.taxable) } : {}),
      iamt: rupees(x.amounts.igst), camt: rupees(x.amounts.cgst), samt: rupees(x.amounts.sgst), csamt: rupees(x.amounts.cess),
      ...(x.source === 'na' ? { derivable_offline: false } : {})
    }
  }
  return {
    format: 'total.gstr9-workings.v1',
    verified_against_offline_tool: false,
    gstin: r.gstin,
    fy: r.fyLabel,
    ...tables,
    table9: Object.fromEntries(r.paid.map((x) => [x.id, { txpyble: rupees(x.payable), txpaid_cash: rupees(x.paidCash), tax_paid_itc_iamt: rupees(x.paidItc.igst), tax_paid_itc_camt: rupees(x.paidItc.cgst), tax_paid_itc_samt: rupees(x.paidItc.sgst), tax_paid_itc_csamt: rupees(x.paidItc.cess) }])),
    table17: r.hsnOutward.map((h) => ({ hsn_sc: h.hsn, uqc: h.uqc, qty: h.qtyMilli / 1000, rt: h.rate, txval: rupees(h.amounts.taxable), iamt: rupees(h.amounts.igst), camt: rupees(h.amounts.cgst), samt: rupees(h.amounts.sgst), csamt: rupees(h.amounts.cess) })),
    table18: r.hsnInward.map((h) => ({ hsn_sc: h.hsn, uqc: h.uqc, qty: h.qtyMilli / 1000, rt: h.rate, txval: rupees(h.amounts.taxable), iamt: rupees(h.amounts.igst), camt: rupees(h.amounts.cgst), samt: rupees(h.amounts.sgst), csamt: rupees(h.amounts.cess) })),
    comparison: r.compare.map((c) => ({ id: c.id, against: c.against, label: c.label, annual: c.annual, monthly: c.monthly, diff: c.diff })),
    months: r.months
  }
}
