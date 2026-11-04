// to-do §4: screens cache the master lists (react-query ['stockItems'], ['ledgers'] …) and only the
// screen that made a change invalidated them — an item created over IPC elsewhere (another screen,
// an import, an e2e driver) did not appear in an open Labels tab until it was
// reopened. After a successful write whose audit coverage (auditCoverage.ts — the one registry of
// what a channel writes) includes a master entity, main tells every window which masters changed
// ('total:masters:changed'); the renderer refetches those lists (renderer lib/masterEvents.ts).
// Pure; tested in masterEvents.test.ts.
import type { AuditEntity } from '@shared/auditEntities'
import { AUDIT_COVERAGE } from './auditCoverage'

export const MASTERS_CHANGED_EVENT = 'total:masters:changed'

/** The master entities a cached list is kept for in the renderer. */
export const MASTER_ENTITIES = ['stockItem', 'ledger', 'unit', 'godown', 'group', 'stockGroup', 'priceLevel'] as const satisfies readonly AuditEntity[]
export type MasterEntity = (typeof MASTER_ENTITIES)[number]

const MASTER_SET: ReadonlySet<string> = new Set(MASTER_ENTITIES)

/** The master entities a channel can write (empty for reads and non-master writes). */
export function masterEntitiesOf(channel: string): MasterEntity[] {
  const cov = AUDIT_COVERAGE[channel]
  if (!cov || !('audit' in cov)) return []
  return cov.audit.filter((e): e is MasterEntity => MASTER_SET.has(e))
}

/** Feature cleanup: the audit entities whose rows can make a hidden feature "used"
 *  (services/featureUsage.ts). A write touching one also names FEATURES_CHANGED, and the renderer
 *  re-reads config:features:get — so a feature appears as soon as its first data lands (a Tally
 *  or books import with cost centres, a post-dated cheque, a challan …). */
export const FEATURE_DATA_ENTITIES = [
  'voucher', 'ledger', 'costCentre', 'currency', 'fx_rate', 'fx_ledger_currency', 'fx_revaluation', 'fx_settlement',
  'cheque_book', 'cheque', 'cheque_config', 'pdc', 'payment_batch', 'payment_template', 'interest_charge',
  'fixed_asset', 'fixed_asset_group', 'depreciation_run', 'trade_doc', 'tradeDocType',
  'payroll_run', 'statutory_payment', 'statutory_rate', 'tally_import', 'import_batch'
] as const satisfies readonly AuditEntity[]
export const FEATURES_CHANGED = 'features'

const FEATURE_DATA_SET: ReadonlySet<string> = new Set(FEATURE_DATA_ENTITIES)

/** What the masters-changed event names after a write on `channel`: its master entities, plus
 *  FEATURES_CHANGED when it can add a hidden feature's data. */
export function changedEntitiesOf(channel: string): string[] {
  const cov = AUDIT_COVERAGE[channel]
  const masters: string[] = masterEntitiesOf(channel)
  return cov && 'audit' in cov && cov.audit.some((e) => FEATURE_DATA_SET.has(e)) ? [...masters, FEATURES_CHANGED] : masters
}
