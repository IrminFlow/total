/**
 * The keyboard layer registry — one place that decides who owns a keystroke.
 *
 * Total is keyboard-first: bare letters navigate (`V` = voucher entry), screens claim their own
 * action letters (`C` = contra inside voucher entry), lists take the arrows, and dialogs take
 * everything. Before this module those rules lived in nine separate `window.addEventListener`
 * calls plus two near-identical module-level stacks (`modalStack`, `keyNavStack`), each with its
 * own idea of "is something else in charge right now".
 *
 * The model is a stack of layers. A keystroke walks it top-down; the first layer whose `handle`
 * returns true consumes it. A layer marked `opaque` (a modal, the command palette) stops the walk
 * even when it declines, so keys aimed at a dialog can never leak to the screen underneath.
 *
 *   [palette]  opaque       Cmd-K
 *   [modal]    opaque       Esc, Tab trap
 *   [list]     transparent  arrows / Enter
 *   [screen]   transparent  this screen's action letters and F-keys
 *   [nav]      transparent  the registry accelerators, Esc-back, ?
 *
 * Priority is mount order (last pushed wins), which lands correctly on its own: a modal mounts
 * after the screen it covers, and a list inside a modal mounts after the modal.
 *
 * Two deliberate properties:
 *  - The dispatcher listens in the BUBBLE phase and ignores events with `defaultPrevented`.
 *    Element-level handlers (the TypeAhead dropdown, DateInput's shorthand parser) call
 *    `preventDefault` on the keys they own and run first, so field behaviour always wins without
 *    any layer needing to know those components exist.
 *  - `handle` returning a boolean, rather than layers declaring key lists, keeps the decision
 *    next to the behaviour — a layer that is conditionally interested (a screen action that is
 *    disabled right now) just returns false and the key falls through.
 */

import { useEffect, useRef } from 'react'

export type LayerKind = 'nav' | 'screen' | 'list' | 'modal' | 'palette'

export interface KeyLayer {
  id: number
  kind: LayerKind
  /** Return true to consume the key and stop the walk. */
  handle: (e: KeyboardEvent) => boolean
  /** When true nothing below this layer is consulted, even for keys it declines. */
  opaque: boolean
}

let seq = 0
let stack: KeyLayer[] = []
let listening = false

function dispatch(e: KeyboardEvent): void {
  // An element-level handler already claimed this key (TypeAhead's Enter, DateInput's shorthand).
  if (e.defaultPrevented) return
  for (let i = stack.length - 1; i >= 0; i--) {
    const layer = stack[i]!
    if (layer.handle(e)) return
    if (layer.opaque) return
  }
}

function ensureListening(): void {
  if (listening) return
  window.addEventListener('keydown', dispatch)
  listening = true
}

function stopListeningIfEmpty(): void {
  if (stack.length > 0 || !listening) return
  window.removeEventListener('keydown', dispatch)
  listening = false
}

export function pushLayer(layer: Omit<KeyLayer, 'id' | 'opaque'> & { opaque?: boolean }): number {
  const id = ++seq
  stack.push({ id, kind: layer.kind, handle: layer.handle, opaque: layer.opaque ?? false })
  ensureListening()
  return id
}

export function removeLayer(id: number): void {
  const i = stack.findIndex((l) => l.id === id)
  if (i >= 0) stack.splice(i, 1)
  stopListeningIfEmpty()
}

/** The topmost layer, optionally of a given kind. */
export function topLayer(kind?: LayerKind): KeyLayer | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!kind || stack[i]!.kind === kind) return stack[i]
  }
  return undefined
}

/**
 * True while a dialog or the palette owns the keyboard. Replaces the old `isAnyModalOpen()` —
 * screens use it to suppress their own shortcuts.
 */
export function isBlocked(): boolean {
  return stack.some((l) => l.opaque)
}

export function layerCount(): number {
  return stack.length
}

/** Focus is somewhere the user is typing, so bare-letter shortcuts must not fire. */
export function isTypingTarget(e: Pick<KeyboardEvent, 'target'>): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true
  // `isContentEditable` is the natural check but jsdom does not implement it, so match the
  // attribute instead. `closest` rather than a direct read because contenteditable inherits:
  // the event target is usually a text node's parent well inside the editable host.
  if (el.isContentEditable === true) return true
  return typeof el.closest === 'function' && el.closest('[contenteditable]:not([contenteditable="false"])') !== null
}

/** No modifier held — the precondition for every bare-letter accelerator. */
export function isPlainKey(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey
}

/**
 * Mount a layer for the life of a component.
 *
 * `handle` is held in a ref so the layer can close over fresh props without being torn down and
 * re-pushed on every render — re-pushing would move it to the top of the stack and quietly steal
 * priority from whatever mounted above it.
 *
 * Returns a STABLE ref holding the layer id (0 while unmounted). It has to be a ref rather than
 * the number itself: the id is only known once the mount effect runs, so a plain return value
 * would still be 0 in the handler closure of the first render, and the layer would spend its
 * whole life comparing against the wrong id.
 *
 * `topOfKind` narrows a layer to "only respond while I am the topmost layer of my kind" — how
 * lists avoid fighting each other. The check lives here so callers never touch ids at all.
 */
export function useKeyLayer(
  kind: LayerKind,
  handle: (e: KeyboardEvent) => boolean,
  opts: { opaque?: boolean; enabled?: boolean; topOfKind?: boolean } = {}
): { readonly current: number } {
  const { opaque = false, enabled = true, topOfKind = false } = opts
  const handleRef = useRef(handle)
  handleRef.current = handle
  const idRef = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const id = pushLayer({
      kind,
      opaque,
      handle: (e) => {
        if (topOfKind && topLayer(kind)?.id !== idRef.current) return false
        return handleRef.current(e)
      }
    })
    idRef.current = id
    return () => {
      removeLayer(id)
      idRef.current = 0
    }
  }, [kind, opaque, enabled, topOfKind])

  return idRef
}

/** Test-only: drop every layer and detach the listener. */
export function __resetLayersForTest(): void {
  stack = []
  stopListeningIfEmpty()
  if (listening) {
    window.removeEventListener('keydown', dispatch)
    listening = false
  }
}
