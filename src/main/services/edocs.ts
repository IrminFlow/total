import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { EdocListRow } from '@shared/reports'
import { buildEInvoiceJson, buildEwbJson, type EdocCompany, type EdocInvoice, type EdocItem } from '@shared/gst/edocs'
import { computeGst, supplyTypeFor } from '@shared/gst/calc'
import { companyExportsDir } from '../paths'
import { NOT_DELETED } from './vouchers'

/** Voucher kinds eligible for e-invoice/e-way bill extraction: sales invoices plus the
 *  credit/debit notes issued against them. */
const EDOC_KINDS = ['sales', 'credit_note', 'debit_note'] as const

/** vt.kind -> NIC DocDtls.Typ / EWB docType. */
function docTypeFor(kind: string): 'INV' | 'CRN' | 'DBN' {
  if (kind === 'credit_note') return 'CRN'
  if (kind === 'debit_note') return 'DBN'
  return 'INV'
}

/** TranDtls.SupTyp precedence: party ledger export_type first, then party state code 96/97
 *  (Other Territory / foreign — export-shaped even without an explicit export_type flag),
 *  else plain domestic B2B. */
function supTypFor(exportType: string | null, partyStateCode: string | null): 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP' {
  switch (exportType) {
    case 'sez_wp': return 'SEZWP'
    case 'sez_wop': return 'SEZWOP'
    case 'exp_wp': return 'EXPWP'
    case 'exp_wop': return 'EXPWOP'
  }
  if (partyStateCode === '96' || partyStateCode === '97') return 'EXPWOP'
  return 'B2B'
}

export function listSalesInvoices(db: DB, from: string, to: string): EdocListRow[] {
  const kindPlaceholders = EDOC_KINDS.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date, vt.kind AS kind, p.name AS partyName, p.gstin AS partyGstin,
              COALESCE(t.total, 0) AS total, v.vehicle_no AS vehicleNo, v.irn, v.ewb_no AS ewbNo,
              EXISTS(SELECT 1 FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id
                     WHERE il.voucher_id = v.id AND si.hsn IS NOT NULL) AS hasHsn
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN (SELECT voucher_id, SUM(amount) AS total FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id) t
         ON t.voucher_id = v.id
       WHERE vt.kind IN (${kindPlaceholders}) AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
       ORDER BY v.date, v.id`
    )
    .all(...EDOC_KINDS, from, to)
    .map((r: any) => {
      const { kind, ...rest } = r
      return { ...rest, docType: docTypeFor(kind), hasHsn: !!r.hasHsn }
    }) as EdocListRow[]
}

/** Assemble full e-doc invoices (items, party, dispatch) for the sales vouchers in a period. */
export function extractEdocInvoices(db: DB, company: CompanyInfo, from: string, to: string, voucherId?: number): EdocInvoice[] {
  const kindPlaceholders = EDOC_KINDS.map(() => '?').join(', ')
  const vouchers = db
    .prepare(
      `SELECT v.id, v.number, v.date, vt.kind AS kind, v.transporter_id AS transporterId, v.vehicle_no AS vehicleNo,
              v.transport_distance AS distanceKm, v.irn,
              p.name AS partyName, p.gstin AS partyGstin, p.state_code AS partyState, p.address AS partyAddress,
              p.export_type AS partyExportType
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE vt.kind IN (${kindPlaceholders}) AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.id = ?) AND ${NOT_DELETED}
       ORDER BY v.date, v.id`
    )
    .all(...EDOC_KINDS, from, to, voucherId ?? null, voucherId ?? null) as {
      id: number; number: string; date: string; kind: 'sales' | 'credit_note' | 'debit_note'
      transporterId: string | null; vehicleNo: string | null; distanceKm: number | null; irn: string | null
      partyName: string | null; partyGstin: string | null; partyState: string | null; partyAddress: string | null
      partyExportType: string | null
    }[]

  const invStmt = db.prepare(
    `SELECT il.qty_milli AS qtyMilli, il.rate_paise AS ratePaise, il.amount,
            si.name, si.hsn, si.gst_rate AS gstRate, si.cess_rate AS cessRate, si.barcode, u.uqc
     FROM inventory_lines il
     JOIN stock_items si ON si.id = il.stock_item_id
     JOIN units u ON u.id = si.unit_id
     WHERE il.voucher_id = ? ORDER BY il.line_order, il.id`
  )
  const totalStmt = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND dr_cr = 'dr'"
  )

  return vouchers.map((v) => {
    const pos = v.partyState ?? company.stateCode
    const supply = supplyTypeFor(company.stateCode, pos)
    const rawItems = invStmt.all(v.id) as {
      qtyMilli: number; ratePaise: number; amount: number
      name: string; hsn: string | null; gstRate: number | null; cessRate: number | null; barcode: string | null; uqc: string
    }[]
    const items: EdocItem[] = rawItems.map((item) => {
      const rate = item.gstRate ?? 0
      const cessRate = item.cessRate ?? 0
      const g = computeGst(item.amount, rate, supply, cessRate)
      return {
        name: item.name,
        hsn: item.hsn ?? '',
        qtyMilli: item.qtyMilli,
        uqc: item.uqc,
        unitPricePaise: item.ratePaise,
        taxablePaise: item.amount,
        rate,
        cessRate,
        cgst: g.cgst,
        sgst: g.sgst,
        igst: g.igst,
        cess: g.cess,
        isService: false,
        barcode: item.barcode
      }
    })
    const taxable = items.reduce((s, i) => s + i.taxablePaise, 0)
    const cgst = items.reduce((s, i) => s + i.cgst, 0)
    const sgst = items.reduce((s, i) => s + i.sgst, 0)
    const igst = items.reduce((s, i) => s + i.igst, 0)
    const cess = items.reduce((s, i) => s + i.cess, 0)
    const total = (totalStmt.get(v.id) as { t: number }).t
    return {
      number: v.number,
      date: v.date,
      docType: docTypeFor(v.kind),
      supTyp: supTypFor(v.partyExportType, v.partyState),
      partyName: v.partyName,
      partyGstin: v.partyGstin,
      partyAddress: v.partyAddress,
      partyStateCode: v.partyState ?? company.stateCode,
      pos,
      items,
      taxable,
      cgst,
      sgst,
      igst,
      cess,
      roundOff: total - (taxable + cgst + sgst + igst + cess),
      total,
      transporterId: v.transporterId,
      vehicleNo: v.vehicleNo,
      distanceKm: v.distanceKm,
      irn: v.irn
    }
  })
}

function edocCompany(company: CompanyInfo): EdocCompany {
  return {
    name: company.name,
    gstin: company.gstin ?? '',
    stateCode: company.stateCode,
    address: company.address
  }
}

export function exportEInvoices(db: DB, company: CompanyInfo, slug: string, from: string, to: string, period: string): { path: string; count: number } {
  // A GSTIN is required for domestic/SEZ buyers, but exports legitimately have none — the
  // builder maps those to BuyerDtls.Gstin 'URP', so don't drop them here.
  const invoices = extractEdocInvoices(db, company, from, to).filter(
    (i) => i.partyGstin || i.supTyp === 'EXPWP' || i.supTyp === 'EXPWOP'
  )
  const json = buildEInvoiceJson(invoices, edocCompany(company))
  const path = join(companyExportsDir(slug), `einvoice-${period}.json`)
  writeFileSync(path, JSON.stringify(json, null, 2))
  return { path, count: invoices.length }
}

export function exportEwb(db: DB, company: CompanyInfo, slug: string, from: string, to: string, period: string): { path: string; count: number } {
  const invoices = extractEdocInvoices(db, company, from, to)
  const json = buildEwbJson(invoices, edocCompany(company))
  const path = join(companyExportsDir(slug), `ewaybill-${period}.json`)
  writeFileSync(path, JSON.stringify(json, null, 2))
  return { path, count: invoices.length }
}
