import type { DB } from '../db/connection'
import { prep } from '../db/stmt'
import { featuresSchema, mergeFeatures, type CompanyFeatures } from '@shared/features'
import { invoiceConfigSchema, mergeInvoiceConfig, type InvoiceConfig } from '@shared/invoiceConfig'
import { chequeConfigSchema, gst3bManualSchema, mergeChequeConfig, type ChequeConfig, type Gst3bManualInput } from '@shared/schemas'
import { DEFAULT_BAND_CUTS, validBandCuts } from '@shared/ageing'
import { DEFAULT_PROVISION_POLICY, validPolicy, type ProvisionRule } from '@shared/badDebt'
import { writeAudit } from './audit'
import { parseExternalBackup, type ExternalBackupConfig } from '@shared/backupSchedule'

/** Company-scoped JSON config living in the `meta` table — same pattern as readCompanyInfo/
 *  writeCompanyInfo (db/seed.ts) and the NIC credentials (services/nic.ts). */
function readMeta(db: DB, key: string): unknown {
  const row = prep(db, 'SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

function writeMeta(db: DB, key: string, value: unknown): void {
  prep(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
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


/**
 * Company-wide collections policy: the defaults a party inherits when it says nothing itself.
 *
 * Every field here is a business's opinion, not an accounting rule, which is why none of it is
 * hardcoded. Interest terms fall back party → company → nothing; ageing bands and the provision
 * ladder have no party-level override because a report that changed its columns per row would be
 * unreadable.
 */
export interface CollectionsPolicy {
  /** Default overdue interest in basis points; 0 = charge none. */
  interestRateBp: number
  interestGraceDays: number
  /** Ageing band cut points, e.g. [30, 60, 90]. */
  bandCuts: number[]
  provisionPolicy: ProvisionRule[]
  /** Days overdue before a party appears in a bulk reminder run. */
  reminderMinOverdueDays: number
  /** Contact line printed under the signature on reminders and statements. */
  contact: string | null
  /**
   * RBI bank rate, whole percent, for section 16 MSMED interest (three times it, compounded
   * monthly). A parameter rather than a constant because it moves, and a number baked into the
   * code would be quietly wrong within a year.
   */
  msmeBankRatePercent: number
}

export const DEFAULT_COLLECTIONS_POLICY: CollectionsPolicy = {
  interestRateBp: 0,
  interestGraceDays: 0,
  bandCuts: DEFAULT_BAND_CUTS,
  provisionPolicy: DEFAULT_PROVISION_POLICY,
  reminderMinOverdueDays: 1,
  contact: null,
  msmeBankRatePercent: 6.5
}

export function getCollectionsPolicy(db: DB): CollectionsPolicy {
  const raw = readMeta(db, 'collections') as Partial<CollectionsPolicy> | null
  if (!raw || typeof raw !== 'object') return DEFAULT_COLLECTIONS_POLICY
  const rate = raw.interestRateBp
  const grace = raw.interestGraceDays
  const minOverdue = raw.reminderMinOverdueDays
  return {
    interestRateBp: typeof rate === 'number' && Number.isInteger(rate) && rate >= 0 && rate <= 6000 ? rate : 0,
    interestGraceDays: typeof grace === 'number' && Number.isInteger(grace) && grace >= 0 && grace <= 365 ? grace : 0,
    // Stored bands and policies are re-validated on read rather than trusted: `meta` is a plain
    // JSON column that a restore, an import or a hand-edit can reach.
    bandCuts: Array.isArray(raw.bandCuts) && validBandCuts(raw.bandCuts) ? raw.bandCuts : DEFAULT_BAND_CUTS,
    provisionPolicy:
      Array.isArray(raw.provisionPolicy) && validPolicy(raw.provisionPolicy) ? raw.provisionPolicy : DEFAULT_PROVISION_POLICY,
    reminderMinOverdueDays:
      typeof minOverdue === 'number' && Number.isInteger(minOverdue) && minOverdue >= 0 && minOverdue <= 365 ? minOverdue : 1,
    contact: typeof raw.contact === 'string' && raw.contact.trim() ? raw.contact.trim().slice(0, 120) : null,
    msmeBankRatePercent:
      typeof raw.msmeBankRatePercent === 'number' && raw.msmeBankRatePercent >= 0 && raw.msmeBankRatePercent <= 30
        ? raw.msmeBankRatePercent
        : DEFAULT_COLLECTIONS_POLICY.msmeBankRatePercent
  }
}

export function setCollectionsPolicy(db: DB, input: CollectionsPolicy): CollectionsPolicy {
  const before = getCollectionsPolicy(db)
  if (!validBandCuts(input.bandCuts)) throw new Error('Ageing bands must be ascending, whole and positive')
  if (!validPolicy(input.provisionPolicy)) throw new Error('Provision policy must rise with age')
  writeMeta(db, 'collections', input)
  const after = getCollectionsPolicy(db)
  writeAudit(db, 'company', 0, 'update', { collections: before }, { collections: after })
  return after
}

// ---------- archived years: books that may be read and not changed (roadmap #257) ----------

export interface ArchiveState {
  archived: boolean
  /** Why, in the archiver's own words — "FY 2023-24, filed and assessed". */
  note: string | null
  /** ISO, when it was archived. */
  at: string | null
  /** Who archived it. */
  by: string | null
}

const NOT_ARCHIVED: ArchiveState = { archived: false, note: null, at: null, by: null }

/**
 * Whether this whole company is read-only.
 *
 * The books-lock date (`lock_before`) closes a period and leaves the rest of the company open,
 * which is right for a filed quarter and wrong for a company nobody should be posting into at
 * all: the year that has been audited, the branch that was sold, the demo company somebody keeps
 * typing into by mistake. A lock date cannot express that — there is always a date after it.
 *
 * Enforced at the IPC boundary rather than in each service, in the same place the licence check
 * lives: every write channel refuses, every read channel works, and exports and backups keep
 * working, because archived books you cannot get data out of are a hostage rather than a record.
 */
export function getArchive(db: DB): ArchiveState {
  const raw = readMeta(db, 'archived')
  if (raw === true) return { archived: true, note: null, at: null, by: null }
  if (!raw || typeof raw !== 'object') return NOT_ARCHIVED
  const value = raw as Partial<ArchiveState>
  if (value.archived !== true) return NOT_ARCHIVED
  return {
    archived: true,
    note: typeof value.note === 'string' && value.note.trim() ? value.note.trim().slice(0, 200) : null,
    at: typeof value.at === 'string' ? value.at : null,
    by: typeof value.by === 'string' ? value.by : null
  }
}

export function setArchive(db: DB, archived: boolean, note: string | null, by: string | null): ArchiveState {
  const before = getArchive(db)
  const after: ArchiveState = archived
    ? { archived: true, note: note?.trim() ? note.trim().slice(0, 200) : null, at: new Date().toISOString(), by }
    : NOT_ARCHIVED
  writeMeta(db, 'archived', after)
  // Archiving and un-archiving are both audited: "who reopened the closed year, and when" is
  // exactly the question this feature exists to be able to answer.
  writeAudit(db, 'company', 0, 'update', { archive: before }, { archive: after })
  return after
}

// ---------- the backup that leaves the machine (roadmap #245, #253) ----------

/** Per-company schedule for copying backups somewhere that is not this disk. */
export function getExternalBackup(db: DB): ExternalBackupConfig {
  return parseExternalBackup(readMeta(db, 'backup.external'))
}

/**
 * Save the schedule. The passphrase is NOT stored here — it goes to the OS keychain via
 * main/secrets.ts, because a passphrase in `meta` would be copied into every backup that
 * passphrase exists to protect.
 */
export function setExternalBackup(db: DB, input: ExternalBackupConfig): ExternalBackupConfig {
  const before = getExternalBackup(db)
  const parsed = parseExternalBackup({ ...input, lastRunAt: before.lastRunAt, lastError: before.lastError })
  writeMeta(db, 'backup.external', parsed)
  writeAudit(db, 'company', 0, 'update', { externalBackup: before }, { externalBackup: parsed })
  return parsed
}

/** Record the outcome of a scheduled run. Not audited: a heartbeat is not a decision. */
export function stampExternalBackup(db: DB, at: string | null, error: string | null): ExternalBackupConfig {
  const current = getExternalBackup(db)
  const next = { ...current, lastRunAt: at ?? current.lastRunAt, lastError: error }
  writeMeta(db, 'backup.external', next)
  return next
}

// ---------- approval threshold (roadmap V #386) ----------

/**
 * The amount above which a voucher entered by an accountant waits for the owner.
 *
 * Paise, or null for "off". The difference between null and 0 is load-bearing and is preserved
 * through every layer: null means the owner never asked for approvals, 0 means they asked for all
 * of them — a real thing to do for a week after finding something wrong. Folding one into the
 * other would be the app overruling a deliberate decision (see src/shared/approvals.ts).
 */
export function getApprovalThreshold(db: DB): number | null {
  const raw = readMeta(db, 'approval.threshold')
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null
}

export function setApprovalThreshold(db: DB, threshold: number | null): number | null {
  const before = getApprovalThreshold(db)
  const value = threshold === null ? null : Math.max(0, Math.round(threshold))
  writeMeta(db, 'approval.threshold', value)
  writeAudit(db, 'company', 0, 'update', { approvalThreshold: before }, { approvalThreshold: value })
  return value
}

// ---------- who signs the TDS return (roadmap #360) ----------

/**
 * The deductor details a quarterly TDS statement needs and the company master does not hold.
 *
 * The TAN and PAN live on CompanyInfo already. What a 24Q or 26Q also asks for is the PERSON
 * RESPONSIBLE for deduction — a named human with a designation, who signs — and whether the
 * deductor is a company or something else. Those are filing facts rather than identity facts, so
 * they sit here rather than being bolted onto every company that will never file a TDS return.
 */
export interface TdsFilingConfig {
  responsiblePerson: string | null
  responsibleDesignation: string | null
  /** 'A' company, 'S' other than company. The two codes that cover this app's users. */
  deductorType: 'A' | 'S'
}

export const DEFAULT_TDS_FILING: TdsFilingConfig = {
  responsiblePerson: null,
  responsibleDesignation: null,
  deductorType: 'S'
}

export function getTdsFiling(db: DB): TdsFilingConfig {
  const raw = readMeta(db, 'tds.filing') as Partial<TdsFilingConfig> | null
  if (!raw || typeof raw !== 'object') return DEFAULT_TDS_FILING
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null)
  return {
    responsiblePerson: text(raw.responsiblePerson),
    responsibleDesignation: text(raw.responsibleDesignation),
    deductorType: raw.deductorType === 'A' ? 'A' : 'S'
  }
}

export function setTdsFiling(db: DB, input: TdsFilingConfig): TdsFilingConfig {
  const before = getTdsFiling(db)
  writeMeta(db, 'tds.filing', input)
  const after = getTdsFiling(db)
  writeAudit(db, 'company', 0, 'update', { tdsFiling: before }, { tdsFiling: after })
  return after
}
