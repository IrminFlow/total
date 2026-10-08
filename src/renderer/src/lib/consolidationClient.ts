// Typed client for group consolidation (WP 6.5) — the channels in src/main/ipcConsolidation.ts.
// Kept beside client.ts like reportsClient.ts.
import { call } from './client'
import type { ConsolidationGroup, ConsolidationMapping, GroupRunResult, IntercompanyPair, MemberChart } from '@shared/consolidation/types'
import type { PairSuggestion } from '@shared/consolidation/suggest'
import type { z } from 'zod'
import type { consolGroupInputSchema, consolMappingInputSchema, consolPairInputSchema } from '@shared/consolidation/schemas'

export type GroupInputPayload = z.input<typeof consolGroupInputSchema>
export type MappingInputPayload = z.input<typeof consolMappingInputSchema>
export type PairInputPayload = z.input<typeof consolPairInputSchema>

export const consolidationApi = {
  listGroups: () => call<ConsolidationGroup[]>('consolGroup:list'),
  saveGroup: (data: GroupInputPayload, id?: number) => call<ConsolidationGroup>('consolGroup:save', { id, data }),
  deleteGroup: (id: number) => call<null>('consolGroup:delete', { id }),
  charts: (groupId: number) => call<MemberChart[]>('consolGroup:charts', { groupId }),
  run: (groupId: number, from: string, to: string, comparePrior = false) => call<GroupRunResult>('consolGroup:run', { groupId, from, to, comparePrior }),
  saveMapping: (data: MappingInputPayload) => call<ConsolidationMapping>('consolMapping:save', data),
  deleteMapping: (id: number) => call<null>('consolMapping:delete', { id }),
  suggestPairs: (groupId: number) => call<PairSuggestion[]>('consolPair:suggest', { groupId }),
  savePair: (data: PairInputPayload, id?: number) => call<IntercompanyPair>('consolPair:save', { id, data }),
  deletePair: (id: number) => call<null>('consolPair:delete', { id })
}
