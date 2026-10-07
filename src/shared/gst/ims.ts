/**
 * Invoice Management System (IMS) action list (WP 3.4). On the GST portal a recipient marks each
 * inward record its suppliers reported — Accept, Reject or Pending (no action = deemed
 * accepted) — before GSTR-2B is generated / recomputed; the sourced rules are in ./sources.ts
 * (IMS_RULES). Total is offline, so it can only PREPARE the decisions: the user reviews the
 * GSTR-2B records here (matched against the books), records an action per record, and exports
 * the list to act on in the portal. Nothing is posted and nothing is uploaded from the app.
 *
 * Pure: storage is services/gstExpansion.ts (gst_ims_actions, migration 028).
 */
import type { PortalInvoice, Recon2bPair, Recon2bBucket } from './recon2b'
import { normalizeGstin } from './recon2b'

export type ImsAction = 'accept' | 'reject' | 'pending'
export type ImsDocType = 'INV' | 'CN' | 'DN'

export const IMS_ACTION_LABELS: Record<ImsAction, string> = { accept: 'Accept', reject: 'Reject', pending: 'Pending' }

/** One stored decision (a gst_ims_actions row). */
export interface ImsActionRecord {
  period: string
  supplierGstin: string
  docType: ImsDocType
  docNo: string
  /** ISO. */
  docDate: string
  action: ImsAction
  note: string | null
  decidedAt: string
  voucherId: number | null
  /** The portal figures the decision was taken on (paise). */
  value: number | null
  taxable: number | null
  igst: number | null
  cgst: number | null
  sgst: number | null
  cess: number | null
}

/** The identity of a 2B / IMS record. */
export interface ImsKey {
  period: string
  supplierGstin: string
  docType: ImsDocType
  docNo: string
}

export const imsDocTypeOf = (p: PortalInvoice): ImsDocType => (p.kind === 'b2b' ? 'INV' : p.noteType === 'D' ? 'DN' : 'CN')

export function imsKeyOf(period: string, p: PortalInvoice): ImsKey {
  return { period, supplierGstin: normalizeGstin(p.gstin), docType: imsDocTypeOf(p), docNo: p.number.trim() }
}

export const imsKeyString = (k: ImsKey): string => `${k.period}|${k.supplierGstin}|${k.docType}|${k.docNo}`

/** One row of the IMS tab: a portal record, its book match (if any) and the stored decision. */
export interface ImsRow {
  key: string
  period: string
  portal: PortalInvoice
  docType: ImsDocType
  bucket: Recon2bBucket
  voucherId: number | null
  partyName: string | null
  partyLedgerId: number | null
  /** The stored action, or null when undecided (the portal treats no action as deemed accepted). */
  action: ImsAction | null
  note: string | null
  decidedAt: string | null
  /** What the reconciliation suggests: accept a matched record, keep a mismatched one pending,
   *  and pending for a record the books don't have (reject only after confirming with the
   *  supplier — the app never suggests it). */
  suggested: ImsAction
}

export function suggestedImsAction(bucket: Recon2bBucket): ImsAction {
  return bucket === 'matched' ? 'accept' : 'pending'
}

/** The IMS rows for a period: every portal-side pair, joined to the stored decisions. */
export function imsRows(period: string, pairs: Recon2bPair[], stored: ImsActionRecord[]): ImsRow[] {
  const byKey = new Map(stored.map((s) => [imsKeyString(s), s]))
  const out: ImsRow[] = []
  for (const pair of pairs) {
    if (!pair.portal) continue
    const k = imsKeyOf(period, pair.portal)
    const key = imsKeyString(k)
    const s = byKey.get(key)
    out.push({
      key,
      period,
      portal: pair.portal,
      docType: k.docType,
      bucket: pair.bucket,
      voucherId: pair.book?.voucherId ?? null,
      partyName: pair.book?.partyName ?? null,
      partyLedgerId: pair.book?.partyLedgerId ?? null,
      action: s?.action ?? null,
      note: s?.note ?? null,
      decidedAt: s?.decidedAt ?? null,
      suggested: suggestedImsAction(pair.bucket)
    })
  }
  return out
}

/** "Bulk accept": the keys of the rows to accept — every matched record not yet decided (or,
 *  with `overwrite`, every matched record). */
export function bulkAcceptKeys(rows: ImsRow[], overwrite = false): string[] {
  return rows.filter((r) => r.bucket === 'matched' && (overwrite || r.action == null)).map((r) => r.key)
}

// ---------- export ----------

const rupees = (paise: number | null): number | null => (paise == null ? null : Math.round(paise) / 100)
const portalDate = (iso: string): string => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`
const ACTION_CODE: Record<ImsAction, string> = { accept: 'A', reject: 'R', pending: 'P' }

/**
 * The action list as JSON. No IMS offline-tool / API upload schema is published in a form we
 * could cite (UNVERIFIED — see ./sources.ts), so this is the app's own layout: per record the
 * fields the portal identifies a record by (supplier GSTIN, document type, number, date, value,
 * taxes) and the action as the portal's A/R/P. Act on it in the IMS dashboard, record by record
 * or via the portal's own bulk tools.
 */
export function imsActionsJson(gstin: string, period: string, records: ImsActionRecord[]): Record<string, unknown> {
  return {
    format: 'total.ims-actions.v1',
    verified_against_portal_schema: false,
    gstin,
    rtnprd: period,
    records: records.map((r) => ({
      ctin: r.supplierGstin,
      doc_typ: r.docType,
      inum: r.docNo,
      idt: portalDate(r.docDate),
      val: rupees(r.value),
      txval: rupees(r.taxable),
      iamt: rupees(r.igst),
      camt: rupees(r.cgst),
      samt: rupees(r.sgst),
      csamt: rupees(r.cess),
      action: ACTION_CODE[r.action],
      remarks: r.note ?? undefined,
      decided_at: r.decidedAt
    }))
  }
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function imsActionsCsv(records: ImsActionRecord[]): string {
  const head = ['Supplier GSTIN', 'Document type', 'Document no.', 'Document date', 'Value', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Cess', 'Action', 'Note', 'Decided at']
  const lines = records.map((r) =>
    [r.supplierGstin, r.docType, r.docNo, portalDate(r.docDate), rupees(r.value)?.toFixed(2), rupees(r.taxable)?.toFixed(2), rupees(r.igst)?.toFixed(2),
      rupees(r.cgst)?.toFixed(2), rupees(r.sgst)?.toFixed(2), rupees(r.cess)?.toFixed(2), IMS_ACTION_LABELS[r.action], r.note, r.decidedAt]
      .map(csvCell)
      .join(',')
  )
  return [head.map(csvCell).join(','), ...lines].join('\n')
}
