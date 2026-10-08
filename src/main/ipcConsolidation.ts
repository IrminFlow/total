// IPC channels for group consolidation (WP 6.5). Registered from ipc.ts with its `handle` (role
// gate + { ok, data | error } envelope); every payload is Zod-parsed here. Write channels are
// mapped in auditCoverage.ts. Writes are owner-only: the definition decides what is eliminated from
// every member's figures. The group definition is stored in the open company; every member's
// books are read read-only (services/consolidation.ts).
import { z } from 'zod'
import type { DB } from './db/connection'
import type { Role } from './services/roles'
import { consolGroupInputSchema, consolMappingInputSchema, consolPairInputSchema, consolRunSchema } from '@shared/consolidation/schemas'
import * as consolidation from './services/consolidation'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; slug: string }

const idSchema = z.object({ id: z.number().int().positive() })
const groupIdSchema = z.object({ groupId: z.number().int().positive() })

export function registerConsolidationIpc(handle: Handle, company: () => Company): void {
  const db = (): DB => company().db

  handle('consolGroup:list', () => consolidation.listGroups(db()), 'viewer')
  handle('consolGroup:save', (p) => {
    const q = z.object({ id: z.number().int().positive().optional(), data: consolGroupInputSchema }).parse(p)
    return consolidation.saveGroup(db(), q.data, q.id)
  }, 'owner')
  handle('consolGroup:delete', (p) => {
    consolidation.deleteGroup(db(), idSchema.parse(p).id)
    return null
  }, 'owner')
  handle('consolGroup:charts', (p) => consolidation.memberCharts(db(), groupIdSchema.parse(p).groupId), 'viewer')
  handle('consolGroup:run', (p) => {
    const q = consolRunSchema.parse(p)
    const c = company()
    return consolidation.runGroup(c.db, q.groupId, q.from, q.to, { comparePrior: q.comparePrior, openSlug: c.slug })
  }, 'viewer')

  handle('consolMapping:save', (p) => consolidation.saveMapping(db(), consolMappingInputSchema.parse(p)), 'owner')
  handle('consolMapping:delete', (p) => {
    consolidation.deleteMapping(db(), idSchema.parse(p).id)
    return null
  }, 'owner')

  handle('consolPair:suggest', (p) => consolidation.suggestGroupPairs(db(), groupIdSchema.parse(p).groupId), 'viewer')
  handle('consolPair:save', (p) => {
    const q = z.object({ id: z.number().int().positive().optional(), data: consolPairInputSchema }).parse(p)
    return consolidation.savePair(db(), q.data, q.id)
  }, 'owner')
  handle('consolPair:delete', (p) => {
    consolidation.deletePair(db(), idSchema.parse(p).id)
    return null
  }, 'owner')
}
