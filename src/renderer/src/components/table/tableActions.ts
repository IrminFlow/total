/**
 * Live actions of each mounted DataTable, by its testId area — how a screen's Options drawer
 * offers "Choose columns…" and PDF/CSV export for the screen's main table without owning the
 * table's state. DataTable registers on mount and unregisters on unmount.
 */
export interface TableActions {
  openColumns: () => void
  exportPdf?: () => void
  exportCsv?: () => void
  exportXlsx?: () => void
}

const registry = new Map<string, TableActions>()

export function registerTableActions(area: string, actions: TableActions): () => void {
  registry.set(area, actions)
  return () => {
    if (registry.get(area) === actions) registry.delete(area)
  }
}

export function tableActions(area: string): TableActions | undefined {
  return registry.get(area)
}
