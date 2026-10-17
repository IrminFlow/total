// Depreciation run (WP 3.6): pick a period inside one financial year → preview per asset and the
// one journal it will post → post. Optional extra-shift days per asset (Schedule II Notes para 6).
// Below: every run so far, with its voucher.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyOf, toDisplayDate } from '@shared/dates'
import { addDays } from '@shared/depreciation'
import type { DepreciationPreviewRow, DepreciationRunRow, ExtraShiftInput } from '@shared/fixedAssets'
import { faApi } from '../../lib/fixedAssetsClient'
import { useSession, useToasts } from '../../state/stores'
import { Badge, Banner, Button, DateInput, Field, Money, Panel, SectionTitle, Select, TextInput, Toolbar, ToolbarSpacer } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { VoucherLink } from '../../components/links'
import { JOURNAL_COLUMNS } from './DisposalWizard'
import { useRefreshFixedAssets } from './common'

const METHOD_OPTIONS = [
  { value: 'slm', label: 'SLM' },
  { value: 'wdv', label: 'WDV' }
]

export const PREVIEW_COLUMNS = defineColumns<DepreciationPreviewRow>([
  { id: 'asset', header: 'Asset', kind: 'text', value: (r) => r.assetName, hideable: false, groupable: false, minWidth: 180 },
  { id: 'group', header: 'Group', kind: 'text', value: (r) => r.groupName, width: 170, className: 'text-muted' },
  { id: 'method', header: 'Method', kind: 'enum', value: (r) => r.method, options: METHOD_OPTIONS, width: 88 },
  { id: 'opening', header: 'Opening WDV', kind: 'money', value: (r) => r.openingWdv, aggregate: 'sum', width: 140 },
  { id: 'additions', header: 'Additions', kind: 'money', value: (r) => r.additions, aggregate: 'sum', width: 130 },
  { id: 'days', header: 'Days', kind: 'number', value: (r) => r.daysUsed, width: 72 },
  { id: 'depreciation', header: 'Depreciation', kind: 'money', value: (r) => r.depreciation, aggregate: 'sum', width: 140 },
  { id: 'closing', header: 'Closing WDV', kind: 'money', value: (r) => r.closingWdv, aggregate: 'sum', width: 140 },
  {
    id: 'shift', header: 'Extra shift', kind: 'money', value: (r) => r.extraShift?.extra ?? null, width: 130, defaultHidden: true, aggregate: 'sum',
    explainable: false
  },
  {
    id: 'state', header: 'Note', kind: 'text', value: (r) => (r.fullyDepreciated ? 'Fully depreciated' : ''), width: 140, groupable: false,
    cell: (r) => (r.fullyDepreciated ? <Badge tone="neutral">Fully depreciated</Badge> : null)
  }
])

export const RUN_COLUMNS = defineColumns<DepreciationRunRow>([
  { id: 'from', header: 'From', kind: 'date', value: (r) => r.periodFrom, width: 104 },
  { id: 'to', header: 'To', kind: 'date', value: (r) => r.periodTo, width: 104 },
  {
    id: 'kind', header: 'Kind', kind: 'text', value: (r) => (r.assetId ? `Disposal catch-up — ${r.assetName ?? ''}` : 'Depreciation run'), minWidth: 180
  },
  {
    id: 'voucher', header: 'Journal', kind: 'text', value: (r) => r.voucherNumber ?? '', width: 110,
    cell: (r) => <VoucherLink voucherId={r.voided ? null : r.voucherId} label={r.voucherNumber ?? '—'} />
  },
  { id: 'total', header: 'Depreciation', kind: 'money', value: (r) => r.total, width: 140 },
  {
    id: 'status', header: 'Status', kind: 'enum', value: (r) => (r.voided ? 'voided' : 'posted'), width: 110,
    options: [{ value: 'posted', label: 'Posted' }, { value: 'voided', label: 'In bin (void)' }],
    cell: (r) => (r.voided ? <Badge tone="warning">In bin (void)</Badge> : <Badge tone="success">Posted</Badge>)
  }
])

export function DepreciationTab(): React.JSX.Element {
  const { to: sessionTo, workingDate } = useSession()
  const toast = useToasts()
  const refresh = useRefreshFixedAssets()
  const fy = fyOf(sessionTo)
  const [from, setFrom] = useState(fy.from)
  const [to, setTo] = useState(fy.to)
  const [posting, setPosting] = useState(false)
  const { data: runs } = useQuery({ queryKey: ['faRuns'], queryFn: faApi.runs })
  // Until the user picks a period: start the day after the FY's last live run (rest of the year).
  const touched = useRef(false)
  useEffect(() => {
    if (touched.current || !runs) return
    const last = runs.filter((r) => !r.voided && r.assetId == null && r.fyStartYear === fy.startYear).map((r) => r.periodTo).sort().at(-1)
    if (last && last < fy.to) setFrom(addDays(last, 1))
  }, [runs, fy.startYear, fy.to])
  const pick = (setter: (v: string) => void) => (v: string): void => {
    touched.current = true
    setter(v)
  }
  const sameFy = fyOf(from).startYear === fyOf(to).startYear && to >= from
  const [shifts, setShifts] = useState<ExtraShiftInput[]>([])
  const { data: preview, isLoading } = useQuery({
    queryKey: ['faRunPreview', from, to, shifts],
    queryFn: () => faApi.runPreview(from, to, shifts),
    enabled: sameFy
  })
  // A period that is already posted shows what that run charged.
  const existingRunId = preview?.existingRun?.runId ?? null
  const { data: postedLines } = useQuery({
    queryKey: ['faRuns', 'lines', existingRunId],
    queryFn: () => faApi.runLines(existingRunId!),
    enabled: existingRunId != null
  })
  const journal = useMemo(() => (existingRunId != null ? [] : (preview?.journal ?? []).map((l, i) => ({ ...l, key: i }))), [preview, existingRunId])
  const rows = useMemo(
    () => (existingRunId != null ? postedLines ?? [] : (preview?.rows ?? []).filter((r) => r.depreciation > 0 || r.daysUsed > 0)),
    [preview, existingRunId, postedLines]
  )

  const post = async (): Promise<void> => {
    setPosting(true)
    try {
      const run = await faApi.runPost(from, to, shifts)
      setShifts([])
      await refresh()
      toast.push('success', `Depreciation posted — Journal ${run.voucherNumber ?? ''}`.trim())
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setPosting(false)
    }
  }

  const label = `${toDisplayDate(from)} – ${toDisplayDate(to)}`
  return (
    <div className="flex flex-col gap-section">
      <Panel>
        <Toolbar label="Run period" bordered className="items-end py-3">
          <Field label="From" className="w-40"><DateInput testId="input-fixed-assets-run-from" value={from} context={workingDate} onChange={pick(setFrom)} /></Field>
          <Field label="To" className="w-40"><DateInput testId="input-fixed-assets-run-to" value={to} context={workingDate} onChange={pick(setTo)} /></Field>
          <p className="pb-2 text-hint text-muted">One journal, dated the last day, for every asset in use in the period.</p>
          <ToolbarSpacer />
          <Button variant="primary" data-testid="btn-fixed-assets-post-run" loading={posting} disabled={!preview || !!preview.blocked} onClick={() => void post()}>
            Post depreciation
          </Button>
        </Toolbar>
        {!sameFy && <Banner tone="warning" className="m-3">A run must start and end inside one financial year.</Banner>}
        {preview?.blocked && (
          <Banner tone={preview.existingRun ? 'info' : 'warning'} className="m-3" testId="fixed-assets-run-blocked"
            action={preview.existingRun ? <VoucherLink voucherId={preview.existingRun.voucherId} label="Open the journal" /> : undefined}>
            {preview.blocked}
          </Banner>
        )}
        {existingRunId == null && (
          <ExtraShiftForm rows={preview?.rows ?? []} shifts={shifts} onChange={setShifts} />
        )}
        {preview?.rows.some((r) => r.extraShiftNote) && (
          <Banner tone="info" className="m-3" testId="fixed-assets-shift-note">
            Extra shift not checked against Schedule II: {preview.rows.filter((r) => r.extraShiftNote).map((r) => `${r.assetName} — ${r.extraShiftNote}`).join('; ')}
          </Banner>
        )}
        <DataTable
          viewId="fixed-assets-run-preview"
          testId="fixed-assets-run-preview"
          ariaLabel={existingRunId != null ? `Depreciation posted for ${label}` : `Depreciation per asset, ${label}`}
          columns={PREVIEW_COLUMNS}
          rows={rows}
          rowKey={(r) => r.assetId}
          rowAttrs={(r) => ({ 'data-row-id': r.assetId })}
          loading={isLoading}
          maxHeight="42vh"
          empty={{ title: 'No depreciation to charge in this period', hint: 'Assets in use appear here; add them on the Register tab' }}
          exportOptions={{ title: 'Depreciation (Companies Act, Schedule II)', periodLabel: label, filename: 'depreciation-preview' }}
        />
      </Panel>
      <div>
        <SectionTitle>{existingRunId != null ? 'Journal' : 'Journal to post'}</SectionTitle>
        <Panel>
          <DataTable
            viewId="fixed-assets-run-journal"
            testId="fixed-assets-run-journal"
            ariaLabel="Depreciation journal"
            columns={JOURNAL_COLUMNS}
            rows={journal}
            rowKey={(r) => r.key}
            maxHeight="none"
            toolbar={false}
            totalsLabel="Total"
            empty={{ title: existingRunId != null ? 'Already posted — open the journal from the banner above' : 'Nothing to post' }}
          />
        </Panel>
      </div>
      <div>
        <SectionTitle>Runs</SectionTitle>
        <Panel>
          <DataTable
            viewId="fixed-assets-runs"
            testId="fixed-assets-runs"
            ariaLabel="Depreciation runs"
            columns={RUN_COLUMNS}
            rows={runs ?? []}
            rowKey={(r) => r.id}
            rowAttrs={(r) => ({ 'data-row-id': r.id })}
            maxHeight="36vh"
            empty={{ title: 'No depreciation posted yet' }}
            exportOptions={{ title: 'Depreciation runs', periodLabel: 'All runs', filename: 'depreciation-runs' }}
          />
        </Panel>
      </div>
    </div>
  )
}

const dayCount = (text: string): number | null => (/^\s*\d{1,3}\s*$/.test(text) ? Number(text) : text.trim() === '' ? 0 : null)

/** Extra-shift days for the run (Schedule II Notes para 6: +50% for double-shift days, +100% for
 *  triple-shift days; not for classes marked NESD in Part C). */
export function ExtraShiftForm({ rows, shifts, onChange }: {
  rows: DepreciationPreviewRow[]; shifts: ExtraShiftInput[]; onChange: (s: ExtraShiftInput[]) => void
}): React.JSX.Element | null {
  const eligible = rows.filter((r) => r.extraShiftAllowed && r.daysUsed > 0)
  const [assetId, setAssetId] = useState<number | null>(null)
  const [d2, setD2] = useState('')
  const [d3, setD3] = useState('')
  if (eligible.length === 0 && shifts.length === 0) return null
  const picked = assetId ?? eligible[0]?.assetId ?? null
  const double = dayCount(d2)
  const triple = dayCount(d3)
  const valid = picked != null && double != null && triple != null && double + triple > 0
  const add = (): void => {
    if (!valid) return
    onChange([...shifts.filter((x) => x.assetId !== picked), { assetId: picked!, doubleShiftDays: double!, tripleShiftDays: triple! }])
    setD2('')
    setD3('')
  }
  const name = (id: number): string => rows.find((r) => r.assetId === id)?.assetName ?? `#${id}`
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-line px-3 py-2" data-testid="fixed-assets-extra-shift">
      <Field label="Extra shift (Sch II Notes para 6)" className="w-60" hint="+50% for double-shift days, +100% for triple">
        <Select value={picked ?? ''} onChange={(e) => setAssetId(Number(e.target.value))} aria-label="Asset worked in shifts" data-testid="input-fixed-assets-shift-asset">
          {eligible.map((r) => <option key={r.assetId} value={r.assetId}>{r.assetName}</option>)}
        </Select>
      </Field>
      <Field label="Double-shift days" className="w-32"><TextInput data-testid="input-fixed-assets-shift-double" className="num" value={d2} onChange={(e) => setD2(e.target.value)} /></Field>
      <Field label="Triple-shift days" className="w-32"><TextInput data-testid="input-fixed-assets-shift-triple" className="num" value={d3} onChange={(e) => setD3(e.target.value)} /></Field>
      <Button data-testid="btn-fixed-assets-shift-add" disabled={!valid} onClick={add}>Set</Button>
      {shifts.map((x) => {
        const extra = rows.find((r) => r.assetId === x.assetId)?.extraShift?.extra
        return (
          <span key={x.assetId} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-hint" data-testid={`fixed-assets-shift-${x.assetId}`}>
            {name(x.assetId)}: {x.doubleShiftDays ?? 0} double / {x.tripleShiftDays ?? 0} triple{extra != null && <> · +<Money paise={extra} /></>}
            <Button size="sm" variant="ghost" aria-label={`Remove extra shift for ${name(x.assetId)}`} onClick={() => onChange(shifts.filter((y) => y.assetId !== x.assetId))}>×</Button>
          </span>
        )
      })}
    </div>
  )
}
