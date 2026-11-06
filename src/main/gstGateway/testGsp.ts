// The built-in "Test GSP" (Phase 4): a simulator of the GST portals behind the gateway's adapter
// contract. It answers with the official field names and the documented error codes (sources.ts)
// so the whole flow — bill → IRN → e-way bill → GSTR-1 saved and filed → GSTR-2B fetched — runs
// end to end in tests and in the app with NO network. It never sends anything anywhere.
//
// Deterministic: every number it issues is derived from the request (the IRN is the SHA-256 of
// GSTIN + financial year + document type + number, as the IRP defines it — [IRN]); ack numbers,
// e-way bill numbers, reference ids and ARNs are hashes of what identifies them, and every time
// comes from the injected clock. Its "server" memory lives in a TestGspState — in memory, one per
// company for this app session (gstGateway/index.ts), never in the company file: the simulator
// writes nothing to the books (a restart forgets what it issued, like a sandbox reset).
//
// Simulated failures (each also documented on the Settings card):
//   auth          any username / password other than the published test pair → NIC 1008 (e-invoice)
//                 or TEST-AUTH (returns)
//   duplicate IRN the same document again → NIC 2150 with InfoDtls DUPIRN (the existing IRN);
//                 after a cancel → 2278
//   validation    the e-invoice schema checks (SCHEMA), seller GSTIN ≠ the caller (2143), road
//                 without a vehicle (4011), rail / air / ship without a document (4012), an
//                 e-way bill for a note (4010), a save whose JSON names another GSTIN / period
//   windows       cancel IRN after 24 h (2270), with a live e-way bill (2230), cancel EWB after
//                 24 h (4055), Get IRN after 3 days (2283)
//   rate limit    more than `ratePerMinute` calls a minute for one GSTIN → HTTP 429 (TEST-RATE)
//   OTP           returns calls without the OTP sign-in → TEST-OTP-REQUIRED; filing without the
//                 EVC OTP → TEST-EVC-REQUIRED; a wrong OTP → TEST-OTP-INVALID
//   not ready     GSTR-2B for a month before the 14th of the next month → TEST-2B-NOT-READY
import crypto from 'crypto'
import { einvoiceIssues } from '@shared/gst/einvoiceSchema'
import type { GatewayCapabilities, GatewayForm } from '@shared/gstGateway'
import {
  GatewayError, type EwbByIrnRequest, type EwbCancelRequest, type EwbCancelResponse, type EwbExtendPayload, type EwbExtendResponse, type EwbResponse,
  type FileReturnResponse, type GatewayIdentity, type GstGatewayAdapter, type IrnCancelRequest, type IrnCancelResponse, type IrnResponse,
  type ReturnStatusResponse, type ReturnsSession
} from './types'

/** The Test GSP's published test login and OTP (shown on the Settings card in test mode). */
export const TEST_GSP_USERNAME = 'testgsp'
export const TEST_GSP_PASSWORD = 'Test@1234'
export const TEST_GSP_OTP = '575757'
export const TEST_GSP_PAN_EVC_NOTE = 'EVC = the PAN of the GSTIN + the OTP'

/** The simulator's memory ("the portal's database"). Values are JSON-serialisable. */
export interface TestGspState {
  get<T>(kind: string, key: string): T | null
  set(kind: string, key: string, value: unknown): void
}

export function memoryTestGspState(): TestGspState {
  const m = new Map<string, unknown>()
  return {
    get: <T>(kind: string, key: string) => (m.has(`${kind}\u0000${key}`) ? (structuredClone(m.get(`${kind}\u0000${key}`)) as T) : null),
    set: (kind, key, value) => {
      if (value === null || value === undefined) m.delete(`${kind}\u0000${key}`)
      else m.set(`${kind}\u0000${key}`, structuredClone(value))
    }
  }
}

/** A purchase the Test GSP's "suppliers" have filed for a recipient (what its GSTR-2B shows). */
export interface SimulatedInwardDoc {
  supplierGstin: string
  supplierName: string
  kind: 'invoice' | 'credit_note' | 'debit_note'
  number: string
  /** yyyy-MM-dd */
  date: string
  /** paise */
  value: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  reverseCharge: boolean
}

export interface TestGspOptions {
  state?: TestGspState
  now?: () => number
  /** Calls a minute per GSTIN before HTTP 429 (default 120). */
  ratePerMinute?: number
  /** What the recipient's suppliers filed for a month (MMYYYY): the GSTR-2B the simulator returns. */
  inwardFor?: (recipientGstin: string, retPeriod: string) => SimulatedInwardDoc[]
}

const IST_MS = 330 * 60 * 1000
const HOUR = 3600 * 1000
const pad = (n: number): string => String(n).padStart(2, '0')
/** 'yyyy-MM-dd HH:mm:ss' IST ([AUTH] TokenExpiry, [GEN] AckDt). */
export function istStamp(ms: number): string {
  return new Date(ms + IST_MS).toISOString().slice(0, 19).replace('T', ' ')
}
/** 'dd/MM/yyyy hh:mm:ss AM' IST ([CEWB] / [EXT] samples). */
function ewbStamp(ms: number): string {
  const d = new Date(ms + IST_MS)
  const h = d.getUTCHours()
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(h % 12 || 12)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`
}
/** 'dd-MM-yyyy' (GSTN returns dates). */
function gstnDate(ms: number): string {
  const d = new Date(ms + IST_MS)
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`
}
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')
/** `len` decimal digits from a hash (first digit 1–9). */
function digits(seed: string, len: number): string {
  const n = BigInt(`0x${sha(seed)}`)
  const s = (n % 10n ** BigInt(len)).toString().padStart(len, '0')
  return s[0] === '0' ? `1${s.slice(1)}` : s
}
function finYear(dt: string): string {
  const [, m, y] = dt.split('/').map(Number) as [number, number, number]
  const start = m >= 4 ? y : y - 1
  return `${start}-${pad((start + 1) % 100)}`
}
const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
/** A JWS shaped like the IRP's ([GEN]: { data: "<JSON>", iss }) — signed with the Test GSP's own
 *  HMAC key and `kid: TEST-GSP`, so it can never pass for NIC's signature. */
function testJws(data: unknown): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', kid: 'TEST-GSP', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ data: JSON.stringify(data), iss: 'TEST-GSP (simulated, not NIC)' }))
  const sig = crypto.createHmac('sha256', 'total-test-gsp').update(`${head}.${body}`).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${head}.${body}.${sig}`
}
const rupees = (paise: number): number => Math.round(paise) / 100
/** MMYYYY → [year, month]. */
const ym = (p: string): [number, number] => [Number(p.slice(2)), Number(p.slice(0, 2))]
/** dd-MM-yyyy of a yyyy-MM-dd. */
const dashDate = (iso: string): string => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`

interface IrnRec { irn: string; gstin: string; ackNo: string; ackDt: string; createdAt: number; status: 'ACT' | 'CNL'; docTyp: string; signedInvoice: string; signedQr: string; ewbNo: string | null; cancelDate?: string }
interface EwbRec { ewbNo: string; irn: string; gstin: string; createdAt: number; ewbDt: string; validTillMs: number | null; status: 'ACT' | 'CNL'; distance: number }
interface RetRec { saved: Record<string, unknown> | null; referenceId: string | null; statusCalls: number; errors: { error_cd: string; error_msg: string }[]; offset: boolean; arn: string | null; filedOn: string | null }

const CAPABILITIES: GatewayCapabilities = { einvoice: true, ewb: true, gstr1: true, gstr3b: true, gstr3bFile: true, gstr2b: true }

export function createTestGsp(opts: TestGspOptions = {}): GstGatewayAdapter {
  const state = opts.state ?? memoryTestGspState()
  const now = opts.now ?? Date.now
  const limit = opts.ratePerMinute ?? 120
  const calls = new Map<string, number[]>()

  const fail = (code: string, message: string, kind: GatewayError['kind'] = 'validation', extra: { info?: unknown; retryAfterMs?: number } = {}): GatewayError =>
    new GatewayError(`${message} (Test GSP ${code})`, [code], kind, extra)

  /** Every call: the rate limit (sliding minute per GSTIN), then the login. */
  function gate(who: GatewayIdentity, einvoice: boolean): string {
    const gstin = who.gstin.toUpperCase()
    const t = now()
    const recent = (calls.get(gstin) ?? []).filter((x) => t - x < 60_000)
    if (recent.length >= limit) {
      calls.set(gstin, recent)
      const retryAfterMs = 60_000 - (t - recent[0]!)
      throw new GatewayError('Too many requests to the GST portal — wait a minute and try again (Test GSP HTTP 429)', ['TEST-RATE', '429'], 'rate_limit', { retryAfterMs })
    }
    recent.push(t)
    calls.set(gstin, recent)
    const user = who.username || TEST_GSP_USERNAME
    const pass = who.password || TEST_GSP_PASSWORD
    if (user !== TEST_GSP_USERNAME || pass !== TEST_GSP_PASSWORD) {
      throw einvoice
        ? fail('1008', 'Invalid login credentials — the Test GSP accepts only its published test username and password', 'auth')
        : fail('TEST-AUTH', 'Invalid username or password for the GST portal — the Test GSP accepts only its published test login', 'auth')
    }
    return gstin
  }

  const irnRec = (irn: string): IrnRec | null => state.get<IrnRec>('irn', irn)
  const ewbRec = (no: string): EwbRec | null => state.get<EwbRec>('ewb', no)

  function signed(rec: IrnRec): IrnResponse {
    const e = rec.ewbNo ? ewbRec(rec.ewbNo) : null
    return {
      Irn: rec.irn, AckNo: rec.ackNo, AckDt: rec.ackDt, SignedInvoice: rec.signedInvoice, SignedQRCode: rec.signedQr, Status: rec.status,
      EwbNo: e && e.status === 'ACT' ? e.ewbNo : null, EwbDt: e && e.status === 'ACT' ? e.ewbDt : null,
      EwbValidTill: e && e.status === 'ACT' && e.validTillMs !== null ? istStamp(e.validTillMs) : null
    }
  }

  function requireSession(gstin: string, s: ReturnsSession): void {
    const rec = state.get<{ gstin: string; expiresAt: number }>('session', s.authToken)
    if (!rec || rec.gstin !== gstin || now() >= rec.expiresAt) {
      throw fail('TEST-OTP-REQUIRED', 'Sign in to the GST portal with the OTP first', 'otp_required')
    }
  }
  const retKey = (form: GatewayForm, gstin: string, period: string): string => `${form}:${gstin}:${period}`
  const ret = (form: GatewayForm, gstin: string, period: string): RetRec =>
    state.get<RetRec>('ret', retKey(form, gstin, period)) ?? { saved: null, referenceId: null, statusCalls: 0, errors: [], offset: false, arn: null, filedOn: null }

  /** Checks a portal GSTIN's shape (the 15-character layout; the check digit is the app's job). */
  const gstinShape = (g: unknown): boolean => typeof g === 'string' && /^\d{2}[A-Z0-9]{10}\d[A-Z0-9]Z?[A-Z0-9]$/.test(g)

  /** A saved GSTR-1's processing errors (as the portal's error report): recipients whose GSTIN is
   *  not a GSTIN. Everything else is accepted. */
  function gstr1Errors(data: Record<string, unknown>): { error_cd: string; error_msg: string }[] {
    const out: { error_cd: string; error_msg: string }[] = []
    for (const g of Array.isArray(data.b2b) ? (data.b2b as { ctin?: unknown }[]) : []) {
      if (!gstinShape(g.ctin)) out.push({ error_cd: 'TEST-CTIN', error_msg: `Recipient GSTIN ${String(g.ctin)} is not valid` })
    }
    return out
  }

  return {
    id: 'test-gsp',
    label: 'Test GSP (built in — simulates the portal, sends nothing)',
    test: true,
    capabilities: CAPABILITIES,

    async generateIrn(who, invoice) {
      const gstin = gate(who, true)
      const d = invoice as { Version?: string; DocDtls?: { Typ: string; No: string; Dt: string }; SellerDtls?: { Gstin: string }; BuyerDtls?: { Gstin: string }; ValDtls?: { TotInvVal: number }; ItemList?: { HsnCd: string; AssAmt: number }[] }
      const issues = einvoiceIssues(invoice)
      if (issues.length) throw new GatewayError(`The IRP would reject this invoice: ${issues.slice(0, 5).join('; ')} (Test GSP SCHEMA)`, ['SCHEMA'], 'validation')
      if (!d.DocDtls || !d.SellerDtls || !d.ItemList?.length || !d.ValDtls) throw fail('2000', 'Invalid JSON')
      if (d.SellerDtls.Gstin.toUpperCase() !== gstin) throw fail('2143', 'Invoice does not belong to the user GSTIN')
      if (d.BuyerDtls?.Gstin === d.SellerDtls.Gstin) throw fail('2211', 'Supplier and recipient GSTIN should not be the same')
      // [IRN]: SHA-256 of supplier GSTIN + financial year + document type + document number.
      const irn = sha(`${gstin}${finYear(d.DocDtls.Dt)}${d.DocDtls.Typ}${d.DocDtls.No.toUpperCase()}`)
      const existing = irnRec(irn)
      if (existing?.status === 'CNL') throw fail('2278', 'IRN is already generated and is cancelled for this document number')
      if (existing) {
        throw fail('2150', 'Duplicate IRN', 'duplicate', { info: [{ InfCd: 'DUPIRN', Desc: { AckNo: existing.ackNo, AckDt: existing.ackDt, Irn: existing.irn } }] })
      }
      const t = now()
      const ackNo = digits(`ack:${irn}`, 15)
      const ackDt = istStamp(t)
      const main = [...d.ItemList].sort((a, b) => b.AssAmt - a.AssAmt)[0]!
      const rec: IrnRec = {
        irn, gstin, ackNo, ackDt, createdAt: t, status: 'ACT', docTyp: d.DocDtls.Typ, ewbNo: null,
        signedInvoice: testJws({ ...invoice, AckNo: ackNo, AckDt: ackDt, Irn: irn }),
        signedQr: testJws({
          SellerGstin: d.SellerDtls.Gstin, BuyerGstin: d.BuyerDtls?.Gstin, DocNo: d.DocDtls.No, DocTyp: d.DocDtls.Typ, DocDt: d.DocDtls.Dt,
          TotInvVal: d.ValDtls.TotInvVal, ItemCnt: d.ItemList.length, MainHsnCode: main.HsnCd, Irn: irn, IrnDt: ackDt
        })
      }
      state.set('irn', irn, rec)
      return signed(rec)
    },

    async getIrn(who, irn) {
      const gstin = gate(who, true)
      const r = irnRec(irn)
      if (!r || r.gstin !== gstin) throw fail('3001', 'Requested data is not available', 'portal')
      // [GET]: "within three days from the date of generation".
      if (now() - r.createdAt > 72 * HOUR) throw fail('2283', 'IRN details cannot be provided as it is generated more than 3 days prior', 'portal')
      return signed(r)
    },

    async cancelIrn(who, req: IrnCancelRequest): Promise<IrnCancelResponse> {
      const gstin = gate(who, true)
      const r = irnRec(req.Irn)
      if (!r || r.gstin !== gstin) throw fail('3001', 'Requested data is not available', 'portal')
      if (r.status === 'CNL') throw fail('9999', 'Invoice is not active', 'portal')
      if (!['1', '2', '3', '4'].includes(String(req.CnlRsn))) throw fail('2000', 'Invalid cancel reason')
      if ((req.CnlRem ?? '').length > 100) throw fail('2000', 'Cancel remarks too long')
      const e = r.ewbNo ? ewbRec(r.ewbNo) : null
      if (e?.status === 'ACT') throw fail('2230', 'This IRN cannot be cancelled because an e-way bill has been generated')
      if (now() - r.createdAt > 24 * HOUR) throw fail('2270', 'The allowed cancellation time limit is crossed, you cannot cancel the IRN')
      r.status = 'CNL'
      r.cancelDate = istStamp(now())
      state.set('irn', r.irn, r)
      return { Irn: r.irn, CancelDate: r.cancelDate }
    },

    async generateEwbByIrn(who, req: EwbByIrnRequest): Promise<EwbResponse> {
      const gstin = gate(who, true)
      const r = irnRec(req.Irn)
      if (!r || r.gstin !== gstin) throw fail('4003', 'Requested IRN data is not available', 'portal')
      if (r.status !== 'ACT') throw fail('4000', 'Status of the IRN is not active', 'portal')
      if (r.docTyp === 'CRN' || r.docTyp === 'DBN') throw fail('4010', 'E-way bill cannot be generated for debit notes, credit notes and services')
      const existing = r.ewbNo ? ewbRec(r.ewbNo) : null
      if (existing?.status === 'ACT') throw fail('4002', 'E-way bill is already generated for this IRN', 'duplicate')
      const distanceIn = Number(req.Distance)
      if (!Number.isFinite(distanceIn) || distanceIn < 0 || distanceIn > 4000) throw fail('4013', 'The distance between the pincodes given is too high or low')
      const mode = req.TransMode ? String(req.TransMode) : ''
      const partA = !mode && !!req.TransId
      if (!partA) {
        if (mode === '1') {
          if (!req.VehNo) throw fail('4011', 'Vehicle number should be passed in case of transportation mode is Road')
        } else if (mode === '2' || mode === '3' || mode === '4') {
          if (!req.TransDocNo) throw fail('4012', 'The transport document number should be passed for rail, air and ship')
        } else {
          throw fail('4019', 'Provide the transporter ID to generate Part A of the e-way bill')
        }
      }
      const t = now()
      // [EWB] validation 10: distance 0 → the portal's PIN-to-PIN distance (simulated: 100 km).
      const distance = distanceIn === 0 ? 100 : distanceIn
      // Rule 138(10) CGST Rules: one day per 200 km (regular cargo), to 23:59 IST; Part A only: none.
      let validTillMs: number | null = null
      if (!partA) {
        const ist = new Date(t + IST_MS)
        validTillMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + Math.max(1, Math.ceil(distance / 200)), 23, 59, 0) - IST_MS
      }
      // Re-generating after a cancel gives a new number (the cancel count is in the seed).
      const ewbNo = digits(`ewb:${r.irn}:${existing ? existing.ewbNo : ''}`, 12)
      const e: EwbRec = { ewbNo, irn: r.irn, gstin, createdAt: t, ewbDt: istStamp(t), validTillMs, status: 'ACT', distance }
      state.set('ewb', ewbNo, e)
      r.ewbNo = ewbNo
      state.set('irn', r.irn, r)
      return { EwbNo: ewbNo, EwbDt: e.ewbDt, EwbValidTill: validTillMs === null ? '' : istStamp(validTillMs) }
    },

    async extendEwb(who, req: EwbExtendPayload): Promise<EwbExtendResponse> {
      const gstin = gate(who, true)
      const e = ewbRec(String(req.ewbNo))
      if (!e || e.gstin !== gstin || e.status !== 'ACT') throw fail('4005', 'E-way bill details are not found', 'portal')
      for (const k of ['fromPlace', 'fromState', 'fromPincode', 'remainingDistance', 'transMode', 'extnRsnCode', 'extnRemarks']) {
        if (req[k] === undefined || req[k] === null || req[k] === '') throw fail('4006', `Requesting parameter cannot be empty (${k})`)
      }
      if (![1, 2, 4, 5, 99].includes(Number(req.extnRsnCode))) throw fail('4059', 'Invalid reason')
      if (String(req.transMode) === '1' && !req.vehicleNo) throw fail('4011', 'Vehicle number should be passed in case of transportation mode is Road')
      if (Number(req.remainingDistance) > e.distance) throw fail('4013', 'The distance between the pincodes given is too high or low')
      const t = now()
      // [EXT]: between 8 hours before and 8 hours after the expiry (code UNVERIFIED → the generic 240).
      if (e.validTillMs === null || t < e.validTillMs - 8 * HOUR || t > e.validTillMs + 8 * HOUR) throw fail('240', 'Could not complete the request — outside the extension window', 'portal')
      const ist = new Date(e.validTillMs + IST_MS)
      e.validTillMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + Math.max(1, Math.ceil(Number(req.remainingDistance) / 200)), 23, 59, 0) - IST_MS
      state.set('ewb', e.ewbNo, e)
      return { ewayBillNo: e.ewbNo, updatedDate: ewbStamp(t), validUpto: ewbStamp(e.validTillMs) }
    },

    async cancelEwb(who, req: EwbCancelRequest): Promise<EwbCancelResponse> {
      const gstin = gate(who, true)
      const e = ewbRec(String(req.ewbNo))
      if (!e || e.gstin !== gstin || e.status !== 'ACT') throw fail('4057', 'This e-way bill is either not generated by you or cancelled', 'portal')
      if (![1, 2, 3, 4].includes(Number(req.cancelRsnCode))) throw fail('4059', 'Invalid reason')
      if (now() - e.createdAt > 24 * HOUR) throw fail('4055', 'You can cancel the e-way bill within 24 hours')
      e.status = 'CNL'
      state.set('ewb', e.ewbNo, e)
      return { ewayBillNo: e.ewbNo, cancelDate: ewbStamp(now()) }
    },

    async requestOtp(who) {
      const gstin = gate(who, false)
      state.set('otp', gstin, { otp: TEST_GSP_OTP, at: now() })
    },

    async signIn(who, otp) {
      const gstin = gate(who, false)
      const pending = state.get<{ otp: string; at: number }>('otp', gstin)
      if (!pending) throw fail('TEST-OTP-REQUIRED', 'Ask for the sign-in OTP first', 'otp_required')
      // GSTN OTPs are short-lived (UNVERIFIED: 10 minutes simulated).
      if (now() - pending.at > 10 * 60_000) throw fail('TEST-OTP-EXPIRED', 'The OTP has expired — ask for a new one', 'otp_required')
      if (otp !== pending.otp) throw fail('TEST-OTP-INVALID', 'The OTP is not correct', 'auth')
      state.set('otp', gstin, null)
      const authToken = sha(`session:${gstin}:${now()}`).slice(0, 32)
      // Session length UNVERIFIED (6 hours simulated).
      const expiresAt = now() + 6 * HOUR
      state.set('session', authToken, { gstin, expiresAt })
      return { authToken, expiresAt }
    },

    async saveReturn(who, s, form, retPeriod, data) {
      const gstin = gate(who, false)
      requireSession(gstin, s)
      const r = ret(form, gstin, retPeriod)
      if (r.arn) throw fail('TEST-FILED', `The ${form.toUpperCase()} for ${retPeriod} is already filed`, 'portal')
      if (String(data.gstin ?? '').toUpperCase() !== gstin) throw fail('TEST-GSTIN', 'The return names another GSTIN')
      const period = String(data.fp ?? data.ret_period ?? '')
      if (period !== retPeriod) throw fail('TEST-PERIOD', `The return is for ${period || 'no period'}, not ${retPeriod}`)
      r.saved = data
      r.referenceId = `TST${digits(`ref:${form}:${gstin}:${retPeriod}:${JSON.stringify(data)}`, 12)}`
      r.statusCalls = 0
      r.errors = form === 'gstr1' ? gstr1Errors(data) : []
      r.offset = false
      state.set('ret', retKey(form, gstin, retPeriod), r)
      return { reference_id: r.referenceId }
    },

    async returnStatus(who, s, form, retPeriod, referenceId): Promise<ReturnStatusResponse> {
      const gstin = gate(who, false)
      requireSession(gstin, s)
      const r = ret(form, gstin, retPeriod)
      if (!r.referenceId || r.referenceId !== referenceId) throw fail('TEST-REF', 'No save with this reference id', 'portal')
      // The first status call after a save answers "in progress", later ones the result.
      r.statusCalls += 1
      state.set('ret', retKey(form, gstin, retPeriod), r)
      if (r.statusCalls === 1) return { status_cd: 'IP', error_report: [] }
      return r.errors.length ? { status_cd: 'PE', error_report: r.errors } : { status_cd: 'P', error_report: [] }
    },

    async offsetLiability(who, s, retPeriod, data) {
      const gstin = gate(who, false)
      requireSession(gstin, s)
      const r = ret('gstr3b', gstin, retPeriod)
      if (!r.saved || r.statusCalls < 2) throw fail('TEST-NOT-SAVED', 'Save the GSTR-3B (and let it process) before setting off the liability', 'portal')
      if (r.arn) throw fail('TEST-FILED', 'The GSTR-3B is already filed', 'portal')
      if (!data || typeof data !== 'object') throw fail('TEST-OFFSET', 'Offset details are missing')
      r.offset = true
      state.set('ret', retKey('gstr3b', gstin, retPeriod), r)
      return { reference_id: `TST${digits(`offset:${gstin}:${retPeriod}`, 12)}` }
    },

    async requestEvcOtp(who, s, form, retPeriod) {
      const gstin = gate(who, false)
      requireSession(gstin, s)
      state.set('evc', retKey(form, gstin, retPeriod), { otp: TEST_GSP_OTP, at: now() })
    },

    async fileReturn(who, s, form, retPeriod, evc): Promise<FileReturnResponse> {
      const gstin = gate(who, false)
      requireSession(gstin, s)
      const r = ret(form, gstin, retPeriod)
      if (r.arn) throw fail('TEST-FILED', `The ${form.toUpperCase()} for ${retPeriod} is already filed`, 'duplicate', { info: { ack_num: r.arn, filed_on: r.filedOn } })
      if (!r.saved || r.statusCalls < 2) throw fail('TEST-NOT-SAVED', 'Save the return and wait until it is processed before filing', 'portal')
      if (r.errors.length) throw fail('TEST-ERRORS', 'The saved return has errors — correct them and save again', 'validation')
      if (form === 'gstr3b' && !r.offset) throw fail('TEST-NOT-OFFSET', 'Set off the liability before filing the GSTR-3B', 'portal')
      // The PAN inside a GSTIN is characters 3–12.
      if (evc.pan.toUpperCase() !== gstin.slice(2, 12)) throw fail('TEST-PAN', 'The PAN does not belong to this GSTIN')
      const pending = state.get<{ otp: string; at: number }>('evc', retKey(form, gstin, retPeriod))
      if (!pending) throw fail('TEST-EVC-REQUIRED', 'Ask for the EVC OTP before filing', 'otp_required')
      if (now() - pending.at > 10 * 60_000) throw fail('TEST-OTP-EXPIRED', 'The EVC OTP has expired — ask for a new one', 'otp_required')
      if (evc.otp !== pending.otp) throw fail('TEST-OTP-INVALID', 'The EVC OTP is not correct', 'auth')
      state.set('evc', retKey(form, gstin, retPeriod), null)
      // ARN layout simulated (UNVERIFIED): AA + state code + MMYY + 7 digits + a check letter.
      const seven = digits(`arn:${form}:${gstin}:${retPeriod}`, 7)
      r.arn = `AA${gstin.slice(0, 2)}${retPeriod.slice(0, 2)}${retPeriod.slice(4)}${seven}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[Number(seven) % 24]}`
      r.filedOn = gstnDate(now())
      state.set('ret', retKey(form, gstin, retPeriod), r)
      return { ack_num: r.arn, filed_on: r.filedOn }
    },

    async fetchGstr2b(who, s, retPeriod) {
      const gstin = gate(who, false)
      requireSession(gstin, s)
      const [y, m] = ym(retPeriod)
      // GSTR-2B is generated on the 14th of the following month (rule 60(7) CGST Rules, as amended
      // — UNVERIFIED here: shared/assistantSources.ts lists it). Before that: not ready.
      const ready = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 14) - IST_MS
      if (now() < ready) throw fail('TEST-2B-NOT-READY', `GSTR-2B for ${retPeriod} is generated on the 14th of the next month`, 'not_ready')
      const docs = opts.inwardFor?.(gstin, retPeriod) ?? []
      const b2b = new Map<string, { ctin: string; trdnm: string; inv: unknown[] }>()
      const cdnr = new Map<string, { ctin: string; trdnm: string; nt: unknown[] }>()
      for (const d of docs) {
        const item = { num: 1, txval: rupees(d.taxable), iamt: rupees(d.igst), camt: rupees(d.cgst), samt: rupees(d.sgst), csamt: rupees(d.cess) }
        const pos = d.igst ? d.supplierGstin.slice(0, 2) : gstin.slice(0, 2)
        if (d.kind === 'invoice') {
          const g = b2b.get(d.supplierGstin) ?? { ctin: d.supplierGstin, trdnm: d.supplierName, inv: [] }
          g.inv.push({ inum: d.number, idt: dashDate(d.date), val: rupees(d.value), pos, rev: d.reverseCharge ? 'Y' : 'N', itcavl: 'Y', typ: 'R', items: [item] })
          b2b.set(d.supplierGstin, g)
        } else {
          const g = cdnr.get(d.supplierGstin) ?? { ctin: d.supplierGstin, trdnm: d.supplierName, nt: [] }
          g.nt.push({ nt_num: d.number, nt_dt: dashDate(d.date), typ: d.kind === 'credit_note' ? 'C' : 'D', val: rupees(d.value), pos, rev: d.reverseCharge ? 'Y' : 'N', itcavl: 'Y', items: [item] })
          cdnr.set(d.supplierGstin, g)
        }
      }
      const json = {
        data: {
          gstin, rtnprd: retPeriod, version: 'TEST-GSP', gendt: gstnDate(ready),
          simulated: 'Test GSP — built from the purchases in your own books; not from the GST portal',
          docdata: { b2b: [...b2b.values()], cdnr: [...cdnr.values()] }
        }
      }
      return { json: JSON.stringify(json) }
    }
  }
}
