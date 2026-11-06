// Phase 4 — the GST gateway on real books: settings (live filing can't be turned on, the password
// only in the secret store), the Test GSP's simulated IRN / e-way bill kept apart from the voucher's
// real columns, GSTR-1 / 3B save → status → (offset) → file → ARN into meta gstFiled (a test filing
// never counts as filed; a real adapter's does), and GSTR-2B fetched into gst2b_statements where
// the WP 3.4 matcher reads it. Hand-worked figures; no network.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, DrCr } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from '../services/masters'
import { saveVoucher } from '../services/vouchers'
import { listSalesInvoices, setTransport } from '../services/edocs'
import { createSecretStore, insecureTestCipher, companyScope, type SecretStore } from '../services/secrets'
import { getStatement, gst2bMismatches, statementSource, store2bStatement } from '../services/assistants'
import { recon2b } from '../services/gst'
import { getRecon2bTolerances } from '../services/gstIms'
import { recon2bOptionsFrom } from '@shared/gst/recon2b'
import { readGstFiled, readGstFiledAll } from '../services/dashboard'
import { setGstFiled } from '../services/simpleTaxes'
import { gatewayStatus, openGateway, readGatewaySettings, resetGatewaySessions, setGatewaySettings, type GatewayDeps } from './index'
import { edocRecord, generateEwbFlow, generateIrnFlow, TEST_STORE } from './edocFlow'
import * as returns from './returnsFlow'
import { createTestGsp, TEST_GSP_OTP, TEST_GSP_PASSWORD } from './testGsp'
import { GatewayError } from './types'

const SLUG = 'gw-test'
const GSTIN = '27AAPFU0939F1ZV'
const COMPANY: CompanyInfo = { ...TEST_INFO, name: 'Demo Traders', gstin: GSTIN, address: '12 MG Road\nPune 411001' }
/** 20 Sep 2026, 11:30 IST: August is over and its GSTR-2B (14 Sep) exists. */
const NOW = Date.parse('2026-09-20T11:30:00+05:30')
const TODAY = '2026-09-20'

let dir = ''
let prevDataDir: string | undefined
let store: SecretStore
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'total-gateway-'))
  prevDataDir = process.env.TOTAL_DATA_DIR
  process.env.TOTAL_DATA_DIR = dir
})
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.TOTAL_DATA_DIR
  else process.env.TOTAL_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  resetGatewaySessions()
  const file = join(dir, `secrets-${Math.random().toString(36).slice(2)}.json`)
  store = createSecretStore({ filePath: () => file, cipher: insecureTestCipher() })
})

interface Books { db: DB; buyer: number; supplier: number; sales: number; purchases: number; igst: number; item: number; post: (kind: string, date: string, party: number, lines: { ledgerId: number; drCr: DrCr; amount: number }[], inv?: { item: number; qtyMilli: number; ratePaise: number; amount: number }[], number?: string, reference?: string) => number }

function books(): Books {
  const db = seededDb()
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
  const buyer = createLedger(db, { name: 'Karnataka Buyer', groupId: g('Sundry Debtors'), gstin: '29AAACU1234F1ZM', stateCode: '29', address: 'Shop 4, Brigade Road\nBengaluru 560001' }).id
  const supplier = createLedger(db, { name: 'Gujarat Supplier', groupId: g('Sundry Creditors'), gstin: '24AAACS1234C1Z4', stateCode: '24', address: 'Ring Road\nSurat 395002' }).id
  const sales = createLedger(db, { name: 'Sales', groupId: g('Sales Accounts') }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId: g('Purchase Accounts') }).id
  const igst = createLedger(db, { name: 'IGST', groupId: g('Duties & Taxes'), taxType: 'igst' }).id
  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Pcs'").get() as { id: number }).id
  const item = Number(db.prepare("INSERT INTO stock_items (name, unit_id, hsn, gst_rate, opening_qty_milli, opening_value) VALUES ('Laptop 14', ?, '84713010', 18, 100000, 300000000)").run(unitId).lastInsertRowid)
  const post: Books['post'] = (kind, date, party, lines, inv = [], number, reference) =>
    saveVoucher(db, {
      voucherTypeId: vt(kind), date, partyLedgerId: party, ...(number ? { number } : {}), ...(reference ? { reference } : {}),
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: inv.map((l) => ({ stockItemId: l.item, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, amount: l.amount, discountPaise: 0, direction: kind === 'purchase' ? 'in' as const : 'out' as const, godownId: null })),
      billRefs: [], tds: null
    }).id
  return { db, buyer, supplier, sales, purchases, igst, item, post }
}

/** 2 × ₹45,000 = ₹90,000 + 18 % IGST ₹16,200 = ₹1,06,200 to a Karnataka buyer, 15 Aug 2026. */
function sale(b: Books, number = 'INV-101'): number {
  const id = b.post('sales', '2026-08-15', b.buyer, [
    { ledgerId: b.buyer, drCr: 'dr', amount: 10_620_000 },
    { ledgerId: b.sales, drCr: 'cr', amount: 9_000_000 },
    { ledgerId: b.igst, drCr: 'cr', amount: 1_620_000 }
  ], [{ item: b.item, qtyMilli: 2000, ratePaise: 4_500_000, amount: 9_000_000 }], number)
  setTransport(b.db, id, { transMode: '1', transDistanceKm: 840, transporterId: null, transporterName: null, transDocNo: null, transDocDate: null, vehicleNo: 'MH12AB1234', vehicleType: 'R', shipToName: null, shipToGstin: null, shipToAddr1: null, shipToAddr2: null, shipToPlace: null, shipToPincode: null, shipToState: null })
  return id
}

/** 1 × ₹40,000 + 18 % IGST ₹7,200 = ₹47,200 from the Gujarat supplier (their bill G-55), 10 Aug 2026. */
function purchase(b: Books): number {
  return b.post('purchase', '2026-08-10', b.supplier, [
    { ledgerId: b.purchases, drCr: 'dr', amount: 4_000_000 },
    { ledgerId: b.igst, drCr: 'dr', amount: 720_000 },
    { ledgerId: b.supplier, drCr: 'cr', amount: 4_720_000 }
  ], [{ item: b.item, qtyMilli: 1000, ratePaise: 4_000_000, amount: 4_000_000 }], undefined, 'G-55')
}

const deps = (over: Partial<GatewayDeps> = {}): GatewayDeps => ({ store, now: () => NOW, ...over })
const gw = (db: DB, over: Partial<GatewayDeps> = {}) => openGateway(db, SLUG, COMPANY, deps(over))
const auditRows = (db: DB, entity: string) => db.prepare('SELECT action, before_json AS b, after_json AS a FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as { action: string; b: string | null; a: string | null }[]

async function signedIn(db: DB, over: Partial<GatewayDeps> = {}) {
  const g = gw(db, over)
  await returns.requestSignInOtp(g)
  await returns.signIn(g, TEST_GSP_OTP)
  return g
}

describe('settings: test mode only; the password lives in the secret store', () => {
  it('defaults to the Test GSP with live filing off; live: true and another provider are refused; nothing is written', () => {
    const { db } = books()
    expect(readGatewaySettings(db)).toEqual({ provider: 'test-gsp', live: false, username: '' })
    const st = gatewayStatus(db, SLUG, store)
    expect(st).toMatchObject({ testMode: true, liveFilingAvailable: false, passwordStored: false, signedIn: false })
    expect(st.providers.find((p) => p.id === 'nic-direct')!.selectable).toBe(false)
    expect(() => setGatewaySettings(db, SLUG, { provider: 'test-gsp', live: true, username: '' }, store)).toThrow(/Live filing is not available/)
    expect(() => setGatewaySettings(db, SLUG, { provider: 'nic-direct', live: false, username: '' }, store)).toThrow(/Only the built-in Test GSP/)
    expect(auditRows(db, 'gst_gateway')).toEqual([])
    // A hand-edited meta row asking for live filing still reads as test mode.
    db.prepare("INSERT INTO meta (key, value) VALUES ('gstGateway', ?)").run(JSON.stringify({ provider: 'test-gsp', live: true, username: 'x' }))
    expect(readGatewaySettings(db).live).toBe(false)
  })

  it('a password goes to the secret store (companyScope), never to meta; audited by presence; an unchanged save writes nothing', () => {
    const { db } = books()
    setGatewaySettings(db, SLUG, { provider: 'test-gsp', live: false, username: 'testgsp', password: TEST_GSP_PASSWORD }, store)
    expect(store.get(companyScope(SLUG), 'gstGateway.password')).toBe(TEST_GSP_PASSWORD)
    const meta = (db.prepare("SELECT value FROM meta WHERE key = 'gstGateway'").get() as { value: string }).value
    expect(meta).not.toContain(TEST_GSP_PASSWORD)
    expect(JSON.stringify(auditRows(db, 'gst_gateway'))).not.toContain(TEST_GSP_PASSWORD)
    expect(JSON.parse(auditRows(db, 'gst_gateway')[0]!.a!)).toEqual({ settings: { provider: 'test-gsp', live: false, username: 'testgsp' }, passwordStored: true })
    setGatewaySettings(db, SLUG, { provider: 'test-gsp', live: false, username: 'testgsp', password: TEST_GSP_PASSWORD }, store)
    expect(auditRows(db, 'gst_gateway')).toHaveLength(1)
    expect(gatewayStatus(db, SLUG, store).passwordStored).toBe(true)
  })

  it('a wrong stored password is an auth failure from the Test GSP', async () => {
    const b = books()
    setGatewaySettings(b.db, SLUG, { provider: 'test-gsp', live: false, username: '', password: 'wrong' }, store)
    const e = await generateIrnFlow(b.db, COMPANY, sale(b), gw(b.db)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(GatewayError)
    expect((e as GatewayError).kind).toBe('auth')
  })
})

describe('e-invoice / e-way bill in test mode', () => {
  it('the simulated IRN = SHA-256(GSTIN + FY + INV + number) lands in the test table only — the voucher, its print and its edit lock never see it', async () => {
    const b = books()
    const id = sale(b)
    const voucherAudits = (): number => (b.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'voucher' AND entity_id = ?").get(id) as { n: number }).n
    const auditsBefore = voucherAudits()
    const r = await generateIrnFlow(b.db, COMPANY, id, gw(b.db))
    const irn = crypto.createHash('sha256').update(`${GSTIN}2026-27INVINV-101`).digest('hex')
    expect(r).toMatchObject({ irn, recovered: false })
    expect(b.db.prepare('SELECT irn, ewb_no FROM vouchers WHERE id = ?').get(id)).toEqual({ irn: null, ewb_no: null })
    expect(listSalesInvoices(b.db, '2026-08-01', '2026-08-31', COMPANY).find((x) => x.voucherId === id)!.irn).toBeNull()
    expect(edocRecord(b.db, TEST_STORE, id, NOW)).toMatchObject({ irn, irnLive: true, number: 'INV-101' })
    const qr = edocRecord(b.db, TEST_STORE, id, NOW).signedQrData as { iss: string; data: { TotInvVal: number; Irn: string } }
    expect(qr.iss).toMatch(/TEST-GSP/)
    expect(qr.data).toMatchObject({ Irn: irn, TotInvVal: 106200 })
    // Audited under the gateway, never as a voucher change.
    expect(auditRows(b.db, 'gst_gateway_edoc').map((x) => JSON.parse(x.a!) as { irn: string; test: boolean })[0]).toMatchObject({ irn, test: true })
    expect(voucherAudits()).toBe(auditsBefore)
    // Generating again is refused locally.
    await expect(generateIrnFlow(b.db, COMPANY, id, gw(b.db))).rejects.toThrow(/already has an IRN/)
  })

  it('a lost answer: the portal says duplicate (2150) and the existing IRN is adopted with its signed copies', async () => {
    const b = books()
    const id = sale(b)
    const first = await generateIrnFlow(b.db, COMPANY, id, gw(b.db))
    b.db.prepare('DELETE FROM gst_gateway_test_edocs WHERE voucher_id = ?').run(id)
    const again = await generateIrnFlow(b.db, COMPANY, id, gw(b.db))
    expect(again).toMatchObject({ irn: first.irn, ackNo: first.ackNo, recovered: true })
    expect(again.signedQrCode).toBe(first.signedQrCode)
  })

  it('e-way bill by IRN: 840 km = 5 days, to 23:59 IST on 25 Sep; stored in the test table', async () => {
    const b = books()
    const id = sale(b)
    await generateIrnFlow(b.db, COMPANY, id, gw(b.db))
    const e = await generateEwbFlow(b.db, COMPANY, id, gw(b.db))
    expect(e.ewbNo).toMatch(/^\d{12}$/)
    expect(e.validUpto).toBe('2026-09-25 23:59:00')
    expect(edocRecord(b.db, TEST_STORE, id, NOW)).toMatchObject({ ewbNo: e.ewbNo, ewbValidUpto: '2026-09-25 23:59:00' })
    expect(b.db.prepare('SELECT ewb_no FROM vouchers WHERE id = ?').get(id)).toEqual({ ewb_no: null })
  })
})

describe('GSTR-1 / GSTR-3B through the gateway', () => {
  it('returns calls need the OTP sign-in first', async () => {
    const b = books()
    sale(b)
    await expect(returns.saveReturn(b.db, COMPANY, gw(b.db), 'gstr1', '082026')).rejects.toMatchObject({ kind: 'otp_required' })
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM gst_gateway_returns').get()).toEqual({ n: 0 })
  })

  it('GSTR-1 (test): the export\'s JSON is sent, processed, filed with EVC → ARN; the filing is kept labelled in gstFiled and never counts as filed', async () => {
    const b = books()
    sale(b)
    const g = await signedIn(b.db)
    const saved = await returns.saveReturn(b.db, COMPANY, g, 'gstr1', '082026')
    expect(saved).toMatchObject({ state: 'saved', test: true, provider: 'test-gsp' })
    expect((await returns.refreshReturnStatus(b.db, g, 'gstr1', '082026')).state).toBe('processing')
    expect((await returns.refreshReturnStatus(b.db, g, 'gstr1', '082026')).state).toBe('processed')
    await returns.requestEvcOtp(b.db, COMPANY, g, 'gstr1', '082026', TODAY)
    const filed = await returns.fileReturn(b.db, COMPANY, g, 'gstr1', '082026', TEST_GSP_OTP, 'owner', TODAY)
    // ARN (simulated): AA + 27 + 08 + 26 + 7 digits + a letter; filed on today (IST).
    expect(filed).toMatchObject({ state: 'filed', filedOn: TODAY })
    expect(filed.arn).toMatch(/^AA270826\d{7}[A-Z]$/)
    expect(readGstFiledAll(b.db)['2026-08']!.gstr1).toMatchObject({ arn: filed.arn, date: TODAY, by: 'owner', via: { provider: 'test-gsp', test: true } })
    expect(readGstFiled(b.db)).toEqual({})
    // The trail: create (saved) → processing → processed → filed, and the company gstFiled update.
    expect(auditRows(b.db, 'gst_gateway_return').map((r) => (JSON.parse(r.a!) as { state: string }).state)).toEqual(['saved', 'processing', 'processed', 'filed'])
    // A real "I've filed" afterwards replaces the simulated mark.
    setGstFiled(b.db, COMPANY, { period: '2026-08', form: 'gstr1', arn: 'AB2708261234567', date: TODAY }, 'owner', TODAY)
    expect(readGstFiled(b.db)['2026-08']!.gstr1).toMatchObject({ arn: 'AB2708261234567' })
    expect(readGstFiledAll(b.db)['2026-08']!.gstr1!.via).toBeUndefined()
  })

  it('a running month is refused locally; filing before the save is processed is refused', async () => {
    const b = books()
    sale(b)
    const g = await signedIn(b.db)
    await expect(returns.fileReturn(b.db, COMPANY, g, 'gstr1', '092026', TEST_GSP_OTP, null, TODAY)).rejects.toThrow(/not over yet/)
    await returns.saveReturn(b.db, COMPANY, g, 'gstr1', '082026')
    await expect(returns.requestEvcOtp(b.db, COMPANY, g, 'gstr1', '082026', TODAY)).rejects.toThrow(/processed/)
  })

  it('GSTR-3B (test): save → processed → offset → file', async () => {
    const b = books()
    sale(b)
    purchase(b)
    const g = await signedIn(b.db)
    await returns.saveReturn(b.db, COMPANY, g, 'gstr3b', '082026')
    await returns.refreshReturnStatus(b.db, g, 'gstr3b', '082026')
    await returns.refreshReturnStatus(b.db, g, 'gstr3b', '082026')
    await expect(returns.requestEvcOtp(b.db, COMPANY, g, 'gstr3b', '082026', TODAY)).rejects.toThrow(/set off/)
    expect((await returns.offsetLiability(b.db, COMPANY, g, '082026')).state).toBe('offset')
    await returns.requestEvcOtp(b.db, COMPANY, g, 'gstr3b', '082026', TODAY)
    const f = await returns.fileReturn(b.db, COMPANY, g, 'gstr3b', '082026', TEST_GSP_OTP, null, TODAY)
    expect(f.arn).toMatch(/^AA270826\d{7}[A-Z]$/)
    expect(readGstFiled(b.db)).toEqual({})
  })

  it('a filing whose answer never reached the books: the portal\'s "already filed" names the ARN and it is recorded', async () => {
    const b = books()
    sale(b)
    const g = await signedIn(b.db)
    await returns.saveReturn(b.db, COMPANY, g, 'gstr1', '082026')
    await returns.refreshReturnStatus(b.db, g, 'gstr1', '082026')
    await returns.refreshReturnStatus(b.db, g, 'gstr1', '082026')
    await returns.requestEvcOtp(b.db, COMPANY, g, 'gstr1', '082026', TODAY)
    // File on the portal directly (as if the app crashed after the portal answered).
    const direct = await g.adapter.fileReturn(g.who, g.session()!, 'gstr1', '082026', { pan: GSTIN.slice(2, 12), otp: TEST_GSP_OTP })
    expect(returns.returnRecord(b.db, g, 'gstr1', '082026')!.state).toBe('processed')
    const rec = await returns.fileReturn(b.db, COMPANY, g, 'gstr1', '082026', TEST_GSP_OTP, 'owner', TODAY)
    expect(rec).toMatchObject({ state: 'filed', arn: direct.ack_num })
    expect(readGstFiledAll(b.db)['2026-08']!.gstr1!.arn).toBe(direct.ack_num)
  })

  it('a quarterly (QRMP) filer is refused before anything is sent', async () => {
    const b = books()
    sale(b)
    b.db.prepare("INSERT INTO meta (key, value) VALUES ('gstProfile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ filing: 'quarterly' }))
    const g = await signedIn(b.db)
    await expect(returns.saveReturn(b.db, COMPANY, g, 'gstr1', '082026')).rejects.toMatchObject({ code: 'gateway_quarterly' })
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM gst_gateway_returns').get()).toEqual({ n: 0 })
  })

  it('with a REAL adapter the filing evidence counts: the ARN from the portal is the filed mark', async () => {
    const b = books()
    sale(b)
    const real = { ...createTestGsp({ now: () => NOW }), id: 'test-gsp' as const, test: false }
    const g = await signedIn(b.db, { adapter: real })
    await returns.saveReturn(b.db, COMPANY, g, 'gstr1', '082026')
    await returns.refreshReturnStatus(b.db, g, 'gstr1', '082026')
    await returns.refreshReturnStatus(b.db, g, 'gstr1', '082026')
    await returns.requestEvcOtp(b.db, COMPANY, g, 'gstr1', '082026', TODAY)
    const f = await returns.fileReturn(b.db, COMPANY, g, 'gstr1', '082026', TEST_GSP_OTP, 'owner', TODAY)
    expect(readGstFiled(b.db)['2026-08']!.gstr1).toMatchObject({ arn: f.arn, date: TODAY, via: { provider: 'test-gsp', test: false } })
    // A real save is what was sent: the GSTR-9 "as filed" snapshot is recorded like an export.
    expect(b.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'gst.exported.gstr1.082026%'").get()).toEqual({ n: 1 })
  })
})

describe('GSTR-2B fetch: stored for the matcher, a simulated one never counts as the portal\'s', () => {
  it('the simulated 2B carries the month\'s GSTIN purchases and the matcher matches the bill (₹40,000 + ₹7,200) — but Home / Taxes / the assistant never see it', async () => {
    const b = books()
    purchase(b)
    const g = await signedIn(b.db)
    const r = await returns.fetchGstr2b(b.db, g, '082026', 'owner')
    expect(r).toMatchObject({ period: '082026', documents: 1, test: true, keptImported: false, fileName: 'GSTR-2B 082026 (Test GSP — simulated)' })
    expect(b.db.prepare("SELECT source, file_name AS f FROM gst2b_statements WHERE period = '082026'").get()).toEqual({ source: 'gateway-test', f: 'GSTR-2B 082026 (Test GSP — simulated)' })
    expect(r.jsonText).toBe(getStatement(b.db, '082026', { includeTest: true })!.jsonText)
    // The GSTR-2B screen's matcher on the fetched JSON: the bill matches.
    const recon = recon2b(b.db, r.jsonText, '2026-08-01', '2026-08-31', recon2bOptionsFrom(getRecon2bTolerances(b.db)))
    expect(recon.result.pairs.filter((p) => p.bucket === 'matched')).toHaveLength(1)
    // A simulation is built from the books, so it always agrees: no reader may take it as the portal's.
    expect(getStatement(b.db, '082026')).toBeNull()
    expect(gst2bMismatches(b.db, '2026-08', { today: TODAY }).statement).toBeNull()
    expect(JSON.parse(auditRows(b.db, 'gst2b_statement')[0]!.a!)).toMatchObject({ period: '082026', documents: 1, source: 'gateway-test' })
  })

  it('a test fetch never replaces a real statement (a file import, or a real fetch); a file import replaces a test one', async () => {
    const b = books()
    purchase(b)
    const fileJson = JSON.stringify({ data: { gstin: GSTIN, rtnprd: '082026', docdata: { b2b: [] } } })
    store2bStatement(b.db, { jsonText: JSON.stringify({ data: { gstin: GSTIN, rtnprd: '082026', docdata: { b2b: [{ ctin: '24AAACS1234C1Z4', inv: [{ inum: 'G-55', idt: '10-08-2026', val: 47200, items: [{ txval: 40000, iamt: 7200 }] }] }] } } }), fileName: 'GSTR2B.json', period: '2026-08' }, 'owner')
    const g = await signedIn(b.db)
    expect(await returns.fetchGstr2b(b.db, g, '082026', 'owner')).toMatchObject({ keptImported: true, fileName: 'GSTR2B.json' })
    expect(getStatement(b.db, '082026')!.fileName).toBe('GSTR2B.json')
    // A real fetch's statement is kept too.
    store2bStatement(b.db, { jsonText: fileJson.replace('082026', '062026'), fileName: 'portal', period: '2026-06', source: 'gateway' }, 'owner')
    expect(await returns.fetchGstr2b(b.db, g, '062026', 'owner')).toMatchObject({ keptImported: true })
    expect(statementSource(b.db, '062026')).toBe('gateway')
    // A test fetch of another month, then a file import over it: the file wins and is a file again.
    await returns.fetchGstr2b(b.db, g, '072026', 'owner')
    expect(statementSource(b.db, '072026')).toBe('gateway-test')
    store2bStatement(b.db, { jsonText: fileJson.replace('082026', '072026'), fileName: 'jul.json', period: '2026-07' }, 'owner')
    expect(b.db.prepare("SELECT source FROM gst2b_statements WHERE period = '072026'").get()).toEqual({ source: null })
    expect(getStatement(b.db, '072026')!.fileName).toBe('jul.json')
  })

  it('a month whose 2B is not generated yet is not_ready; nothing is stored', async () => {
    const b = books()
    const g = await signedIn(b.db)
    await expect(returns.fetchGstr2b(b.db, g, '092026', 'owner')).rejects.toMatchObject({ kind: 'not_ready' })
    expect(getStatement(b.db, '092026')).toBeNull()
  })
})
