// Launch to Home: the Gateway's four reads — report:dashboardSeries, report:dashboard,
// payables:msmeDue and report:dashboardPromised — come from ONE round trip (dashboard:all). Every
// card keeps its own query key and its own loading / error state: each part's queryFn asks this
// fetcher, which shares one in-flight dashboard:all between them (react-query's fetchQuery
// dedupes the concurrent calls; invalidating ['dashboard'] refetches it once). A failing part
// fails only its query, as when they were four calls. Outside the Gateway (tests rendering a card
// alone) there is no provider and each card calls its own channel as before.
import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import type { DashSection } from '@shared/dashboard'

type All = Awaited<ReturnType<typeof api.reports.dashboardAll>>
export type GatewayPart = keyof All
type PartData<K extends GatewayPart> = NonNullable<All[K]> extends DashSection<infer D> ? D : never
export type GatewayFetch = <K extends GatewayPart>(part: K) => Promise<PartData<K>>

const GatewayDataContext = createContext<GatewayFetch | null>(null)

/** The Gateway's shared fetcher, or null outside the Gateway (call your own channel then). */
export function useGatewayFetch(): GatewayFetch | null {
  return useContext(GatewayDataContext)
}

/** One dashboard:all per (today, period, parties) — the parts' queryFns all resolve from it. */
export function useGatewayFetcher(today: string, from: string, to: string, parties: boolean): GatewayFetch {
  const queryClient = useQueryClient()
  return useCallback(
    async <K extends GatewayPart>(part: K): Promise<PartData<K>> => {
      const all = await queryClient.fetchQuery({
        queryKey: ['dashboard', 'all', today, from, to, parties],
        queryFn: () => api.reports.dashboardAll(today, from, to, parties),
        // The parts ask together; a part refetched on its own a moment later reuses the answer.
        staleTime: 1_000
      })
      const section = all[part] as DashSection<PartData<K>> | null
      if (!section) throw new Error('Not loaded on this dashboard')
      if (!section.ok) throw new Error(section.error)
      return section.data
    },
    [queryClient, today, from, to, parties]
  )
}

export function GatewayDataProvider({ fetch, children }: { fetch: GatewayFetch; children: ReactNode }): React.JSX.Element {
  return <GatewayDataContext.Provider value={fetch}>{children}</GatewayDataContext.Provider>
}
