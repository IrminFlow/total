// to-do §4: screens cache the master lists (react-query ['stockItems'], ['ledgers'] …) and only the
// screen that made a change invalidated them — an item created over IPC elsewhere (another screen,
// the MCP inbox, an import, an e2e driver) did not appear in an open Labels tab until it was
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
