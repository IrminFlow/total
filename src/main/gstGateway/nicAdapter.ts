// The NIC e-invoice client (services/nic.ts, WP 3.5 — built to the published IRP API, never run
// live) as a gateway adapter. It covers e-invoice and e-way bill by IRN (the IRP's API suite);
// GSTN returns are not part of it. The transport (login, SEK encryption, retry, token refresh)
// stays in nic.ts; this file only maps the adapter calls onto it ([GEN] [CNL] [GET] [EWB] [CEWB]
// [EXT] in sources.ts).
import type { NicCredentials } from '@shared/schemas'
import type { GatewayCapabilities } from '@shared/gstGateway'
import { einvCall, ewayApiCall, type NicDeps } from '../services/nic'
import { GatewayError, notSupported, type GatewayErrorKind, type GstGatewayAdapter, type IrnResponse } from './types'

const CAPABILITIES: GatewayCapabilities = { einvoice: true, ewb: true, gstr1: false, gstr3b: false, gstr3bFile: false, gstr2b: false }
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const orNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v))

function irnResponse(d: Record<string, unknown>): IrnResponse {
  return {
    Irn: str(d.Irn), AckNo: str(d.AckNo), AckDt: str(d.AckDt),
    SignedInvoice: orNull(d.SignedInvoice), SignedQRCode: orNull(d.SignedQRCode),
    ...(d.Status !== undefined ? { Status: str(d.Status) } : {}),
    EwbNo: orNull(d.EwbNo), EwbDt: orNull(d.EwbDt), EwbValidTill: orNull(d.EwbValidTill)
  }
}

/** NIC codes that mean "the login is wrong" ([ERR] VITAL list, services/nic.ts FRIENDLY). */
const AUTH_CODES = new Set(['1008', '1010', '1011', '1012', '1013', '1014', '1016', '1017', '1018', '1019', '3000'])
const DUPLICATE_CODES = new Set(['2150', '4002'])

/** The NIC client's errors with the gateway's kinds (auth / duplicate); messages and codes as NIC gave them. */
async function mapped<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    if (!(e instanceof GatewayError) || e.kind !== 'portal') throw e
    const kind: GatewayErrorKind | null = e.codes.some((c) => AUTH_CODES.has(c)) ? 'auth' : e.codes.some((c) => DUPLICATE_CODES.has(c)) ? 'duplicate' : null
    if (!kind) throw e
    throw new GatewayError(e.message, e.codes, kind, e.info !== undefined ? { info: e.info } : {})
  }
}

export function createNicAdapter(creds: NicCredentials, deps: NicDeps = {}): GstGatewayAdapter {
  const noReturns = (): never => {
    throw notSupported('The NIC e-invoice API', 'GSTN returns (GSTR-1, GSTR-3B, GSTR-2B)')
  }
  return {
    id: 'nic-direct',
    label: 'NIC e-invoice API (direct)',
    test: false,
    capabilities: CAPABILITIES,
    async generateIrn(who, invoice) {
      return irnResponse((await mapped(einvCall(creds, who.gstin, 'POST', '/eicore/v1.03/Invoice', invoice, deps))).data)
    },
    async getIrn(who, irn) {
      return irnResponse((await mapped(einvCall(creds, who.gstin, 'GET', `/eicore/v1.03/Invoice/irn/${irn}`, null, deps))).data)
    },
    async cancelIrn(who, req) {
      const d = (await mapped(einvCall(creds, who.gstin, 'POST', '/eicore/v1.03/Invoice/Cancel', req, deps))).data
      return { Irn: str(d.Irn), CancelDate: str(d.CancelDate) }
    },
    async generateEwbByIrn(who, req) {
      const d = (await mapped(einvCall(creds, who.gstin, 'POST', '/eiewb/v1.03/ewaybill', req, deps))).data
      return { EwbNo: str(d.EwbNo), EwbDt: str(d.EwbDt), EwbValidTill: str(d.EwbValidTill) }
    },
    async extendEwb(who, req) {
      const d = await mapped(ewayApiCall(creds, who.gstin, 'EXTENDVALIDITY', req, deps))
      return { ewayBillNo: str(d.ewayBillNo), updatedDate: str(d.updatedDate), validUpto: str(d.validUpto) }
    },
    async cancelEwb(who, req) {
      const d = await mapped(ewayApiCall(creds, who.gstin, 'CANEWB', req, deps))
      return { ewayBillNo: str(d.ewayBillNo), cancelDate: str(d.cancelDate) }
    },
    requestOtp: async () => noReturns(),
    signIn: async () => noReturns(),
    saveReturn: async () => noReturns(),
    returnStatus: async () => noReturns(),
    offsetLiability: async () => noReturns(),
    requestEvcOtp: async () => noReturns(),
    fileReturn: async () => noReturns(),
    fetchGstr2b: async () => noReturns()
  }
}
