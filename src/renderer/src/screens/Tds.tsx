import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TdsSection } from '@shared/domain'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { AmountInput, Button, EmptyState, Field, Modal, Money, Panel, ScrollList, SectionTitle, Select, TextInput } from '../components/ui'
import { useLedgers } from '../components/pickers'
import { fyOf, fyFromStartYear, todayISO } from '@shared/dates'
import { tdsQuarterOf } from '@shared/tds'

const QUARTERS = [1, 2, 3, 4] as const

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
  const flaggedNoPan = useMemo(() => ledgers.filter((l) => l.tdsSectionId != null && !l.pan), [ledgers])

  const qLabel = `Q${quarter} FY${fy.label}`
  const rows = (summary ?? []).filter((r) => r.quarter === qLabel)
  const totals = rows.reduce(
    (acc, r) => ({ deductees: acc.deductees + r.deductees, base: acc.base + r.base, tds: acc.tds + r.tds }),
    { deductees: 0, base: 0, tds: 0 }
  )

  const doExport = async (): Promise<void> => {
    try {
      const r = await api.tds.export26q(fyStartYear, quarter)
      toast.push('success', `26Q CSV ready (${r.path.split('/').pop()}) — import into NSDL's RPU manually, this is not a filed FVU`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <Select value={fyStartYear} onChange={(e) => setFyStartYear(Number(e.target.value))} className="w-36">
              {years.map((y) => (
                <option key={y} value={y}>
                  FY {fyFromStartYear(y).label}
                </option>
              ))}
            </Select>
            <Button data-testid="btn-tds-sections" onClick={() => setSectionsOpen(true)}>
              Sections…
            </Button>
            <Button data-testid="btn-tds-export" variant="primary" onClick={() => void doExport()}>
              Export 26Q CSV
            </Button>
          </div>
        }
      >
        TDS
      </SectionTitle>

      <div className="mb-3 flex gap-1">
        {QUARTERS.map((q) => (
          <button
            key={q}
            data-testid={`tab-tds-q${q}`}
            onClick={() => setQuarter(q)}
            className={`rounded-md px-3 py-1 text-[12.5px] ${
              quarter === q ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
            }`}
          >
            Q{q}
          </button>
        ))}
      </div>

      {flaggedNoPan.length > 0 && (
        <Panel className="mb-3">
          <div className="border-b border-line bg-amber/10 px-3 py-2 text-[12.5px] text-amber">
            {flaggedNoPan.length} part{flaggedNoPan.length > 1 ? 'ies' : 'y'} flagged for TDS with no PAN on file — the
            higher 20% rate applies
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Party</th>
                <th className="w-28">Section</th>
                <th className="w-28">PAN</th>
              </tr>
            </thead>
            <tbody data-testid="rows-tds-nopan">
              {flaggedNoPan.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="num text-muted">{(l.tdsSectionId != null && sectionCodeById.get(l.tdsSectionId)) || '—'}</td>
                  <td className="text-muted">Missing — add it in Masters</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel>
        {rows.length === 0 ? (
          <EmptyState title={`No TDS deductions in ${qLabel}`} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Section</th>
                <th className="r w-32">Deductees</th>
                <th className="r w-36">Base</th>
                <th className="r w-36">TDS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sectionCode}>
                  <td className="num">{r.sectionCode}</td>
                  <td className="r num">{r.deductees}</td>
                  <td className="r"><Money paise={r.base} /></td>
                  <td className="r"><Money paise={r.tds} /></td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="r num">{totals.deductees}</td>
                <td className="r"><Money paise={totals.base} /></td>
                <td className="r"><Money paise={totals.tds} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-[11.5px] text-muted">
        {qLabel} · The 26Q CSV lists deductee, PAN, section, voucher and amounts for manual import into NSDL's Return
        Preparation Utility — it is not a ready-to-file FVU.
      </p>

      {sectionsOpen && <SectionsModal sections={sections ?? []} onClose={() => setSectionsOpen(false)} />}
    </div>
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
        <ScrollList maxH="40vh" className="rounded-md border border-line">
          {sections.length === 0 ? (
            <EmptyState title="No sections yet" hint="Add one below — e.g. 194C Contractors at 1%" />
          ) : (
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="w-20">Code</th>
                  <th>Description</th>
                  <th className="r w-20">Rate</th>
                  <th className="r w-32">Single limit</th>
                  <th className="r w-32">Annual limit</th>
                  <th className="w-14"></th>
                </tr>
              </thead>
              <tbody data-testid="rows-tds-sections">
                {sections.map((s) => (
                  <tr key={s.id} className={form.id === s.id ? 'bg-amberbar/10' : ''}>
                    <td className="num">{s.code}</td>
                    <td>{s.description}</td>
                    <td className="r num">{s.rate}%</td>
                    <td className="r">{s.thresholdSingle > 0 ? <Money paise={s.thresholdSingle} /> : <span className="text-muted">—</span>}</td>
                    <td className="r">{s.thresholdAnnual > 0 ? <Money paise={s.thresholdAnnual} /> : <span className="text-muted">—</span>}</td>
                    <td className="r">
                      <button
                        data-testid={`btn-tds-section-edit-${s.id}`}
                        className="text-[12px] text-blue hover:underline"
                        onClick={() => edit(s)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ScrollList>

        <div>
          <p className="mb-2 text-[12.5px] font-medium text-ink">{form.id != null ? `Edit ${form.code}` : 'New section'}</p>
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
          {error && <p className="mt-2 text-[12.5px] text-cr">{error}</p>}
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
