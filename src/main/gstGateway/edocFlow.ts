// IRN and e-way bill flows (WP 3.5, folded behind the gateway in Phase 4). One implementation for
// every adapter: validate the voucher against the books and the published rules locally (refuse
// before any call), call the adapter, then persist the portal's answer and audit it.
//
// Where the answer goes is the `EdocStore`:
//   VOUCHER_STORE  the voucher's own columns (irn, irn_ack_no, …, ewb_history) — what prints, the
//                  edit lock and the e-documents list read. Used by REAL portals only (the NIC
//                  client, services/nic.ts — behaviour unchanged, nicContract.dbtest.ts).
//   TEST_STORE     gst_gateway_test_edocs, the same columns per voucher — the Test GSP's simulated
//                  IRNs / e-way bills never reach a print, never lock a voucher and never mix with a
//                  real IRN.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { buildEInvoiceJson, buildEwbByIrnPayload, type EdocCompany } from '@shared/gst/edocs'
import { einvoiceIssues } from '@shared/gst/einvoiceSchema'
import {
  ewbCancelWindow, ewbExtendWindow, irnCancelWindow, IRN_CANCEL_REMARK_MAX, EWB_CANCEL_REMARK_MAX,
  type EwbEvent, type EwbExtendRequest, type NicCancelReason, type NicRecord
} from '@shared/gst/nicRecord'
import { outwardDebitNoteIds } from '../services/gst'
import { extractEdocInvoices, goodsMovedOnChallan, movedOnChallanReason } from '../services/edocs'
import { writeAudit } from '../services/audit'
import { log } from '../log'
import { GatewayError, type GatewayIdentity, type GstGatewayAdapter } from './types'

// ---------- where the answers are stored ----------

export interface EdocRow {
  irn: string | null; irn_ack_no: string | null; irn_ack_date: string | null
  irn_signed_invoice: string | null; irn_signed_qr: string | null
  irn_cancelled_at: string | null; irn_cancel_reason: string | null; irn_cancel_remark: string | null
  ewb_no: string | null; ewb_valid_upto: string | null; ewb_date: string | null; ewb_history: string | null
  number: string; date: string; deleted_at: string | null
}
type EdocColumn = Exclude<keyof EdocRow, 'number' | 'date' | 'deleted_at'>

export interface EdocStore {
  readonly name: 'voucher' | 'test'
  read(db: DB, voucherId: number): EdocRow | undefined
  write(db: DB, voucherId: number, set: Partial<Record<EdocColumn, string | null>>): void
  audit(db: DB, voucherId: number, before: Record<string, unknown>, after: Record<string, unknown>): void
}

const EDOC_COLUMNS = `irn, irn_ack_no, irn_ack_date, irn_signed_invoice, irn_signed_qr, irn_cancelled_at, irn_cancel_reason,
  irn_cancel_remark, ewb_no, ewb_valid_upto, ewb_date, ewb_history`
const COLUMN_NAMES = new Set<string>(EDOC_COLUMNS.split(',').map((c) => c.trim()))

function setClause(set: Partial<Record<EdocColumn, string | null>>): { sql: string; values: (string | null)[] } {
  const keys = Object.keys(set)
  for (const k of keys) if (!COLUMN_NAMES.has(k)) throw new Error(`not an e-document column: ${k}`)
  return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => set[k as EdocColumn] ?? null) }
}

export const VOUCHER_STORE: EdocStore = {
  name: 'voucher',
  read: (db, id) => db.prepare(`SELECT ${EDOC_COLUMNS}, number, date, deleted_at FROM vouchers WHERE id = ?`).get(id) as EdocRow | undefined,
  write: (db, id, set) => {
    const { sql, values } = setClause(set)
    db.prepare(`UPDATE vouchers SET ${sql} WHERE id = ?`).run(...values, id)
  },
  audit: (db, id, before, after) => writeAudit(db, 'voucher', id, 'update', before, after)
}

export const TEST_STORE: EdocStore = {
  name: 'test',
  read: (db, id) => {
    const v = db.prepare('SELECT number, date, deleted_at FROM vouchers WHERE id = ?').get(id) as Pick<EdocRow, 'number' | 'date' | 'deleted_at'> | undefined
    if (!v) return undefined
    const t = db.prepare(`SELECT ${EDOC_COLUMNS} FROM gst_gateway_test_edocs WHERE voucher_id = ?`).get(id) as Omit<EdocRow, 'number' | 'date' | 'deleted_at'> | undefined
    const empty = Object.fromEntries([...COLUMN_NAMES].map((c) => [c, null])) as Omit<EdocRow, 'number' | 'date' | 'deleted_at'>
    return { ...empty, ...t, ...v }
  },
  write: (db, id, set) => {
    db.prepare('INSERT INTO gst_gateway_test_edocs (voucher_id) VALUES (?) ON CONFLICT(voucher_id) DO NOTHING').run(id)
    const { sql, values } = setClause(set)
    db.prepare(`UPDATE gst_gateway_test_edocs SET ${sql}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE voucher_id = ?`).run(...values, id)
  },
  // A simulated answer is not a change to the voucher: audited under the gateway's own entity.
  audit: (db, id, before, after) => writeAudit(db, 'gst_gateway_edoc', id, 'update', { ...before, test: true }, { ...after, test: true })
}

// ---------- helpers ----------

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const irnLive = (v: Pick<EdocRow, 'irn' | 'irn_cancelled_at'>): boolean => !!v.irn && !v.irn_cancelled_at
const cfg = (message: string, codes: string[] = []): GatewayError => new GatewayError(message, codes, 'config')

export function readEwbHistory(raw: string | null): EwbEvent[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as EwbEvent[]) : []
  } catch {
    return []
  }
}
const withEvent = (raw: string | null, e: EwbEvent): string => JSON.stringify([...readEwbHistory(raw), e])

function voucherFor(db: DB, store: EdocStore, voucherId: number): EdocRow {
  const v = store.read(db, voucherId)
  if (!v) throw cfg('Voucher not found')
  if (v.deleted_at) throw cfg('This voucher is in the bin — restore it first')
  return v
}

/** 'yyyy-MM-dd HH:mm:ss' in IST. */
export function istNow(ms: number): string {
  return new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/** The e-document facts of a voucher as audited (signed copies by presence only). */
function auditFacts(v: EdocRow): Record<string, unknown> {
  return {
    irn: v.irn, irnAckNo: v.irn_ack_no, irnAckDate: v.irn_ack_date, signedInvoice: !!v.irn_signed_invoice, signedQrCode: !!v.irn_signed_qr,
    irnCancelledAt: v.irn_cancelled_at, irnCancelReason: v.irn_cancel_reason, irnCancelRemark: v.irn_cancel_remark,
    ewbNo: v.ewb_no, ewbDate: v.ewb_date, ewbValidUpto: v.ewb_valid_upto
  }
}

export interface EdocCall {
  adapter: GstGatewayAdapter
  store: EdocStore
  who: GatewayIdentity
  now: () => number
}

// ---------- IRN ----------

export interface IrnResult {
  irn: string
  ackNo: string
  ackDate: string
  /** The signed JWS strings ([GEN] SignedInvoice / SignedQRCode). For an adopted duplicate (2150)
   *  they come from Get IRN details ([GET], 3 days) when it answers. */
  signedQrCode: string | null
  signedInvoice: string | null
  /** True when the portal answered 2150 (duplicate) and the existing IRN was adopted. */
  recovered: boolean
}

/** Generate an IRN for one sales voucher (or outward credit / debit note) and store it. */
export async function generateIrnFlow(db: DB, company: CompanyInfo, voucherId: number, c: EdocCall): Promise<IrnResult> {
  const v = voucherFor(db, c.store, voucherId)
  // A cancelled IRN does not block a new one here (e.g. after renumbering); the portal itself
  // refuses a second IRN for the same document number ([GEN] validation 12, error 2278).
  if (irnLive(v)) throw cfg('This invoice already has an IRN')

  const [invoice] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!invoice) throw cfg('Only sales invoices and credit / debit notes in the books can be e-invoiced')
  // A purchase-side debit note (goods returned to a supplier) is not an outward document.
  if (invoice.docType === 'DBN' && !outwardDebitNoteIds(db, invoice.date, invoice.date).has(voucherId)) {
    throw cfg('This debit note is a purchase return — only outward documents are e-invoiced')
  }
  const isExport = invoice.supTyp === 'EXPWP' || invoice.supTyp === 'EXPWOP'
  // [GEN] validation 7: "B2C transactions not accepted for IRN". Exports go with Gstin URP.
  if (!invoice.partyGstin && !isExport) throw cfg('e-Invoice needs a registered (GSTIN) buyer, or an export party')

  const edocCompany: EdocCompany = { name: company.name, gstin: c.who.gstin, stateCode: company.stateCode, address: company.address }
  const [payload] = buildEInvoiceJson([invoice], edocCompany)
  // Pre-flight against the published schema + validations: refuse locally what the IRP rejects.
  const issues = einvoiceIssues(payload)
  if (issues.length) {
    throw cfg(`This invoice would be rejected by NIC: ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}`)
  }

  let data: { Irn: unknown; AckNo: unknown; AckDt: unknown; SignedInvoice?: unknown; SignedQRCode?: unknown; EwbNo?: unknown; EwbDt?: unknown; EwbValidTill?: unknown }
  let recovered = false
  try {
    data = await c.adapter.generateIrn(c.who, payload as unknown as Record<string, unknown>)
  } catch (e) {
    // 2150 Duplicate IRN: the portal already holds an IRN for this supplier + FY + type + number —
    // by definition this document (e.g. an earlier attempt whose response was lost). Adopt it when
    // InfoDtls carries it (shape UNVERIFIED: [{InfCd:'DUPIRN', Desc:{AckNo, AckDt, Irn}}]).
    const info = (e as { info?: unknown }).info
    const dup = e instanceof GatewayError && e.codes.includes('2150') && Array.isArray(info)
      ? (info as { InfCd?: string; Desc?: { Irn?: string; AckNo?: unknown; AckDt?: unknown } }[]).find((x) => x.InfCd === 'DUPIRN')?.Desc
      : undefined
    if (!dup?.Irn) throw e
    data = { Irn: dup.Irn, AckNo: dup.AckNo, AckDt: dup.AckDt }
    recovered = true
  }
  const irn = str(data.Irn)
  if (!/^[0-9a-f]{64}$/i.test(irn)) throw new GatewayError('The portal returned no valid IRN')
  const ackNo = str(data.AckNo)
  const ackDate = str(data.AckDt)
  // [GEN]: EwbNo/EwbDt/EwbValidTill come back when e-way details rode along.
  const ewbNo = data.EwbNo ? str(data.EwbNo) : null
  const ewbValid = data.EwbValidTill ? str(data.EwbValidTill) : null
  const ewbDate = data.EwbDt ? str(data.EwbDt) : null
  let signedInvoice = data.SignedInvoice ? str(data.SignedInvoice) : null
  let signedQrCode = data.SignedQRCode ? str(data.SignedQRCode) : null
  if (recovered && (!signedInvoice || !signedQrCode)) {
    // The duplicate answer carries no signed copies; Get IRN details returns them within 3 days
    // of generation ([GET]). Best effort — the IRN is adopted either way.
    try {
      const got = await c.adapter.getIrn(c.who, irn)
      if (str(got.Irn) === irn) {
        signedInvoice = got.SignedInvoice ? str(got.SignedInvoice) : signedInvoice
        signedQrCode = got.SignedQRCode ? str(got.SignedQRCode) : signedQrCode
      }
    } catch (e) {
      log('warn', 'nic-irn-signed-copies-unavailable', { voucherId, codes: e instanceof GatewayError ? e.codes : [] })
    }
  }
  const before = {
    irn: v.irn, irnAckNo: v.irn_ack_no, irnAckDate: v.irn_ack_date, ewbNo: v.ewb_no, ewbValidUpto: v.ewb_valid_upto,
    ...(v.irn_cancelled_at ? { irnCancelledAt: v.irn_cancelled_at, irnCancelReason: v.irn_cancel_reason, irnCancelRemark: v.irn_cancel_remark } : {})
  }
  db.transaction(() => {
    c.store.write(db, voucherId, {
      irn, irn_ack_no: ackNo, irn_ack_date: ackDate, irn_signed_invoice: signedInvoice, irn_signed_qr: signedQrCode,
      irn_cancelled_at: null, irn_cancel_reason: null, irn_cancel_remark: null
    })
    if (ewbNo) {
      c.store.write(db, voucherId, {
        ewb_no: ewbNo, ewb_valid_upto: ewbValid, ewb_date: ewbDate,
        ewb_history: withEvent(v.ewb_history, { action: 'generate', ewbNo, at: ewbDate ?? '', validUpto: ewbValid ?? '' })
      })
    }
    // The signed copies are kept but only their presence is audited.
    c.store.audit(db, voucherId, before, {
      irn, irnAckNo: ackNo, irnAckDate: ackDate, ewbNo: ewbNo ?? v.ewb_no, ewbValidUpto: ewbNo ? ewbValid : v.ewb_valid_upto,
      signedInvoice: !!signedInvoice, signedQrCode: !!signedQrCode, ...(recovered ? { recoveredDuplicate: true } : {})
    })
  })()
  log('info', 'nic-irn-generated', { voucherId, ackNo, recovered, store: c.store.name })
  return { irn, ackNo, ackDate, signedQrCode, signedInvoice, recovered }
}

// ---------- e-way bill ----------

export interface EwbResult {
  ewbNo: string
  /** EwbValidTill verbatim; '' for a Part-A-only bill (no validity yet). */
  validUpto: string
}

/** Generate an e-way bill against an existing IRN ([EWB]); transport from the voucher. */
export async function generateEwbFlow(db: DB, company: CompanyInfo, voucherId: number, c: EdocCall): Promise<EwbResult> {
  const v = voucherFor(db, c.store, voucherId)
  if (v.irn && v.irn_cancelled_at) throw cfg('This invoice\'s IRN was cancelled — an e-way bill can no longer be generated against it')
  if (!v.irn) throw cfg('Generate the IRN first — the e-way bill hangs off it')
  if (v.ewb_no) throw cfg('This invoice already has an e-way bill')
  const [invoice] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!invoice) throw cfg('Voucher not found')
  // [EWB] validations 2/3: no EWB for credit/debit notes or services-only documents.
  if (invoice.docType === 'CRN' || invoice.docType === 'DBN') throw cfg('E-way bills are not generated for credit or debit notes')
  if (!invoice.items.some((i) => !i.isService)) throw cfg('E-way bills need at least one goods line — this invoice is services only')
  // WP 2.5b: goods that all travelled on a delivery challan need no second EWB.
  const moved = goodsMovedOnChallan(db, [voucherId]).get(voucherId)
  if (moved) throw cfg(`${movedOnChallanReason(moved)} — that e-way bill covers the movement`)
  if (!invoice.vehicleNo && !invoice.transporterId && !invoice.transport?.docNo) {
    throw cfg('Add a vehicle number, transport document or transporter ID in the voucher\'s Transport details first')
  }
  const payload = buildEwbByIrnPayload(v.irn, invoice)
  const data = await c.adapter.generateEwbByIrn(c.who, payload as unknown as Record<string, unknown> & { Irn: string })
  const ewbNo = str(data.EwbNo)
  if (!/^\d{12}$/.test(ewbNo)) throw new GatewayError('The portal returned no valid e-way bill number')
  const validUpto = str(data.EwbValidTill)
  const ewbDate = str(data.EwbDt)
  const before = { ewbNo: v.ewb_no, ewbValidUpto: v.ewb_valid_upto }
  db.transaction(() => {
    c.store.write(db, voucherId, {
      ewb_no: ewbNo, ewb_valid_upto: validUpto || null, ewb_date: ewbDate || null,
      ewb_history: withEvent(v.ewb_history, { action: 'generate', ewbNo, at: ewbDate, validUpto })
    })
    c.store.audit(db, voucherId, before, { ewbNo, ewbValidUpto: validUpto || null, ewbDate: ewbDate || null })
  })()
  log('info', 'nic-ewb-generated', { voucherId, ewbNo, store: c.store.name })
  return { ewbNo, validUpto }
}

const IRN_CANCEL_CODE: Record<NicCancelReason, string> = { duplicate: '1', data_entry_mistake: '2', order_cancelled: '3', other: '4' }
const EWB_CANCEL_CODE: Record<NicCancelReason, number> = { duplicate: 1, order_cancelled: 2, data_entry_mistake: 3, other: 4 }

/**
 * Cancel a voucher's IRN ([CNL] {Irn, CnlRsn, CnlRem}; within 24 h of AckDt, not while an e-way
 * bill is active) — refused locally, before any call, outside that window or with a live e-way
 * bill. The IRN, ack and signed copies are KEPT and the cancel recorded, audited.
 */
export async function cancelIrnFlow(db: DB, voucherId: number, reason: NicCancelReason, remark: string, c: EdocCall): Promise<{ irn: string; cancelDate: string }> {
  const v = voucherFor(db, c.store, voucherId)
  if (!v.irn) throw cfg('This invoice has no IRN to cancel')
  if (v.irn_cancelled_at) throw cfg('This IRN is already cancelled')
  if (v.ewb_no) throw cfg('Cancel the e-way bill first — an IRN with an active e-way bill cannot be cancelled', ['2230'])
  const now = c.now()
  const win = irnCancelWindow({ irn: v.irn, irnCancelledAt: null, ackDate: v.irn_ack_date, ewbNo: null }, now)
  if (!win.allowed) throw cfg(win.reason!, ['2270'])
  const rem = remark.trim().slice(0, IRN_CANCEL_REMARK_MAX)
  const data = await c.adapter.cancelIrn(c.who, { Irn: v.irn, CnlRsn: IRN_CANCEL_CODE[reason], CnlRem: rem })
  // [CNL] response: Irn, CancelDate. A missing CancelDate (UNVERIFIED) is stamped with our clock in IST.
  const cancelDate = str(data.CancelDate) || istNow(now)
  const before = auditFacts(v)
  db.transaction(() => {
    c.store.write(db, voucherId, { irn_cancelled_at: cancelDate, irn_cancel_reason: reason, irn_cancel_remark: rem || null })
    c.store.audit(db, voucherId, before, { ...before, irnCancelledAt: cancelDate, irnCancelReason: reason, irnCancelRemark: rem || null })
  })()
  log('info', 'nic-irn-cancelled', { voucherId, store: c.store.name })
  return { irn: str(data.Irn) || v.irn, cancelDate }
}

/**
 * Cancel a voucher's e-way bill ([CEWB] CANEWB {ewbNo, cancelRsnCode, cancelRmrk}; within 24 h of
 * EwbDt). On success the LIVE columns are cleared and the cancel goes into ewb_history; audited.
 */
export async function cancelEwbFlow(db: DB, voucherId: number, reason: NicCancelReason, remark: string, c: EdocCall): Promise<{ ewbNo: string; cancelDate: string }> {
  const v = voucherFor(db, c.store, voucherId)
  if (!v.ewb_no) throw cfg('This voucher has no e-way bill to cancel')
  const now = c.now()
  const win = ewbCancelWindow({ ewbNo: v.ewb_no, ewbDate: v.ewb_date }, now)
  if (!win.allowed) throw cfg(win.reason!, ['4055'])
  const rem = remark.trim().slice(0, EWB_CANCEL_REMARK_MAX)
  const data = await c.adapter.cancelEwb(c.who, { ewbNo: Number(v.ewb_no), cancelRsnCode: EWB_CANCEL_CODE[reason], cancelRmrk: rem })
  const cancelDate = str(data.cancelDate) || istNow(now)
  const ewbNo = v.ewb_no
  const before = auditFacts(v)
  db.transaction(() => {
    c.store.write(db, voucherId, {
      ewb_no: null, ewb_valid_upto: null, ewb_date: null,
      ewb_history: withEvent(v.ewb_history, { action: 'cancel', ewbNo, at: cancelDate, reason, ...(rem ? { remark: rem } : {}) })
    })
    c.store.audit(db, voucherId, before,
      { ...before, ewbNo: null, ewbDate: null, ewbValidUpto: null, cancelledEwbNo: ewbNo, ewbCancelDate: cancelDate, ewbCancelReason: reason, ewbCancelRemark: rem || null })
  })()
  log('info', 'nic-ewb-cancelled', { voucherId, store: c.store.name })
  return { ewbNo: str(data.ewayBillNo) || ewbNo, cancelDate }
}

/**
 * Extend an e-way bill's validity ([EXT] EXTENDVALIDITY; between 8 h before and 8 h after expiry).
 * Refused locally outside the window. Stores the new valid-upto and an 'extend' event; audited.
 */
export async function extendEwbFlow(db: DB, voucherId: number, input: EwbExtendRequest, c: EdocCall): Promise<{ ewbNo: string; validUpto: string }> {
  const v = voucherFor(db, c.store, voucherId)
  if (!v.ewb_no) throw cfg('This voucher has no e-way bill to extend')
  if (input.transMode === '1' && !input.vehicleNo) throw cfg('Road transport needs a vehicle number', ['4011'])
  if ((input.transMode === '2' || input.transMode === '3' || input.transMode === '4') && !input.transDocNo) {
    throw cfg('Rail, air or ship transport needs the transport document number', ['4012'])
  }
  if (!/^\d{6}$/.test(String(input.fromPincode))) throw cfg('The current location needs a 6-digit PIN code')
  const win = ewbExtendWindow({ ewbNo: v.ewb_no, ewbValidUpto: v.ewb_valid_upto }, c.now())
  if (!win.allowed) throw cfg(win.reason!)
  const inTransit = input.transMode === '5'
  const iso = input.transDocDate?.split('-')
  const vehicleNo = input.vehicleNo ? input.vehicleNo.replace(/[\s-]/g, '').toUpperCase() : ''
  const data = await c.adapter.extendEwb(c.who, {
    ewbNo: Number(v.ewb_no),
    vehicleNo,
    fromPlace: input.fromPlace.slice(0, 50),
    fromState: input.fromStateCode,
    remainingDistance: input.remainingDistanceKm,
    transDocNo: input.transDocNo ?? '',
    transDocDate: iso && iso.length === 3 ? `${iso[2]}/${iso[1]}/${iso[0]}` : '',
    transMode: input.transMode,
    extnRsnCode: input.reasonCode,
    extnRemarks: input.remarks,
    fromPincode: input.fromPincode,
    // [EXT]: modes 1–4 → consignmentStatus 'M' and transitType ''; mode 5 → 'T' with R/W/O.
    consignmentStatus: inTransit ? 'T' : 'M',
    transitType: inTransit ? (input.transitType ?? 'R') : '',
    addressLine1: input.addressLine1 ?? '',
    addressLine2: '',
    addressLine3: ''
  })
  const validUpto = str(data.validUpto)
  const ewbNo = v.ewb_no
  const before = auditFacts(v)
  const event: EwbEvent = {
    action: 'extend', ewbNo, at: str(data.updatedDate), validUpto, reason: input.reasonCode, remark: input.remarks,
    fromPlace: input.fromPlace, fromStateCode: input.fromStateCode, fromPincode: input.fromPincode,
    remainingDistanceKm: input.remainingDistanceKm, transMode: input.transMode, ...(vehicleNo ? { vehicleNo } : {})
  }
  db.transaction(() => {
    c.store.write(db, voucherId, { ewb_valid_upto: validUpto, ewb_history: withEvent(v.ewb_history, event) })
    c.store.audit(db, voucherId, before, { ...before, ewbValidUpto: validUpto, ewbExtension: event })
  })()
  log('info', 'nic-ewb-extended', { voucherId, store: c.store.name })
  return { ewbNo: str(data.ewayBillNo) || ewbNo, validUpto }
}

// ---------- the stored record (read-only; no network) ----------

/** A JWS (header.payload.signature, base64url) → its decoded payload ({ data: "<JSON>", iss }).
 *  The signature is never verified here (that needs the portal's public signing key). */
export function decodeJwsPayload(jws: string | null): Record<string, unknown> | null {
  if (!jws) return null
  const parts = jws.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
    if (typeof payload.data === 'string') {
      try {
        return { ...payload, data: JSON.parse(payload.data) as unknown }
      } catch {
        return payload
      }
    }
    return payload
  } catch {
    return null
  }
}

/** Everything a portal returned for one voucher, as stored. QUERY — writes nothing. */
export function edocRecord(db: DB, store: EdocStore, voucherId: number, now: number = Date.now()): NicRecord {
  const v = store.read(db, voucherId)
  if (!v) throw cfg('Voucher not found')
  return {
    voucherId,
    number: v.number,
    date: v.date,
    irn: v.irn,
    ackNo: v.irn_ack_no,
    ackDate: v.irn_ack_date,
    signedInvoice: v.irn_signed_invoice,
    signedQrCode: v.irn_signed_qr,
    signedInvoiceData: decodeJwsPayload(v.irn_signed_invoice),
    signedQrData: decodeJwsPayload(v.irn_signed_qr),
    irnCancelledAt: v.irn_cancelled_at,
    irnCancelReason: (v.irn_cancel_reason as NicCancelReason | null) ?? null,
    irnCancelRemark: v.irn_cancel_remark,
    irnLive: irnLive(v),
    ewbNo: v.ewb_no,
    ewbDate: v.ewb_date,
    ewbValidUpto: v.ewb_valid_upto,
    ewbHistory: readEwbHistory(v.ewb_history),
    cancelIrn: irnCancelWindow({ irn: v.irn, irnCancelledAt: v.irn_cancelled_at, ackDate: v.irn_ack_date, ewbNo: v.ewb_no }, now),
    cancelEwb: ewbCancelWindow({ ewbNo: v.ewb_no, ewbDate: v.ewb_date }, now),
    extendEwb: ewbExtendWindow({ ewbNo: v.ewb_no, ewbValidUpto: v.ewb_valid_upto }, now)
  }
}
