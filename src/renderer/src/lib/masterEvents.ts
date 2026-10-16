import type { QueryClient } from '@tanstack/react-query'

/**
 * to-do §4: main announces which masters a write changed ('total:masters:changed',
 * main/masterEvents.ts); the cached lists of those masters are refetched, so an open screen
 * (the Labels tab, a picker) shows an item created elsewhere without being reopened.
 * Unknown entities are ignored. Returns the unsubscribe function.
 */
export const MASTER_QUERY_KEYS: Record<string, string> = {
  stockItem: 'stockItems',
  ledger: 'ledgers',
  unit: 'units',
  godown: 'godowns',
  group: 'groups',
  stockGroup: 'stockGroups',
  priceLevel: 'priceLevels'
}

export function bindMasterEvents(queryClient: QueryClient, bridge: Pick<Window['total'], 'onMastersChanged'> | undefined = window.total): () => void {
  const unsub = bridge?.onMastersChanged?.((e) => {
    const keys = new Set((e?.entities ?? []).map((x) => MASTER_QUERY_KEYS[x]).filter((k): k is string => !!k))
    for (const k of keys) void queryClient.invalidateQueries({ queryKey: [k] })
  })
  return unsub ?? (() => {})
}
