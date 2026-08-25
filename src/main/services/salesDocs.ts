/**
 * Quotation → order → challan → invoice, and the same chain pointing inward (#378, #188, #189).
 *
 * The sale does not start at the invoice. It starts at a quotation — which is where the app was
 * silent — becomes an order when the customer says yes, is delivered on a challan, and is only
 * then invoiced. None of the first three moves money or creates a liability, so none of them is
 * an accounting entry; they are documents that carry quantities and prices forward, and only the
 * last stage posts.
 *
 * The property that matters is that each document converts ONCE. Quoting once and invoicing twice
 * is the failure this chain exists to prevent, and it is a failure nobody notices for a month.
 * A partly-delivered order is a separate idea from a converted one: quantities are tracked per
 * line, so an order can go out on two challans without either of them closing it.
 */
import type { DB } from '../db/connection'
import { todayISO } from '@shared/dates'
import { roundPaise } from '@shared/money'
import { computeGst, supplyTypeFor, type GstBreakup } from '@shared/gst/calc'
import type { CompanyInfo } from '@shared/domain'
import { effectiveItemTax, getLedger } from './masters'
import { writeAudit } from './audit'
import {
  documentFulfilment,
  lineFulfilment,
  threeWayMatch,
  type Fulfilment,
  type MatchLine,
  type MatchResult
} from '@shared/fulfilment'
import { NOT_DELETED } from './vouchers'

export type Stage = 'quotation' | 'order' | 'challan'
/**
 * Which way the document faces.
 *
 * Outward is the sale: quotation → sales order → delivery challan → tax invoice. Inward is the
 * purchase, and it is the SAME three stages read the other way: an 'order' on the purchase side
 * is the purchase order, a 'challan' on the purchase side is the goods receipt note. One
 * implementation, because the conversion arithmetic — what is still owed — must have one answer.
 */
export type Side = 'sales' | 'purchase'
export type DocStatus = 'open' | 'converted' | 'closed' | 'lost'

/** What each stage becomes. The invoice is a voucher, so the chain ends outside this table. */
export const NEXT_STAGE: Record<Stage, Stage | 'invoice'> = {
  quotation: 'order',
  order: 'challan',
  challan: 'invoice'
}

const PREFIX: Record<Side, Record<Stage, string>> = {
  sales: { quotation: 'QT', order: 'SO', challan: 'DC' },
  // No RFQ stage: a purchase quotation is a document the SUPPLIER issues, and typing the
  // supplier's own quotation into our books as ours would misattribute it.
  purchase: { quotation: 'RFQ', order: 'PO', challan: 'GRN' }
}

const LABELS: Record<Side, Record<Stage, string>> = {
  sales: { quotation: 'Quotation', order: 'Sales order', challan: 'Delivery challan' },
  purchase: { quotation: 'Request for quotation', order: 'Purchase order', challan: 'Receipt note' }
}

export const STAGE_LABEL: Record<Stage, string> = LABELS.sales

export const stageLabel = (stage: Stage, side: Side = 'sales'): string => LABELS[side][stage]

/** The stages each side actually uses. */
export const STAGES_FOR: Record<Side, Stage[]> = {
  sales: ['quotation', 'order', 'challan'],
  purchase: ['order', 'challan']
}

export interface SalesDocLine {
  id: number
  stockItemId: number | null
  description: string
  qtyMilli: number
  ratePaise: number
  discountPaise: number
  gstRate: number | null
  hsn: string | null
  /** Quantity already carried downstream. */
  fulfilledMilli: number
  /** qty − fulfilled: what a conversion would still take. */
  pendingMilli: number
  /** fulfilled − qty: what arrived that nobody ordered. Only ever non-zero inward. */
  overMilli: number
  /** Post-discount value, exclusive of tax. */
  amountPaise: number
}

export interface SalesDoc {
  id: number
  stage: Stage
  side: Side
  /** "Purchase order", "Receipt note", "Quotation" — the word this document is called by. */
  stageLabel: string
  number: string
  date: string
  partyLedgerId: number | null
  partyName: string | null
  validUntil: string | null
  reference: string | null
  narration: string | null
  terms: string | null
  fromDocumentId: number | null
  convertedToId: number | null
  invoiceVoucherId: number | null
  convertedOn: string | null
  status: DocStatus
  closedReason: string | null
  createdAt: string
  lines: SalesDocLine[]
  taxablePaise: number
  gst: GstBreakup
  totalPaise: number
  /** A quotation past its validity is not a live price. */
  expired: boolean
  /**
   * The balance, which is the whole point of an order (#188).
   *
   * An order is not a document, it is what is still owed. `status` says whether anybody has
   * closed it; this says what is actually outstanding, and the two are different for every
   * part-delivered order in the book.
   */
  fulfilment: Fulfilment
  /**
   * Goods that arrived against no order at all (#189).
   *
   * It happens — a supplier ships a replacement, a sample turns up, somebody ordered by phone.
   * The receipt note still has to exist, because the goods are physically in the godown; what it
   * cannot do is pretend an order authorised them.
   */
  unordered: boolean
}

interface DocRow {
  id: number; stage: Stage; side: Side; number: string; date: string; party_ledger_id: number | null
  party_name: string | null; valid_until: string | null; reference: string | null; narration: string | null
  terms: string | null; from_document_id: number | null; converted_to_id: number | null
  invoice_voucher_id: number | null; converted_on: string | null; status: DocStatus
  closed_reason: string | null; created_at: string
}

interface LineRow {
  id: number; stock_item_id: number | null; description: string; qty_milli: number
  rate_paise: number; discount_paise: number; gst_rate: number | null; hsn: string | null
  fulfilled_milli: number
}

const lineAmount = (r: { qty_milli: number; rate_paise: number; discount_paise: number }): number =>
  Math.max(0, roundPaise((r.qty_milli * r.rate_paise) / 1000) - r.discount_paise)

function hydrate(db: DB, row: DocRow, info: CompanyInfo, asOn: string): SalesDoc {
  const lineRows = db
    .prepare('SELECT * FROM sales_document_lines WHERE document_id = ? ORDER BY sort_order, id')
    .all(row.id) as LineRow[]

  const party = row.party_ledger_id ? getLedger(db, row.party_ledger_id) : null
  const supply = supplyTypeFor(info.stateCode, party?.stateCode ?? info.stateCode)

  const lines: SalesDocLine[] = lineRows.map((r) => ({
    id: r.id,
    stockItemId: r.stock_item_id,
    description: r.description,
    qtyMilli: r.qty_milli,
    ratePaise: r.rate_paise,
    discountPaise: r.discount_paise,
    gstRate: r.gst_rate,
    hsn: r.hsn,
    fulfilledMilli: r.fulfilled_milli,
    pendingMilli: lineFulfilment(r.qty_milli, r.fulfilled_milli).pendingMilli,
    overMilli: lineFulfilment(r.qty_milli, r.fulfilled_milli).overMilli,
    amountPaise: lineAmount(r)
  }))

  const gst = lines.reduce<GstBreakup>(
    (acc, l) => {
      const b = computeGst(l.amountPaise, l.gstRate ?? 0, supply)
      return {
        taxable: acc.taxable + b.taxable,
        cgst: acc.cgst + b.cgst,
        sgst: acc.sgst + b.sgst,
        igst: acc.igst + b.igst,
        cess: acc.cess + b.cess,
        total: acc.total + b.total
      }
    },
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 }
  )

  const side: Side = row.side ?? 'sales'
  return {
    id: row.id,
    stage: row.stage,
    side,
    stageLabel: stageLabel(row.stage, side),
    number: row.number,
    date: row.date,
    partyLedgerId: row.party_ledger_id,
    partyName: row.party_name ?? party?.name ?? null,
    validUntil: row.valid_until,
    reference: row.reference,
    narration: row.narration,
    terms: row.terms,
    fromDocumentId: row.from_document_id,
    convertedToId: row.converted_to_id,
    invoiceVoucherId: row.invoice_voucher_id,
    convertedOn: row.converted_on,
    status: row.status,
    closedReason: row.closed_reason,
    createdAt: row.created_at,
    lines,
    taxablePaise: gst.taxable,
    gst,
    totalPaise: gst.total,
    expired: row.stage === 'quotation' && row.status === 'open' && row.valid_until !== null && row.valid_until < asOn,
    fulfilment: documentFulfilment(lines.map((l) => ({ orderedMilli: l.qtyMilli, fulfilledMilli: l.fulfilledMilli }))),
    unordered: side === 'purchase' && row.stage === 'challan' && row.from_document_id === null
  }
}

export function getDocument(db: DB, id: number, info: CompanyInfo, asOn = todayISO()): SalesDoc | null {
  const row = db.prepare('SELECT * FROM sales_documents WHERE id = ?').get(id) as DocRow | undefined
  return row ? hydrate(db, row, info, asOn) : null
}

export function listDocuments(
  db: DB,
  info: CompanyInfo,
  opts: { stage?: Stage; status?: DocStatus; asOn?: string; side?: Side } = {}
): SalesDoc[] {
  const clauses: string[] = []
  const args: unknown[] = []
  // Defaulted rather than optional: a caller that forgets the side would get the sales chain and
  // the purchase chain in one list, which reads as a duplicate-numbering bug.
  clauses.push('side = ?')
  args.push(opts.side ?? 'sales')
  if (opts.stage) {
    clauses.push('stage = ?')
    args.push(opts.stage)
  }
  if (opts.status) {
    clauses.push('status = ?')
    args.push(opts.status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM sales_documents ${where} ORDER BY date DESC, id DESC`).all(...args) as DocRow[]
  const asOn = opts.asOn ?? todayISO()
  return rows.map((r) => hydrate(db, r, info, asOn))
}

/** The next free number for a stage. Sequential per stage, never shared with the voucher series. */
export function nextNumber(db: DB, stage: Stage, side: Side = 'sales'): string {
  const prefix = PREFIX[side][stage]
  const row = db
    .prepare("SELECT number FROM sales_documents WHERE stage = ? AND number LIKE ? ORDER BY id DESC LIMIT 1")
    .get(stage, `${prefix}-%`) as { number: string } | undefined
  const last = row ? Number(row.number.split('-').pop()) : 0
  return `${prefix}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`
}

export interface SalesDocLineInput {
  stockItemId?: number | null
  description: string
  qtyMilli: number
  ratePaise: number
  discountPaise?: number
  gstRate?: number | null
  hsn?: string | null
}

export interface SalesDocInput {
  stage: Stage
  side?: Side
  number?: string
  date: string
  partyLedgerId?: number | null
  partyName?: string | null
  validUntil?: string | null
  reference?: string | null
  narration?: string | null
  terms?: string | null
  lines: SalesDocLineInput[]
}

export function saveDocument(db: DB, info: CompanyInfo, input: SalesDocInput, id?: number): SalesDoc {
  const side: Side = input.side ?? 'sales'
  if (input.lines.length === 0) throw new Error('A document needs at least one line')
  if (!STAGES_FOR[side].includes(input.stage)) {
    throw new Error(`A ${side} chain has no ${stageLabel(input.stage, side).toLowerCase()} stage`)
  }
  if (side === 'purchase' && !input.partyLedgerId) {
    // A purchase order commits the business to pay somebody. "Somebody" has to be a ledger: the
    // bill that follows lands in it, and a payable addressed to a name is not a payable.
    throw new Error('A purchase document needs a supplier ledger')
  }
  if (!input.partyLedgerId && !input.partyName?.trim()) {
    // A quotation may go to somebody who is not a customer yet, but it still has to go to
    // somebody: a quotation addressed to nobody cannot be sent or followed up.
    throw new Error('Who is this for?')
  }
  const before = id ? getDocument(db, id, info) : null
  if (before && before.status === 'converted') {
    throw new Error(`${before.number} has already become ${before.convertedToId ? 'the next document' : 'an invoice'} — edit that instead`)
  }

  const run = db.transaction((): number => {
    let docId = id
    if (docId) {
      db.prepare(
        `UPDATE sales_documents SET date = ?, party_ledger_id = ?, party_name = ?, valid_until = ?,
         reference = ?, narration = ?, terms = ? WHERE id = ?`
      ).run(
        input.date, input.partyLedgerId ?? null, input.partyName ?? null, input.validUntil ?? null,
        input.reference ?? null, input.narration ?? null, input.terms ?? null, docId
      )
      db.prepare('DELETE FROM sales_document_lines WHERE document_id = ?').run(docId)
    } else {
      docId = Number(
        db
          .prepare(
            `INSERT INTO sales_documents (stage, side, number, date, party_ledger_id, party_name, valid_until,
              reference, narration, terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.stage, side, input.number?.trim() || nextNumber(db, input.stage, side), input.date,
            input.partyLedgerId ?? null, input.partyName ?? null, input.validUntil ?? null,
            input.reference ?? null, input.narration ?? null, input.terms ?? null
          ).lastInsertRowid
      )
    }
    insertLines(db, docId, input.lines, input.date)
    return docId
  })()

  const saved = getDocument(db, run, info)!
  writeAudit(db, 'sales_document', run, before ? 'update' : 'create', before, saved)
  return saved
}

function insertLines(
  db: DB,
  docId: number,
  lines: SalesDocLineInput[],
  docDate: string,
  fulfilled: number[] = []
): void {
  const insert = db.prepare(
    `INSERT INTO sales_document_lines (document_id, stock_item_id, description, qty_milli, rate_paise,
      discount_paise, gst_rate, hsn, fulfilled_milli, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  lines.forEach((l, i) => {
    if (l.qtyMilli <= 0) throw new Error(`"${l.description}" has no quantity`)
    // The tax band comes from the item unless the caller states one — a quotation typed against
    // a real item should not have to restate a rate the master already knows.
    let gstRate = l.gstRate ?? null
    let hsn = l.hsn ?? null
    if (l.stockItemId && (gstRate === null || hsn === null)) {
      // The document's own date, never today: a quotation raised before a rate change quotes the
      // rate it was raised under, and converting it later must not silently reprice it (D-92).
      const tax = effectiveItemTax(db, l.stockItemId, docDate)
      gstRate ??= tax.gstRate
      hsn ??= tax.hsn
    }
    insert.run(
      docId, l.stockItemId ?? null, l.description, l.qtyMilli, l.ratePaise, l.discountPaise ?? 0,
      gstRate, hsn, fulfilled[i] ?? 0, i
    )
  })
}

export function deleteDocument(db: DB, id: number, info: CompanyInfo): void {
  const before = getDocument(db, id, info)
  if (!before) throw new Error('No such document')
  if (before.status === 'converted') throw new Error(`${before.number} has already been converted — it cannot be deleted`)
  db.prepare('DELETE FROM sales_documents WHERE id = ?').run(id)
  writeAudit(db, 'sales_document', id, 'delete', before, null)
}

/** Mark a quotation lost, or an order closed short. The reason is the point of the record. */
export function closeDocument(db: DB, id: number, info: CompanyInfo, status: 'closed' | 'lost', reason: string | null): SalesDoc {
  const before = getDocument(db, id, info)
  if (!before) throw new Error('No such document')
  if (before.status === 'converted') throw new Error(`${before.number} has already been converted`)
  db.prepare('UPDATE sales_documents SET status = ?, closed_reason = ? WHERE id = ?').run(status, reason, id)
  const after = getDocument(db, id, info)!
  writeAudit(db, 'sales_document', id, 'update', before, after)
  return after
}

// ---------- conversion ----------

export interface ConvertInput {
  /** Per source line, how much to carry forward. Omitted = everything still pending. */
  quantities?: { lineId: number; qtyMilli: number }[]
  date?: string
  number?: string
  /**
   * Accept more than was ordered (inward only).
   *
   * Outward this stays false: delivering more than the customer ordered on the strength of a
   * typo is a loss, and the challan is ours to control. Inward it is the supplier's lorry that
   * decides, and the goods are in the godown whether or not we authorised them — refusing to
   * record them would leave the stock ledger short. The excess is carried and reported as an
   * over-receipt rather than silently clipped.
   */
  allowOver?: boolean
}

/**
 * Turn a document into the next stage.
 *
 * A conversion that takes everything closes the source; one that takes part of it leaves it open
 * with the quantities marked fulfilled, so the rest can go out later. That distinction is the
 * whole of "fulfilment tracking" — an order is not finished because something was delivered
 * against it.
 */
export function convert(db: DB, id: number, info: CompanyInfo, input: ConvertInput = {}): SalesDoc {
  const source = getDocument(db, id, info)
  if (!source) throw new Error('No such document')
  if (source.status === 'converted') {
    throw new Error(`${source.number} has already been converted — converting it again would bill the customer twice`)
  }
  if (source.status === 'lost' || source.status === 'closed') {
    throw new Error(`${source.number} was ${source.status} — reopen it before converting it`)
  }
  const next = NEXT_STAGE[source.stage]
  if (next === 'invoice') {
    throw new Error(
      source.side === 'purchase'
        ? 'A receipt note becomes the supplier’s bill, which is a voucher — use the bill draft'
        : 'A challan becomes an invoice, which is a voucher — use the invoice draft'
    )
  }
  if (!source.partyLedgerId) {
    // A quotation may name a stranger; an order is a commitment, and a commitment needs a ledger
    // to carry the receivable when it is eventually invoiced.
    throw new Error(`${stageLabel(next, source.side)} needs a party ledger, not just a name`)
  }

  const over = input.allowOver === true
  if (over && source.side !== 'purchase') {
    throw new Error('Only an inward receipt may take more than was ordered')
  }
  const wanted = new Map((input.quantities ?? []).map((q) => [q.lineId, q.qtyMilli]))
  const cap = (l: SalesDocLine): number => {
    const asked = input.quantities ? (wanted.get(l.id) ?? 0) : l.pendingMilli
    return over ? asked : Math.min(asked, l.pendingMilli)
  }
  const carried = source.lines.map((l) => ({ line: l, qty: cap(l) })).filter((x) => x.qty > 0)
  if (carried.length === 0) throw new Error(`Nothing is left on ${source.number} to carry forward`)

  const date = input.date ?? todayISO()
  const newId = db.transaction((): number => {
    const docId = Number(
      db
        .prepare(
          `INSERT INTO sales_documents (stage, side, number, date, party_ledger_id, party_name, reference,
            narration, terms, from_document_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          next, source.side, input.number?.trim() || nextNumber(db, next, source.side), date, source.partyLedgerId, source.partyName,
          source.number, source.narration, source.terms, source.id
        ).lastInsertRowid
    )
    insertLines(
      db,
      docId,
      carried.map((x) => ({
        stockItemId: x.line.stockItemId,
        description: x.line.description,
        qtyMilli: x.qty,
        // The discount travels pro-rata with the quantity, so a half delivery carries half of it.
        ratePaise: x.line.ratePaise,
        discountPaise: Math.round((x.line.discountPaise * x.qty) / x.line.qtyMilli),
        gstRate: x.line.gstRate,
        hsn: x.line.hsn
      })),
      date
    )

    const bump = db.prepare('UPDATE sales_document_lines SET fulfilled_milli = fulfilled_milli + ? WHERE id = ?')
    for (const x of carried) bump.run(x.qty, x.line.id)

    // Per line, and MAX(0, …) per line rather than over the sum: an excess on one line must not
    // cancel a shortfall on another, or an order half of which never arrived would close itself
    // because the other half was over-delivered (see documentFulfilment).
    const after = db
      .prepare('SELECT qty_milli AS q, fulfilled_milli AS f FROM sales_document_lines WHERE document_id = ?')
      .all(source.id) as { q: number; f: number }[]
    const stillPending = documentFulfilment(after.map((r) => ({ orderedMilli: r.q, fulfilledMilli: r.f }))).pendingMilli
    db.prepare('UPDATE sales_documents SET converted_to_id = ?, converted_on = ?, status = ? WHERE id = ?')
      .run(docId, date, stillPending > 0 ? 'open' : 'converted', source.id)
    return docId
  })()

  const created = getDocument(db, newId, info)!
  writeAudit(db, 'sales_document', newId, 'create', null, { from: source.number, stage: next, number: created.number })
  return created
}

// ---------- the invoice, as a draft the human saves ----------

export interface InvoiceDraft {
  documentId: number
  documentNumber: string
  date: string
  partyLedgerId: number
  narration: string
  lines: { ledgerName: string; group: string; drCr: 'dr' | 'cr'; amount: number }[]
  inventory: { stockItemId: number; description: string; qtyMilli: number; ratePaise: number; discountPaise: number; amount: number }[]
  gst: GstBreakup
  totalPaise: number
}

/**
 * What invoicing a challan would look like.
 *
 * A draft, not a posting — every other document in this chain is memorandum, and the one that
 * finally hits the books is the one a person should look at first. `markInvoiced` records the
 * voucher afterwards, so the chain knows the sale is finished.
 */
export function invoiceDraft(db: DB, id: number, info: CompanyInfo): InvoiceDraft {
  const doc = getDocument(db, id, info)
  if (!doc) throw new Error('No such document')
  if (doc.invoiceVoucherId) throw new Error(`${doc.number} has already been invoiced`)
  if (!doc.partyLedgerId) throw new Error('An invoice needs a party ledger')

  /**
   * Inward, every debit and credit turns over.
   *
   * A sale debits the customer and credits sales; a purchase debits purchases and credits the
   * supplier. The tax follows: output tax is a credit, input tax is a debit — and input tax is
   * credit the business can claim, which is exactly why it must not be lumped into the purchase
   * value. Same document, mirrored posting, one place that decides which way it goes.
   */
  const inward = doc.side === 'purchase'
  const lines: InvoiceDraft['lines'] = inward
    ? [
        { ledgerName: 'Purchase Account', group: 'Purchase Accounts', drCr: 'dr', amount: doc.gst.taxable },
        { ledgerName: doc.partyName ?? 'Sundry Creditors', group: 'Sundry Creditors', drCr: 'cr', amount: doc.totalPaise }
      ]
    : [
        { ledgerName: doc.partyName ?? 'Sundry Debtors', group: 'Sundry Debtors', drCr: 'dr', amount: doc.totalPaise },
        { ledgerName: 'Sales Account', group: 'Sales Accounts', drCr: 'cr', amount: doc.gst.taxable }
      ]
  const tax = (name: string, amount: number): void => {
    if (amount > 0) lines.push({ ledgerName: name, group: 'Duties & Taxes', drCr: inward ? 'dr' : 'cr', amount })
  }
  tax('CGST', doc.gst.cgst)
  tax('SGST', doc.gst.sgst)
  tax('IGST', doc.gst.igst)
  tax('CESS', doc.gst.cess)

  return {
    documentId: doc.id,
    documentNumber: doc.number,
    date: todayISO(),
    partyLedgerId: doc.partyLedgerId,
    narration: `Against ${stageLabel(doc.stage, doc.side).toLowerCase()} ${doc.number}`,
    lines,
    inventory: doc.lines
      .filter((l) => l.stockItemId !== null)
      .map((l) => ({
        stockItemId: l.stockItemId!,
        description: l.description,
        qtyMilli: l.qtyMilli,
        ratePaise: l.ratePaise,
        discountPaise: l.discountPaise,
        amount: l.amountPaise
      })),
    gst: doc.gst,
    totalPaise: doc.totalPaise
  }
}

/** Record which voucher finally billed this document. */
export function markInvoiced(db: DB, id: number, voucherId: number, info: CompanyInfo): SalesDoc {
  const before = getDocument(db, id, info)
  if (!before) throw new Error('No such document')
  if (before.invoiceVoucherId) throw new Error(`${before.number} has already been invoiced`)
  db.prepare("UPDATE sales_documents SET invoice_voucher_id = ?, status = 'converted', converted_on = ? WHERE id = ?")
    .run(voucherId, todayISO(), id)
  const after = getDocument(db, id, info)!
  writeAudit(db, 'sales_document', id, 'update', before, after)
  return after
}

// ---------- the pipeline, which is the report a desk actually wants ----------

export interface PipelineStage {
  stage: Stage
  label: string
  open: number
  openValuePaise: number
  converted: number
  lost: number
  /** Documents with something still owed on them — which is not the same as `open`. */
  partlyFulfilled: number
  pendingMilli: number
  overMilli: number
}

export interface Pipeline {
  side: Side
  stages: PipelineStage[]
  expiringSoon: SalesDoc[]
  /** Inward only: goods that arrived with no order behind them. */
  unordered: SalesDoc[]
}

export function pipeline(db: DB, info: CompanyInfo, asOn = todayISO(), side: Side = 'sales'): Pipeline {
  const docs = listDocuments(db, info, { asOn, side })
  const stages: PipelineStage[] = STAGES_FOR[side].map((stage) => {
    const mine = docs.filter((d) => d.stage === stage)
    const open = mine.filter((d) => d.status === 'open')
    return {
      stage,
      label: stageLabel(stage, side),
      open: open.length,
      openValuePaise: open.reduce((s, d) => s + d.totalPaise, 0),
      converted: mine.filter((d) => d.status === 'converted').length,
      lost: mine.filter((d) => d.status === 'lost').length,
      // Not the same count as `open`: a document can be open because nobody has touched it and
      // open because half of it arrived last Tuesday, and only one of those needs chasing.
      partlyFulfilled: mine.filter((d) => d.fulfilment.state === 'partial').length,
      pendingMilli: open.reduce((s, d) => s + d.fulfilment.pendingMilli, 0),
      overMilli: mine.reduce((s, d) => s + d.fulfilment.overMilli, 0)
    }
  })
  return {
    side,
    stages,
    // A quotation about to expire is the only thing on this screen with a deadline.
    expiringSoon: docs.filter((d) => d.stage === 'quotation' && d.status === 'open' && d.validUntil !== null && d.validUntil >= asOn).slice(0, 10),
    unordered: docs.filter((d) => d.unordered).slice(0, 10)
  }
}

// ---------- the three-way match (roadmap #189) ----------

/**
 * Order, receipt, invoice — and whether the three agree.
 *
 * This is the entire reason a receipt note is a document rather than a note in the margin. The
 * order says what was asked for, the receipt says what the lorry actually brought, the bill says
 * what the supplier wants paying for, and the three disagree far more often than anybody expects.
 * A bill for more than arrived is money leaving the business for nothing, and it is invisible
 * unless something holds all three quantities side by side.
 *
 * Quantities only. What a variance is WORTH is the invoice's arithmetic, and computing it a
 * second time here would produce a second answer to the same question.
 */
export interface ThreeWayMatch extends MatchResult {
  orderId: number | null
  orderNumber: string | null
  partyName: string | null
  receiptNumbers: string[]
  invoiceNumbers: string[]
}

interface InvoicedRow { stock_item_id: number | null; qty_milli: number; number: string }

/** Quantities the linked supplier bills actually charged for, by item. */
function invoicedQuantities(db: DB, voucherIds: number[]): InvoicedRow[] {
  if (voucherIds.length === 0) return []
  const placeholders = voucherIds.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT il.stock_item_id AS stock_item_id, il.qty_milli AS qty_milli, v.number AS number
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       WHERE il.voucher_id IN (${placeholders}) AND ${NOT_DELETED} AND il.direction = 'in'`
    )
    .all(...voucherIds) as InvoicedRow[]
}

const matchKey = (stockItemId: number | null, description: string): string =>
  stockItemId != null ? `item:${stockItemId}` : `desc:${description.trim().toLowerCase()}`

/**
 * Match one purchase order against everything received and billed under it.
 *
 * Also answers for a receipt note with NO order behind it: pass the receipt's id and every line
 * comes back `not_ordered`, which is the honest answer rather than an empty report.
 */
export function threeWayMatchFor(db: DB, id: number, info: CompanyInfo): ThreeWayMatch {
  const doc = getDocument(db, id, info)
  if (!doc) throw new Error('No such document')
  if (doc.side !== 'purchase') throw new Error('The three-way match is an inward report')

  const order = doc.stage === 'order' ? doc : null
  const receipts = order
    ? (db.prepare("SELECT id FROM sales_documents WHERE from_document_id = ? AND stage = 'challan'").all(order.id) as { id: number }[])
        .map((r) => getDocument(db, r.id, info)!)
    : [doc]

  const rows = new Map<string, MatchLine>()
  const take = (key: string, description: string): MatchLine => {
    let row = rows.get(key)
    if (!row) {
      row = { key, description, orderedMilli: 0, receivedMilli: 0, invoicedMilli: 0 }
      rows.set(key, row)
    }
    return row
  }

  for (const l of order?.lines ?? []) take(matchKey(l.stockItemId, l.description), l.description).orderedMilli += l.qtyMilli
  for (const r of receipts) {
    for (const l of r.lines) take(matchKey(l.stockItemId, l.description), l.description).receivedMilli += l.qtyMilli
  }

  const voucherIds = receipts.map((r) => r.invoiceVoucherId).filter((v): v is number => v != null)
  const invoiceNumbers = new Set<string>()
  for (const row of invoicedQuantities(db, voucherIds)) {
    invoiceNumbers.add(row.number)
    // An item on the bill that matches nothing ordered and nothing received still gets a row: it
    // is the clearest case there is of being charged for goods that never came.
    take(matchKey(row.stock_item_id, ''), `Item #${row.stock_item_id ?? '?'}`).invoicedMilli += row.qty_milli
  }

  return {
    ...threeWayMatch([...rows.values()]),
    orderId: order?.id ?? null,
    orderNumber: order?.number ?? null,
    partyName: doc.partyName,
    receiptNumbers: receipts.map((r) => r.number),
    invoiceNumbers: [...invoiceNumbers]
  }
}
