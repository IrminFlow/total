import { createHash, randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Recon2bPair, Recon2bResult } from '@shared/gst/recon2b'
import { upcomingDeadlines, type DeadlineKind } from '@shared/compliance'
import { companyExportsDir } from '../paths'
import { recon2b } from './gst'
import { tdsSummary } from './tds'
import { writeAudit } from './audit'
import { IN_BOOKS, requireInBooksVoucher } from './vouchers'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface Gst2bImportRow {
  id: number; period: string; sourceHash: string; fileName: string | null; toleranceValue: number
  toleranceTax: number; summary: Recon2bResult['buckets']; importedBy: string; importedAt: string
}

function importRow(row: Record<string, unknown>): Gst2bImportRow {
  return {
    id: Number(row.id), period: String(row.period), sourceHash: String(row.sourceHash), fileName: row.fileName == null ? null : String(row.fileName),
    toleranceValue: Number(row.toleranceValue), toleranceTax: Number(row.toleranceTax),
    summary: JSON.parse(String(row.summaryJson)) as Recon2bResult['buckets'], importedBy: String(row.importedBy), importedAt: String(row.importedAt)
  }
}

export function listGst2bImports(db: DB, period?: string): Gst2bImportRow[] {
  const sql = `SELECT id, period, source_hash AS sourceHash, file_name AS fileName,
    tolerance_value AS toleranceValue, tolerance_tax AS toleranceTax, summary_json AS summaryJson,
    imported_by AS importedBy, imported_at AS importedAt FROM gst2b_imports`
  const rows = period ? db.prepare(`${sql} WHERE period = ? ORDER BY imported_at DESC, id DESC`).all(period) : db.prepare(`${sql} ORDER BY imported_at DESC, id DESC`).all()
  return (rows as Record<string, unknown>[]).map(importRow)
}

function pairKey(pair: Recon2bPair, index: number): string {
  if (pair.portal) return `portal:${pair.portal.gstin}:${pair.portal.kind}:${pair.portal.number}:${pair.portal.date}`
  if (pair.book) return `book:${pair.book.voucherId}`
  return `row:${index}`
}

export function saveGst2bImport(
  db: DB,
  input: { jsonText: string; fileName?: string | null; from: string; to: string; period: string },
  actor: string
): { imported: Gst2bImportRow; result: Recon2bResult; errors: string[]; duplicate: boolean } {
  const sourceHash = sha256(input.jsonText)
  const existing = db.prepare('SELECT id FROM gst2b_imports WHERE source_hash = ?').get(sourceHash) as { id: number } | undefined
  const compared = recon2b(db, input.jsonText, input.from, input.to)
  if (existing) return { imported: listGst2bImports(db).find((row) => row.id === existing.id)!, result: compared.result, errors: compared.errors, duplicate: true }
  const imported = db.transaction(() => {
    const inserted = db.prepare(
      `INSERT INTO gst2b_imports (period, source_hash, file_name, source_json, summary_json, imported_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(input.period, sourceHash, input.fileName?.trim() || null, input.jsonText, JSON.stringify(compared.result.buckets), actor)
    const importId = Number(inserted.lastInsertRowid)
    const add = db.prepare(
      `INSERT INTO itc_action_items
       (import_id, source_key, bucket, classification, voucher_id, portal_json, book_json, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    compared.result.pairs.forEach((pair, index) => {
      if (pair.bucket === 'matched') return
      const classification = pair.bucket === 'missingInBooks' ? 'missing' : pair.bucket === 'missingInPortal' ? 'follow_up' : 'mismatched'
      add.run(importId, pairKey(pair, index), pair.bucket, classification, pair.book?.voucherId ?? null,
        pair.portal ? JSON.stringify(pair.portal) : null, pair.book ? JSON.stringify(pair.book) : null, actor)
    })
    writeAudit(db, 'gst2b_import', importId, 'import', null, { period: input.period, sourceHash, fileName: input.fileName ?? null, buckets: compared.result.buckets })
    return listGst2bImports(db).find((row) => row.id === importId)!
  })()
  return { imported, result: compared.result, errors: compared.errors, duplicate: false }
}

export interface ItcActionRow {
  id: number; importId: number; period: string; sourceKey: string; bucket: string; classification: 'missing' | 'mismatched' | 'blocked' | 'reversed' | 'follow_up'
  status: 'open' | 'waiting_supplier' | 'resolved' | 'dismissed'; owner: string | null; dueDate: string | null; note: string | null
  voucherId: number | null; portal: Record<string, unknown> | null; book: Record<string, unknown> | null; updatedBy: string; updatedAt: string
}

export function listItcActions(db: DB, period?: string): ItcActionRow[] {
  const rows = db.prepare(
    `SELECT a.id, a.import_id AS importId, i.period, a.source_key AS sourceKey, a.bucket, a.classification,
      a.status, a.owner, a.due_date AS dueDate, a.note, a.voucher_id AS voucherId,
      a.portal_json AS portalJson, a.book_json AS bookJson, a.updated_by AS updatedBy, a.updated_at AS updatedAt
     FROM itc_action_items a JOIN gst2b_imports i ON i.id = a.import_id
     WHERE (? IS NULL OR i.period = ?) ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'waiting_supplier' THEN 1 ELSE 2 END,
      COALESCE(a.due_date, '9999-12-31'), a.id DESC`
  ).all(period ?? null, period ?? null) as Record<string, unknown>[]
  return rows.map((row) => ({
    id: Number(row.id), importId: Number(row.importId), period: String(row.period), sourceKey: String(row.sourceKey), bucket: String(row.bucket),
    classification: row.classification as ItcActionRow['classification'], status: row.status as ItcActionRow['status'],
    owner: row.owner == null ? null : String(row.owner), dueDate: row.dueDate == null ? null : String(row.dueDate), note: row.note == null ? null : String(row.note),
    voucherId: row.voucherId == null ? null : Number(row.voucherId), portal: row.portalJson == null ? null : JSON.parse(String(row.portalJson)) as Record<string, unknown>,
    book: row.bookJson == null ? null : JSON.parse(String(row.bookJson)) as Record<string, unknown>, updatedBy: String(row.updatedBy), updatedAt: String(row.updatedAt)
  }))
}

export function updateItcAction(db: DB, id: number, patch: Pick<ItcActionRow, 'classification' | 'status' | 'owner' | 'dueDate' | 'note'>, actor: string): ItcActionRow {
  const before = listItcActions(db).find((row) => row.id === id)
  if (!before) throw new Error('ITC action not found')
  db.prepare(
    `UPDATE itc_action_items SET classification = ?, status = ?, owner = ?, due_date = ?, note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(patch.classification, patch.status, patch.owner?.trim() || null, patch.dueDate || null, patch.note?.trim() || null, actor, id)
  const after = listItcActions(db).find((row) => row.id === id)!
  writeAudit(db, 'itc_action', id, 'update', before, after)
  return after
}

export type EdocKind = 'einvoice' | 'eway'
export type EdocStatus = 'pending' | 'generated' | 'failed' | 'cancelled' | 'extended' | 'vehicle_updated' | 'expired'
export interface EdocEvent { id: number; voucherId: number; kind: EdocKind; status: EdocStatus; requestKey: string | null; documentNo: string | null; validUntil: string | null; vehicleNo: string | null; reason: string | null; actor: string; occurredAt: string }

export function edocEvents(db: DB, voucherId?: number): EdocEvent[] {
  const rows = db.prepare(
    `SELECT e.id, e.voucher_id AS voucherId, e.kind, e.status, e.request_key AS requestKey, e.document_no AS documentNo,
      e.valid_until AS validUntil, e.vehicle_no AS vehicleNo, e.reason, e.actor, e.occurred_at AS occurredAt
     FROM edoc_lifecycle_events e JOIN vouchers v ON v.id=e.voucher_id
     WHERE ${IN_BOOKS} AND (? IS NULL OR e.voucher_id = ?) ORDER BY e.occurred_at DESC, e.id DESC`
  ).all(voucherId ?? null, voucherId ?? null) as EdocEvent[]
  return rows
}

export function addEdocEvent(db: DB, input: Omit<EdocEvent, 'id' | 'actor' | 'occurredAt'> & { response?: unknown }, actor: string): EdocEvent {
  requireInBooksVoucher(
    db,
    input.voucherId,
    input.kind === 'einvoice'
      ? ['sales', 'credit_note', 'debit_note']
      : ['sales', 'purchase', 'credit_note', 'debit_note', 'stock_journal']
  )
  const result = db.prepare(
    `INSERT INTO edoc_lifecycle_events (voucher_id, kind, status, request_key, document_no, valid_until, vehicle_no, reason, response_json, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.voucherId, input.kind, input.status, input.requestKey, input.documentNo, input.validUntil, input.vehicleNo, input.reason,
    input.response == null ? null : JSON.stringify(input.response), actor)
  const created = edocEvents(db).find((row) => row.id === Number(result.lastInsertRowid))!
  writeAudit(db, 'edoc_lifecycle', created.id, 'create', null, created)
  return created
}

export interface TdsWorkspace {
  fyStartYear: number; quarter: 1 | 2 | 3 | 4; deducted: number; deposited: number; difference: number
  sections: ReturnType<typeof tdsSummary>; challans: TdsChallan[]; returnStatus: TdsReturnStatus
}
export interface TdsChallan { id: number; fyStartYear: number; quarter: number; bsrCode: string; challanSerial: string; depositDate: string; amount: number; note: string | null; createdBy: string; createdAt: string }
export interface TdsReturnStatus { status: 'draft' | 'prepared' | 'filed' | 'revised'; token: string | null; filedAt: string | null; note: string | null; updatedBy: string | null; updatedAt: string | null }

export function tdsWorkspace(db: DB, fyStartYear: number, quarter: 1 | 2 | 3 | 4): TdsWorkspace {
  const label = `Q${quarter} FY${fyStartYear}-${String(fyStartYear + 1).slice(2)}`
  const sections = tdsSummary(db, fyStartYear).filter((row) => row.quarter === label)
  const challans = db.prepare(
    `SELECT id, fy_start_year AS fyStartYear, quarter, bsr_code AS bsrCode, challan_serial AS challanSerial,
      deposit_date AS depositDate, amount, note, created_by AS createdBy, created_at AS createdAt
     FROM tds_challans WHERE fy_start_year = ? AND quarter = ? ORDER BY deposit_date, id`
  ).all(fyStartYear, quarter) as TdsChallan[]
  const row = db.prepare(
    `SELECT status, token, filed_at AS filedAt, note, updated_by AS updatedBy, updated_at AS updatedAt
     FROM tds_return_periods WHERE fy_start_year = ? AND quarter = ?`
  ).get(fyStartYear, quarter) as TdsReturnStatus | undefined
  const returnStatus = row ?? { status: 'draft', token: null, filedAt: null, note: null, updatedBy: null, updatedAt: null }
  const deducted = sections.reduce((sum, item) => sum + item.tds, 0)
  const deposited = challans.reduce((sum, item) => sum + item.amount, 0)
  return { fyStartYear, quarter, deducted, deposited, difference: deducted - deposited, sections, challans, returnStatus }
}

export function addTdsChallan(db: DB, input: Omit<TdsChallan, 'id' | 'createdBy' | 'createdAt'>, actor: string): TdsChallan {
  if (!/^\d{7}$/.test(input.bsrCode)) throw new Error('BSR code must be 7 digits')
  if (!/^\d{1,8}$/.test(input.challanSerial)) throw new Error('Challan serial must be 1–8 digits')
  const result = db.prepare(
    `INSERT INTO tds_challans (fy_start_year, quarter, bsr_code, challan_serial, deposit_date, amount, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.fyStartYear, input.quarter, input.bsrCode, input.challanSerial, input.depositDate, input.amount, input.note?.trim() || null, actor)
  const created = tdsWorkspace(db, input.fyStartYear, input.quarter as 1 | 2 | 3 | 4).challans.find((row) => row.id === Number(result.lastInsertRowid))!
  writeAudit(db, 'tds_challan', created.id, 'create', null, created)
  return created
}

export function setTdsReturnStatus(db: DB, fyStartYear: number, quarter: 1 | 2 | 3 | 4, status: TdsReturnStatus['status'], token: string | null, filedAt: string | null, note: string | null, actor: string): TdsWorkspace {
  if (status === 'filed' && (!token?.trim() || !filedAt)) throw new Error('Filed returns require the acknowledgement token and filing date')
  const before = tdsWorkspace(db, fyStartYear, quarter).returnStatus
  db.prepare(
    `INSERT INTO tds_return_periods (fy_start_year, quarter, status, token, filed_at, note, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fy_start_year, quarter) DO UPDATE SET
     status=excluded.status, token=excluded.token, filed_at=excluded.filed_at, note=excluded.note,
     updated_by=excluded.updated_by, updated_at=datetime('now')`
  ).run(fyStartYear, quarter, status, token?.trim() || null, filedAt, note?.trim() || null, actor)
  const after = tdsWorkspace(db, fyStartYear, quarter)
  writeAudit(db, 'tds_return', fyStartYear * 10 + quarter, 'update', before, after.returnStatus)
  return after
}

export interface ComplianceObligation { id: number; stableKey: string; kind: DeadlineKind | 'state' | 'custom'; title: string; dueDate: string; status: 'open' | 'in_progress' | 'filed' | 'paid' | 'not_applicable'; owner: string | null; note: string | null; source: 'statutory' | 'custom'; updatedBy: string; updatedAt: string }

export function syncComplianceCalendar(db: DB, company: CompanyInfo, today: string, hasPayroll: boolean, actor: string): ComplianceObligation[] {
  const deadlines = upcomingDeadlines(today, company.gstRegistrationType, hasPayroll, 370)
  const insert = db.prepare(
    `INSERT INTO compliance_obligations (stable_key, kind, title, due_date, source, updated_by)
     VALUES (?, ?, ?, ?, 'statutory', ?) ON CONFLICT(stable_key) DO UPDATE SET title=excluded.title, due_date=excluded.due_date`
  )
  db.transaction(() => { for (const item of deadlines) insert.run(item.id, item.kind, item.title, item.date, actor) })()
  return listComplianceObligations(db, today)
}

export function listComplianceObligations(db: DB, from?: string, to?: string): ComplianceObligation[] {
  return db.prepare(
    `SELECT id, stable_key AS stableKey, kind, title, due_date AS dueDate, status, owner, note, source,
      updated_by AS updatedBy, updated_at AS updatedAt FROM compliance_obligations
     WHERE (? IS NULL OR due_date >= ?) AND (? IS NULL OR due_date <= ?) ORDER BY due_date, title`
  ).all(from ?? null, from ?? null, to ?? null, to ?? null) as ComplianceObligation[]
}

export function saveComplianceObligation(db: DB, input: { id?: number; title: string; dueDate: string; kind: ComplianceObligation['kind']; status: ComplianceObligation['status']; owner?: string | null; note?: string | null }, actor: string): ComplianceObligation {
  const before = input.id ? listComplianceObligations(db).find((row) => row.id === input.id) : null
  if (input.id && !before) throw new Error('Compliance obligation not found')
  const id = input.id ?? Number(db.prepare(
    `INSERT INTO compliance_obligations (stable_key, kind, title, due_date, status, owner, note, source, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'custom', ?)`
  ).run(`custom:${randomUUID()}`, input.kind, input.title.trim(), input.dueDate, input.status, input.owner?.trim() || null, input.note?.trim() || null, actor).lastInsertRowid)
  if (input.id) db.prepare(
    `UPDATE compliance_obligations SET kind=?, title=?, due_date=?, status=?, owner=?, note=?, updated_by=?, updated_at=datetime('now') WHERE id=?`
  ).run(input.kind, input.title.trim(), input.dueDate, input.status, input.owner?.trim() || null, input.note?.trim() || null, actor, input.id)
  const after = listComplianceObligations(db).find((row) => row.id === id)!
  writeAudit(db, 'compliance_obligation', id, before ? 'update' : 'create', before, after)
  return after
}

export interface GstRegistration { id: number; gstin: string; legalName: string; stateCode: string; address: string; registrationType: 'regular' | 'composition'; isPrimary: boolean; active: boolean; invoicePrefix: string; createdBy: string; createdAt: string; updatedAt: string }

export function listGstRegistrations(db: DB): GstRegistration[] {
  const rows = db.prepare(
    `SELECT id, gstin, legal_name AS legalName, state_code AS stateCode, address, registration_type AS registrationType,
      is_primary AS isPrimary, active, invoice_prefix AS invoicePrefix, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt
     FROM gst_registrations ORDER BY is_primary DESC, state_code, legal_name`
  ).all() as (Omit<GstRegistration, 'isPrimary' | 'active'> & { isPrimary: number; active: number })[]
  return rows.map((row) => ({ ...row, isPrimary: !!row.isPrimary, active: !!row.active }))
}

export function saveGstRegistration(db: DB, input: Omit<GstRegistration, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'> & { id?: number }, actor: string): GstRegistration {
  const gstin = input.gstin.trim().toUpperCase()
  if (!/^\d{2}[A-Z0-9]{13}$/.test(gstin) || gstin.slice(0, 2) !== input.stateCode) throw new Error('GSTIN must be valid-shaped and start with the registration state code')
  const before = input.id ? listGstRegistrations(db).find((row) => row.id === input.id) : null
  const save = db.transaction(() => {
    if (input.isPrimary) db.prepare('UPDATE gst_registrations SET is_primary = 0').run()
    if (input.id) {
      db.prepare(`UPDATE gst_registrations SET gstin=?,legal_name=?,state_code=?,address=?,registration_type=?,is_primary=?,active=?,invoice_prefix=?,updated_at=datetime('now') WHERE id=?`)
        .run(gstin, input.legalName.trim(), input.stateCode, input.address.trim(), input.registrationType, input.isPrimary ? 1 : 0, input.active ? 1 : 0, input.invoicePrefix.trim().toUpperCase(), input.id)
      return input.id
    }
    return Number(db.prepare(`INSERT INTO gst_registrations (gstin,legal_name,state_code,address,registration_type,is_primary,active,invoice_prefix,created_by) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(gstin, input.legalName.trim(), input.stateCode, input.address.trim(), input.registrationType, input.isPrimary ? 1 : 0, input.active ? 1 : 0, input.invoicePrefix.trim().toUpperCase(), actor).lastInsertRowid)
  })()
  const after = listGstRegistrations(db).find((row) => row.id === save)!
  writeAudit(db, 'gst_registration', save, before ? 'update' : 'create', before, after)
  return after
}

/** Use the selected registration as the legal identity on its own return payload. */
export function companyForGstRegistration(db: DB, company: CompanyInfo, registrationId?: number | null): CompanyInfo {
  if (registrationId == null) return company
  const registration = listGstRegistrations(db).find((row) => row.id === registrationId && row.active)
  if (!registration) throw new Error('Active GST registration not found')
  return {
    ...company,
    name: registration.legalName,
    stateCode: registration.stateCode,
    gstin: registration.gstin,
    gstRegistrationType: registration.registrationType,
    address: registration.address
  }
}

export interface GstRegistrationSeries {
  id: number; registrationId: number; voucherTypeId: number; voucherTypeName: string
  prefix: string; suffix: string; padWidth: number; restartFy: boolean
}

export function listGstRegistrationSeries(db: DB, registrationId?: number): GstRegistrationSeries[] {
  const rows = db.prepare(
    `SELECT s.id, s.registration_id AS registrationId, s.voucher_type_id AS voucherTypeId,
      vt.name AS voucherTypeName, s.prefix, s.suffix, s.pad_width AS padWidth, s.restart_fy AS restartFy
     FROM gst_registration_series s JOIN voucher_types vt ON vt.id=s.voucher_type_id
     WHERE (? IS NULL OR s.registration_id=?) ORDER BY vt.name`
  ).all(registrationId ?? null, registrationId ?? null) as (Omit<GstRegistrationSeries, 'restartFy'> & { restartFy: number })[]
  return rows.map((row) => ({ ...row, restartFy: !!row.restartFy }))
}

export function saveGstRegistrationSeries(db: DB, input: Omit<GstRegistrationSeries, 'id' | 'voucherTypeName'>, actor: string): GstRegistrationSeries {
  if (!listGstRegistrations(db).some((row) => row.id === input.registrationId && row.active)) throw new Error('Active GST registration not found')
  const voucherType = db.prepare('SELECT id, gst_registration_id AS registrationId FROM voucher_types WHERE id=?').get(input.voucherTypeId) as { id: number; registrationId: number | null } | undefined
  if (!voucherType) throw new Error('Voucher type not found')
  if (voucherType.registrationId != null && voucherType.registrationId !== input.registrationId) throw new Error('Voucher type belongs to a different GST registration')
  const before = listGstRegistrationSeries(db, input.registrationId).find((row) => row.voucherTypeId === input.voucherTypeId) ?? null
  db.prepare(
    `INSERT INTO gst_registration_series(registration_id,voucher_type_id,prefix,suffix,pad_width,restart_fy)
     VALUES(?,?,?,?,?,?) ON CONFLICT(registration_id,voucher_type_id) DO UPDATE SET
     prefix=excluded.prefix,suffix=excluded.suffix,pad_width=excluded.pad_width,restart_fy=excluded.restart_fy`
  ).run(input.registrationId, input.voucherTypeId, input.prefix.trim().toUpperCase(), input.suffix.trim().toUpperCase(), input.padWidth, input.restartFy ? 1 : 0)
  const after = listGstRegistrationSeries(db, input.registrationId).find((row) => row.voucherTypeId === input.voucherTypeId)!
  writeAudit(db, 'gst_registration_series', after.id, before ? 'update' : 'create', before, after)
  return after
}

export interface LutAuthorization {
  id: number; registrationId: number; registrationGstin: string; fyStartYear: number; arn: string
  filedDate: string; validFrom: string; validTo: string; note: string | null; createdBy: string; createdAt: string
}

export function listLutAuthorizations(db: DB, registrationId?: number): LutAuthorization[] {
  return db.prepare(
    `SELECT l.id,l.registration_id AS registrationId,r.gstin AS registrationGstin,l.fy_start_year AS fyStartYear,
      l.arn,l.filed_date AS filedDate,l.valid_from AS validFrom,l.valid_to AS validTo,l.note,
      l.created_by AS createdBy,l.created_at AS createdAt
     FROM lut_authorizations l JOIN gst_registrations r ON r.id=l.registration_id
     WHERE (? IS NULL OR l.registration_id=?) ORDER BY l.fy_start_year DESC,r.gstin`
  ).all(registrationId ?? null, registrationId ?? null) as LutAuthorization[]
}

export function saveLutAuthorization(db: DB, input: Omit<LutAuthorization, 'id' | 'registrationGstin' | 'createdBy' | 'createdAt'>, actor: string): LutAuthorization {
  if (!listGstRegistrations(db).some((row) => row.id === input.registrationId && row.active)) throw new Error('Active GST registration not found')
  if (!input.arn.trim()) throw new Error('LUT acknowledgement reference is required')
  if (input.validFrom > input.validTo) throw new Error('LUT valid-from date must be before valid-to date')
  const before = listLutAuthorizations(db, input.registrationId).find((row) => row.fyStartYear === input.fyStartYear) ?? null
  db.prepare(
    `INSERT INTO lut_authorizations(registration_id,fy_start_year,arn,filed_date,valid_from,valid_to,note,created_by)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(registration_id,fy_start_year) DO UPDATE SET
     arn=excluded.arn,filed_date=excluded.filed_date,valid_from=excluded.valid_from,valid_to=excluded.valid_to,
     note=excluded.note,created_by=excluded.created_by,created_at=datetime('now')`
  ).run(input.registrationId, input.fyStartYear, input.arn.trim().toUpperCase(), input.filedDate, input.validFrom, input.validTo, input.note?.trim() || null, actor)
  const after = listLutAuthorizations(db, input.registrationId).find((row) => row.fyStartYear === input.fyStartYear)!
  writeAudit(db, 'lut_authorization', after.id, before ? 'update' : 'create', before, after)
  return after
}

export interface TaxContentPack { id: number; packKey: string; version: string; effectiveFrom: string; effectiveTo: string | null; title: string; content: Record<string, unknown>; sourceUrl: string | null; installedBy: string; installedAt: string; active: boolean }
export function listTaxContentPacks(db: DB): TaxContentPack[] {
  const rows = db.prepare(`SELECT id,pack_key AS packKey,version,effective_from AS effectiveFrom,effective_to AS effectiveTo,title,content_json AS contentJson,source_url AS sourceUrl,installed_by AS installedBy,installed_at AS installedAt,active FROM tax_content_packs ORDER BY pack_key,effective_from DESC`).all() as Record<string, unknown>[]
  return rows.map((row) => ({ id:Number(row.id), packKey:String(row.packKey), version:String(row.version), effectiveFrom:String(row.effectiveFrom), effectiveTo:row.effectiveTo==null?null:String(row.effectiveTo), title:String(row.title), content:JSON.parse(String(row.contentJson)) as Record<string,unknown>, sourceUrl:row.sourceUrl==null?null:String(row.sourceUrl), installedBy:String(row.installedBy), installedAt:String(row.installedAt), active:!!row.active }))
}
export function installTaxContentPack(db: DB, input: { packKey:string;version:string;effectiveFrom:string;effectiveTo?:string|null;title:string;content:Record<string,unknown>;sourceUrl?:string|null }, actor:string): TaxContentPack {
  const result=db.prepare(`INSERT INTO tax_content_packs(pack_key,version,effective_from,effective_to,title,content_json,source_url,installed_by) VALUES(?,?,?,?,?,?,?,?)`).run(input.packKey.trim(),input.version.trim(),input.effectiveFrom,input.effectiveTo??null,input.title.trim(),JSON.stringify(input.content),input.sourceUrl?.trim()||null,actor)
  const created=listTaxContentPacks(db).find((row)=>row.id===Number(result.lastInsertRowid))!;writeAudit(db,'tax_content_pack',created.id,'create',null,{...created,content:'[versioned guidance]'});return created
}

export function exportNoticeEvidencePack(db: DB, company: CompanyInfo, slug: string, from: string, to: string, actor: string): { dir: string; manifestPath: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const dir=join(companyExportsDir(slug),`notice-evidence-${from}-${to}-${stamp}`);mkdirSync(dir,{recursive:true})
  const vouchers=db.prepare(`SELECT v.id,v.date,v.number,vt.name AS type,v.narration,v.reference FROM vouchers v JOIN voucher_types vt ON vt.id=v.voucher_type_id WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} ORDER BY v.date,v.id`).all(from,to)
  const returns=db.prepare(`SELECT return_type AS returnType,period,status,frozen_at AS frozenAt,filed_at AS filedAt,arn,snapshot_hash AS snapshotHash FROM gst_return_periods WHERE from_date<=? AND to_date>=? ORDER BY period,return_type`).all(to,from)
  const imports=listGst2bImports(db).filter((row)=>row.period>=from.slice(5,7)+from.slice(0,4)&&row.period<=to.slice(5,7)+to.slice(0,4))
  const audit=db.prepare(`SELECT id,entity,entity_id AS entityId,action,at,user_name AS userName,row_hash AS rowHash FROM audit_log WHERE at>=? AND at<? ORDER BY id`).all(`${from} 00:00:00`,`${to} 23:59:59`)
  const manifest={schema:'total.notice-evidence.v1',createdAt:new Date().toISOString(),createdBy:actor,company:{name:company.name,gstin:company.gstin},period:{from,to},files:['vouchers.json','returns.json','gstr2b-imports.json','audit.json']}
  for(const [name,value] of [['vouchers.json',vouchers],['returns.json',returns],['gstr2b-imports.json',imports],['audit.json',audit]] as const)writeFileSync(join(dir,name),JSON.stringify(value,null,2))
  const manifestPath=join(dir,'manifest.json');writeFileSync(manifestPath,JSON.stringify(manifest,null,2));writeAudit(db,'export',0,'export',null,{kind:'notice_evidence',from,to,dir,files:manifest.files});return{dir,manifestPath}
}
