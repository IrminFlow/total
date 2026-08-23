/**
 * Per-screen accelerators.
 *
 * A screen declares its own actions once; three surfaces read the same declaration:
 *  - the `screen` keyboard layer that actually runs them,
 *  - the footer hint bar,
 *  - the `?` shortcut overlay,
 *  - and the sidebar, which greys out any nav letter the screen has taken over.
 *
 * Keeping one declaration is the point: the previous arrangement had VoucherEntry's F-key map,
 * the footer's hint text and ShortcutHelp's documentation as three hand-maintained lists, so
 * the help could (and did) drift from the behaviour.
 *
 * Tally note: a screen action may carry BOTH a bare letter and an F-key. Bare letters only fire
 * when focus is outside a text field, and voucher entry keeps focus in a field almost always, so
 * the F-keys stay the primary path there. That mirrors Tally, where the letters come off the
 * right-hand button bar rather than the entry grid.
 */

import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import type { Screen } from '../state/stores'
import { isPlainKey, isTypingTarget, useKeyLayer } from './keyboard'

export interface AccelAction {
  /** Bare letter or digit. Fires only with no modifier and no text field focused. */
  key?: string
  /** Tally function key, e.g. 'F5'. Fires regardless of focus, as Tally's do. */
  fkey?: string
  /**
   * The F-key form requires Ctrl or Alt (credit/debit note, which share F8/F9 with sales and
   * purchase). Applies to `fkey` only — a bare letter can never carry a modifier, since
   * `isPlainKey` is what distinguishes an accelerator from a browser/OS chord.
   */
  ctrlOrAlt?: boolean
  label: string
  run: () => void
  /** Live only when this returns true; shown greyed in the hint bar otherwise. */
  when?: () => boolean
  /** Bound but not advertised. */
  hidden?: boolean
}

/** What the hint bar and shortcut overlay render — plain data, no callbacks. */
export interface AccelDescriptor {
  key?: string
  fkey?: string
  ctrlOrAlt?: boolean
  label: string
  enabled: boolean
  hidden?: boolean
}

interface AccelState {
  screen: Screen['name'] | null
  actions: AccelDescriptor[]
  publish: (screen: Screen['name'] | null, actions: AccelDescriptor[]) => void
}

export const useAccelStore = create<AccelState>((set) => ({
  screen: null,
  actions: [],
  publish: (screen, actions) => set({ screen, actions })
}))

/** Uppercase bare keys the active screen has claimed — the sidebar greys these out. */
export function useShadowedAccels(): Set<string> {
  const actions = useAccelStore((s) => s.actions)
  return useMemo(
    () => new Set(actions.filter((a) => a.enabled && a.key).map((a) => a.key!.toUpperCase())),
    [actions]
  )
}

function matches(action: AccelAction, e: KeyboardEvent): boolean {
  if (action.fkey && e.key === action.fkey) {
    const withModifier = e.ctrlKey || e.altKey
    // Ctrl/Alt+F8 (credit note) and plain F8 (sales) are different actions on the same key, so
    // the modifier has to be part of the match rather than merely tolerated.
    return action.ctrlOrAlt ? withModifier : !withModifier && !e.metaKey
  }
  if (!action.key) return false
  if (!isPlainKey(e) || isTypingTarget(e)) return false
  return e.key.toLowerCase() === action.key.toLowerCase()
}

/**
 * Bind this screen's accelerators for as long as it is mounted.
 *
 * `actions` may be rebuilt on every render; only a change to the rendered *shape* (keys, labels,
 * enabled-ness) republishes to the store, so the hint bar does not re-render on every keystroke.
 */
export function useScreenAccels(screen: Screen['name'], actions: AccelAction[]): void {
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useKeyLayer('screen', (e) => {
    for (const action of actionsRef.current) {
      if (action.when && !action.when()) continue
      if (!matches(action, e)) continue
      e.preventDefault()
      action.run()
      return true
    }
    return false
  })

  const descriptors: AccelDescriptor[] = actions.map((a) => ({
    key: a.key,
    fkey: a.fkey,
    ctrlOrAlt: a.ctrlOrAlt,
    label: a.label,
    enabled: a.when ? a.when() : true,
    hidden: a.hidden
  }))
  const signature = JSON.stringify(descriptors)
  const publish = useAccelStore((s) => s.publish)

  useEffect(() => {
    publish(screen, JSON.parse(signature) as AccelDescriptor[])
  }, [screen, signature, publish])

  useEffect(() => () => publish(null, []), [publish])
}
