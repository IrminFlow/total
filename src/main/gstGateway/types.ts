// The GST gateway's adapter contract (Phase 4). Every provider — the built-in Test GSP, the NIC
// e-invoice client (services/nic.ts) and, later, a real GSP — implements `GstGatewayAdapter`.
// Request and response fields carry the names of the official APIs (NIC IRP v1.03 for e-invoice /
// e-way bill by IRN, the EWB API v1.03 for extend / cancel, the GSTN taxpayer returns API for
// GSTR-1 / 3B / 2B); sources.ts cites each call and lists what was read only second-hand.
//
// Adapters only talk to their portal. They never touch the company DB: the flows in edocFlow.ts /
// returnsFlow.ts validate the books, call the adapter and persist + audit the answer.
import type { GatewayCapabilities, GatewayForm, GatewayProviderId } from '@shared/gstGateway'

/** Why a call failed. `otp_required` = sign in (taxpayer OTP) or ask for the EVC OTP first. */
export type GatewayErrorKind =
  | 'auth'
  | 'otp_required'
  | 'duplicate'
  | 'validation'
  | 'rate_limit'
  | 'not_ready'
  | 'not_supported'
  | 'network'
  | 'config'
  | 'portal'

/** A failure from (or on the way to) a portal: the portal's codes + a user message. NicError
 *  (services/nic.ts) extends it, so a NIC failure is a gateway failure too. */
export class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  readonly codes: string[]
  /** The portal's extra details (e.g. NIC InfoDtls on a duplicate IRN). */
  info?: unknown
  /** Rate limit: when to try again. */
  retryAfterMs?: number
  constructor(message: string, codes: string[] = [], kind: GatewayErrorKind = 'portal', extra: { info?: unknown; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.codes = codes
    this.kind = kind
    if (extra.info !== undefined) this.info = extra.info
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs
  }
}

/** Who is calling: the company's GSTIN and the portal login (the password from the secret store). */
export interface GatewayIdentity {
  gstin: string
  username: string
  password: string
}

/** A GSTN taxpayer session (after the OTP sign-in). */
export interface ReturnsSession {
  authToken: string
  /** ms since epoch. */
  expiresAt: number
}

// ---------- e-invoice / e-way bill (NIC IRP v1.03 field names) ----------

export interface IrnResponse {
  Irn: string
  AckNo: string
  AckDt: string
  SignedInvoice: string | null
  SignedQRCode: string | null
  /** 'ACT' | 'CNL' — only Get IRN details returns it. */
  Status?: string
  EwbNo?: string | null
  EwbDt?: string | null
  EwbValidTill?: string | null
}

export interface IrnCancelRequest { Irn: string; CnlRsn: string; CnlRem: string }
export interface IrnCancelResponse { Irn: string; CancelDate: string }

/** [EWB] request: Irn, Distance, TransMode, TransId, TransName, TransDocDt, TransDocNo, VehNo, VehType. */
export type EwbByIrnRequest = Record<string, unknown> & { Irn: string }
export interface EwbResponse { EwbNo: string; EwbDt: string; EwbValidTill: string }

/** [EXT] EXTENDVALIDITY data. */
export type EwbExtendPayload = Record<string, unknown> & { ewbNo: number }
export interface EwbExtendResponse { ewayBillNo: string; updatedDate: string; validUpto: string }

export interface EwbCancelRequest { ewbNo: number; cancelRsnCode: number; cancelRmrk: string }
export interface EwbCancelResponse { ewayBillNo: string; cancelDate: string }

// ---------- GSTN returns ----------

/** GSTN return status codes as the status call reports them (UNVERIFIED — sources.ts):
 *  P processed, PE processed with errors, ER error, IP in progress. */
export type ReturnStatusCode = 'P' | 'PE' | 'ER' | 'IP'

export interface ReturnStatusResponse {
  status_cd: ReturnStatusCode
  /** Errors of a PE / ER save: [{ error_cd, error_msg }]. */
  error_report: { error_cd: string; error_msg: string }[]
}

export interface FileReturnResponse { ack_num: string; filed_on?: string }

export interface GstGatewayAdapter {
  readonly id: GatewayProviderId
  readonly label: string
  /** True for a simulator: nothing leaves this computer. */
  readonly test: boolean
  readonly capabilities: GatewayCapabilities

  generateIrn(who: GatewayIdentity, invoice: Record<string, unknown>): Promise<IrnResponse>
  getIrn(who: GatewayIdentity, irn: string): Promise<IrnResponse>
  cancelIrn(who: GatewayIdentity, req: IrnCancelRequest): Promise<IrnCancelResponse>
  generateEwbByIrn(who: GatewayIdentity, req: EwbByIrnRequest): Promise<EwbResponse>
  extendEwb(who: GatewayIdentity, req: EwbExtendPayload): Promise<EwbExtendResponse>
  cancelEwb(who: GatewayIdentity, req: EwbCancelRequest): Promise<EwbCancelResponse>

  /** OTPREQUEST: the portal sends an OTP to the taxpayer's registered mobile / e-mail. */
  requestOtp(who: GatewayIdentity): Promise<void>
  /** AUTHTOKEN with that OTP → a session for the returns calls. */
  signIn(who: GatewayIdentity, otp: string): Promise<ReturnsSession>
  /** RETSAVE: the return's JSON (the offline-tool / API format gst.ts builds) → a reference id. */
  saveReturn(who: GatewayIdentity, s: ReturnsSession, form: GatewayForm, retPeriod: string, data: Record<string, unknown>): Promise<{ reference_id: string }>
  /** RETSTATUS of a save. */
  returnStatus(who: GatewayIdentity, s: ReturnsSession, form: GatewayForm, retPeriod: string, referenceId: string): Promise<ReturnStatusResponse>
  /** GSTR-3B offset liability (RETOFFSET) — set the liability off against credit and cash. */
  offsetLiability(who: GatewayIdentity, s: ReturnsSession, retPeriod: string, data: Record<string, unknown>): Promise<{ reference_id: string }>
  /** EVC: the portal sends the filing OTP to the authorised signatory. */
  requestEvcOtp(who: GatewayIdentity, s: ReturnsSession, form: GatewayForm, retPeriod: string): Promise<void>
  /** RETFILE with EVC (PAN + OTP) → the ARN. */
  fileReturn(who: GatewayIdentity, s: ReturnsSession, form: GatewayForm, retPeriod: string, evc: { pan: string; otp: string }): Promise<FileReturnResponse>
  /** GSTR-2B for a month: the JSON (the format parseGstr2b reads). */
  fetchGstr2b(who: GatewayIdentity, s: ReturnsSession, retPeriod: string): Promise<{ json: string }>
}

/** A refusal for a call this provider has no API for. */
export function notSupported(provider: string, what: string): GatewayError {
  return new GatewayError(`${provider} does not offer ${what}.`, [], 'not_supported')
}
