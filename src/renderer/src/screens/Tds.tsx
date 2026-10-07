import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TdsRate, TdsSection } from '@shared/domain'
import { api, type TdsSummaryRow } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { AmountInput, Banner, Button, DrawerSection, Field, Modal, Money, Page, PageHeader, Panel, Select, TabBar, TextInput } from '../components/ui'
import { OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { useLedgers } from '../components/pickers'
import { fyOf, fyFromStartYear, todayISO } from '@shared/dates'
import { DEDUCTEE_TYPE_LABELS, tdsQuarterOf, type RateDeducteeType } from '@shared/tds'
import { formatPaise } from '@shared/money'
import { LedgerLink } from '../components/links'
import { openLedgerStatement } from '../lib/drill'

const QUARTERS = [1, 2, 3, 4] as const

interface NoPanRow {
  ledgerId: number
  name: string
  section: string | null
}

const NO_PAN_COLUMNS = defineColumns<NoPanRow>([
  {
    id: 'party',
    header: 'Party',
    kind: 'text',
    value: (r) => r.name,
    hideable: false,
    groupable: false,
    // Name → edit window (where the PAN goes); the rest of the row → statement.
    cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.name} />
  },
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.section, text: (r) => r.section ?? '—', className: 'num text-muted', width: 120 },
  { id: 'pan', header: 'PAN', kind: 'text', value: () => 'Missing — add it in Masters', className: 'text-muted', width: 220, sortable: false, filterable: false, groupable: false }
])

export const TDS_SUMMARY_COLUMNS = defineColumns<TdsSummaryRow>([
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, className: 'num', hideable: false, groupable: false },
  { id: 'deductees', header: 'Deductees', kind: 'number', value: (r) => r.deductees, width: 120, aggregate: 'sum' },
  { id: 'base', header: 'Base', kind: 'money', value: (r) => r.base, width: 150, aggregate: 'sum' },
  { id: 'tds', header: 'TDS', kind: 'money', value: (r) => r.tds, width: 150, aggregate: 'sum' }
])

const optionalMoney = (paise: number): React.JSX.Element => (paise > 0 ? <Money paise={paise} /> : <span className="text-muted">—</span>)

const SECTION_COLUMNS = defineColumns<TdsSection>([
  { id: 'code', header: 'Code', kind: 'text', value: (s) => s.code, className: 'num', width: 90, hideable: false, groupable: false },
  { id: 'description', header: 'Description', kind: 'text', value: (s) => s.description, groupable: false },
  { id: 'rate', header: 'Rate', kind: 'number', value: (s) => s.rate, text: (s) => `${s.rate}%`, width: 96 },
  {
    id: 'single',
    header: 'Single limit',
    kind: 'money',
    value: (s) => s.thresholdSingle,
    text: (s) => (s.thresholdSingle > 0 ? formatPaise(s.thresholdSingle) : '—'),
    cell: (s) => optionalMoney(s.thresholdSingle),
    width: 144
  },
  {
    id: 'annual',
    header: 'Annual limit',
    kind: 'money',
    value: (s) => s.thresholdAnnual,
    text: (s) => (s.thresholdAnnual > 0 ? formatPaise(s.thresholdAnnual) : '—'),
    cell: (s) => optionalMoney(s.thresholdAnnual),
    width: 144
  }
])

export function TdsScreen(): React.JSX.Element {
  const { info } = useSession()
  const toast = useToasts()
  const ledgers = useLedgers()
  const currentFy = fyOf(todayISO())
  const [fyStartYear, setFyStartYear] = useState(currentFy.startYear)
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>(tdsQuarterOf(todayISO()).q)
  const [sectionsOpen, setSectionsOpen] = useState(false)

  const years: number[] = []
  for (let y = currentFy.startYear; y >= (info?.booksFrom ?? currentFy.startYear); y--) years.push(y)
  const fy = fyFromStartYear(fyStartYear)

  const { data: summary } = useQuery({
    queryKey: ['tdsSummary', fyStartYear],
    queryFn: () => api.tds.summary(fyStartYear)
  })
  const { data: sections } = useQuery({ queryKey: ['tdsSections'], queryFn: api.tds.sections })
  const sectionCodeById = useMemo(() => new Map((sections ?? []).map((s) => [s.id, s.code])), [sections])

  // The summary endpoint aggregates section × quarter (deductee count, not per-deductee rows) —
  // there's no per-deductee/PAN breakdown API yet, so the missing-PAN warning surfaces at the
  // ledger-master level instead of per transaction row.
  const flaggedNoPan = useMemo<NoPanRow[]>(
    () =>
      ledgers
        .filter((l) => l.tdsSectionId != null && !l.pan)
        .map((l) => ({ ledgerId: l.id, name: l.name, section: (l.tdsSectionId != null && sectionCodeById.get(l.tdsSectionId)) || null })),
    [ledgers, sectionCodeById]
  )

  const qLabel = `Q${quarter} FY${fy.label}`
  const rows = useMemo(() => (summary ?? []).filter((r) => r.quarter === qLabel), [summary, qLabel])

  const doExport = async (): Promise<void> => {
    try {
      const r = await api.tds.export26q(fyStartYear, quarter)
      toast.push('success', `26Q CSV ready (${r.path.split('/').pop()}) — import into NSDL's RPU manually, this is not a filed FVU`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Page>
      <PageHeader
        title="TDS"
        period={qLabel}
        tabs={
          <TabBar
            screen="tds"
            label="Quarter"
            tabs={QUARTERS.map((q) => ({ id: `q${q}` as const, label: `Q${q}` }))}
            active={`q${quarter}` as const}
            onSelect={(id) => setQuarter(Number(id.slice(1)) as typeof quarter)}
          />
        }
        controls={
          <Select value={fyStartYear} onChange={(e) => setFyStartYear(Number(e.target.value))} className="w-36" aria-label="Financial year" data-testid="input-tds-fy">
            {years.map((y) => (
              <option key={y} value={y}>
                FY {fyFromStartYear(y).label}
              </option>
            ))}
          </Select>
        }
        secondary={
          <Button data-testid="btn-tds-sections" onClick={() => setSectionsOpen(true)}>
            Sections…
          </Button>
        }
        actions={
          <Button data-testid="btn-tds-export" variant="primary" onClick={() => void doExport()}>
            Export 26Q CSV
          </Button>
        }
        options={{
          content: (
            <>
              <OptionsTable area="tds-summary" label="Summary table" />
              {flaggedNoPan.length > 0 && <OptionsTable area="tds-nopan" label="Parties without PAN" />}
              <DrawerSection title="About the 26Q CSV">
                <p className="text-hint text-muted">
                  The 26Q CSV lists deductee, PAN, section, voucher and amounts for manual import into NSDL&apos;s Return Preparation
                  Utility — it is not a ready-to-file FVU.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />

      {flaggedNoPan.length > 0 && (
        <Panel className="mb-3">
          <div className="border-b border-warning/40 bg-warning-soft px-3 py-2 text-body-sm text-warning" role="status">
            {flaggedNoPan.length} part{flaggedNoPan.length > 1 ? 'ies' : 'y'} flagged for TDS with no PAN on file — the
            higher no-PAN rate applies (20%, or 5% for purchase of goods)
          </div>
          <DataTable
            viewId="tds-nopan"
            testId="tds-nopan"
            ariaLabel="Parties flagged for TDS with no PAN"
            columns={NO_PAN_COLUMNS}
            rows={flaggedNoPan}
            rowKey={(r) => r.ledgerId}
            rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
            onRowActivate={(r) => openLedgerStatement(r.ledgerId)}
            maxHeight="40vh"
            exportOptions={{ title: 'TDS parties without PAN', periodLabel: `FY ${fy.label}`, filename: 'tds-missing-pan' }}
          />
        </Panel>
      )}

      <Panel>
        <DataTable
          viewId="tds-summary"
          testId="tds-summary"
          ariaLabel={`TDS by section — ${qLabel}`}
          columns={TDS_SUMMARY_COLUMNS}
          rows={rows}
          rowKey={(r) => r.sectionCode}
          maxHeight="none"
          empty={{ title: `No TDS deductions in ${qLabel}` }}
          exportOptions={{ title: 'TDS by section', periodLabel: qLabel, filename: `tds-q${quarter}-fy${fy.label}` }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">The 26Q CSV is for manual import into NSDL&apos;s RPU — not a ready-to-file FVU.</p>

      {sectionsOpen && <SectionsModal sections={sections ?? []} onClose={() => setSectionsOpen(false)} />}
    </Page>
  )
}

// ---------- section editor modal ----------

interface SectionForm {
  id?: number
  code: string
  description: string
  /** Percent, kept as a string while editing (rates like 0.1% are valid). */
  rate: string
  thresholdSingle: number | null
  thresholdAnnual: number | null
}

const blankSection = (): SectionForm => ({ code: '', description: '', rate: '', thresholdSingle: null, thresholdAnnual: null })

/** Lists the TDS sections and lets the owner add or edit one — wires tds:sectionSave. */
function SectionsModal({ sections, onClose }: { sections: TdsSection[]; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SectionForm>(blankSection())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const edit = (s: TdsSection): void => {
    setError(null)
    setForm({
      id: s.id,
      code: s.code,
      description: s.description,
      rate: String(s.rate),
      thresholdSingle: s.thresholdSingle || null,
      thresholdAnnual: s.thresholdAnnual || null
    })
  }

  const save = async (): Promise<void> => {
    const rate = Number(form.rate)
    if (!form.code.trim()) return setError('Section code is required (e.g. 194C)')
    if (!form.description.trim()) return setError('Description is required')
    if (form.rate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100) return setError('Rate must be between 0 and 100%')
    setError(null)
    setSaving(true)
    try {
      await api.tds.sectionSave({
        ...(form.id != null ? { id: form.id } : {}),
        code: form.code.trim(),
        description: form.description.trim(),
        rate,
        thresholdSingle: form.thresholdSingle ?? 0,
        thresholdAnnual: form.thresholdAnnual ?? 0
      })
      await queryClient.invalidateQueries({ queryKey: ['tdsSections'] })
      toast.push('success', form.id != null ? 'Section updated' : 'Section added')
      setForm(blankSection())
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="TDS sections" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-md border border-line">
          <DataTable
            viewId="tds-sections"
            testId="tds-sections"
            ariaLabel="TDS sections"
            columns={SECTION_COLUMNS}
            rows={sections}
            rowKey={(s) => s.id}
            rowClassName={(s) => (form.id === s.id ? 'bg-amberbar/10' : '')}
            maxHeight="40vh"
            empty={{ title: 'No sections yet', hint: 'Add one below — e.g. 194C Contractors at 1%' }}
            toolbarFeatures={{ views: false, groupBy: false, density: false }}
            trailingWidth={64}
            trailing={(s) => (
              <button
                data-testid={`btn-tds-section-edit-${s.id}`}
                className="text-small text-blue hover:underline"
                onClick={() => edit(s)}
              >
                Edit
              </button>
            )}
          />
        </div>

        <div>
          <p className="mb-2 text-body-sm font-medium text-ink">{form.id != null ? `Edit ${form.code}` : 'New section'}</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Code" hint="e.g. 194C">
              <TextInput
                data-testid="input-tds-section-code"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <TextInput
                data-testid="input-tds-section-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
            <Field label="Rate %">
              <TextInput
                data-testid="input-tds-section-rate"
                className="num"
                value={form.rate}
                onChange={(e) => setForm({ ...form, rate: e.target.value })}
              />
            </Field>
            <Field label="Single-payment threshold" hint="Blank = none">
              <AmountInput paise={form.thresholdSingle} onPaise={(p) => setForm({ ...form, thresholdSingle: p })} />
            </Field>
            <Field label="Annual threshold" hint="Blank = none">
              <AmountInput paise={form.thresholdAnnual} onPaise={(p) => setForm({ ...form, thresholdAnnual: p })} />
            </Field>
          </div>
          {error && <p className="mt-2 text-body-sm text-cr">{error}</p>}
          {form.id != null && <RatesEditor sectionId={form.id} />}
          <div className="mt-3 flex justify-end gap-2">
            {form.id != null && (
              <Button
                onClick={() => {
                  setError(null)
                  setForm(blankSection())
                }}
              >
                Cancel edit
              </Button>
            )}
            <Button data-testid="btn-tds-section-save" variant="primary" disabled={saving} onClick={() => void save()}>
              {form.id != null ? 'Save section' : 'Add section'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---------- effective-dated rates (migration 020) ----------

const DEDUCTEE_OPTIONS: RateDeducteeType[] = ['any', 'individual_huf', 'company', 'firm', 'other']

interface RateForm {
  id?: number
  effectiveFrom: string
  effectiveTo: string
  deducteeType: RateDeducteeType
  /** Percent text (0.1 is valid). */
  rate: string
  single: number | null
  annual: number | null
  basis: 'fy' | 'month'
  excessOnly: boolean
  noPan: string
  returnCode: string
}

const blankRate = (): RateForm => ({
  effectiveFrom: todayISO(), effectiveTo: '', deducteeType: 'any', rate: '', single: null, annual: null,
  basis: 'fy', excessOnly: false, noPan: '20', returnCode: ''
})

const pct = (bp: number): string => `${bp / 100}%`

/** The section's rate rows by date and deductee type — every seeded figure is editable here;
 *  seeded rows show their statutory citation on hover. Owner-only server-side (tds:rateSave). */
function RatesEditor({ sectionId }: { sectionId: number }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rates } = useQuery({ queryKey: ['tdsRates', sectionId], queryFn: () => api.tds.rates(sectionId) })
  const [form, setForm] = useState<RateForm | null>(null)

  const edit = (r: TdsRate): void =>
    setForm({
      id: r.id, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? '', deducteeType: r.deducteeType,
      rate: String(r.rateBp / 100), single: r.thresholdSinglePaise || null, annual: r.thresholdAnnualPaise || null,
      basis: r.thresholdBasis, excessOnly: r.thresholdExcessOnly, noPan: String(r.noPanRateBp / 100), returnCode: r.returnCode ?? ''
    })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['tdsRates', sectionId] })
    await queryClient.invalidateQueries({ queryKey: ['tdsSections'] })
  }

  const save = async (): Promise<void> => {
    if (!form) return
    const rate = Number(form.rate)
    const noPan = Number(form.noPan)
    if (form.rate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100) return void toast.push('error', 'Rate must be between 0 and 100%')
    if (!Number.isFinite(noPan) || noPan < 0 || noPan > 100) return void toast.push('error', 'No-PAN rate must be between 0 and 100%')
    try {
      await api.tds.rateSave({
        ...(form.id != null ? { id: form.id } : {}),
        sectionId,
        effectiveFrom: form.effectiveFrom,
        effectiveTo: form.effectiveTo || null,
        deducteeType: form.deducteeType,
        rateBp: Math.round(rate * 100),
        thresholdSinglePaise: form.single ?? 0,
        thresholdAnnualPaise: form.annual ?? 0,
        thresholdBasis: form.basis,
        thresholdExcessOnly: form.excessOnly,
        noPanRateBp: Math.round(noPan * 100),
        returnCode: form.returnCode.trim() || null
      })
      await refresh()
      setForm(null)
      toast.push('success', 'Rate saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (id: number): Promise<void> => {
    try {
      await api.tds.rateDelete(id)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mt-4" data-testid="tds-rates">
      <p className="mb-1 text-body-sm font-medium text-ink">Rates by date</p>
      <table className="ledger-table text-body-sm">
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th>Deductee</th>
            <th className="r">Rate</th>
            <th className="r">Single</th>
            <th className="r">Aggregate</th>
            <th className="r">No PAN</th>
            <th>Code</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(rates ?? []).map((r) => (
            <tr key={r.id} title={r.source ?? 'Added by you'}>
              <td className="num">{r.effectiveFrom}</td>
              <td className="num">{r.effectiveTo ?? '—'}</td>
              <td>{DEDUCTEE_TYPE_LABELS[r.deducteeType]}</td>
              <td className="r num">{pct(r.rateBp)}</td>
              <td className="r">{optionalMoney(r.thresholdSinglePaise)}</td>
              <td className="r">
                {optionalMoney(r.thresholdAnnualPaise)}
                {r.thresholdAnnualPaise > 0 && (
                  <span className="text-caption text-muted"> /{r.thresholdBasis === 'month' ? 'month' : 'year'}{r.thresholdExcessOnly ? ', excess only' : ''}</span>
                )}
              </td>
              <td className="r num">{pct(r.noPanRateBp)}</td>
              <td className="num text-muted">{r.returnCode ?? ''}</td>
              <td className="r whitespace-nowrap">
                <button className="text-small text-blue hover:underline" onClick={() => edit(r)}>Edit</button>{' '}
                <button className="text-small text-cr hover:underline" onClick={() => void remove(r.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {form ? (
        <div className="mt-2 grid grid-cols-4 gap-2">
          <Field label="From">
            <TextInput className="num" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
          </Field>
          <Field label="To" hint="Blank = open">
            <TextInput className="num" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
          </Field>
          <Field label="Deductee">
            <Select value={form.deducteeType} onChange={(e) => setForm({ ...form, deducteeType: e.target.value as RateDeducteeType })}>
              {DEDUCTEE_OPTIONS.map((t) => (
                <option key={t} value={t}>{DEDUCTEE_TYPE_LABELS[t]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Rate %">
            <TextInput className="num" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
          </Field>
          <Field label="Single-payment threshold">
            <AmountInput paise={form.single} onPaise={(p) => setForm({ ...form, single: p })} />
          </Field>
          <Field label="Aggregate threshold">
            <AmountInput paise={form.annual} onPaise={(p) => setForm({ ...form, annual: p })} />
          </Field>
          <Field label="Aggregate over">
            <Select value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as 'fy' | 'month' })}>
              <option value="fy">Financial year</option>
              <option value="month">Month</option>
            </Select>
          </Field>
          <Field label="No-PAN rate %">
            <TextInput className="num" value={form.noPan} onChange={(e) => setForm({ ...form, noPan: e.target.value })} />
          </Field>
          <Field label="Return code">
            <TextInput className="num" value={form.returnCode} onChange={(e) => setForm({ ...form, returnCode: e.target.value })} />
          </Field>
          <label className="col-span-2 flex items-center gap-2 pt-5 text-body-sm">
            <input type="checkbox" checked={form.excessOnly} onChange={(e) => setForm({ ...form, excessOnly: e.target.checked })} />
            Deduct only on the amount above the aggregate threshold
          </label>
          <div className="flex items-end justify-end gap-2">
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()}>Save rate</Button>
          </div>
        </div>
      ) : (
        <Button className="mt-2" onClick={() => setForm(blankRate())}>+ Add rate</Button>
      )}
    </div>
  )
}
