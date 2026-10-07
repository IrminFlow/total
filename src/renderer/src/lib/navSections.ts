import { useEffect, useState } from 'react'
import { useSession, type Screen } from '../state/stores'
import { screenDef, type NavSectionId } from './screens'

/**
 * Collapsible sidebar sections. The user's open/closed choices are a display preference —
 * persisted to localStorage under `total-navsections-<company-slug>` (like reportConfig.ts), never
 * to the company database. Only sections the user has toggled are stored; the rest follow
 * DEFAULT_OPEN.
 *
 * Navigating to a screen auto-opens its section for the session (`autoOpen`) without writing that
 * into the stored preferences, so other sections keep exactly what the user chose. Toggling the
 * auto-opened section clears the override and stores the user's explicit choice.
 */

export type NavSectionPrefs = Partial<Record<NavSectionId, boolean>>

/** The untitled top block is always open; of the headed sections only Books starts open. */
export const DEFAULT_OPEN: Record<NavSectionId, boolean> = {
  top: true,
  trade: true,
  books: true,
  analysis: false,
  banking: false,
  payroll: false,
  gst: false,
  system: false
}

/** Sidebar section the screen lives in, or null for screens outside the sidebar. */
export function sectionOfScreen(name: Screen['name']): NavSectionId | null {
  return screenDef(name)?.navSection ?? null
}

/** Whether a section is shown expanded: top always; the auto-opened one; else stored ?? default. */
export function isSectionOpen(id: NavSectionId, prefs: NavSectionPrefs, autoOpen: NavSectionId | null): boolean {
  if (id === 'top' || id === autoOpen) return true
  return prefs[id] ?? DEFAULT_OPEN[id]
}

/** Flip a section's visible state, storing the result as an explicit preference. */
export function toggleSection(
  id: NavSectionId,
  prefs: NavSectionPrefs,
  autoOpen: NavSectionId | null
): { prefs: NavSectionPrefs; autoOpen: NavSectionId | null } {
  if (id === 'top') return { prefs, autoOpen }
  return {
    prefs: { ...prefs, [id]: !isSectionOpen(id, prefs, autoOpen) },
    autoOpen: autoOpen === id ? null : autoOpen
  }
}

export function useNavSections(activeScreen: Screen['name']): {
  isOpen: (id: NavSectionId) => boolean
  toggle: (id: NavSectionId) => void
  setOpen: (id: NavSectionId, open: boolean) => void
} {
  const slug = useSession((s) => s.slug)
  const storageKey = `total-navsections-${slug ?? 'nocompany'}`

  const load = (): NavSectionPrefs => {
    try {
      const stored = localStorage.getItem(storageKey)
      return stored ? (JSON.parse(stored) as NavSectionPrefs) : {}
    } catch {
      return {}
    }
  }

  const [prefs, setPrefs] = useState<NavSectionPrefs>(load)
  const [autoOpen, setAutoOpen] = useState<NavSectionId | null>(() => sectionOfScreen(activeScreen))

  // Re-load when the company changes — each company keeps its own sidebar layout.
  useEffect(() => {
    setPrefs(load())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  // Screens outside the sidebar (company details, ledger statement) keep the last auto-open.
  useEffect(() => {
    const section = sectionOfScreen(activeScreen)
    if (section) setAutoOpen(section)
  }, [activeScreen])

  const toggle = (id: NavSectionId): void => {
    const next = toggleSection(id, prefs, autoOpen)
    localStorage.setItem(storageKey, JSON.stringify(next.prefs))
    setPrefs(next.prefs)
    setAutoOpen(next.autoOpen)
  }

  const isOpen = (id: NavSectionId): boolean => isSectionOpen(id, prefs, autoOpen)

  return { isOpen, toggle, setOpen: (id, open) => { if (isOpen(id) !== open) toggle(id) } }
}
