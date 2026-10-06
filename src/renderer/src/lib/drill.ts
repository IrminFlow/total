// Drill-down actions shared by every report and list (WP 1.8). A ledger NAME opens the ledger's
// edit window; the rest of its row opens the ledger statement. The edit and item windows are
// hosted once, globally (components/DrillHost.tsx), and opened through this store, so a table of
// 10,000 rows never mounts 10,000 modals.
import { create } from 'zustand'
import { useNav, useSession } from '../state/stores'

interface DrillState {
  /** Ledger whose edit window is open, or null. */
  ledgerEditId: number | null
  /** Stock item whose editor is open, or null. */
  itemEditId: number | null
  setLedgerEdit: (id: number | null) => void
  setItemEdit: (id: number | null) => void
}

export const useDrill = create<DrillState>((set) => ({
  ledgerEditId: null,
  itemEditId: null,
  setLedgerEdit: (ledgerEditId) => set({ ledgerEditId }),
  setItemEdit: (itemEditId) => set({ itemEditId })
}))

/** Masters can only be changed by owners and accountants. With no users set up (`user` null)
 *  nothing is role-gated, same as main's `handle()` gate. */
export function canEditMasters(): boolean {
  const user = useSession.getState().user
  return user == null || user.role !== 'viewer'
}

/** Hook form of {@link canEditMasters}, re-rendering when the signed-in user changes. */
export function useCanEditMasters(): boolean {
  return useSession((s) => s.user == null || s.user.role !== 'viewer')
}

/** Synthetic rows (computed balances, totals) carry ids <= 0 and never drill. */
export const isRealId = (id: number | null | undefined): id is number => typeof id === 'number' && id > 0

export function openLedgerStatement(ledgerId: number): void {
  if (!isRealId(ledgerId)) return
  const nav = useNav.getState()
  const top = nav.stack[nav.stack.length - 1]
  if (top?.name === 'ledger-statement' && top.ledgerId === ledgerId) return // already there
  nav.go({ name: 'ledger-statement', ledgerId })
}

/** Opens the ledger edit window — or, for a read-only (viewer) user, who could never save it,
 *  the ledger's statement instead. */
export function openLedgerEdit(ledgerId: number): void {
  if (!isRealId(ledgerId)) return
  if (!canEditMasters()) return openLedgerStatement(ledgerId)
  useDrill.getState().setLedgerEdit(ledgerId)
}

/** Opens the stock item editor. Read-only users have no item editor (see ItemLink). */
export function openItemEdit(itemId: number): void {
  if (!isRealId(itemId) || !canEditMasters()) return
  useDrill.getState().setItemEdit(itemId)
}

export function openVoucher(voucherId: number): void {
  if (!isRealId(voucherId)) return
  useNav.getState().go({ name: 'voucher-entry', voucherId })
}

/** ⌘E (Ctrl+E off macOS) on a list: the ledger of the row the user is on. Screen-agnostic — it
 *  reads the DOM rather than any one table's state:
 *  1. the row (`tr` or a `[data-drill-row]` list row) holding keyboard focus, else
 *  2. the active (amber-bar) DataTable row of the table the user last pointed at or tabbed into,
 *     else the last active row in the document (overlays render after the screen).
 *  The ledger is the row's first LedgerLink (`[data-ledger-link]`), or the row's own
 *  `data-drill-ledger` when it has no link. Returns null when the row has no ledger. */
export function ledgerForShortcut(doc: Document, lastTable: Element | null): number | null {
  const fromRow = (row: Element | null): number | null => {
    if (!row) return null
    const own = row.getAttribute('data-drill-ledger')
    const link = row.querySelector('[data-ledger-link]')?.getAttribute('data-ledger-link') ?? null
    const id = Number(link ?? own)
    return isRealId(id) ? id : null
  }
  const focused = doc.activeElement
  if (focused && focused !== doc.body) {
    const direct = focused.getAttribute('data-ledger-link')
    if (direct && isRealId(Number(direct))) return Number(direct)
    const row = focused.closest('[data-drill-row], tr.dt-row')
    if (row) return fromRow(row)
  }
  const ACTIVE = 'tr.dt-row[data-active="true"]'
  if (lastTable && lastTable.isConnected) {
    const id = fromRow(lastTable.querySelector(ACTIVE))
    if (id != null) return id
  }
  const all = Array.from(doc.querySelectorAll(ACTIVE))
  for (let i = all.length - 1; i >= 0; i--) {
    const id = fromRow(all[i]!)
    if (id != null) return id
  }
  return null
}
