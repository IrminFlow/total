// The gateway adapter contract (Phase 4): ONE suite every adapter must pass. It runs against the
// built-in Test GSP (testGsp.contract.test.ts, every capability) and against the NIC client over
// the fake NIC sandbox (nicAdapter.contract.dbtest.ts, e-invoice + e-way bill), and is written so a
// real GSP sandbox can run it later from the manual CI workflow (.github/workflows/gsp-sandbox.yml)
// with `TOTAL_GSP_SANDBOX=1` and credentials from the repository secrets.
//
// Hand-worked expectations only: the IRN is the SHA-256 the IRP defines ([IRN] in sources.ts),
// worked out here from the request; every refusal is the documented code.
import crypto from 'crypto'
import { describe, expect, it } from 'vitest'
import { buildEInvoiceJson, type EdocCompany, type EdocInvoice } from '@shared/gst/edocs'
import { einvoiceIssues } from '@shared/gst/einvoiceSchema'
import { GatewayError, type GatewayIdentity, type GstGatewayAdapter } from './types'

export const CONTRACT_GSTIN = '27AAPFU0939F1ZV'
export const CONTRACT_BUYER = '29AACCR7832C1ZD'
const HOUR = 3600 * 1000

export interface ContractClock {
  now(): number
  advance(ms: number): void
}

export interface ContractSetup {
  adapter: GstGatewayAdapter
  who: GatewayIdentity
  /** The identity with a wrong password (expect kind 'auth'). */
  badWho: GatewayIdentity
  /** For adapters whose login is fixed at construction (NIC): one built with a wrong password. */
  badAdapter?: GstGatewayAdapter
  clock: ContractClock
  /** The OTP the adapter's portal sends (the Test GSP's published one; a sandbox's from the env). */
  otp: string
  /** A month whose GSTR-2B exists, and the documents it should carry (when known). */
  gstr2b?: { period: string; expectInvoices?: number }
  /** Rate limit to drive (calls a minute), when the adapter can be configured with one. */
  rateLimit?: number
}

export function contractInvoice(no: string, dateIso: string): Record<string, unknown> {
  const inv: EdocInvoice = {
    number: no,
    date: dateIso,
    docType: 'INV',
    partyName: 'Rao Traders',
    partyGstin: CONTRACT_BUYER,
    partyAddress: '5 Brigade Rd, Bengaluru 560001',
    partyStateCode: '29',
    pos: '29',
    items: [{
      name: 'Laptop 14', hsn: '8471', qtyMilli: 2000, uqc: 'PCS', unitPricePaise: 5000000,
      taxablePaise: 10000000, rate: 18, cessRate: 0, cgst: 0, sgst: 0, igst: 1800000, cess: 0, isService: false
    }],
    taxable: 10000000, cgst: 0, sgst: 0, igst: 1800000, cess: 0, roundOff: 0, total: 11800000,
    transporterId: null, vehicleNo: 'MH12AB1234', distanceKm: 350,
    transport: { mode: '1', docNo: '', docDate: null, transporterName: '', vehicleType: 'R' },
    shipTo: null
  } as EdocInvoice
  const company: EdocCompany = { name: 'Demo Traders', gstin: CONTRACT_GSTIN, stateCode: '27', address: '12 MG Road\nPune 411001' }
  return buildEInvoiceJson([inv], company)[0] as unknown as Record<string, unknown>
}

/** [IRN]: SHA-256 of supplier GSTIN + financial year + document type + document number. */
export const expectedIrn = (gstin: string, fy: string, typ: string, no: string): string =>
  crypto.createHash('sha256').update(`${gstin}${fy}${typ}${no.toUpperCase()}`).digest('hex')

async function rejection(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayError)
    return e as GatewayError
  }
  throw new Error('expected a rejection')
}

/** `make()` gives a FRESH portal per test. */
export function runGatewayContract(name: string, make: () => ContractSetup): void {
  describe(`gateway contract: ${name}`, () => {
    it('declares what it can do', () => {
      const { adapter } = make()
      expect(['test-gsp', 'nic-direct']).toContain(adapter.id)
      expect(typeof adapter.capabilities.einvoice).toBe('boolean')
    })

    describe('e-invoice', () => {
      it('generates the IRN the IRP defines, with ack no / date and a signed QR whose payload names the document', async () => {
        const s = make()
        if (!s.adapter.capabilities.einvoice) return
        const doc = contractInvoice('GW-1', '2026-07-06')
        expect(einvoiceIssues(doc)).toEqual([])
        const r = await s.adapter.generateIrn(s.who, doc)
        expect(r.Irn).toBe(expectedIrn(CONTRACT_GSTIN, '2026-27', 'INV', 'GW-1'))
        expect(r.AckNo).toMatch(/^\d{10,20}$/)
        expect(r.AckDt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
        const qr = JSON.parse(Buffer.from(r.SignedQRCode!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { data: string }
        expect(JSON.parse(qr.data)).toMatchObject({ SellerGstin: CONTRACT_GSTIN, BuyerGstin: CONTRACT_BUYER, DocNo: 'GW-1', DocTyp: 'INV', Irn: r.Irn, TotInvVal: 118000 })
      })

      it('a second request for the same document is a duplicate (2150) carrying the existing IRN', async () => {
        const s = make()
        if (!s.adapter.capabilities.einvoice) return
        const first = await s.adapter.generateIrn(s.who, contractInvoice('GW-2', '2026-07-06'))
        const e = await rejection(s.adapter.generateIrn(s.who, contractInvoice('GW-2', '2026-07-06')))
        expect(e.codes).toContain('2150')
        const dup = (e.info as { InfCd: string; Desc: { Irn: string } }[]).find((x) => x.InfCd === 'DUPIRN')
        expect(dup?.Desc.Irn).toBe(first.Irn)
      })

      it('get IRN details returns the signed copies; cancel within 24 h works once; a cancelled number gets no new IRN (2278)', async () => {
        const s = make()
        if (!s.adapter.capabilities.einvoice) return
        const g = await s.adapter.generateIrn(s.who, contractInvoice('GW-3', '2026-07-06'))
        const got = await s.adapter.getIrn(s.who, g.Irn)
        expect(got.Irn).toBe(g.Irn)
        expect(got.SignedInvoice).toBe(g.SignedInvoice)
        const c = await s.adapter.cancelIrn(s.who, { Irn: g.Irn, CnlRsn: '2', CnlRem: 'typo' })
        expect(c.Irn).toBe(g.Irn)
        expect(c.CancelDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
        expect((await rejection(s.adapter.cancelIrn(s.who, { Irn: g.Irn, CnlRsn: '2', CnlRem: '' }))).codes).toContain('9999')
        expect((await rejection(s.adapter.generateIrn(s.who, contractInvoice('GW-3', '2026-07-06')))).codes).toContain('2278')
      })

      it('cancel after 24 h is refused (2270); Get IRN after 3 days (2283)', async () => {
        const s = make()
        if (!s.adapter.capabilities.einvoice) return
        const g = await s.adapter.generateIrn(s.who, contractInvoice('GW-4', '2026-07-06'))
        s.clock.advance(25 * HOUR)
        expect((await rejection(s.adapter.cancelIrn(s.who, { Irn: g.Irn, CnlRsn: '1', CnlRem: '' }))).codes).toContain('2270')
        s.clock.advance(48 * HOUR)
        expect((await rejection(s.adapter.getIrn(s.who, g.Irn))).codes).toContain('2283')
      })

      it('a seller GSTIN other than the caller\'s is refused (2143)', async () => {
        const s = make()
        if (!s.adapter.capabilities.einvoice) return
        const doc = contractInvoice('GW-5', '2026-07-06')
        const e = await rejection(s.adapter.generateIrn({ ...s.who, gstin: '29AACCR7832C1ZD' }, doc))
        expect(e.codes.some((c) => ['2143', '1015'].includes(c))).toBe(true)
      })

      it('wrong credentials are an auth failure', async () => {
        const s = make()
        if (!s.adapter.capabilities.einvoice) return
        const e = await rejection((s.badAdapter ?? s.adapter).generateIrn(s.badWho, contractInvoice('GW-6', '2026-07-06')))
        expect(e.kind).toBe('auth')
      })
    })

    describe('e-way bill by IRN', () => {
      it('generates a 12-digit EWB valid one day per 200 km; refuses a second (4002); cancels; an IRN with a live EWB can\'t be cancelled (2230)', async () => {
        const s = make()
        if (!s.adapter.capabilities.ewb) return
        const g = await s.adapter.generateIrn(s.who, contractInvoice('GW-7', '2026-07-06'))
        const e = await s.adapter.generateEwbByIrn(s.who, { Irn: g.Irn, Distance: 350, TransMode: '1', VehNo: 'MH12AB1234', VehType: 'R' })
        expect(e.EwbNo).toMatch(/^\d{12}$/)
        expect(e.EwbValidTill).toMatch(/^\d{4}-\d{2}-\d{2} 23:59:00$/)
        expect((await rejection(s.adapter.generateEwbByIrn(s.who, { Irn: g.Irn, Distance: 350, TransMode: '1', VehNo: 'MH12AB1234', VehType: 'R' }))).codes).toContain('4002')
        expect((await rejection(s.adapter.cancelIrn(s.who, { Irn: g.Irn, CnlRsn: '1', CnlRem: '' }))).codes).toContain('2230')
        const c = await s.adapter.cancelEwb(s.who, { ewbNo: Number(e.EwbNo), cancelRsnCode: 2, cancelRmrk: 'order cancelled' })
        expect(String(c.ewayBillNo)).toBe(e.EwbNo)
        expect((await rejection(s.adapter.cancelEwb(s.who, { ewbNo: Number(e.EwbNo), cancelRsnCode: 2, cancelRmrk: '' }))).codes).toContain('4057')
      })

      it('road without a vehicle is a validation error (4011)', async () => {
        const s = make()
        if (!s.adapter.capabilities.ewb) return
        const g = await s.adapter.generateIrn(s.who, contractInvoice('GW-8', '2026-07-06'))
        expect((await rejection(s.adapter.generateEwbByIrn(s.who, { Irn: g.Irn, Distance: 100, TransMode: '1', VehType: 'R' }))).codes).toContain('4011')
      })

      it('extends within 8 h of expiry with the new validity; refuses outside the window', async () => {
        const s = make()
        if (!s.adapter.capabilities.ewb) return
        const g = await s.adapter.generateIrn(s.who, contractInvoice('GW-9', '2026-07-06'))
        const e = await s.adapter.generateEwbByIrn(s.who, { Irn: g.Irn, Distance: 150, TransMode: '1', VehNo: 'MH12AB1234', VehType: 'R' })
        const req = {
          ewbNo: Number(e.EwbNo), vehicleNo: 'MH12AB1234', fromPlace: 'Pune', fromState: 27, remainingDistance: 100, transDocNo: '', transDocDate: '',
          transMode: '1', extnRsnCode: 1, extnRemarks: 'breakdown', fromPincode: 411001, consignmentStatus: 'M', transitType: '',
          addressLine1: '', addressLine2: '', addressLine3: ''
        }
        await rejection(s.adapter.extendEwb(s.who, req))
        // Validity ends 23:59 IST the next day: move to within 8 hours of it.
        const until = Date.parse(`${e.EwbValidTill.replace(' ', 'T')}+05:30`)
        s.clock.advance(until - s.clock.now() - 2 * HOUR)
        const x = await s.adapter.extendEwb(s.who, req)
        expect(String(x.ewayBillNo)).toBe(e.EwbNo)
        expect(x.validUpto).toMatch(/^\d{2}\/\d{2}\/\d{4} 11:59:00 PM$/)
      })

      it('no e-way bill for a credit note (4010)', async () => {
        const s = make()
        if (!s.adapter.capabilities.ewb) return
        const doc = contractInvoice('GW-10', '2026-07-06') as { DocDtls: { Typ: string } }
        doc.DocDtls.Typ = 'CRN'
        const g = await s.adapter.generateIrn(s.who, doc as unknown as Record<string, unknown>)
        expect((await rejection(s.adapter.generateEwbByIrn(s.who, { Irn: g.Irn, Distance: 100, TransMode: '1', VehNo: 'MH12AB1234', VehType: 'R' }))).codes).toContain('4010')
      })
    })

    describe('GSTN returns', () => {
      const gstr1 = (period: string, ctin = CONTRACT_BUYER): Record<string, unknown> => ({
        gstin: CONTRACT_GSTIN, fp: period, b2b: [{ ctin, inv: [{ inum: 'GW-1', idt: '06-07-2026', val: 118000, pos: '29', rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: { rt: 18, txval: 100000, iamt: 18000, csamt: 0 } }] }] }]
      })

      it('every returns call needs the OTP sign-in first (otp_required); a wrong OTP is refused; wrong credentials are an auth failure', async () => {
        const s = make()
        if (!s.adapter.capabilities.gstr1) {
          expect((await rejection(s.adapter.requestOtp(s.who))).kind).toBe('not_supported')
          return
        }
        const fake = { authToken: 'nope', expiresAt: s.clock.now() + HOUR }
        expect((await rejection(s.adapter.saveReturn(s.who, fake, 'gstr1', '072026', gstr1('072026')))).kind).toBe('otp_required')
        expect((await rejection((s.badAdapter ?? s.adapter).requestOtp(s.badWho))).kind).toBe('auth')
        await s.adapter.requestOtp(s.who)
        expect((await rejection(s.adapter.signIn(s.who, s.otp === '000000' ? '111111' : '000000'))).kind).toBe('auth')
        await s.adapter.requestOtp(s.who)
        const session = await s.adapter.signIn(s.who, s.otp)
        expect(session.expiresAt).toBeGreaterThan(s.clock.now())
      })

      it('GSTR-1: save → in progress → processed → EVC OTP → file → ARN; filing again is refused', async () => {
        const s = make()
        if (!s.adapter.capabilities.gstr1) return
        await s.adapter.requestOtp(s.who)
        const session = await s.adapter.signIn(s.who, s.otp)
        const saved = await s.adapter.saveReturn(s.who, session, 'gstr1', '072026', gstr1('072026'))
        expect(saved.reference_id).toMatch(/^[A-Z0-9]+$/)
        let st = await s.adapter.returnStatus(s.who, session, 'gstr1', '072026', saved.reference_id)
        for (let i = 0; i < 5 && st.status_cd === 'IP'; i++) st = await s.adapter.returnStatus(s.who, session, 'gstr1', '072026', saved.reference_id)
        expect(st.status_cd).toBe('P')
        const pan = CONTRACT_GSTIN.slice(2, 12)
        expect((await rejection(s.adapter.fileReturn(s.who, session, 'gstr1', '072026', { pan, otp: s.otp }))).kind).toBe('otp_required')
        await s.adapter.requestEvcOtp(s.who, session, 'gstr1', '072026')
        const filed = await s.adapter.fileReturn(s.who, session, 'gstr1', '072026', { pan, otp: s.otp })
        expect(filed.ack_num).toMatch(/^[A-Z0-9]{10,20}$/)
        await s.adapter.requestEvcOtp(s.who, session, 'gstr1', '072026')
        await rejection(s.adapter.fileReturn(s.who, session, 'gstr1', '072026', { pan, otp: s.otp }))
      })

      it('GSTR-1 with an invalid recipient GSTIN processes with errors (PE) and can\'t be filed', async () => {
        const s = make()
        if (!s.adapter.capabilities.gstr1) return
        await s.adapter.requestOtp(s.who)
        const session = await s.adapter.signIn(s.who, s.otp)
        const saved = await s.adapter.saveReturn(s.who, session, 'gstr1', '082026', gstr1('082026', 'NOT-A-GSTIN'))
        let st = await s.adapter.returnStatus(s.who, session, 'gstr1', '082026', saved.reference_id)
        for (let i = 0; i < 5 && st.status_cd === 'IP'; i++) st = await s.adapter.returnStatus(s.who, session, 'gstr1', '082026', saved.reference_id)
        expect(st.status_cd).toBe('PE')
        expect(st.error_report.length).toBeGreaterThan(0)
        await s.adapter.requestEvcOtp(s.who, session, 'gstr1', '082026')
        expect((await rejection(s.adapter.fileReturn(s.who, session, 'gstr1', '082026', { pan: CONTRACT_GSTIN.slice(2, 12), otp: s.otp }))).kind).toBe('validation')
      })

      it('GSTR-3B: save → processed → offset → file; filing before the offset is refused', async () => {
        const s = make()
        if (!s.adapter.capabilities.gstr3b) return
        await s.adapter.requestOtp(s.who)
        const session = await s.adapter.signIn(s.who, s.otp)
        const saved = await s.adapter.saveReturn(s.who, session, 'gstr3b', '072026', { gstin: CONTRACT_GSTIN, ret_period: '072026', sup_details: {} })
        let st = await s.adapter.returnStatus(s.who, session, 'gstr3b', '072026', saved.reference_id)
        for (let i = 0; i < 5 && st.status_cd === 'IP'; i++) st = await s.adapter.returnStatus(s.who, session, 'gstr3b', '072026', saved.reference_id)
        expect(st.status_cd).toBe('P')
        const pan = CONTRACT_GSTIN.slice(2, 12)
        if (!s.adapter.capabilities.gstr3bFile) return
        await s.adapter.requestEvcOtp(s.who, session, 'gstr3b', '072026')
        await rejection(s.adapter.fileReturn(s.who, session, 'gstr3b', '072026', { pan, otp: s.otp }))
        await s.adapter.offsetLiability(s.who, session, '072026', { gstin: CONTRACT_GSTIN, ret_period: '072026', creditUsedPaise: {}, cashPaise: {} })
        await s.adapter.requestEvcOtp(s.who, session, 'gstr3b', '072026')
        expect((await s.adapter.fileReturn(s.who, session, 'gstr3b', '072026', { pan, otp: s.otp })).ack_num).toMatch(/^[A-Z0-9]{10,20}$/)
      })

      it('GSTR-2B: a generated month comes back in the portal\'s 2B JSON layout; a month not yet generated is not_ready', async () => {
        const s = make()
        if (!s.adapter.capabilities.gstr2b || !s.gstr2b) return
        await s.adapter.requestOtp(s.who)
        const session = await s.adapter.signIn(s.who, s.otp)
        const { json } = await s.adapter.fetchGstr2b(s.who, session, s.gstr2b.period)
        const parsed = JSON.parse(json) as { data: { rtnprd: string; docdata: { b2b: { inv: unknown[] }[] } } }
        expect(parsed.data.rtnprd).toBe(s.gstr2b.period)
        if (s.gstr2b.expectInvoices !== undefined) expect(parsed.data.docdata.b2b.flatMap((g) => g.inv).length).toBe(s.gstr2b.expectInvoices)
        // The running month's 2B does not exist yet.
        const d = new Date(s.clock.now() + 330 * 60_000)
        const running = `${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`
        expect((await rejection(s.adapter.fetchGstr2b(s.who, session, running))).kind).toBe('not_ready')
      })
    })

    it('rate limit: past the provider\'s limit a call is refused as rate_limit with a retry time', async () => {
      const s = make()
      if (!s.rateLimit) return
      for (let i = 0; i < s.rateLimit; i++) await s.adapter.requestOtp(s.who).catch(() => undefined)
      const e = await rejection(s.adapter.requestOtp(s.who))
      expect(e.kind).toBe('rate_limit')
      expect(e.retryAfterMs).toBeGreaterThan(0)
      s.clock.advance(61_000)
      await s.adapter.requestOtp(s.who)
    })
  })
}
