// The screen context the assistant is told (WP 5.2): the current screen (nav), its title, the
// working period, the screen's parameters (ledger on a statement, voucher in the editor, tab …)
// and anything a screen registers itself (the bank ledger picked on Banking, the budget on
// Budgets). Pure builder + a small registry store; the panel's context strip shows exactly what
// screenContextLines() makes of it — the same lines main puts in the system prompt.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { AiContext } from '@shared/aiExplain'
import type { Screen } from '../state/stores'
import { SCREENS } from './screens'

type Params = Record<string, string | number>

interface ScreenParamsState {
  /** Screen name → parameters it registered (only the current screen's are sent). */
  byScreen: Record<string, Params>
  set: (screen: string, params: Params | null) => void
}

export const useAiScreenParams = create<ScreenParamsState>((set) => ({
  byScreen: {},
  set: (screen, params) =>
    set((s) => {
      const next = { ...s.byScreen }
      if (params && Object.keys(params).length) next[screen] = params
      else delete next[screen]
      return { byScreen: next }
    })
}))

/** A screen tells the assistant about a selection the nav state does not hold (e.g. Banking's
 *  ledger). Cleared when the screen unmounts. Values that are null / undefined are left out. */
export function useAiScreenContext(screen: Screen['name'], params: Record<string, string | number | null | undefined>): void {
  const key = JSON.stringify(params)
  useEffect(() => {
    const clean: Params = {}
    for (const [k, v] of Object.entries(JSON.parse(key) as Record<string, string | number | null>)) if (v !== null && v !== undefined && v !== '') clean[k] = v
    useAiScreenParams.getState().set(screen, clean)
    return () => useAiScreenParams.getState().set(screen, null)
  }, [screen, key])
}

/** Nav-state fields that are worth telling (ids, tabs, filters) — never drafts or prefill objects. */
const PARAM_KEYS = ['ledgerId', 'voucherId', 'itemId', 'godownId', 'loanId', 'tab', 'kind', 'month', 'q', 'id', 'aiDraftId'] as const

export function screenTitle(name: string): string | undefined {
  return SCREENS.find((s) => s.name === name)?.title
}

/** The context for a screen. Pure; tested. */
export function screenContextFor(screen: Screen, from: string, to: string, extra: Params = {}): AiContext {
  const params: Params = {}
  const rec = screen as unknown as Record<string, unknown>
  for (const k of PARAM_KEYS) {
    const v = rec[k]
    if (typeof v === 'number' && Number.isFinite(v)) params[k] = v
    else if (typeof v === 'string' && v.length <= 120) params[k] = v
  }
  for (const [k, v] of Object.entries(extra)) if (Object.keys(params).length < 12 || k in params) params[k] = v
  const label = screenTitle(screen.name)
  return {
    screen: screen.name,
    ...(label ? { label } : {}),
    from,
    to,
    ...(Object.keys(params).length ? { params: Object.fromEntries(Object.entries(params).slice(0, 12)) } : {})
  }
}

/** Screens whose figures are balances as on the period's end (an explain there uses `asOn`). */
export const AS_ON_SCREENS = new Set<string>(['trial-balance', 'balance-sheet', 'outstandings', 'stock-summary', 'receivables', 'payables'])
