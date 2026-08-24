import type { DB } from '../db/connection'
import { featuresSchema, mergeFeatures, type CompanyFeatures } from '@shared/features'
import { invoiceConfigSchema, mergeInvoiceConfig, type InvoiceConfig } from '@shared/invoiceConfig'
import { chequeConfigSchema, gst3bManualSchema, mergeChequeConfig, type ChequeConfig, type Gst3bManualInput } from '@shared/schemas'
import { writeAudit } from './audit'

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

export function getInvoiceConfig(db: DB): InvoiceConfig {
  return mergeInvoiceConfig(readMeta(db, 'invoice'))
}

export function setInvoiceConfig(db: DB, input: InvoiceConfig): InvoiceConfig {
  const before = getInvoiceConfig(db)
  const parsed = invoiceConfigSchema.parse(input)
  writeMeta(db, 'invoice', parsed)
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

// ---------- audit retention (task Q1 #92) ----------

/** Days of audit_log history to keep, or null (the default) = keep forever. Stored in `meta`
 *  under 'audit.keepDays'. When set, company open prunes older rows (see ipc.ts + audit.ts). */
export function getAuditKeepDays(db: DB): number | null {
  const raw = readMeta(db, 'audit.keepDays')
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
}

export function setAuditKeepDays(db: DB, keepDays: number | null): number | null {
  const before = getAuditKeepDays(db)
  if (keepDays === null) {
    db.prepare("DELETE FROM meta WHERE key = 'audit.keepDays'").run()
  } else {
    writeMeta(db, 'audit.keepDays', keepDays)
  }
  writeAudit(db, 'company', 0, 'update', { auditKeepDays: before }, { auditKeepDays: keepDays })
  return keepDays
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

/**
 * How many backups to keep before the oldest is pruned.
 *
 * Twenty was a reasonable guess and is a bad universal answer: a business that opens its books
 * four times a day burns through twenty in a week, and one that opens them weekly keeps five
 * months of history in the same twenty. The number belongs to the business.
 *
 * Bounded below at 5 rather than allowing 1. A retention of one means the next open overwrites
 * the only copy — which is not a backup policy, it is a mirror, and the one thing backups exist
 * to survive is a mistake noticed later.
 */
export const BACKUP_KEEP_DEFAULT = 20
export const BACKUP_KEEP_MIN = 5
export const BACKUP_KEEP_MAX = 200

export function getBackupKeep(db: DB): number {
  const raw = readMeta(db, 'backup.keep')
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= BACKUP_KEEP_MIN && raw <= BACKUP_KEEP_MAX
    ? raw
    : BACKUP_KEEP_DEFAULT
}

export function setBackupKeep(db: DB, keep: number): number {
  const clamped = Math.min(BACKUP_KEEP_MAX, Math.max(BACKUP_KEEP_MIN, Math.round(keep)))
  const before = getBackupKeep(db)
  writeMeta(db, 'backup.keep', clamped)
  writeAudit(db, 'company', 0, 'update', { backupKeep: before }, { backupKeep: clamped })
  return clamped
}

/**
 * How long a binned voucher sits before being purged automatically.
 *
 * Thirty days was a guess, and the right answer is a business's own: a shop that bins a mistyped
 * receipt daily wants them gone; a business under audit wants nothing to disappear at all. Zero
 * means never auto-purge, which is a legitimate policy rather than a disabled feature.
 *
 * Auto-purge only ever touches vouchers dated on or before the books lock date — see
 * purgeOldDeleted — so this setting cannot reach anything in a period still open.
 */
export const BIN_PURGE_DAYS_DEFAULT = 30

export function getBinPurgeDays(db: DB): number {
  const raw = readMeta(db, 'bin.purgeDays')
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 3650
    ? raw
    : BIN_PURGE_DAYS_DEFAULT
}

export function setBinPurgeDays(db: DB, days: number): number {
  const clamped = Math.min(3650, Math.max(0, Math.round(days)))
  const before = getBinPurgeDays(db)
  writeMeta(db, 'bin.purgeDays', clamped)
  writeAudit(db, 'company', 0, 'update', { binPurgeDays: before }, { binPurgeDays: clamped })
  return clamped
}

/**
 * Checklist steps that are genuinely preferences rather than book facts.
 *
 * Only two: whether the shortcut sheet has been opened, and whether a backup has been verified.
 * Everything else on the checklist is derived from the books, which is what stops it lying.
 */
export type ChecklistFlag = 'backupVerified' | 'sawShortcuts'

export function getChecklistFlag(db: DB, flag: ChecklistFlag): boolean {
  return readMeta(db, `checklist.${flag}`) === true
}

export function setChecklistFlag(db: DB, flag: ChecklistFlag, value: boolean): void {
  writeMeta(db, `checklist.${flag}`, value)
}
