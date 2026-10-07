// Shared pieces of the quotation / order screens (WP 2.5c): the derived-status badge, and the
// document actions every surface offers (list row menu, entry form footer) — convert, close,
// cancel, reopen, duplicate, print, bin / restore.
import { useQueryClient } from '@tanstack/react-query'
import type { TradeDocKind, VoucherKind } from '@shared/domain'
import type { TradeDocStatus } from '@shared/tradeCycle/fulfilment'
import { TRADE_DOC_TITLES, tradeStatusLabel } from '@shared/tradeCycle/edit'
import { api } from '../../lib/client'
import { confirmDialog, promptDialog } from '../../lib/dialogs'
import { nextDraftId, useNav, useToasts } from '../../state/stores'
import { Badge } from '../../components/ui'
import type { BadgeTone } from '../../components/kit/Badge'
import type { MenuItem } from '../../components/kit/Menu'

const TONE: Record<TradeDocStatus, BadgeTone> = {
  open: 'info',
  expired: 'warning',
  partly_fulfilled: 'amber',
  fulfilled: 'success',
  closed: 'neutral',
  cancelled: 'danger'
}

export function TradeStatusBadge({ kind, status, binned }: { kind: TradeDocKind; status: TradeDocStatus; binned?: boolean }): React.JSX.Element {
  if (binned) return <Badge tone="neutral" testId="trade-doc-status" className="line-through">In the bin</Badge>
  return (
    <Badge tone={TONE[status]} testId="trade-doc-status">
      {tradeStatusLabel(kind, status)}
    </Badge>
  )
}

export const LIST_SCREEN: Record<TradeDocKind, 'quotations' | 'sales-orders' | 'purchase-orders'> = {
  quotation: 'quotations',
  sales_order: 'sales-orders',
  purchase_order: 'purchase-orders'
}

/** Where a document converts to: trade-doc targets open the order form, voucher targets the
 *  voucher form pre-filled with every pending line ("Add from…" picks). */
export const CONVERSIONS: Record<TradeDocKind, { to: TradeDocKind | VoucherKind; label: string }[]> = {
  quotation: [
    { to: 'sales_order', label: 'Convert to sales order' },
    { to: 'sales', label: 'Convert to invoice' }
  ],
  sales_order: [
    { to: 'delivery_note', label: 'Convert to delivery challan' },
    { to: 'sales', label: 'Convert to invoice' }
  ],
  purchase_order: [
    { to: 'receipt_note', label: 'Convert to goods receipt' },
    { to: 'purchase', label: 'Convert to bill' }
  ]
}

export interface ActionDoc {
  id: number
  kind: TradeDocKind
  number: string
  partyLedgerId: number
  /** Derived status. */
  status: TradeDocStatus
  binned: boolean
}

/** The actions on one document. `onDone` runs after a state change (refresh / leave). */
export function useTradeDocActions(onDone?: (what: 'deleted' | 'changed') => void): {
  convert: (d: ActionDoc, to: TradeDocKind | VoucherKind) => Promise<void>
  menu: (d: ActionDoc, opts?: { canWrite: boolean; open?: boolean }) => MenuItem[]
  print: (id: number) => Promise<void>
} {
  const nav = useNav()
  const toast = useToasts()
  const qc = useQueryClient()
  const name = (d: ActionDoc): string => `${TRADE_DOC_TITLES[d.kind]} ${d.number}`

  const run = async (fn: () => Promise<unknown>, done: string, what: 'deleted' | 'changed' = 'changed'): Promise<void> => {
    try {
      await fn()
      toast.push('success', done)
      await qc.invalidateQueries()
      onDone?.(what)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const convert = async (d: ActionDoc, to: TradeDocKind | VoucherKind): Promise<void> => {
    try {
      if (to === 'quotation' || to === 'sales_order' || to === 'purchase_order') {
        const draft = await api.tradeDocs.convert(d.id, to)
        nav.go({ name: 'trade-doc', kind: to, draft, draftId: nextDraftId() })
        return
      }
      nav.go({ name: 'voucher-entry', kindHint: to, draft: { partyLedgerId: d.partyLedgerId, fromTradeDocId: d.id }, draftId: nextDraftId() })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const print = async (id: number): Promise<void> => {
    try {
      await api.tradeDocs.pdf(id)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const menu = (d: ActionDoc, opts: { canWrite: boolean; open?: boolean } = { canWrite: true }): MenuItem[] => {
    const items: MenuItem[] = []
    const live = !d.binned && d.status !== 'cancelled' && d.status !== 'closed'
    if (opts.open !== false) items.push({ label: 'Open', onSelect: () => nav.go({ name: 'trade-doc', kind: d.kind, id: d.id }), testId: 'trade-doc-action-open' })
    if (opts.canWrite && live && d.status !== 'fulfilled') {
      for (const c of CONVERSIONS[d.kind]) {
        items.push({ label: c.label, onSelect: () => void convert(d, c.to), testId: `trade-doc-action-convert-${c.to}` })
      }
    }
    if (!d.binned) items.push({ label: 'Print / PDF', onSelect: () => void print(d.id), testId: 'trade-doc-action-pdf' })
    if (!opts.canWrite) return items
    items.push({
      label: 'Duplicate',
      testId: 'trade-doc-action-duplicate',
      onSelect: () =>
        void api.tradeDocs
          .duplicate(d.id)
          .then((draft) => nav.go({ name: 'trade-doc', kind: d.kind, draft, draftId: nextDraftId() }))
          .catch((err: Error) => toast.push('error', err.message))
    })
    if (d.binned) {
      items.push({ label: 'Restore from bin', testId: 'trade-doc-action-restore', onSelect: () => void run(() => api.tradeDocs.restore(d.id), `${name(d)} restored`) })
      return items
    }
    if (live && d.status !== 'fulfilled') {
      items.push({
        label: d.kind === 'quotation' ? 'Mark lost / close…' : 'Short-close…',
        testId: 'trade-doc-action-close',
        onSelect: async () => {
          const reason = await promptDialog({
            title: d.kind === 'quotation' ? `Close ${name(d)}` : `Short-close ${name(d)}`,
            message: d.kind === 'quotation'
              ? 'Nothing more can be converted from it. Converted lines keep their links.'
              : 'The rest of its quantity stops being pending; what was delivered keeps its links.',
            placeholder: 'Reason (optional)',
            confirmLabel: 'Close'
          })
          if (reason === null) return
          await run(() => api.tradeDocs.close(d.id, reason.trim() || null), `${name(d)} closed`)
        }
      })
    }
    if (d.status === 'closed' || d.status === 'cancelled') {
      items.push({ label: 'Reopen', testId: 'trade-doc-action-reopen', onSelect: () => void run(() => api.tradeDocs.reopen(d.id), `${name(d)} reopened`) })
    }
    // Cancelling needs nothing drawn on it (the server checks; partly / fully fulfilled never can).
    if (d.status === 'open' || d.status === 'expired' || d.status === 'closed') {
      items.push({
        label: 'Cancel…',
        danger: true,
        testId: 'trade-doc-action-cancel',
        onSelect: async () => {
          const reason = await promptDialog({
            title: `Cancel ${name(d)}`,
            message: 'Only a document nothing has been drawn from can be cancelled — short-close it otherwise.',
            placeholder: 'Reason (optional)',
            confirmLabel: 'Cancel document'
          })
          if (reason === null) return
          await run(() => api.tradeDocs.cancel(d.id, reason.trim() || null), `${name(d)} cancelled`)
        }
      })
    }
    items.push({
      label: 'Move to bin',
      danger: true,
      testId: 'trade-doc-action-delete',
      onSelect: async () => {
        const ok = await confirmDialog({
          title: 'Move to Bin',
          message: `Move ${name(d)} to the bin? It stays restorable from this list ("In the bin").`,
          confirmLabel: 'Move to Bin',
          danger: true
        })
        if (ok) await run(() => api.tradeDocs.remove(d.id), `${name(d)} moved to the bin`, 'deleted')
      }
    })
    return items
  }

  return { convert, menu, print }
}
