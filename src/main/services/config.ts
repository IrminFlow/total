import type { DB } from '../db/connection'
import { featuresSchema, mergeFeatures, type CompanyFeatures } from '@shared/features'
import { invoiceConfigSchema, mergeInvoiceConfig, type InvoiceConfig } from '@shared/invoiceConfig'
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
