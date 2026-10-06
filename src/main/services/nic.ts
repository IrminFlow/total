/**
 * Live filing against the NIC e-Invoice API suite (v1.04 auth, v1.03 IRN + EWB-by-IRN).
 * Needs API credentials (direct-access registration on einvoice1.gst.gov.in, or GSP
 * credentials) and the NIC RSA public key. Everything is stored per company; the app
 * stays fully functional offline — this is the optional online path.
 */
import crypto from 'crypto'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { nicCredentialsSchema, type NicCredentials } from '@shared/schemas'
import { buildEInvoiceJson, type EdocCompany } from '@shared/gst/edocs'
import { extractEdocInvoices } from './edocs'
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

// ---------- crypto helpers (NIC conventions) ----------

function rsaEncrypt(publicKeyPem: string, data: Buffer): string {
  return crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, data).toString('base64')
}

function aesEncrypt(key: Buffer, plain: string): string {
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null)
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

function aesDecrypt(key: Buffer, b64: string): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null)
  return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()])
}

// ---------- session ----------

interface NicSession {
  authToken: string
  sek: Buffer
  obtainedAt: number
  /** Identity the token was issued for (sessionKey) — a different identity never reuses it. */
  key: string
}

const SESSION_TTL_MS = 4 * 60 * 60 * 1000

/** One cached session, valid only for the exact identity it was obtained for. Also reset on
 *  credential save and on company switch/close (ipc.ts closeCurrentCompany). */
let session: NicSession | null = null

/** The identity a session belongs to: GSTIN + username + client id + endpoint (sandbox vs
 *  production), plus a digest of the secrets so a changed password/secret can't ride on an old
 *  token. Raw secrets never end up in the key. */
function sessionKey(creds: NicCredentials, gstin: string): string {
  const secretDigest = crypto.createHash('sha256').update(`${creds.password}\u0000${creds.clientSecret}`).digest('hex')
  return JSON.stringify([gstin.toUpperCase(), creds.username, creds.clientId, creds.baseUrlEinvoice.replace(/\/$/, ''), secretDigest])
}

export type NicFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>
const defaultFetch: NicFetch = (url, init) => fetch(url, init)

interface NicEnvelope {
  Status: number | string
  Data?: string
  ErrorDetails?: { ErrorMessage?: string; error_description?: string }[] | string
  error?: { message?: string } | string
}

function nicError(body: NicEnvelope, fallback: string): Error {
  let detail = ''
  if (Array.isArray(body.ErrorDetails)) {
    detail = body.ErrorDetails.map((e) => e.ErrorMessage ?? e.error_description ?? '').filter(Boolean).join('; ')
  } else if (typeof body.ErrorDetails === 'string') {
    try {
      const parsed = JSON.parse(body.ErrorDetails) as { ErrorMessage?: string }[]
      detail = parsed.map((e) => e.ErrorMessage ?? '').join('; ')
    } catch {
      detail = body.ErrorDetails
    }
  } else if (body.error) {
    detail = typeof body.error === 'string' ? body.error : (body.error.message ?? '')
  }
  return new Error(detail || fallback)
}

/** Exported for tests (inject `fetchFn`; no real network). */
export async function authenticate(creds: NicCredentials, gstin: string, fetchFn: NicFetch = defaultFetch): Promise<NicSession> {
  const key = sessionKey(creds, gstin)
  if (session && session.key === key && Date.now() - session.obtainedAt < SESSION_TTL_MS) return session
  session = null
  const appKey = crypto.randomBytes(32)
  const payload = {
    UserName: creds.username,
    Password: creds.password,
    AppKey: appKey.toString('base64'),
    ForceRefreshAccessToken: false
  }
  const data = rsaEncrypt(creds.publicKeyPem, Buffer.from(JSON.stringify(payload), 'utf8'))
  const res = await fetchFn(`${creds.baseUrlEinvoice.replace(/\/$/, '')}/eivital/v1.04/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      gstin
    },
    body: JSON.stringify({ Data: data })
  })
  const body = (await res.json()) as NicEnvelope
  if (String(body.Status) !== '1' || !body.Data) throw nicError(body, `Authentication failed (HTTP ${res.status})`)
  const inner = JSON.parse(Buffer.from(body.Data, 'base64').toString('utf8')) as { AuthToken: string; Sek: string }
  const sek = aesDecrypt(appKey, inner.Sek)
  session = { authToken: inner.AuthToken, sek, obtainedAt: Date.now(), key }
  return session
}

async function nicPost(
  creds: NicCredentials,
  gstin: string,
  path: string,
  payload: unknown,
  fetchFn: NicFetch = defaultFetch
): Promise<Record<string, unknown>> {
  const s = await authenticate(creds, gstin, fetchFn)
  const res = await fetchFn(`${creds.baseUrlEinvoice.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      gstin,
      user_name: creds.username,
      AuthToken: s.authToken
    },
    body: JSON.stringify({ Data: aesEncrypt(s.sek, JSON.stringify(payload)) })
  })
  const body = (await res.json()) as NicEnvelope
  if (String(body.Status) !== '1' || !body.Data) {
    if (res.status === 401) session = null
    throw nicError(body, `Request failed (HTTP ${res.status})`)
  }
  return JSON.parse(aesDecrypt(s.sek, body.Data).toString('utf8')) as Record<string, unknown>
}

// ---------- operations ----------

export interface IrnResult {
  irn: string
  ackNo: string
  ackDate: string
}

/** Generate an IRN for one sales voucher and store it on the voucher. */
export async function generateIrn(db: DB, slug: string, company: CompanyInfo, voucherId: number): Promise<IrnResult> {
  const creds = readNicCredentials(db, slug)
  assertConfigured(creds)
  if (!company.gstin) throw new Error('Company GSTIN is missing')
  const existing = db.prepare('SELECT irn FROM vouchers WHERE id = ?').get(voucherId) as { irn: string | null } | undefined
  if (!existing) throw new Error('Voucher not found')
  if (existing.irn) throw new Error('This invoice already has an IRN')

  const [invoice] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
  if (!invoice) throw new Error('Only sales vouchers can be e-invoiced')
  if (!invoice.partyGstin) throw new Error('e-Invoice needs a registered (GSTIN) buyer')

  const edocCompany: EdocCompany = {
    name: company.name, gstin: company.gstin, stateCode: company.stateCode, address: company.address
  }
  const [payload] = buildEInvoiceJson([invoice], edocCompany)
  const result = await nicPost(creds, company.gstin, '/eicore/v1.03/Invoice', payload)
  const irn = String(result.Irn ?? '')
  if (!irn) throw new Error('Portal returned no IRN')
  const ackNo = String(result.AckNo ?? '')
  const ackDate = String(result.AckDt ?? '')
  db.prepare('UPDATE vouchers SET irn = ?, irn_ack_no = ?, irn_ack_date = ? WHERE id = ?')
    .run(irn, ackNo, ackDate, voucherId)
  writeAudit(db, 'voucher', voucherId, 'update', null, { irn })
  return { irn, ackNo, ackDate }
}

export interface EwbResult {
  ewbNo: string
  validUpto: string
}

/** Generate an e-way bill against an existing IRN (dispatch details from the voucher). */
export async function generateEwbByIrn(db: DB, slug: string, company: CompanyInfo, voucherId: number): Promise<EwbResult> {
  const creds = readNicCredentials(db, slug)
  assertConfigured(creds)
  if (!company.gstin) throw new Error('Company GSTIN is missing')
  const v = db.prepare('SELECT irn, ewb_no, vehicle_no, transporter_id, transport_distance FROM vouchers WHERE id = ?').get(voucherId) as
    | { irn: string | null; ewb_no: string | null; vehicle_no: string | null; transporter_id: string | null; transport_distance: number | null }
    | undefined
  if (!v) throw new Error('Voucher not found')
  if (!v.irn) throw new Error('Generate the IRN first — the e-way bill hangs off it')
  if (v.ewb_no) throw new Error('This invoice already has an e-way bill')
  if (!v.vehicle_no && !v.transporter_id) throw new Error('Add a vehicle number or transporter ID on the voucher first')

  const payload = {
    Irn: v.irn,
    Distance: v.transport_distance ?? 0,
    TransMode: v.vehicle_no ? '1' : null,
    TransId: v.transporter_id || null,
    VehNo: v.vehicle_no || null,
    VehType: v.vehicle_no ? 'R' : null
  }
  const result = await nicPost(creds, company.gstin, '/eiewb/v1.03/ewaybill', payload)
  const ewbNo = String(result.EwbNo ?? '')
  if (!ewbNo) throw new Error('Portal returned no e-way bill number')
  const validUpto = String(result.EwbValidTill ?? '')
  db.prepare('UPDATE vouchers SET ewb_no = ?, ewb_valid_upto = ? WHERE id = ?').run(ewbNo, validUpto, voucherId)
  writeAudit(db, 'voucher', voucherId, 'update', null, { ewbNo })
  return { ewbNo, validUpto }
}

/** Drop the cached session (e.g. after editing credentials). */
export function resetNicSession(): void {
  session = null
}
