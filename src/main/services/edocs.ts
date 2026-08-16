import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, VoucherTransport } from '@shared/domain'
import type { EdocListRow } from '@shared/reports'
import type { VoucherTransportInput } from '@shared/schemas'
import {
  buildEInvoiceJson, buildEwbJson, ewbEligibility, ewbIssues, EWB_THRESHOLD_PAISE,
  type EdocCompany, type EdocInvoice, type EdocItem, type EdocShipTo, type EdocTransport
} from '@shared/gst/edocs'
import { computeGst, supplyTypeFor } from '@shared/gst/calc'
import { toUqc } from '@shared/gst/uqc'
import { descendantIdsByName } from './masters'
import { outwardDebitNoteIds } from './gst'
import { writeAudit } from './audit'
import { companyExportsDir } from '../paths'
import { IN_BOOKS, NOT_DELETED } from './vouchers'

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
  const outwardDbn = outwardDebitNoteIds(db, from, to)
  return db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date, vt.kind AS kind, p.name AS partyName, p.gstin AS partyGstin,
              COALESCE(t.total, 0) AS total, v.vehicle_no AS vehicleNo, v.irn, v.ewb_no AS ewbNo,
              EXISTS(SELECT 1 FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id
                     WHERE il.voucher_id = v.id AND si.hsn IS NOT NULL) AS hasHsn,
              EXISTS(SELECT 1 FROM inventory_lines il2 WHERE il2.voucher_id = v.id AND il2.qty_milli != 0) AS hasGoods
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN (SELECT voucher_id, SUM(amount) AS total FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id) t
         ON t.voucher_id = v.id
       WHERE vt.kind IN (${kindPlaceholders}) AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(...EDOC_KINDS, from, to)
    .map((r: any) => {
      const { kind, hasGoods, ...rest } = r
      const docType = docTypeFor(kind)
      const isOutwardDbn = docType === 'DBN' && outwardDbn.has(r.voucherId)
      const ewbReason =
        docType === 'CRN'
          ? 'Credit note — e-way bills accompany goods movement'
          : docType === 'DBN' && !isOutwardDbn
            ? 'Purchase-side debit note'
            : !hasGoods
              ? 'Services only — no goods movement'
              : r.total <= EWB_THRESHOLD_PAISE
                ? 'At or below ₹50,000 — per-bill export overrides'
                : null
      return { ...rest, docType, hasHsn: !!r.hasHsn, outwardDbn: isOutwardDbn, ewbReason }
    }) as EdocListRow[]
}

// ---------- voucher transport (migration 013) ----------

interface TransportRow {
  voucher_id: number; trans_mode: string | null; trans_distance: number | null
  transporter_id: string | null; transporter_name: string | null
  trans_doc_no: string | null; trans_doc_date: string | null
  vehicle_no: string | null; vehicle_type: string | null
  ship_to_name: string | null; ship_to_gstin: string | null
  ship_to_addr1: string | null; ship_to_addr2: string | null
  ship_to_place: string | null; ship_to_pincode: string | null; ship_to_state: string | null
}

const mapTransport = (r: TransportRow): VoucherTransport => ({
  voucherId: r.voucher_id,
  transMode: r.trans_mode,
  transDistanceKm: r.trans_distance,
  transporterId: r.transporter_id,
  transporterName: r.transporter_name,
  transDocNo: r.trans_doc_no,
  transDocDate: r.trans_doc_date,
  vehicleNo: r.vehicle_no,
  vehicleType: r.vehicle_type,
  shipToName: r.ship_to_name,
  shipToGstin: r.ship_to_gstin,
  shipToAddr1: r.ship_to_addr1,
  shipToAddr2: r.ship_to_addr2,
  shipToPlace: r.ship_to_place,
  shipToPincode: r.ship_to_pincode,
  shipToState: r.ship_to_state
})

export function getTransport(db: DB, voucherId: number): VoucherTransport | null {
  const row = db.prepare('SELECT * FROM voucher_transport WHERE voucher_id = ?').get(voucherId) as TransportRow | undefined
  return row ? mapTransport(row) : null
}

export function setTransport(db: DB, voucherId: number, input: VoucherTransportInput): VoucherTransport {
  const exists = db.prepare(`SELECT id FROM vouchers WHERE id = ?`).get(voucherId)
  if (!exists) throw new Error('Voucher not found')
  const before = getTransport(db, voucherId)
  db.prepare(
    `INSERT INTO voucher_transport (
       voucher_id, trans_mode, trans_distance, transporter_id, transporter_name,
       trans_doc_no, trans_doc_date, vehicle_no, vehicle_type,
       ship_to_name, ship_to_gstin, ship_to_addr1, ship_to_addr2,
       ship_to_place, ship_to_pincode, ship_to_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(voucher_id) DO UPDATE SET
       trans_mode = excluded.trans_mode, trans_distance = excluded.trans_distance,
       transporter_id = excluded.transporter_id, transporter_name = excluded.transporter_name,
       trans_doc_no = excluded.trans_doc_no, trans_doc_date = excluded.trans_doc_date,
       vehicle_no = excluded.vehicle_no, vehicle_type = excluded.vehicle_type,
       ship_to_name = excluded.ship_to_name, ship_to_gstin = excluded.ship_to_gstin,
       ship_to_addr1 = excluded.ship_to_addr1, ship_to_addr2 = excluded.ship_to_addr2,
       ship_to_place = excluded.ship_to_place, ship_to_pincode = excluded.ship_to_pincode,
       ship_to_state = excluded.ship_to_state`
  ).run(
    voucherId, input.transMode, input.transDistanceKm, input.transporterId, input.transporterName,
    input.transDocNo, input.transDocDate, input.vehicleNo, input.vehicleType,
    input.shipToName, input.shipToGstin, input.shipToAddr1, input.shipToAddr2,
    input.shipToPlace, input.shipToPincode, input.shipToState
  )
  const after = getTransport(db, voucherId)!
  writeAudit(db, 'voucher', voucherId, 'update', { transport: before }, { transport: after })
  return after
}

// ---------- extraction ----------

/** Assemble full e-doc invoices (items, party, transport, ship-to) for the sales vouchers in a period. */
export function extractEdocInvoices(db: DB, company: CompanyInfo, from: string, to: string, voucherId?: number): EdocInvoice[] {
  const kindPlaceholders = EDOC_KINDS.map(() => '?').join(', ')
  const vouchers = db
    .prepare(
      `SELECT v.id, v.number, v.date, vt.kind AS kind, v.reference,
              v.transporter_id AS transporterId, v.vehicle_no AS vehicleNo,
              v.transport_distance AS distanceKm, v.pos_override AS posOverride, v.irn,
              p.name AS partyName, p.gstin AS partyGstin, p.state_code AS partyState, p.address AS partyAddress,
              p.export_type AS partyExportType,
              t.trans_mode, t.trans_distance, t.transporter_id AS tTransporterId, t.transporter_name,
              t.trans_doc_no, t.trans_doc_date, t.vehicle_no AS tVehicleNo, t.vehicle_type,
              t.ship_to_name, t.ship_to_gstin, t.ship_to_addr1, t.ship_to_addr2,
              t.ship_to_place, t.ship_to_pincode, t.ship_to_state
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN voucher_transport t ON t.voucher_id = v.id
       WHERE vt.kind IN (${kindPlaceholders}) AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.id = ?) AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(...EDOC_KINDS, from, to, voucherId ?? null, voucherId ?? null) as {
      id: number; number: string; date: string; kind: 'sales' | 'credit_note' | 'debit_note'; reference: string | null
      transporterId: string | null; vehicleNo: string | null; distanceKm: number | null
      posOverride: string | null; irn: string | null
      partyName: string | null; partyGstin: string | null; partyState: string | null; partyAddress: string | null
      partyExportType: string | null
      trans_mode: string | null; trans_distance: number | null; tTransporterId: string | null
      transporter_name: string | null; trans_doc_no: string | null; trans_doc_date: string | null
      tVehicleNo: string | null; vehicle_type: string | null
      ship_to_name: string | null; ship_to_gstin: string | null; ship_to_addr1: string | null
      ship_to_addr2: string | null; ship_to_place: string | null; ship_to_pincode: string | null
      ship_to_state: string | null
    }[]

  const salesGroupIds = descendantIdsByName(db, ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'])

  const invStmt = db.prepare(
    `SELECT il.qty_milli AS qtyMilli, il.rate_paise AS ratePaise, il.amount,
            si.name, si.hsn, si.gst_rate AS gstRate, si.cess_rate AS cessRate, si.barcode, u.uqc
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
  // Original invoice for a note's RefDtls.PrecDocDtls: match voucher.reference against a
  // sales voucher number (null-safe — omitted when it doesn't resolve).
  const refStmt = db.prepare(
    `SELECT v.number, v.date FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
     WHERE vt.kind = 'sales' AND v.number = ? AND ${NOT_DELETED} ORDER BY v.date DESC LIMIT 1`
  )

  return vouchers.map((v) => {
    const pos = v.posOverride ?? v.partyState ?? company.stateCode
    const supply = supplyTypeFor(company.stateCode, pos)
    const rawItems = invStmt.all(v.id) as {
      qtyMilli: number; ratePaise: number; amount: number
      name: string; hsn: string | null; gstRate: number | null; cessRate: number | null; barcode: string | null; uqc: string
    }[]
    let items: EdocItem[] = rawItems.map((item) => {
      const rate = item.gstRate ?? 0
      const cessRate = item.cessRate ?? 0
      const g = computeGst(item.amount, rate, supply, cessRate)
      const mapped = toUqc(item.uqc)
      return {
        name: item.name,
        hsn: item.hsn ?? '',
        qtyMilli: item.qtyMilli,
        uqc: mapped.fallback ? item.uqc : mapped.uqc,
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
    // Service invoices book no inventory lines — build items from the income-side ledger
    // lines instead (SAC from the ledger's HSN, IsServc Y) so ItemList is never empty.
    if (items.length === 0) {
      const salesSide = v.kind === 'credit_note' ? 'dr' : 'cr'
      const lines = lineStmt.all(v.id) as {
        amount: number; drCr: 'dr' | 'cr'; groupId: number; gstRate: number | null; hsn: string | null; name: string
      }[]
      items = lines
        .filter((l) => l.drCr === salesSide && salesGroupIds.has(l.groupId))
        .map((l) => {
          const rate = l.gstRate ?? 0
          const g = computeGst(l.amount, rate, supply, 0)
          return {
            name: l.name,
            hsn: l.hsn ?? '',
            qtyMilli: 0,
            uqc: 'OTH',
            unitPricePaise: l.amount,
            taxablePaise: l.amount,
            rate,
            cessRate: 0,
            cgst: g.cgst,
            sgst: g.sgst,
            igst: g.igst,
            cess: g.cess,
            isService: true,
            barcode: null
          }
        })
    }
    const taxable = items.reduce((s, i) => s + i.taxablePaise, 0)
    const cgst = items.reduce((s, i) => s + i.cgst, 0)
    const sgst = items.reduce((s, i) => s + i.sgst, 0)
    const igst = items.reduce((s, i) => s + i.igst, 0)
    const cess = items.reduce((s, i) => s + i.cess, 0)
    const total = (totalStmt.get(v.id) as { t: number }).t

    const transport: EdocTransport | null =
      v.trans_mode || v.trans_doc_no || v.trans_doc_date || v.transporter_name || v.vehicle_type
        ? {
            mode: v.trans_mode,
            docNo: v.trans_doc_no,
            docDate: v.trans_doc_date,
            transporterName: v.transporter_name,
            vehicleType: v.vehicle_type
          }
        : null
    const shipTo: EdocShipTo | null =
      v.ship_to_name || v.ship_to_addr1 || v.ship_to_pincode || v.ship_to_state
        ? {
            name: v.ship_to_name,
            gstin: v.ship_to_gstin,
            addr1: v.ship_to_addr1,
            addr2: v.ship_to_addr2,
            place: v.ship_to_place,
            pincode: v.ship_to_pincode,
            state: v.ship_to_state
          }
        : null

    let precedingDoc: { invNo: string; invDate: string } | null = null
    if ((v.kind === 'credit_note' || v.kind === 'debit_note') && v.reference) {
      const orig = refStmt.get(v.reference.trim()) as { number: string; date: string } | undefined
      if (orig) precedingDoc = { invNo: orig.number, invDate: orig.date }
    }

    return {
      voucherId: v.id,
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
      // Transport-modal values win over the legacy voucher columns.
      transporterId: v.tTransporterId ?? v.transporterId,
      vehicleNo: v.tVehicleNo ?? v.vehicleNo,
      distanceKm: v.trans_distance ?? v.distanceKm,
      transport,
      shipTo,
      precedingDoc,
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

// ---------- e-way bill export (per-bill + combined) ----------

export interface EwbSkipped {
  number: string
  reason: string
}

export interface EwbExportResult {
  /** Combined bulk file (all eligible bills in one billLists). */
  path: string
  /** Folder holding one valid single-bill bulk file per voucher. */
  dir: string
  count: number
  skipped: EwbSkipped[]
}

const safeFileName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-')

/**
 * EWB-eligible invoices for a period: sales + OUTWARD debit notes that move goods, above the
 * ₹50,000 threshold unless overridden. Credit notes never get e-way bills, and the NIC bulk
 * docType enum has no DBN — outward debit notes export as docType 'OTH'.
 */
function ewbInvoicesFor(
  db: DB, company: CompanyInfo, from: string, to: string,
  opts: { voucherIds?: number[]; includeBelowThreshold?: boolean }
): { eligible: EdocInvoice[]; skipped: EwbSkipped[] } {
  const outwardDbn = outwardDebitNoteIds(db, from, to)
  const all = extractEdocInvoices(db, company, from, to)

  const eligible: EdocInvoice[] = []
  const skipped: EwbSkipped[] = []
  for (const inv of all) {
    if (opts.voucherIds && (inv.voucherId == null || !opts.voucherIds.includes(inv.voucherId))) continue
    if (inv.docType === 'CRN') {
      skipped.push({ number: inv.number, reason: 'Credit note — e-way bills accompany goods movement' })
      continue
    }
    if (inv.docType === 'DBN' && (inv.voucherId == null || !outwardDbn.has(inv.voucherId))) {
      skipped.push({ number: inv.number, reason: 'Purchase-side debit note' })
      continue
    }
    const elig = ewbEligibility(inv, opts.includeBelowThreshold ?? false)
    if (!elig.eligible) {
      skipped.push({ number: inv.number, reason: elig.reason! })
      continue
    }
    const issues = ewbIssues(inv, edocCompany(company))
    if (issues.length) {
      skipped.push({ number: inv.number, reason: issues.join('; ') })
      continue
    }
    // The NIC bulk docType enum has no DBN — outward debit notes export as 'OTH'.
    eligible.push(inv.docType === 'DBN' ? ({ ...inv, docType: 'OTH' as unknown as EdocInvoice['docType'] }) : inv)
  }
  return { eligible, skipped }
}

/**
 * Write the period's e-way bills: ONE combined bulk file (as before) AND one single-bill
 * bulk file per voucher under exports/ewb/<period>/ — the NIC bulk converter accepts
 * single-row files, and per-bill files let each consignment be uploaded independently.
 */
export function exportEwb(
  db: DB, company: CompanyInfo, slug: string, from: string, to: string, period: string,
  opts: { voucherIds?: number[]; includeBelowThreshold?: boolean } = {}
): EwbExportResult {
  const { eligible, skipped } = ewbInvoicesFor(db, company, from, to, opts)
  const comp = edocCompany(company)

  const combined = buildEwbJson(eligible, comp)
  const path = join(companyExportsDir(slug), `ewaybill-${period}.json`)
  writeFileSync(path, JSON.stringify(combined, null, 2))

  const dir = join(companyExportsDir(slug), 'ewb', period)
  mkdirSync(dir, { recursive: true })
  for (const inv of eligible) {
    const single = buildEwbJson([inv], comp)
    writeFileSync(join(dir, `ewb-${safeFileName(inv.number)}.json`), JSON.stringify(single, null, 2))
  }

  return { path, dir, count: eligible.length, skipped }
}

/** Single-voucher EWB JSON (the per-row button): throws with the blocking reasons when the
 *  bill can't be generated, otherwise writes a one-entry bulk file and returns its path. */
export function ewbJsonForVoucher(db: DB, company: CompanyInfo, slug: string, voucherId: number): { path: string } {
  const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!inv) throw new Error('Voucher not found')
  const elig = ewbEligibility(inv, true) // explicit per-bill request overrides the threshold
  if (!elig.eligible) throw new Error(elig.reason!)
  const issues = ewbIssues(inv, edocCompany(company))
  if (issues.length) throw new Error(issues.join('; '))
  const json = buildEwbJson([inv], edocCompany(company))
  const dir = join(companyExportsDir(slug), 'ewb')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `ewb-${safeFileName(inv.number)}.json`)
  writeFileSync(path, JSON.stringify(json, null, 2))
  return { path }
}

// ---------- e-invoice round-off validation (G6 #33) ----------

export interface RoundOffIssue {
  voucherId: number
  number: string
  roundOff: number
  /** Non-item, non-tax, non-party ledger lines that explain the residue. */
  lines: string[]
}

/**
 * |roundOff| beyond ₹1 means the invoice total includes ledger lines the e-invoice can't
 * represent (freight, discounts booked as bare ledger lines, …) — surfaced per voucher with
 * the offending line names instead of silently landing in RndOffAmt (audit D11).
 */
export function einvoiceRoundOffIssues(db: DB, company: CompanyInfo, from: string, to: string): RoundOffIssue[] {
  const invoices = extractEdocInvoices(db, company, from, to)
  const lineStmt = db.prepare(
    `SELECT l.name, l.tax_type AS taxType, l.group_id AS groupId, vl.ledger_id AS ledgerId
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ?`
  )
  const partyStmt = db.prepare('SELECT party_ledger_id AS p FROM vouchers WHERE id = ?')
  const salesGroupIds = descendantIdsByName(db, ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'])

  const issues: RoundOffIssue[] = []
  for (const inv of invoices) {
    if (inv.voucherId == null || Math.abs(inv.roundOff) <= 100) continue
    const partyId = (partyStmt.get(inv.voucherId) as { p: number | null }).p
    const lines = (lineStmt.all(inv.voucherId) as { name: string; taxType: string | null; groupId: number; ledgerId: number }[])
      .filter((l) => l.taxType === null && !salesGroupIds.has(l.groupId) && l.ledgerId !== partyId)
      .filter((l) => l.name.toLowerCase() !== 'round off')
      .map((l) => l.name)
    issues.push({ voucherId: inv.voucherId, number: inv.number, roundOff: inv.roundOff, lines: [...new Set(lines)] })
  }
  return issues
}
