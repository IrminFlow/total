/**
 * Quotation → order → challan → invoice (roadmap #378, and #188/#189 with it).
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

export type Stage = 'quotation' | 'order' | 'challan'
export type DocStatus = 'open' | 'converted' | 'closed' | 'lost'

/** What each stage becomes. The invoice is a voucher, so the chain ends outside this table. */
export const NEXT_STAGE: Record<Stage, Stage | 'invoice'> = {
  quotation: 'order',
  order: 'challan',
  challan: 'invoice'
}

const PREFIX: Record<Stage, string> = { quotation: 'QT', order: 'SO', challan: 'DC' }

export const STAGE_LABEL: Record<Stage, string> = {
  quotation: 'Quotation',
  order: 'Sales order',
  challan: 'Delivery challan'
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
  /** Post-discount value, exclusive of tax. */
  amountPaise: number
}

export interface SalesDoc {
  id: number
  stage: Stage
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
}

interface DocRow {
  id: number; stage: Stage; number: string; date: string; party_ledger_id: number | null
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
    pendingMilli: Math.max(0, r.qty_milli - r.fulfilled_milli),
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

  return {
    id: row.id,
    stage: row.stage,
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
    expired: row.stage === 'quotation' && row.status === 'open' && row.valid_until !== null && row.valid_until < asOn
  }
}

export function getDocument(db: DB, id: number, info: CompanyInfo, asOn = todayISO()): SalesDoc | null {
  const row = db.prepare('SELECT * FROM sales_documents WHERE id = ?').get(id) as DocRow | undefined
  return row ? hydrate(db, row, info, asOn) : null
}

export function listDocuments(
  db: DB,
  info: CompanyInfo,
  opts: { stage?: Stage; status?: DocStatus; asOn?: string } = {}
): SalesDoc[] {
  const clauses: string[] = []
  const args: unknown[] = []
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
export function nextNumber(db: DB, stage: Stage): string {
  const row = db
    .prepare("SELECT number FROM sales_documents WHERE stage = ? AND number LIKE ? ORDER BY id DESC LIMIT 1")
    .get(stage, `${PREFIX[stage]}-%`) as { number: string } | undefined
  const last = row ? Number(row.number.split('-').pop()) : 0
  return `${PREFIX[stage]}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`
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
  if (input.lines.length === 0) throw new Error('A document needs at least one line')
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
            `INSERT INTO sales_documents (stage, number, date, party_ledger_id, party_name, valid_until,
              reference, narration, terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.stage, input.number?.trim() || nextNumber(db, input.stage), input.date,
            input.partyLedgerId ?? null, input.partyName ?? null, input.validUntil ?? null,
            input.reference ?? null, input.narration ?? null, input.terms ?? null
          ).lastInsertRowid
      )
    }
    insertLines(db, docId, input.lines)
    return docId
  })()

  const saved = getDocument(db, run, info)!
  writeAudit(db, 'sales_document', run, before ? 'update' : 'create', before, saved)
  return saved
}

function insertLines(db: DB, docId: number, lines: SalesDocLineInput[], fulfilled: number[] = []): void {
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
      const tax = effectiveItemTax(db, l.stockItemId)
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
  if (next === 'invoice') throw new Error('A challan becomes an invoice, which is a voucher — use the invoice draft')
  if (!source.partyLedgerId) {
    // A quotation may name a stranger; an order is a commitment, and a commitment needs a ledger
    // to carry the receivable when it is eventually invoiced.
    throw new Error(`${STAGE_LABEL[next]} needs a party ledger, not just a name`)
  }

  const wanted = new Map((input.quantities ?? []).map((q) => [q.lineId, q.qtyMilli]))
  const carried = source.lines
    .map((l) => ({ line: l, qty: input.quantities ? Math.min(wanted.get(l.id) ?? 0, l.pendingMilli) : l.pendingMilli }))
    .filter((x) => x.qty > 0)
  if (carried.length === 0) throw new Error(`Nothing is left on ${source.number} to carry forward`)

  const date = input.date ?? todayISO()
  const newId = db.transaction((): number => {
    const docId = Number(
      db
        .prepare(
          `INSERT INTO sales_documents (stage, number, date, party_ledger_id, party_name, reference,
            narration, terms, from_document_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          next, input.number?.trim() || nextNumber(db, next), date, source.partyLedgerId, source.partyName,
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
      }))
    )

    const bump = db.prepare('UPDATE sales_document_lines SET fulfilled_milli = fulfilled_milli + ? WHERE id = ?')
    for (const x of carried) bump.run(x.qty, x.line.id)

    const stillPending = db
      .prepare('SELECT COALESCE(SUM(qty_milli - fulfilled_milli), 0) AS left FROM sales_document_lines WHERE document_id = ?')
      .get(source.id) as { left: number }
    db.prepare('UPDATE sales_documents SET converted_to_id = ?, converted_on = ?, status = ? WHERE id = ?')
      .run(docId, date, stillPending.left > 0 ? 'open' : 'converted', source.id)
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

  const lines: InvoiceDraft['lines'] = [
    { ledgerName: doc.partyName ?? 'Sundry Debtors', group: 'Sundry Debtors', drCr: 'dr', amount: doc.totalPaise },
    { ledgerName: 'Sales Account', group: 'Sales Accounts', drCr: 'cr', amount: doc.gst.taxable }
  ]
  const tax = (name: string, amount: number): void => {
    if (amount > 0) lines.push({ ledgerName: name, group: 'Duties & Taxes', drCr: 'cr', amount })
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
    narration: `Against ${STAGE_LABEL[doc.stage].toLowerCase()} ${doc.number}`,
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

// ---------- the pipeline, which is the report a sales desk actually wants ----------

export interface PipelineStage {
  stage: Stage
  open: number
  openValuePaise: number
  converted: number
  lost: number
}

export function pipeline(db: DB, info: CompanyInfo, asOn = todayISO()): { stages: PipelineStage[]; expiringSoon: SalesDoc[] } {
  const docs = listDocuments(db, info, { asOn })
  const stages: PipelineStage[] = (['quotation', 'order', 'challan'] as Stage[]).map((stage) => {
    const mine = docs.filter((d) => d.stage === stage)
    const open = mine.filter((d) => d.status === 'open')
    return {
      stage,
      open: open.length,
      openValuePaise: open.reduce((s, d) => s + d.totalPaise, 0),
      converted: mine.filter((d) => d.status === 'converted').length,
      lost: mine.filter((d) => d.status === 'lost').length
    }
  })
  return {
    stages,
    // A quotation about to expire is the only thing on this screen with a deadline.
    expiringSoon: docs.filter((d) => d.stage === 'quotation' && d.status === 'open' && d.validUntil !== null && d.validUntil >= asOn).slice(0, 10)
  }
}
