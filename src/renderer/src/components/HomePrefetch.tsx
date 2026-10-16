import { useEffect } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import type { CompanyFeatures } from '@shared/features'
import { useScreen, type Screen } from '../state/stores'
import { ACCOUNTANT_NAV, SIMPLE_ENTRIES } from '../lib/screens'
import { useFeatures } from '../lib/useFeatures'
import { useChunkLoading } from '../lib/chunkLoading'
import { prefetchWhenIdle } from '../lib/lazyScreen'
import { SCREEN_CHUNKS } from '../lazyScreens'

/** The screens the sidebar lists (accountant NAV, or every simple section's entries). */
export function sidebarScreens(simple: boolean, features: CompanyFeatures): Screen['name'][] {
  const on = (f: keyof CompanyFeatures | undefined): boolean => !f || !!features[f]
  if (simple) {
    return ['simple-section', ...SIMPLE_ENTRIES.filter((e) => e.features.every(on)).map((e) => e.screen.name)]
  }
  return ACCOUNTANT_NAV.filter((s) => on(s.feature)).flatMap((s) => s.items.filter((i) => on(i.feature)).map((i) => i.screen.name))
}

const warmed = new Set<string>()

/**
 * Once Home has loaded (nothing fetching, no chunk pending), loads the code of the sidebar's
 * screens one per idle slot, so the first click on any of them renders at once. Renders nothing.
 */
export function HomePrefetch({ simple }: { simple: boolean }): null {
  const screen = useScreen()
  const fetching = useIsFetching()
  const chunks = useChunkLoading((s) => s.count)
  const features = useFeatures()
  const idle = screen.name === 'gateway' && fetching === 0 && chunks === 0
  const key = simple ? 'simple' : 'accountant'
  useEffect(() => {
    if (!idle || warmed.has(key)) return
    warmed.add(key)
    const preloads = sidebarScreens(simple, features).flatMap((name) => (SCREEN_CHUNKS[name] ?? []).map((c) => c.preload))
    prefetchWhenIdle(preloads)
  }, [idle, key, simple, features])
  return null
}
