import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { EdocInvoice, EdocItem } from '@shared/gst/edocs'
import { computeGst, supplyTypeFor } from '@shared/gst/calc'
import { toUqc } from '@shared/gst/uqc'
import { fyOf } from '@shared/dates'
import { pdfOptionsFor } from '@shared/printTemplates'
import { renderDocument, type InvoiceDocument } from '@shared/print/render'
import { selfInvoiceNumber, selfInvoiceStatus, type SelfInvoiceRow } from '@shared/gst/selfInvoice'
import { selfInvoiceSeriesSchema, type SelfInvoiceSeries } from '@shared/gst/expansionSchemas'
import { descendantIdsByName } from './masters'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'
import { resolveTemplate } from './printTemplates'
import { plexFontFaceCss } from './printFonts'
import { writeExportPdf } from './pdf'

/**
 * Reverse-charge self-invoices (WP 3.4). A registered person liable to pay tax under s.9(3)/9(4)
 * on goods or services received from a supplier who is NOT registered issues the invoice
 * itself (s.31(3)(f) CGST Act), within 30 days of receipt (rule 47A, from 01-11-2024), with the
 * rule 46 particulars — a consecutive serial unique for the FY (rule 46(b)) and "tax payable on
 * reverse charge: yes" (rule 46(p)). Sources: SELF_INVOICE_RULES in shared/gst/sources.ts.
 *
 * In the books: a purchase voucher whose party ledger is flagged reverse charge (`ledgers.rcm`)
 * and carries no GSTIN. The self-invoice is a separate numbered document on that voucher
 * (gst_self_invoices, migration 028), printed through the print-template path ('self_invoice'
 * document kind). Tax is computed at the master rates, exactly as GSTR-3B 3.1(d) computes it.
 */

const SERIES_KEY = 'gst.selfInvoice.series'

export function getSelfInvoiceSeries(db: DB): SelfInvoiceSeries {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SERIES_KEY) as { value: string } | undefined
  let raw: unknown = {}
  try {
    raw = row ? JSON.parse(row.value) : {}
  } catch {
    raw = {}
  }
  const parsed = selfInvoiceSeriesSchema.safeParse(raw)
  return parsed.success ? parsed.data : selfInvoiceSeriesSchema.parse({})
}

export function setSelfInvoiceSeries(db: DB, input: unknown): SelfInvoiceSeries {
  const before = getSelfInvoiceSeries(db)
  const parsed = selfInvoiceSeriesSchema.parse(input)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SERIES_KEY, JSON.stringify(parsed))
  writeAudit(db, 'gst_self_invoice', 0, 'update', { series: before }, { series: parsed })
  return parsed
}

interface PurchaseHead {
  id: number
  number: string
  date: string
  reference: string | null
  posOverride: string | null
  deletedAt: string | null
  partyLedgerId: number
  partyName: string
  partyAddress: string | null
  partyState: string | null
  partyGstin: string | null
  partyRcm: number
}

const HEAD_SQL = `SELECT v.id, v.number, v.date, v.reference, v.pos_override AS posOverride, v.deleted_at AS deletedAt,
         p.id AS partyLedgerId, p.name AS partyName, p.address AS partyAddress, p.state_code AS partyState,
         p.gstin AS partyGstin, COALESCE(p.rcm, 0) AS partyRcm
  FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id JOIN ledgers p ON p.id = v.party_ledger_id`

/** The self-invoice items of a purchase: inventory lines (goods) or, failing those, the
 *  purchase-side ledger lines (services), taxed at the master rate. */
function selfInvoiceItems(db: DB, company: CompanyInfo, head: PurchaseHead): EdocItem[] {
  const supply = supplyTypeFor(company.stateCode, head.partyState ?? company.stateCode)
  const inv = db
    .prepare(
      `SELECT il.qty_milli AS qtyMilli, il.rate_paise AS ratePaise, il.amount, si.name, si.hsn, si.gst_rate AS gstRate,
              si.cess_rate AS cessRate, u.uqc, u.symbol
       FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id JOIN units u ON u.id = si.unit_id
       WHERE il.voucher_id = ? ORDER BY il.line_order, il.id`
    )
    .all(head.id) as { qtyMilli: number; ratePaise: number; amount: number; name: string; hsn: string | null; gstRate: number | null; cessRate: number | null; uqc: string | null; symbol: string }[]
  if (inv.length > 0) {
    return inv.map((l) => {
      const g = computeGst(l.amount, l.gstRate ?? 0, supply, l.cessRate ?? 0)
      const mapped = toUqc(l.uqc ?? l.symbol)
      return {
        name: l.name, hsn: l.hsn ?? '', qtyMilli: l.qtyMilli, uqc: mapped.fallback ? (l.uqc ?? l.symbol) : mapped.uqc,
        unitPricePaise: l.ratePaise, taxablePaise: l.amount, rate: l.gstRate ?? 0, cessRate: l.cessRate ?? 0,
        cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess, isService: false
      }
    })
  }
  const purchaseGroupIds = descendantIdsByName(db, ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'])
  const lines = db
    .prepare(
      `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, l.name, l.hsn, l.gst_rate AS gstRate
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
    )
    .all(head.id) as { amount: number; drCr: 'dr' | 'cr'; groupId: number; name: string; hsn: string | null; gstRate: number | null }[]
  return lines
    .filter((l) => l.drCr === 'dr' && purchaseGroupIds.has(l.groupId))
    .map((l) => {
      const g = computeGst(l.amount, l.gstRate ?? 0, supply, 0)
      return {
        name: l.name, hsn: l.hsn ?? '', qtyMilli: 0, uqc: 'OTH', unitPricePaise: l.amount, taxablePaise: l.amount, rate: l.gstRate ?? 0,
        cessRate: 0, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess, isService: true
      }
    })
}

/** Purchases that need (or have) a self-invoice in [from, to], with their status as on `today`. */
export function listSelfInvoices(db: DB, company: CompanyInfo, from: string, to: string, today: string): SelfInvoiceRow[] {
  const heads = db
    .prepare(
      `${HEAD_SQL}
       WHERE vt.kind = 'purchase' AND v.date BETWEEN ? AND ?
         AND ((COALESCE(p.rcm, 0) = 1 AND (p.gstin IS NULL OR p.gstin = '') AND ${IN_BOOKS})
              OR EXISTS (SELECT 1 FROM gst_self_invoices s WHERE s.voucher_id = v.id))
       ORDER BY v.date, v.id`
    )
    .all(from, to) as PurchaseHead[]
  const siStmt = db.prepare('SELECT number, date FROM gst_self_invoices WHERE voucher_id = ?')
  return heads.map((h) => {
    const items = selfInvoiceItems(db, company, h)
    const tax = items.reduce((t, i) => t + i.cgst + i.sgst + i.igst + i.cess, 0)
    const taxable = items.reduce((t, i) => t + i.taxablePaise, 0)
    const si = siStmt.get(h.id) as { number: string; date: string } | undefined
    const st = selfInvoiceStatus(h.date, si?.date ?? null, today, h.deletedAt != null)
    return {
      voucherId: h.id, voucherNumber: h.number, date: h.date, supplierRef: h.reference, partyLedgerId: h.partyLedgerId, partyName: h.partyName,
      taxable, tax, selfInvoiceNumber: si?.number ?? null, selfInvoiceDate: si?.date ?? null, ...st
    }
  })
}

function requireRcmPurchase(db: DB, voucherId: number): PurchaseHead {
  const h = db.prepare(`${HEAD_SQL} WHERE v.id = ? AND vt.kind = 'purchase'`).get(voucherId) as PurchaseHead | undefined
  if (!h) throw new Error('Not a purchase voucher with a party')
  if (h.deletedAt) throw new Error('This purchase is in the bin')
  if (!h.partyRcm) throw new Error(`${h.partyName} is not marked reverse charge (Masters → Ledger → Reverse charge)`)
  if (h.partyGstin) throw new Error(`${h.partyName} is registered (GSTIN ${h.partyGstin}) — a self-invoice is for unregistered suppliers (s.31(3)(f))`)
  return h
}

/** Raise the self-invoice for an RCM purchase: next number in the FY series, dated `date`
 *  (default: the purchase's date — the date of receipt in the books). */
export function generateSelfInvoice(db: DB, voucherId: number, date?: string): { voucherId: number; number: string; date: string } {
  return db.transaction(() => {
    const h = requireRcmPurchase(db, voucherId)
    if (db.prepare('SELECT 1 FROM gst_self_invoices WHERE voucher_id = ?').get(voucherId)) throw new Error('A self-invoice already exists for this purchase')
    const on = date ?? h.date
    if (on < h.date) throw new Error('A self-invoice cannot be dated before the purchase (the date of receipt)')
    const fy = fyOf(on)
    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM gst_self_invoices WHERE fy_start_year = ?').get(fy.startYear) as { m: number | null }).m ?? 0) + 1
    const number = selfInvoiceNumber(getSelfInvoiceSeries(db).prefix, fy.label, seq)
    db.prepare('INSERT INTO gst_self_invoices (voucher_id, number, date, fy_start_year, seq) VALUES (?, ?, ?, ?, ?)').run(voucherId, number, on, fy.startYear, seq)
    writeAudit(db, 'gst_self_invoice', voucherId, 'create', null, { voucherId, number, date: on })
    return { voucherId, number, date: on }
  })()
}

/** The printable self-invoice (invoice shape; the company is the issuer, the supplier the party). */
export function selfInvoiceDocument(db: DB, company: CompanyInfo, voucherId: number): InvoiceDocument {
  const h = db.prepare(`${HEAD_SQL} WHERE v.id = ?`).get(voucherId) as PurchaseHead | undefined
  const si = db.prepare('SELECT number, date FROM gst_self_invoices WHERE voucher_id = ?').get(voucherId) as { number: string; date: string } | undefined
  if (!h || !si) throw new Error('No self-invoice for this purchase — generate it first')
  const items = selfInvoiceItems(db, company, h)
  const sum = (f: (i: EdocItem) => number): number => items.reduce((t, i) => t + f(i), 0)
  const taxable = sum((i) => i.taxablePaise)
  const cgst = sum((i) => i.cgst), sgst = sum((i) => i.sgst), igst = sum((i) => i.igst), cess = sum((i) => i.cess)
  const invoice: EdocInvoice = {
    voucherId,
    number: si.number,
    date: si.date,
    docType: 'INV',
    supTyp: 'B2B',
    rchrg: true,
    partyName: h.partyName,
    partyGstin: null,
    partyAddress: h.partyAddress,
    partyStateCode: h.partyState ?? company.stateCode,
    // Place of supply: the recipient's (our) location unless the voucher overrides it.
    pos: h.posOverride ?? company.stateCode,
    items, taxable, cgst, sgst, igst, cess, roundOff: 0, total: taxable + cgst + sgst + igst + cess,
    transporterId: null, vehicleNo: null, distanceKm: null,
    precedingDoc: h.reference ? { invNo: h.reference, invDate: h.date } : null
  }
  return { shape: 'invoice', kind: 'self_invoice', company, invoice, outstandingPaise: null, einvoice: null }
}

export function selfInvoiceHtml(db: DB, company: CompanyInfo, voucherId: number): string {
  const template = resolveTemplate(db, 'self_invoice')
  return renderDocument(template, selfInvoiceDocument(db, company, voucherId), { fontFaceCss: plexFontFaceCss })
}

export async function selfInvoicePdf(db: DB, company: CompanyInfo, slug: string, voucherId: number): Promise<string> {
  const template = resolveTemplate(db, 'self_invoice')
  const doc = selfInvoiceDocument(db, company, voucherId)
  const html = renderDocument(template, doc, { fontFaceCss: plexFontFaceCss })
  const safe = doc.invoice.number.replace(/[^a-zA-Z0-9-_]/g, '_')
  return writeExportPdf(slug, `self-invoice-${safe}.pdf`, html, pdfOptionsFor(template))
}
