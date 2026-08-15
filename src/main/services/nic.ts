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

// ---------- credential storage ----------

export function readNicCredentials(db: DB): NicCredentials {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'nic'").get() as { value: string } | undefined
  if (!row) return nicCredentialsSchema.parse({})
  try {
    return nicCredentialsSchema.parse(JSON.parse(row.value))
  } catch {
    return nicCredentialsSchema.parse({})
  }
}

export function writeNicCredentials(db: DB, creds: NicCredentials): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('nic', JSON.stringify(creds))
  // Credentials (incl. password) never go into the audit trail — before/after are always null.
  writeAudit(db, 'nic_credentials', 0, 'update', null, null)
}

export function nicConfigured(db: DB): boolean {
  const c = readNicCredentials(db)
  return !!(c.baseUrlEinvoice && c.username && c.password && c.clientId && c.publicKeyPem)
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
}

let session: NicSession | null = null

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

async function authenticate(creds: NicCredentials, gstin: string): Promise<NicSession> {
  if (session && Date.now() - session.obtainedAt < 4 * 60 * 60 * 1000) return session
  const appKey = crypto.randomBytes(32)
  const payload = {
    UserName: creds.username,
    Password: creds.password,
    AppKey: appKey.toString('base64'),
    ForceRefreshAccessToken: false
  }
  const data = rsaEncrypt(creds.publicKeyPem, Buffer.from(JSON.stringify(payload), 'utf8'))
  const res = await fetch(`${creds.baseUrlEinvoice.replace(/\/$/, '')}/eivital/v1.04/auth`, {
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
  session = { authToken: inner.AuthToken, sek, obtainedAt: Date.now() }
  return session
}

async function nicPost(
  creds: NicCredentials,
  gstin: string,
  path: string,
  payload: unknown
): Promise<Record<string, unknown>> {
  const s = await authenticate(creds, gstin)
  const res = await fetch(`${creds.baseUrlEinvoice.replace(/\/$/, '')}${path}`, {
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
export async function generateIrn(db: DB, company: CompanyInfo, voucherId: number): Promise<IrnResult> {
  const creds = readNicCredentials(db)
  if (!nicConfigured(db)) throw new Error('Live filing is not configured — add NIC API credentials first')
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
export async function generateEwbByIrn(db: DB, company: CompanyInfo, voucherId: number): Promise<EwbResult> {
  const creds = readNicCredentials(db)
  if (!nicConfigured(db)) throw new Error('Live filing is not configured — add NIC API credentials first')
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
