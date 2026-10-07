// Payables → Payment runs (WP 4.3): every planned / batch run with its live payment vouchers.
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PaymentRun } from '@shared/payables/types'
import { Modal, Page, PageHeader, Panel } from '../../components/ui'
import { OptionsTable } from '../../components/ScreenOptions'
import { DataTable, defineColumns } from '../../components/table'
import { payablesApi } from '../../lib/payablesClient'
import { RunSummary } from './RunModals'

const RUN_COLUMNS = defineColumns<PaymentRun>([
  { id: 'runNo', header: 'Run', kind: 'text', value: (r) => r.runNo, width: 100, hideable: false, className: 'num' },
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date },
  {
    id: 'kind', header: 'From', kind: 'enum', value: (r) => r.kind, width: 110,
    options: [{ value: 'plan', label: 'Plan' }, { value: 'batch', label: 'Batch' }], text: (r) => (r.kind === 'plan' ? 'Plan' : 'Batch')
  },
  { id: 'suppliers', header: 'Suppliers', kind: 'text', value: (r) => r.lines.map((l) => l.partyName).join(', '), minWidth: 200 },
  { id: 'vouchers', header: 'Payments', kind: 'number', value: (r) => r.vouchers, width: 90, aggregate: 'sum' },
  { id: 'tds', header: 'TDS', kind: 'money', value: (r) => r.lines.reduce((s, l) => s + (l.tds?.amount ?? 0), 0), width: 120, aggregate: 'sum' },
  { id: 'amount', header: 'Settled', kind: 'money', value: (r) => r.amount, width: 140, aggregate: 'sum', className: 'font-medium' }
])

export function RunsTab({ tabs }: { tabs: ReactNode }): React.JSX.Element {
  const { data, isLoading } = useQuery({ queryKey: ['payablesRuns'], queryFn: payablesApi.runs })
  const [open, setOpen] = useState<PaymentRun | null>(null)
  return (
    <Page width="wide">
      <PageHeader title="Payables" period="payment runs" tabs={tabs} options={{ content: <OptionsTable area="payables-runs" /> }} />
      <Panel>
        <DataTable
          viewId="payables-runs"
          testId="payables-runs"
          ariaLabel="Payment runs"
          columns={RUN_COLUMNS}
          rows={data ?? []}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row-id': r.id })}
          loading={isLoading}
          onRowActivate={setOpen}
          empty={{ title: 'No payment runs yet', hint: 'Plan payments or enter a batch to post several at once' }}
          exportOptions={{ title: 'Payment runs', periodLabel: 'all runs', filename: 'payment-runs' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">Click a run for its payments, cheques and the bank payment file. A payment moved to the bin drops out of its run.</p>
      {open && (
        <Modal title={`Payment run ${open.runNo}`} onClose={() => setOpen(null)} wide>
          <RunSummary run={open} />
        </Modal>
      )}
    </Page>
  )
}
