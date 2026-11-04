// The feature cleanup: which of the hideable features (shared/features.ts HIDEABLE_FEATURES) a
// company has never used. "Used" = the company has any row of that feature's data — in the bin or
// not, whatever the feature flags say. A feature in the returned list is hidden from the sidebar,
// the palette, the simple entries and Settings → Features (renderer screenFeatures); nothing here
// changes a figure or a stored flag, and reports keep reading the data exactly as before.
import type { DB } from '../db/connection'
import { HIDEABLE_FEATURES, type HideableFeature } from '@shared/features'

/** One EXISTS probe per table (or filtered row set) that holds the feature's data. */
const PROBES: Record<HideableFeature, readonly string[]> = {
  costCentres: ['SELECT 1 FROM cost_centres', 'SELECT 1 FROM voucher_line_cost_allocations'],
  // Cheque books / the register, cheque print calibration, post-dated cheques and bulk bank
  // payment files (templates and the batches written).
  cheques: [
    'SELECT 1 FROM cheque_books',
    'SELECT 1 FROM cheques',
    "SELECT 1 FROM meta WHERE key LIKE 'cheque.%'",
    'SELECT 1 FROM pdc_events',
    'SELECT 1 FROM bank_payment_templates',
    'SELECT 1 FROM bank_payment_batches'
  ],
  // Interest on overdue bills: a charge posted, or interest terms set on a party.
  interest: ['SELECT 1 FROM interest_charges', 'SELECT 1 FROM ledgers WHERE interest_rate_bp IS NOT NULL'],
  // The fixed-asset register (the seeded asset groups do not count).
  fixedAssets: [
    'SELECT 1 FROM fixed_assets',
    'SELECT 1 FROM depreciation_runs',
    'SELECT 1 FROM fixed_asset_groups WHERE is_seeded = 0'
  ],
  // Quotations / orders (trade documents, a user's own document type) and challans / GRNs.
  tradeCycle: [
    'SELECT 1 FROM trade_docs',
    'SELECT 1 FROM trade_doc_types WHERE is_system = 0',
    `SELECT 1 FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id WHERE t.kind IN ('delivery_note', 'receipt_note')`
  ],
  // PF / ESI / PT: a payroll line that deducted any of them, a statutory payment, or a rate the
  // user entered (the seeded rates do not count).
  payrollStatutory: [
    'SELECT 1 FROM payroll_lines WHERE pf_emp <> 0 OR pf_er <> 0 OR esi_emp <> 0 OR esi_er <> 0 OR pt <> 0',
    'SELECT 1 FROM statutory_payments',
    'SELECT 1 FROM statutory_rates WHERE is_seeded = 0'
  ]
}

/** Probes over a voucher COLUMN (no index leads with it): a post-dated voucher (cheques). Read incrementally — only the vouchers added since the last look at
 *  this handle (by id, the primary key) — so the renderer's re-read after every save stays cheap
 *  on a big file. A voucher EDITED into post-dated is seen when the company is
 *  next opened. */
const VOUCHER_PROBES: Partial<Record<HideableFeature, string>> = {
  cheques: 'post_dated = 1'
}
const voucherScan = new WeakMap<DB, Partial<Record<HideableFeature, number>>>()

function usesByVoucher(db: DB, feature: HideableFeature): boolean {
  const where = VOUCHER_PROBES[feature]
  if (!where) return false
  let seen = voucherScan.get(db)
  if (!seen) voucherScan.set(db, (seen = {}))
  const since = seen[feature] ?? 0
  const max = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM vouchers').get() as { m: number }).m
  if (max <= since) return false
  const hit = (db.prepare(`SELECT EXISTS (SELECT 1 FROM vouchers WHERE id > ? AND id <= ? AND ${where}) AS used`).get(since, max) as { used: number }).used === 1
  seen[feature] = max
  return hit
}

function uses(db: DB, feature: HideableFeature): boolean {
  return PROBES[feature].some((sql) => (db.prepare(`SELECT EXISTS (${sql}) AS used`).get() as { used: number }).used === 1) || usesByVoucher(db, feature)
}

/** Features already seen used, per open company handle: data is rarely removed, so a used feature
 *  is not probed again until the company is reopened (a new handle) — only unused ones are, and
 *  those probes stop at the first row. */
const knownUsed = new WeakMap<DB, Set<HideableFeature>>()

/** The hideable features this company has no data for (HIDEABLE_FEATURES order). */
export function unusedFeatures(db: DB): HideableFeature[] {
  let used = knownUsed.get(db)
  if (!used) knownUsed.set(db, (used = new Set()))
  return HIDEABLE_FEATURES.filter((f) => {
    if (used.has(f)) return false
    if (!uses(db, f)) return true
    used.add(f)
    return false
  })
}
