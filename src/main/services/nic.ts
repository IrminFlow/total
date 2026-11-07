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
import { nicTimestampMs, type EwbEvent, type EwbExtendRequest, type NicCancelReason, type NicRecord } from '@shared/gst/nicRecord'
import { writeAudit } from './audit'
import { GatewayError } from '../gstGateway/types'
import { createNicAdapter } from '../gstGateway/nicAdapter'
import {
  cancelEwbFlow, cancelIrnFlow, decodeJwsPayload, edocRecord, extendEwbFlow, generateEwbFlow, generateIrnFlow, readEwbHistory, VOUCHER_STORE,
  type EdocCall, type EwbResult, type IrnResult
} from '../gstGateway/edocFlow'
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
export class NicError extends GatewayError {
  constructor(message: string, codes: string[] = [], kind: 'portal' | 'network' | 'config' = 'portal') {
    super(message, codes, kind)
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

/** 'yyyy-MM-dd HH:mm:ss' read as IST (UTC+05:30 — UNVERIFIED, [AUTH] gives only the format); the
 *  EWB API's 'dd/MM/yyyy hh:mm:ss AM' too (shared/gst/nicRecord.ts). */
export const parseNicTimestamp = nicTimestampMs

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
export async function einvCall(
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
export async function ewayApiCall(creds: NicCredentials, gstin: string, action: string, payload: unknown, deps: NicDeps): Promise<Record<string, unknown>> {
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

// ---------- operations (Phase 4: the shared gateway flows over the NIC adapter) ----------
//
// The validation, persistence and audit of every IRN / e-way bill call live in
// gstGateway/edocFlow.ts (one implementation for every adapter); this client is the NIC adapter
// (gstGateway/nicAdapter.ts over einvCall / ewayApiCall above) writing to the voucher's own
// columns — behaviour unchanged (nicContract.dbtest.ts).

interface Ctx { creds: NicCredentials; gstin: string; deps: NicDeps }

function context(db: DB, slug: string, company: CompanyInfo, deps: NicDeps): Ctx {
  const store = deps.store ?? appSecretStore()
  const creds = readNicCredentials(db, slug, store)
  assertConfigured(creds, store)
  if (!company.gstin) throw new NicError('Company GSTIN is missing — set it in Company settings', [], 'config')
  return { creds, gstin: company.gstin.toUpperCase(), deps }
}

function nicCall(db: DB, slug: string, company: CompanyInfo, deps: NicDeps): EdocCall {
  const ctx = context(db, slug, company, deps)
  return {
    adapter: createNicAdapter(ctx.creds, ctx.deps),
    store: VOUCHER_STORE,
    who: { gstin: ctx.gstin, username: ctx.creds.username, password: '' },
    now: deps.now ?? Date.now
  }
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

export type { IrnResult, EwbResult, EwbEvent, NicRecord, NicCancelReason }
export { readEwbHistory, decodeJwsPayload }

/** Generate an IRN for one sales voucher (or outward credit/debit note) and store it on the voucher. */
export async function generateIrn(db: DB, slug: string, company: CompanyInfo, voucherId: number, deps: NicDeps = {}): Promise<IrnResult> {
  return generateIrnFlow(db, company, voucherId, nicCall(db, slug, company, deps))
}

/** Generate an e-way bill against an existing IRN ([EWB]). */
export async function generateEwbByIrn(db: DB, slug: string, company: CompanyInfo, voucherId: number, deps: NicDeps = {}): Promise<EwbResult> {
  return generateEwbFlow(db, company, voucherId, nicCall(db, slug, company, deps))
}

/** Cancel a voucher's IRN ([CNL]; edocFlow.cancelIrnFlow). */
export async function cancelIrn(
  db: DB, slug: string, company: CompanyInfo, voucherId: number, reason: NicCancelReason, remark = '', deps: NicDeps = {}
): Promise<{ irn: string; cancelDate: string }> {
  return cancelIrnFlow(db, voucherId, reason, remark, nicCall(db, slug, company, deps))
}

/** Get IRN details ([GET], GET /eicore/v1.03/Invoice/irn/{irn}; within 3 days of generation). */
export async function getIrnDetails(db: DB, slug: string, company: CompanyInfo, irn: string, deps: NicDeps = {}): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f]{64}$/i.test(irn)) throw new NicError('Not an IRN (64 hex characters)', [], 'config')
  const ctx = context(db, slug, company, deps)
  return (await einvCall(ctx.creds, ctx.gstin, 'GET', `/eicore/v1.03/Invoice/irn/${irn}`, null, ctx.deps)).data
}

/** Cancel a voucher's e-way bill ([CEWB] CANEWB; edocFlow.cancelEwbFlow). */
export async function cancelEwb(
  db: DB, slug: string, company: CompanyInfo, voucherId: number, reason: NicCancelReason, remark = '', deps: NicDeps = {}
): Promise<{ ewbNo: string; cancelDate: string }> {
  return cancelEwbFlow(db, voucherId, reason, remark, nicCall(db, slug, company, deps))
}

/** = shared/gst/nicRecord.ts EwbExtendRequest. */
export type EwbExtendInput = EwbExtendRequest

/** Extend an e-way bill's validity ([EXT] EXTENDVALIDITY; edocFlow.extendEwbFlow). Route via the
 *  IRP UNVERIFIED (see header). */
export async function extendEwb(db: DB, slug: string, company: CompanyInfo, voucherId: number, input: EwbExtendInput, deps: NicDeps = {}): Promise<{ ewbNo: string; validUpto: string }> {
  return extendEwbFlow(db, voucherId, input, nicCall(db, slug, company, deps))
}

/** Everything the IRP / EWB system returned for one voucher, as stored. QUERY — writes nothing. */
export function nicRecord(db: DB, voucherId: number, now: number = Date.now()): NicRecord {
  return edocRecord(db, VOUCHER_STORE, voucherId, now)
}

/** The JSON file "Save JSON" writes: the response fields as the IRP named them ([GEN]). */
export function signedCopyJson(rec: NicRecord): Record<string, unknown> {
  if (!rec.irn) throw new NicError('This voucher has no IRN', [], 'config')
  if (!rec.signedInvoice && !rec.signedQrCode) throw new NicError('No signed copy is stored for this IRN (it was generated before Total kept them, or adopted without one)', [], 'config')
  return {
    Irn: rec.irn, AckNo: rec.ackNo, AckDt: rec.ackDate,
    SignedInvoice: rec.signedInvoice, SignedQRCode: rec.signedQrCode,
    DocNo: rec.number, DocDt: rec.date
  }
}
