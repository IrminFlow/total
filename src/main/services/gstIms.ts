import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import { DEFAULT_RECON2B_TOLERANCES, type Recon2bTolerances } from '@shared/gst/recon2b'
import { imsActionsCsv, imsActionsJson, type ImsActionRecord } from '@shared/gst/ims'
import { recon2bTolerancesSchema, imsDecisionSchema, type ImsDecisionInput } from '@shared/gst/expansionSchemas'
import { writeAudit } from './audit'
import { companyExportsDir } from '../paths'

/**
 * GSTR-2B matcher tolerances + the IMS action list (WP 3.4). Tolerances live in `meta`
 * (`gst.recon2b.tolerances`); decisions in gst_ims_actions (migration 028). Nothing here posts a
 * voucher — a record missing in the books is proposed through the 2B screen's "Create purchase".
 */

const TOLERANCE_KEY = 'gst.recon2b.tolerances'

export function getRecon2bTolerances(db: DB): Recon2bTolerances {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(TOLERANCE_KEY) as { value: string } | undefined
  let raw: unknown = {}
  try {
    raw = row ? JSON.parse(row.value) : {}
  } catch {
    raw = {}
  }
  const parsed = recon2bTolerancesSchema.safeParse(raw)
  return parsed.success ? parsed.data : { ...DEFAULT_RECON2B_TOLERANCES }
}

export function setRecon2bTolerances(db: DB, input: unknown): Recon2bTolerances {
  const before = getRecon2bTolerances(db)
  const parsed = recon2bTolerancesSchema.parse(input)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(TOLERANCE_KEY, JSON.stringify(parsed))
  writeAudit(db, 'company', 0, 'update', { recon2bTolerances: before }, { recon2bTolerances: parsed })
  return parsed
}

interface ImsRow {
  period: string
  supplier_gstin: string
  doc_type: 'INV' | 'CN' | 'DN'
  doc_no: string
  doc_date: string
  action: 'accept' | 'reject' | 'pending'
  note: string | null
  record_json: string | null
  voucher_id: number | null
  decided_at: string
}

const mapRow = (r: ImsRow): ImsActionRecord => {
  let rec: Partial<Record<'value' | 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess', number | null>> = {}
  try {
    rec = r.record_json ? (JSON.parse(r.record_json) as typeof rec) : {}
  } catch {
    rec = {}
  }
  return {
    period: r.period, supplierGstin: r.supplier_gstin, docType: r.doc_type, docNo: r.doc_no, docDate: r.doc_date,
    action: r.action, note: r.note, decidedAt: r.decided_at, voucherId: r.voucher_id,
    value: rec.value ?? null, taxable: rec.taxable ?? null, igst: rec.igst ?? null, cgst: rec.cgst ?? null, sgst: rec.sgst ?? null, cess: rec.cess ?? null
  }
}

export function listImsActions(db: DB, period: string): ImsActionRecord[] {
  return (db.prepare('SELECT * FROM gst_ims_actions WHERE period = ? ORDER BY supplier_gstin, doc_date, doc_no').all(period) as ImsRow[]).map(mapRow)
}

/**
 * Store (or clear, when action is null) IMS decisions for one return period, in one
 * transaction — the 2B screen's per-row actions and its bulk accept both land here. A voucher id
 * that no longer exists (or sits in the bin) is dropped rather than refused.
 */
export function setImsActions(db: DB, period: string, raw: ImsDecisionInput[]): { saved: number; cleared: number } {
  const decisions = raw.map((d) => imsDecisionSchema.parse(d))
  const live = db.prepare('SELECT 1 FROM vouchers WHERE id = ? AND deleted_at IS NULL')
  const upsert = db.prepare(
    `INSERT INTO gst_ims_actions (period, supplier_gstin, doc_type, doc_no, doc_date, action, note, record_json, voucher_id, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(period, supplier_gstin, doc_type, doc_no) DO UPDATE SET
       doc_date = excluded.doc_date, action = excluded.action, note = excluded.note, record_json = excluded.record_json,
       voucher_id = excluded.voucher_id, decided_at = excluded.decided_at`
  )
  const del = db.prepare('DELETE FROM gst_ims_actions WHERE period = ? AND supplier_gstin = ? AND doc_type = ? AND doc_no = ?')
  let saved = 0
  let cleared = 0
  db.transaction(() => {
    for (const d of decisions) {
      const gstin = d.supplierGstin.toUpperCase()
      if (d.action == null) {
        cleared += del.run(period, gstin, d.docType, d.docNo).changes
        continue
      }
      const voucherId = d.voucherId != null && live.get(d.voucherId) ? d.voucherId : null
      const record = JSON.stringify({ value: d.value, taxable: d.taxable, igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: d.cess })
      upsert.run(period, gstin, d.docType, d.docNo, d.docDate, d.action, d.note, record, voucherId)
      saved++
    }
    writeAudit(db, 'gst_ims', 0, 'update', null, { imsActions: { period, saved, cleared } })
  })()
  return { saved, cleared }
}

/** Write the period's IMS action list as JSON + CSV into exports/ (the app's own layout — see
 *  ims.ts; the portal's IMS offline-tool schema is unpublished). */
export function exportImsActions(db: DB, slug: string, gstin: string, period: string): { jsonPath: string; csvPath: string; count: number } {
  const records = listImsActions(db, period)
  if (records.length === 0) throw new Error('No IMS actions recorded for this period yet')
  const dir = companyExportsDir(slug)
  const jsonPath = join(dir, `ims-actions-${period}.json`)
  const csvPath = join(dir, `ims-actions-${period}.csv`)
  writeFileSync(jsonPath, JSON.stringify(imsActionsJson(gstin, period, records), null, 2))
  writeFileSync(csvPath, imsActionsCsv(records))
  return { jsonPath, csvPath, count: records.length }
}
