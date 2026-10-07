// "Add from…" drawer (WP 2.5b, design §5.2). Lists a party's open source lines for the invoice
// being entered — challan lines for a sales invoice, GRN lines for a purchase bill, invoice /
// bill lines for a credit / debit note — with what is still pending. Tick lines, adjust the
// quantity (defaults to pending, capped at pending), Insert: the form appends rows that carry
// their `source`, and the save links them (services/tradeLinks.ts).
import { useMemo, useState } from 'react'
import type { OpenSourceLine } from '@shared/tradeCycle/types'
import { formatQtyMilli } from '@shared/money'
import type { SourcePick } from '@shared/voucherEdit'
import { Button, Drawer } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { ItemLink, VoucherLink } from '../../components/links'
import { useStockItems } from '../../components/pickers'

export function AddFromDrawer({
  title,
  lines,
  loading,
  onClose,
  onInsert
}: {
  title: string
  /** Open lines with pending > 0 — already net of what this form holds. */
  lines: OpenSourceLine[]
  loading?: boolean
  onClose: () => void
  onInsert: (picks: SourcePick[]) => void
}): React.JSX.Element {
  const items = useStockItems()
  const itemName = useMemo(() => new Map(items.map((i) => [i.id, i.name])), [items])
  // Picked lines → the quantity text being typed (units).
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(() => new Map())

  const toggle = (l: OpenSourceLine, on: boolean): void =>
    setPicked((m) => {
      const next = new Map(m)
      if (on) next.set(l.lineUid, String(l.pendingMilli / 1000))
      else next.delete(l.lineUid)
      return next
    })
  const setQty = (l: OpenSourceLine, text: string): void =>
    setPicked((m) => {
      const q = Math.round(parseFloat(text || '0') * 1000)
      // Capped at pending (I1): more than that is a separate, unlinked line.
      return new Map(m).set(l.lineUid, Number.isFinite(q) && q > l.pendingMilli ? String(l.pendingMilli / 1000) : text)
    })

  const columns = useMemo(
    () =>
      defineColumns<OpenSourceLine>([
        {
          id: 'doc', header: 'Document', kind: 'text', value: (r) => r.label, minWidth: 150, hideable: false,
          cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.label} />
        },
        { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
        {
          id: 'item', header: 'Item', kind: 'text', value: (r) => itemName.get(r.stockItemId) ?? '', minWidth: 120,
          cell: (r) => <ItemLink itemId={r.stockItemId} name={itemName.get(r.stockItemId) ?? `#${r.stockItemId}`} />
        },
        { id: 'qty', header: 'On doc.', kind: 'quantity', value: (r) => r.qtyMilli, width: 84 },
        { id: 'done', header: 'Done', kind: 'quantity', value: (r) => r.doneMilli, width: 76, defaultHidden: false },
        { id: 'pending', header: 'Pending', kind: 'quantity', value: (r) => r.pendingMilli, width: 84 },
        { id: 'rate', header: 'Rate', kind: 'money', value: (r) => r.ratePaise, width: 110 },
        {
          id: 'serials', header: 'Serials', kind: 'text', value: (r) => r.serials.join(', '), defaultHidden: r0(lines),
          width: 120
        },
        {
          id: 'take', header: 'Take', kind: 'quantity', value: (r) => (picked.has(r.lineUid) ? Math.round(parseFloat(picked.get(r.lineUid) || '0') * 1000) : null),
          width: 96, sortable: false, filterable: false, hideable: false,
          cell: (r) =>
            picked.has(r.lineUid) ? (
              <input
                className="w-full rounded border border-line bg-panel px-1.5 py-0.5 text-right num"
                data-testid="input-add-from-qty"
                aria-label={`Quantity from ${r.label}`}
                value={picked.get(r.lineUid)}
                inputMode="decimal"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => setQty(r, e.target.value)}
              />
            ) : (
              <span className="text-muted">—</span>
            )
        }
      ]),
    [itemName, picked, lines]
  )

  const picks: SourcePick[] = lines
    .filter((l) => picked.has(l.lineUid))
    .map((l) => ({ line: l, qtyMilli: Math.min(l.pendingMilli, Math.round(parseFloat(picked.get(l.lineUid) || '0') * 1000)) }))
    .filter((p) => Number.isFinite(p.qtyMilli) && p.qtyMilli > 0)

  return (
    <Drawer
      title={title}
      subtitle="Tick the lines to draw on; the quantity defaults to what is still pending."
      onClose={onClose}
      width={860}
      testId="drawer-add-from"
      footer={
        <>
          <span className="mr-auto text-hint text-muted">
            {picks.length} line{picks.length === 1 ? '' : 's'} · {formatQtyMilli(picks.reduce((s, p) => s + p.qtyMilli, 0))} units
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={picks.length === 0} data-testid="btn-add-from-insert" onClick={() => onInsert(picks)}>
            Insert lines
          </Button>
        </>
      }
    >
      <DataTable
        testId="add-from"
        columns={columns}
        rows={lines}
        rowKey={(r) => r.lineUid}
        rowAttrs={(r) => ({ 'data-line-uid': r.lineUid })}
        loading={loading}
        maxHeight="calc(100vh - 220px)"
        empty={{ title: 'Nothing pending for this party', hint: 'Every line is already drawn on, or there are no documents yet.' }}
        onRowActivate={(r) => toggle(r, !picked.has(r.lineUid))}
        leadingWidth={32}
        leading={(r) => (
          <input
            type="checkbox"
            aria-label={`Take ${r.label}`}
            data-testid="input-add-from-pick"
            checked={picked.has(r.lineUid)}
            onChange={(e) => toggle(r, e.target.checked)}
          />
        )}
      />
    </Drawer>
  )
}

/** Hide the serials column when no line has any. */
function r0(lines: OpenSourceLine[]): boolean {
  return !lines.some((l) => l.serials.length > 0)
}
