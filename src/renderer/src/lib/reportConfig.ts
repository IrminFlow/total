import { useEffect, useState } from 'react'
import { useSession } from '../state/stores'

export interface ReportColumn {
  key: string
  label: string
  defaultOn: boolean
}

export interface SavedReportView<T> {
  name: string
  value: T
  createdAt: string
}

/** Named, per-company report states. Callers decide which deterministic filters belong in T. */
export function useSavedReportViews<T>(reportKey: string): {
  views: SavedReportView<T>[]
  save: (name: string, value: T) => void
  remove: (name: string) => void
} {
  const slug = useSession((s) => s.slug)
  const storageKey = `total-reportviews-${slug ?? 'nocompany'}-${reportKey}`
  const load = (): SavedReportView<T>[] => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is SavedReportView<T> =>
        !!item && typeof item === 'object' && typeof (item as SavedReportView<T>).name === 'string' && 'value' in item
      ).slice(0, 20)
    } catch {
      return []
    }
  }
  const [views, setViews] = useState<SavedReportView<T>[]>(load)
  useEffect(() => setViews(load()), [storageKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const persist = (next: SavedReportView<T>[]): void => {
    localStorage.setItem(storageKey, JSON.stringify(next))
    setViews(next)
  }
  const save = (rawName: string, value: T): void => {
    const name = rawName.trim().slice(0, 48)
    if (!name) return
    const withoutSameName = views.filter((view) => view.name.toLocaleLowerCase() !== name.toLocaleLowerCase())
    persist([{ name, value, createdAt: new Date().toISOString() }, ...withoutSameName].slice(0, 20))
  }
  const remove = (name: string): void => persist(views.filter((view) => view.name !== name))
  return { views, save, remove }
}

/**
 * F12-style per-report column visibility. Purely a display preference — persisted to
 * localStorage under `total-reportcfg-<company-slug>-<reportKey>`, never to the company database,
 * and never changes what a report *computes* (only what's rendered). A hidden column's <th>/<td>
 * pair is simply not rendered; the underlying query/data is untouched.
 *
 * Pattern for a new report screen:
 *   const COLUMNS: ReportColumn[] = [{ key: 'debit', label: 'Debit', defaultOn: true }, ...]
 *   const { visible, toggle } = useReportConfig('my-report', COLUMNS)
 *   ...
 *   {visible.debit && <th>Debit</th>}   // and the matching <td> in the body
 *   <ReportConfigButton columns={COLUMNS} visible={visible} toggle={toggle} />
 */
export function useReportConfig(
  reportKey: string,
  columns: ReportColumn[]
): { visible: Record<string, boolean>; toggle: (key: string) => void } {
  const slug = useSession((s) => s.slug)
  const storageKey = `total-reportcfg-${slug ?? 'nocompany'}-${reportKey}`

  const load = (): Record<string, boolean> => {
    const defaults = Object.fromEntries(columns.map((c) => [c.key, c.defaultOn]))
    try {
      const stored = localStorage.getItem(storageKey)
      if (!stored) return defaults
      return { ...defaults, ...(JSON.parse(stored) as Record<string, boolean>) }
    } catch {
      return defaults
    }
  }

  const [visible, setVisible] = useState<Record<string, boolean>>(load)

  // Re-load when the company (or report) changes — a fresh company shouldn't inherit the
  // previous one's column choices since they share no localStorage key.
  useEffect(() => {
    setVisible(load())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const toggle = (key: string): void => {
    setVisible((v) => {
      const next = { ...v, [key]: !v[key] }
      localStorage.setItem(storageKey, JSON.stringify(next))
      return next
    })
  }

  return { visible, toggle }
}
