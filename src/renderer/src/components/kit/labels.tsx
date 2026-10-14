// WP 10.4: the words the shared kit itself prints (dialog / drawer chrome, inputs' hints, the
// DataTable toolbar and empty states). The full app keeps these literal English values — the
// default of the context, so accountant screens and their snapshots are byte-identical. The
// simple shell (and the setup wizard) provide a translated set built from `common.*` keys
// (simple/kitLabels.ts), so a Hindi reader never meets an English "Close" or "Filter rows…".
import { createContext, useContext } from 'react'

export interface KitLabels {
  close: string
  resizePanel: string
  dismiss: string
  loading: string
  unavailable: string
  amount: string
  date: string
  notAnAmount: string
  dateHint: string
  discardPrompt: string
  discard: string
  keepEditing: string
  table: {
    filterRows: string
    filterRowsLabel: string
    /** "12 rows" / "3 of 12 rows". */
    rowCount: (total: number, shown: number | null) => string
    groupBy: string
    groupNone: string
    compactRows: string
    compact: string
    comfortable: string
    columns: string
    chooseColumns: string
    views: string
    savedViews: string
    defaultView: string
    nothingToShow: string
    noRowsMatch: string
    noneMatch: (total: number) => string
    quickNoMatch: (query: string) => string
    clearFilters: string
    clearAll: string
    activeFilters: string
    removeFilter: (what: string) => string
    filterColumn: (label: string, filtered: boolean) => string
  }
}

export const ENGLISH_KIT_LABELS: KitLabels = {
  close: 'Close',
  resizePanel: 'Resize the panel',
  dismiss: 'Dismiss',
  loading: 'Loading',
  unavailable: 'Unavailable',
  amount: 'Amount',
  date: 'Date',
  notAnAmount: 'Not an amount',
  dateHint: 'Try 7, 7/4, t, y or 15-08-2026',
  discardPrompt: 'Discard unsaved changes?',
  discard: 'Discard',
  keepEditing: 'Keep editing',
  table: {
    filterRows: 'Filter rows…',
    filterRowsLabel: 'Filter rows',
    rowCount: (total, shown) => `${shown != null ? `${shown} of ${total}` : `${total}`} ${total === 1 ? 'row' : 'rows'}`,
    groupBy: 'Group',
    groupNone: 'None',
    compactRows: 'Compact rows',
    compact: 'Compact',
    comfortable: 'Comfortable',
    columns: 'Columns',
    chooseColumns: 'Choose columns',
    views: 'Views',
    savedViews: 'Saved views',
    defaultView: 'Default view',
    nothingToShow: 'Nothing to show',
    noRowsMatch: 'No rows match',
    noneMatch: (total) => `None of the ${total.toLocaleString('en-IN')} ${total === 1 ? 'row matches' : 'rows match'} your filters`,
    quickNoMatch: (query) => `Nothing matches “${query}” with the current filters`,
    clearFilters: 'Clear filters',
    clearAll: 'Clear all',
    activeFilters: 'Active filters',
    removeFilter: (what) => `Remove filter: ${what}`,
    filterColumn: (label, filtered) => `Filter ${label}${filtered ? ' (filtered)' : ''}`
  }
}

const KitLabelsContext = createContext<KitLabels>(ENGLISH_KIT_LABELS)

/** Provides the kit's words for a subtree (the simple shell, the setup wizard). */
export const KitLabelsProvider = KitLabelsContext.Provider

/** The kit's words in effect here — English unless a simple-mode provider is above. */
export function useKitLabels(): KitLabels {
  return useContext(KitLabelsContext)
}
