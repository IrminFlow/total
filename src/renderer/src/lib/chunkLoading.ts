import { create } from 'zustand'

/**
 * How many lazily loaded screens / dialogs are still waiting for their code (lib/lazyScreen.tsx).
 * Shell's `<main data-loading>` — the E2E harness's idle marker — reports "true" while this is
 * above zero, exactly as it does while a query is fetching, so a screen whose chunk has not
 * arrived yet never looks idle.
 */
export const useChunkLoading = create<{ count: number; inc: () => void; dec: () => void }>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
  dec: () => set((s) => ({ count: Math.max(0, s.count - 1) }))
}))
