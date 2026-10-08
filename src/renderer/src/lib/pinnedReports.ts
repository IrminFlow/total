import { useQuery } from '@tanstack/react-query'
import { useSession } from '../state/stores'
import { reportsApi, type SavedReport } from './reportsClient'
import { registerDynamicNav, type DynamicNavItem } from './dynamicNav'

/** The company's saved reports (shared query: the builder, the sidebar, the packs screen). */
export function useSavedReports(): { data: SavedReport[] | undefined; isLoading: boolean } {
  const slug = useSession((s) => s.slug)
  const locked = useSession((s) => s.locked)
  return useQuery({ queryKey: ['savedReports'], queryFn: reportsApi.list, enabled: !!slug && !locked })
}

/** Saved reports pinned to the sidebar, as Analysis entries under the registry's screens. */
export function usePinnedReportItems(): DynamicNavItem[] {
  const { data } = useSavedReports()
  return (data ?? [])
    .filter((r) => r.pinned)
    .map((r) => ({
      key: `report-${r.id}`,
      label: r.name,
      title: `Saved report — ${r.name}`,
      screen: { name: 'report-builder', reportId: r.id },
      testId: `nav-report-${r.id}`,
      isActive: (s) => s.name === 'report-builder' && s.reportId === r.id
    }))
}

registerDynamicNav({ id: 'pinned-reports', section: 'analysis', useItems: usePinnedReportItems })
