import type { QueryClient } from '@tanstack/react-query'
import { useSession } from '../state/stores'

/**
 * Query keys are not namespaced by company (['ledgers'] means "the open company's ledgers"), so
 * the cache must be emptied whenever the open company changes — otherwise the next company's
 * screens paint the previous company's data until their refetch lands.
 *
 * Every open/switch/close goes through the session store's `slug` (setCompany / clearCompany),
 * so this subscribes there. Zustand runs subscribers synchronously inside `set()`, i.e. before
 * React renders the new company's tree, so no component ever reads a stale entry. A same-slug
 * setCompany (Company Info save) or a lock/unlock is not a switch and keeps the cache.
 *
 * Returns the unsubscribe function.
 */
export function bindQueryCacheToCompany(queryClient: QueryClient): () => void {
  return useSession.subscribe((state, prev) => {
    if (state.slug !== prev.slug) queryClient.clear()
  })
}
