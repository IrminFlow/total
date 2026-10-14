// WP 10.5: the simple shell's own keys (Shell.tsx installs them in the simple shell only — the
// full app's keys are unchanged).
//
//   /   focuses the screen's search box where it has one (Home's "Ask Total" box, a list's
//       "Filter rows" box), like the web's convention. Never while typing in a box, with a
//       modifier held, or while a dialog is open; with no search box on the screen the key is
//       left alone.
//
// The other simple keys live with their owners: ⌘K palette, ⌘J Ask Total (App.tsx), ? and ⌘/
// help (help/keys.ts — ? never while typing), Esc closes the topmost layer (dialogs:
// kit/layers.ts useDialogLayer; the simple panels: layers.ts routePanelEscape; then the form's
// own "discard?" and the app's "back"), ⌘↵ / ⌘N in each entry screen.
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
