// WP 3.5 — contract tests: the REAL nic.ts client against the fake NIC sandbox
// (nicFake.testutil.ts, built to the published API documentation). Proves the crypto, the header
// sets, token caching/expiry/reuse per identity, retry/backoff, error mapping, that nothing
// secret reaches the log or the audit trail, and that the portal's answers land on the voucher
// exactly where edocs.ts reads them. No network, no credentials.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, DrCr } from '@shared/domain'
import { nicCredentialsSchema, type NicCredentials } from '@shared/schemas'
import { buildEwbByIrnPayload } from '@shared/gst/edocs'
import { einvoiceIssues } from '@shared/gst/einvoiceSchema'
import { seededDb, TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { extractEdocInvoices, listSalesInvoices, setTransport } from './edocs'
import { createSecretStore, insecureTestCipher, type SecretStore } from './secrets'
import { createFakeNic, istStamp, type FakeNic } from './nicFake.testutil'
import {
  aesDecrypt, aesEncrypt, authenticate, cancelEwb, cancelIrn, decryptJson, encryptLoginPayload, extendEwb, generateEwbByIrn,
  generateIrn, getIrnDetails, maskNicCredentials, NIC_SECRET_MASK, NicError, nicBackoffMs, parseNicTimestamp, resetNicSession,
  testNicConnection, writeNicCredentials, type NicDeps
} from './nic'

const GSTIN = '27AAPFU0939F1ZV'
const COMPANY: CompanyInfo = { ...TEST_INFO, name: 'Demo Traders', gstin: GSTIN, address: '12 MG Road\nPune 411001' }
const SLUG = 'nic-contract'
const SECRETS = { username: 'api_demo_user', password: 'Sandbox#Pass-9917', clientId: 'AAACL07TXPDEMO', clientSecret: 'cs-Kq81Zz0TopSecret' }

let dir: string
let prevDataDir: string | undefined
let clock: number
let fake: FakeNic
let store: SecretStore
let sleeps: number[]

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'total-nic-contract-'))
  prevDataDir = process.env.TOTAL_DATA_DIR
  process.env.TOTAL_DATA_DIR = dir // log() writes under dataRoot()/logs
})

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.TOTAL_DATA_DIR
  else process.env.TOTAL_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

function newFake(over: Partial<Parameters<typeof createFakeNic>[0]> = {}): FakeNic {
  return createFakeNic({ ...SECRETS, gstins: [GSTIN, '29AAPFU0939F1ZR'], now: () => clock, validateInvoice: einvoiceIssues, ...over })
}

function creds(over: Partial<NicCredentials> = {}): NicCredentials {
  return nicCredentialsSchema.parse({ baseUrlEinvoice: 'https://einv-apisandbox.nic.in', ...SECRETS, publicKeyPem: fake.publicKeyPem, ...over })
}

const deps = (): NicDeps => ({ fetchFn: fake.fetch, store, sleep: async (ms) => { sleeps.push(ms) }, now: () => clock })

beforeEach(() => {
  resetNicSession()
  clock = Date.UTC(2026, 7, 20, 6, 0, 0) // 20 Aug 2026, 11:30 IST
  sleeps = []
  fake = newFake()
  const file = join(dir, `secrets-${Math.random().toString(36).slice(2)}.json`)
  store = createSecretStore({ filePath: () => file, cipher: insecureTestCipher() })
})

// ---------- books ----------

interface Books {
  db: DB
  post(kind: string, date: string, party: number, lines: { ledgerId: number; drCr: DrCr; amount: number }[], inv?: { item: number; qtyMilli: number; ratePaise: number; amount: number; discountPaise?: number; source?: string }[], number?: string): number
  buyer: number; exporter: number; supplier: number; sales: number; purchases: number; igst: number; item: number
}

function books(): Books {
  const db = seededDb()
  writeNicCredentials(db, SLUG, creds(), store)
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vt = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
  const buyer = createLedger(db, { name: 'Karnataka Buyer', groupId: g('Sundry Debtors'), gstin: '29AAACU1234F1ZM', stateCode: '29', address: 'Shop 4, Brigade Road\nBengaluru 560001' }).id
  const exporter = createLedger(db, { name: 'Globex Corporation', groupId: g('Sundry Debtors'), stateCode: '96', address: '1 Infinite Loop, Cupertino', exportType: 'exp_wop' }).id
  const supplier = createLedger(db, { name: 'Pune Supplier', groupId: g('Sundry Creditors'), gstin: '27AAACS1234C1ZY', stateCode: '27', address: 'Unit 9, Chakan\nPune 410501' }).id
  const sales = createLedger(db, { name: 'Sales', groupId: g('Sales Accounts') }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId: g('Purchase Accounts') }).id
  const igst = createLedger(db, { name: 'IGST', groupId: g('Duties & Taxes'), taxType: 'igst' }).id
  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Pcs'").get() as { id: number }).id
  const item = Number(db.prepare("INSERT INTO stock_items (name, unit_id, hsn, gst_rate, opening_qty_milli, opening_value) VALUES ('Laptop 14\"', ?, '84713010', 18, 100000, 300000000)").run(unitId).lastInsertRowid)
  const post: Books['post'] = (kind, date, party, lines, inv = [], number) =>
    saveVoucher(db, {
      voucherTypeId: vt(kind), date, partyLedgerId: party, ...(number ? { number } : {}),
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: inv.map((l) => ({
        stockItemId: l.item, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, amount: l.amount, discountPaise: l.discountPaise ?? 0,
        direction: kind === 'purchase' || kind === 'credit_note' ? 'in' as const : 'out' as const, godownId: null,
        ...(l.source ? { source: { lineUid: l.source, linkType: 'fulfil' as const } } : {})
      })),
      billRefs: [], tds: null
    }).id
  return { db, post, buyer, exporter, supplier, sales, purchases, igst, item }
}

/** An inter-state B2B invoice: 2 × ₹45,000 − ₹1,000 discount = ₹89,000 + 18 % IGST. */
function b2bInvoice(b: Books, number = 'INV/26-27/0001'): number {
  return b.post('sales', '2026-08-15', b.buyer, [
    { ledgerId: b.buyer, drCr: 'dr', amount: 10_502_000 },
    { ledgerId: b.sales, drCr: 'cr', amount: 8_900_000 },
    { ledgerId: b.igst, drCr: 'cr', amount: 1_602_000 }
  ], [{ item: b.item, qtyMilli: 2000, ratePaise: 4_500_000, amount: 8_900_000, discountPaise: 100_000 }], number)
}

const voucherRow = (db: DB, id: number) =>
  db.prepare('SELECT irn, irn_ack_no AS ackNo, irn_ack_date AS ackDate, ewb_no AS ewbNo, ewb_valid_upto AS ewbValidUpto FROM vouchers WHERE id = ?').get(id) as
    { irn: string | null; ackNo: string | null; ackDate: string | null; ewbNo: string | null; ewbValidUpto: string | null }

const authCalls = (): typeof fake.calls => fake.calls.filter((c) => c.path === '/eivital/v1.04/auth')

// ---------- crypto ----------

describe('crypto per the published samples', () => {
  it('login: RSA PKCS#1 v1.5 over Base64(JSON) — the fake decrypts it with the matching private key', async () => {
    await authenticate(creds(), GSTIN, undefined, deps())
    const login = authCalls()[0]!
    expect(login.plain).toEqual({ UserName: SECRETS.username, ForceRefreshAccessToken: false, AppKeyBytes: 32 })
    // The wire body is one RSA block (2048-bit key → 256 bytes), base64 — never the JSON itself.
    const { Data } = JSON.parse(login.body!) as { Data: string }
    expect(Buffer.from(Data, 'base64')).toHaveLength(256)
    expect(login.body).not.toContain(SECRETS.password)
  })

  it('AES-256-ECB/PKCS#7 round-trips, and a SEK-encrypted response decrypts (with or without a Base64 layer)', () => {
    const key = crypto.randomBytes(32)
    const enc = aesEncrypt(key, '{"a":"ü€"}')
    expect(Buffer.from(enc, 'base64').length % 16).toBe(0)
    expect(aesDecrypt(key, enc).toString('utf8')).toBe('{"a":"ü€"}')
    expect(decryptJson(key, enc)).toEqual({ a: 'ü€' })
    expect(decryptJson(key, aesEncrypt(key, Buffer.from('{"b":1}').toString('base64')))).toEqual({ b: 1 })
    // Interop with a plain node cipher (= Java AES/ECB/PKCS5Padding).
    const c = crypto.createCipheriv('aes-256-ecb', key, null)
    const theirs = Buffer.concat([c.update('{"x":2}'), c.final()]).toString('base64')
    expect(decryptJson(key, theirs)).toEqual({ x: 2 })
  })

  it('the SEK is decrypted with the AppKey: the session can read what the fake encrypts with its SEK', async () => {
    const s = await authenticate(creds(), GSTIN, undefined, deps())
    expect(s.sek).toHaveLength(32)
    expect(decryptJson(s.sek, aesEncrypt(s.sek, '{"ok":true}'))).toEqual({ ok: true })
  })

  it('a malformed public key is a config error, before anything is sent', async () => {
    await expect(authenticate(creds({ publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----' }), GSTIN, undefined, deps()))
      .rejects.toThrow(/NIC public key is not a valid RSA public key/)
    expect(fake.calls).toHaveLength(0)
  })

  it('TokenExpiry is read as IST', () => {
    expect(parseNicTimestamp('2026-08-20 12:30:00')).toBe(Date.UTC(2026, 7, 20, 7, 0, 0))
    expect(parseNicTimestamp('garbage')).toBeNull()
    expect(istStamp(Date.UTC(2026, 7, 20, 7, 0, 0))).toBe('2026-08-20 12:30:00')
  })
})

// ---------- headers ----------

describe('header sets', () => {
  it('auth: client_id / client_secret / Gstin; IRN calls add user_name + AuthToken; ewayapi uses client-id / client-secret / Gstin / authtoken', async () => {
    const b = books()
    const id = b2bInvoice(b)
    await generateIrn(b.db, SLUG, COMPANY, id, deps())
    setTransport(b.db, id, { transMode: '1', transDistanceKm: 840, transporterId: null, transporterName: null, transDocNo: null, transDocDate: null, vehicleNo: 'MH12AB1234', vehicleType: 'R', shipToName: null, shipToGstin: null, shipToAddr1: null, shipToAddr2: null, shipToPlace: null, shipToPincode: null, shipToState: null })
    await generateEwbByIrn(b.db, SLUG, COMPANY, id, deps())
    await cancelEwb(b.db, SLUG, COMPANY, id, 'data_entry_mistake', 'wrong vehicle', deps())
    const [auth, gen, ewb, cnl] = fake.calls
    expect(Object.keys(auth!.headers).sort()).toEqual(['Content-Type', 'Gstin', 'client_id', 'client_secret'])
    expect(auth!.headers).toMatchObject({ client_id: SECRETS.clientId, client_secret: SECRETS.clientSecret, Gstin: GSTIN })
    for (const c of [gen!, ewb!]) {
      expect(Object.keys(c.headers).sort()).toEqual(['AuthToken', 'Content-Type', 'Gstin', 'client_id', 'client_secret', 'user_name'])
      expect(c.headers.user_name).toBe(SECRETS.username)
    }
    expect(Object.keys(cnl!.headers).sort()).toEqual(['Content-Type', 'Gstin', 'authtoken', 'client-id', 'client-secret'])
    expect(cnl!.plain).toEqual({ action: 'CANEWB', ewbNo: expect.any(Number), cancelRsnCode: 3, cancelRmrk: 'wrong vehicle' }) // EWB code 3 = data entry mistake
    expect(fake.calls.map((c) => c.path)).toEqual(['/eivital/v1.04/auth', '/eicore/v1.03/Invoice', '/eiewb/v1.03/ewaybill', '/ewaybillapi/v1.03/ewayapi'])
    // Secrets never in a URL.
    for (const c of fake.calls) expect(c.path).not.toMatch(new RegExp(`${SECRETS.password}|${SECRETS.clientSecret}`))
  })
})

// ---------- token cache ----------

describe('token caching, expiry and reuse per identity', () => {
  it('one login serves many calls; concurrent calls share one handshake', async () => {
    const c = creds()
    await Promise.all([authenticate(c, GSTIN, undefined, deps()), authenticate(c, GSTIN, undefined, deps()), authenticate(c, GSTIN, undefined, deps())])
    await authenticate(c, GSTIN, undefined, deps())
    expect(authCalls()).toHaveLength(1)
  })

  it('refreshes inside the last 10 minutes with ForceRefreshAccessToken, logs in afresh after expiry (sandbox: 60 min)', async () => {
    const c = creds()
    const s1 = await authenticate(c, GSTIN, undefined, deps())
    clock += 45 * 60 * 1000
    expect((await authenticate(c, GSTIN, undefined, deps())).authToken).toBe(s1.authToken) // still cached
    clock += 8 * 60 * 1000 // 53 min: inside the 10-minute window
    const s2 = await authenticate(c, GSTIN, undefined, deps())
    expect(authCalls()).toHaveLength(2)
    expect(authCalls()[1]!.plain).toMatchObject({ ForceRefreshAccessToken: true })
    expect(s2.authToken).not.toBe(s1.authToken)
    clock += 2 * 60 * 60 * 1000 // well past expiry
    await authenticate(c, GSTIN, undefined, deps())
    expect(authCalls()[2]!.plain).toMatchObject({ ForceRefreshAccessToken: false })
  })

  it('a token per identity: another GSTIN gets its own login, and switching back reuses the first', async () => {
    const c = creds()
    const a = await authenticate(c, GSTIN, undefined, deps())
    const k = await authenticate(c, '29AAPFU0939F1ZR', undefined, deps())
    expect(k.authToken).not.toBe(a.authToken)
    expect((await authenticate(c, GSTIN, undefined, deps())).authToken).toBe(a.authToken)
    expect(authCalls().map((x) => x.headers.Gstin)).toEqual([GSTIN, '29AAPFU0939F1ZR'])
  })

  it('a token revoked server-side (1005 Invalid Token) is dropped and the call retried once on a fresh login', async () => {
    const b = books()
    await authenticate(creds(), GSTIN, undefined, deps())
    fake.revokeTokens()
    const r = await generateIrn(b.db, SLUG, COMPANY, b2bInvoice(b), deps())
    expect(r.irn).toMatch(/^[0-9a-f]{64}$/)
    expect(fake.calls.map((c) => c.path)).toEqual(['/eivital/v1.04/auth', '/eicore/v1.03/Invoice', '/eivital/v1.04/auth', '/eicore/v1.03/Invoice'])
  })

  it('the connection test always performs a fresh handshake and reports the token expiry; it writes nothing', async () => {
    const b = books()
    const auditBefore = (b.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
    await authenticate(creds(), GSTIN, undefined, deps())
    const r = await testNicConnection(b.db, SLUG, COMPANY, deps())
    expect(r).toEqual({ ok: true, endpoint: 'https://einv-apisandbox.nic.in', sandbox: true, tokenExpiry: istStamp(clock + 60 * 60 * 1000) })
    expect(authCalls()).toHaveLength(2)
    expect(fake.calls.every((c) => c.path === '/eivital/v1.04/auth')).toBe(true) // no filing
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(auditBefore)
  })
})

// ---------- retry / backoff ----------

describe('retry with backoff on 5xx and dropped connections', () => {
  it('two 503s then success: three attempts, 500 ms then 1 s backoff', async () => {
    fake.failNext(2, 503)
    await authenticate(creds(), GSTIN, undefined, deps())
    expect(fake.calls.map((c) => c.status)).toEqual([503, 503, 200])
    expect(sleeps).toEqual([nicBackoffMs(0), nicBackoffMs(1)])
    expect(sleeps).toEqual([500, 1000])
  })

  it('a dropped connection is retried too', async () => {
    fake.dropNext(1)
    await authenticate(creds(), GSTIN, undefined, deps())
    expect(fake.calls.map((c) => c.status)).toEqual([0, 200])
  })

  it('gives up after 3 attempts with a plain message; a 4xx/JSON rejection is never retried', async () => {
    fake.failNext(3, 502)
    const err = await authenticate(creds(), GSTIN, undefined, deps()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NicError)
    expect((err as NicError).kind).toBe('network')
    expect((err as Error).message).toBe('The NIC portal is not responding (HTTP 502 after 3 tries) — try again later')
    fake.calls.length = 0
    fake.dropNext(3)
    await expect(authenticate(creds(), GSTIN, undefined, deps())).rejects.toThrow(/Could not reach the NIC portal after 3 tries/)
    fake.calls.length = 0
    sleeps.length = 0
    await expect(authenticate(creds({ password: 'wrong' }), GSTIN, undefined, deps())).rejects.toThrow(NicError)
    expect(fake.calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })
})

// ---------- error mapping ----------

describe('NIC error codes map to user messages', () => {
  const cases: [string, Partial<NicCredentials>, string | undefined, RegExp][] = [
    ['wrong password (1019)', { password: 'nope' }, undefined, /^NIC rejected the API password \(NIC 1019: Incorrect Password\)$/],
    ['unknown user (1017)', { username: 'ghost' }, undefined, /NIC does not know this API username \(NIC 1017/],
    ['wrong client secret (1010)', { clientSecret: 'bad' }, undefined, /NIC rejected the client ID \/ client secret \(NIC 1010/],
    ['GSTIN not linked (1015)', {}, '24AAPFU0939F1Z1', /not linked to the API user.*\(NIC 1015/],
    ['wrong public key (1013)', { publicKeyPem: crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).publicKey }, undefined, /check the NIC public key.*\(NIC 1013/]
  ]
  for (const [name, over, gstin, re] of cases) {
    it(name, async () => {
      await expect(authenticate(creds(over), gstin ?? GSTIN, undefined, deps())).rejects.toThrow(re)
    })
  }

  it('messages never carry the secrets', async () => {
    const err = (await authenticate(creds({ password: 'nope' }), GSTIN, undefined, deps()).catch((e: unknown) => e)) as Error
    expect(err.message).not.toContain('nope')
    expect(err.message).not.toContain(SECRETS.clientSecret)
  })
})

// ---------- end-to-end filing, persistence ----------

describe('IRN and e-way bill: payloads, persistence, cancel, extend', () => {
  it('generates an IRN, stores IRN / ack no / ack date where edocs.ts reads them, returns a verifiable signed QR', async () => {
    const b = books()
    const id = b2bInvoice(b)
    const r = await generateIrn(b.db, SLUG, COMPANY, id, deps())
    const rec = fake.irns.get(r.irn)!
    expect(rec).toBeDefined()
    expect(voucherRow(b.db, id)).toEqual({ irn: rec.irn, ackNo: rec.ackNo, ackDate: rec.ackDt, ewbNo: null, ewbValidUpto: null })
    expect(r).toMatchObject({ irn: rec.irn, ackNo: rec.ackNo, ackDate: rec.ackDt, recovered: false })
    // The request the portal decrypted is exactly the builder's document, and it passes the schema.
    const sent = fake.calls.find((c) => c.path === '/eicore/v1.03/Invoice')!.plain as Record<string, any>
    expect(einvoiceIssues(sent)).toEqual([])
    expect(sent.ItemList[0]).toMatchObject({ PrdDesc: "Laptop 14''", TotAmt: 90000, Discount: 1000, AssAmt: 89000, IgstAmt: 16020 })
    expect(sent.SellerDtls).toMatchObject({ Addr1: '12 MG Road', Loc: 'Pune', Pin: 411001 })
    // Signed QR: a JWT the fake signed, whose data names this IRN.
    const qr = fake.verifyJwt(r.signedQrCode!)
    expect(JSON.parse(String(qr.data))).toMatchObject({ Irn: r.irn, DocNo: 'INV/26-27/0001', SellerGstin: GSTIN, ItemCnt: 1 })
    expect(JSON.parse(String(fake.verifyJwt(r.signedInvoice!).data))).toMatchObject({ Irn: r.irn })
    // edocs.ts sees the IRN (the print QR payload and the e-docs list key off it).
    expect(extractEdocInvoices(b.db, COMPANY, '2026-08-01', '2026-08-31', id)[0]!.irn).toBe(r.irn)
    expect(listSalesInvoices(b.db, '2026-08-01', '2026-08-31', COMPANY).find((x) => x.voucherId === id)!.irn).toBe(r.irn)
    // Audit: whole before/after, no secrets.
    const audit = b.db.prepare("SELECT before_json AS b, after_json AS a FROM audit_log WHERE entity = 'voucher' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(id) as { b: string; a: string }
    expect(JSON.parse(audit.b)).toMatchObject({ irn: null, irnAckNo: null })
    expect(JSON.parse(audit.a)).toMatchObject({ irn: r.irn, irnAckNo: rec.ackNo, irnAckDate: rec.ackDt })
    // Re-generating locally is refused before any call.
    await expect(generateIrn(b.db, SLUG, COMPANY, id, deps())).rejects.toThrow('This invoice already has an IRN')
    // Get IRN details round-trips.
    expect(await getIrnDetails(b.db, SLUG, COMPANY, r.irn, deps())).toMatchObject({ Irn: r.irn, Status: 'ACT', SignedQRCode: r.signedQrCode })
  })

  it('a lost response is recovered: NIC 2150 (duplicate) with the existing IRN in InfoDtls is adopted', async () => {
    const b = books()
    const id = b2bInvoice(b)
    const first = await generateIrn(b.db, SLUG, COMPANY, id, deps())
    b.db.prepare('UPDATE vouchers SET irn = NULL, irn_ack_no = NULL, irn_ack_date = NULL WHERE id = ?').run(id) // as if the reply never arrived
    const again = await generateIrn(b.db, SLUG, COMPANY, id, deps())
    expect(again).toMatchObject({ irn: first.irn, ackNo: first.ackNo, ackDate: first.ackDate, recovered: true, signedQrCode: null })
    expect(voucherRow(b.db, id).irn).toBe(first.irn)
  })

  it('e-way bill by IRN: the transport payload, EWB no and valid-until stored; cancel EWB, cancel IRN, no re-use of the number', async () => {
    const b = books()
    const id = b2bInvoice(b)
    const { irn } = await generateIrn(b.db, SLUG, COMPANY, id, deps())
    await expect(generateEwbByIrn(b.db, SLUG, COMPANY, id, deps())).rejects.toThrow(/vehicle number, transport document or transporter ID/)
    setTransport(b.db, id, { transMode: '1', transDistanceKm: 840, transporterId: null, transporterName: 'VRL Logistics', transDocNo: null, transDocDate: null, vehicleNo: 'mh 12 ab 1234', vehicleType: 'R', shipToName: null, shipToGstin: null, shipToAddr1: null, shipToAddr2: null, shipToPlace: null, shipToPincode: null, shipToState: null })
    const e = await generateEwbByIrn(b.db, SLUG, COMPANY, id, deps())
    const ewbCall = fake.calls.find((c) => c.path === '/eiewb/v1.03/ewaybill')!
    const [inv] = extractEdocInvoices(b.db, COMPANY, '2026-08-01', '2026-08-31', id)
    expect(ewbCall.plain).toEqual(buildEwbByIrnPayload(irn, inv!))
    expect(ewbCall.plain).toEqual({ Irn: irn, Distance: 840, TransMode: '1', TransName: 'VRL Logistics', VehNo: 'MH12AB1234', VehType: 'R' })
    const rec = fake.ewbs.get(Number(e.ewbNo))!
    expect(voucherRow(b.db, id)).toMatchObject({ irn, ewbNo: String(rec.ewbNo), ewbValidUpto: rec.validTill })
    expect(rec.validTill).toBe('2026-08-25 23:59:00') // 840 km → 5 days, ends 23:59 IST
    expect(listSalesInvoices(b.db, '2026-08-01', '2026-08-31', COMPANY).find((x) => x.voucherId === id)!.ewbNo).toBe(e.ewbNo)

    // Extend inside the ±8 h window around expiry.
    await expect(extendEwb(b.db, SLUG, COMPANY, id, { reasonCode: 5, remarks: 'Accident', fromPlace: 'Hubballi', fromStateCode: 29, fromPincode: 580020, remainingDistanceKm: 400, transMode: '1', vehicleNo: 'KA25AB9999' }, deps()))
      .rejects.toThrow(/NIC 240/) // too early
    clock = rec.validTillMs! - 2 * 3600 * 1000
    const ext = await extendEwb(b.db, SLUG, COMPANY, id, { reasonCode: 5, remarks: 'Accident', fromPlace: 'Hubballi', fromStateCode: 29, fromPincode: 580020, remainingDistanceKm: 400, transMode: '1', vehicleNo: 'KA25AB9999' }, deps())
    expect(ext.validUpto).toBe('27/08/2026 11:59:00 PM')
    expect(fake.calls.at(-1)!.plain).toMatchObject({ action: 'EXTENDVALIDITY', consignmentStatus: 'M', transitType: '', extnRsnCode: 5, fromState: 29 })
    expect(voucherRow(b.db, id).ewbValidUpto).toBe('27/08/2026 11:59:00 PM')

    // The IRN can't be cancelled while the EWB is active (local check mirrors NIC 2230).
    await expect(cancelIrn(b.db, SLUG, COMPANY, id, 'order_cancelled', '', deps())).rejects.toThrow(/Cancel the e-way bill first/)
    clock = Date.UTC(2026, 7, 20, 9, 0, 0)
    await cancelEwb(b.db, SLUG, COMPANY, id, 'order_cancelled', 'order cancelled', deps())
    expect(fake.calls.at(-1)!.plain).toMatchObject({ cancelRsnCode: 2 }) // EWB: 2 = order cancelled
    expect(voucherRow(b.db, id)).toMatchObject({ ewbNo: null, ewbValidUpto: null })
    const c = await cancelIrn(b.db, SLUG, COMPANY, id, 'order_cancelled', 'buyer cancelled the order', deps())
    expect(fake.calls.at(-1)!.plain).toEqual({ Irn: irn, CnlRsn: '3', CnlRem: 'buyer cancelled the order' }) // IRN: 3 = order cancelled
    expect(c).toEqual({ irn, cancelDate: fake.irns.get(irn)!.cancelDate })
    expect(voucherRow(b.db, id)).toEqual({ irn: null, ackNo: null, ackDate: null, ewbNo: null, ewbValidUpto: null })
    const audit = b.db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'voucher' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(id) as { a: string }
    expect(JSON.parse(audit.a)).toMatchObject({ irn: null, cancelledIrn: irn, irnCancelReason: 'order_cancelled' })
    // NIC 2278: the cancelled document number can't be e-invoiced again.
    await expect(generateIrn(b.db, SLUG, COMPANY, id, deps())).rejects.toThrow(/cancelled number cannot be e-invoiced again.*\(NIC 2278/)
  })

  it('IRN cancellation after 24 h maps NIC 2270', async () => {
    const b = books()
    const id = b2bInvoice(b)
    await generateIrn(b.db, SLUG, COMPANY, id, deps())
    clock += 25 * 3600 * 1000
    await expect(cancelIrn(b.db, SLUG, COMPANY, id, 'data_entry_mistake', '', deps())).rejects.toThrow(/24-hour window to cancel this IRN has passed.*\(NIC 2270/)
    expect(voucherRow(b.db, id).irn).not.toBeNull()
  })

  it('an export without a GSTIN is e-invoiced as URP / 96 / 999999 with zero IGST (export without payment)', async () => {
    const b = books()
    const id = b.post('sales', '2026-08-15', b.exporter, [
      { ledgerId: b.exporter, drCr: 'dr', amount: 9_000_000 }, { ledgerId: b.sales, drCr: 'cr', amount: 9_000_000 }
    ], [{ item: b.item, qtyMilli: 2000, ratePaise: 4_500_000, amount: 9_000_000 }], 'EXP-1')
    await generateIrn(b.db, SLUG, COMPANY, id, deps())
    const sent = fake.calls.find((c) => c.path === '/eicore/v1.03/Invoice')!.plain as Record<string, any>
    expect(sent.TranDtls.SupTyp).toBe('EXPWOP')
    expect(sent.BuyerDtls).toMatchObject({ Gstin: 'URP', Pos: '96', Stcd: '96', Pin: 999999 })
    expect(sent.ItemList[0]).toMatchObject({ GstRt: 18, IgstAmt: 0 })
    expect(sent.ValDtls).toMatchObject({ IgstVal: 0, TotInvVal: 90000, RndOffAmt: 0 })
  })

  it('a purchase-side debit note and a binned voucher are refused locally', async () => {
    const b = books()
    const dn = b.post('debit_note', '2026-08-15', b.supplier, [
      { ledgerId: b.supplier, drCr: 'dr', amount: 1_000_000 }, { ledgerId: b.purchases, drCr: 'cr', amount: 1_000_000 }
    ], [], 'DN-1')
    await expect(generateIrn(b.db, SLUG, COMPANY, dn, deps())).rejects.toThrow(/purchase return/)
    const id = b2bInvoice(b)
    b.db.prepare("UPDATE vouchers SET deleted_at = '2026-08-16' WHERE id = ?").run(id)
    await expect(generateIrn(b.db, SLUG, COMPANY, id, deps())).rejects.toThrow(/in the bin/)
    expect(fake.calls).toHaveLength(0)
  })

  it('pre-flight: an invoice the schema rejects is refused locally (no call), with the reason', async () => {
    const b = books()
    const id = b2bInvoice(b, '0042') // DocDtls.No cannot start with 0
    await expect(generateIrn(b.db, SLUG, COMPANY, id, deps())).rejects.toThrow(/would be rejected by NIC: DocDtls\.No/)
    await expect(generateIrn(b.db, SLUG, { ...COMPANY, address: '12 MG Road, Pune' }, b2bInvoice(b, 'INV-2'), deps()))
      .rejects.toThrow(/SellerDtls\.Pin: PIN code must be 6 digits/)
    expect(fake.calls).toHaveLength(0)
  })

  it('an invoice whose goods moved on a delivery challan is e-invoiced, but gets no second e-way bill', async () => {
    const b = books()
    const dcId = b.post('delivery_note', '2026-08-14', b.buyer, [], [{ item: b.item, qtyMilli: 2000, ratePaise: 4_500_000, amount: 9_000_000 }], 'DC-7')
    b.db.prepare("UPDATE vouchers SET ewb_no = '391000000777' WHERE id = ?").run(dcId)
    const lineUid = (b.db.prepare('SELECT line_uid AS u FROM inventory_lines WHERE voucher_id = ?').get(dcId) as { u: string }).u
    const id = b.post('sales', '2026-08-15', b.buyer, [
      { ledgerId: b.buyer, drCr: 'dr', amount: 10_620_000 }, { ledgerId: b.sales, drCr: 'cr', amount: 9_000_000 }, { ledgerId: b.igst, drCr: 'cr', amount: 1_620_000 }
    ], [{ item: b.item, qtyMilli: 2000, ratePaise: 4_500_000, amount: 9_000_000, source: lineUid }], 'INV-DC-7')
    expect((b.db.prepare('SELECT moves_stock AS m FROM inventory_lines WHERE voucher_id = ?').get(id) as { m: number }).m).toBe(0)
    const { irn } = await generateIrn(b.db, SLUG, COMPANY, id, deps())
    expect(irn).toMatch(/^[0-9a-f]{64}$/)
    b.db.prepare("UPDATE vouchers SET vehicle_no = 'MH12AB1234' WHERE id = ?").run(id)
    await expect(generateEwbByIrn(b.db, SLUG, COMPANY, id, deps())).rejects.toThrow(/Goods moved on challan DC-7 \(EWB 391000000777\)/)
  })
})

// ---------- secrets ----------

describe('secrets stay secret', () => {
  it('nic:get masks password and client secret', () => {
    const m = maskNicCredentials(creds())
    expect(m).toMatchObject({ username: SECRETS.username, clientId: SECRETS.clientId, password: NIC_SECRET_MASK, clientSecret: NIC_SECRET_MASK })
    expect(JSON.stringify(m)).not.toContain(SECRETS.password)
    expect(JSON.stringify(m)).not.toContain(SECRETS.clientSecret)
    expect(maskNicCredentials(creds({ password: '', clientSecret: '' }))).toMatchObject({ password: '', clientSecret: '' })
  })

  it('after a full filing cycle (incl. failures) no secret, token or session key is in the log or the audit trail', async () => {
    const b = books()
    const id = b2bInvoice(b)
    await authenticate(creds({ password: 'wrong-pw-xyz' }), GSTIN, undefined, deps()).catch(() => undefined)
    fake.failNext(3)
    await generateIrn(b.db, SLUG, COMPANY, id, deps()).catch(() => undefined)
    const r = await generateIrn(b.db, SLUG, COMPANY, id, deps())
    const s = await authenticate(creds(), GSTIN, undefined, deps())
    await testNicConnection(b.db, SLUG, COMPANY, deps())
    const logs = join(dir, 'logs')
    expect(existsSync(logs)).toBe(true)
    const logText = readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('\n')
    expect(logText).toContain('nic-irn-generated')
    const audit = JSON.stringify(b.db.prepare('SELECT * FROM audit_log').all())
    for (const secret of [SECRETS.password, SECRETS.clientSecret, 'wrong-pw-xyz', s.authToken, s.sek.toString('base64'), r.signedQrCode!]) {
      expect(logText).not.toContain(secret)
      expect(audit).not.toContain(secret)
    }
    // And the meta row holds no secret either.
    expect((b.db.prepare("SELECT value FROM meta WHERE key = 'nic'").get() as { value: string }).value).not.toContain(SECRETS.password)
  })
})
