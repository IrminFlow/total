/**
 * A fake NIC sandbox (WP 3.5) — an injectable `fetch` that speaks the published e-Invoice (IRP)
 * API contract, so the REAL client in nic.ts can be exercised end to end without credentials.
 * Used by nicContract.dbtest.ts (in-process) and by scripts/e2e/13-nic-masking.mjs (wrapped in a
 * local HTTP server — this file is plain, type-strippable TypeScript with no imports beyond
 * node:crypto so Node can load it directly; keep it that way: no enums, no parameter properties,
 * no path aliases).
 *
 * Contract sources (all read 2026-10-07):
 *  [AUTH]  https://einv-apisandbox.nic.in/version1.04/authentication.html
 *  [JAVA]  https://einv-apisandbox.nic.in/sample-code-in-java.html   (RSA/ECB/PKCS1PADDING over
 *          Base64(JSON); AES/ECB/PKCS5Padding; SEK decrypted with the AppKey)
 *  [CSHARP] https://einv-apisandbox.nic.in/sample-code-in-c-sharp-dot-net.html (rsa.Encrypt(…, false)
 *          = PKCS#1 v1.5; auth response Data deserialised as an object)
 *  [GEN]   https://einv-apisandbox.nic.in/version1.03/generate-irn.html
 *  [CNL]   https://einv-apisandbox.nic.in/version1.03/cancel-irn.html
 *  [GET]   https://einv-apisandbox.nic.in/version1.03/get-eInvoicedetails.html
 *  [EWB]   https://einv-apisandbox.nic.in/version1.03/ewaybill-generation-irn.html
 *  [CEWB]  https://einv-apisandbox.nic.in/version1.03/cancel-eway-bill.html
 *  [EXT]   https://docs.ewaybillgst.gov.in/apidocs/version1.03/extend-validity.html
 *  [IRN]   https://einv-apisandbox.nic.in/irn.html (IRN = SHA-256 of GSTIN + FY + doc type + doc no)
 *  [ERR]   https://einvoice1.gst.gov.in/others/geterrorcodes/VITAL | /INV | /EWB
 *
 * UNVERIFIED (the fake follows the documents; the real sandbox may differ):
 *  - The URL paths: the reference pages write `<URL>/v1.04/auth`, `<URL>/api/Invoice`; the
 *    /eivital, /eicore, /eiewb, /ewaybillapi prefixes are the conventional NIC-direct layout.
 *  - Header spelling: the API pages list client_id / client_secret / Gstin / user_name /
 *    AuthToken, the Java/C# samples use client-id / client-secret / gstin, and the cancel-EWB page
 *    lists client-id / client-secret / Gstin / authtoken. The fake accepts either spelling.
 *  - ErrorDetails encoding: [GEN] says "Base 64 encoded string" of the error array, [AUTH] says
 *    "<Errors JSON>". The fake sends auth errors as a JSON array and the rest base64-encoded so
 *    the client's decoder is exercised both ways.
 *  - The 2150 duplicate response's InfoDtls shape ([{InfCd:'DUPIRN', Desc:{AckNo,AckDt,Irn}}]).
 *  - Codes for "IRN not found" (3001 used — "Requested data is not available") and "already
 *    cancelled" (9999 used); the EWB-API extend-validity window error code (the generic 240).
 *  - Timestamps are rendered in IST (UTC+05:30); the documents give only the format.
 *  - The signed JWTs are signed by the fake's own RSA key, not NIC's.
 */
import crypto from 'node:crypto'

export interface FakeRequestInit { method: string; headers: Record<string, string>; body?: string }
export interface FakeResponse { status: number; json(): Promise<unknown> }

export interface FakeNicOptions {
  username: string
  password: string
  clientId: string
  clientSecret: string
  /** GSTINs enabled for e-invoicing under these credentials ([AUTH] "Only taxpayer GSTINs enabled
   *  for e-invoicing are allowed"). */
  gstins: string[]
  /** Token validity: 360 min in production, 60 min on the sandbox ([AUTH]). Default 60 min. */
  tokenTtlMs?: number
  /** Clock (ms since epoch) — injectable so tests can run past token expiry and the 24 h windows. */
  now?: () => number
  /** Optional extra document validation (e.g. the app's Zod schema) — failures become an
   *  error response with code 'SCHEMA'. */
  validateInvoice?: (doc: unknown) => string[]
}

export interface FakeCall {
  method: string
  path: string
  headers: Record<string, string>
  /** Raw request body as sent (still encrypted). */
  body: string | undefined
  /** The decrypted request JSON, when the fake could decrypt it. */
  plain?: unknown
  status: number
}

interface TokenRec { token: string; sek: Buffer; user: string; gstin: string; clientId: string; issuedAt: number; expiresAt: number }
interface IrnRec { irn: string; gstin: string; ackNo: string; ackDt: string; createdAt: number; status: 'ACT' | 'CNL'; doc: Record<string, unknown>; signedInvoice: string; signedQr: string; ewbNo: number | null; cancelDate?: string }
interface EwbRec { ewbNo: number; irn: string; gstin: string; createdAt: number; ewbDt: string; validTill: string | null; validTillMs: number | null; status: 'ACT' | 'CNL'; distance: number }

const IST_MS = 330 * 60 * 1000
const pad = (n: number): string => String(n).padStart(2, '0')
/** 'yyyy-MM-dd HH:mm:ss' in IST ([AUTH] TokenExpiry, [GEN] AckDt). */
export function istStamp(ms: number): string {
  return new Date(ms + IST_MS).toISOString().slice(0, 19).replace('T', ' ')
}
/** 'dd/MM/yyyy hh:mm:ss AM' in IST (EWB-API style, [CEWB]/[EXT] samples). */
function ewbStamp(ms: number): string {
  const d = new Date(ms + IST_MS)
  const h = d.getUTCHours()
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(h % 12 || 12)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`
}

const b64 = (b: Buffer | string): string => (typeof b === 'string' ? Buffer.from(b, 'utf8') : b).toString('base64')
function aesEnc(key: Buffer, plain: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-256-ecb', key, null)
  return Buffer.concat([c.update(plain), c.final()])
}
function aesDec(key: Buffer, data: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-ecb', key, null)
  return Buffer.concat([d.update(data), d.final()])
}
function b64url(s: string | Buffer): string {
  return (typeof s === 'string' ? Buffer.from(s) : s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Error envelope. Auth errors carry the array as JSON, everything else base64 (see header). */
function errEnvelope(errors: { ErrorCode: string; ErrorMessage: string }[], base64: boolean, info: unknown = null): Record<string, unknown> {
  return { Status: 0, Data: null, ErrorDetails: base64 ? b64(JSON.stringify(errors)) : errors, InfoDtls: info }
}

/** Header lookup tolerant of case and of '_' vs '-' (see UNVERIFIED in the header comment). */
function header(h: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase().replace(/-/g, '_')
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase().replace(/-/g, '_') === want) return v
  return undefined
}

/** Financial year of a dd/MM/yyyy date: '2026-27'. */
function finYear(dt: string): string {
  const [, m, y] = dt.split('/').map(Number) as [number, number, number]
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

export interface FakeNic {
  /** RSA public key (SPKI PEM) the client must encrypt the login with — goes in Settings → NIC. */
  publicKeyPem: string
  fetch: (url: string, init: FakeRequestInit) => Promise<FakeResponse>
  calls: FakeCall[]
  /** Answer the next `count` requests with HTTP `status` (default 503) and a non-JSON body. */
  failNext(count: number, status?: number): void
  /** Make the next request throw like a dropped connection. */
  dropNext(count: number): void
  /** Invalidate every issued token server-side (next authenticated call → 1005 Invalid Token). */
  revokeTokens(): void
  irns: Map<string, IrnRec>
  ewbs: Map<number, EwbRec>
  /** Verify a signed JWT the fake issued and return its payload (tests: "is this a real JWT?"). */
  verifyJwt(jwt: string): Record<string, unknown>
}

export function createFakeNic(opts: FakeNicOptions): FakeNic {
  const now = opts.now ?? Date.now
  const ttl = opts.tokenTtlMs ?? 60 * 60 * 1000
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const signKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const signPub = crypto.createPublicKey(signKey)
  const tokens = new Map<string, TokenRec>()
  const irns = new Map<string, IrnRec>()
  const ewbs = new Map<number, EwbRec>()
  const calls: FakeCall[] = []
  let failQueue: number[] = []
  let drops = 0
  let ackSeq = 112610000000000
  let ewbSeq = 391000000000
  let lastLogin: Record<string, unknown> | undefined

  const jwt = (payload: Record<string, unknown>): string => {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'FAKE-NIC-SANDBOX', typ: 'JWT' }))
    const body = b64url(JSON.stringify(payload))
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signKey)
    return `${head}.${body}.${b64url(sig)}`
  }
  const verifyJwt = (token: string): Record<string, unknown> => {
    const [h, p, s] = token.split('.') as [string, string, string]
    const fromUrl = (x: string): Buffer => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), signPub, fromUrl(s))) throw new Error('bad JWT signature')
    return JSON.parse(fromUrl(p).toString('utf8')) as Record<string, unknown>
  }

  const ok = (sek: Buffer, data: unknown): Record<string, unknown> =>
    ({ Status: 1, Data: b64(aesEnc(sek, Buffer.from(JSON.stringify(data), 'utf8'))), ErrorDetails: null, InfoDtls: null })
  const fail = (code: string, msg: string, info: unknown = null): Record<string, unknown> =>
    errEnvelope([{ ErrorCode: code, ErrorMessage: msg }], true, info)

  /** Decrypt a SEK-encrypted Data string; tolerant of an extra Base64 layer (EWB "Encrypt(Base64(JSON))"). */
  const decryptData = (sek: Buffer, data: string): unknown => {
    const text = aesDec(sek, Buffer.from(data, 'base64')).toString('utf8')
    try { return JSON.parse(text) } catch { return JSON.parse(Buffer.from(text, 'base64').toString('utf8')) }
  }

  function auth(h: Record<string, string>, body: string | undefined): Record<string, unknown> {
    const cid = header(h, 'client_id'), csec = header(h, 'client_secret'), gstin = header(h, 'gstin')
    const e = (code: string, msg: string): Record<string, unknown> => errEnvelope([{ ErrorCode: code, ErrorMessage: msg }], false)
    if (!cid) return e('1011', 'Client Id is required')
    if (!csec) return e('1012', 'Client Secret is required')
    if (!gstin) return e('1004', 'Header GSTIN is required')
    if (cid !== opts.clientId || csec !== opts.clientSecret) return e('1010', 'Invalid Client-ID/Client-Secret')
    let creds: { UserName?: string; Password?: string; AppKey?: string; ForceRefreshAccessToken?: boolean }
    try {
      const { Data } = JSON.parse(body ?? '{}') as { Data: string }
      // [JAVA]/[CSHARP]: RSA PKCS#1 v1.5 over the Base64 of the JSON.
      const raw = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(Data, 'base64'))
      creds = JSON.parse(Buffer.from(raw.toString('utf8'), 'base64').toString('utf8'))
    } catch {
      return e('1013', 'Decryption of password failed')
    }
    lastLogin = { UserName: creds.UserName, ForceRefreshAccessToken: !!creds.ForceRefreshAccessToken, AppKeyBytes: Buffer.from(creds.AppKey ?? '', 'base64').length }
    if (!creds.UserName) return e('1006', 'User Name is required')
    if (creds.UserName !== opts.username) return e('1017', 'Incorrect user id/User does not exists')
    if (creds.Password !== opts.password) return e('1019', 'Incorrect Password')
    if (!opts.gstins.includes(gstin)) return e('1015', 'Invalid GSTIN for this user')
    const appKey = Buffer.from(creds.AppKey ?? '', 'base64')
    if (appKey.length !== 32) return e('1016', 'Decryption of App Key failed')
    const t = now()
    // [AUTH]: "Any hits to this API within these 360 minutes will return the same token";
    // ForceRefreshAccessToken works "within the last 10 minutes of expiry".
    let rec = [...tokens.values()].find((r) => r.user === creds.UserName && r.gstin === gstin && r.clientId === cid && r.expiresAt > t)
    if (rec && creds.ForceRefreshAccessToken && rec.expiresAt - t <= 10 * 60 * 1000) {
      tokens.delete(rec.token)
      rec = undefined
    }
    if (!rec) {
      rec = { token: crypto.randomBytes(16).toString('base64url'), sek: crypto.randomBytes(32), user: creds.UserName, gstin, clientId: cid, issuedAt: t, expiresAt: t + ttl }
      tokens.set(rec.token, rec)
    }
    return {
      Status: 1,
      Data: { ClientId: cid, UserName: rec.user, AuthToken: rec.token, Sek: b64(aesEnc(appKey, rec.sek)), TokenExpiry: istStamp(rec.expiresAt) },
      ErrorDetails: null,
      InfoDtls: null
    }
  }

  /** Authenticated-call gate: returns the token record or an error envelope. `ewbStyle` = the
   *  ewayapi header set (client-id / client-secret / Gstin / authtoken, [CEWB]). */
  function gate(h: Record<string, string>, ewbStyle: boolean): TokenRec | Record<string, unknown> {
    const cid = header(h, 'client_id'), csec = header(h, 'client_secret'), gstin = header(h, 'gstin')
    const token = header(h, 'authtoken')
    if (!cid) return fail('1011', 'Client Id is required')
    if (!csec) return fail('1012', 'Client Secret is required')
    if (!gstin) return fail('1004', 'Header GSTIN is required')
    if (cid !== opts.clientId || csec !== opts.clientSecret) return fail('1010', 'Invalid Client-ID/Client-Secret')
    if (!ewbStyle && !header(h, 'user_name')) return fail('1006', 'User Name is required')
    const rec = token ? tokens.get(token) : undefined
    if (!rec || rec.expiresAt <= now() || rec.gstin !== gstin || (!ewbStyle && rec.user !== header(h, 'user_name'))) {
      return fail('1005', 'Invalid Token')
    }
    return rec
  }
  const isRec = (x: TokenRec | Record<string, unknown>): x is TokenRec => typeof (x as TokenRec).token === 'string' && (x as TokenRec).sek instanceof Buffer

  function generate(rec: TokenRec, doc: Record<string, unknown>): Record<string, unknown> {
    const d = doc as { Version?: string; Irn?: string; DocDtls?: { Typ: string; No: string; Dt: string }; SellerDtls?: { Gstin: string }; BuyerDtls?: { Gstin: string }; ValDtls?: { TotInvVal: number }; ItemList?: { HsnCd: string; AssAmt: number }[] }
    if (d.Version !== '1.1') return fail('2000', 'Invalid Version') // [GEN] validation 2 (code UNVERIFIED)
    if (d.Irn) return fail('2000', 'IRN should not be passed in the request') // [GEN] validation 3 (code UNVERIFIED)
    const extra = opts.validateInvoice?.(doc) ?? []
    if (extra.length) return errEnvelope(extra.map((m) => ({ ErrorCode: 'SCHEMA', ErrorMessage: m })), true)
    if (!d.DocDtls || !d.SellerDtls || !d.ItemList?.length || !d.ValDtls) return fail('2000', 'Invalid JSON')
    if (d.SellerDtls.Gstin !== rec.gstin) return fail('2143', 'Invoice does not belongs to the user GSTIN')
    if (d.BuyerDtls?.Gstin === d.SellerDtls.Gstin) return fail('2211', 'Supplier and recipient GSTIN should not be the same.')
    const [dd, mm, yyyy] = d.DocDtls.Dt.split('/').map(Number) as [number, number, number]
    if (Date.UTC(yyyy, mm - 1, dd) - IST_MS > now()) return fail('2163', 'The document date should not be future date.')
    // [IRN]: hash of Supplier GSTIN + Fin. Year + Doc Type + Doc Number.
    const irn = crypto.createHash('sha256').update(`${rec.gstin}${finYear(d.DocDtls.Dt)}${d.DocDtls.Typ}${d.DocDtls.No.toUpperCase()}`).digest('hex')
    const existing = irns.get(irn)
    if (existing?.status === 'CNL') return fail('2278', 'IRN is already generated and is cancelled for this Document number')
    if (existing) {
      return fail('2150', 'Duplicate IRN', [{ InfCd: 'DUPIRN', Desc: { AckNo: Number(existing.ackNo), AckDt: existing.ackDt, Irn: existing.irn } }])
    }
    const t = now()
    const ackNo = String(++ackSeq)
    const ackDt = istStamp(t)
    const items = d.ItemList
    const main = [...items].sort((a, b) => b.AssAmt - a.AssAmt)[0]!
    const signedInvoice = jwt({ data: JSON.stringify({ ...doc, AckNo: Number(ackNo), AckDt: ackDt, Irn: irn }), iss: 'NIC Sandbox (fake)' })
    const signedQr = jwt({
      data: JSON.stringify({
        SellerGstin: d.SellerDtls.Gstin, BuyerGstin: d.BuyerDtls?.Gstin, DocNo: d.DocDtls.No, DocTyp: d.DocDtls.Typ,
        DocDt: d.DocDtls.Dt, TotInvVal: d.ValDtls.TotInvVal, ItemCnt: items.length, MainHsnCode: main.HsnCd, Irn: irn, IrnDt: ackDt
      }),
      iss: 'NIC Sandbox (fake)'
    })
    irns.set(irn, { irn, gstin: rec.gstin, ackNo, ackDt, createdAt: t, status: 'ACT', doc, signedInvoice, signedQr, ewbNo: null })
    return ok(rec.sek, { AckNo: Number(ackNo), AckDt: ackDt, Irn: irn, SignedInvoice: signedInvoice, SignedQRCode: signedQr, Status: 'ACT', EwbNo: null, EwbDt: null, EwbValidTill: null, Remarks: null })
  }

  function cancel(rec: TokenRec, req: { Irn?: string; CnlRsn?: string; CnlRem?: string }): Record<string, unknown> {
    const r = req.Irn ? irns.get(req.Irn) : undefined
    if (!r || r.gstin !== rec.gstin) return fail('3001', 'Requested data is not available')
    if (r.status === 'CNL') return fail('9999', 'Invoice is not active')
    if (!['1', '2', '3', '4'].includes(String(req.CnlRsn))) return fail('2000', 'Invalid cancel reason') // [CNL] CnlRsn 1–4 (code UNVERIFIED)
    if ((req.CnlRem ?? '').length > 100) return fail('2000', 'Cancel remarks too long') // [CNL] max 100 (code UNVERIFIED)
    if (r.ewbNo !== null && ewbs.get(r.ewbNo)?.status === 'ACT') return fail('2230', 'This IRN cannot be cancelled because e-way bill has been generated')
    if (now() - r.createdAt > 24 * 3600 * 1000) return fail('2270', 'The allowed cancellation time limit is crossed, you cannot cancel the IRN')
    r.status = 'CNL'
    r.cancelDate = istStamp(now())
    return ok(rec.sek, { Irn: r.irn, CancelDate: r.cancelDate })
  }

  function getIrn(rec: TokenRec, irn: string): Record<string, unknown> {
    const r = irns.get(irn)
    if (!r || r.gstin !== rec.gstin) return fail('3001', 'Requested data is not available')
    // [GET]: "IRN can be retrieved using this API within three days from the date of generation".
    if (now() - r.createdAt > 3 * 24 * 3600 * 1000) return fail('2283', 'IRN details cannot be provided as it is generated more than 3 days prior')
    const e = r.ewbNo !== null ? ewbs.get(r.ewbNo) : undefined
    return ok(rec.sek, {
      AckNo: Number(r.ackNo), AckDt: r.ackDt, Irn: r.irn, SignedInvoice: r.signedInvoice, SignedQRCode: r.signedQr, Status: r.status,
      EwbNo: e?.ewbNo ?? null, EwbDt: e?.ewbDt ?? null, EwbValidTill: e?.validTill ?? null, Remarks: null
    })
  }

  function ewbByIrn(rec: TokenRec, req: { Irn?: string; Distance?: number; TransMode?: string; TransId?: string; TransDocNo?: string; TransDocDt?: string; VehNo?: string; VehType?: string }): Record<string, unknown> {
    if (!req.Irn) return fail('4006', 'Requesting parameter cannot be empty')
    const r = irns.get(req.Irn)
    if (!r || r.gstin !== rec.gstin) return fail('4003', 'Requested IRN data is not available')
    if (r.status !== 'ACT') return fail('4000', 'Status of the IRN is not active')
    const typ = (r.doc.DocDtls as { Typ: string }).Typ
    if (typ === 'CRN' || typ === 'DBN') return fail('4010', 'E-way Bill cannot generated for Debit Note, Credit Note and Services')
    if (r.ewbNo !== null && ewbs.get(r.ewbNo)?.status === 'ACT') return fail('4002', 'EwayBill is already generated for this IRN')
    if (typeof req.Distance !== 'number' || req.Distance < 0 || req.Distance > 4000) return fail('4013', 'The distance between the pincodes given is too high or low')
    const partA = !req.TransMode && !!req.TransId
    if (!partA) {
      if (req.TransMode === '1') {
        if (!req.VehNo) return fail('4011', 'Vehicle number should be passed in case of transportation mode is Road')
        if (!req.VehType) return fail('4022', 'vehicle type should be passed in case of transportation mode is Road')
        if (!/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(req.VehNo)) return fail('4014', 'Invalid Vehicle Number')
      } else if (req.TransMode === '2' || req.TransMode === '3') {
        if (!req.TransDocNo) return fail('4012', 'The transport document number should be passed for transportation modes air and rail')
      } else if (req.TransMode !== '4') {
        return fail('4019', 'Provide Transporter ID in order to generate Part A of e-Way Bill')
      }
      if (req.TransDocDt && !/^\d{2}\/\d{2}\/\d{4}$/.test(req.TransDocDt)) return fail('4017', 'Incorrect date format')
    }
    const t = now()
    // [EWB] validation 10: distance 0 → the system's PIN-to-PIN distance (the fake uses 100 km).
    const distance = req.Distance === 0 ? 100 : req.Distance
    // Validity (rule 138(10) CGST Rules: one day per 200 km for regular cargo), ending 23:59:00 IST.
    // Part-A only: no validity ([GEN] "E Way Bill validity date, if Part B details provided").
    let validTillMs: number | null = null
    if (!partA) {
      const days = Math.max(1, Math.ceil(distance / 200))
      const ist = new Date(t + IST_MS)
      validTillMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 23, 59, 0) - IST_MS
    }
    const ewbNo = ++ewbSeq
    const e: EwbRec = { ewbNo, irn: r.irn, gstin: rec.gstin, createdAt: t, ewbDt: istStamp(t), validTill: validTillMs === null ? null : istStamp(validTillMs), validTillMs, status: 'ACT', distance }
    ewbs.set(ewbNo, e)
    r.ewbNo = ewbNo
    return ok(rec.sek, { EwbNo: ewbNo, EwbDt: e.ewbDt, EwbValidTill: e.validTill, Remarks: req.Distance === 0 ? `Distance between these two pincodes is ${distance}` : null })
  }

  /** EWB-API style envelope ([CEWB]/[EXT]): {status, data} / {status:'0', error:{errorCodes}}. */
  const ewbOk = (sek: Buffer, data: unknown): Record<string, unknown> => ({ status: '1', data: b64(aesEnc(sek, Buffer.from(JSON.stringify(data), 'utf8'))), alert: null })
  const ewbFail = (code: string): Record<string, unknown> => ({ status: '0', error: { errorCodes: code } })

  function ewayApi(rec: TokenRec, action: string, req: Record<string, unknown>): Record<string, unknown> {
    const e = ewbs.get(Number(req.ewbNo))
    if (action === 'CANEWB') {
      if (!e || e.gstin !== rec.gstin || e.status !== 'ACT') return ewbFail('4057') // "either not generated by you or cancelled"
      // EWB master "Reason Codes" for cancellation: 1 Duplicate, 2 Order Cancelled, 3 Data Entry mistake, 4 Others.
      if (![1, 2, 3, 4].includes(Number(req.cancelRsnCode))) return ewbFail('4059') // "Invalid reason"
      if (now() - e.createdAt > 24 * 3600 * 1000) return ewbFail('4055') // "within 24 hours"
      e.status = 'CNL'
      return ewbOk(rec.sek, { ewayBillNo: e.ewbNo, cancelDate: ewbStamp(now()) })
    }
    if (action === 'EXTENDVALIDITY') {
      if (!e || e.gstin !== rec.gstin || e.status !== 'ACT') return ewbFail('4005') // "Eway Bill details are not found"
      // [EXT] JSON Schema "required" list.
      for (const k of ['fromPlace', 'fromState', 'fromPincode', 'remainingDistance', 'transMode', 'extnRsnCode', 'extnRemarks']) {
        if (req[k] === undefined || req[k] === null || req[k] === '') return ewbFail('4006') // "Requesting parameter cannot be empty"
      }
      // EWB master "Reasons for extension of validity": 1, 2, 4, 5, 99.
      if (![1, 2, 4, 5, 99].includes(Number(req.extnRsnCode))) return ewbFail('4059')
      const mode = String(req.transMode)
      // [EXT]: modes 1–4 → consignmentStatus M, transitType ''; mode 5 → T with R/W/O.
      if (['1', '2', '3', '4'].includes(mode) ? req.consignmentStatus !== 'M' || (req.transitType ?? '') !== '' : req.consignmentStatus !== 'T' || !['R', 'W', 'O'].includes(String(req.transitType))) {
        return ewbFail('4006')
      }
      if (mode === '1' && !req.vehicleNo) return ewbFail('4011')
      if (Number(req.remainingDistance) > e.distance) return ewbFail('4013')
      // [EXT]: "between 8 hours before expiry time and 8 hours after expiry time" (code UNVERIFIED → 240).
      const t = now()
      if (e.validTillMs === null || t < e.validTillMs - 8 * 3600 * 1000 || t > e.validTillMs + 8 * 3600 * 1000) return ewbFail('240')
      const days = Math.max(1, Math.ceil(Number(req.remainingDistance) / 200))
      const ist = new Date(e.validTillMs + IST_MS)
      e.validTillMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 23, 59, 0) - IST_MS
      e.validTill = istStamp(e.validTillMs)
      return ewbOk(rec.sek, { ewayBillNo: String(e.ewbNo), updatedDate: ewbStamp(t), validUpto: ewbStamp(e.validTillMs) })
    }
    return ewbFail('239') // "Invalid action"
  }

  async function handle(url: string, init: FakeRequestInit): Promise<{ status: number; body: unknown }> {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '')
    const h = init.headers
    const parsed = (): Record<string, unknown> => JSON.parse(init.body ?? '{}') as Record<string, unknown>
    const call: FakeCall = { method: init.method, path, headers: { ...h }, body: init.body, status: 200 }
    calls.push(call)
    if (path === '/eivital/v1.04/auth' && init.method === 'POST') {
      lastLogin = undefined
      const body = auth(h, init.body)
      // The decrypted login minus the password (tests assert on ForceRefreshAccessToken / AppKey).
      call.plain = lastLogin
      return { status: 200, body }
    }
    const ewbStyle = path === '/ewaybillapi/v1.03/ewayapi'
    const g = gate(h, ewbStyle)
    if (!isRec(g)) {
      call.status = 200
      return { status: 200, body: ewbStyle ? ewbFail('238') : g } // 238 "Invalid auth token" (EWB list)
    }
    try {
      if (path === '/eicore/v1.03/Invoice' && init.method === 'POST') {
        const doc = decryptData(g.sek, String(parsed().Data)) as Record<string, unknown>
        call.plain = doc
        return { status: 200, body: generate(g, doc) }
      }
      if (path === '/eicore/v1.03/Invoice/Cancel' && init.method === 'POST') {
        const req = decryptData(g.sek, String(parsed().Data)) as Record<string, string>
        call.plain = req
        return { status: 200, body: cancel(g, req) }
      }
      const m = /^\/eicore\/v1\.03\/Invoice\/irn\/([0-9a-f]{64})$/.exec(path)
      if (m && init.method === 'GET') return { status: 200, body: getIrn(g, m[1]!) }
      if (path === '/eiewb/v1.03/ewaybill' && init.method === 'POST') {
        const req = decryptData(g.sek, String(parsed().Data)) as Record<string, never>
        call.plain = req
        return { status: 200, body: ewbByIrn(g, req) }
      }
      if (ewbStyle && init.method === 'POST') {
        const { action, data } = parsed() as { action: string; data: string }
        const req = decryptData(g.sek, data) as Record<string, unknown>
        call.plain = { action, ...req }
        return { status: 200, body: ewayApi(g, action, req) }
      }
    } catch {
      return { status: 200, body: ewbStyle ? ewbFail('109') : fail('2000', 'Invalid JSON') } // 109 "Decryption of data failed"
    }
    call.status = 404
    return { status: 404, body: { message: 'Not found' } }
  }

  return {
    publicKeyPem: publicKey,
    calls,
    irns,
    ewbs,
    verifyJwt,
    failNext(count: number, status = 503) {
      failQueue = [...failQueue, ...Array.from({ length: count }, () => status)]
    },
    dropNext(count: number) {
      drops += count
    },
    revokeTokens() {
      tokens.clear()
    },
    async fetch(url: string, init: FakeRequestInit): Promise<FakeResponse> {
      if (drops > 0) {
        drops--
        calls.push({ method: init.method, path: new URL(url).pathname, headers: { ...init.headers }, body: init.body, status: 0 })
        throw new TypeError('fetch failed')
      }
      const forced = failQueue.shift()
      if (forced !== undefined) {
        calls.push({ method: init.method, path: new URL(url).pathname, headers: { ...init.headers }, body: init.body, status: forced })
        return { status: forced, json: async () => { throw new SyntaxError('Unexpected token < in JSON') } }
      }
      const r = await handle(url, init)
      return { status: r.status, json: async () => JSON.parse(JSON.stringify(r.body)) }
    }
  }
}
