import { useMemo, type ReactNode } from 'react'
import { useT } from '../lib/i18n'
import { ENGLISH_KIT_LABELS, KitLabelsProvider, type KitLabels } from '../components/kit/labels'
import type { Translate } from '@shared/i18n'

/** WP 10.4: the shared kit's words (dialog / drawer chrome, input hints, the DataTable toolbar)
 *  in the reader's language, for everything rendered inside the simple shell or the setup wizard.
 *  The full app keeps the kit's English defaults (components/kit/labels.tsx). */
export function simpleKitLabels(t: Translate): KitLabels {
  return {
    close: t('common.close'),
    resizePanel: t('common.kit.resizePanel'),
    dismiss: t('common.kit.dismiss'),
    loading: t('common.loading'),
    unavailable: t('common.kit.unavailable'),
    amount: t('common.kit.amount'),
    date: t('common.kit.date'),
    notAnAmount: t('common.kit.notAnAmount'),
    dateHint: t('common.kit.dateHint'),
    discardPrompt: t('common.kit.discardPrompt'),
    discard: t('common.kit.discard'),
    keepEditing: t('common.kit.keepEditing'),
    table: {
      filterRows: t('common.table.filterRows'),
      filterRowsLabel: t('common.table.filterRowsLabel'),
      rowCount: (count, shown) => (shown != null ? t('common.table.rowsOf', { count, shown }) : t('common.table.rows', { count })),
      groupBy: t('common.table.groupBy'),
      groupNone: t('common.table.groupNone'),
      compactRows: t('common.table.compactRows'),
      compact: t('common.table.compact'),
      comfortable: t('common.table.comfortable'),
      columns: t('common.table.columns'),
      chooseColumns: t('common.table.chooseColumns'),
      views: t('common.table.views'),
      savedViews: t('common.table.savedViews'),
      defaultView: t('common.table.defaultView'),
      nothingToShow: t('common.table.nothingToShow'),
      noRowsMatch: t('common.table.noRowsMatch'),
      noneMatch: (count) => t('common.table.noneMatch', { count }),
      quickNoMatch: (query) => t('common.table.quickNoMatch', { query }),
      clearFilters: t('common.table.clearFilters'),
      clearAll: t('common.table.clearAll'),
      activeFilters: t('common.table.activeFilters'),
      removeFilter: (what) => t('common.table.removeFilter', { what }),
      filterColumn: (column, filtered) => t('common.table.filterColumn', { column, filtered: filtered ? 'yes' : 'no' })
    }
  }
}

/** Provides the translated kit words below it while `on` (the simple shell); off = the kit's
 *  English defaults, exactly as before (always rendered, so toggling never remounts children). */
export function SimpleKitLabels({ on, children }: { on: boolean; children: ReactNode }): React.JSX.Element {
  const t = useT()
  const labels = useMemo(() => (on ? simpleKitLabels(t) : ENGLISH_KIT_LABELS), [on, t])
  return <KitLabelsProvider value={labels}>{children}</KitLabelsProvider>
}
