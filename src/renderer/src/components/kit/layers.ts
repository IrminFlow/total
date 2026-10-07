import { useEffect, useRef, type RefObject } from 'react'

/**
 * The dialog-layer stack shared by Modal and Drawer (and consulted by useKeyNav and Popover).
 * Only the topmost layer responds to Esc/Tab, so stacked layers (a ConfirmModal over a Drawer over
 * the screen) close one at a time, and keyboard lists behind the top layer are suspended.
 */

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

let layerSeq = 0
const layerStack: number[] = []
/** Each mounted layer's element (by stack id), so lists and popovers can tell whether they live
 *  inside the topmost one. */
const layerElements = new Map<number, () => HTMLElement | null>()

/** True while any Modal or Drawer is mounted — screens use it to suppress their own global
 *  shortcuts (Gateway single-letter keys, VoucherEntry F-keys / ⌘↵) so keys aimed at a dialog
 *  never leak through to the screen underneath. useKeyNav already checks this internally. */
export function isAnyModalOpen(): boolean {
  return layerStack.length > 0
}

/** The topmost open layer's element (Modal dialog or Drawer panel), or null when none is open.
 *  Popovers portal into it (so they sit inside its focus trap and above its content); keyboard
 *  lists inside it keep working while everything behind it is suspended. */
export function topModalElement(): HTMLElement | null {
  const id = layerStack[layerStack.length - 1]
  return id === undefined ? null : (layerElements.get(id)?.() ?? null)
}

/**
 * Open "Esc layers" above dialogs — transient overlays (the table's filter/column/view popovers)
 * that must take Esc before the dialog does. A dialog's capture-phase key handler is registered
 * first, so it would otherwise close the whole dialog; while a layer is open it lets Esc through.
 * Returns the unregister function.
 */
let escapeLayers = 0
export function registerEscapeLayer(): () => void {
  escapeLayers++
  let done = false
  return () => {
    if (done) return
    done = true
    escapeLayers--
  }
}

/** An element (or an ancestor) marked `data-consumes-escape` handles Esc itself first — e.g. the
 *  table's quick filter clears its text — so a dialog doesn't close on that keypress. */
const consumesEscape = (t: EventTarget | null): boolean => t instanceof Element && t.closest('[data-consumes-escape]') !== null

/**
 * Registers `ref` as a dialog layer while mounted: pushes it on the stack, traps Tab inside it,
 * routes Esc (when it is the top layer and no popover/field claims Esc) to `onEscape`, moves focus
 * in on mount (unless a child autoFocus already took it) and restores focus on unmount.
 */
export function useDialogLayer(ref: RefObject<HTMLElement | null>, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const el = ref.current
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? el).focus()
    }
    return () => {
      previous?.focus?.()
    }
  }, [ref])

  useEffect(() => {
    const id = ++layerSeq
    layerStack.push(id)
    layerElements.set(id, () => ref.current)
    const isTop = (): boolean => layerStack[layerStack.length - 1] === id
    const onKey = (e: KeyboardEvent): void => {
      if (!isTop()) return
      if (e.key === 'Escape') {
        // A popover (or a field that clears itself) inside the layer takes this Esc first.
        if (escapeLayers > 0 || consumesEscape(e.target)) return
        e.stopPropagation()
        onEscapeRef.current()
      } else if (e.key === 'Tab') {
        const el = ref.current
        if (!el) return
        const focusables = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (f) => f.offsetParent !== null || f === document.activeElement
        )
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        const inside = el.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const i = layerStack.indexOf(id)
      if (i >= 0) layerStack.splice(i, 1)
      layerElements.delete(id)
    }
  }, [ref])
}

/** Number of open layers — for tests and for useKeyNav's "Enter belongs to the dialog's button". */
export function layerCount(): number {
  return layerStack.length
}
