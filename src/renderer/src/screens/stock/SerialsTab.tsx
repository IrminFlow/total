import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type SerialRecordRow } from '../../lib/client'
import { useNav } from '../../state/stores'
import {
  EmptyState,
  Money,
  Panel,
  RowLink,
  Select,
  SkeletonRows,
  TextInput,
  useTableNav
} from '../../components/ui'
import { useStockItems } from '../../components/pickers'
import { toDisplayDate } from '@shared/dates'

/**
 * The serial register (roadmap E #115).
 *
 * The screen a warranty claim is answered from: which unit, where is it now, and what did it do.
 * The search box takes a partial number because the way this screen is actually reached is a
 * customer reading four digits off a sticker over the phone.
 */
export function SerialsTab(): React.JSX.Element {
  const nav = useNav()
  const items = useStockItems()
  const [stockItemId, setStockItemId] = useState<number | null>(null)
  const [status, setStatus] = useState<'all' | 'in_stock' | 'issued'>('all')
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['serials', stockItemId, status, search],
    queryFn: () => api.serials.list({ stockItemId, status, search: search.trim() || null })
  })
  const rows = data ?? []
  const tracked = items.filter((i) => i.trackSerials)

  const toggle = (r: SerialRecordRow): void => setOpenId((cur) => (cur === r.id ? null : r.id))
  const kbd = useTableNav(rows, { rowId: (r) => r.id, onEnter: toggle, onToggle: toggle })

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TextInput
          data-testid="input-serial-search"
          aria-label="Search serial numbers"
          placeholder="Serial number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-56"
        />
        <Select
          data-testid="select-serial-item"
          aria-label="Stock item"
          value={stockItemId ?? ''}
          onChange={(e) => setStockItemId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All items</option>
          {tracked.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
        <Select
          data-testid="select-serial-status"
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as 'all' | 'in_stock' | 'issued')}
        >
          <option value="all">In stock and issued</option>
          <option value="in_stock">In stock</option>
          <option value="issued">Issued</option>
        </Select>
      </div>

      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No serial numbers yet"
            hint={
              tracked.length === 0
                ? 'Tick "Track serial numbers" on an item under Masters → Stock items, then enter its serials on the purchase'
                : 'They appear here as soon as a voucher moves a serial-tracked item'
            }
          />
        ) : (
          <table className="ledger-table" data-testid="rows-serials">
            <thead>
              <tr>
                <th scope="col">Serial</th>
                <th scope="col">Item</th>
                <th scope="col">Where</th>
                <th scope="col">Last movement</th>
                <th scope="col">Party</th>
                <th scope="col" className="r w-32">Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} {...kbd.rowProps(i, r)} aria-expanded={openId === r.id}>
                  <td className="num">
                    <span className="mr-1.5 inline-block w-3 text-label text-muted">{openId === r.id ? '▾' : '▸'}</span>
                    {r.serial}
                  </td>
                  <td>{r.itemName}</td>
                  <td>
                    <span className={r.status === 'in_stock' ? 'text-dr' : 'text-muted'}>
                      {r.status === 'in_stock' ? 'In stock' : 'Issued'}
                    </span>
                  </td>
                  <td className="num text-muted">
                    {toDisplayDate(r.lastMovedOn)} · {r.lastVoucherType} {r.lastVoucherNumber}
                  </td>
                  <td className="text-muted">{r.partyName ?? '—'}</td>
                  <td className="r">
                    <Money paise={r.ratePaise} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {openId !== null && <SerialHistory serialId={openId} onOpenVoucher={(id) => nav.go({ name: 'voucher-entry', voucherId: id })} />}
    </>
  )
}

/** Everything that ever happened to one unit, oldest first — bought here, sold there. */
function SerialHistory({
  serialId,
  onOpenVoucher
}: {
  serialId: number
  onOpenVoucher: (voucherId: number) => void
}): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['serialHistory', serialId], queryFn: () => api.serials.history(serialId) })
  return (
    <Panel className="mt-3">
      <h3 className="mb-2 text-body font-medium">History</h3>
      {!data?.length ? (
        <p className="text-hint text-muted">Nothing recorded.</p>
      ) : (
        <table className="ledger-table" data-testid="rows-serial-history">
          <thead>
            <tr>
              <th scope="col" className="w-32">Date</th>
              <th scope="col" className="w-24">Direction</th>
              <th scope="col">Voucher</th>
              <th scope="col">Party</th>
              <th scope="col">Godown</th>
              <th scope="col" className="r w-32">Rate</th>
            </tr>
          </thead>
          <tbody>
            {data.map((h, i) => (
              <tr key={i}>
                <td className="num">{toDisplayDate(h.movedOn)}</td>
                <td className={h.direction === 'in' ? 'text-dr' : 'text-muted'}>{h.direction === 'in' ? 'Received' : 'Issued'}</td>
                <td>
                  <RowLink
                    className="px-0"
                    data-testid={`btn-serial-voucher-${h.voucherId}`}
                    onClick={() => onOpenVoucher(h.voucherId)}
                  >
                    {h.voucherType} {h.voucherNumber}
                  </RowLink>
                </td>
                <td className="text-muted">{h.partyName ?? '—'}</td>
                <td className="text-muted">{h.godownName ?? '—'}</td>
                <td className="r">
                  <Money paise={h.ratePaise} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}
