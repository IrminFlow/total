// Migration from the old per-report column toggles (lib/reportConfig.ts, stored under
// `total-reportcfg-<slug>-<reportKey>` as { [columnKey]: boolean }) into a table view.
import type { ColumnDef, ViewState } from './types'
import { reconcileView } from './viewState'

/**
 * Applies a legacy useReportConfig visibility map to `base`. `idMap` maps legacy keys to table
 * column ids when they differ (one legacy key may map to several columns — TrialBalance's single
 * "movement" toggle drove two columns). Legacy `false` hides, `true` shows (even a column that is
 * `defaultHidden`). Unknown keys and non-boolean values are ignored; corrupt input returns `base`.
 */
export function applyLegacyReportConfig<Row>(
  raw: string | null,
  columns: readonly ColumnDef<Row>[],
  base: ViewState,
  idMap: Record<string, string | string[]> = {}
): ViewState {
  if (!raw) return base
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
  const hidden = new Set(base.hidden)
  for (const [key, on] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof on !== 'boolean') continue
    const mapped = idMap[key] ?? key
    for (const id of Array.isArray(mapped) ? mapped : [mapped]) {
      const col = columns.find((c) => c.id === id)
      if (!col || col.hideable === false) continue
      if (on) hidden.delete(id)
      else hidden.add(id)
    }
  }
  return reconcileView({ ...base, hidden: [...hidden] }, columns)
}
