import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { DEFAULT_FEATURES, screenFeatures, type ScreenFeatures } from '@shared/features'

/**
 * Company feature flags (Tally's F11), backed by react-query so every screen shares one cache
 * entry — Settings → Features writes through api.config.features.set and invalidates ['features'],
 * every gated screen re-renders. Defaults (all on) while the query is loading, so nothing flashes
 * hidden-then-shown on first paint. The feature cleanup's hidden features (`unused`, computed by
 * main) come with the same query and turn their flags off here (shared/features.ts screenFeatures).
 */
export function useFeatures(): ScreenFeatures {
  const { data } = useQuery({ queryKey: ['features'], queryFn: api.config.features.get })
  // WP 8.3: `manufacturing` resolved (absent = follows inventory), so screens gate on it directly.
  return screenFeatures(data ?? DEFAULT_FEATURES)
}
