/**
 * The stored NIC e-invoice / e-way bill record of one voucher (migration "NIC e-document columns")
 * as the renderer sees it, plus the PURE time-window rules of the IRP / EWB system.
 *
 * Sources (read 2026-10-17; the client in services/nic.ts has never run against the real portal):
 *  [GEN]  https://einv-apisandbox.nic.in/version1.03/generate-irn.html — response AckNo, AckDt, Irn,
 *         SignedInvoice, SignedQRCode, EwbNo, EwbDt, EwbValidTill
 *  [CNL]  https://einv-apisandbox.nic.in/version1.03/cancel-irn.html — Irn, CnlRsn (1 Duplicate,
 *         2 Data entry mistake, 3 Order Cancelled, 4 Others), CnlRem (max 100); "IRN can be
 *         cancelled within 24 hours of generation"; not while an active e-way bill exists
 *  [CEWB] https://einv-apisandbox.nic.in/version1.03/cancel-eway-bill.html — action CANEWB,
 *         ewbNo, cancelRsnCode, cancelRmrk (max 50); "within 24 hours"
 *  [EXT]  https://docs.ewaybillgst.gov.in/apidocs/version1.03/extend-validity.html — action
 *         EXTENDVALIDITY; "between 8 hours before expiry time and 8 hours after expiry time"
 *  [MASTER] https://docs.ewaybillgst.gov.in/apidocs/master-codes-list.html — cancel reason codes
 *         (1 Duplicate, 2 Order Cancelled, 3 Data Entry mistake, 4 Others) and extension reasons
 *         (1 Natural Calamity, 2 Law and Order, 4 Transshipment, 5 Accident, 99 Others)
 */

/** One e-way bill event, kept in vouchers.ewb_history (a JSON array, oldest first). */
export interface EwbEvent {
  action: 'generate' | 'extend' | 'cancel'
  ewbNo: string
  /** The portal's timestamp for the event (EwbDt / updatedDate / cancelDate), verbatim. */
  at: string
  /** Valid-upto after the event ('' = Part A only / none). */
  validUpto?: string
  /** Extend: [MASTER] extension reason code; cancel: our reason key. */
  reason?: string | number
  remark?: string
  /** Extend only: where the goods are now and what is left. */
  fromPlace?: string
  fromStateCode?: number
  fromPincode?: number
  remainingDistanceKm?: number
  transMode?: string
  vehicleNo?: string
}


export interface NicRecord {
  voucherId: number
  number: string
  date: string
  irn: string | null
  ackNo: string | null
  ackDate: string | null
  signedInvoice: string | null
  signedQrCode: string | null
  /** The JWS payloads, decoded for reading (not verified). */
  signedInvoiceData: Record<string, unknown> | null
  signedQrData: Record<string, unknown> | null
  /** A recorded Cancel IRN ([CNL] CancelDate, our reason key, CnlRem); the IRN above is kept. */
  irnCancelledAt: string | null
  irnCancelReason: NicCancelReason | null
  irnCancelRemark: string | null
  /** irn present and not cancelled. */
  irnLive: boolean
  ewbNo: string | null
  ewbDate: string | null
  ewbValidUpto: string | null
  ewbHistory: EwbEvent[]
  /** The windows as of the server's clock when read. */
  cancelIrn: NicWindow
  cancelEwb: NicWindow
  extendEwb: NicWindow
}


// ---------- cancel state + time windows ----------

/** Why a document is being cancelled. The two systems number these DIFFERENTLY:
 *  IRN [CNL] CnlRsn: 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others;
 *  EWB [MASTER] "Reason Codes": 1 Duplicate, 2 Order Cancelled, 3 Data Entry mistake, 4 Others. */
export const NIC_CANCEL_REASONS = ['duplicate', 'data_entry_mistake', 'order_cancelled', 'other'] as const
export type NicCancelReason = (typeof NIC_CANCEL_REASONS)[number]
export const NIC_CANCEL_REASON_LABEL: Record<NicCancelReason, string> = {
  duplicate: 'Duplicate',
  data_entry_mistake: 'Data entry mistake',
  order_cancelled: 'Order cancelled',
  other: 'Others'
}
/** [CNL] CnlRem: "Remarks", max length 100. [CEWB] cancelRmrk: Text(50). */
export const IRN_CANCEL_REMARK_MAX = 100
export const EWB_CANCEL_REMARK_MAX = 50

/** [MASTER] "Reasons for extension of validity". */
export const EWB_EXTEND_REASONS = [
  { code: 1, label: 'Natural calamity' },
  { code: 2, label: 'Law and order situation' },
  { code: 4, label: 'Transshipment' },
  { code: 5, label: 'Accident' },
  { code: 99, label: 'Others' }
] as const
export type EwbExtendReasonCode = (typeof EWB_EXTEND_REASONS)[number]['code']
/** [MASTER] transport modes; 5 = in transit (extension only). */
export const EWB_EXTEND_MODES = [
  { code: '1', label: 'Road' },
  { code: '2', label: 'Rail' },
  { code: '3', label: 'Air' },
  { code: '4', label: 'Ship' },
  { code: '5', label: 'In transit' }
] as const

/** What Extend validity sends ([EXT] request: extnRsnCode, extnRemarks, fromPlace, fromState,
 *  fromPincode, remainingDistance, transMode, vehicleNo / transDocNo + transDocDate, transitType). */
export interface EwbExtendRequest {
  reasonCode: EwbExtendReasonCode
  remarks: string
  fromPlace: string
  fromStateCode: number
  fromPincode: number
  remainingDistanceKm: number
  transMode: '1' | '2' | '3' | '4' | '5'
  vehicleNo?: string
  transDocNo?: string
  /** ISO date. */
  transDocDate?: string
  transitType?: 'R' | 'W' | 'O'
  addressLine1?: string
}

const HOUR_MS = 3600 * 1000
/** [CNL] / [CEWB]: "within 24 hours". */
export const CANCEL_WINDOW_MS = 24 * HOUR_MS
/** [EXT]: "between 8 hours before expiry time and 8 hours after expiry time". */
export const EXTEND_WINDOW_MS = 8 * HOUR_MS
const IST_OFFSET_MS = 330 * 60 * 1000

/**
 * A portal timestamp → ms since epoch, read as IST (UTC+05:30 — UNVERIFIED, the documents give
 * only the formats). Two shapes occur: the e-invoice API's 'yyyy-MM-dd HH:mm:ss' (AckDt, CancelDate,
 * EwbValidTill) and the EWB API's 'dd/MM/yyyy hh:mm:ss AM' (cancelDate, validUpto after an extension).
 */
export function nicTimestampMs(s: unknown): number | null {
  if (typeof s !== 'string') return null
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s)
  if (m) {
    const [, y, mo, d, h, mi, se] = m.map(Number) as [number, number, number, number, number, number, number]
    return Date.UTC(y, mo - 1, d, h, mi, se) - IST_OFFSET_MS
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?: ?([AP]M))?/i.exec(s)
  if (m) {
    const [d, mo, y, h0, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
    const ampm = m[7]?.toUpperCase()
    const h = ampm ? (h0 % 12) + (ampm === 'PM' ? 12 : 0) : h0
    return Date.UTC(y, mo - 1, d, h, mi, se) - IST_OFFSET_MS
  }
  return null
}

/** ms → 'dd Mon yyyy, hh:mm' in IST, for the screen. */
export function istLabel(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS)
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} IST`
}

/** Whether an action is open now, and why not. `opensAt` / `closesAt` are ms (null = unknown). */
export interface NicWindow {
  allowed: boolean
  /** Plain reason when not allowed. */
  reason: string | null
  opensAt: number | null
  closesAt: number | null
}

const shut = (reason: string, opensAt: number | null = null, closesAt: number | null = null): NicWindow => ({ allowed: false, reason, opensAt, closesAt })

/** [CNL]: an IRN can be cancelled within 24 hours of its AckDt, and not while an e-way bill is active
 *  (error 2230). An unreadable AckDt leaves it to the portal (allowed, no deadline shown). */
export function irnCancelWindow(r: { irn: string | null; irnCancelledAt: string | null; ackDate: string | null; ewbNo: string | null }, now: number): NicWindow {
  if (!r.irn) return shut('This voucher has no IRN')
  if (r.irnCancelledAt) return shut('The IRN is already cancelled')
  const ack = nicTimestampMs(r.ackDate)
  const closesAt = ack === null ? null : ack + CANCEL_WINDOW_MS
  if (closesAt !== null && now > closesAt) {
    return shut(`The 24-hour window to cancel this IRN closed on ${istLabel(closesAt)} — issue a credit note instead`, ack, closesAt)
  }
  if (r.ewbNo) return shut('Cancel the e-way bill first — an IRN with an active e-way bill cannot be cancelled', ack, closesAt)
  return { allowed: true, reason: null, opensAt: ack, closesAt }
}

/** [CEWB]: an e-way bill can be cancelled within 24 hours of its generation (EwbDt). */
export function ewbCancelWindow(r: { ewbNo: string | null; ewbDate: string | null }, now: number): NicWindow {
  if (!r.ewbNo) return shut('This voucher has no e-way bill')
  const at = nicTimestampMs(r.ewbDate)
  const closesAt = at === null ? null : at + CANCEL_WINDOW_MS
  if (closesAt !== null && now > closesAt) return shut(`The 24-hour window to cancel this e-way bill closed on ${istLabel(closesAt)}`, at, closesAt)
  return { allowed: true, reason: null, opensAt: at, closesAt }
}

/** [EXT]: validity can be extended between 8 hours before and 8 hours after it expires. A Part-A-only
 *  bill (no validity) can't be extended. */
export function ewbExtendWindow(r: { ewbNo: string | null; ewbValidUpto: string | null }, now: number): NicWindow {
  if (!r.ewbNo) return shut('This voucher has no e-way bill')
  const until = nicTimestampMs(r.ewbValidUpto)
  if (until === null) return shut('This e-way bill has no validity yet (Part B not filled) — nothing to extend')
  const opensAt = until - EXTEND_WINDOW_MS
  const closesAt = until + EXTEND_WINDOW_MS
  if (now < opensAt) return shut(`Validity can be extended from ${istLabel(opensAt)} (8 hours before it expires)`, opensAt, closesAt)
  if (now > closesAt) return shut(`The extension window closed on ${istLabel(closesAt)} (8 hours after expiry)`, opensAt, closesAt)
  return { allowed: true, reason: null, opensAt, closesAt }
}

/** Shown on the e-Invoice details screen: what the client follows but no one has confirmed against
 *  the live portal. */
export const NIC_UNVERIFIED: readonly string[] = [
  'The whole live client: built to the published API pages, never run against the real NIC portal or sandbox.',
  'Timestamps (AckDt, CancelDate, EwbDt, validity) are read as IST; the pages give only the formats.',
  'The 24-hour cancel windows are counted from AckDt (IRN) and EwbDt (e-way bill); the error text 4055 says "from Part B entry".',
  'CnlRem (IRN cancel remark) is sent as typed, max 100; whether the IRP requires it is not stated.',
  'EXTENDVALIDITY through the IRP route (/ewaybillapi/v1.03/ewayapi): the IRP pages document only CANEWB there.',
  'The error code for an extension outside the ±8 h window (the fake answers the generic 240).',
  'Whether ewayapi `data` is AES over the JSON or over Base64(JSON) (the client encrypts the JSON and reads either).',
  'The signed QR / signed invoice are stored and printed as returned; their signature is not verified here.'
]
