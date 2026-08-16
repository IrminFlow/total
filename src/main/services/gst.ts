import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { buildGstr1, buildGstr3b, type GstDoc, type GstDocRateItem, type GstHsnLine, type Gstr1Result, type Gstr3bResult, type InwardSummary } from '@shared/gst/returns'
import { computeGst, supplyTypeFor } from '@shared/gst/calc'
import { plainRupees } from '@shared/money'
import { parseGstr2b, reconcile2b, type PurchaseDoc, type Recon2bResult } from '@shared/gst/recon2b'
import { descendantIdsByName } from './masters'
import { companyExportsDir } from '../paths'
import { NOT_DELETED } from './vouchers'

interface DocVoucherRow {
  id: number; date: string; number: string; kind: 'sales' | 'credit_note'
  partyName: string | null; partyGstin: string | null; partyState: string | null
}

/**
 * Extract outward GST documents (sales + credit notes) for a period.
 * Taxable value per rate comes from inventory lines (rate from the stock item) when present,
 * otherwise from sales-account ledger lines (rate from the ledger). Tax is recomputed from
 * rate + supply type — the voucher-entry UI writes the same figures, and recomputing keeps
 * returns correct even if tax ledger lines were edited by hand.
 */
export function extractOutwardDocs(db: DB, company: CompanyInfo, from: string, to: string): GstDoc[] {
  const vouchers = db
    .prepare(
      `SELECT v.id, v.date, v.number, vt.kind,
              p.name AS partyName, p.gstin AS partyGstin, p.state_code AS partyState
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind IN ('sales', 'credit_note') AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as DocVoucherRow[]

  const salesGroupIds = descendantIdsByName(db, ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'])

  const invStmt = db.prepare(
    `SELECT il.qty_milli AS qtyMilli, il.amount,
            si.name AS itemName, si.hsn, si.gst_rate AS gstRate, si.cess_rate AS cessRate,
            u.uqc
     FROM inventory_lines il
     JOIN stock_items si ON si.id = il.stock_item_id
     JOIN units u ON u.id = si.unit_id
     WHERE il.voucher_id = ? ORDER BY il.line_order, il.id`
  )
  const lineStmt = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, l.gst_rate AS gstRate, l.hsn, l.name
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
  )
  const totalStmt = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND dr_cr = 'dr'"
  )

  return vouchers.map((v) => {
    const pos = v.partyState ?? company.stateCode
    const supply = supplyTypeFor(company.stateCode, pos)
    const inv = invStmt.all(v.id) as {
      qtyMilli: number; amount: number; itemName: string
      hsn: string | null; gstRate: number | null; cessRate: number | null; uqc: string
    }[]

    interface RateBucket { taxable: number; cessRate: number }
    const buckets = new Map<string, RateBucket & { rate: number }>()
    const hsnLines: GstHsnLine[] = []

    const addToBucket = (rate: number, cessRate: number, taxable: number): void => {
      const key = `${rate}|${cessRate}`
      const b = buckets.get(key) ?? { rate, cessRate, taxable: 0 }
      b.taxable += taxable
      buckets.set(key, b)
    }

    if (inv.length > 0) {
      for (const line of inv) {
        const rate = line.gstRate ?? 0
        const cessRate = line.cessRate ?? 0
        addToBucket(rate, cessRate, line.amount)
        if (line.hsn) {
          const g = computeGst(line.amount, rate, supply, cessRate)
          hsnLines.push({
            hsn: line.hsn, description: line.itemName, uqc: line.uqc, qtyMilli: line.qtyMilli,
            rate, taxable: line.amount, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess
          })
        }
      }
    } else {
      const lines = lineStmt.all(v.id) as {
        amount: number; drCr: 'dr' | 'cr'; groupId: number; gstRate: number | null; hsn: string | null; name: string
      }[]
      // Sales side: credit lines on sales vouchers, debit lines on credit notes.
      const salesSide = v.kind === 'sales' ? 'cr' : 'dr'
      for (const line of lines) {
        if (line.drCr !== salesSide || !salesGroupIds.has(line.groupId)) continue
        const rate = line.gstRate ?? 0
        addToBucket(rate, 0, line.amount)
        if (line.hsn) {
          const g = computeGst(line.amount, rate, supply, 0)
          hsnLines.push({
            hsn: line.hsn, description: line.name, uqc: 'OTH', qtyMilli: 0,
            rate, taxable: line.amount, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess
          })
        }
      }
    }

    const items: GstDocRateItem[] = [...buckets.values()].map((b) => {
      const g = computeGst(b.taxable, b.rate, supply, b.cessRate)
      return { rate: b.rate, taxable: b.taxable, cgst: g.cgst, sgst: g.sgst, igst: g.igst, cess: g.cess }
    })

    const invoiceValue = (totalStmt.get(v.id) as { t: number }).t

    return {
      voucherId: v.id,
      kind: v.kind,
      date: v.date,
      number: v.number,
      partyName: v.partyName,
      partyGstin: v.partyGstin,
      pos,
      invoiceValue,
      items,
      hsnLines
    }
  })
}

/** ITC for the period: tax-ledger debits on purchases minus credits on debit notes (purchase returns). */
export function inwardSummary(db: DB, from: string, to: string): InwardSummary {
  const rows = db
    .prepare(
      `SELECT l.tax_type AS taxType,
              SUM(CASE
                    WHEN vt.kind = 'purchase' AND vl.dr_cr = 'dr' THEN vl.amount
                    WHEN vt.kind = 'debit_note' AND vl.dr_cr = 'cr' THEN -vl.amount
                    ELSE 0
                  END) AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE l.tax_type IS NOT NULL AND vt.kind IN ('purchase', 'debit_note') AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
       GROUP BY l.tax_type`
    )
    .all(from, to) as { taxType: 'cgst' | 'sgst' | 'igst' | 'cess'; amount: number }[]
  const s: InwardSummary = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  for (const r of rows) s[r.taxType] += r.amount
  return s
}

interface PurchaseVoucherRow {
  id: number; date: string; number: string; reference: string | null; kind: 'purchase' | 'debit_note'
  partyLedgerId: number | null; partyName: string | null; partyGstin: string | null
}

/**
 * Extract purchase-side documents (purchase invoices + debit notes) for a period, for GSTR-2B
 * reconciliation. Mirrors extractOutwardDocs: taxable value from inventory lines when present,
 * otherwise from purchase-side ledger lines (dr side on purchase / cr on debit_note, ledgers
 * under Purchase Accounts / Direct Expenses / Indirect Expenses). Tax components are per-voucher
 * sums of lines whose ledger tax_type is cgst/sgst/igst/cess — the actual booked tax, not a
 * recomputation, so entry errors surface in the reconciliation. supplierRef is the supplier's
 * own invoice number as entered (vouchers.reference); invoiceValue is the party ledger's line
 * amount (cr on purchase, dr on debit_note), falling back to the total debit if that's zero.
 */
export function extractPurchaseDocs(db: DB, from: string, to: string): PurchaseDoc[] {
  const vouchers = db
    .prepare(
      `SELECT v.id, v.date, v.number, v.reference, v.party_ledger_id AS partyLedgerId, vt.kind,
              p.name AS partyName, p.gstin AS partyGstin
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind IN ('purchase', 'debit_note') AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as PurchaseVoucherRow[]

  const purchaseGroupIds = descendantIdsByName(db, ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'])

  const invStmt = db.prepare(`SELECT il.amount FROM inventory_lines il WHERE il.voucher_id = ?`)
  const lineStmt = db.prepare(
    `SELECT vl.amount, vl.dr_cr AS drCr, l.group_id AS groupId, l.tax_type AS taxType
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
  )
  const partyLineStmt = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND ledger_id = ? AND dr_cr = ?`
  )
  const totalDrStmt = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND dr_cr = 'dr'`
  )

  return vouchers.map((v) => {
    const inv = invStmt.all(v.id) as { amount: number }[]
    const lines = lineStmt.all(v.id) as { amount: number; drCr: 'dr' | 'cr'; groupId: number; taxType: string | null }[]

    let taxable = 0
    if (inv.length > 0) {
      taxable = inv.reduce((s, l) => s + l.amount, 0)
    } else {
      const purchaseSide = v.kind === 'purchase' ? 'dr' : 'cr'
      for (const line of lines) {
        if (line.drCr === purchaseSide && purchaseGroupIds.has(line.groupId)) taxable += line.amount
      }
    }

    let igst = 0, cgst = 0, sgst = 0, cess = 0
    for (const line of lines) {
      if (line.taxType === 'igst') igst += line.amount
      else if (line.taxType === 'cgst') cgst += line.amount
      else if (line.taxType === 'sgst') sgst += line.amount
      else if (line.taxType === 'cess') cess += line.amount
    }

    const partySide = v.kind === 'purchase' ? 'cr' : 'dr'
    let invoiceValue = v.partyLedgerId != null ? (partyLineStmt.get(v.id, v.partyLedgerId, partySide) as { t: number }).t : 0
    if (!invoiceValue) invoiceValue = (totalDrStmt.get(v.id) as { t: number }).t

    return {
      voucherId: v.id,
      kind: v.kind,
      date: v.date,
      number: v.number,
      supplierRef: v.reference,
      partyName: v.partyName,
      partyGstin: v.partyGstin,
      invoiceValue,
      taxable,
      igst,
      cgst,
      sgst,
      cess
    }
  })
}

/** Parse a downloaded GSTR-2B JSON and reconcile it against the books for the same period. */
export function recon2b(
  db: DB,
  jsonText: string,
  from: string,
  to: string
): { result: Recon2bResult; errors: string[]; period: string | null } {
  const parsed = parseGstr2b(jsonText)
  const books = extractPurchaseDocs(db, from, to)
  const result = reconcile2b(parsed.invoices, books, { amountTolerancePaise: 100, dateWindowDays: 7 })
  return { result, errors: parsed.errors, period: parsed.period }
}

export function gstr1(db: DB, company: CompanyInfo, from: string, to: string, period: string): Gstr1Result {
  const docs = extractOutwardDocs(db, company, from, to)
  return buildGstr1(docs, company.gstin ?? '', company.stateCode, period)
}

export function gstr3b(db: DB, company: CompanyInfo, from: string, to: string, period: string): Gstr3bResult {
  const docs = extractOutwardDocs(db, company, from, to)
  return buildGstr3b(docs, inwardSummary(db, from, to), company.gstin ?? '', period)
}

export function exportReturnJson(
  slug: string,
  name: 'gstr1' | 'gstr3b',
  period: string,
  json: Record<string, unknown>
): string {
  const path = join(companyExportsDir(slug), `${name}-${period}.json`)
  writeFileSync(path, JSON.stringify(json, null, 2))
  return path
}

/** CSV of the GSTR-1 section summary for spreadsheet review. */
export function exportGstr1Csv(slug: string, result: Gstr1Result): string {
  const header = 'Section,Documents,Taxable Value,IGST,CGST,SGST,Cess'
  const lines = result.summary.map((s) =>
    [s.label, s.docs, plainRupees(s.taxable), plainRupees(s.igst), plainRupees(s.cgst), plainRupees(s.sgst), plainRupees(s.cess)]
      .map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v))
      .join(',')
  )
  const path = join(companyExportsDir(slug), `gstr1-${result.period}-summary.csv`)
  writeFileSync(path, [header, ...lines].join('\n'))
  return path
}
