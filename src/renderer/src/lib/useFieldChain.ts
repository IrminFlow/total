/**
 * Tally Enter-chaining: Enter moves to the next field, and Enter on the last one asks to accept.
 *
 * This is the single most defining behaviour of Tally data entry — an operator keys a whole
 * voucher without ever reaching for Tab or the mouse — and the app did not have it. Field
 * traversal was plain browser Tab order, and `AmountInput` even shipped an `onEnter` prop that
 * no call site ever passed.
 *
 * Order is resolved from the DOM at the moment Enter is pressed, rather than from a declared
 * field list. The entry forms render fields conditionally (cheque number only for payments, the
 * currency block behind a feature flag, a cost-centre column behind another) and splice rows
 * into the middle of the line grid when TDS applies, so a declared list would have to restate
 * every one of those conditions and would rot the first time one changed. Document order is
 * already the truth.
 *
 * The handler sits on the form container, so no field component needs to know the chain exists:
 *  - Anything that already claimed Enter (the ledger type-ahead picking a match, DateInput
 *    committing shorthand) calls preventDefault, and this bails on `defaultPrevented`.
 *  - Buttons are skipped by default so Enter never walks onto Save/Delete/Cancel. A control that
 *    *should* be in the chain — the Dr/Cr toggle — opts in with `data-chain`.
 */

import { useCallback, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

/**
 * Fields the chain visits: real inputs, plus anything that opts in with `data-chain`.
 * `[data-chain='skip']` opts a field out (a read-only display input, say).
 */
const CHAIN_SELECTOR = [
  "input:not([disabled]):not([type='hidden'])",
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[data-chain]:not([data-chain="skip"])'
].join(', ')

/**
 * Is this field actually on screen?
 *
 * `offsetParent === null` is the usual test but it depends on layout, which jsdom does not do —
 * under test every field would look hidden and the chain would never move. Prefer
 * `checkVisibility()` where Chromium provides it and fall back to computed style, which jsdom
 * does implement.
 */
function isVisible(el: HTMLElement): boolean {
  if (el === document.activeElement) return true
  if (typeof el.checkVisibility === 'function') return el.checkVisibility()
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function chainFields(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CHAIN_SELECTOR)).filter(
    (el) =>
      el.dataset.chain !== 'skip' &&
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      isVisible(el)
  )
}

export interface FieldChain {
  /** Spread onto the form container. */
  containerProps: { onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void }
  /** Move focus to the field after `from` (defaults to the focused one). Used after a picker
   *  commits a value, where the picker — not the chain — consumed the Enter. */
  advance: (from?: HTMLElement) => void
  focusFirst: () => void
}

export function useFieldChain(
  rootRef: RefObject<HTMLElement | null>,
  opts: { onAccept?: () => void; enabled?: boolean } = {}
): FieldChain {
  const { onAccept, enabled = true } = opts

  const advance = useCallback(
    (from?: HTMLElement) => {
      const root = rootRef.current
      if (!root) return
      const fields = chainFields(root)
      const current = from ?? (document.activeElement as HTMLElement | null)
      const index = current ? fields.indexOf(current) : -1
      const next = fields[index + 1]
      if (next) {
        next.focus()
        if (next instanceof HTMLInputElement && next.type !== 'checkbox') next.select()
        return
      }
      // Past the last field: this is the "Accept?" moment.
      onAccept?.()
    },
    [rootRef, onAccept]
  )

  const focusFirst = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    chainFields(root)[0]?.focus()
  }, [rootRef])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (!enabled || e.key !== 'Enter') return
      // Someone closer to the event already owns this Enter (a type-ahead picking a match, a
      // date field committing shorthand). Never advance out from under them.
      if (e.defaultPrevented) return
      // Cmd/Ctrl+Enter is "save now", handled by the entry screens themselves.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement
      // Enter on a button means "press it", not "move on".
      if (target.tagName === 'BUTTON' && target.dataset.chain === undefined) return
      if (target.tagName === 'TEXTAREA') return
      e.preventDefault()
      advance(target)
    },
    [enabled, advance]
  )

  return { containerProps: { onKeyDown }, advance, focusFirst }
}
