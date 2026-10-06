// The one global host for drill-down windows (WP 1.8): the ledger edit window and the stock item
// editor, opened from any screen through lib/drill.ts, plus the ⌘E "edit this row's ledger"
// shortcut. Mounted once in App (unlocked layout), never per row.
import { useEffect, useRef } from 'react'
import { useDrill, ledgerForShortcut, openLedgerEdit, openLedgerStatement } from '../lib/drill'
import { useSession } from '../state/stores'
import { LedgerFormModal } from './LedgerFormModal'
import { ItemFormModal } from '../screens/Masters'
import { useStockItems } from './pickers'
import { Modal, isAnyModalOpen } from './ui'

export function DrillHost(): React.JSX.Element {
  const ledgerEditId = useDrill((s) => s.ledgerEditId)
  const itemEditId = useDrill((s) => s.itemEditId)
  const setLedgerEdit = useDrill((s) => s.setLedgerEdit)
  const setItemEdit = useDrill((s) => s.setItemEdit)
  const slug = useSession((s) => s.slug)

  // Switching (or closing) the company drops whatever was open for the old one.
  useEffect(() => {
    setLedgerEdit(null)
    setItemEdit(null)
  }, [slug, setLedgerEdit, setItemEdit])

  useEditShortcut()

  return (
    <>
      {ledgerEditId != null && (
        <LedgerFormModal
          key={`l${ledgerEditId}`}
          ledgerId={ledgerEditId}
          onClose={() => setLedgerEdit(null)}
          // From any edit window, one click on to the ledger's statement (Day Book, Outstandings…
          // rows open something else, so this is their path to it).
          onOpenStatement={(id) => {
            setLedgerEdit(null)
            openLedgerStatement(id)
          }}
        />
      )}
      {itemEditId != null && <ItemById key={`i${itemEditId}`} itemId={itemEditId} onClose={() => setItemEdit(null)} />}
    </>
  )
}

function ItemById({ itemId, onClose }: { itemId: number; onClose: () => void }): React.JSX.Element {
  const items = useStockItems()
  const item = items.find((i) => i.id === itemId)
  if (item) return <ItemFormModal item={item} onClose={onClose} />
  return (
    <Modal title="Edit item" onClose={onClose}>
      <p className="text-[13px] text-muted">{items.length ? 'Item not found — it may have been deleted.' : 'Loading item…'}</p>
    </Modal>
  )
}

/** ⌘E / Ctrl+E: open the edit window for the ledger of the row the user is on. */
function useEditShortcut(): void {
  const lastTable = useRef<Element | null>(null)
  useEffect(() => {
    const claim = (e: Event): void => {
      const t = e.target
      if (t instanceof Element) {
        const table = t.closest('.data-table-wrap')
        if (table) lastTable.current = table
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'e') return
      if (isAnyModalOpen()) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const id = ledgerForShortcut(document, lastTable.current)
      if (id == null) return
      e.preventDefault()
      openLedgerEdit(id)
    }
    window.addEventListener('pointerdown', claim, true)
    window.addEventListener('focusin', claim, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', claim, true)
      window.removeEventListener('focusin', claim, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}
