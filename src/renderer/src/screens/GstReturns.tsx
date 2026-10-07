import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useFeatures } from '../lib/useFeatures'
import { useNav, useSession, useToasts } from '../state/stores'
import { AmountInput, Banner, Button, DrawerSection, EmptyState, Money, Page, PageHeader, Panel, Select, SkeletonRows, Spinner, TabBar } from '../components/ui'
import { OptionChoice, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { posLabel } from '@shared/gst/states'
import type { Gstr1Result, Gstr3bResult } from '@shared/gst/returns'
import type { GstIssue } from '@shared/gst/validate'
import type { Gst3bManualInput } from '@shared/schemas'

export interface MonthChoice {
  key: string // YYYY-MM
  label: string
  from: string
  to: string
  period: string // MMYYYY
}

export function useMonths(): MonthChoice[] {
  const { from, to } = useSession()
  return useMemo(() => {
    const months: MonthChoice[] = []
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    let [y, m] = from.split('-').map(Number) as [number, number]
    const [ey, em] = to.split('-').map(Number) as [number, number]
    if (!y || !m || !ey || !em) return months
    while ((y < ey || (y === ey && m <= em)) && months.length < 120) {
      const mm = m.toString().padStart(2, '0')
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
      months.push({
        key: `${y}-${mm}`,
        label: `${names[m - 1]} ${y}`,
        from: `${y}-${mm}-01`,
        to: `${y}-${mm}-${lastDay}`,
        period: `${mm}${y}`
      })
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
    return months
  }, [from, to])
}

export function MonthBar({
  months,
  value,
  onChange,
  testId = 'input-month'
}: {
  months: MonthChoice[]
  value: string
  onChange: (key: string) => void
  /** data-testid (lib/testids.ts — `input-<screen>-month`). */
  testId?: string
}): React.JSX.Element {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-48" data-testid={testId} aria-label="Return period">
      {months.map((m) => (
        <option key={m.key} value={m.key}>
          {m.label}
        </option>
      ))}
    </Select>
  )
}

/** Which month a return screen opens on (a screen option): this month, or the previous one —
 *  the month usually being filed. */
export type OpenOn = 'current' | 'previous'
export const OPEN_ON_CHOICES: { value: OpenOn; label: string }[] = [
  { value: 'current', label: 'This month' },
  { value: 'previous', label: 'Previous month' }
]

function previousMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

export function useDefaultMonth(months: MonthChoice[], openOn: OpenOn = 'current'): [string, (k: string) => void] {
  const today = todayISO().slice(0, 7)
  const current = openOn === 'previous' ? previousMonthKey(today) : today
  const fallback = months.find((m) => m.key === current)?.key ?? months[months.length - 1]?.key ?? current
  const [key, setKey] = useState(fallback)
  return [months.some((m) => m.key === key) ? key : fallback, setKey]
}

/** Selected month resolved against the list — null when the period yields no months at all
 *  (item 77 pattern: never `months.find(...)!`). */
export function useMonth(openOn: OpenOn = 'current'): {
  months: MonthChoice[]
  month: MonthChoice | null
  monthKey: string
  setMonthKey: (k: string) => void
} {
  const months = useMonths()
  const [monthKey, setMonthKey] = useDefaultMonth(months, openOn)
  const month = months.find((m) => m.key === monthKey) ?? months[0] ?? null
  return { months, month, monthKey, setMonthKey }
}

export function NoMonths(): React.JSX.Element {
  return (
    <Panel>
      <EmptyState
        title="No months in the current period"
        hint="Check the period (From/To) in the sidebar — it looks empty or reversed."
      />
    </Panel>
  )
}

// ---------- the GST returns tab family (WP 3.4) ----------

export type GstReturnTab = 'gstr1' | 'gstr3b' | 'gstr9' | 'itc04' | 'itc-reversal'

const GST_RETURN_TABS: { id: GstReturnTab; label: string }[] = [
  { id: 'gstr1', label: 'GSTR-1' },
  { id: 'gstr3b', label: 'GSTR-3B' },
  { id: 'gstr9', label: 'GSTR-9' },
  { id: 'itc04', label: 'ITC-04' },
  { id: 'itc-reversal', label: 'ITC reversal' }
]

/** The tab row shared by the GST return screens: each tab is its own registry screen, so the
 *  testids read tab-<current screen>-<tab> (e.g. tab-gstr1-gstr9). */
export function GstReturnTabs({ current }: { current: GstReturnTab }): React.JSX.Element {
  const nav = useNav()
  return (
    <TabBar
      screen={current}
      label="GST returns"
      tabs={GST_RETURN_TABS}
      active={current}
      onSelect={(t) => {
        if (t !== current) nav.go({ name: t })
      }}
    />
  )
}

// ---------- GSTR-1 ----------

const GSTR1_NOTE =
  'The exported JSON matches the GST offline-tool schema — upload it on the portal under Returns → GSTR-1 → Prepare offline. A CSV summary lands beside it in exports/. HSN rows (Table 12) restate the invoice tables and Documents issued (Table 13) counts net series — neither adds to the total.'

type Gstr1SummaryRow = Gstr1Result['summary'][number]

/** HSN rows (Table 12) restate the invoice tables and Documents issued (Table 13) counts net
 *  series — neither adds to the grand total. */
const NON_INVOICE_SECTIONS = new Set(['hsn_b2b', 'hsn_b2c', 'doc_issue'])
const invoiceSum =
  (pick: (r: Gstr1SummaryRow) => number) =>
  (rows: Gstr1SummaryRow[]): number =>
    rows.filter((r) => !NON_INVOICE_SECTIONS.has(r.section)).reduce((s, r) => s + pick(r), 0)

export const GSTR1_COLUMNS = defineColumns<Gstr1SummaryRow>([
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.label, hideable: false, groupable: false, minWidth: 220 },
  { id: 'docs', header: 'Docs', kind: 'number', value: (r) => r.docs, width: 96, aggregate: invoiceSum((r) => r.docs) },
  { id: 'taxable', header: 'Taxable', kind: 'money', value: (r) => r.taxable, width: 140, aggregate: invoiceSum((r) => r.taxable) },
  { id: 'igst', header: 'IGST', kind: 'money', value: (r) => r.igst, width: 124, aggregate: invoiceSum((r) => r.igst) },
  { id: 'cgst', header: 'CGST', kind: 'money', value: (r) => r.cgst, width: 124, aggregate: invoiceSum((r) => r.cgst) },
  { id: 'sgst', header: 'SGST', kind: 'money', value: (r) => r.sgst, width: 124, aggregate: invoiceSum((r) => r.sgst) },
  { id: 'cess', header: 'Cess', kind: 'money', value: (r) => r.cess, width: 108, aggregate: invoiceSum((r) => r.cess) }
])

const SEVERITY_CLASS: Record<GstIssue['severity'], string> = {
  blocking: 'border-danger/50 bg-danger-soft text-danger',
  warning: 'border-warning/50 bg-warning-soft text-warning'
}

function IssueRow({
  severity,
  message,
  voucherIds,
  onOpen
}: {
  severity: GstIssue['severity']
  message: string
  voucherIds: number[]
  onOpen: (voucherId: number) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? voucherIds : voucherIds.slice(0, 8)
  return (
    <div className="flex flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0" data-row-id={voucherIds[0]}>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-label font-medium uppercase ${SEVERITY_CLASS[severity]}`}>
          {severity}
        </span>
        <span className="text-body-sm text-ink">{message}</span>
      </div>
      {voucherIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pl-1">
          {shown.map((id) => (
            <button
              key={id}
              data-testid="btn-gstr1-drill"
              data-row-id={id}
              className="rounded border border-line px-1.5 py-0.5 text-caption text-blue hover:bg-panel2"
              onClick={() => onOpen(id)}
            >
              Open #{id}
            </button>
          ))}
          {voucherIds.length > 8 && !expanded && (
            <button className="text-caption text-muted hover:text-ink" onClick={() => setExpanded(true)}>
              +{voucherIds.length - 8} more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The return screens' shared options: which month to open on (the month select stays visible). */
function ReturnOptions({ openOn, onOpenOn }: { openOn: OpenOn; onOpenOn: (v: OpenOn) => void }): React.JSX.Element {
  return (
    <DrawerSection title="Return period">
      <OptionChoice label="Open on" value={openOn} options={OPEN_ON_CHOICES} onChange={onOpenOn} testId="input-return-open-on" />
      <p className="text-hint text-muted">Months come from the working period. The month picker stays in the header.</p>
    </DrawerSection>
  )
}

export function Gstr1Screen(): React.JSX.Element {
  const features = useFeatures()
  const opts = useScreenOptions('gstr1', { openOn: 'current' as OpenOn }, { openOn: ['current', 'previous'] })
  const { months, month, monthKey, setMonthKey } = useMonth(opts.options.openOn)
  const { info } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const { data, isLoading } = useQuery({
    queryKey: ['gstr1', month?.key],
    queryFn: () => api.gst.gstr1(month!.from, month!.to, month!.period),
    enabled: !!month
  })
  const { data: validation, isLoading: validating } = useQuery({
    queryKey: ['gstValidate', month?.key],
    queryFn: () => api.gst.validate(month!.from, month!.to),
    enabled: !!month
  })

  const issues = validation?.issues ?? []
  const blocking = issues.filter((i) => i.severity === 'blocking')
  const warnings = issues.filter((i) => i.severity === 'warning')
  const roundOff = validation?.roundOff ?? []
  const exportBlockedReason = !info?.gstin
    ? 'Add the company GSTIN under Company details to enable portal export.'
    : blocking.length
      ? `Export blocked — ${blocking.length} blocking issue${blocking.length === 1 ? '' : 's'} below must be fixed first.`
      : null

  const doExport = async (): Promise<void> => {
    if (!month) return
    try {
      const r = await api.gst.exportGstr1(month.from, month.to, month.period)
      toast.push('success', `GSTR-1 JSON ready to upload — ${r.jsonPath.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const openVoucher = (voucherId: number): void => nav.go({ name: 'voucher-entry', voucherId })

  if (!month) {
    return (
      <Page>
        <PageHeader title="GSTR-1 · Outward supplies" />
        <NoMonths />
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        title="GSTR-1 · Outward supplies"
        tabs={<GstReturnTabs current="gstr1" />}
        controls={<MonthBar months={months} value={monthKey} onChange={setMonthKey} testId="input-gstr1-month" />}
        actions={
          <Button
            variant="primary"
            data-testid="btn-gstr1-export"
            onClick={() => void doExport()}
            disabled={!!exportBlockedReason || validating}
            title={exportBlockedReason ?? undefined}
          >
            Export portal JSON
          </Button>
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <ReturnOptions openOn={opts.options.openOn} onOpenOn={(v) => opts.set('openOn', v)} />
              <OptionsTable area="gstr1" label="Summary table" />
              <DrawerSection title="About the export">
                <p className="text-hint text-muted">{GSTR1_NOTE}</p>
              </DrawerSection>
            </>
          )
        }}
      />

      {exportBlockedReason && (
        <Banner tone={blocking.length ? 'danger' : 'warning'} className="mb-3" testId="gstr1-export-blocked">
          {exportBlockedReason}
        </Banner>
      )}

      {validating ? (
        <Panel className="mb-section">
          <div className="flex items-center gap-2 px-3 py-3 text-body-sm text-muted">
            <Spinner /> Validating period documents…
          </div>
        </Panel>
      ) : issues.length > 0 || roundOff.length > 0 ? (
        <Panel className="mb-section" scroll={{ maxH: '18rem' }}>
          <div data-testid="rows-gstr1-issues">
            {[...blocking, ...warnings].map((issue, i) => (
              <IssueRow key={`${issue.code}-${i}`} severity={issue.severity} message={issue.message} voucherIds={issue.voucherIds} onOpen={openVoucher} />
            ))}
            {roundOff.map((r) => (
              <IssueRow
                key={`roundoff-${r.voucherId}`}
                severity="warning"
                message={`${r.number}: e-invoice round-off of ₹${formatPaise(r.roundOff)} across ${r.lines.join(', ')} — the NIC schema tolerates ±₹1 per line.`}
                voucherIds={[r.voucherId]}
                onOpen={openVoucher}
              />
            ))}
          </div>
        </Panel>
      ) : (
        <p className="mb-3 text-small text-success" role="status" data-testid="gstr1-validation-clean">
          Validation clean — no issues found in this period. ✓
        </p>
      )}

      <Panel>
        <DataTable
          viewId="gstr1-summary"
          testId="gstr1"
          ariaLabel="GSTR-1 section summary"
          columns={GSTR1_COLUMNS}
          rows={data?.summary ?? []}
          rowKey={(s) => s.section}
          rowAttrs={(s) => ({ 'data-section': s.section })}
          rowClassName={(s) => (s.docs === 0 && s.taxable === 0 ? 'text-muted' : '')}
          loading={isLoading}
          maxHeight="none"
          totalsLabel="Total (invoice tables)"
          empty={{ title: 'No GSTR-1 data for this month' }}
          exportOptions={{
            title: 'GSTR-1 summary',
            periodLabel: month.label,
            filename: `gstr1-summary-${month.period}`,
            totalsLabel: 'Total (invoice tables)'
          }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">
        Upload the JSON on the portal under Returns → GSTR-1 → Prepare offline. HSN (Table 12) and Documents issued (Table 13) don&apos;t add to the total.
      </p>
      {features.orders && (
        <p className="mt-1 text-hint text-muted" data-testid="gstr1-challan-note">
          Delivery challans are never invoices here; Table 13 counts them by purpose (9 job work, 10 on approval, 11 liquid gas,
          12 other than supply). A challan for a plain supply is reported under 12 — confirm that with your CA.
        </p>
      )}
    </Page>
  )
}

// ---------- GSTR-3B ----------

const GSTR3B_NOTE =
  '4(B) reversals, the 4(D)(1) reclaim and 5.1 interest/late fee are the manual adjustments, persisted per period and folded into the exported JSON — the ITC reversal tab computes them. Per Circular 170/02/2022-GST, credit blocked under s.17(5) (parties marked blocked) is availed in 4(A)(5) and reversed in 4(B)(1) automatically. RCM tax (3.1(d)) is payable in cash and simultaneously claimable as ITC under 4(A)(3).'

const INTERSTATE_COLUMNS = defineColumns<Gstr3bResult['interState'][number]>([
  { id: 'pos', header: 'Place of supply', kind: 'text', value: (r) => posLabel(r.pos), hideable: false, groupable: false },
  { id: 'taxable', header: 'Taxable', kind: 'money', value: (r) => r.taxable, width: 140, aggregate: 'sum' },
  { id: 'igst', header: 'IGST', kind: 'money', value: (r) => r.igst, width: 124, aggregate: 'sum' }
])

const EMPTY_MANUAL: Gst3bManualInput = {
  itcRevRul: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  itcRevOth: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  itcReclaimed: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  interest: { igst: 0, cgst: 0, sgst: 0, cess: 0 },
  lateFee: { camt: 0, samt: 0 }
}

type ManualHead = 'itcRevRul' | 'itcRevOth' | 'itcReclaimed' | 'interest'
const MANUAL_HEADS: { key: ManualHead; label: string }[] = [
  { key: 'itcRevRul', label: '4(B)(1) ITC reversed — rules 38/42/43 (s.17(5) credit is added automatically)' },
  { key: 'itcRevOth', label: '4(B)(2) ITC reversed — others (rule 37, 37A …)' },
  { key: 'itcReclaimed', label: '4(D)(1) ITC reclaimed (reversed under 4(B)(2) earlier; also added to 4(A)(5))' },
  { key: 'interest', label: '5.1 Interest payable' }
]

function ManualAdjustments({ period }: { period: string }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: saved, isLoading } = useQuery({
    queryKey: ['gst3bManual', period],
    queryFn: () => api.gst.get3bManual(period)
  })
  const [draft, setDraft] = useState<Gst3bManualInput | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(null), [period])
  const value = draft ?? saved ?? EMPTY_MANUAL
  const dirty = draft != null && JSON.stringify(draft) !== JSON.stringify(saved ?? EMPTY_MANUAL)

  const setPart = (head: ManualHead, field: 'igst' | 'cgst' | 'sgst' | 'cess', paise: number | null): void => {
    setDraft({ ...value, [head]: { ...value[head], [field]: paise ?? 0 } })
  }

  const doSave = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      await api.gst.set3bManual(period, draft)
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['gst3bManual'] })
      await queryClient.invalidateQueries({ queryKey: ['gstr3b'] })
      toast.push('success', 'Manual adjustments saved — 3B figures recomputed')
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) return <SkeletonRows rows={4} />

  return (
    <div className="px-3 py-2">
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Adjustment (entered by you, applied to this period)</th>
            <th className="r w-32">IGST</th>
            <th className="r w-32">CGST</th>
            <th className="r w-32">SGST</th>
            <th className="r w-32">Cess</th>
          </tr>
        </thead>
        <tbody data-testid="rows-gstr3b-manual">
          {MANUAL_HEADS.map((h) => (
            <tr key={h.key}>
              <td>{h.label}</td>
              {(['igst', 'cgst', 'sgst', 'cess'] as const).map((f) => (
                <td key={f} className="r">
                  <AmountInput
                    paise={value[h.key][f]}
                    onPaise={(p) => setPart(h.key, f, p)}
                    testId={`input-3b-${h.key.toLowerCase()}-${f}`}
                    ariaLabel={`${h.label} — ${f.toUpperCase()}`}
                  />
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td>5.1 Late fee (CGST/SGST heads only on the portal)</td>
            <td className="r text-muted">–</td>
            <td className="r">
              <AmountInput
                paise={value.lateFee.camt}
                onPaise={(p) => setDraft({ ...value, lateFee: { ...value.lateFee, camt: p ?? 0 } })}
                testId="input-3b-latefee-camt"
                ariaLabel="5.1 Late fee — CGST"
              />
            </td>
            <td className="r">
              <AmountInput
                paise={value.lateFee.samt}
                onPaise={(p) => setDraft({ ...value, lateFee: { ...value.lateFee, samt: p ?? 0 } })}
                testId="input-3b-latefee-samt"
                ariaLabel="5.1 Late fee — SGST"
              />
            </td>
            <td className="r text-muted">–</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-end gap-2">
        {dirty && <span className="text-hint text-amber">Unsaved changes</span>}
        <Button variant="primary" data-testid="btn-gstr3b-save-manual" disabled={!dirty || saving} onClick={() => void doSave()}>
          {saving ? 'Saving…' : 'Save adjustments'}
        </Button>
      </div>
    </div>
  )
}

export function Gstr3bScreen(): React.JSX.Element {
  const opts = useScreenOptions('gstr3b', { openOn: 'current' as OpenOn }, { openOn: ['current', 'previous'] })
  const { months, month, monthKey, setMonthKey } = useMonth(opts.options.openOn)
  const { info } = useSession()
  const toast = useToasts()
  const { data, isLoading } = useQuery({
    queryKey: ['gstr3b', month?.key],
    queryFn: () => api.gst.gstr3b(month!.from, month!.to, month!.period),
    enabled: !!month
  })

  const doExport = async (): Promise<void> => {
    if (!month) return
    try {
      const r = await api.gst.exportGstr3b(month.from, month.to, month.period)
      toast.push('success', `GSTR-3B JSON saved — ${r.jsonPath.split('/').pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const row = (
    label: string,
    v: { taxable?: number; igst: number; cgst?: number; sgst?: number; cess: number } | undefined,
    opts: { negative?: boolean; className?: string } = {}
  ): React.JSX.Element => {
    const sign = opts.negative ? -1 : 1
    const cell = (n: number | undefined): React.JSX.Element =>
      n == null ? <span className="text-muted">–</span> : <Money paise={sign * n} signed={opts.negative} />
    return (
      <tr className={opts.className}>
        <td>{label}</td>
        <td className="r">{v?.taxable != null ? <Money paise={v.taxable} /> : <span className="text-muted">–</span>}</td>
        <td className="r">{cell(v?.igst ?? 0)}</td>
        <td className="r">{cell(v?.cgst)}</td>
        <td className="r">{cell(v?.sgst)}</td>
        <td className="r">{cell(v?.cess ?? 0)}</td>
      </tr>
    )
  }

  if (!month) {
    return (
      <Page>
        <PageHeader title="GSTR-3B · Summary return" />
        <NoMonths />
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        title="GSTR-3B · Summary return"
        tabs={<GstReturnTabs current="gstr3b" />}
        controls={<MonthBar months={months} value={monthKey} onChange={setMonthKey} testId="input-gstr3b-month" />}
        actions={
          <Button variant="primary" data-testid="btn-gstr3b-export" onClick={() => void doExport()} disabled={!info?.gstin}>
            Export JSON
          </Button>
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <ReturnOptions openOn={opts.options.openOn} onOpenOn={(v) => opts.set('openOn', v)} />
              {data && data.interState.length > 0 && <OptionsTable area="gstr3b-interstate" label="3.2 inter-state table" />}
              <DrawerSection title="About the adjustments">
                <p className="text-hint text-muted">{GSTR3B_NOTE}</p>
              </DrawerSection>
            </>
          )
        }}
      />

      {!info?.gstin && (
        <Banner tone="warning" className="mb-3">
          Add the company GSTIN under Company details to enable export.
        </Banner>
      )}

      <Panel>
        {isLoading || !data ? (
          <SkeletonRows />
        ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Table</th>
              <th className="r w-32">Taxable</th>
              <th className="r w-28">IGST</th>
              <th className="r w-28">CGST</th>
              <th className="r w-28">SGST</th>
              <th className="r w-24">Cess</th>
            </tr>
          </thead>
          <tbody data-testid="rows-gstr3b">
            {row('3.1(a) Outward taxable supplies', data.outward)}
            {row('3.1(b) Zero-rated (exports + SEZ)', { taxable: data.zeroRated.taxable, igst: data.zeroRated.igst, cess: data.zeroRated.cess })}
            {row('3.1(c) Nil-rated / exempt', { taxable: data.nilExempt.taxable, igst: 0, cgst: 0, sgst: 0, cess: 0 })}
            {row('3.1(d) Inward supplies under RCM', data.rcm)}
            {row('4(A)(1) ITC — import of goods', data.itcParts.impg)}
            {row('4(A)(3) ITC — inward RCM supplies', data.itcParts.isrc)}
            {row('4(A)(5) ITC — all other (incl. s.17(5) credit and reclaims)', data.itcParts.oth)}
            {row('4(B)(1) Reversed — rules 38/42/43 and s.17(5)', data.manual.itcRevRul, { negative: true })}
            {row('4(B)(2) Reversed — others (rule 37 …)', data.manual.itcRevOth, { negative: true })}
            {row('4(C) Net eligible ITC', data.itc, { className: 'total-row' })}
            {row('4(D)(1) ITC reclaimed (reversed under 4(B)(2) earlier)', data.itcParts.blocked)}
            {row('5.1 Interest payable (manual, below)', data.manual.interest)}
            {row('5.1 Late fee (manual, below)', { igst: 0, cgst: data.manual.lateFee.camt, sgst: data.manual.lateFee.samt, cess: 0 })}
          </tbody>
        </table>
        )}
      </Panel>

      {data && data.interState.length > 0 && (
        <Panel className="mt-section">
          <p className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">3.2 Inter-state supplies to unregistered persons</p>
          <DataTable
            viewId="gstr3b-interstate"
            testId="gstr3b-interstate"
            ariaLabel="3.2 Inter-state supplies to unregistered persons"
            columns={INTERSTATE_COLUMNS}
            rows={data.interState}
            rowKey={(r) => r.pos}
            maxHeight="none"
            exportOptions={{
              title: 'GSTR-3B 3.2 — inter-state supplies to unregistered persons',
              periodLabel: month.label,
              filename: `gstr3b-interstate-${month.period}`
            }}
          />
        </Panel>
      )}

      {data && (
        <Panel className="mt-section">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Set-off (sec 49/49A order: IGST credit first, cess only against cess)</th>
                <th className="r w-28">IGST</th>
                <th className="r w-28">CGST</th>
                <th className="r w-28">SGST</th>
                <th className="r w-24">Cess</th>
              </tr>
            </thead>
            <tbody data-testid="rows-gstr3b-setoff">
              <tr>
                <td>Output tax liability (3.1(a) + 3.1(b))</td>
                <td className="r"><Money paise={data.outward.igst + data.zeroRated.igst} /></td>
                <td className="r"><Money paise={data.outward.cgst} /></td>
                <td className="r"><Money paise={data.outward.sgst} /></td>
                <td className="r"><Money paise={data.outward.cess + data.zeroRated.cess} /></td>
              </tr>
              <tr>
                <td>Less: ITC set off (4(C))</td>
                <td className="r"><Money paise={-(data.outward.igst + data.zeroRated.igst - data.netPayable.igst)} signed /></td>
                <td className="r"><Money paise={-(data.outward.cgst - data.netPayable.cgst)} signed /></td>
                <td className="r"><Money paise={-(data.outward.sgst - data.netPayable.sgst)} signed /></td>
                <td className="r"><Money paise={-(data.outward.cess + data.zeroRated.cess - data.netPayable.cess)} signed /></td>
              </tr>
              <tr className="total-row">
                <td>Net payable in cash</td>
                <td className="r"><Money paise={data.netPayable.igst} /></td>
                <td className="r"><Money paise={data.netPayable.cgst} /></td>
                <td className="r"><Money paise={data.netPayable.sgst} /></td>
                <td className="r"><Money paise={data.netPayable.cess} /></td>
              </tr>
              <tr>
                <td>RCM payable — cash only, never set off against ITC (3.1(d))</td>
                <td className="r"><Money paise={data.rcmPayable.igst} /></td>
                <td className="r"><Money paise={data.rcmPayable.cgst} /></td>
                <td className="r"><Money paise={data.rcmPayable.sgst} /></td>
                <td className="r"><Money paise={data.rcmPayable.cess} /></td>
              </tr>
            </tbody>
          </table>
        </Panel>
      )}

      <Panel className="mt-section">
        <ManualAdjustments period={month.period} />
      </Panel>

      <p className="mt-2 text-hint text-muted">Manual adjustments are saved per period and folded into the exported JSON · F12 for options.</p>
    </Page>
  )
}
