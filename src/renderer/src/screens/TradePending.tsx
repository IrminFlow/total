// Pending challans / pending GRNs (WP 2.5b, design §5.3): delivery challan lines not yet
// invoiced ("goods delivered, not invoiced") and GRN lines not yet billed ("received, not
// billed"), with ageing and the pending value, as on the period end. One screen, two tabs.
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { purposeLabel, STOCK_NOTE_PURPOSES } from '@shared/voucherEdit'
import type { PendingNoteRow } from '@shared/tradeCycle/types'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Button, DrawerSection, Page, PageHeader, Panel } from '../components/ui'
import { OptionsPeriod, OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { ItemLink, LedgerLink, VoucherLink } from '../components/links'
import { TabBar } from '../components/TabBar'

export type PendingStage = 'delivery_note' | 'receipt_note'

const AGE_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const
const bucketOf = (days: number): string => AGE_BUCKETS[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3]!

function columnsFor(stage: PendingStage) {
  return defineColumns<PendingNoteRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
    {
      id: 'number', header: stage === 'delivery_note' ? 'Challan' : 'GRN', kind: 'text', value: (r) => r.number, width: 96, hideable: false,
      cell: (r) => <VoucherLink voucherId={r.voucherId} label={<span className="num">{r.number}</span>} />
    },
    {
      id: 'party', header: stage === 'delivery_note' ? 'Consignee' : 'Supplier', kind: 'text', value: (r) => r.partyName ?? '', minWidth: 150,
      cell: (r) => (r.partyLedgerId ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName ?? ''} /> : <>{r.partyName}</>)
    },
    {
      id: 'purpose', header: 'Purpose', kind: 'enum', value: (r) => r.purpose, width: 110, defaultHidden: stage === 'receipt_note',
      options: STOCK_NOTE_PURPOSES[stage].map((p) => ({ value: p.value, label: p.label })),
      text: (r) => purposeLabel(r.purpose)
    },
    {
      id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 140,
      cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} />
    },
    { id: 'godown', header: 'Godown', kind: 'text', value: (r) => r.godownName ?? '', defaultHidden: true },
    { id: 'qty', header: stage === 'delivery_note' ? 'Delivered' : 'Received', kind: 'quantity', value: (r) => r.qtyMilli, decimals: (r) => r.decimals, width: 100, defaultHidden: true },
    { id: 'done', header: stage === 'delivery_note' ? 'Invoiced' : 'Billed', kind: 'quantity', value: (r) => r.doneMilli, decimals: (r) => r.decimals, width: 90 },
    { id: 'pending', header: 'Pending', kind: 'quantity', value: (r) => r.pendingMilli, decimals: (r) => r.decimals, unit: (r) => r.unit ?? '', width: 110, aggregate: 'sum' },
    { id: 'rate', header: 'Rate', kind: 'money', value: (r) => r.ratePaise, width: 120, defaultHidden: true },
    { id: 'value', header: 'Pending value', kind: 'money', value: (r) => r.pendingValue, width: 130, aggregate: 'sum' },
    { id: 'age', header: 'Age', kind: 'number', value: (r) => r.ageDays, text: (r) => `${r.ageDays} d`, width: 70 },
    { id: 'bucket', header: 'Ageing', kind: 'text', value: (r) => bucketOf(r.ageDays), groupKey: (r) => bucketOf(r.ageDays), width: 104, defaultHidden: true }
  ])
}

const COLUMNS: Record<PendingStage, ReturnType<typeof columnsFor>> = {
  delivery_note: columnsFor('delivery_note'),
  receipt_note: columnsFor('receipt_note')
}

const TITLE: Record<PendingStage, string> = { delivery_note: 'Pending challans', receipt_note: 'Pending GRNs' }

export function TradePendingScreen({ stage }: { stage: PendingStage }): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const { data, isLoading } = useQuery({ queryKey: ['tradePending', stage, to], queryFn: () => api.trade.pending(stage, to) })
  const rows = data ?? []
  const periodLabel = `as on ${toDisplayDate(to)}`
  const outward = stage === 'delivery_note'
  return (
    <Page width="wide">
      <PageHeader
        title={TITLE[stage]}
        period={periodLabel}
        tabs={
          <TabBar
            screen="trade-pending"
            tabs={[
              { id: 'delivery_note', label: 'Challans not invoiced' },
              { id: 'receipt_note', label: 'GRNs not billed' }
            ]}
            active={stage}
            onSelect={(s) => nav.go({ name: s === 'delivery_note' ? 'pending-challans' : 'pending-grns' })}
          />
        }
        actions={
          <Button
            data-testid="btn-trade-pending-new"
            onClick={() => nav.go({ name: 'voucher-entry', kindHint: stage })}
          >
            New {outward ? 'challan' : 'GRN'}
          </Button>
        }
        options={{
          content: (
            <>
              <OptionsPeriod asOn />
              <OptionsTable area={`trade-pending-${stage}`} />
              <DrawerSection title="About this report">
                <p className="text-hint text-muted">
                  {outward
                    ? 'Delivery challan lines whose goods left but are not yet on a sales invoice (goods delivered, not invoiced). '
                    : 'Goods receipt note lines received but not yet on a purchase bill (received, not billed). '}
                  A line counts as done once a live {outward ? 'invoice' : 'bill'} (or a return) dated on or before the report date
                  draws on it. Short-closed notes are not pending. The value is the line&apos;s taxable value for the pending
                  quantity; age runs from the note&apos;s date.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <Panel>
        <DataTable
          key={stage}
          viewId={`trade-pending-${stage}`}
          testId={`trade-pending-${stage}`}
          ariaLabel={TITLE[stage]}
          columns={COLUMNS[stage]}
          rows={rows}
          rowKey={(r) => r.lineUid}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
          loading={isLoading}
          onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
          empty={{
            title: outward ? 'Every challan is invoiced' : 'Every GRN is billed',
            hint: outward ? 'Raise the invoice with “Add from challans…” (⌥A) in a sales invoice.' : 'Raise the bill with “Add from receipt notes…” (⌥A) in a purchase bill.'
          }}
          exportOptions={{ title: TITLE[stage], periodLabel, filename: `pending-${outward ? 'challans' : 'grns'}` }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Click a line to open its {outward ? 'challan' : 'GRN'} · F12 for options.</p>
    </Page>
  )
}
