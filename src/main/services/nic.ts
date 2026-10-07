/**
 * Live filing against the NIC e-Invoice API suite (v1.04 auth, v1.03 IRN + EWB-by-IRN).
 * Needs API credentials (direct-access registration on einvoice1.gst.gov.in, or GSP
 * credentials) and the NIC RSA public key. Everything is stored per company; the app
 * stays fully functional offline — this is the optional online path.
 *
 * EXPERIMENTAL: contract-tested against the published API documentation only (WP 3.5, fake
 * sandbox in nicFake.testutil.ts, 2026-10-07) — not yet verified on the NIC sandbox.
 */
import crypto from 'crypto'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { nicCredentialsSchema, type NicCredentials } from '@shared/schemas'
import { buildEInvoiceJson, buildEwbByIrnPayload, type EdocCompany } from '@shared/gst/edocs'
import { einvoiceIssues } from '@shared/gst/einvoiceSchema'
import { outwardDebitNoteIds } from './gst'
import { extractEdocInvoices, goodsMovedOnChallan, movedOnChallanReason } from './edocs'
import { writeAudit } from './audit'
import { log } from '../log'
import { companyScope, SecretsUnavailableError, type SecretStore } from './secrets'
import { appSecretStore } from './secretStore'

// ---------- credential storage ----------
//
// Non-secret settings (URLs, username, client id, public key PEM) live in the company DB's
// `meta` row 'nic'. The two secret halves — password and clientSecret — live in the encrypted
// secret store (secrets.ts / secretStore.ts) under scope companyScope(slug), never in the DB.
// Consequence: company backups carry no NIC secrets, and after restoring a backup on another
// machine (or under a different slug) the owner must re-enter the password and client secret
// in Settings → Live filing.
//
// Older versions stored everything as plaintext JSON in `meta`. readNicCredentials moves any
// such plaintext secrets into the store on first read and rewrites the meta row without them.
// (Backups taken before that move still contain the old plaintext — nothing can fix those.)

const SECRET_FIELDS = ['password', 'clientSecret'] as const
type SecretField = (typeof SECRET_FIELDS)[number]
const secretName = (f: SecretField): string => `nic.${f}`

function readMetaRaw(db: DB): Record<string, unknown> {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'nic'").get() as { value: string } | undefined
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.value) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeMetaWithoutSecrets(db: DB, creds: Record<string, unknown>): void {
  const clean = { ...creds }
  for (const f of SECRET_FIELDS) delete clean[f]
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('nic', JSON.stringify(clean))
}

function parseCreds(raw: Record<string, unknown>): NicCredentials {
  const r = nicCredentialsSchema.safeParse(raw)
  return r.success ? r.data : nicCredentialsSchema.parse({})
}

/**
 * Full credentials for the open company, secrets decrypted. Also performs the one-time move of
 * legacy plaintext secrets out of `meta`: each is copied into the store (unless the store already
 * holds a value — the store is the source of truth, e.g. after restoring an old backup) and the
 * meta row is rewritten without it, with secure_delete on so the freed page is zeroed.
 *
 * If secure storage is unavailable, legacy plaintext is left in place and still used (it is
 * already on disk; nothing new is ever written in plaintext), and store-held secrets read as ''.
 */
export function readNicCredentials(db: DB, slug: string, store: SecretStore = appSecretStore()): NicCredentials {
  const raw = readMetaRaw(db)
  const scope = companyScope(slug)
  const legacy = SECRET_FIELDS.filter((f) => typeof raw[f] === 'string' && raw[f] !== '')

  if (!store.available()) {
    if (legacy.length) log('warn', 'nic-secrets-legacy-plaintext-unmigrated', { slug })
    const out: Record<string, unknown> = { ...raw }
    for (const f of SECRET_FIELDS) if (!legacy.includes(f)) out[f] = ''
    return parseCreds(out)
  }

  const secrets: Partial<Record<SecretField, string>> = {}
  for (const f of SECRET_FIELDS) {
    const stored = store.get(scope, secretName(f))
    if (stored !== null) secrets[f] = stored
  }
  if (legacy.length) {
    for (const f of legacy) {
      if (secrets[f] === undefined) {
        store.set(scope, secretName(f), raw[f] as string)
        secrets[f] = raw[f] as string
      }
    }
    // Store first, then scrub: a crash in between leaves a duplicate the next read scrubs, never
    // a lost secret.
    db.pragma('secure_delete = ON')
    try {
      writeMetaWithoutSecrets(db, raw)
    } finally {
      db.pragma('secure_delete = OFF')
    }
    log('info', 'nic-secrets-migrated', { slug, fields: legacy })
  }
  return parseCreds({ ...raw, password: secrets.password ?? '', clientSecret: secrets.clientSecret ?? '' })
}

/** Throws SecretsUnavailableError (and writes nothing) when a non-empty secret can't be encrypted. */
export function writeNicCredentials(db: DB, slug: string, creds: NicCredentials, store: SecretStore = appSecretStore()): void {
  const scope = companyScope(slug)
  // Secrets first — if encryption is unavailable this throws before anything changes.
  for (const f of SECRET_FIELDS) if (creds[f]) store.set(scope, secretName(f), creds[f])
  for (const f of SECRET_FIELDS) if (!creds[f]) store.delete(scope, secretName(f))
  writeMetaWithoutSecrets(db, creds)
  // Credentials (incl. password) never go into the audit trail — before/after are always null.
  writeAudit(db, 'nic_credentials', 0, 'update', null, null)
}

/** The mask nic:get sends instead of a stored secret; nic:save treats it as "keep what's stored". */
export const NIC_SECRET_MASK = '••••••••'

/** Credentials as the renderer may see them: password AND clientSecret (the two halves of the NIC
 *  auth pair) masked — never sent back in full (v0.3 review F3). */
export function maskNicCredentials(creds: NicCredentials): NicCredentials {
  return { ...creds, password: creds.password ? NIC_SECRET_MASK : '', clientSecret: creds.clientSecret ? NIC_SECRET_MASK : '' }
}

/** Forget a company's NIC secrets (company deleted) so a future company reusing the slug can't inherit them. */
export function deleteNicSecrets(slug: string, store: SecretStore = appSecretStore()): void {
  store.deleteScope(companyScope(slug))
}

function credsComplete(c: NicCredentials): boolean {
  return !!(c.baseUrlEinvoice && c.username && c.password && c.clientId && c.publicKeyPem)
}

function assertConfigured(creds: NicCredentials, store: SecretStore = appSecretStore()): void {
  if (credsComplete(creds)) return
  // Distinguish "never set up" from "set up, but the keychain can't decrypt the secrets now".
  if (!store.available()) throw new SecretsUnavailableError()
  throw new Error('Live filing is not configured — add NIC API credentials first')
}

export function nicConfigured(db: DB, slug: string, store: SecretStore = appSecretStore()): boolean {
  return credsComplete(readNicCredentials(db, slug, store))
}

// ---------- the published API contract (WP 3.5) ----------
//
// Sources, all read 2026-10-07 (the client was hardened against these with the fake sandbox in
// nicFake.testutil.ts; it has NOT run against the real NIC sandbox — no credentials):
//  [AUTH]  https://einv-apisandbox.nic.in/version1.04/authentication.html
//  [JAVA]  https://einv-apisandbox.nic.in/sample-code-in-java.html
//  [CSHARP] https://einv-apisandbox.nic.in/sample-code-in-c-sharp-dot-net.html
//  [GEN]   https://einv-apisandbox.nic.in/version1.03/generate-irn.html
//  [CNL]   https://einv-apisandbox.nic.in/version1.03/cancel-irn.html
//  [GET]   https://einv-apisandbox.nic.in/version1.03/get-eInvoicedetails.html
//  [EWB]   https://einv-apisandbox.nic.in/version1.03/ewaybill-generation-irn.html
//  [CEWB]  https://einv-apisandbox.nic.in/version1.03/cancel-eway-bill.html
//  [EXT]   https://docs.ewaybillgst.gov.in/apidocs/version1.03/extend-validity.html
//  [MASTER] https://docs.ewaybillgst.gov.in/apidocs/master-codes-list.html
//  [ERR]   https://einvoice1.gst.gov.in/others/geterrorcodes/VITAL, /INV, /EWB
//
// UNVERIFIED — see the list at the top of nicFake.testutil.ts (URL prefixes, header spelling,
// ErrorDetails encoding, the 2150 InfoDtls shape, IST timestamps) plus: whether the IRP accepts
// EXTENDVALIDITY on its /ewaybillapi route (the IRP pages document only CANEWB there), and
// whether ewayapi `data` is AES over the JSON or over Base64(JSON) ([CEWB] writes
// "Encrypt(Base64(Request JSON),sek)"; this client encrypts the JSON, like the IRN calls, and
// decodes either form in responses).

/**
 * Login encryption. [JAVA]: `Base64.getEncoder().encodeToString(payload.getBytes())`, then
 * `Cipher.getInstance("RSA/ECB/PKCS1PADDING")`; [CSHARP]: `rsa.Encrypt(…, false)` — PKCS#1 v1.5
 * (not OAEP) over the Base64 text of the JSON; [AUTH]: "encoded using Base64 and then encrypted
 * using e-Invoice public Key". (Before WP 3.5 the client RSA-encrypted the raw JSON.)
 */
export function encryptLoginPayload(publicKeyPem: string, payload: unknown): string {
  const b64json = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  try {
    return crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(b64json, 'utf8')).toString('base64')
  } catch {
    throw new NicError('The NIC public key is not a valid RSA public key — paste the PEM from the portal into Settings → NIC', [], 'config')
  }
}

/** AES-256 ECB, PKCS#7 padding ([AUTH] Sek: "AES 256(AES/ECB/PKCS7Padding)"; [JAVA] AES/ECB/PKCS5Padding). */
export function aesEncrypt(key: Buffer, plain: string): string {
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null)
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

export function aesDecrypt(key: Buffer, b64: string): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null)
  return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()])
}

/** A SEK-encrypted response payload → JSON. Tolerates an extra Base64 layer (EWB "Encrypt(Base64(JSON))"). */
export function decryptJson(sek: Buffer, b64: string): Record<string, unknown> {
  const text = aesDecrypt(sek, b64).toString('utf8')
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as Record<string, unknown>
  }
}

// ---------- errors ----------

/** A failure from (or on the way to) the portal, with the NIC error codes and a user message. */
export class NicError extends Error {
  constructor(message: string, readonly codes: string[] = [], readonly kind: 'portal' | 'network' | 'config' = 'portal') {
    super(message)
    this.name = 'NicError'
  }
}

/** Friendlier text for the codes a user can act on ([ERR] lists; portal text is kept alongside). */
const FRIENDLY: Record<string, string> = {
  '1004': 'The company GSTIN was not sent — set it in Company settings',
  '1005': 'The NIC session expired — try again',
  '1008': 'NIC rejected the API username or password',
  '1010': 'NIC rejected the client ID / client secret',
  '1011': 'The client ID is missing — add it in Settings → NIC',
  '1012': 'The client secret is missing — add it in Settings → NIC',
  '1013': 'NIC could not decrypt the login — check the NIC public key in Settings → NIC',
  '1014': 'This API user is inactive on the NIC portal',
  '1015': 'This company GSTIN is not linked to the API user on the NIC portal',
  '1016': 'NIC could not decrypt the login — check the NIC public key in Settings → NIC',
  '1017': 'NIC does not know this API username',
  '1018': 'The client ID is not mapped to this API user on the NIC portal',
  '1019': 'NIC rejected the API password',
  '3000': 'NIC rejected the API username or password',
  '2150': 'NIC already has an IRN for this document number',
  '2278': 'This document number already had an IRN that was cancelled — a cancelled number cannot be e-invoiced again; issue the invoice under a new number',
  '2270': 'The 24-hour window to cancel this IRN has passed — issue a credit note instead',
  '2230': 'Cancel the e-way bill first — an IRN with an active e-way bill cannot be cancelled',
  '2283': 'NIC only returns IRN details for 3 days after generation',
  '4002': 'NIC already has an e-way bill for this IRN',
  '4010': 'E-way bills are not generated for credit notes, debit notes or services',
  '4011': 'Road transport needs a vehicle number',
  '4012': 'Rail / air transport needs the transport document number',
  '4014': 'NIC rejected the vehicle number',
  '4022': 'Road transport needs a vehicle type',
  '4055': 'The 24-hour window to cancel this e-way bill has passed',
  '4057': 'This e-way bill was not generated by you or is already cancelled'
}

/** Messages of the EWB-API numeric codes this client can meet ([ERR] EWB list; EWB API list). */
const EWB_CODE_TEXT: Record<string, string> = {
  '238': 'Invalid auth token', '239': 'Invalid action', '240': 'Could not complete the request, pls contact helpdesk',
  '109': 'Decryption of data failed', '4005': 'Eway Bill details are not found', '4006': 'Requesting parameter cannot be empty',
  '4011': 'Vehicle number should be passed in case of transportation mode is Road', '4013': 'The distance between the pincodes given is too high or low',
  '4055': 'You can cancel the ewaybill within 24 hours from Part B entry', '4057': 'This eway bill is either not generated by you or cancelled',
  '4059': 'Invalid reason'
}

function decodeErrorDetails(raw: unknown): { ErrorCode?: string; ErrorMessage?: string }[] {
  if (Array.isArray(raw)) return raw as { ErrorCode?: string; ErrorMessage?: string }[]
  if (typeof raw !== 'string' || !raw) return []
  // [GEN]: "ErrorDetails": "Base 64 encoded string" of the array; [AUTH]: plain "<Errors JSON>".
  for (const text of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return parsed as { ErrorCode?: string; ErrorMessage?: string }[]
    } catch {
      // try the next decoding
    }
  }
  return [{ ErrorMessage: raw.slice(0, 200) }]
}

function errorFromEnvelope(body: unknown, httpStatus: number, fallback: string): NicError {
  const b = (body ?? {}) as Record<string, unknown>
  let errors = decodeErrorDetails(b.ErrorDetails)
  if (!errors.length && b.error !== undefined) {
    // EWB-API style: {"status":"0","error":{"errorCodes":"240"}} — possibly base64 / comma-list.
    let err = b.error as unknown
    if (typeof err === 'string') {
      try { err = JSON.parse(Buffer.from(err, 'base64').toString('utf8')) } catch { err = { message: err } }
    }
    const e = err as { errorCodes?: string | number; message?: string }
    const codes = String(e.errorCodes ?? '').split(',').map((c) => c.trim()).filter(Boolean)
    errors = codes.length ? codes.map((c) => ({ ErrorCode: c, ErrorMessage: EWB_CODE_TEXT[c] ?? '' })) : [{ ErrorMessage: e.message ?? '' }]
  }
  const codes = errors.map((e) => String(e.ErrorCode ?? '')).filter(Boolean)
  const parts = errors.map((e) => {
    const code = e.ErrorCode ? String(e.ErrorCode) : ''
    const portal = (e.ErrorMessage ?? '').trim()
    const friendly = code ? FRIENDLY[code] : undefined
    if (friendly) return `${friendly} (NIC ${code}${portal ? `: ${portal}` : ''})`
    return code ? `${portal || 'Rejected'} (NIC ${code})` : portal
  }).filter(Boolean)
  return new NicError(parts.join('; ') || `${fallback} (HTTP ${httpStatus})`, codes)
}

// ---------- transport: retry with backoff ----------

export type NicFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>
const defaultFetch: NicFetch = (url, init) => fetch(url, init)

export interface NicDeps {
  fetchFn?: NicFetch
  store?: SecretStore
  /** Backoff sleeper — tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Attempts per request (first try + retries) on a 5xx or a network failure. */
export const NIC_MAX_ATTEMPTS = 3
/** Exponential backoff: 500 ms, 1 s (then give up). */
export const nicBackoffMs = (attempt: number): number => 500 * 2 ** attempt

/** One HTTP exchange with retry/backoff on 5xx and network errors. A 4xx or a JSON error
 *  envelope is returned as-is — those are answers, not outages. */
async function exchange(url: string, init: { method: string; headers: Record<string, string>; body?: string }, deps: NicDeps): Promise<{ status: number; body: unknown }> {
  const fetchFn = deps.fetchFn ?? defaultFetch
  const sleep = deps.sleep ?? realSleep
  let lastStatus = 0
  for (let attempt = 0; attempt < NIC_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(nicBackoffMs(attempt - 1))
    let res: { status: number; json(): Promise<unknown> }
    try {
      res = await fetchFn(url, init)
    } catch {
      lastStatus = 0
      continue
    }
    if (res.status >= 500) {
      lastStatus = res.status
      continue
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  }
  const path = new URL(url).pathname
  log('warn', 'nic-unreachable', { path, status: lastStatus, attempts: NIC_MAX_ATTEMPTS })
  throw new NicError(
    lastStatus
      ? `The NIC portal is not responding (HTTP ${lastStatus} after ${NIC_MAX_ATTEMPTS} tries) — try again later`
      : `Could not reach the NIC portal after ${NIC_MAX_ATTEMPTS} tries — check the internet connection and the base URL`,
    [],
    'network'
  )
}

// ---------- session ----------

interface NicSession {
  authToken: string
  sek: Buffer
  /** ms since epoch — from TokenExpiry ([AUTH] 'yyyy-MM-dd HH:mm:ss'). */
  expiresAt: number
  /** The portal's TokenExpiry string, verbatim (shown by the connection test). */
  tokenExpiry: string
}

/** Sessions by identity (sessionKey). Reset on credential save and on company switch/close
 *  (ipc.ts closeCurrentCompany). A different identity never reuses another's token. */
const sessions = new Map<string, NicSession>()
/** In-flight logins, so concurrent calls for one identity share one handshake. */
const pendingLogins = new Map<string, Promise<NicSession>>()

/** [AUTH]: ForceRefreshAccessToken works "within the last 10 minutes of expiry" — inside that
 *  window the client asks for a fresh token instead of reusing the cached one. */
const REFRESH_WINDOW_MS = 10 * 60 * 1000
/** If TokenExpiry can't be parsed: the shortest published validity (60 min, sandbox — [AUTH]). */
const FALLBACK_TTL_MS = 60 * 60 * 1000

/** The identity a session belongs to: GSTIN + username + client id + endpoint (sandbox vs
 *  production), plus a digest of the secrets so a changed password/secret can't ride on an old
 *  token. Raw secrets never end up in the key. */
function sessionKey(creds: NicCredentials, gstin: string): string {
  const secretDigest = crypto.createHash('sha256').update(`${creds.password}\u0000${creds.clientSecret}`).digest('hex')
  return JSON.stringify([gstin.toUpperCase(), creds.username, creds.clientId, baseUrl(creds), secretDigest])
}

const baseUrl = (creds: NicCredentials): string => creds.baseUrlEinvoice.replace(/\/+$/, '')

/** 'yyyy-MM-dd HH:mm:ss' read as IST (UTC+05:30 — UNVERIFIED, [AUTH] gives only the format). */
export function parseNicTimestamp(s: unknown): number | null {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s) : null
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m.map(Number) as [number, number, number, number, number, number, number]
  return Date.UTC(y, mo - 1, d, h, mi, se) - 330 * 60 * 1000
}

/** e-Invoice header set ([GEN]/[CNL]/[GET]/[EWB] request-header tables). The secrets ride only
 *  in headers and the RSA-encrypted login body — never in a URL, a log line or an error. */
function einvHeaders(creds: NicCredentials, gstin: string, token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    Gstin: gstin,
    ...(token ? { user_name: creds.username, AuthToken: token } : {})
  }
}

/** ewayapi header set ([CEWB]: client-id, client-secret, Gstin, authtoken). */
function ewbHeaders(creds: NicCredentials, gstin: string, token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'client-id': creds.clientId, 'client-secret': creds.clientSecret, Gstin: gstin, authtoken: token }
}

async function login(creds: NicCredentials, gstin: string, forceRefresh: boolean, deps: NicDeps): Promise<NicSession> {
  const now = deps.now ?? Date.now
  const appKey = crypto.randomBytes(32)
  // [AUTH] request payload; AppKey: "random 32 bytes array … base 64 … 44 chars long".
  const data = encryptLoginPayload(creds.publicKeyPem, {
    UserName: creds.username,
    Password: creds.password,
    AppKey: appKey.toString('base64'),
    ForceRefreshAccessToken: forceRefresh
  })
  const { status, body } = await exchange(`${baseUrl(creds)}/eivital/v1.04/auth`, {
    method: 'POST',
    headers: einvHeaders(creds, gstin),
    body: JSON.stringify({ Data: data })
  }, deps)
  const env = (body ?? {}) as { Status?: unknown; Data?: unknown }
  if (String(env.Status) !== '1' || !env.Data) {
    const err = errorFromEnvelope(body, status, 'NIC login failed')
    log('warn', 'nic-auth-failed', { codes: err.codes, status })
    throw err
  }
  // [AUTH]/[CSHARP]: Data is an object {ClientId, UserName, AuthToken, Sek, TokenExpiry}. Before
  // WP 3.5 the client expected a base64 string here; a string is still accepted.
  let inner: { AuthToken?: string; Sek?: string; TokenExpiry?: string }
  try {
    inner = typeof env.Data === 'string' ? JSON.parse(Buffer.from(env.Data, 'base64').toString('utf8')) : (env.Data as typeof inner)
  } catch {
    throw new NicError('NIC sent an unreadable login response')
  }
  if (!inner.AuthToken || !inner.Sek) throw new NicError('NIC login response has no token / session key')
  let sek: Buffer
  try {
    sek = aesDecrypt(appKey, inner.Sek)
  } catch {
    throw new NicError('Could not decrypt the NIC session key')
  }
  if (sek.length !== 32) throw new NicError('NIC session key has the wrong length')
  const expiresAt = parseNicTimestamp(inner.TokenExpiry) ?? now() + FALLBACK_TTL_MS
  log('info', 'nic-auth-ok', { forceRefresh, tokenExpiry: inner.TokenExpiry ?? null })
  return { authToken: inner.AuthToken, sek, expiresAt, tokenExpiry: inner.TokenExpiry ?? '' }
}

/** A valid session for this identity: cached until 10 min before TokenExpiry, then refreshed
 *  with ForceRefreshAccessToken; after expiry a plain new login. Exported for tests. */
export async function authenticate(creds: NicCredentials, gstin: string, fetchFn?: NicFetch, deps: NicDeps = {}): Promise<NicSession> {
  const d: NicDeps = { ...deps, ...(fetchFn ? { fetchFn } : {}) }
  const now = d.now ?? Date.now
  const key = sessionKey(creds, gstin)
  const cached = sessions.get(key)
  const t = now()
  if (cached && t < cached.expiresAt - REFRESH_WINDOW_MS) return cached
  const inFlight = pendingLogins.get(key)
  if (inFlight) return inFlight
  const forceRefresh = !!cached && t < cached.expiresAt
  sessions.delete(key)
  const p = login(creds, gstin, forceRefresh, d)
    .then((s) => {
      sessions.set(key, s)
      return s
    })
    .finally(() => pendingLogins.delete(key))
  pendingLogins.set(key, p)
  return p
}

/** Drop the cached sessions (credential save, company switch/close). */
export function resetNicSession(): void {
  sessions.clear()
  pendingLogins.clear()
}

const isInvalidToken = (status: number, err: NicError): boolean =>
  status === 401 || err.codes.includes('1005') || err.codes.includes('238') || err.codes.includes('106')

/**
 * One authenticated e-invoice API call. Request `Data` = Base64(AES(SEK, JSON)) ([GEN] "Base 64
 * encoded string of encrypted invoice JSON using Sek"); response `Data` decrypted the same way.
 * An invalid/expired token (HTTP 401, NIC 1005) drops the session and retries once on a fresh
 * login.
 */
async function einvCall(
  creds: NicCredentials, gstin: string, method: 'GET' | 'POST', path: string, payload: unknown, deps: NicDeps
): Promise<{ data: Record<string, unknown>; info: unknown }> {
  for (let round = 0; round < 2; round++) {
    const s = await authenticate(creds, gstin, undefined, deps)
    const { status, body } = await exchange(`${baseUrl(creds)}${path}`, {
      method,
      headers: einvHeaders(creds, gstin, s.authToken),
      ...(method === 'POST' ? { body: JSON.stringify({ Data: aesEncrypt(s.sek, JSON.stringify(payload)) }) } : {})
    }, deps)
    const env = (body ?? {}) as { Status?: unknown; Data?: unknown; InfoDtls?: unknown }
    if (String(env.Status) === '1' && typeof env.Data === 'string') {
      try {
        return { data: decryptJson(s.sek, env.Data), info: env.InfoDtls ?? null }
      } catch {
        throw new NicError('Could not decrypt the NIC response')
      }
    }
    const err = errorFromEnvelope(body, status, 'NIC rejected the request')
    ;(err as NicError & { info?: unknown }).info = env.InfoDtls ?? null
    if (round === 0 && isInvalidToken(status, err)) {
      sessions.delete(sessionKey(creds, gstin))
      continue
    }
    log('warn', 'nic-request-rejected', { path: path.replace(/[0-9a-f]{64}/, '<irn>'), codes: err.codes, status })
    throw err
  }
  throw new NicError('NIC session could not be renewed')
}

/** One EWB-API call through the IRP (`/ewaybillapi/v1.03/ewayapi`, {action, data} — [CEWB]/[EXT]). */
async function ewayApiCall(creds: NicCredentials, gstin: string, action: string, payload: unknown, deps: NicDeps): Promise<Record<string, unknown>> {
  for (let round = 0; round < 2; round++) {
    const s = await authenticate(creds, gstin, undefined, deps)
    const { status, body } = await exchange(`${baseUrl(creds)}/ewaybillapi/v1.03/ewayapi`, {
      method: 'POST',
      headers: ewbHeaders(creds, gstin, s.authToken),
      body: JSON.stringify({ action, data: aesEncrypt(s.sek, JSON.stringify(payload)) })
    }, deps)
    const env = (body ?? {}) as { status?: unknown; data?: unknown }
    if (String(env.status) === '1' && typeof env.data === 'string') {
      try {
        return decryptJson(s.sek, env.data)
      } catch {
        throw new NicError('Could not decrypt the NIC response')
      }
    }
    const err = errorFromEnvelope(body, status, 'NIC rejected the e-way bill request')
    if (round === 0 && isInvalidToken(status, err)) {
      sessions.delete(sessionKey(creds, gstin))
      continue
    }
    log('warn', 'nic-ewb-rejected', { action, codes: err.codes, status })
    throw err
  }
  throw new NicError('NIC session could not be renewed')
}

// ---------- operations ----------

interface Ctx { creds: NicCredentials; gstin: string; deps: NicDeps }

function context(db: DB, slug: string, company: CompanyInfo, deps: NicDeps): Ctx {
  const store = deps.store ?? appSecretStore()
  const creds = readNicCredentials(db, slug, store)
  assertConfigured(creds, store)
  if (!company.gstin) throw new NicError('Company GSTIN is missing — set it in Company settings', [], 'config')
  return { creds, gstin: company.gstin.toUpperCase(), deps }
}

export interface NicConnectionResult {
  ok: true
  /** Base URL that answered (sandbox or production). */
  endpoint: string
  sandbox: boolean
  /** The portal's TokenExpiry for the session just obtained. */
  tokenExpiry: string
}

/** Settings → NIC "Connection test": the auth handshake only (no filing, nothing written). Always
 *  performs a fresh login rather than trusting a cached session. */
export async function testNicConnection(db: DB, slug: string, company: CompanyInfo, deps: NicDeps = {}): Promise<NicConnectionResult> {
  const { creds, gstin } = context(db, slug, company, deps)
  sessions.delete(sessionKey(creds, gstin))
  const s = await authenticate(creds, gstin, undefined, deps)
  const endpoint = baseUrl(creds)
  return { ok: true, endpoint, sandbox: /sandbox|trial/i.test(endpoint), tokenExpiry: s.tokenExpiry }
}

export interface IrnResult {
  irn: string
  ackNo: string
  ackDate: string
  /** The NIC-signed JWTs from the response. NOT persisted — the vouchers table has no column for
   *  them and WP 3.5 adds no migration; Get IRN returns them for 3 days ([GET]). */
  signedQrCode: string | null
  signedInvoice: string | null
  /** True when NIC answered 2150 (duplicate) and the existing IRN for this document was adopted. */
  recovered: boolean
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

function voucherForNic(db: DB, voucherId: number): { irn: string | null; irn_ack_no: string | null; irn_ack_date: string | null; ewb_no: string | null; ewb_valid_upto: string | null; date: string; deleted_at: string | null } {
  // getVoucher-style read (incl. the bin) so a binned voucher gets a precise message.
  const v = db.prepare('SELECT irn, irn_ack_no, irn_ack_date, ewb_no, ewb_valid_upto, date, deleted_at FROM vouchers WHERE id = ?').get(voucherId) as
    ReturnType<typeof voucherForNic> | undefined
  if (!v) throw new NicError('Voucher not found', [], 'config')
  if (v.deleted_at) throw new NicError('This voucher is in the bin — restore it first', [], 'config')
  return v
}

/** Generate an IRN for one sales voucher (or outward credit/debit note) and store it on the voucher. */
export async function generateIrn(db: DB, slug: string, company: CompanyInfo, voucherId: number, deps: NicDeps = {}): Promise<IrnResult> {
  const ctx = context(db, slug, company, deps)
  const v = voucherForNic(db, voucherId)
  if (v.irn) throw new NicError('This invoice already has an IRN', [], 'config')

  const [invoice] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!invoice) throw new NicError('Only sales invoices and credit / debit notes in the books can be e-invoiced', [], 'config')
  // A purchase-side debit note (goods returned to a supplier) is not an outward document — the
  // same split exportEInvoices applies.
  if (invoice.docType === 'DBN' && !outwardDebitNoteIds(db, invoice.date, invoice.date).has(voucherId)) {
    throw new NicError('This debit note is a purchase return — only outward documents are e-invoiced', [], 'config')
  }
  const isExport = invoice.supTyp === 'EXPWP' || invoice.supTyp === 'EXPWOP'
  // [GEN] validation 7: "B2C transactions not accepted for IRN". Exports go with Gstin URP.
  if (!invoice.partyGstin && !isExport) throw new NicError('e-Invoice needs a registered (GSTIN) buyer, or an export party', [], 'config')

  const edocCompany: EdocCompany = { name: company.name, gstin: ctx.gstin, stateCode: company.stateCode, address: company.address }
  const [payload] = buildEInvoiceJson([invoice], edocCompany)
  // Pre-flight against the published schema + validations: refuse locally what the IRP rejects.
  const issues = einvoiceIssues(payload)
  if (issues.length) {
    throw new NicError(`This invoice would be rejected by NIC: ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}`, [], 'config')
  }

  let data: Record<string, unknown>
  let recovered = false
  try {
    ;({ data } = await einvCall(ctx.creds, ctx.gstin, 'POST', '/eicore/v1.03/Invoice', payload, ctx.deps))
  } catch (e) {
    // 2150 Duplicate IRN: NIC already holds an IRN for this supplier + FY + type + number — by
    // definition this document (e.g. an earlier attempt whose response was lost). Adopt it when
    // InfoDtls carries it (shape UNVERIFIED: [{InfCd:'DUPIRN', Desc:{AckNo, AckDt, Irn}}]).
    const info = (e as { info?: unknown }).info
    const dup = e instanceof NicError && e.codes.includes('2150') && Array.isArray(info)
      ? (info as { InfCd?: string; Desc?: { Irn?: string; AckNo?: unknown; AckDt?: unknown } }[]).find((x) => x.InfCd === 'DUPIRN')?.Desc
      : undefined
    if (!dup?.Irn) throw e
    data = { Irn: dup.Irn, AckNo: dup.AckNo, AckDt: dup.AckDt }
    recovered = true
  }
  const irn = str(data.Irn)
  if (!/^[0-9a-f]{64}$/i.test(irn)) throw new NicError('NIC returned no valid IRN')
  const ackNo = str(data.AckNo)
  const ackDate = str(data.AckDt)
  // [GEN]: EwbNo/EwbDt/EwbValidTill come back when e-way details rode along (this client never
  // sends EwbDtls, but store them if the portal returns them).
  const ewbNo = data.EwbNo ? str(data.EwbNo) : null
  const ewbValid = data.EwbValidTill ? str(data.EwbValidTill) : null
  const before = { irn: v.irn, irnAckNo: v.irn_ack_no, irnAckDate: v.irn_ack_date, ewbNo: v.ewb_no, ewbValidUpto: v.ewb_valid_upto }
  db.transaction(() => {
    db.prepare('UPDATE vouchers SET irn = ?, irn_ack_no = ?, irn_ack_date = ? WHERE id = ?').run(irn, ackNo, ackDate, voucherId)
    if (ewbNo) db.prepare('UPDATE vouchers SET ewb_no = ?, ewb_valid_upto = ? WHERE id = ?').run(ewbNo, ewbValid, voucherId)
    writeAudit(db, 'voucher', voucherId, 'update', before, {
      ...before, irn, irnAckNo: ackNo, irnAckDate: ackDate, ...(ewbNo ? { ewbNo, ewbValidUpto: ewbValid } : {}), ...(recovered ? { recoveredDuplicate: true } : {})
    })
  })()
  log('info', 'nic-irn-generated', { voucherId, ackNo, recovered })
  return {
    irn, ackNo, ackDate,
    signedQrCode: data.SignedQRCode ? str(data.SignedQRCode) : null,
    signedInvoice: data.SignedInvoice ? str(data.SignedInvoice) : null,
    recovered
  }
}

export interface EwbResult {
  ewbNo: string
  /** EwbValidTill verbatim ('yyyy-MM-dd HH:mm:ss'); '' for a Part-A-only bill (no validity yet). */
  validUpto: string
}

/** Generate an e-way bill against an existing IRN ([EWB]); transport from the voucher's
 *  Transport details (voucher_transport, falling back to the legacy voucher columns). */
export async function generateEwbByIrn(db: DB, slug: string, company: CompanyInfo, voucherId: number, deps: NicDeps = {}): Promise<EwbResult> {
  const ctx = context(db, slug, company, deps)
  const v = voucherForNic(db, voucherId)
  if (!v.irn) throw new NicError('Generate the IRN first — the e-way bill hangs off it', [], 'config')
  if (v.ewb_no) throw new NicError('This invoice already has an e-way bill', [], 'config')
  const [invoice] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!invoice) throw new NicError('Voucher not found', [], 'config')
  // [EWB] validations 2/3: no EWB for credit/debit notes or services-only documents.
  if (invoice.docType === 'CRN' || invoice.docType === 'DBN') throw new NicError('E-way bills are not generated for credit or debit notes', [], 'config')
  if (!invoice.items.some((i) => !i.isService)) throw new NicError('E-way bills need at least one goods line — this invoice is services only', [], 'config')
  // WP 2.5b: an invoice whose goods all travelled on a delivery challan needs no second EWB —
  // the challan's e-way bill covered the movement (same rule as the bulk export).
  const moved = goodsMovedOnChallan(db, [voucherId]).get(voucherId)
  if (moved) throw new NicError(`${movedOnChallanReason(moved)} — that e-way bill covers the movement`, [], 'config')
  if (!invoice.vehicleNo && !invoice.transporterId && !invoice.transport?.docNo) {
    throw new NicError('Add a vehicle number, transport document or transporter ID in the voucher\'s Transport details first', [], 'config')
  }
  const payload = buildEwbByIrnPayload(v.irn, invoice)
  const { data } = await einvCall(ctx.creds, ctx.gstin, 'POST', '/eiewb/v1.03/ewaybill', payload, ctx.deps)
  const ewbNo = str(data.EwbNo)
  if (!/^\d{12}$/.test(ewbNo)) throw new NicError('NIC returned no valid e-way bill number')
  const validUpto = str(data.EwbValidTill)
  const before = { ewbNo: v.ewb_no, ewbValidUpto: v.ewb_valid_upto }
  db.transaction(() => {
    db.prepare('UPDATE vouchers SET ewb_no = ?, ewb_valid_upto = ? WHERE id = ?').run(ewbNo, validUpto || null, voucherId)
    writeAudit(db, 'voucher', voucherId, 'update', before, { ewbNo, ewbValidUpto: validUpto || null })
  })()
  log('info', 'nic-ewb-generated', { voucherId, ewbNo })
  return { ewbNo, validUpto }
}

/** Why a document is being cancelled. The two systems number these DIFFERENTLY:
 *  IRN [CNL] CnlRsn: 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others;
 *  EWB [MASTER] "Reason Codes": 1 Duplicate, 2 Order Cancelled, 3 Data Entry mistake, 4 Others. */
export type NicCancelReason = 'duplicate' | 'data_entry_mistake' | 'order_cancelled' | 'other'
const IRN_CANCEL_CODE: Record<NicCancelReason, string> = { duplicate: '1', data_entry_mistake: '2', order_cancelled: '3', other: '4' }
const EWB_CANCEL_CODE: Record<NicCancelReason, number> = { duplicate: 1, order_cancelled: 2, data_entry_mistake: 3, other: 4 }

/**
 * Cancel a voucher's IRN ([CNL]: within 24 h, not while an e-way bill is active). On success the
 * IRN/ack columns are cleared (the voucher is no longer e-invoiced) and the cancelled IRN, date
 * and reason are kept in the audit row — there is no column for a cancelled IRN and WP 3.5 adds
 * no migration. NIC will not issue a new IRN for the same document number ([GEN] validation 12,
 * error 2278). Service-level only: no IPC channel / UI yet.
 */
export async function cancelIrn(
  db: DB, slug: string, company: CompanyInfo, voucherId: number, reason: NicCancelReason, remark = '', deps: NicDeps = {}
): Promise<{ irn: string; cancelDate: string }> {
  const ctx = context(db, slug, company, deps)
  const v = voucherForNic(db, voucherId)
  if (!v.irn) throw new NicError('This invoice has no IRN to cancel', [], 'config')
  if (v.ewb_no) throw new NicError('Cancel the e-way bill first — an IRN with an active e-way bill cannot be cancelled', ['2230'], 'config')
  const { data } = await einvCall(ctx.creds, ctx.gstin, 'POST', '/eicore/v1.03/Invoice/Cancel', {
    Irn: v.irn, CnlRsn: IRN_CANCEL_CODE[reason], CnlRem: remark.slice(0, 100)
  }, ctx.deps)
  const cancelDate = str(data.CancelDate)
  const before = { irn: v.irn, irnAckNo: v.irn_ack_no, irnAckDate: v.irn_ack_date }
  db.transaction(() => {
    db.prepare('UPDATE vouchers SET irn = NULL, irn_ack_no = NULL, irn_ack_date = NULL WHERE id = ?').run(voucherId)
    writeAudit(db, 'voucher', voucherId, 'update', before, { irn: null, irnAckNo: null, irnAckDate: null, cancelledIrn: v.irn, irnCancelDate: cancelDate, irnCancelReason: reason })
  })()
  log('info', 'nic-irn-cancelled', { voucherId })
  return { irn: str(data.Irn) || v.irn, cancelDate }
}

/** Get IRN details ([GET], GET /eicore/v1.03/Invoice/irn/{irn}; within 3 days of generation). */
export async function getIrnDetails(db: DB, slug: string, company: CompanyInfo, irn: string, deps: NicDeps = {}): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f]{64}$/i.test(irn)) throw new NicError('Not an IRN (64 hex characters)', [], 'config')
  const ctx = context(db, slug, company, deps)
  return (await einvCall(ctx.creds, ctx.gstin, 'GET', `/eicore/v1.03/Invoice/irn/${irn}`, null, ctx.deps)).data
}

/** Cancel a voucher's e-way bill ([CEWB], action CANEWB; within 24 h). Clears ewb_no/valid-upto;
 *  the cancelled number stays in the audit row. Service-level only: no IPC channel / UI yet. */
export async function cancelEwb(
  db: DB, slug: string, company: CompanyInfo, voucherId: number, reason: NicCancelReason, remark = '', deps: NicDeps = {}
): Promise<{ ewbNo: string; cancelDate: string }> {
  const ctx = context(db, slug, company, deps)
  const v = voucherForNic(db, voucherId)
  if (!v.ewb_no) throw new NicError('This voucher has no e-way bill to cancel', [], 'config')
  // [CEWB] data structure: cancelRmrk Text(50).
  const data = await ewayApiCall(ctx.creds, ctx.gstin, 'CANEWB', { ewbNo: Number(v.ewb_no), cancelRsnCode: EWB_CANCEL_CODE[reason], cancelRmrk: remark.slice(0, 50) }, ctx.deps)
  const cancelDate = str(data.cancelDate)
  db.transaction(() => {
    db.prepare('UPDATE vouchers SET ewb_no = NULL, ewb_valid_upto = NULL WHERE id = ?').run(voucherId)
    writeAudit(db, 'voucher', voucherId, 'update', { ewbNo: v.ewb_no, ewbValidUpto: v.ewb_valid_upto },
      { ewbNo: null, ewbValidUpto: null, cancelledEwbNo: v.ewb_no, ewbCancelDate: cancelDate, ewbCancelReason: reason })
  })()
  log('info', 'nic-ewb-cancelled', { voucherId })
  return { ewbNo: str(data.ewayBillNo) || v.ewb_no, cancelDate }
}

export interface EwbExtendInput {
  /** [MASTER] "Reasons for extension of validity": 1 Natural Calamity, 2 Law and Order,
   *  4 Transshipment, 5 Accident, 99 Others. */
  reasonCode: 1 | 2 | 4 | 5 | 99
  remarks: string
  fromPlace: string
  fromStateCode: number
  fromPincode: number
  remainingDistanceKm: number
  /** 1 road, 2 rail, 3 air, 4 ship, 5 in transit ([MASTER]). */
  transMode: '1' | '2' | '3' | '4' | '5'
  vehicleNo?: string
  transDocNo?: string
  /** ISO date. */
  transDocDate?: string
  /** Only for transMode 5: R road, W warehouse, O others ([EXT] validations). */
  transitType?: 'R' | 'W' | 'O'
  addressLine1?: string
}

/** Extend an e-way bill's validity ([EXT], action EXTENDVALIDITY; between 8 h before and 8 h
 *  after expiry). Stores the new valid-upto. Route via the IRP UNVERIFIED (see header). */
export async function extendEwb(db: DB, slug: string, company: CompanyInfo, voucherId: number, input: EwbExtendInput, deps: NicDeps = {}): Promise<{ ewbNo: string; validUpto: string }> {
  const ctx = context(db, slug, company, deps)
  const v = voucherForNic(db, voucherId)
  if (!v.ewb_no) throw new NicError('This voucher has no e-way bill to extend', [], 'config')
  if (input.transMode === '1' && !input.vehicleNo) throw new NicError('Road transport needs a vehicle number', ['4011'], 'config')
  if (!/^\d{6}$/.test(String(input.fromPincode))) throw new NicError('The current location needs a 6-digit PIN code', [], 'config')
  const inTransit = input.transMode === '5'
  const iso = input.transDocDate?.split('-')
  const data = await ewayApiCall(ctx.creds, ctx.gstin, 'EXTENDVALIDITY', {
    ewbNo: Number(v.ewb_no),
    vehicleNo: input.vehicleNo ? input.vehicleNo.replace(/[\s-]/g, '').toUpperCase() : '',
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
  }, ctx.deps)
  const validUpto = str(data.validUpto)
  db.transaction(() => {
    db.prepare('UPDATE vouchers SET ewb_valid_upto = ? WHERE id = ?').run(validUpto, voucherId)
    writeAudit(db, 'voucher', voucherId, 'update', { ewbNo: v.ewb_no, ewbValidUpto: v.ewb_valid_upto }, { ewbNo: v.ewb_no, ewbValidUpto: validUpto, ewbExtensionReason: input.reasonCode })
  })()
  log('info', 'nic-ewb-extended', { voucherId })
  return { ewbNo: str(data.ewayBillNo) || v.ewb_no, validUpto }
}
