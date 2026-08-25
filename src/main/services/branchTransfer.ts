/**
 * The branch-transfer invoice, against the books (roadmap #108).
 *
 * The engine is in `src/shared/gst/branchTransfer.ts` and every statutory citation lives there.
 * This is the half that has to talk to the database: which stock journals crossed a registration
 * boundary, what was on them, which of them already carry a document, where the next serial comes
 * from — and, on the other side, how the issued documents reach the two returns.
 *
 * THE ONE THING THIS FILE MUST NOT DO IS POST. A transfer between two registrations of one
 * business creates output tax in one return and input credit in the other, and creates no revenue,
 * no expense and no change in the closing stock value. There is no `saveVoucher` in here, no
 * ledger is touched, and the trial balance is byte-identical before and after an invoice is
 * issued. `branchTransfer.dbtest.ts` asserts exactly that.
 *
 * The consequence is stated rather than hidden: the tax is in the RETURNS and not in the BOOKS.
 * Where the receiving registration takes full credit — the case the second proviso to rule 28 is
 * written for, and the ordinary case — the two amounts are equal and opposite across one PAN and
 * the net effect on the books really is nil. Where it does not, the tax is a real cost, and the
 * document says on its face that the user has to journal it themselves.
 */

import type { DB } from '../db/connection'
import type { GstDoc, ItcPart } from '@shared/gst/returns'
import {
  branchTransferNumber,
  buildBranchTransferInvoice,
  type BranchTransferDoc,
  type BranchTransferMovement,
  type BranchTransferParty,
  type Rule28Basis
} from '@shared/gst/branchTransfer'
import { fyOf, toDisplayDate } from '@shared/dates'
import { ensureRegistrations, primaryRegistration, type GstScope } from './registrations'
import type { CrossRegistrationTransfer, GstRegistration } from '@shared/gst/registrations'
import { crossRegistrationTransfers } from './registrations'
import { itemTaxOn } from './gstRates'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

const partyOf = (reg: GstRegistration): BranchTransferParty => ({
  registrationId: reg.id,
  gstin: reg.gstin,
  stateCode: reg.stateCode,
  tradeName: reg.tradeName,
  address: reg.address
})

interface InvLineRow {
  voucherId: number
  date: string
  number: string
  stockItemId: number
  itemName: string
  hsn: string | null
  unit: string | null
  qtyMilli: number
  amount: number
  direction: 'in' | 'out'
  gstRate: number | null
  cessRate: number | null
  regId: number
}

/** A movement the app declines to invoice, and why. Reported, never silently dropped. */
export interface UninvoiceableMovement {
  voucherId: number
  date: string
  number: string
  reason: string
}

export interface MovementScan {
  movements: BranchTransferMovement[]
  skipped: UninvoiceableMovement[]
}

/**
 * Every cross-registration stock movement in a period, with its lines.
 *
 * `crossRegistrationTransfers` answers "did this happen", at voucher level, and that is what the
 * validation warning needs. An invoice needs the goods: description, HSN, quantity, unit and the
 * rate they carry, because rule 46 asks for all of them and because the tax is computed per line.
 *
 * A journal with more than one sending or more than one receiving registration is NOT invoiced.
 * Splitting its lines between two destinations would be a guess about which goods went where, and
 * a tax invoice built on a guess is worse than the warning it replaced. Those come back in
 * `skipped` with the reason on them.
 */
export function scanMovements(db: DB, from: string, to: string): MovementScan {
  const regs = ensureRegistrations(db)
  if (regs.length <= 1) return { movements: [], skipped: [] }
  const byId = new Map(regs.map((r) => [r.id, r]))
  const primary = primaryRegistration(db)!

  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number,
              il.stock_item_id AS stockItemId, si.name AS itemName, si.hsn AS hsn,
              u.symbol AS unit, il.qty_milli AS qtyMilli, il.amount, il.direction,
              si.gst_rate AS gstRate, si.cess_rate AS cessRate,
              COALESCE(g.gst_registration_id, ${primary.id}) AS regId
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN stock_items si ON si.id = il.stock_item_id
       LEFT JOIN units u ON u.id = si.unit_id
       LEFT JOIN godowns g ON g.id = il.godown_id
       WHERE vt.kind = 'stock_journal' AND il.is_absolute = 0
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id, il.line_order, il.id`
    )
    .all(from, to) as InvLineRow[]

  const byVoucher = new Map<number, InvLineRow[]>()
  for (const r of rows) {
    const list = byVoucher.get(r.voucherId)
    if (list) list.push(r)
    else byVoucher.set(r.voucherId, [r])
  }

  const movements: BranchTransferMovement[] = []
  const skipped: UninvoiceableMovement[] = []

  for (const [voucherId, lines] of byVoucher) {
    const head = lines[0] as InvLineRow
    const outRegs = new Set(lines.filter((l) => l.direction === 'out').map((l) => l.regId))
    const inRegs = new Set(lines.filter((l) => l.direction === 'in').map((l) => l.regId))
    const crosses = [...outRegs].some((o) => [...inRegs].some((i) => i !== o))
    if (!crosses) continue

    if (outRegs.size !== 1 || inRegs.size !== 1) {
      skipped.push({
        voucherId,
        date: head.date,
        number: head.number,
        reason:
          `This journal moves stock out of ${outRegs.size} registration${outRegs.size === 1 ? '' : 's'} and into ` +
          `${inRegs.size}. Which goods went to which registration is not recorded, and an invoice built on a guess ` +
          'about that is worse than none. Split it into one journal per pair and it can be invoiced.'
      })
      continue
    }

    const fromReg = byId.get([...outRegs][0] as number)
    const toReg = byId.get([...inRegs][0] as number)
    if (!fromReg || !toReg) continue

    const outLines = lines.filter((l) => l.direction === 'out')
    movements.push({
      voucherId,
      date: head.date,
      voucherNumber: head.number,
      from: partyOf(fromReg),
      to: partyOf(toReg),
      lines: outLines.map((l) => {
        // The rate in force on the VOUCHER's date, exactly as the outward extraction does (D-92).
        // A rate change must not reprice a document that was already issued or already filed.
        const dated = itemTaxOn(db, l.stockItemId, head.date)
        return {
          description: l.itemName,
          hsn: l.hsn,
          qtyMilli: l.qtyMilli,
          unit: l.unit,
          bookValue: l.amount,
          rate: dated.gstRate ?? l.gstRate ?? 0,
          cessRate: dated.cessRate ?? l.cessRate ?? 0
        }
      })
    })
  }

  return { movements, skipped }
}

// ---------- the register ----------

export interface BranchTransferRecord {
  id: number
  number: string
  date: string
  voucherId: number | null
  fromRegistrationId: number
  fromGstin: string | null
  fromStateCode: string
  toRegistrationId: number
  toGstin: string | null
  toStateCode: string
  supplyType: 'intra' | 'inter'
  basis: Rule28Basis
  recipientFullItc: boolean
  bookValue: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  total: number
  issuedAt: string
  warnings: string[]
}

interface InvoiceRow {
  id: number
  number: string
  doc_date: string
  voucher_id: number | null
  from_registration_id: number
  to_registration_id: number
  supply_type: 'intra' | 'inter'
  basis: Rule28Basis
  recipient_full_itc: number
  book_value: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  doc_json: string
  issued_at: string
}

function mapRecord(db: DB, r: InvoiceRow): BranchTransferRecord {
  let warnings: string[] = []
  let fromGstin: string | null = null
  let toGstin: string | null = null
  let fromStateCode = ''
  let toStateCode = ''
  try {
    const doc = JSON.parse(r.doc_json) as BranchTransferDoc
    warnings = doc.warnings ?? []
    fromGstin = doc.from.gstin
    toGstin = doc.to.gstin
    fromStateCode = doc.from.stateCode
    toStateCode = doc.to.stateCode
  } catch {
    // A document that cannot be parsed is still a document that was issued. Losing the warnings is
    // survivable; losing the row is not. The registrations answer for the rest.
    const regs = ensureRegistrations(db)
    fromStateCode = regs.find((x) => x.id === r.from_registration_id)?.stateCode ?? ''
    toStateCode = regs.find((x) => x.id === r.to_registration_id)?.stateCode ?? ''
  }
  return {
    id: r.id,
    number: r.number,
    date: r.doc_date,
    voucherId: r.voucher_id,
    fromRegistrationId: r.from_registration_id,
    fromGstin,
    fromStateCode,
    toRegistrationId: r.to_registration_id,
    toGstin,
    toStateCode,
    supplyType: r.supply_type,
    basis: r.basis,
    recipientFullItc: !!r.recipient_full_itc,
    bookValue: r.book_value,
    taxable: r.taxable,
    igst: r.igst,
    cgst: r.cgst,
    sgst: r.sgst,
    cess: r.cess,
    total: r.taxable + r.igst + r.cgst + r.sgst + r.cess,
    issuedAt: r.issued_at,
    warnings
  }
}

export interface PendingTransfer {
  voucherId: number
  date: string
  number: string
  fromRegistrationId: number
  fromGstin: string | null
  fromStateCode: string
  toRegistrationId: number
  toGstin: string | null
  toStateCode: string
  supplyType: 'intra' | 'inter'
  bookValue: number
  /** Tax at the goods' own rates on the book value — what an invoice on the default basis carries. */
  estimatedTax: number
  lines: number
}

export interface BranchTransferRegister {
  from: string
  to: string
  /** Movements with no invoice against them. The work to do. */
  pending: PendingTransfer[]
  /** Documents already issued whose date falls in the period. */
  issued: BranchTransferRecord[]
  /** Movements this app declines to invoice, with the reason. */
  skipped: UninvoiceableMovement[]
  /** False on a single-registration book: none of this can arise, and the tab says so. */
  multiRegistration: boolean
}

/** Which (voucher, from, to) triples already carry a document. */
function documentedKeys(db: DB): Set<string> {
  const rows = db
    .prepare(
      'SELECT voucher_id AS v, from_registration_id AS f, to_registration_id AS t FROM branch_transfer_invoices'
    )
    .all() as { v: number | null; f: number; t: number }[]
  return new Set(rows.map((r) => `${r.v}:${r.f}:${r.t}`))
}

/** The month's branch-transfer desk: what needs an invoice, what has one, what cannot have one. */
export function branchTransferRegister(db: DB, from: string, to: string): BranchTransferRegister {
  const regs = ensureRegistrations(db)
  if (regs.length <= 1) {
    return { from, to, pending: [], issued: [], skipped: [], multiRegistration: false }
  }
  const { movements, skipped } = scanMovements(db, from, to)
  const documented = documentedKeys(db)

  const pending = movements
    .filter((m) => !documented.has(`${m.voucherId}:${m.from.registrationId}:${m.to.registrationId}`))
    .map((m) => {
      const supplyType: 'intra' | 'inter' = m.from.stateCode === m.to.stateCode ? 'intra' : 'inter'
      const bookValue = m.lines.reduce((t, l) => t + l.bookValue, 0)
      const estimatedTax = m.lines.reduce(
        (t, l) => t + Math.round((l.bookValue * l.rate) / 100) + Math.round((l.bookValue * l.cessRate) / 100),
        0
      )
      return {
        voucherId: m.voucherId,
        date: m.date,
        number: m.voucherNumber,
        fromRegistrationId: m.from.registrationId,
        fromGstin: m.from.gstin,
        fromStateCode: m.from.stateCode,
        toRegistrationId: m.to.registrationId,
        toGstin: m.to.gstin,
        toStateCode: m.to.stateCode,
        supplyType,
        bookValue,
        estimatedTax,
        lines: m.lines.length
      }
    })

  const issued = (
    db
      .prepare('SELECT * FROM branch_transfer_invoices WHERE doc_date BETWEEN ? AND ? ORDER BY doc_date, id')
      .all(from, to) as InvoiceRow[]
  ).map((r) => mapRecord(db, r))

  return { from, to, pending, issued, skipped, multiRegistration: true }
}

/**
 * The cross-registration movements that still have no invoice.
 *
 * What `gst:validate` warns about. Same shape as `crossRegistrationTransfers`, minus the ones that
 * have been dealt with — so the warning shrinks as the work is done instead of standing there
 * forever repeating something the user has already fixed.
 */
export function undocumentedCrossTransfers(db: DB, from: string, to: string): CrossRegistrationTransfer[] {
  const all = crossRegistrationTransfers(db, from, to)
  if (all.length === 0) return all
  const documented = documentedKeys(db)
  return all.filter((t) => !documented.has(`${t.voucherId}:${t.fromRegistrationId}:${t.toRegistrationId}`))
}

// ---------- issuing ----------

/**
 * The next serial in a SENDING registration's branch-transfer series for a financial year.
 *
 * Read from the highest serial actually issued in that series rather than from a counter: a
 * counter and a table are two facts that can disagree, and the one that matters legally is the
 * document. Per registration, because two registrations are two registered persons and rule 46(b)
 * wants each of their series consecutive.
 */
export function nextBranchTransferNumber(db: DB, senderStateCode: string, date: string): string {
  const fy = fyOf(date)
  const prefix = `BT/${senderStateCode}/${fy.label}/`
  const rows = db
    .prepare('SELECT number FROM branch_transfer_invoices WHERE number LIKE ?')
    .all(`${prefix}%`) as { number: string }[]
  const highest = rows.reduce((max, r) => {
    const n = Number(r.number.slice(prefix.length))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  return branchTransferNumber(senderStateCode, fy.label, highest + 1)
}

export interface IssueBranchTransfersInput {
  from: string
  to: string
  basis: Rule28Basis
  recipientFullItc: boolean
  /** Only these vouchers, when given. */
  voucherIds?: number[]
  /** A value the user fixed by hand, for the bases the books cannot answer. Per movement. */
  declaredPaise?: number | null
  recipientPricePaise?: number | null
  by?: string | null
}

export interface IssueBranchTransfersResult {
  issued: BranchTransferRecord[]
  /** Movements that already had a document and were left alone. */
  skipped: number[]
}

function persist(db: DB, doc: BranchTransferDoc, recipientFullItc: boolean, by: string | null): BranchTransferRecord {
  const res = db
    .prepare(
      `INSERT INTO branch_transfer_invoices
        (number, doc_date, voucher_id, from_registration_id, to_registration_id, place_of_supply,
         supply_type, basis, recipient_full_itc, book_value, taxable, igst, cgst, sgst, cess,
         doc_json, issued_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      doc.number, doc.date, doc.voucherId, doc.from.registrationId, doc.to.registrationId,
      doc.placeOfSupply, doc.supplyType, doc.basis,
      // Stored, not re-derived from the document's warnings. It is what `branchTransferInwardItc`
      // reads to decide whether the receiver may claim the credit, and a fact a return depends on
      // should not be recovered by matching the prefix of an English sentence.
      recipientFullItc ? 1 : 0,
      doc.totals.bookValue, doc.totals.taxable, doc.totals.igst, doc.totals.cgst, doc.totals.sgst,
      doc.totals.cess, JSON.stringify(doc), by
    )
  const id = Number(res.lastInsertRowid)
  const row = db.prepare('SELECT * FROM branch_transfer_invoices WHERE id = ?').get(id) as InvoiceRow
  const record = mapRecord(db, row)
  writeAudit(db, 'branchTransferInvoice', id, 'create', null, record)
  return record
}

/**
 * Raise the invoices for a period's cross-registration movements.
 *
 * Idempotent per (voucher, sender, recipient): a movement that already carries a document is
 * skipped rather than documented twice, because two invoices for one supply is a worse finding
 * than none. The whole run is one transaction — a half-issued month with a gap in a registration's
 * serial is not a state anybody can explain to an auditor.
 *
 * Still posts nothing. See the file header.
 */
export function issueBranchTransfers(db: DB, input: IssueBranchTransfersInput): IssueBranchTransfersResult {
  const { movements } = scanMovements(db, input.from, input.to)
  const wanted = input.voucherIds ? movements.filter((m) => input.voucherIds!.includes(m.voucherId)) : movements
  const documented = documentedKeys(db)
  const todo = wanted.filter((m) => !documented.has(`${m.voucherId}:${m.from.registrationId}:${m.to.registrationId}`))
  const skipped = wanted
    .filter((m) => documented.has(`${m.voucherId}:${m.from.registrationId}:${m.to.registrationId}`))
    .map((m) => m.voucherId)
  if (todo.length === 0) return { issued: [], skipped }

  const run = db.transaction((): BranchTransferRecord[] => {
    const out: BranchTransferRecord[] = []
    // Serials are handed out from a running counter PER SENDING REGISTRATION for the batch. Asking
    // the table once per document would give every document in the batch the same serial, because
    // nothing has been written yet.
    const nextBy = new Map<string, number>()
    for (const m of todo) {
      const key = `${m.from.stateCode}|${fyOf(m.date).label}`
      let seq = nextBy.get(key)
      if (seq === undefined) {
        seq = Number(nextBranchTransferNumber(db, m.from.stateCode, m.date).split('/').pop())
      }
      const number = branchTransferNumber(m.from.stateCode, fyOf(m.date).label, seq)
      nextBy.set(key, seq + 1)

      const doc = buildBranchTransferInvoice({
        movement: m,
        number,
        basis: input.basis,
        recipientFullItc: input.recipientFullItc,
        declaredPaise: input.declaredPaise ?? null,
        recipientPricePaise: input.recipientPricePaise ?? null
      })
      out.push(persist(db, doc, input.recipientFullItc, input.by ?? null))
    }
    return out
  })

  return { issued: run(), skipped }
}

/** The stored document, for reprinting. Reprints the paper that was issued, not a recomputation. */
export function getBranchTransferInvoice(db: DB, id: number): BranchTransferDoc {
  const row = db.prepare('SELECT doc_json FROM branch_transfer_invoices WHERE id = ?').get(id) as
    | { doc_json: string }
    | undefined
  if (!row) throw new Error('Branch-transfer invoice not found')
  return JSON.parse(row.doc_json) as BranchTransferDoc
}

/**
 * Withdraw a branch-transfer invoice.
 *
 * Deletes the row rather than marking it cancelled, and the movement returns to `pending`. That is
 * a deliberate narrowness: an issued serial should not be reused, so the screen offers this for a
 * document raised by mistake in the same sitting, and the audit trail keeps what it was.
 */
export function deleteBranchTransferInvoice(db: DB, id: number): void {
  const row = db.prepare('SELECT * FROM branch_transfer_invoices WHERE id = ?').get(id) as InvoiceRow | undefined
  if (!row) throw new Error('Branch-transfer invoice not found')
  const before = mapRecord(db, row)
  db.prepare('DELETE FROM branch_transfer_invoices WHERE id = ?').run(id)
  writeAudit(db, 'branchTransferInvoice', id, 'delete', before, null)
}

// ---------- how the document reaches the two returns ----------

/**
 * The sender's side: issued branch-transfer invoices as outward documents.
 *
 * Appended to `extractOutwardDocs`, so the supply lands in GSTR-1's B2B table (the recipient is a
 * registered person with a GSTIN) and in GSTR-3B 3.1(a), exactly as any other outward supply would.
 * That is the point of the whole feature — the supply has to be IN the sender's return, not
 * mentioned beside it.
 *
 * `voucherId` on the synthetic doc is the stock journal's id. Voucher ids are unique across kinds,
 * so it cannot collide with a real sales voucher, and it is what lets a validation issue or an
 * amendment diff point back at the movement the invoice documents.
 *
 * Returns nothing at all when the scope has no registration — a caller passing a bare `CompanyInfo`
 * gets exactly what it always got.
 *
 * NOT covered: GSTR-1 Table 13, "documents issued". That is computed by `extractDocSeries` from
 * voucher numbering, and these documents are not vouchers. The series is consecutive and readable
 * off the register, but Table 13 has to be completed by hand for it. Said here and on the roadmap
 * rather than quietly left out.
 */
export function branchTransferOutwardDocs(db: DB, scope: GstScope, from: string, to: string): GstDoc[] {
  const regId = scope.registrationId
  if (regId == null) return []
  const rows = db
    .prepare(
      `SELECT * FROM branch_transfer_invoices
       WHERE doc_date BETWEEN ? AND ? AND from_registration_id = ?
       ORDER BY doc_date, id`
    )
    .all(from, to, regId) as InvoiceRow[]

  const docs: GstDoc[] = []
  for (const r of rows) {
    let doc: BranchTransferDoc
    try {
      doc = JSON.parse(r.doc_json) as BranchTransferDoc
    } catch {
      continue
    }
    // One rate bucket per rate, and one HSN line per (hsn, rate) — the same shape the outward
    // extraction produces, so Tables 4-7 tie to Table 12 for these documents too.
    const byRate = new Map<number, { rate: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number }>()
    const hsnLines: GstDoc['hsnLines'] = []
    const nilLines: { taxable: number }[] = []
    for (const l of doc.lines) {
      if (l.rate === 0) {
        nilLines.push({ taxable: l.taxable })
      } else {
        const b = byRate.get(l.rate) ?? { rate: l.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
        b.taxable += l.taxable
        b.cgst += l.cgst
        b.sgst += l.sgst
        b.igst += l.igst
        b.cess += l.cess
        byRate.set(l.rate, b)
      }
      hsnLines.push({
        hsn: l.hsn ?? '',
        description: l.description,
        uqc: l.unit ?? 'OTH',
        qtyMilli: l.qtyMilli,
        rate: l.rate,
        taxable: l.taxable,
        cgst: l.cgst,
        sgst: l.sgst,
        igst: l.igst,
        cess: l.cess
      })
    }
    docs.push({
      voucherId: doc.voucherId,
      kind: 'sales',
      date: doc.date,
      number: doc.number,
      partyName: doc.to.tradeName,
      partyGstin: doc.to.gstin,
      pos: doc.placeOfSupply,
      invoiceValue: doc.totals.total,
      items: [...byRate.values()],
      hsnLines,
      nilLines,
      invTyp: 'R'
    })
  }
  return docs
}

/**
 * The receiver's side: credit on branch transfers received in the period.
 *
 * Folded into GSTR-3B Table 4(A)(5) "All other ITC", which is where an ordinary inward supply from
 * a registered person belongs. The tax the sender charged is the tax the receiver claims, to the
 * paise, because both are read off the same stored document — which is the property that makes the
 * two registrations' returns tie, and the one a recomputation on each side would quietly break.
 */
export function branchTransferInwardItc(db: DB, scope: GstScope, from: string, to: string): ItcPart {
  const regId = scope.registrationId
  const zero: ItcPart = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  if (regId == null) return zero
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(igst), 0) AS igst, COALESCE(SUM(cgst), 0) AS cgst,
              COALESCE(SUM(sgst), 0) AS sgst, COALESCE(SUM(cess), 0) AS cess
       FROM branch_transfer_invoices
       WHERE doc_date BETWEEN ? AND ? AND to_registration_id = ? AND recipient_full_itc = 1`
    )
    .get(from, to, regId) as ItcPart
  return row ?? zero
}
