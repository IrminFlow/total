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
  /**
   * A shortcut that is neither a bare letter nor an F-key — ⌥↑ to move a voucher line, ⌘⌫ to
   * delete one. Declaring them here rather than in a private useKeyLayer is what keeps the `?`
   * overlay and the hint bar honest: a binding that is not in this list is not documented
   * anywhere, and that is how the overlay drifted from the behaviour before the registry existed.
   *
   * `display` is then required, because there is no key or fkey to render a cap from.
   */
  match?: (e: KeyboardEvent) => boolean
  /** Key caps to render for this action, overriding the ones derived from key/fkey. */
  display?: string[]
  label: string
  run: () => void
  /** Live only when this returns true; shown greyed in the hint bar otherwise. */
  when?: () => boolean
  /**
   * Kept off the footer hint bar, but still listed in the `?` overlay.
   *
   * The bar is one line of a fixed-width window and it belongs to the actions used every minute
   * — on voucher entry, the ten type keys. An eleventh entry does not shorten them, it pushes
   * the last of them off the right-hand edge, which costs more than the new one gains. The
   * overlay has room, and now has a search box.
   */
  hintHidden?: boolean
}

/** What the hint bar and shortcut overlay render — plain data, no callbacks. */
export interface AccelDescriptor {
  key?: string
  fkey?: string
  ctrlOrAlt?: boolean
  display?: string[]
  label: string
  enabled: boolean
  hintHidden?: boolean
}

/**
 * More than one component can publish for the same screen.
 *
 * Voucher entry is the case that forced it: the screen shell owns the voucher-type F-keys, and
 * the entry grid inside it owns the line-editing chords. A single flat `actions` array meant
 * whichever of them rendered last silently erased the other's from the hint bar and the `?`
 * overlay — the bindings kept working, so the only symptom was documentation quietly going
 * missing, which is the failure this registry exists to prevent.
 *
 * So publishers are keyed by a token they hold for their lifetime, and `actions` is the
 * concatenation in registration order.
 */
interface AccelState {
  screen: Screen['name'] | null
  actions: AccelDescriptor[]
  groups: { token: number; actions: AccelDescriptor[] }[]
  publish: (token: number, screen: Screen['name'] | null, actions: AccelDescriptor[]) => void
  retract: (token: number) => void
}

let accelToken = 0
/** A stable identity for one publishing component. */
export function nextAccelToken(): number {
  return ++accelToken
}

const flatten = (groups: AccelState['groups']): AccelDescriptor[] => groups.flatMap((g) => g.actions)

export const useAccelStore = create<AccelState>((set) => ({
  screen: null,
  actions: [],
  groups: [],
  publish: (token, screen, actions) =>
    set((s) => {
      const existing = s.groups.findIndex((g) => g.token === token)
      const groups =
        existing === -1
          ? [...s.groups, { token, actions }]
          : s.groups.map((g) => (g.token === token ? { token, actions } : g))
      return { screen: screen ?? s.screen, groups, actions: flatten(groups) }
    }),
  retract: (token) =>
    set((s) => {
      const groups = s.groups.filter((g) => g.token !== token)
      return { groups, actions: flatten(groups), screen: groups.length === 0 ? null : s.screen }
    })
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
  // A custom matcher owns the decision entirely — it is used for chords the key/fkey shape
  // cannot express, so falling through to that shape afterwards would double-match.
  if (action.match) return action.match(e)
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
    display: a.display,
    label: a.label,
    enabled: a.when ? a.when() : true,
    hintHidden: a.hintHidden
  }))
  const signature = JSON.stringify(descriptors)
  const publish = useAccelStore((s) => s.publish)
  const retract = useAccelStore((s) => s.retract)
  const tokenRef = useRef(0)
  if (tokenRef.current === 0) tokenRef.current = nextAccelToken()

  useEffect(() => {
    publish(tokenRef.current, screen, JSON.parse(signature) as AccelDescriptor[])
  }, [screen, signature, publish])

  useEffect(() => {
    const token = tokenRef.current
    return () => retract(token)
  }, [retract])
}
