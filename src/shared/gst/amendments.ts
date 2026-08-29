/**
 * GSTR-1 amendment tables — B2BA (9A), B2CLA (9A), CDNRA (9C) and CDNURA (9C).
 *
 * Why this module exists, in one paragraph: once a GSTR-1 for a period is filed it is not
 * re-filed. A correction to an invoice that was already filed is a NEW ROW in an amendment
 * table of a LATER period, and that row carries two things — the ORIGINAL document's identity
 * (counterparty GSTIN + document number + document date) as the key the portal matches on, and
 * the REVISED particulars as the new truth. Get the key wrong and the portal cannot find the
 * document being amended: the row is rejected, the original stands, and the books and the return
 * quietly disagree until somebody's annual reconciliation finds it.
 *
 * Pure, like the rest of src/shared: money is integer paise in, rupees only at the JSON edge;
 * dates are ISO 'YYYY-MM-DD' in, portal 'DD-MM-YYYY' only at the JSON edge.
 *
 * Field naming is pinned to GSTN's GSTR-1 Save API v5.0 schema, published 23 February 2026, and
 * the current Returns Offline Tool manual (rechecked 28 August 2026). In particular, B2BA uses
 * group-level `ctin` plus `oinum`/`oidt`; the schema has NO `octin` property, and GSTN marks the
 * recipient GSTIN non-amendable. CDNRA similarly uses `ctin` plus `ont_num`/`ont_dt`.
 */
import { toPortalDate } from '../dates'
import {
  isB2cLarge,
  isZeroRatedTyp,
  type GstDoc,
  type GstDocRateItem
} from './returns'

// ---------- shared local helpers (mirrors of returns.ts internals, which are not exported) ----------

const toRupees = (paise: number): number => Math.round(paise) / 100

/** Byte-for-byte the itm_det shape returns.ts emits, so an amended row is indistinguishable
 *  from the original row it replaces except for the amendment keys. */
function itmDet(item: GstDocRateItem) {
  return {
    rt: item.rate,
    txval: toRupees(item.taxable),
    ...(item.igst ? { iamt: toRupees(item.igst) } : {}),
    ...(item.cgst ? { camt: toRupees(item.cgst) } : {}),
    ...(item.sgst ? { samt: toRupees(item.sgst) } : {}),
    csamt: toRupees(item.cess)
  }
}

/**
 * The rated (non-zero-rate) item buckets of a document, applying the same rate-0 routing
 * returns.ts's private `normalize` applies: a rt:0 row must never reach b2b/b2cl/cdnr for a
 * DOMESTIC document (the portal rejects it — it belongs in Table 8), while a ZERO-RATED
 * document (export/SEZ) keeps its rate-0 value as a single rt:0 bucket so the invoice is still
 * reported. Duplicated rather than imported because `normalize` is module-private in returns.ts
 * and this module may not modify that file.
 */
function ratedItemsOf(d: GstDoc): GstDocRateItem[] {
  const zeroRated = isZeroRatedTyp(d.invTyp ?? 'R')
  const out: GstDocRateItem[] = []
  let rate0: GstDocRateItem | null = null
  const addRate0 = (taxable: number, cess: number): void => {
    if (!rate0) {
      rate0 = { rate: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
      out.push(rate0)
    }
    rate0.taxable += taxable
    rate0.cess += cess
  }
  if (zeroRated) for (const l of d.nilLines ?? []) addRate0(l.taxable, 0)
  for (const item of d.items) {
    if (item.rate !== 0) out.push(item)
    else if (zeroRated) addRate0(item.taxable, item.cess)
    // domestic rate-0 → Table 8, never an amendment itms row
  }
  return out
}

const isExportDoc = (d: GstDoc): boolean => {
  const t = d.invTyp ?? 'R'
  return t === 'EXPWP' || t === 'EXPWOP'
}

/** Signed tax totals of a document's rated items, paise. Integer arithmetic only. */
function taxTotals(d: GstDoc): {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
} {
  let taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0
  for (const i of ratedItemsOf(d)) {
    taxable += i.taxable; igst += i.igst; cgst += i.cgst; sgst += i.sgst; cess += i.cess
  }
  return { taxable, igst, cgst, sgst, cess }
}

/** Rate-wise fingerprint. Two documents with identical totals but a different rate split ARE a
 *  changed document (the portal files rate-wise), so the diff must see the split, not just the
 *  sum. Sorted so item ORDER alone is never mistaken for a change. */
function rateSignature(d: GstDoc): string {
  return ratedItemsOf(d)
    .map((i) => `${i.rate}:${i.taxable}:${i.igst}:${i.cgst}:${i.sgst}:${i.cess}`)
    .sort()
    .join('|')
}

// ---------- period arithmetic ----------

/** GST return periods are 'MMYYYY' (portal order). Comparing them as strings sorts 012027
 *  before 122026, which is backwards — so compare on a YYYYMM integer instead. */
export function periodOrder(period: string): number {
  const m = /^(\d{2})(\d{4})$/.exec(period)
  if (!m) return NaN
  const month = Number(m[1])
  if (month < 1 || month > 12) return NaN
  return Number(m[2]) * 100 + month
}

// ---------- diff ----------

/** The particulars of a filed document that an amendment can restate. */
export type AmendmentField =
  | 'value'
  | 'tax'
  | 'pos'
  | 'rchrg'
  | 'partyGstin'
  | 'date'
  | 'number'
  | 'invTyp'

export interface AmendmentChange {
  field: AmendmentField
  from: string | number | boolean | null
  to: string | number | boolean | null
}

export interface AmendmentDiff {
  changed: AmendmentField[]
  changes: AmendmentChange[]
  /** False when original and revised are the same document in every reported particular. */
  hasChange: boolean
  /** True when the counterparty went registered → unregistered or the reverse. The row then
   *  moves between amendment tables, which is worth surfacing on its own. */
  registrationChanged: boolean
}

/**
 * Which particulars actually differ between the filed document and the corrected one.
 *
 * Two jobs: it feeds the UI (an amendment row is meaningless to the user without "why is this
 * here?"), and it is the gate for the no-change rule below. `tax` collapses the whole rate-wise
 * tax split into one flag — the row restates every item anyway, so the useful signal is "the
 * tax on this document is not what was filed", not which of five columns moved.
 */
export function diffForAmendment(original: GstDoc, revised: GstDoc): AmendmentDiff {
  const changes: AmendmentChange[] = []
  const push = (
    field: AmendmentField,
    from: string | number | boolean | null,
    to: string | number | boolean | null
  ): void => {
    if (from !== to) changes.push({ field, from, to })
  }

  push('value', original.invoiceValue, revised.invoiceValue)
  push('pos', original.pos, revised.pos)
  push('rchrg', original.rchrg ?? false, revised.rchrg ?? false)
  push('partyGstin', original.partyGstin, revised.partyGstin)
  push('date', original.date, revised.date)
  push('number', original.number, revised.number)
  push('invTyp', original.invTyp ?? 'R', revised.invTyp ?? 'R')

  const ot = taxTotals(original)
  const rt = taxTotals(revised)
  const taxMoved =
    ot.taxable !== rt.taxable ||
    ot.igst !== rt.igst ||
    ot.cgst !== rt.cgst ||
    ot.sgst !== rt.sgst ||
    ot.cess !== rt.cess ||
    rateSignature(original) !== rateSignature(revised)
  if (taxMoved) changes.push({ field: 'tax', from: ot.taxable, to: rt.taxable })

  return {
    changed: changes.map((c) => c.field),
    changes,
    hasChange: changes.length > 0,
    registrationChanged: !!original.partyGstin !== !!revised.partyGstin
  }
}

// ---------- input / output shapes ----------

export interface AmendmentPair {
  /** The document exactly as it was filed. Its GSTIN/number/date are the portal's match key —
   *  never re-derive them from the corrected voucher. */
  original: GstDoc
  /** The corrected document. Its particulars become the new filed truth. */
  revised: GstDoc
  /** Tax period 'MMYYYY' in which `original` was filed. */
  originalPeriod: string
}

export interface AmendmentInput {
  pairs: AmendmentPair[]
  /** Two-digit state code of the company — decides intra vs inter for the B2CL test. */
  companyState: string
  /** Tax period 'MMYYYY' this amendment return is being filed for. */
  period: string
}

export type AmendmentRejectionCode =
  | 'no_change'
  | 'original_period_not_earlier'
  | 'invalid_period'
  | 'duplicate_amendment'
  | 'recipient_gstin_not_amendable'
  | 'b2cs_no_amendment_table'
  | 'no_rated_items'

export interface AmendmentRejection {
  code: AmendmentRejectionCode
  /** Human-readable, shown verbatim in the amendments panel. */
  message: string
  /** Vouchers to drill into — original first, then revised (mirrors GstIssue.voucherIds). */
  voucherIds: number[]
  /** The portal match key this row would have used, for the message and for support. */
  key: { ctin: string | null; oinum: string; oidt: string }
  diff?: AmendmentDiff
}

export interface AmendmentTables {
  /** Table 9A — amendments to B2B invoices, grouped by the non-amendable counterparty GSTIN. */
  b2ba: unknown[]
  /** Table 9A — amendments to B2C (large) invoices, grouped by the REVISED place of supply. */
  b2cla: unknown[]
  /** Table 9C — registered credit/debit-note amendments, grouped by the non-amendable GSTIN. */
  cdnra: unknown[]
  /** Table 9C — amendments to credit/debit notes issued to unregistered persons. */
  cdnura: unknown[]
  /** Pairs that are NOT amendable, each with the rule that refused them. Never silently
   *  dropped: a correction the user believes they filed is worse than one they can see failed. */
  rejected: AmendmentRejection[]
}

const EMPTY_KEY = (d: GstDoc): { ctin: string | null; oinum: string; oidt: string } => ({
  ctin: d.partyGstin,
  oinum: d.number,
  oidt: d.date
})

/**
 * Identity of the document being amended. The portal matches on counterparty GSTIN + document
 * number + document date, so that triple — from the ORIGINAL, never the revised — is also the
 * right key for "has this already been amended into this period?".
 */
const amendmentKey = (o: GstDoc): string => `${o.partyGstin ?? ''}|${o.number}|${o.date}`

// ---------- builder ----------

/**
 * Shape a set of {original, revised} pairs into the four GSTR-1 amendment tables.
 *
 * Every rule below refuses a row rather than emitting one the portal would bounce; the refusals
 * come back in `rejected` so the screen can explain them.
 */
export function buildAmendmentTables(input: AmendmentInput): AmendmentTables {
  const rejected: AmendmentRejection[] = []
  const filingOrder = periodOrder(input.period)

  interface Row {
    pair: AmendmentPair
    rated: GstDocRateItem[]
  }
  const b2baRows: Row[] = []
  const b2claRows: Row[] = []
  const cdnraRows: Row[] = []
  const cdnuraRows: Row[] = []

  const seen = new Set<string>()

  for (const pair of input.pairs) {
    const { original, revised } = pair
    const voucherIds = [original.voucherId, revised.voucherId]
    const key = EMPTY_KEY(original)
    const reject = (code: AmendmentRejectionCode, message: string, diff?: AmendmentDiff): void => {
      rejected.push({ code, message, voucherIds, key, ...(diff ? { diff } : {}) })
    }

    // RULE — the periods must be real 'MMYYYY' values.
    // WHY: everything downstream (ordering, the portal's own period match) is meaningless on a
    // malformed period, and a NaN comparison silently answers "false" to every question.
    const origOrder = periodOrder(pair.originalPeriod)
    if (Number.isNaN(origOrder) || Number.isNaN(filingOrder)) {
      reject(
        'invalid_period',
        `Tax period must be MMYYYY — got original "${pair.originalPeriod}", filing "${input.period}".`
      )
      continue
    }

    // RULE — the original's tax period must be strictly EARLIER than the amending period.
    // WHY: an amendment corrects something already filed. If the original belongs to this period
    // or a later one it has not been filed yet, so the correction is just an edit to the voucher
    // and belongs in the ordinary b2b/b2cl/cdnr tables. Filing it as an amendment asks the portal
    // to match a document it has never seen, and the row is rejected.
    if (origOrder >= filingOrder) {
      reject(
        'original_period_not_earlier',
        `${original.number} was filed in ${pair.originalPeriod}, which is not earlier than the amending period ${input.period} — amend it in a later return, or correct the voucher itself.`
      )
      continue
    }

    // RULE — an amendment row must differ from the original in at least one particular.
    // WHY: a row that restates the filed document exactly changes nothing on the portal but does
    // reopen the document for the recipient — their GSTR-2B moves, their reconciliation breaks,
    // and nobody can say what the amendment was for. If nothing changed, there is nothing to file.
    const diff = diffForAmendment(original, revised)
    if (!diff.hasChange) {
      reject(
        'no_change',
        `${original.number} is identical to the filed document — an amendment with no changed particular has nothing to amend.`,
        diff
      )
      continue
    }

    // GSTN's current offline-tool manual explicitly marks the B2BA recipient GSTIN/UIN as
    // non-amendable, and the v5.0 JSON contract contains only one group-level `ctin` — there is
    // no original/revised pair with which to express a change. The same structural fact applies
    // to CDNRA. Never guess at a nil-and-rebook workflow: surface the correction for deliberate
    // portal/professional handling instead of emitting a row that cannot represent it.
    if (original.partyGstin !== revised.partyGstin) {
      reject(
        'recipient_gstin_not_amendable',
        `${original.number} changes the recipient GSTIN from ${original.partyGstin ?? 'unregistered'} to ${revised.partyGstin ?? 'unregistered'}, but GSTN marks the B2BA recipient GSTIN/UIN non-amendable. Correct the recipient through the portal-prescribed reversal/new-document workflow; this app will not invent that filing.`,
        diff
      )
      continue
    }

    // RULE — a document cannot be amended twice into the same period.
    // WHY: the portal keys amendment rows on (original GSTIN, number, date). Two rows with the
    // same key in one return are a duplicate: the portal takes one and the other is rejected, and
    // which one it took is not knowable from here. Consolidate the corrections into one row.
    const k = amendmentKey(original)
    if (seen.has(k)) {
      reject(
        'duplicate_amendment',
        `${original.number} dated ${original.date} is already being amended in ${input.period} — a document can only be amended once per period; combine the corrections into a single row.`,
        diff
      )
      continue
    }

    const rated = ratedItemsOf(revised)
    // A purely nil-rated revision has no rated items — mirrors returns.ts, which refuses to emit
    // an invoice table row with an empty itms[] because the portal rejects it.
    if (!rated.length) {
      reject(
        'no_rated_items',
        `${revised.number} has no rated lines after nil-rated routing — nil-rated value is reported in Table 8, which has no invoice-level amendment table.`,
        diff
      )
      continue
    }

    const row: Row = { pair, rated }
    const isNote = revised.kind === 'credit_note' || revised.kind === 'debit_note'
    // Only a pair that actually becomes an amendment row claims the key — a pair refused for
    // having no amendment table has not been "amended into" this period at all.
    const place = (into: Row[]): void => { into.push(row); seen.add(k) }

    if (!isNote) {
      if (revised.partyGstin) {
        place(b2baRows)
      } else if (
        isExportDoc(revised) ||
        isB2cLarge({
          partyGstin: revised.partyGstin,
          pos: revised.pos,
          companyStateCode: input.companyState,
          invoiceValue: revised.invoiceValue
        })
      ) {
        place(b2claRows)
      } else {
        // RULE — a B2C invoice below the B2CL threshold has no amendment table of its own.
        // WHY: it was never filed as a document. It was filed inside the B2CS rate-wise totals
        // for its POS, so its correction is a movement in those totals (Table 10, b2csa) and not
        // a row keyed on an invoice number. Reported, not dropped: the user asked for a
        // correction and is entitled to know where it went.
        reject(
          'b2cs_no_amendment_table',
          `${revised.number} is a B2C supply below the B2CL threshold — it was filed inside the B2CS totals for POS ${revised.pos}, so the correction flows through those totals (Table 10), not an invoice-level amendment.`,
          diff
        )
      }
      continue
    }

    if (revised.partyGstin) {
      place(cdnraRows)
    } else if (
      isExportDoc(revised) ||
      (revised.pos !== input.companyState && isB2cLarge({
        partyGstin: revised.partyGstin,
        pos: revised.pos,
        companyStateCode: input.companyState,
        invoiceValue: revised.invoiceValue
      }))
    ) {
      // CDNURA carries only the notes CDNUR carries: B2CL-type (inter-state, above the
      // threshold) and export notes — the same test returns.ts applies when building cdnur.
      place(cdnuraRows)
    } else {
      reject(
        'b2cs_no_amendment_table',
        `${revised.number} is a note to an unregistered person below the B2CL threshold — it was netted into the B2CS totals for POS ${revised.pos}, so the correction flows through those totals, not an invoice-level amendment.`,
        diff
      )
    }
  }

  // ---- 9A — b2ba, grouped by the non-amendable recipient GSTIN ----
  const b2ba = groupBy(b2baRows, (r) => r.pair.original.partyGstin!).map(([ctin, list]) => ({
    ctin,
    inv: list.map((r) => ({
      // GSTN v5.0: original number/date live on the invoice; recipient GSTIN is the group `ctin`.
      oinum: r.pair.original.number,
      oidt: toPortalDate(r.pair.original.date),
      inum: r.pair.revised.number,
      idt: toPortalDate(r.pair.revised.date),
      val: toRupees(r.pair.revised.invoiceValue),
      pos: r.pair.revised.pos,
      rchrg: r.pair.revised.rchrg ? 'Y' : 'N',
      inv_typ: r.pair.revised.invTyp ?? 'R',
      itms: r.rated.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
    }))
  }))

  // ---- 9A — b2cla, grouped by the REVISED place of supply ----
  const b2cla = groupBy(b2claRows, (r) => r.pair.revised.pos).map(([pos, list]) => ({
    pos,
    inv: list.map((r) => ({
      oinum: r.pair.original.number,
      oidt: toPortalDate(r.pair.original.date),
      inum: r.pair.revised.number,
      idt: toPortalDate(r.pair.revised.date),
      val: toRupees(r.pair.revised.invoiceValue),
      itms: r.rated.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
    }))
  }))

  // ---- 9C — cdnra, grouped by the non-amendable recipient GSTIN ----
  const cdnra = groupBy(cdnraRows, (r) => r.pair.original.partyGstin!).map(([ctin, list]) => ({
    ctin,
    nt: list.map((r) => ({
      // GSTN v5.0 calls these original-note keys `ont_num` / `ont_dt`.
      ont_num: r.pair.original.number,
      ont_dt: toPortalDate(r.pair.original.date),
      ntty: r.pair.revised.kind === 'credit_note' ? 'C' : 'D',
      nt_num: r.pair.revised.number,
      nt_dt: toPortalDate(r.pair.revised.date),
      pos: r.pair.revised.pos,
      rchrg: r.pair.revised.rchrg ? 'Y' : 'N',
      inv_typ: r.pair.revised.invTyp ?? 'R',
      val: toRupees(r.pair.revised.invoiceValue),
      itms: r.rated.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
    }))
  }))

  // ---- 9C — cdnura, a flat list (mirrors cdnur in returns.ts, which is not grouped) ----
  const cdnura = cdnuraRows.map((r) => ({
    ont_num: r.pair.original.number,
    ont_dt: toPortalDate(r.pair.original.date),
    ntty: r.pair.revised.kind === 'credit_note' ? 'C' : 'D',
    nt_num: r.pair.revised.number,
    nt_dt: toPortalDate(r.pair.revised.date),
    typ: isExportDoc(r.pair.revised) ? (r.pair.revised.invTyp ?? 'R') : 'B2CL',
    pos: r.pair.revised.pos,
    val: toRupees(r.pair.revised.invoiceValue),
    itms: r.rated.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
  }))

  return { b2ba, b2cla, cdnra, cdnura, rejected }
}

/** Stable insertion-ordered grouping (Map preserves first-seen key order). */
function groupBy<T>(rows: T[], keyOf: (row: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = keyOf(r)
    const list = m.get(k) ?? []
    list.push(r)
    m.set(k, list)
  }
  return [...m.entries()]
}
