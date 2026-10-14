// WP 10.5: the simple shell's own keys (Shell.tsx installs them in the simple shell only — the
// full app's keys are unchanged).
//
//   /   focuses the screen's search box where it has one (Home's "Ask Total" box, a list's
//       "Filter rows" box), like the web's convention. Never while typing in a box, with a
//       modifier held, or while a dialog is open; with no search box on the screen the key is
//       left alone.
//   ←/→/↑/↓ on a choice chip / card (role="radio") move to the next choice and pick it — every
//       simple radio group at once (the wizard installs it too).
//   Tab  reaches ONE choice per group — the picked one, else the first (WAI-ARIA radio group:
//       a roving tabindex, `useRovingRadios`), so a question is one Tab stop, not one per choice.
//
// The other simple keys live with their owners: ⌘K palette, ⌘J Ask Total (App.tsx), ? and ⌘/
// help (help/keys.ts — ? never while typing), Esc closes the topmost layer (dialogs:
// kit/layers.ts useDialogLayer; the simple panels: layers.ts routePanelEscape; then the form's
// own "discard?" and the app's "back"), ⌘↵ / ⌘N in each entry screen.
import { useEffect } from 'react'
import { isAnyModalOpen } from '../components/kit/layers'

export const typingIn = (el: EventTarget | null): boolean => {
  const h = el as HTMLElement | null
  if (!h || typeof h.tagName !== 'string') return false
  return h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || h.isContentEditable
}

/** The screen's search box: a role="search" form's field, else a search input, in <main>. */
export function screenSearchBox(root: ParentNode = document): HTMLElement | null {
  const main = root.querySelector('#main')
  if (!main) return null
  const candidates = main.querySelectorAll<HTMLElement>('[role="search"] input, [role="search"] textarea, input[type="search"]')
  for (const el of candidates) if (!(el as HTMLInputElement).disabled && el.getClientRects().length > 0) return el
  // jsdom has no layout: fall back to the first one.
  return candidates[0] ?? null
}

/**
 * ←/→/↑/↓ on a choice chip / card (`role="radio"` in a `role="radiogroup"` — the simple screens'
 * "Paid how?", "Who paid?", the wizard's cards …) move to the next / previous choice and pick it,
 * as a radio group does. True = handled.
 */
export function handleRadioArrows(e: KeyboardEvent): boolean {
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
  if (!step || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return false
  const el = e.target instanceof HTMLElement ? e.target : null
  if (!el || el.tagName === 'INPUT' || el.getAttribute('role') !== 'radio') return false
  const group = el.closest('[role="radiogroup"]')
  if (!group) return false
  const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].filter((r) => !(r as HTMLButtonElement).disabled && r.closest('[role="radiogroup"]') === group)
  const at = radios.indexOf(el)
  if (at < 0 || radios.length < 2) return false
  e.preventDefault()
  const to = radios[(at + step + radios.length) % radios.length]!
  to.focus()
  to.click()
  return true
}

/** Handles `/` (true = it moved the focus). */
export function handleSlashKey(e: KeyboardEvent): boolean {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return false
  if (typingIn(e.target) || isAnyModalOpen()) return false
  const box = screenSearchBox()
  if (!box) return false
  e.preventDefault()
  box.focus()
  return true
}

/**
 * The roving tabindex of every `role="radiogroup"` under `root`: the picked choice (else the first
 * enabled one) is the group's single Tab stop, every other choice is tabindex -1 (still focusable
 * by the arrow keys above). Radios of a nested group belong to that group only.
 */
export function syncRovingRadios(root: ParentNode = document): void {
  for (const group of root.querySelectorAll<HTMLElement>('[role="radiogroup"]')) {
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].filter((r) => r.closest('[role="radiogroup"]') === group)
    const enabled = radios.filter((r) => !(r as HTMLButtonElement).disabled && r.getAttribute('aria-disabled') !== 'true')
    const stop = enabled.find((r) => r.getAttribute('aria-checked') === 'true') ?? enabled[0]
    for (const r of radios) {
      const want = r === stop ? 0 : -1
      if (r.tabIndex !== want) r.tabIndex = want
    }
  }
}

/** Keeps `syncRovingRadios` true for the whole document while `on` (the simple shell, the wizard). */
export function useRovingRadios(on: boolean): void {
  useEffect(() => {
    if (!on || typeof MutationObserver === 'undefined') return
    syncRovingRadios()
    const mo = new MutationObserver(() => syncRovingRadios())
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked', 'disabled', 'aria-disabled', 'role'] })
    return () => mo.disconnect()
  }, [on])
}
