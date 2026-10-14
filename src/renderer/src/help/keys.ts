// WP 10.3: the help panel's keys, for App's global key handler — in a simple company, ? (when no
// box has the focus) and ⌘/ (anywhere) open the help on the current screen's article, or close
// it. The full app keeps ? for its shortcut reference (returns false there).
import { helpKeyFor } from '../lib/screens'
import { useNav, useSession } from '../state/stores'
import { useHelpPanel } from './store'

const typingIn = (el: EventTarget | null): boolean => {
  const h = el as HTMLElement | null
  if (!h || typeof h.tagName !== 'string') return false
  return h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || h.isContentEditable
}

/** Handles the key (and returns true) when it is a help key in a simple company. */
export function handleHelpKey(e: KeyboardEvent): boolean {
  const s = useSession.getState()
  if (!s.slug || s.locked || s.ui.mode !== 'simple') return false
  const slash = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '/'
  const question = e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !typingIn(e.target)
  if (!slash && !question) return false
  e.preventDefault()
  useHelpPanel.getState().toggleForScreen(helpKeyFor(useNav.getState().stack.at(-1) ?? { name: 'gateway' }))
  return true
}
