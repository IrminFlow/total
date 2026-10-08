import type { Screen } from '../state/stores'
import type { NavSectionId } from './screens'

/**
 * Dynamic sidebar entries — items that come from the company's data rather than the static
 * screen registry (lib/screens.ts), e.g. saved reports pinned to Analysis (WP 6.1). A source is a
 * hook returning the current items for one section; Shell renders them after the section's
 * registry items. Register sources at module load (never conditionally), so the hooks run in the
 * same order on every render.
 */
export interface DynamicNavItem {
  /** Unique within the section (React key). */
  key: string
  label: string
  screen: Screen
  /** data-testid of the sidebar button (convention: nav-<area>-<id>). */
  testId: string
  /** Whether this entry is the visible screen (registry items match by screen name only). */
  isActive: (screen: Screen) => boolean
  /** Tooltip. */
  title?: string
}

export interface DynamicNavSource {
  id: string
  section: NavSectionId
  useItems: () => DynamicNavItem[]
}

const SOURCES: DynamicNavSource[] = []

export function registerDynamicNav(source: DynamicNavSource): void {
  const at = SOURCES.findIndex((s) => s.id === source.id)
  if (at >= 0) SOURCES[at] = source
  else SOURCES.push(source)
}

export function dynamicNavSources(): readonly DynamicNavSource[] {
  return SOURCES
}

/** Every registered source's items, grouped by section (sections in source order). */
export function useDynamicNav(): Map<NavSectionId, DynamicNavItem[]> {
  const out = new Map<NavSectionId, DynamicNavItem[]>()
  for (const source of SOURCES) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- SOURCES is fixed after module load
    const items = source.useItems()
    if (items.length) out.set(source.section, [...(out.get(source.section) ?? []), ...items])
  }
  return out
}
