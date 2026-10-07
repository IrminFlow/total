import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { api, type ManufactureRegisterRow } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Badge, Button, DrawerSection, Money, Page, PageHeader, Panel } from '../components/ui'
import { OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { ItemLink } from '../components/links'

// Manufacture register (WP 2.2; WP 2.4 live re-pricing): one row per live manufacture voucher in
// the period. "Cost now" is the engine's CURRENT production cost (materials re-derived at every
// valuation + labour − by-products), so a backdated purchase re-prices it; "Cost at save" is the
// figure the voucher was saved with. Profit = saved sale value − cost now. Binned vouchers are
// excluded server-side.

const perItemQty = { decimals: (r: ManufactureRegisterRow) => r.decimals, unit: (r: ManufactureRegisterRow) => r.unitSymbol }

export const MANUFACTURE_REGISTER_COLUMNS = defineColumns<ManufactureRegisterRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted', hideable: false, width: 104 },
  { id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, className: 'num text-muted', width: 80, groupable: false },
  {
    id: 'item',
    header: 'Item',
    kind: 'text',
    value: (r) => r.itemName,
    minWidth: 140,
    cell: (r) => (
      <span className="inline-flex items-center gap-2">
        <ItemLink itemId={r.finishedItemId} name={r.itemName} />
        {r.jobWork && <Badge tone="info">job work</Badge>}
      </span>
    )
  },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qtyMilli, ...perItemQty, width: 96 },
  { id: 'materials', header: 'Materials', kind: 'money', value: (r) => r.materialPaise, aggregate: 'sum', width: 130, defaultHidden: true },
  { id: 'labour', header: 'Labour / job charges', kind: 'money', value: (r) => r.labourPaise, aggregate: 'sum', width: 150, defaultHidden: true },
  { id: 'byProducts', header: 'By-products', kind: 'money', value: (r) => r.byProductPaise, aggregate: 'sum', width: 118 },
  {
    id: 'costAtSave',
    header: 'Cost at save',
    kind: 'money',
    value: (r) => r.costAtSave,
    aggregate: 'sum',
    width: 126,
    cell: (r) => <Money paise={r.costAtSave} className={r.repriced ? 'text-muted line-through decoration-1' : 'text-muted'} />
  },
  {
    id: 'productionCost',
    header: 'Cost now',
    kind: 'money',
    value: (r) => r.productionCost,
    aggregate: 'sum',
    width: 196,
    cell: (r) => (
      <span className="inline-flex items-center gap-1.5" data-testid="register-cost-now" data-repriced={r.repriced ? 'true' : 'false'}>
        {r.repriced && <Badge tone="warning" title={`Saved at ${r.costAtSave / 100}; re-priced by later entries`}>re-priced</Badge>}
        <Money paise={r.productionCost} />
      </span>
    )
  },
  { id: 'saleAmount', header: 'Sale value', kind: 'money', value: (r) => r.saleAmount, aggregate: 'sum', width: 126 },
  {
    id: 'profit',
    header: 'Profit',
    kind: 'money',
    value: (r) => r.profitPaise,
    aggregate: 'sum',
    width: 126,
    cell: (r) => <Money paise={r.profitPaise} className={r.profitPaise < 0 ? 'text-danger' : ''} />
  },
  { id: 'profitAtSave', header: 'Profit at save', kind: 'money', value: (r) => r.profitAtSave, aggregate: 'sum', width: 140, defaultHidden: true }
])

export function ManufactureRegisterScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const opts = useScreenOptions('manufacture-register', {})
  const { data, isLoading } = useQuery({ queryKey: ['manufactureRegister', from, to], queryFn: () => api.manufacture.register(from, to) })
  const periodLabel = `${toDisplayDate(from)} – ${toDisplayDate(to)}`
  const repriced = (data ?? []).filter((r) => r.repriced).length
  const report = (tab: 'production' | 'cost-sheet' | 'margin' | 'variance' | 'job-work', label: string): React.JSX.Element => (
    <Button size="sm" variant="ghost" data-testid={`btn-register-${tab}`} onClick={() => nav.go({ name: 'manufacture-reports', tab })}>
      {label}
    </Button>
  )
  return (
    <Page width="wide">
      <PageHeader
        title="Manufacture register"
        period={periodLabel}
        secondary={
          <div className="flex items-center gap-1">
            {report('production', 'Production register')}
            {report('cost-sheet', 'Cost sheet')}
            {report('margin', 'Margin')}
            {report('variance', 'Variance')}
            {report('job-work', 'At job workers')}
          </div>
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod />
              <DrawerSection title="Job work">
                <div className="flex flex-col items-start gap-2">
                  <Button data-testid="btn-register-send-job-work" onClick={() => nav.go({ name: 'stock-journal', mode: 'jobWork' })}>
                    Send material to a job worker
                  </Button>
                  <Button data-testid="btn-register-receive-job-work" onClick={() => nav.go({ name: 'manufacture', jobWork: true })}>
                    Receive finished goods from a job worker
                  </Button>
                </div>
              </DrawerSection>
              <OptionsTable area="manufacture-register" />
            </>
          )
        }}
      />
      {repriced > 0 && (
        <p className="mb-2 text-hint text-muted" data-testid="register-repriced-note">
          {repriced} manufacture{repriced > 1 ? 's were' : ' was'} re-priced by entries saved later (e.g. a backdated purchase) — “Cost now” is what the
          books carry; profit uses it.
        </p>
      )}
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
