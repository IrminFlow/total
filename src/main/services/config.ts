import type { DB } from '../db/connection'
import { featuresSchema, mergeFeatures, type CompanyFeatures } from '@shared/features'
import { invoiceConfigSchema, mergeInvoiceConfig, type InvoiceConfig } from '@shared/invoiceConfig'
import { chequeConfigSchema, mergeChequeConfig, type ChequeConfig } from '@shared/schemas'
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
