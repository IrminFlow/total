import type { DB } from '../db/connection'
import { featuresSchema, mergeFeatures, type CompanyFeatures } from '@shared/features'
import { invoiceConfigSchema, type InvoiceConfig } from '@shared/invoiceConfig'
import { chequeConfigSchema, gst3bManualSchema, mergeChequeConfig, type ChequeConfig, type Gst3bManualInput } from '@shared/schemas'
import { getAuditTrailRequired, setAuditTrailRequired, writeAudit } from './audit'
import { MIN_AUDIT_KEEP_DAYS } from '@shared/auditRetention'
import { getLegacyConfigView, setLegacyConfig } from './printTemplates'

/** Company-scoped JSON config living in the `meta` table — same pattern as readCompanyInfo/
 *  writeCompanyInfo (db/seed.ts) and the NIC credentials (services/nic.ts). */
function readMeta(db: DB, key: string): unknown {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

function writeMeta(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value)
  )
}

// ---------- F11 feature toggles ----------

export function getFeatures(db: DB): CompanyFeatures {
  return mergeFeatures(readMeta(db, 'features'))
}

export function setFeatures(db: DB, input: CompanyFeatures): CompanyFeatures {
  const before = getFeatures(db)
  const parsed = featuresSchema.parse(input)
  writeMeta(db, 'features', parsed)
  writeAudit(db, 'company', 0, 'update', { features: before }, { features: parsed })
  return parsed
}

// ---------- invoice print customization ----------

// Since WP 1.10c the source of truth is the Classic print template (services/printTemplates.ts);
// these keep the old `config:invoice:*` channels working against it.

export function getInvoiceConfig(db: DB): InvoiceConfig {
  return getLegacyConfigView(db)
}

export function setInvoiceConfig(db: DB, input: InvoiceConfig): InvoiceConfig {
  const before = getInvoiceConfig(db)
  const parsed = invoiceConfigSchema.parse(input)
  setLegacyConfig(db, parsed)
  // Never dump the logo's base64 payload into the audit trail — just its size.
  const redact = (c: InvoiceConfig): unknown => ({
    ...c,
    logoDataUrl: c.logoDataUrl ? `[logo ${c.logoDataUrl.length} chars]` : null
  })
  writeAudit(db, 'company', 0, 'update', { invoice: redact(before) }, { invoice: redact(parsed) })
  return parsed
}

// ---------- cheque print calibration (per bank ledger) ----------

export function getChequeConfig(db: DB, bankLedgerId: number): ChequeConfig {
  return mergeChequeConfig(readMeta(db, `cheque.${bankLedgerId}`))
}

export function setChequeConfig(db: DB, bankLedgerId: number, input: ChequeConfig): ChequeConfig {
  const before = getChequeConfig(db, bankLedgerId)
  const parsed = chequeConfigSchema.parse(input)
  writeMeta(db, `cheque.${bankLedgerId}`, parsed)
  writeAudit(db, 'cheque_config', bankLedgerId, 'update', before, parsed)
  return parsed
}

// ---------- GSTR-3B manual adjustments (per period, meta `gst3b.manual.<MMYYYY>`) ----------

export function getGst3bManual(db: DB, period: string): Gst3bManualInput {
  const parsed = gst3bManualSchema.safeParse(readMeta(db, `gst3b.manual.${period}`) ?? {})
  return parsed.success ? parsed.data : gst3bManualSchema.parse({})
}

export function setGst3bManual(db: DB, period: string, input: unknown): Gst3bManualInput {
  const before = getGst3bManual(db, period)
  const parsed = gst3bManualSchema.parse(input)
  writeMeta(db, `gst3b.manual.${period}`, parsed)
  writeAudit(db, 'company', 0, 'update', { gst3bManual: { period, ...before } }, { gst3bManual: { period, ...parsed } })
  return parsed
}

// ---------- audit retention (task Q1 #92; WP 3.8) ----------

/** Days of audit_log history to keep, or null (the default) = keep forever. Stored in `meta`
 *  under 'audit.keepDays'. Only consulted when the company is NOT flagged audit-trail-required
 *  (the default is required → nothing is ever pruned); see pruneAudit in audit.ts. */
export function getAuditKeepDays(db: DB): number | null {
  const raw = readMeta(db, 'audit.keepDays')
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
}

export function setAuditKeepDays(db: DB, keepDays: number | null): number | null {
  if (keepDays !== null && keepDays < MIN_AUDIT_KEEP_DAYS) {
    throw new Error(`Audit entries must be kept for at least ${MIN_AUDIT_KEEP_DAYS} days (8 years) — Companies Act 2013 s.128(5)`)
  }
  if (keepDays !== null && getAuditTrailRequired(db)) {
    throw new Error('This company keeps the full audit trail (rule 3(1)); turn off "audit trail required" before setting a retention window')
  }
  const before = getAuditKeepDays(db)
  if (keepDays === null) {
    db.prepare("DELETE FROM meta WHERE key = 'audit.keepDays'").run()
  } else {
    writeMeta(db, 'audit.keepDays', keepDays)
  }
  if (before !== keepDays) writeAudit(db, 'company', 0, 'update', { auditKeepDays: before }, { auditKeepDays: keepDays })
  return keepDays
}

export { getAuditTrailRequired, setAuditTrailRequired }

/** The Audit settings view: both retention knobs together. */
export function getAuditSettings(db: DB): { keepDays: number | null; trailRequired: boolean } {
  return { keepDays: getAuditKeepDays(db), trailRequired: getAuditTrailRequired(db) }
}

// ---------- agent bridge feature flag (lane A) ----------

/** Whether the `<company>/inbox/` drop-folder watcher + auto mirror refresh are on for this
 *  company. Default OFF — an agent write surface should be a deliberate opt-in. Stored in `meta`
 *  under 'agent_bridge'; the CLI is always available regardless (it validates identically). */
export function getAgentBridgeEnabled(db: DB): boolean {
  return readMeta(db, 'agent_bridge') === true
}

export function setAgentBridgeEnabled(db: DB, enabled: boolean): boolean {
  const before = getAgentBridgeEnabled(db)
  writeMeta(db, 'agent_bridge', enabled)
  writeAudit(db, 'company', 0, 'update', { agentBridge: before }, { agentBridge: enabled })
  return enabled
}

// ---------- compliance-deadline notifications (once-per-day guard) ----------

/** True the first time it's called on a given `today`, false on every subsequent call the same
 *  day — the app checks compliance deadlines once per launch/dashboard-load, and this stops a
 *  user who reopens the app (or a background refresh) from re-popping the same OS notifications.
 *  Guard state lives in `meta` under 'deadline_notified' as the last date it fired, following the
 *  same read/write-through-JSON pattern as the rest of this file. */
export function shouldNotifyDeadlinesToday(db: DB, today: string): boolean {
  const last = readMeta(db, 'deadline_notified')
  if (last === today) return false
  writeMeta(db, 'deadline_notified', today)
  return true
}
