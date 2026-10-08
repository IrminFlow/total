// Payables → MSME (WP 4.3): dues to micro / small suppliers aged against the MSMED Act 2006 s.15
// deadline, indicative s.16 interest at three times the RBI bank rate (editable, effective-dated),
// the Income-tax s.43B(h) / 2025 Act s.37(2)(g) disallowance for the year, and MSME Form 1 data
// for a half-year (CSV). Sources: src/shared/payables/msmeSources.ts (shown in Options).
import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fyOf, toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { formMsme1Period, MSME_AGE_BUCKETS, MSME_AGE_LABELS, MSME_CATEGORY_LABELS, addDays } from '@shared/payables/msme'
import { disallowanceSection, MSME_SOURCES } from '@shared/payables/msmeSources'
import type { MsmeBill43Bh, MsmeBillRow, MsmeForm1Supplier } from '@shared/payables/types'
import {
  Banner, Button, DateInput, DrawerSection, Field, Page, PageHeader, Panel, Segmented, Select, StatGrid, StatTile, TextInput
} from '../../components/ui'
import { OptionsTable } from '../../components/ScreenOptions'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { payablesApi } from '../../lib/payablesClient'
import { useToasts } from '../../state/stores'
import { pct, usePayablesAsOn } from './common'

const BASIS = { agreed: 'Agreed', agreed_capped: 'Agreed > 45 d: capped', no_agreement: 'No agreement: 15 d' } as const

const DUES_COLUMNS = defineColumns<MsmeBillRow>([
  { id: 'party', header: 'Supplier', kind: 'text', value: (r) => r.partyName, minWidth: 150, hideable: false, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.partyName} /> },
  { id: 'category', header: 'Category', kind: 'enum', value: (r) => r.category, width: 90, options: [{ value: 'micro', label: 'Micro' }, { value: 'small', label: 'Small' }], text: (r) => MSME_CATEGORY_LABELS[r.category] },
  { id: 'udyam', header: 'Udyam no.', kind: 'text', value: (r) => r.udyamNo ?? '', width: 170, defaultHidden: true, className: 'num' },
  { id: 'bill', header: 'Bill', kind: 'text', value: (r) => r.number, width: 100, cell: (r) => <VoucherLink voucherId={r.voucherId} label={<span className="num">{r.number}</span>} /> },
  { id: 'date', header: 'Accepted', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  { id: 'basis', header: 'Period', kind: 'text', value: (r) => `${BASIS[r.s15.basis]} (${r.s15.days} d)`, width: 170, defaultHidden: true },
  { id: 'payBy', header: 's.15 pay by', kind: 'date', value: (r) => r.s15.payBy },
  {
    id: 'bucket', header: 'Status', kind: 'enum', value: (r) => r.bucket, width: 140, groupKey: (r) => MSME_AGE_LABELS[r.bucket],
    options: MSME_AGE_BUCKETS.map((b) => ({ value: b, label: MSME_AGE_LABELS[b] })), text: (r) => MSME_AGE_LABELS[r.bucket],
    cell: (r) => <span className={r.bucket === 'within' ? 'text-muted' : 'text-cr'}>{MSME_AGE_LABELS[r.bucket]}</span>
  },
  { id: 'late', header: 'Days late', kind: 'number', value: (r) => r.daysLate, width: 84 },
  { id: 'pending', header: 'Pending', kind: 'money', value: (r) => r.pending, width: 130, aggregate: 'sum', className: 'font-medium' },
  {
    id: 'interest', header: 's.16 interest', kind: 'money', value: (r) => r.interest.paise, width: 130, aggregate: 'sum', className: 'text-cr',
    text: (r) => formatPaise(r.interest.paise)
  }
])

const DISALLOW_LABEL = { disallowed: 'Disallowed', at_risk: 'At risk (period running)', allowed: 'Paid in time' } as const

const DISALLOW_COLUMNS = defineColumns<MsmeBill43Bh>([
  { id: 'party', header: 'Supplier', kind: 'text', value: (r) => r.partyName, minWidth: 150, hideable: false, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.partyName} /> },
  { id: 'bill', header: 'Bill', kind: 'text', value: (r) => r.number, width: 100, cell: (r) => <VoucherLink voucherId={r.voucherId} label={<span className="num">{r.number}</span>} /> },
  { id: 'date', header: 'Accepted', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  { id: 'payBy', header: 's.15 pay by', kind: 'date', value: (r) => r.payBy },
  { id: 'pending', header: 'Unpaid at year end', kind: 'money', value: (r) => r.pendingAtFyEnd, width: 150, aggregate: 'sum' },
  { id: 'gst', header: 'GST (ITC) out', kind: 'money', value: (r) => r.gstExcluded || null, width: 120, aggregate: 'sum', className: 'text-muted' },
  {
    id: 'status', header: 'Status', kind: 'enum', value: (r) => r.status, width: 170, text: (r) => DISALLOW_LABEL[r.status],
    options: (Object.keys(DISALLOW_LABEL) as (keyof typeof DISALLOW_LABEL)[]).map((k) => ({ value: k, label: DISALLOW_LABEL[k] }))
  },
  { id: 'disallowed', header: 'Disallowed', kind: 'money', value: (r) => r.disallowed, width: 140, aggregate: 'sum', className: 'text-cr font-medium' },
  { id: 'atRisk', header: 'At risk', kind: 'money', value: (r) => r.atRisk, width: 130, aggregate: 'sum' }
])

const FORM_COLUMNS = defineColumns<MsmeForm1Supplier>([
  { id: 'party', header: 'Name of MSE supplier', kind: 'text', value: (r) => r.partyName, minWidth: 170, hideable: false, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.partyName} /> },
  { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan ?? '', width: 110, className: 'num' },
  { id: 'withinN', header: 'No.', group: 'Paid ≤ 45 d', kind: 'number', value: (r) => r.paidWithin45.count, width: 60 },
  { id: 'within', header: 'Amount', group: 'Paid ≤ 45 d', kind: 'money', value: (r) => r.paidWithin45.amount, width: 120, aggregate: 'sum' },
  { id: 'afterN', header: 'No.', group: 'Paid > 45 d', kind: 'number', value: (r) => r.paidAfter45.count, width: 60 },
  { id: 'after', header: 'Amount', group: 'Paid > 45 d', kind: 'money', value: (r) => r.paidAfter45.amount, width: 120, aggregate: 'sum' },
  { id: 'dn', header: 'By debit note', kind: 'money', value: (r) => r.debitNotes.amount || null, width: 120, aggregate: 'sum', defaultHidden: true },
  { id: 'outLe', header: '≤ 45 d', group: 'Outstanding', kind: 'money', value: (r) => r.outstandingUpTo45, width: 120, aggregate: 'sum' },
  { id: 'outGt', header: '> 45 d', group: 'Outstanding', kind: 'money', value: (r) => r.outstandingOver45, width: 130, aggregate: 'sum', className: 'text-cr font-medium' }
])

type View = 'dues' | 'disallowance' | 'form1'

function BankRatesEditor(): React.JSX.Element {
  const qc = useQueryClient()
  const toast = useToasts()
  const { data } = useQuery({ queryKey: ['msmeBankRates'], queryFn: payablesApi.bankRates })
  const [fromDate, setFromDate] = useState('')
  const [rate, setRate] = useState('')
  const [source, setSource] = useState('')
  const add = async (): Promise<void> => {
    try {
      const bp = Math.round(Number(rate) * 100)
      if (!fromDate || !Number.isFinite(bp) || bp <= 0) return void toast.push('error', 'Enter the date and the bank rate in per cent')
      await payablesApi.saveBankRate({ fromDate, rateBp: bp, source })
      setFromDate('')
      setRate('')
      setSource('')
      await qc.invalidateQueries({ queryKey: ['msmeBankRates'] })
      await qc.invalidateQueries({ queryKey: ['msmeReport'] })
      await qc.invalidateQueries({ queryKey: ['payablesPlan'] })
      toast.push('success', 'Bank rate saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <DrawerSection title="RBI bank rate (s.16 = 3 ×)" testId="options-msme-bank-rates">
      <table className="w-full text-hint" data-testid="rows-msme-bank-rates">
        <tbody>
          {[...(data ?? [])].reverse().map((r) => (
            <tr key={r.id} title={r.source}>
              <td className="num py-0.5">{toDisplayDate(r.fromDate)}</td>
              <td className="num py-0.5 text-right">{pct(r.rateBp)}</td>
              <td className="num py-0.5 text-right text-muted">→ {pct(r.rateBp * 3)}</td>
              <td className={`py-0.5 pl-2 ${/UNVERIFIED/.test(r.source) ? 'text-warning' : 'text-muted'}`}>{/UNVERIFIED/.test(r.source) ? 'unverified' : 'sourced'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-2">
        <Field label="From">
          <DateInput value={fromDate} context={fromDate || '2026-04-01'} onChange={setFromDate} allowEmpty testId="input-msme-rate-from" />
        </Field>
        <Field label="Bank rate %">
          <TextInput value={rate} onChange={(e) => setRate(e.target.value)} className="num text-right" data-testid="input-msme-rate" placeholder="5.75" />
        </Field>
      </div>
      <Field label="Source (RBI press release)">
        <TextInput value={source} onChange={(e) => setSource(e.target.value)} data-testid="input-msme-rate-source" placeholder="RBI press release …, date" />
      </Field>
      <Button size="sm" data-testid="btn-msme-rate-add" onClick={() => void add()}>
        Add rate
      </Button>
      <p className="text-hint text-muted">Hover a row for its source. Only the owner can change the table.</p>
    </DrawerSection>
  )
}

export function MsmeTab({ tabs }: { tabs: ReactNode }): React.JSX.Element {
  const defaultAsOn = usePayablesAsOn()
  const toast = useToasts()
  const [asOn, setAsOn] = useState(defaultAsOn)
  const [view, setView] = useState<View>('dues')
  const currentFy = fyOf(asOn).startYear
  const [fyStartYear, setFyStartYear] = useState<number>(currentFy)
  const lastHalf = formMsme1Period(asOn).to <= asOn ? formMsme1Period(asOn) : formMsme1Period(addDays(formMsme1Period(asOn).from, -1))
  const [halfFrom, setHalfFrom] = useState(lastHalf.from)
  const q = { asOn, fyStartYear, formPeriodDate: halfFrom }
  const { data, isLoading } = useQuery({ queryKey: ['msmeReport', q], queryFn: () => payablesApi.msmeReport(q) })

  const halves = Array.from({ length: 6 }, (_, i) => {
    let p = lastHalf
    for (let k = 0; k < i; k++) p = formMsme1Period(addDays(p.from, -1))
    return p
  })
  const exportForm = async (): Promise<void> => {
    try {
      const r = await payablesApi.msmeForm1Csv(q)
      toast.push('success', `MSME Form 1 data saved — ${r.rows} supplier${r.rows === 1 ? '' : 's'}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const d = data?.disallowance
  // The year has not ended: nothing is settled as disallowed yet (a late bill paid before the year
  // end is still allowed for the year).
  const yearOpen = !!d && d.fyEnd >= todayISO()
  const form = data?.form1
  const s16 = data?.s16RateBp
  return (
    <Page width="wide">
      <PageHeader
        title="Payables"
        period={`MSME as on ${toDisplayDate(asOn)}`}
        tabs={tabs}
        controls={<DateInput value={asOn} context={asOn} onChange={setAsOn} testId="input-msme-as-on" ariaLabel="As on" className="w-32" />}
        secondary={
          <Button data-testid="btn-msme-form1-csv" onClick={() => void exportForm()}>
            MSME Form 1 CSV
          </Button>
        }
        options={{
          content: (
            <>
              <DrawerSection title="Year and half-year">
                <Field label={`Disallowance year (${disallowanceSection(fyStartYear)})`}>
                  <Select data-testid="input-msme-fy" value={fyStartYear} onChange={(e) => setFyStartYear(Number(e.target.value))}>
                    {[currentFy, currentFy - 1, currentFy - 2].map((y) => (
                      <option key={y} value={y}>FY {y}-{String((y + 1) % 100).padStart(2, '0')}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="MSME Form 1 half-year">
                  <Select data-testid="input-msme-half" value={halfFrom} onChange={(e) => setHalfFrom(e.target.value)}>
                    {halves.map((h) => (
                      <option key={h.from} value={h.from}>{h.label} — due {toDisplayDate(h.dueDate)}</option>
                    ))}
                  </Select>
                </Field>
              </DrawerSection>
              <BankRatesEditor />
              <OptionsTable area={view === 'dues' ? 'msme-dues' : view === 'form1' ? 'msme-form1' : 'msme-disallowance'} />
              <DrawerSection title="Sources" testId="options-msme-sources">
                <ul className="flex flex-col gap-1.5 text-hint text-muted">
                  {MSME_SOURCES.map((s) => (
                    <li key={s.rule}>
                      <span className="text-ink">{s.rule}</span> — {s.citation} ({s.dated}){' '}
                      {!s.verified && <span className="text-warning">UNVERIFIED</span>}
                      {s.note && <span className="block">{s.note}</span>}
                    </li>
                  ))}
                </ul>
              </DrawerSection>
            </>
          )
        }}
      />
      <StatGrid className="mb-section">
        <StatTile label="Due to micro / small" value={formatPaise(data?.totalPending ?? 0, { symbol: true })} testId="msme-tile-total" loading={isLoading} />
        <StatTile
          label="Past the s.15 period"
          value={formatPaise((data?.totalPending ?? 0) - (data?.buckets.within ?? 0), { symbol: true })}
          tone="cr"
          testId="msme-tile-late"
          loading={isLoading}
        />
        <StatTile
          label="s.16 interest (indicative)"
          value={formatPaise(data?.totalInterest ?? 0, { symbol: true })}
          hint={s16 != null ? `${pct(s16)} = 3 × bank rate ${pct(data!.bankRate!.rateBp)}` : 'No bank rate on file'}
          testId="msme-tile-interest"
          loading={isLoading}
        />
        <StatTile
          label={`${yearOpen ? 'At risk' : 'Disallowed'} FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`}
          value={formatPaise((yearOpen ? d?.atRisk : d?.disallowed) ?? 0, { symbol: true })}
          tone={(d?.disallowed ?? 0) > 0 ? 'cr' : yearOpen && (d?.atRisk ?? 0) > 0 ? 'amber' : undefined}
          hint={
            yearOpen
              ? `${disallowanceSection(fyStartYear)} · year open: disallowed if still unpaid on ${toDisplayDate(d?.fyEnd ?? asOn)} past the s.15 period`
              : `${disallowanceSection(fyStartYear)} · still at risk ${formatPaise(d?.atRisk ?? 0)}`
          }
          testId="msme-tile-disallowed"
          loading={isLoading}
          onClick={() => setView('disallowance')}
        />
        <StatTile
          label={`Form 1 · ${form?.period.label ?? ''}`}
          value={formatPaise(form?.total ?? 0, { symbol: true })}
          hint={form ? `${form.mustFile ? 'File' : 'Nothing to file'} — due ${toDisplayDate(form.period.dueDate)}` : undefined}
          testId="msme-tile-form1"
          loading={isLoading}
          onClick={() => setView('form1')}
        />
      </StatGrid>
      {(data?.gaps.length ?? 0) > 0 && (
        <Banner tone="warning" className="mb-section" testId="msme-gaps" title="Supplier details missing">
          {data!.gaps.slice(0, 4).map((g, i) => (
            <span key={i} className="block">
              <LedgerLink ledgerId={g.ledgerId} name={g.name} />: {g.issue}
            </span>
          ))}
          {data!.gaps.length > 4 && <span className="block text-muted">…and {data!.gaps.length - 4} more</span>}
        </Banner>
      )}
      <Panel>
        {view === 'dues' && (
          <DataTable
            viewId="msme-dues"
            testId="msme-dues"
            ariaLabel="Dues to micro and small suppliers"
            columns={DUES_COLUMNS}
            rows={data?.rows ?? []}
            rowKey={(r) => r.key}
            rowAttrs={(r) => ({ 'data-row-id': r.voucherId ?? undefined, 'data-bucket': r.bucket })}
            loading={isLoading}
            toolbarStart={<ViewSwitch view={view} onChange={setView} />}
            empty={{ title: 'Nothing due to micro or small suppliers', hint: 'Mark suppliers as MSME on their ledger (Udyam number, category, agreed days)' }}
            exportOptions={{ title: 'Dues to MSME suppliers (MSMED Act s.15 / s.16)', periodLabel: `as on ${toDisplayDate(asOn)}`, filename: 'msme-dues', footNote: 's.16 interest is indicative: compound, monthly rests, 3 × RBI bank rate.' }}
          />
        )}
        {view === 'disallowance' && (
          <DataTable
            viewId="msme-disallowance"
            testId="msme-disallowance"
            ariaLabel="MSME disallowance for the year"
            columns={DISALLOW_COLUMNS}
            rows={d?.bills ?? []}
            rowKey={(r) => r.key}
            loading={isLoading}
            toolbarStart={<ViewSwitch view={view} onChange={setView} />}
            empty={{ title: `Nothing unpaid to micro / small suppliers on ${toDisplayDate(d?.fyEnd ?? asOn)}` }}
            exportOptions={{
              title: `${disallowanceSection(fyStartYear)} — MSME dues unpaid at year end`, periodLabel: `FY ending ${toDisplayDate(d?.fyEnd ?? asOn)}`,
              filename: 'msme-43bh', footNote: 'Capital purchases on these suppliers are not a deduction — review them separately.'
            }}
          />
        )}
        {view === 'form1' && (
          <DataTable
            viewId="msme-form1"
            testId="msme-form1"
            ariaLabel="MSME Form 1 data"
            columns={FORM_COLUMNS}
            rows={form?.suppliers ?? []}
            rowKey={(r) => r.ledgerId}
            loading={isLoading}
            toolbarStart={<ViewSwitch view={view} onChange={setView} />}
            empty={{ title: `No dealings with micro / small suppliers in ${form?.period.label ?? 'the half-year'}` }}
            exportOptions={{ title: `MSME Form 1 — ${form?.period.label ?? ''}`, periodLabel: `due ${form ? toDisplayDate(form.period.dueDate) : ''}`, filename: 'msme-form-1' }}
          />
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">
        {view === 'disallowance'
          ? `Bills booked in the year, unpaid at its end and not paid within the s.15 period: added back for the year, allowed when paid. GST taken as input tax credit is left out (pro rata); capital purchases need a separate review.${
              (d?.carriedFromEarlier.bills ?? 0) > 0 ? ` ${d!.carriedFromEarlier.bills} unpaid bill(s) from earlier years / opening balances (${formatPaise(d!.carriedFromEarlier.amount)}) are not this year's figure — check them.` : ''
            }`
          : view === 'form1'
            ? 'Revised MSME Form 1 (S.O. 2751(E), 15 Jul 2024): only companies with amounts outstanding more than 45 days file. The CSV adds the bills behind the > 45 d column.'
            : 'Acceptance is the bill date. Interest is indicative · F12 for the bank rate table and the sources.'}
      </p>
    </Page>
  )
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }): React.JSX.Element {
  return (
    <Segmented<View>
      label="MSME view"
      size="sm"
      testId="msme-view"
      value={view}
      onChange={onChange}
      options={[
        { value: 'dues', label: 'Dues & interest' },
        { value: 'disallowance', label: '43B(h) / s.37' },
        { value: 'form1', label: 'MSME Form 1' }
      ]}
    />
  )
}
