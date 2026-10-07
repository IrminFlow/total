import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { api, type ManufactureRegisterRow } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Money, Page, PageHeader, Panel } from '../components/ui'
import { OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { ItemLink } from '../components/links'

// Manufacture register (WP 2.2): one row per live manufacture voucher in the period with the
// entry facts from manufacture_details — production cost (materials at save-time engine cost +
// labour), sale value and profit — with totals. Binned vouchers are excluded server-side.

const perItemQty = { decimals: (r: ManufactureRegisterRow) => r.decimals, unit: (r: ManufactureRegisterRow) => r.unitSymbol }

export const MANUFACTURE_REGISTER_COLUMNS = defineColumns<ManufactureRegisterRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted', hideable: false, width: 110 },
  { id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, className: 'num text-muted', width: 100, groupable: false },
  {
    id: 'item',
    header: 'Item',
    kind: 'text',
    value: (r) => r.itemName,
    minWidth: 160,
    cell: (r) => <ItemLink itemId={r.finishedItemId} name={r.itemName} />
  },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qtyMilli, ...perItemQty, width: 110 },
  { id: 'productionCost', header: 'Production cost', kind: 'money', value: (r) => r.productionCost, aggregate: 'sum', width: 150 },
  { id: 'saleAmount', header: 'Sale value', kind: 'money', value: (r) => r.saleAmount, aggregate: 'sum', width: 150 },
  {
    id: 'profit',
    header: 'Profit',
    kind: 'money',
    value: (r) => r.profitPaise,
    aggregate: 'sum',
    width: 150,
    cell: (r) => <Money paise={r.profitPaise} className={r.profitPaise < 0 ? 'text-danger' : ''} />
  }
])

export function ManufactureRegisterScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const opts = useScreenOptions('manufacture-register', {})
  const { data, isLoading } = useQuery({ queryKey: ['manufactureRegister', from, to], queryFn: () => api.manufacture.register(from, to) })
  const periodLabel = `${toDisplayDate(from)} – ${toDisplayDate(to)}`
  return (
    <Page width="wide">
      <PageHeader
        title="Manufacture register"
        period={periodLabel}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod />
              <OptionsTable area="manufacture-register" />
            </>
          )
        }}
      />
      <Panel>
        <DataTable
          viewId="manufacture-register"
          testId="manufacture-register"
          ariaLabel="Manufacture register"
          columns={MANUFACTURE_REGISTER_COLUMNS}
          rows={data ?? []}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
          loading={isLoading}
          empty={{ title: 'No manufactures in this period', hint: 'Sidebar → Manufacture, or Alt+F7' }}
          onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
          maxHeight="calc(100vh - 240px)"
          exportOptions={{ title: 'Manufacture register', periodLabel, filename: 'manufacture-register' }}
        />
      </Panel>
    </Page>
  )
}
