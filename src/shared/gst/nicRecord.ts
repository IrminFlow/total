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
  ewbNo: string | null
  ewbDate: string | null
  ewbValidUpto: string | null
  ewbHistory: EwbEvent[]
}

