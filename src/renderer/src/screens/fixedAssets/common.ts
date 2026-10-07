// Shared bits of the Fixed assets screen (WP 3.6).
import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Group, Ledger } from '@shared/domain'
import { useGroups } from '../../components/pickers'

export type FixedAssetsTab = 'register' | 'depreciation' | 'schedule' | 'income-tax' | 'setup'

/** Query families of the screen (the registry's `invalidates` lists these). */
export const FA_QUERY_FAMILIES = [
  'faList', 'faGroups', 'faBlocks', 'faClasses', 'faRunPreview', 'faRuns', 'faSchedule', 'faIt', 'faCandidates', 'faDisposal'
] as const

/** After any write: refresh every fa* query plus the books' own (a run / disposal posts a voucher). */
export function useRefreshFixedAssets(): () => Promise<void> {
  const qc = useQueryClient()
  return useCallback(async () => {
    await Promise.all([
      ...FA_QUERY_FAMILIES.map((k) => qc.invalidateQueries({ queryKey: [k] })),
      qc.invalidateQueries({ queryKey: ['ledgers'] }),
      qc.invalidateQueries({ queryKey: ['daybook'] })
    ])
  }, [qc])
}

/** Group ids under Fixed Assets (inclusive). */
export function fixedAssetGroupIds(groups: Group[]): Set<number> {
  const root = groups.find((g) => g.name.toLowerCase() === 'fixed assets')
  const ids = new Set<number>()
  if (!root) return ids
  ids.add(root.id)
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups) {
      if (g.parentId != null && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id)
        grew = true
      }
    }
  }
  return ids
}

export const isAccDepName = (name: string): boolean => /^accumulated depreciation/i.test(name)

/** LedgerPicker filters: asset ledgers (Fixed Assets, not accumulated depreciation) and
 *  accumulated-depreciation candidates (any Fixed Assets ledger). */
export function useFixedAssetLedgerFilters(): {
  asset: (l: Ledger) => boolean
  accDep: (l: Ledger) => boolean
} {
  const groups = useGroups()
  const ids = useMemo(() => fixedAssetGroupIds(groups), [groups])
  return useMemo(
    () => ({
      asset: (l: Ledger) => ids.has(l.groupId) && !isAccDepName(l.name),
      accDep: (l: Ledger) => ids.has(l.groupId)
    }),
    [ids]
  )
}

/** "5" / "5.25" (percent) → basis points; null when not a percentage in 0–100. */
export function parsePercentBp(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null
  const bp = Math.round(Number(t) * 100)
  return bp >= 0 && bp <= 10_000 ? bp : null
}

export const bpText = (bp: number): string => (bp / 100).toFixed(2).replace(/\.00$/, '')
