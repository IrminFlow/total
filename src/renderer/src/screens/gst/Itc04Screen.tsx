// ITC-04 (WP 3.4): goods sent to job workers (Table 4), received back (5A), supplied from the
// job worker's premises (5C), from the WP 2.4 job-work challans. Periodicity per rule 45(3) +
// Notification 35/2021-CT: half-yearly above ₹5 crore preceding-FY turnover, else annual.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyOf, todayISO, toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { ITC04_RULES } from '@shared/gst/sources'
import type { Itc04PeriodKind, Itc04Periodicity, Itc04ReceivedRow, Itc04SentRow, Itc04SuppliedRow } from '@shared/gst/itc04'
import { posLabel } from '@shared/gst/states'
import { api } from '../../lib/client'
import { useNav, useToasts } from '../../state/stores'
import { Badge, Banner, Button, DrawerSection, EmptyState, Page, PageHeader, Panel, Select } from '../../components/ui'
import { OptionsTable } from '../../components/ScreenOptions'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { openVoucher } from '../../lib/drill'
import { GstReturnTabs } from '../GstReturns'
import { FySelect, SourcesSection, UnverifiedBanner } from './common'

const jwText = (r: { jwGstin: string | null; jwStateCode: string | null }): string => r.jwGstin ?? (r.jwStateCode ? `Unregistered · ${posLabel(r.jwStateCode)}` : '—')
const jwCols = <T extends { jwGstin: string | null; jwStateCode: string | null; jwName: string; partyLedgerId: number | null }>() =>
  [
    { id: 'jw', header: 'Job worker', kind: 'text' as const, value: (r: T) => r.jwName, minWidth: 120, cell: (r: T) => <LedgerLink ledgerId={r.partyLedgerId} name={r.jwName} /> },
    { id: 'gstin', header: 'GSTIN / State', kind: 'text' as const, value: (r: T) => jwText(r), width: 150, className: 'num text-muted' }
  ]

export const ITC04_SENT_COLUMNS = defineColumns<Itc04SentRow>([
  ...jwCols<Itc04SentRow>(),
  { id: 'challan', header: 'Challan', kind: 'text', value: (r) => r.challanNo, width: 84, hideable: false, groupable: false, cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.challanNo} /> },
  { id: 'date', header: 'Challan date', kind: 'date', value: (r) => r.challanDate, className: 'text-muted' },
  { id: 'desc', header: 'Description', kind: 'text', value: (r) => r.description, minWidth: 120 },
  { id: 'hsn', header: 'HSN', kind: 'text', value: (r) => r.hsn, width: 80, className: 'num', defaultHidden: true },
  { id: 'uqc', header: 'UQC', kind: 'text', value: (r) => r.uqc, width: 64 },
  { id: 'qty', header: 'Quantity', kind: 'quantity', value: (r) => r.qtyMilli, width: 96, aggregate: 'sum' },
  { id: 'value', header: 'Taxable value', kind: 'money', value: (r) => r.taxableValuePaise, width: 124, aggregate: 'sum' },
  { id: 'type', header: 'Type', kind: 'enum', value: (r) => r.goodsType, width: 104, options: [{ value: 'inputs', label: 'Inputs' }, { value: 'capital_goods', label: 'Capital goods' }] },
  { id: 'rates', header: 'C/S/I/cess %', kind: 'text', value: (r) => `${r.cgstRate}/${r.sgstRate}/${r.igstRate}/${r.cessRate}`, width: 112, className: 'num text-muted' },
  { id: 'nature', header: 'Nature of processing', kind: 'text', value: (r) => r.natureOfProcessing, minWidth: 140, defaultHidden: true }
])

export const ITC04_RECEIVED_COLUMNS = defineColumns<Itc04ReceivedRow>([
  ...jwCols<Itc04ReceivedRow>(),
  { id: 'jwChallan', header: 'JW challan', kind: 'text', value: (r) => r.jwChallanNo, width: 104, groupable: false, cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.jwChallanNo ?? `#${r.voucherId}`} /> },
  { id: 'jwDate', header: 'Date', kind: 'date', value: (r) => r.jwChallanDate, className: 'text-muted' },
  { id: 'kind', header: 'Received as', kind: 'enum', value: (r) => r.kind, width: 108, options: [{ value: 'processed', label: 'Processed' }, { value: 'unprocessed', label: 'Unprocessed' }] },
  { id: 'desc', header: 'Description', kind: 'text', value: (r) => r.description, minWidth: 140 },
  { id: 'uqc', header: 'UQC', kind: 'text', value: (r) => r.uqc, width: 64 },
  { id: 'qty', header: 'Quantity', kind: 'quantity', value: (r) => r.qtyMilli, width: 104, aggregate: 'sum' },
  { id: 'orig', header: 'Orig. challan', kind: 'text', value: (r) => r.originalChallanNo, width: 104 },
  { id: 'origDate', header: 'Original date', kind: 'date', value: (r) => r.originalChallanDate, className: 'text-muted', defaultHidden: true },
  { id: 'nature', header: 'Nature of job work', kind: 'text', value: (r) => r.natureOfProcessing, minWidth: 140, defaultHidden: true },
  { id: 'lossUqc', header: 'UQC', group: 'Losses & wastes', kind: 'text', value: (r) => r.lossUqc, width: 64 },
  { id: 'loss', header: 'Quantity', group: 'Losses & wastes', kind: 'quantity', value: (r) => r.lossQtyMilli, width: 104, aggregate: 'sum' }
])

export const ITC04_SUPPLIED_COLUMNS = defineColumns<Itc04SuppliedRow>([
  ...jwCols<Itc04SuppliedRow>(),
  { id: 'inv', header: 'Invoice no.', kind: 'text', value: (r) => r.invoiceNo, width: 110, groupable: false, cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.invoiceNo} /> },
  { id: 'date', header: 'Invoice date', kind: 'date', value: (r) => r.invoiceDate, className: 'text-muted' },
  { id: 'desc', header: 'Description', kind: 'text', value: (r) => r.description, minWidth: 140 },
  { id: 'uqc', header: 'UQC', kind: 'text', value: (r) => r.uqc, width: 64 },
  { id: 'qty', header: 'Quantity', kind: 'quantity', value: (r) => r.qtyMilli, width: 104, aggregate: 'sum' },
  { id: 'value', header: 'Taxable value', kind: 'money', value: (r) => r.taxableValuePaise, width: 132, aggregate: 'sum' }
])

type PeriodicityChoice = 'auto' | Itc04Periodicity

export function Itc04Screen(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const [fy, setFy] = useState(() => fyOf(todayISO()).startYear)
  const [choice, setChoice] = useState<PeriodicityChoice>('auto')
  const [kind, setKind] = useState<Itc04PeriodKind>('FY')
  const periodicity = choice === 'auto' ? undefined : choice
  const { data, isLoading } = useQuery({
    queryKey: ['itc04', fy, kind, choice],
    queryFn: () => api.gst.itc04({ fyStartYear: fy, kind, periodicity })
  })
  const periods = data?.periods ?? []
  const r = data?.result
  // The server falls back to the first period when `kind` doesn't exist at this periodicity —
  // show what it actually built.
  const shownKind = r?.period.kind ?? kind
  const empty = r && r.sent.length + r.received.length + r.supplied.length === 0

  const doExport = async (): Promise<void> => {
    try {
      const x = await api.gst.exportItc04({ fyStartYear: fy, kind: shownKind, periodicity })
      toast.push('success', `ITC-04 saved — ${x.csvPath.split('/').pop()} and JSON`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Page width="wide">
      <PageHeader
        title="ITC-04 · Job work"
        tabs={<GstReturnTabs current="itc04" />}
        controls={
          <div className="flex items-center gap-2">
            <FySelect value={fy} onChange={setFy} testId="input-itc04-fy" />
            <Select value={shownKind} onChange={(e) => setKind(e.target.value as Itc04PeriodKind)} className="w-44" aria-label="ITC-04 period" data-testid="input-itc04-period">
              {periods.map((p) => (
                <option key={p.kind} value={p.kind}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
        }
        actions={
          <Button variant="primary" data-testid="btn-itc04-export" onClick={() => void doExport()} disabled={!r || !!empty}>
            Export CSV + JSON
          </Button>
        }
        options={{
          content: (
            <>
              <DrawerSection title="Periodicity">
                <Select value={choice} onChange={(e) => setChoice(e.target.value as PeriodicityChoice)} aria-label="Periodicity" data-testid="input-itc04-periodicity">
                  <option value="auto">From last year’s turnover{data ? ` (${data.derivedPeriodicity === 'half_yearly' ? 'half-yearly' : 'annual'})` : ''}</option>
                  <option value="half_yearly">Half-yearly</option>
                  <option value="annual">Annual</option>
                </Select>
                <p className="text-hint text-muted">
                  Rule 45(3) with Notification 35/2021-CT: six months (Apr–Sep by 25 Oct, Oct–Mar by 25 Apr) when aggregate turnover in the
                  preceding year exceeds {formatPaise(ITC04_RULES.halfYearlyAboveAatoPaise, { symbol: true })}; the year (by 25 Apr) otherwise.
                </p>
              </DrawerSection>
              <OptionsTable area="itc04-sent" label="Table 4" />
              <OptionsTable area="itc04-received" label="Table 5A" />
              <SourcesSection ids={ITC04_RULES.sources} />
            </>
          )
        }}
      />

      <UnverifiedBanner ids={['itc04-json', 'itc04-hsn']} testId="itc04-unverified" />
      {data && r && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-small text-muted" data-testid="itc04-facts">
          <Badge tone="neutral">{data.periodicity === 'half_yearly' ? 'Half-yearly' : 'Annual'}</Badge>
          <Badge tone="amber">Due {toDisplayDate(r.period.dueDate)}</Badge>
          <span>Preceding year’s turnover {formatPaise(data.precedingTurnover, { symbol: true })}</span>
        </div>
      )}
      {r && r.issues.length > 0 && (
        <Banner tone={r.issues.some((i) => i.severity === 'blocking') ? 'danger' : 'warning'} className="mb-3" testId="itc04-issues">
          <ul className="list-disc pl-4">
            {r.issues.map((i, k) => (
              <li key={k}>
                {i.message}{' '}
                {i.voucherIds.slice(0, 5).map((id) => (
                  <button key={id} className="ml-1 text-blue hover:underline" onClick={() => openVoucher(id)}>
                    #{id}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {empty ? (
        <Panel>
          <EmptyState
            title="No job work in this period"
            hint="Send goods with Stock journal → Send to job worker; receive them with Manufacture → Receive from job worker."
            action={<Button onClick={() => nav.go({ name: 'stock-journal', mode: 'jobWork' })}>Send to job worker…</Button>}
          />
        </Panel>
      ) : (
        <>
          <Panel className="mb-section">
            <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Table 4 — inputs / capital goods sent for job work</p>
            <DataTable
              viewId="itc04-sent" testId="itc04-sent" ariaLabel="ITC-04 Table 4" columns={ITC04_SENT_COLUMNS} rows={r?.sent ?? []}
              rowKey={(x, i) => `${x.voucherId}-${i}`} rowAttrs={(x) => ({ 'data-row-id': x.voucherId })} onRowActivate={(x) => openVoucher(x.voucherId)}
              loading={isLoading} maxHeight="none" empty={{ title: 'Nothing sent in this period' }}
              exportOptions={{ title: 'ITC-04 Table 4', periodLabel: r?.period.label ?? '', filename: `itc04-table4-${fy}-${kind}` }}
            />
          </Panel>
          <Panel className="mb-section">
            <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Table 5A — received back from the job worker (with losses and wastes)</p>
            <DataTable
              viewId="itc04-received" testId="itc04-received" ariaLabel="ITC-04 Table 5A" columns={ITC04_RECEIVED_COLUMNS} rows={r?.received ?? []}
              rowKey={(x, i) => `${x.voucherId}-${i}`} rowAttrs={(x) => ({ 'data-row-id': x.voucherId })} onRowActivate={(x) => openVoucher(x.voucherId)}
              loading={isLoading} maxHeight="none" empty={{ title: 'Nothing received back in this period' }}
              exportOptions={{ title: 'ITC-04 Table 5A', periodLabel: r?.period.label ?? '', filename: `itc04-table5a-${fy}-${kind}` }}
            />
          </Panel>
          <Panel className="mb-section">
            <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Table 5C — supplied from the job worker&apos;s premises</p>
            <DataTable
              viewId="itc04-supplied" testId="itc04-supplied" ariaLabel="ITC-04 Table 5C" columns={ITC04_SUPPLIED_COLUMNS} rows={r?.supplied ?? []}
              rowKey={(x, i) => `${x.voucherId}-${i}`} rowAttrs={(x) => ({ 'data-row-id': x.voucherId })} onRowActivate={(x) => openVoucher(x.voucherId)}
              loading={isLoading} maxHeight="none" empty={{ title: 'No sales out of a job worker’s godown in this period' }}
              exportOptions={{ title: 'ITC-04 Table 5C', periodLabel: r?.period.label ?? '', filename: `itc04-table5c-${fy}-${kind}` }}
            />
          </Panel>
          <p className="text-hint text-muted">
            Table 5B (sent on from one job worker to another) is not recorded in the books — enter it on the portal if it applies. Upload via
            the GST ITC-04 offline tool; the JSON is the app&apos;s own layout.
          </p>
        </>
      )}
    </Page>
  )
}
