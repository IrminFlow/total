import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { DEFAULT_FEATURES, type CompanyFeatures } from '@shared/features'

/**
 * Company feature flags (Tally's F11), backed by react-query so every screen shares one cache
 * entry — Settings → Features writes through api.config.features.set and invalidates ['features'],
 * every gated screen re-renders. Defaults (all on) while the query is loading, so nothing flashes
 * hidden-then-shown on first paint.
 */
export function useFeatures(): CompanyFeatures {
  const { data } = useQuery({ queryKey: ['features'], queryFn: api.config.features.get })
  return data ?? DEFAULT_FEATURES
}
