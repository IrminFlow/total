// Stock lines an accounting-mode alteration carries (WP 2.3): item, direction, qty and amount
// stay exactly as saved (the ledger lines are what this form edits), while each line's godown,
// batch and serial numbers can be picked in its detail row — the same expander every other
// voucher mode uses.
import { Fragment } from 'react'
import type { InventoryPayload } from '@shared/voucherEdit'
import { Money } from '../../components/ui'
import { useStockItems } from '../../components/pickers'
import { LineDetailToggle, LineStockDetail, LineStockSummary, useLineDetails } from './LineStockDetail'

export function CarriedStockLines({
  lines,
  onChange,
  voucherId
}: {
  lines: readonly InventoryPayload[]
  onChange: (index: number, patch: Partial<InventoryPayload>) => void
  voucherId?: number
}): React.JSX.Element {
  const items = useStockItems()
  const details = useLineDetails()
  return (
    <div className="mt-3" data-testid="carried-stock-lines">
      <p className="mb-1 text-small text-muted">
        Stock lines on this voucher — quantities and amounts are kept as saved; godown, batch and serials can be changed.
      </p>
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="w-16">In / Out</th>
            <th className="r w-24">Qty</th>
            <th className="r w-32">Amount</th>
            <th className="w-48">Godown · batch · serials</th>
            <th className="w-6"><span className="sr-only">Stock details</span></th>
          </tr>
        </thead>
        <tbody data-testid="rows-carried-stock">
          {lines.map((l, i) => {
            const found = items.find((it) => it.id === l.stockItemId)
            const item = found && l.isAbsolute ? { ...found, trackSerials: false } : found
            const fields = { godownId: l.godownId ?? null, batchId: l.batchId ?? null, serials: l.serials }
            const open = details.isOpen(i, item)
            return (
              <Fragment key={i}>
                <tr onKeyDown={details.onRowKeyDown(i)}>
                  <td className="text-body-sm">{found?.name ?? `Item #${l.stockItemId}`}</td>
                  <td className={`text-small ${l.direction === 'in' ? 'text-dr' : 'text-cr'}`}>{l.isAbsolute ? 'Count' : l.direction === 'in' ? 'In' : 'Out'}</td>
                  <td className="r num text-body-sm">{l.qtyMilli / 1000}</td>
                  <td className="r"><Money paise={l.amount} /></td>
                  <td>{!open && <LineStockSummary fields={fields} />}</td>
                  <td>
                    <LineDetailToggle open={open} onToggle={() => details.toggle(i)} fields={fields} disabled={!item} />
                  </td>
                </tr>
                {open && item && (
                  <tr data-testid="row-line-detail">
                    <td colSpan={6} className="!pt-0">
                      <LineStockDetail
                        item={item}
                        direction={l.direction}
                        qtyMilli={l.qtyMilli}
                        fields={fields}
                        onChange={(patch) => onChange(i, patch)}
                        voucherId={voucherId}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
