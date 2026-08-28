/**
 * Reverse-charge self-invoices (roadmap #356).
 *
 * The engine is in src/shared/gst/selfInvoice.ts, and the statutory citations live there. This is
 * the part that has to talk to the books: which purchases are reverse-charge, what tax they carry
 * at master rates, which of them already have a document, and where the next serial comes from.
 *
 * GSTR-3B and document scope are intentionally different. `rcmInwardSummary` includes every
 * flagged 9(3) liability, including a registered supplier. Section 31(3)(f), however, tells the
 * recipient to self-invoice only when that supplier is unregistered; a registered supplier's own
 * RCM invoice is the supporting document. Both paths use the same rates and registration scope.
 */

import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { computeGst, supplyTypeFor } from '@shared/gst/calc'
import {
  buildSelfInvoice,
  selfInvoiceNumber,
  type SelfInvoiceDoc,
  type SelfInvoiceLine,
  type SelfInvoiceSupply
} from '@shared/gst/selfInvoice'
import { rcmAdvice } from '@shared/gst/reverseCharge'
import { fyOf, toDisplayDate } from '@shared/dates'
import { formatPaise, plainMilli } from '@shared/money'
import { descendantIdsByName } from './masters'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'
import { writeExportPdf } from './pdf'
import { regScope, type GstScope } from './registrations'

const PURCHASE_GROUPS = ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses']

interface RcmVoucherRow {
  id: number
  date: string
  number: string
  partyLedgerId: number | null
  partyName: string | null
  partyGstin: string | null
  partyState: string | null
  partyAddress: string | null
}

/**
 * Every inward reverse-charge supply in a period, with its tax computed at master rates.
 *
 * Only UNREGISTERED suppliers appear. Section 31(3)(f) requires a recipient self-invoice for a
 * 9(3)/9(4) supply received from "a supplier who is not registered". A registered 9(3) supplier's
 * own RCM invoice remains the document; its liability still belongs in GSTR-3B.
 *
 * Purchase-return debit notes are excluded here even though they reduce the 3B liability: a
 * self-invoice documents a supply received, and a return is not one. The credit note against a
 * self-invoice is a separate document the user raises if they need it, and inventing a negative
 * self-invoice would put a document on the file that section 31 does not contemplate.
 */
export function rcmSupplies(db: DB, company: GstScope, from: string, to: string): SelfInvoiceSupply[] {
  const vouchers = db
    .prepare(
      `SELECT v.id, v.date, v.number, v.party_ledger_id AS partyLedgerId,
              p.name AS partyName, p.gstin AS partyGstin, p.state_code AS partyState, p.address AS partyAddress
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind = 'purchase' AND p.rcm = 1 AND p.gstin IS NULL
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}${regScope(company)}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as RcmVoucherRow[]
  if (vouchers.length === 0) return []

  const purchaseGroupIds = descendantIdsByName(db, PURCHASE_GROUPS)
  const invStmt = db.prepare(
    `SELECT si.name AS name, si.hsn AS hsn, il.qty_milli AS qtyMilli, u.symbol AS unit,
            il.amount AS amount, si.gst_rate AS gstRate, si.cess_rate AS cessRate
     FROM inventory_lines il
     JOIN stock_items si ON si.id = il.stock_item_id
     LEFT JOIN units u ON u.id = si.unit_id
     WHERE il.voucher_id = ?`
  )
  const lineStmt = db.prepare(
    `SELECT l.name AS name, l.hsn AS hsn, vl.amount AS amount, vl.dr_cr AS drCr,
            l.group_id AS groupId, l.gst_rate AS gstRate
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ?`
  )

  const out: SelfInvoiceSupply[] = []
  for (const v of vouchers) {
    const supply = supplyTypeFor(company.stateCode, v.partyState ?? company.stateCode)
    const inv = invStmt.all(v.id) as {
      name: string; hsn: string | null; qtyMilli: number; unit: string | null
      amount: number; gstRate: number | null; cessRate: number | null
    }[]

    const raw =
      inv.length > 0
        ? inv.map((l) => ({
            description: l.name, hsn: l.hsn, qtyMilli: l.qtyMilli, unit: l.unit,
            taxable: l.amount, rate: l.gstRate ?? 0, cessRate: l.cessRate ?? 0
          }))
        : (lineStmt.all(v.id) as { name: string; hsn: string | null; amount: number; drCr: 'dr' | 'cr'; groupId: number; gstRate: number | null }[])
            .filter((l) => l.drCr === 'dr' && purchaseGroupIds.has(l.groupId))
            .map((l) => ({
              description: l.name, hsn: l.hsn, qtyMilli: null, unit: null,
              taxable: l.amount, rate: l.gstRate ?? 0, cessRate: 0
            }))

    if (raw.length === 0) continue

    const lines: SelfInvoiceLine[] = raw.map((l) => {
      const g = computeGst(l.taxable, l.rate, supply, l.cessRate)
      return { ...l, igst: g.igst, cgst: g.cgst, sgst: g.sgst, cess: g.cess }
    })

    out.push({
      voucherId: v.id,
      date: v.date,
      voucherNumber: v.number,
      supplierName: v.partyName ?? 'Unnamed supplier',
      supplierGstin: v.partyGstin,
      supplierStateCode: v.partyState,
      supplierAddress: v.partyAddress,
      // A blank GSTIN does NOT make this section 9(4). Since 1 February 2019 that subsection is
      // confined to notified classes/categories (currently the promoter regime). The ordinary
      // party RCM flag represents a notified 9(3) category; the unsupported 9(4) promoter model
      // is not guessed into existence.
      basis: 'notified',
      lines
    })
  }
  return out
}

export interface SelfInvoiceRecord {
  id: number
  number: string
  date: string
  basis: 'unregistered' | 'notified'
  supplierName: string
  supplierGstin: string | null
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  total: number
  voucherIds: number[]
  issuedAt: string
  warnings: string[]
}

interface SelfInvoiceRow {
  id: number; number: string; doc_date: string; basis: 'unregistered' | 'notified'
  supplier_name: string; supplier_gstin: string | null
  taxable: number; igst: number; cgst: number; sgst: number; cess: number
  doc_json: string; issued_at: string
}

function mapRecord(db: DB, r: SelfInvoiceRow): SelfInvoiceRecord {
  const voucherIds = (
    db.prepare('SELECT voucher_id AS id FROM rcm_self_invoice_vouchers WHERE self_invoice_id = ? ORDER BY voucher_id').all(r.id) as
      { id: number }[]
  ).map((x) => x.id)
  let warnings: string[] = []
  try {
    warnings = (JSON.parse(r.doc_json) as SelfInvoiceDoc).warnings ?? []
  } catch {
    // A document that cannot be parsed is still a document that was issued. Losing the warnings
    // is survivable; losing the row is not.
  }
  return {
    id: r.id, number: r.number, date: r.doc_date, basis: r.basis,
    supplierName: r.supplier_name, supplierGstin: r.supplier_gstin,
    taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess,
    total: r.taxable + r.igst + r.cgst + r.sgst + r.cess,
    voucherIds, issuedAt: r.issued_at, warnings
  }
}

export interface RcmRegister {
  from: string
  to: string
  /** Reverse-charge purchases with no self-invoice against them yet. The work to do. */
  pending: { voucherId: number; date: string; voucherNumber: string; supplierName: string; supplierGstin: string | null; basis: string; taxable: number; tax: number }[]
  /** Documents already issued whose date falls in the period. */
  issued: SelfInvoiceRecord[]
  /**
   * Purchases where a line's SAC looks like a notified supply but the party is not flagged.
   *
   * Advice, not a supply: nothing here has been treated as reverse charge in the books, so
   * issuing a self-invoice for it would document a liability the return does not carry. The fix
   * is to flag the party (or the entry), and then it appears in `pending` next time.
   */
  unflagged: { voucherId: number; date: string; voucherNumber: string; partyName: string | null; category: string; reason: string }[]
}

/** The month's reverse-charge desk: what needs a document, what has one, and what to look at. */
export function rcmRegister(db: DB, company: GstScope, from: string, to: string): RcmRegister {
  const supplies = rcmSupplies(db, company, from, to)
  // Deliberately NOT filtered by IN_BOOKS. The join is here to read the voucher's date, and the
  // question being asked is "which purchases already carry a document" — a self-invoice issued to
  // satisfy Rule 46 does not stop having existed because the voucher behind it was later binned,
  // and that combination is precisely what an auditor is looking for. It cannot widen `pending`
  // either: that is computed from `rcmSupplies`, which is IN_BOOKS-filtered, minus this set.
  const documented = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT siv.voucher_id AS id
           FROM rcm_self_invoice_vouchers siv
           JOIN vouchers v ON v.id = siv.voucher_id
           WHERE v.date BETWEEN ? AND ?${regScope(company)}`
        )
        .all(from, to) as { id: number }[]
    ).map((r) => r.id)
  )

  const pending = supplies
    .filter((s) => !documented.has(s.voucherId))
    .map((s) => ({
      voucherId: s.voucherId,
      date: s.date,
      voucherNumber: s.voucherNumber,
      supplierName: s.supplierName,
      supplierGstin: s.supplierGstin,
      basis: s.basis,
      taxable: s.lines.reduce((t, l) => t + l.taxable, 0),
      tax: s.lines.reduce((t, l) => t + l.igst + l.cgst + l.sgst + l.cess, 0)
    }))

  const issued = (
    db
      .prepare(
        `SELECT DISTINCT r.* FROM rcm_self_invoices r
         JOIN rcm_self_invoice_vouchers siv ON siv.self_invoice_id = r.id
         JOIN vouchers v ON v.id = siv.voucher_id
         WHERE r.doc_date BETWEEN ? AND ?${regScope(company)}
         ORDER BY r.doc_date, r.id`
      )
      .all(from, to) as SelfInvoiceRow[]
  ).map((r) => mapRecord(db, r))

  return { from, to, pending, issued, unflagged: unflaggedAdvice(db, from, to, company) }
}

/** Purchases whose SAC matches a notified category on a party nobody has flagged. See `unflagged`. */
function unflaggedAdvice(db: DB, from: string, to: string, company: GstScope): RcmRegister['unflagged'] {
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number AS voucherNumber, p.name AS partyName,
              p.gstin AS partyGstin, COALESCE(l.hsn, si.hsn) AS sac
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id
       LEFT JOIN ledgers l ON l.id = vl.ledger_id
       LEFT JOIN inventory_lines il ON il.voucher_id = v.id
       LEFT JOIN stock_items si ON si.id = il.stock_item_id
       WHERE vt.kind = 'purchase' AND COALESCE(p.rcm, 0) = 0
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}${regScope(company)}`
    )
    .all(from, to) as { voucherId: number; date: string; voucherNumber: string; partyName: string | null; partyGstin: string | null; sac: string | null }[]

  const seen = new Set<number>()
  const out: RcmRegister['unflagged'] = []
  for (const r of rows) {
    if (seen.has(r.voucherId)) continue
    const advice = rcmAdvice({ sac: r.sac, partyFlagged: false, partyGstin: r.partyGstin })
    if (advice.kind !== 'suggest') continue
    seen.add(r.voucherId)
    out.push({
      voucherId: r.voucherId,
      date: r.date,
      voucherNumber: r.voucherNumber,
      partyName: r.partyName,
      category: advice.match.category.label,
      reason: advice.match.category.reason
    })
  }
  return out
}

/**
 * The next serial in the self-invoice series for a financial year.
 *
 * Read from the highest serial actually issued in that year's series rather than from a counter:
 * a counter and a table are two facts that can disagree, and the one that matters legally is the
 * document.
 */
export function nextSelfInvoiceNumber(db: DB, date: string): string {
  const fy = fyOf(date)
  const prefix = `RCM/${fy.label}/`
  const rows = db
    .prepare('SELECT number FROM rcm_self_invoices WHERE number LIKE ? ')
    .all(`${prefix}%`) as { number: string }[]
  const highest = rows.reduce((max, r) => {
    const n = Number(r.number.slice(prefix.length))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  return selfInvoiceNumber(fy.label, highest + 1)
}

function persist(db: DB, doc: SelfInvoiceDoc, partyLedgerId: number | null, by: string | null): SelfInvoiceRecord {
  const res = db
    .prepare(
      `INSERT INTO rcm_self_invoices
        (number, doc_date, basis, party_ledger_id, supplier_name, supplier_gstin, place_of_supply,
         supply_type, taxable, igst, cgst, sgst, cess, doc_json, issued_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      doc.number, doc.date, doc.basis, partyLedgerId, doc.supplierName, doc.supplierGstin,
      doc.placeOfSupply, doc.supplyType, doc.totals.taxable, doc.totals.igst, doc.totals.cgst,
      doc.totals.sgst, doc.totals.cess, JSON.stringify(doc), by
    )
  const id = Number(res.lastInsertRowid)
  const link = db.prepare('INSERT INTO rcm_self_invoice_vouchers (self_invoice_id, voucher_id) VALUES (?, ?)')
  for (const vid of doc.voucherIds) link.run(id, vid)
  const row = db.prepare('SELECT * FROM rcm_self_invoices WHERE id = ?').get(id) as SelfInvoiceRow
  const record = mapRecord(db, row)
  writeAudit(db, 'rcmSelfInvoice', id, 'create', null, record)
  return record
}

export interface IssueSelfInvoicesResult {
  issued: SelfInvoiceRecord[]
  /** Vouchers that already had a document and were left alone. */
  skipped: number[]
}

/**
 * Issue self-invoices for reverse-charge purchases in a period.
 *
 * Idempotent by voucher: a purchase that already carries a document is skipped rather than
 * documented twice, because two invoices for one supply is a worse finding than none. The whole
 * run is one transaction — a half-issued month with three documents and a gap in the serial is
 * not a state anybody can explain to an auditor.
 */
export function issueSelfInvoices(
  db: DB,
  company: GstScope,
  from: string,
  to: string,
  opts: { consolidate: boolean; voucherIds?: number[]; by?: string | null }
): IssueSelfInvoicesResult {
  if (opts.consolidate) {
    throw new Error(
      'Consolidated section 9(4) self-invoices are unavailable: the books do not model the notified promoter regime or the Rule 46 daily threshold. Issue one document per supply.'
    )
  }
  const all = rcmSupplies(db, company, from, to)
  const wanted = opts.voucherIds ? all.filter((s) => opts.voucherIds!.includes(s.voucherId)) : all

  const already = new Set(
    (db.prepare('SELECT DISTINCT voucher_id AS id FROM rcm_self_invoice_vouchers').all() as { id: number }[]).map((r) => r.id)
  )
  const todo = wanted.filter((s) => !already.has(s.voucherId))
  const skipped = wanted.filter((s) => already.has(s.voucherId)).map((s) => s.voucherId)
  if (todo.length === 0) return { issued: [], skipped }

  const partyOf = (voucherId: number): number | null => {
    const row = db.prepare('SELECT party_ledger_id AS id FROM vouchers WHERE id = ?').get(voucherId) as { id: number | null } | undefined
    return row?.id ?? null
  }

  const run = db.transaction((): SelfInvoiceRecord[] => {
    const out: SelfInvoiceRecord[] = []
    for (const s of todo) {
      const doc = buildSelfInvoice({
        supply: s,
        number: nextSelfInvoiceNumber(db, s.date),
        recipientStateCode: company.stateCode,
        recipientGstin: company.gstin
      })
      out.push(persist(db, doc, partyOf(s.voucherId), opts.by ?? null))
    }
    return out
  })

  return { issued: run(), skipped }
}

/** The stored document, for reprinting. Reprints the paper that was issued, not a recomputation. */
export function getSelfInvoice(db: DB, id: number): SelfInvoiceDoc {
  const row = db.prepare('SELECT doc_json FROM rcm_self_invoices WHERE id = ?').get(id) as { doc_json: string } | undefined
  if (!row) throw new Error('Self-invoice not found')
  return JSON.parse(row.doc_json) as SelfInvoiceDoc
}

const esc = (s: string | null): string => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The document, as paper.
 *
 * Headed "Tax invoice under section 31(3)(f)" rather than "Invoice", because that is what it is
 * and because the person filing it in a folder six months from now needs to know which of the two
 * kinds of invoice they are holding. The Rule 46 gaps ride on the face for the same reason.
 */
export async function selfInvoicePdf(db: DB, company: CompanyInfo, slug: string, id: number): Promise<string> {
  const doc = getSelfInvoice(db, id)
  const recipientGstin = doc.recipientGstin ?? company.gstin
  const money = (p: number): string => formatPaise(p)

  const rows = doc.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.hsn ?? '—')}</td>` +
        `<td class="r num">${l.qtyMilli === null ? '—' : plainMilli(l.qtyMilli)}</td>` +
        `<td class="r num">${l.rate}%</td><td class="r num">${money(l.taxable)}</td>` +
        `<td class="r num">${money(l.igst + l.cgst + l.sgst + l.cess)}</td></tr>`
    )
    .join('')

  const taxRows = [
    ['IGST', doc.totals.igst],
    ['CGST', doc.totals.cgst],
    ['SGST', doc.totals.sgst],
    ['Cess', doc.totals.cess]
  ]
    .filter(([, v]) => (v as number) !== 0)
    .map(([label, v]) => `<tr><td>${label}</td><td class="r num">${money(v as number)}</td></tr>`)
    .join('')

  const warnings = doc.warnings.length
    ? `<div class="warn"><b>Before this is filed:</b><ul>${doc.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : ''

  const basisLine =
    doc.basis === 'unregistered'
      ? 'Section 9(4) — supply received from a supplier who is not registered.'
      : 'Section 9(3) — a notified supply on which the recipient pays the tax.'

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.number)}</title><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.5 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 30px; }
    .num { font-variant-numeric: tabular-nums; font-family: Menlo, monospace; font-size: 11.5px; }
    .head { border-bottom: 1.5px solid #16181f; padding-bottom: 12px; display: flex; justify-content: space-between; }
    h1 { font-size: 17px; } .sub { color: #555; font-size: 11px; }
    .tag { text-align: right; } .tag b { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; }
    .parties { display: flex; gap: 40px; padding: 14px 0; border-bottom: 1px solid #16181f; }
    h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; text-align: left; border-bottom: 1.5px solid #16181f; padding: 6px 0; }
    td { padding: 5px 0; border-bottom: 1px dotted #bbb; }
    .r { text-align: right; }
    .totals { width: 44%; margin-left: auto; }
    .totals tr:last-child td { font-weight: 600; border-top: 1px solid #16181f; }
    .warn { margin-top: 16px; font-size: 10.5px; border: 1px solid #b45309; padding: 8px 10px; }
    .warn ul { margin: 4px 0 0 16px; }
    .note { margin-top: 14px; font-size: 10.5px; color: #555; border-top: 1px dotted #999; padding-top: 8px; }
    .sign { margin-top: 30px; display: flex; justify-content: space-between; font-size: 11px; }
  </style></head><body>
    <div class="head">
      <div><h1>${esc(company.name)}</h1><div class="sub">${esc(company.address)}</div>
        <div class="sub">${recipientGstin ? 'GSTIN ' + esc(recipientGstin) : 'No GSTIN on record'}</div></div>
      <div class="tag"><b>Self-invoice</b>
        <div class="sub">Tax invoice under section 31(3)(f)</div>
        <div class="sub">${esc(doc.number)} · ${toDisplayDate(doc.date)}</div></div>
    </div>

    <div class="parties">
      <div><h3>Supplier</h3><b>${esc(doc.supplierName)}</b>
        <div class="sub">${esc(doc.supplierAddress ?? '')}</div>
        <div class="sub">${doc.supplierGstin ? 'GSTIN ' + esc(doc.supplierGstin) : 'Unregistered'}</div></div>
      <div><h3>Recipient (liable to pay the tax)</h3><b>${esc(company.name)}</b>
        <div class="sub">${basisLine}</div></div>
      <div><h3>Place of supply</h3><span class="num">${esc(doc.placeOfSupply)}</span>
        <div class="sub">${doc.supplyType === 'intra' ? 'Intra-state' : 'Inter-state'}</div></div>
    </div>

    <table>
      <thead><tr><th>Description</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th>
        <th class="r">Taxable</th><th class="r">Tax</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      <tbody>
        <tr><td>Taxable value</td><td class="r num">${money(doc.totals.taxable)}</td></tr>
        ${taxRows}
        <tr><td>Total</td><td class="r num">${money(doc.totals.total)}</td></tr>
      </tbody>
    </table>

    ${warnings}

    <div class="note">
      Raised by the recipient under section 31(3)(f) of the CGST Act, on a supply on which the tax is payable by the
      recipient under ${doc.basis === 'unregistered' ? 'section 9(4)' : 'section 9(3)'}. The tax shown is payable in
      cash and, where eligible, may be claimed as input credit in the same period.
      ${doc.voucherIds.length > 1 ? `Consolidates ${doc.voucherIds.length} purchases.` : ''}
    </div>

    <div class="sign"><span>Place: ${esc(company.address.split(',').pop()?.trim() ?? '')}</span>
      <span>For <b>${esc(company.name)}</b><br><br><br>Authorised signatory</span></div>
  </body></html>`

  return writeExportPdf(slug, `self-invoice-${doc.number.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`, html, {
    pageSize: 'A4',
    pageNumbers: true
  })
}

/**
 * Withdraw a self-invoice.
 *
 * Deletes the row rather than marking it cancelled, and only for a document nothing else depends
 * on. That is a deliberate narrowness: an issued invoice serial should not be reused, so the
 * screen offers this only for a document issued by mistake in the same sitting, and the audit
 * trail keeps what it was.
 */
export function deleteSelfInvoice(db: DB, id: number): void {
  const row = db.prepare('SELECT * FROM rcm_self_invoices WHERE id = ?').get(id) as SelfInvoiceRow | undefined
  if (!row) throw new Error('Self-invoice not found')
  const before = mapRecord(db, row)
  db.prepare('DELETE FROM rcm_self_invoices WHERE id = ?').run(id)
  writeAudit(db, 'rcmSelfInvoice', id, 'delete', before, null)
}
