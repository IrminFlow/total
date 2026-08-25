import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, VoucherTransport } from '@shared/domain'
import type { EdocListRow } from '@shared/reports'
import type { VoucherTransportInput } from '@shared/schemas'
import {
  buildEInvoiceJson, buildEwbJson, ewbEligibility, ewbIssues, EWB_THRESHOLD_PAISE,
  EWB_INELIGIBILITY_REASON, type EwbIneligibility,
  type EdocCompany, type EdocInvoice, type EdocItem, type EdocShipTo, type EdocTransport
} from '@shared/gst/edocs'
import { computeGst, supplyTypeFor } from '@shared/gst/calc'
import {
  estimateEwayDistanceKm, pinCoordinates, PIN_DISTANCE_DISCLAIMER, type EwayDistanceEstimate
} from '@shared/gst/pinDistance'
import { makeRateResolver } from './itemRates'
import { toUqc } from '@shared/gst/uqc'
import { descendantIdsByName } from './masters'
import { outwardDebitNoteIds } from './gst'
import { writeAudit } from './audit'
import { companyExportsDir } from '../paths'
import { IN_BOOKS, NOT_DELETED } from './vouchers'
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from '@shared/keyset'

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

/** How many e-document rows the period holds — the denominator for a paged view. */
export function countSalesInvoices(db: DB, from: string, to: string): number {
  const kindPlaceholders = EDOC_KINDS.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind IN (${kindPlaceholders}) AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .get(...EDOC_KINDS, from, to) as { n: number }
  return row.n
}

/** The cursor identifying an e-document row, for asking for the page after it. */
export function edocCursor(row: { date: string; voucherId: number }): string {
  return encodeCursor([row.date, row.voucherId])
}

/** Ordering columns, and therefore the cursor's shape. `v.id` is the tiebreak: a day's invoices
 *  all share a date, and a cursor of date alone would repeat or skip the rest of that day. */
const EDOC_KEY = ['v.date', 'v.id'] as const

/**
 * The period's e-invoice / e-way-bill worklist.
 *
 * Paged, and two-phase, for the same reason the Day Book is. This used to be one statement with a
 * derived table that summed EVERY voucher line in the database and two correlated EXISTS per row,
 * returning every sales document in the period unbounded. On a book with 85,840 vouchers the
 * screen never finished at all — it was the one screen in the sweep that did not come back inside
 * sixty seconds. Phase one takes the page's ids off the date index; phase two totals and inspects
 * exactly those.
 *
 * The other lane fixed the same 13.8-second screen by folding the two correlated EXISTS over
 * `inventory_lines` into one grouped LEFT JOIN, and said in its own comment that pagination was
 * this lane's to design. Both cures are not needed and the grouped pass is the wrong one once the
 * page is bounded: it groups the WHOLE period to answer a question about `limit` rows, while the
 * EXISTS below now run once per row of one page. So the page won, and the LEFT JOIN went.
 */
export function listSalesInvoices(
  db: DB,
  from: string,
  to: string,
  opts: { limit?: number; after?: string | null } = {}
): EdocListRow[] {
  const kindPlaceholders = EDOC_KINDS.map(() => '?').join(', ')
  const cursor = decodeCursor(opts.after)
  const after = cursor ? keysetAfter(EDOC_KEY, cursor) : null
  const params: (string | number)[] = [...EDOC_KINDS, from, to, ...(after?.params ?? [])]
  if (opts.limit != null) params.push(opts.limit)
  const ids = db
    .prepare(
      `SELECT v.id AS voucherId, v.date
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind IN (${kindPlaceholders}) AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}${after ? ` AND ${after.sql}` : ''}
       ORDER BY ${keysetOrderBy(EDOC_KEY)}
       ${opts.limit != null ? 'LIMIT ?' : ''}`
    )
    .all(...params) as { voucherId: number; date: string }[]
  if (ids.length === 0) return []

  // The outward-debit-note set is a property of the period, not of the page — but it is small
  // (debit notes are rare) and computing it per page is cheaper than carrying state.
  const outwardDbn = outwardDebitNoteIds(db, from, to)
  const idJson = JSON.stringify(ids.map((r) => r.voucherId))
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date, vt.kind AS kind, p.name AS partyName, p.gstin AS partyGstin,
              COALESCE(t.total, 0) AS total, v.vehicle_no AS vehicleNo, v.irn, v.ewb_no AS ewbNo,
              EXISTS(SELECT 1 FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id
                     WHERE il.voucher_id = v.id AND si.hsn IS NOT NULL) AS hasHsn,
              EXISTS(SELECT 1 FROM inventory_lines il2 WHERE il2.voucher_id = v.id AND il2.qty_milli != 0) AS hasGoods
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN (
         SELECT voucher_id, SUM(amount) AS total FROM voucher_lines
         WHERE dr_cr = 'dr' AND voucher_id IN (SELECT value FROM json_each(?))
         GROUP BY voucher_id
       ) t ON t.voucher_id = v.id
       WHERE v.id IN (SELECT value FROM json_each(?)) AND ${IN_BOOKS}
       ORDER BY ${keysetOrderBy(EDOC_KEY)}`
    )
    .all(idJson, idJson) as Record<string, unknown>[]

  return rows.map((r) => {
    const { kind, hasGoods, ...rest } = r as { kind: string; hasGoods: number; voucherId: number; total: number }
    const docType = docTypeFor(kind)
    const isOutwardDbn = docType === 'DBN' && outwardDbn.has(r.voucherId as number)
    // The CODE, not the sentence. `ewbReason: string` shipped the same sixty-character English
    // string once per row — 44,000 identical copies across the wire for one screen — and it also
    // put a user-facing sentence in the service layer. The renderer maps the code through
    // EWB_INELIGIBILITY_REASON / _SHORT in @shared/gst/edocs.
    const ewbReasonCode: EwbIneligibility | null =
      docType === 'CRN'
        ? 'credit_note'
        : docType === 'DBN' && !isOutwardDbn
          ? 'purchase_dbn'
          : !hasGoods
            ? 'services_only'
            : (r.total as number) <= EWB_THRESHOLD_PAISE
              ? 'below_threshold'
              : null
    return { ...rest, docType, hasHsn: !!r.hasHsn, outwardDbn: isOutwardDbn, ewbReasonCode }
  }) as unknown as EdocListRow[]
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
  // Joined to vouchers so transport on a binned voucher reads as absent (house NOT_DELETED rule).
  const row = db
    .prepare(
      `SELECT t.* FROM voucher_transport t JOIN vouchers v ON v.id = t.voucher_id
       WHERE t.voucher_id = ? AND ${NOT_DELETED}`
    )
    .get(voucherId) as TransportRow | undefined
  return row ? mapTransport(row) : null
}

export function setTransport(db: DB, voucherId: number, input: VoucherTransportInput): VoucherTransport {
  const exists = db.prepare(`SELECT id FROM vouchers v WHERE id = ? AND ${NOT_DELETED}`).get(voucherId)
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

// ---------- e-way bill distance estimate (roadmap D-96) ----------

/**
 * What the PIN-code estimator offers for one voucher. Deliberately an OFFER and never a write.
 *
 * The e-way bill's distance field decides how long the bill stays valid (one day per 200 km of
 * the declared distance, broadly). An understated distance expires the consignment while it is
 * still on the road, which is a detained vehicle and a penalty — so an approximate figure must
 * never arrive in that field on its own. This returns a number to look at; storing it is a
 * separate, explicit `setTransport` call the user makes after reading the disclaimer.
 *
 * WHERE THE PIN CODES COME FROM — the destination PIN is stored (voucher_transport.ship_to_pincode,
 * the ship-to address on the transport modal). The DESPATCH PIN IS NOT STORED ANYWHERE: the
 * company's own address is a single free-text field with no PIN column, and the party ledger
 * has a state code but no PIN. Rather than parse six digits out of an address line and present a
 * guess as the despatch point, the despatch PIN is always supplied by the caller — the user
 * types it. See the report for D-96.
 */
export interface EwayDistanceOffer {
  fromPin: string | null
  toPin: string | null
  /** Where the destination PIN came from. 'ship_to' = the stored ship-to address. */
  toPinSource: 'ship_to' | 'typed' | null
  /** Null when either PIN cannot be resolved honestly — an unknown PIN offers nothing at all. */
  estimate: EwayDistanceEstimate | null
  /** Printed verbatim beside any figure this produces. */
  disclaimer: string
  /** What the voucher's distance field holds right now. This call never changes it. */
  storedKm: number | null
  /** Why there is no estimate, when there is none. */
  reason: string | null
}

/**
 * Offer an estimated distance for a voucher's e-way bill. Reads; never writes.
 *
 * `opts.toPin` overrides the stored ship-to PIN (the consignment can go somewhere the ship-to
 * address does not describe). Either PIN being unresolvable yields `estimate: null` and a reason
 * — never a fallback figure, because a wrong distance offered confidently is the failure this
 * whole path exists to avoid.
 */
export function estimateTransportDistance(
  db: DB,
  voucherId: number,
  opts: { fromPin?: string | null; toPin?: string | null } = {}
): EwayDistanceOffer {
  const stored = getTransport(db, voucherId)
  const clean = (v: string | null | undefined): string | null => {
    const t = (v ?? '').trim()
    return t === '' ? null : t
  }
  const fromPin = clean(opts.fromPin)
  const typedTo = clean(opts.toPin)
  const shipToPin = clean(stored?.shipToPincode)
  const toPin = typedTo ?? shipToPin
  const toPinSource: EwayDistanceOffer['toPinSource'] =
    toPin === null ? null : typedTo !== null ? 'typed' : 'ship_to'

  const base = {
    fromPin,
    toPin,
    toPinSource,
    disclaimer: PIN_DISTANCE_DISCLAIMER,
    storedKm: stored?.transDistanceKm ?? null
  }

  if (!fromPin || !toPin) {
    return {
      ...base,
      estimate: null,
      reason: !fromPin && !toPin
        ? 'Enter the despatch and delivery PIN codes. Neither is stored: the company address has no PIN field, and this document has no ship-to PIN.'
        : !fromPin
          ? 'Enter the despatch PIN code — the company address is free text and holds no PIN.'
          : 'Enter the delivery PIN code, or set a ship-to PIN on this document.'
    }
  }

  const estimate = estimateEwayDistanceKm(fromPin, toPin)
  if (!estimate) {
    // pinCoordinates() answers null for a malformed PIN, an unallotted postal circle, and the
    // 9x Army Postal Service range. All three mean the same thing to a user: type the distance.
    const bad = [
      ...(pinCoordinates(fromPin) ? [] : [`despatch PIN ${fromPin}`]),
      ...(pinCoordinates(toPin) ? [] : [`delivery PIN ${toPin}`])
    ].join(' and ')
    return {
      ...base,
      estimate: null,
      reason: `No estimate: ${bad} is not a PIN this app can place. Enter the distance the e-way bill portal gives you.`
    }
  }
  return { ...base, estimate, reason: null }
}

// ---------- extraction ----------

/** Assemble full e-doc invoices (items, party, transport, ship-to) for the sales vouchers in a period. */
export function extractEdocInvoices(db: DB, company: CompanyInfo, from: string, to: string, voucherId?: number): EdocInvoice[] {
  const kindPlaceholders = EDOC_KINDS.map(() => '?').join(', ')
  const vouchers = db
    .prepare(
      `SELECT v.id, v.number, v.date, vt.kind AS kind, v.reference,
              v.is_optional AS isOptional,
              v.transporter_id AS transporterId, v.vehicle_no AS vehicleNo,
              v.transport_distance AS distanceKm, v.pos_override AS posOverride, v.irn,
              p.name AS partyName, p.gstin AS partyGstin, p.state_code AS partyState, p.address AS partyAddress,
              p.export_type AS partyExportType, COALESCE(p.rcm, 0) AS partyRcm,
              t.trans_mode, t.trans_distance, t.transporter_id AS tTransporterId, t.transporter_name,
              t.trans_doc_no, t.trans_doc_date, t.vehicle_no AS tVehicleNo, t.vehicle_type,
              t.ship_to_name, t.ship_to_gstin, t.ship_to_addr1, t.ship_to_addr2,
              t.ship_to_place, t.ship_to_pincode, t.ship_to_state
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       LEFT JOIN voucher_transport t ON t.voucher_id = v.id
       WHERE vt.kind IN (${kindPlaceholders}) AND v.date BETWEEN ? AND ?
         AND (? IS NULL OR v.id = ?) AND ${voucherId != null ? NOT_DELETED : IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(...EDOC_KINDS, from, to, voucherId ?? null, voucherId ?? null) as {
      id: number; number: string; date: string; kind: 'sales' | 'credit_note' | 'debit_note'; reference: string | null
      isOptional: number
      transporterId: string | null; vehicleNo: string | null; distanceKm: number | null
      posOverride: string | null; irn: string | null
      partyName: string | null; partyGstin: string | null; partyState: string | null; partyAddress: string | null
      partyExportType: string | null; partyRcm: number
      trans_mode: string | null; trans_distance: number | null; tTransporterId: string | null
      transporter_name: string | null; trans_doc_no: string | null; trans_doc_date: string | null
      tVehicleNo: string | null; vehicle_type: string | null
      ship_to_name: string | null; ship_to_gstin: string | null; ship_to_addr1: string | null
      ship_to_addr2: string | null; ship_to_place: string | null; ship_to_pincode: string | null
      ship_to_state: string | null
    }[]

  const salesGroupIds = descendantIdsByName(db, ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'])

  // An IRN is signed against the tax the invoice actually carried, so the rate is the one in
  // force on the invoice's own date, not today's master rate (D-92).
  const rateOnDate = makeRateResolver(db)

  const invStmt = db.prepare(
    `SELECT il.stock_item_id AS stockItemId, il.qty_milli AS qtyMilli, il.rate_paise AS ratePaise, il.amount,
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
    const supTyp = supTypFor(v.partyExportType, v.partyState)
    const pos = v.posOverride ?? v.partyState ?? company.stateCode
    // SEZ/export supplies are ALWAYS inter-state (sec 7(5)(b) IGST Act): a same-state SEZ
    // unit must be billed IGST — the IRP rejects SEZWP/SEZWOP payloads carrying CGST/SGST.
    const supply = supTyp !== 'B2B' ? 'inter' : supplyTypeFor(company.stateCode, pos)
    const rawItems = invStmt.all(v.id) as {
      stockItemId: number; qtyMilli: number; ratePaise: number; amount: number
      name: string; hsn: string | null; gstRate: number | null; cessRate: number | null; barcode: string | null; uqc: string
    }[]
    let items: EdocItem[] = rawItems.map((item) => {
      const dated = rateOnDate?.(item.stockItemId, v.date) ?? null
      const rate = dated ? dated.ratePercent : (item.gstRate ?? 0)
      const cessRate = dated ? dated.cessPercent : (item.cessRate ?? 0)
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
      isOptional: !!v.isOptional,
      supTyp,
      rchrg: !!v.partyRcm,
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
  // Purchase-side debit notes (goods returned to a supplier) are NOT outward documents —
  // e-invoicing one would register a spurious IRN and auto-populate portal GSTR-1 with
  // output tax the books don't contain. Same outwardDebitNoteIds split as every sibling
  // path (listSalesInvoices, ewbInvoicesFor, GSTR-1 extraction).
  const outwardDbn = outwardDebitNoteIds(db, from, to)
  // A GSTIN is required for domestic/SEZ buyers, but exports legitimately have none — the
  // builder maps those to BuyerDtls.Gstin 'URP', so don't drop them here.
  const invoices = extractEdocInvoices(db, company, from, to).filter(
    (i) =>
      (i.docType !== 'DBN' || (i.voucherId != null && outwardDbn.has(i.voucherId))) &&
      (i.partyGstin || i.supTyp === 'EXPWP' || i.supTyp === 'EXPWOP')
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

/** Per-bill file name. Sanitising voucher numbers can collide ('INV/25-26/001' and
 *  'INV-25-26/001' both sanitise to 'INV-25-26-001', and sales/DBN series share numbers), so
 *  the unique voucher id is always part of the name — a later bill must never silently
 *  overwrite an earlier one in the NIC bulk-upload folder. */
const ewbFileName = (inv: EdocInvoice): string =>
  `ewb-${safeFileName(inv.number)}-v${inv.voucherId ?? 0}.json`

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
      skipped.push({ number: inv.number, reason: EWB_INELIGIBILITY_REASON.credit_note })
      continue
    }
    if (inv.docType === 'DBN' && (inv.voucherId == null || !outwardDbn.has(inv.voucherId))) {
      skipped.push({ number: inv.number, reason: EWB_INELIGIBILITY_REASON.purchase_dbn })
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
    writeFileSync(join(dir, ewbFileName(inv)), JSON.stringify(single, null, 2))
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
  const path = join(dir, ewbFileName(inv))
  writeFileSync(path, JSON.stringify(json, null, 2))
  return { path }
}

/**
 * The exact JSON an export would write, without writing anything.
 *
 * Deliberately built by calling the same builders the export paths call, rather than by reading
 * a file back: a preview that reads the last export shows the last export, which is precisely
 * the wrong thing when someone is checking what is about to happen.
 *
 * Nothing here throws for an ineligible bill the way `ewbJsonForVoucher` does -- the point of
 * looking is often to find out why a payload is not what you expected, and refusing to show it
 * defeats that. The blocking issues are returned alongside instead.
 */
export function previewJson(
  db: DB,
  company: CompanyInfo,
  kind: 'einvoice' | 'ewb',
  from: string,
  to: string,
  opts: { voucherId?: number; includeBelowThreshold?: boolean } = {}
): { json: unknown; count: number; issues: string[] } {
  const comp = edocCompany(company)

  if (kind === 'einvoice') {
    const outwardDbn = outwardDebitNoteIds(db, from, to)
    const invoices = extractEdocInvoices(db, company, from, to, opts.voucherId).filter(
      (i) =>
        (i.docType !== 'DBN' || (i.voucherId != null && outwardDbn.has(i.voucherId))) &&
        (i.partyGstin || i.supTyp === 'EXPWP' || i.supTyp === 'EXPWOP')
    )
    return { json: buildEInvoiceJson(invoices, comp), count: invoices.length, issues: [] }
  }

  if (opts.voucherId != null) {
    const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', opts.voucherId)
    if (!inv) return { json: null, count: 0, issues: ['Voucher not found'] }
    const elig = ewbEligibility(inv, true)
    const issues = [...(elig.eligible ? [] : [elig.reason!]), ...ewbIssues(inv, comp)]
    return { json: buildEwbJson([inv], comp), count: 1, issues }
  }

  const { eligible, skipped } = ewbInvoicesFor(db, company, from, to, {
    includeBelowThreshold: opts.includeBelowThreshold
  })
  return {
    json: buildEwbJson(eligible, comp),
    count: eligible.length,
    issues: skipped.map((s) => `${s.number}: ${s.reason}`)
  }
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
