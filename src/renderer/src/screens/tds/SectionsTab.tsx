// Sections tab: the section master with its effective-dated rate editor (WP 3.1), the
// deductees (type from the PAN or set on the ledger) and lower-deduction certificates per party.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger, TdsCertificateRow, TdsRate, TdsSection } from '@shared/domain'
import { DEDUCTEE_TYPE_LABELS, deducteeTypeFromPan, type RateDeducteeType } from '@shared/tds'
import { formatPaise } from '@shared/money'
import { toDisplayDate, todayISO } from '@shared/dates'
import { KIND_WORDS, useKind, withholdingApi, KindContext } from './common'
import { useToasts } from '../../state/stores'
import { AmountInput, Badge, Button, Field, Modal, Money, Panel, SectionTitle, Select, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerPicker, useLedgers } from '../../components/pickers'
import { LedgerLink } from '../../components/links'
import { openLedgerStatement, useCanEditMasters } from '../../lib/drill'
import { confirmDialog } from '../../lib/dialogs'

const optionalMoney = (paise: number): React.JSX.Element => (paise > 0 ? <Money paise={paise} /> : <span className="text-muted">—</span>)

export const SECTION_COLUMNS = defineColumns<TdsSection>([
  { id: 'code', header: 'Code', kind: 'text', value: (s) => s.code, className: 'num', width: 90, hideable: false, groupable: false },
  { id: 'description', header: 'Description', kind: 'text', value: (s) => s.description, groupable: false },
  { id: 'reference', header: '2025 Act', kind: 'text', value: (s) => s.newReference, width: 170, text: (s) => s.newReference ?? '—', className: 'text-muted' },
  { id: 'rate', header: 'Rate today', kind: 'number', value: (s) => s.rate, text: (s) => `${s.rate}%`, width: 100 },
  {
    id: 'single', header: 'Single limit', kind: 'money', value: (s) => s.thresholdSingle,
    text: (s) => (s.thresholdSingle > 0 ? formatPaise(s.thresholdSingle) : '—'), cell: (s) => optionalMoney(s.thresholdSingle), width: 136
  },
  {
    id: 'annual', header: 'Aggregate limit', kind: 'money', value: (s) => s.thresholdAnnual,
    text: (s) => (s.thresholdAnnual > 0 ? formatPaise(s.thresholdAnnual) : '—'), cell: (s) => optionalMoney(s.thresholdAnnual), width: 144
  }
])

interface DeducteeRow {
  ledgerId: number
  name: string
  pan: string | null
  explicitType: Ledger['deducteeType']
  panType: ReturnType<typeof deducteeTypeFromPan>
  sectionCode: string | null
  certificates: number
}

const DEDUCTEE_COLUMNS = defineColumns<DeducteeRow>([
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.name, hideable: false, groupable: false, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.name} /> },
  {
    id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, width: 150, className: 'num',
    text: (r) => r.pan ?? 'Missing', cell: (r) => (r.pan ? <span className="num">{r.pan}</span> : <Badge tone="danger">Missing — higher rate</Badge>)
  },
  {
    id: 'type', header: 'Deductee type', kind: 'text', width: 230,
    value: (r) => (r.explicitType ? DEDUCTEE_TYPE_LABELS[r.explicitType] : r.panType ? DEDUCTEE_TYPE_LABELS[r.panType] : null),
    text: (r) => (r.explicitType ? `${DEDUCTEE_TYPE_LABELS[r.explicitType]} (set)` : r.panType ? `${DEDUCTEE_TYPE_LABELS[r.panType]} (from PAN)` : 'Unknown — highest rate'),
    cell: (r) =>
      r.explicitType ? (
        <span>{DEDUCTEE_TYPE_LABELS[r.explicitType]} <span className="text-muted">· set on ledger</span></span>
      ) : r.panType ? (
        <span>{DEDUCTEE_TYPE_LABELS[r.panType]} <span className="text-muted">· from PAN</span></span>
      ) : (
        <span className="text-muted">Unknown — highest rate applies</span>
      )
  },
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, width: 96, className: 'num', text: (r) => r.sectionCode ?? '—' },
  { id: 'certs', header: 'Certificates', kind: 'number', value: (r) => r.certificates, width: 110 }
])

function SectionsBody(): React.JSX.Element {
  const k = useKind()
  const w = KIND_WORDS[k]
  const wapi = withholdingApi(k)
  void w

  const canEdit = useCanEditMasters()
  const ledgers = useLedgers()
  const { data: sections } = useQuery({ queryKey: [`${k}Sections`], queryFn: wapi.sections })
  const { data: certificates } = useQuery({ queryKey: [k, 'certificates'], queryFn: () => wapi.certificates() })
  const [editing, setEditing] = useState<TdsSection | 'new' | null>(null)
  const [cert, setCert] = useState<TdsCertificateRow | 'new' | null>(null)
  const codeOf = useMemo(() => new Map((sections ?? []).map((s) => [s.id, s.code])), [sections])
  const nameOf = useMemo(() => new Map(ledgers.map((l) => [l.id, l.name])), [ledgers])

  const deductees = useMemo<DeducteeRow[]>(() => {
    const certCount = new Map<number, number>()
    for (const c of certificates ?? []) certCount.set(c.ledgerId, (certCount.get(c.ledgerId) ?? 0) + 1)
    return ledgers
      .filter((l) => (k === 'tcs' ? l.tcsSectionId != null : l.tdsSectionId != null || l.deducteeType != null) || certCount.has(l.id))
      .map((l) => ({
        ledgerId: l.id, name: l.name, pan: l.pan, explicitType: l.deducteeType, panType: deducteeTypeFromPan(l.pan),
        sectionCode: (k === 'tcs' ? l.tcsSectionId : l.tdsSectionId) != null ? (codeOf.get((k === 'tcs' ? l.tcsSectionId : l.tdsSectionId)!) ?? null) : null, certificates: certCount.get(l.id) ?? 0
      }))
  }, [ledgers, certificates, codeOf])

  const certColumns = useMemo(
    () =>
      defineColumns<TdsCertificateRow>([
        { id: 'party', header: 'Party', kind: 'text', value: (c) => nameOf.get(c.ledgerId) ?? '', hideable: false, cell: (c) => <LedgerLink ledgerId={c.ledgerId} name={nameOf.get(c.ledgerId) ?? ''} /> },
        { id: 'number', header: 'Certificate no.', kind: 'text', value: (c) => c.certificateNo, width: 150, className: 'num' },
        { id: 'section', header: 'Section', kind: 'text', value: (c) => (c.sectionId != null ? (codeOf.get(c.sectionId) ?? '') : 'All'), width: 90 },
        { id: 'rate', header: 'Rate', kind: 'number', value: (c) => c.rateBp / 100, text: (c) => `${c.rateBp / 100}%`, width: 80 },
        { id: 'from', header: 'Valid from', kind: 'date', value: (c) => c.validFrom },
        { id: 'to', header: 'Valid to', kind: 'date', value: (c) => c.validTo },
        { id: 'cap', header: 'Amount cap', kind: 'money', value: (c) => c.capPaise ?? 0, text: (c) => (c.capPaise == null ? 'No cap' : formatPaise(c.capPaise)), width: 140 },
        {
          id: 'status', header: 'Status', kind: 'enum', width: 110,
          options: [{ value: 'valid', label: 'In force' }, { value: 'expired', label: 'Expired' }, { value: 'future', label: 'Not yet' }],
          value: (c) => (c.validTo < todayISO() ? 'expired' : c.validFrom > todayISO() ? 'future' : 'valid'),
          cell: (c) => (c.validTo < todayISO() ? <Badge>Expired</Badge> : c.validFrom > todayISO() ? <Badge tone="info">Not yet</Badge> : <Badge tone="success">In force</Badge>)
        }
      ]),
    [nameOf, codeOf]
  )

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="px-3 pt-3">
          <SectionTitle
            as="h3"
            right={canEdit && <Button size="sm" data-testid={`btn-${k}-section-new`} onClick={() => setEditing('new')}>New section</Button>}
          >
            Sections and rates
          </SectionTitle>
        </div>
        <DataTable
          viewId={`${k}-sections`}
          testId={`${k}-sections`}
          ariaLabel={`${w.name} sections`}
          columns={SECTION_COLUMNS}
          rows={sections ?? []}
          rowKey={(s) => s.id}
          onRowActivate={canEdit ? (s) => setEditing(s) : undefined}
          maxHeight="40vh"
          empty={{ title: 'No sections yet', hint: 'Add one — e.g. 194C Contractors' }}
          trailingWidth={canEdit ? 64 : 0}
          trailing={canEdit ? (s) => (
            <button data-testid={`btn-${k}-section-edit-${s.id}`} className="text-small text-blue hover:underline" onClick={() => setEditing(s)}>
              Edit
            </button>
          ) : undefined}
        />
        <p className="px-3 py-2 text-hint text-muted">
          {k === 'tcs'
            ? 'Each rate row is effective-dated and cites its source (hover a row in the rate editor): s.206C of the 1961 Act as amended by Finance Act 2025, and s.394 of the 2025 Act as amended by Finance Act 2026. Without a PAN the higher of twice the rate and 5% applies (s.206CC, at most 20%). Have them checked by your CA.'
            : 'Each rate row is effective-dated by deductee type and cites its source (hover a row in the rate editor). Figures are sourced from the Income-tax Act 1961 / Finance Act 2025 and the Income-tax Act 2025 — have them checked by your CA.'}
        </p>
      </Panel>

      <Panel>
        <div className="px-3 pt-3">
          <SectionTitle as="h3">{w.party}s</SectionTitle>
        </div>
        <DataTable
          viewId={`${k}-deductees`}
          testId={`${k}-deductees`}
          ariaLabel={`${w.name} ${w.party.toLowerCase()}s`}
          columns={DEDUCTEE_COLUMNS}
          rows={deductees}
          rowKey={(r) => r.ledgerId}
          rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
          onRowActivate={(r) => openLedgerStatement(r.ledgerId)}
          maxHeight="40vh"
          empty={k === 'tcs' ? { title: 'No buyer is flagged for TCS', hint: 'Set a TCS section (and PAN) on the customer ledger, or a goods category on the stock item' } : { title: 'No party is flagged for TDS', hint: 'Set a TDS section (and PAN) on the supplier ledger' }}
          exportOptions={{ title: `${w.name} ${w.party.toLowerCase()}s`, periodLabel: `as on ${toDisplayDate(todayISO())}`, filename: `${k}-deductees` }}
        />
        <p className="px-3 py-2 text-hint text-muted">
          The deductee type defaults from the PAN&apos;s fourth character (P/H individual or HUF, C company, F firm, others); set it on the ledger to
          override. A party without a PAN or type pays the highest rate in force for its section.
        </p>
      </Panel>

      <Panel>
        <div className="px-3 pt-3">
          <SectionTitle as="h3" right={canEdit && <Button size="sm" data-testid={`btn-${k}-cert-new`} onClick={() => setCert('new')}>New certificate</Button>}>
            Lower-deduction certificates
          </SectionTitle>
        </div>
        <DataTable
          viewId={`${k}-certificates`}
          testId={`${k}-certificates`}
          ariaLabel="Lower-deduction certificates"
          columns={certColumns}
          rows={certificates ?? []}
          rowKey={(c) => c.id}
          onRowActivate={canEdit ? (c) => setCert(c) : undefined}
          maxHeight="40vh"
          empty={{ title: 'No certificates', hint: k === 'tcs' ? 'Record a section 206C(9) lower-collection certificate the buyer gave you' : 'Record a section 197 certificate the deductee gave you' }}
          trailingWidth={canEdit ? 64 : 0}
          trailing={canEdit ? (c) => (
            <button data-testid={`btn-${k}-cert-edit-${c.id}`} className="text-small text-blue hover:underline" onClick={() => setCert(c)}>
              Edit
            </button>
          ) : undefined}
        />
      </Panel>

      {editing && <SectionModal section={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {cert && <CertificateModal cert={cert === 'new' ? null : cert} sections={sections ?? []} onClose={() => setCert(null)} />}
    </div>
  )
}

// ---------- section editor ----------

interface SectionForm {
  id?: number
  code: string
  description: string
  /** Percent, kept as a string while editing (rates like 0.1% are valid). */
  rate: string
  thresholdSingle: number | null
  thresholdAnnual: number | null
}

function SectionModal({ section, onClose }: { section: TdsSection | null; onClose: () => void }): React.JSX.Element {
  const k = useKind()
  const w = KIND_WORDS[k]
  const wapi = withholdingApi(k)
  void w

  const toast = useToasts()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SectionForm>(() =>
    section
      ? {
          id: section.id, code: section.code, description: section.description, rate: String(section.rate),
          thresholdSingle: section.thresholdSingle || null, thresholdAnnual: section.thresholdAnnual || null
        }
      : { code: '', description: '', rate: '', thresholdSingle: null, thresholdAnnual: null }
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    const rate = Number(form.rate)
    if (!form.code.trim()) return setError('Section code is required (e.g. 194C)')
    if (!form.description.trim()) return setError('Description is required')
    if (form.rate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100) return setError('Rate must be between 0 and 100%')
    setError(null)
    setSaving(true)
    try {
      await wapi.sectionSave({
        ...(form.id != null ? { id: form.id } : {}),
        code: form.code.trim(), description: form.description.trim(), rate,
        thresholdSingle: form.thresholdSingle ?? 0, thresholdAnnual: form.thresholdAnnual ?? 0
      })
      await queryClient.invalidateQueries({ queryKey: [`${k}Sections`] })
      toast.push('success', form.id != null ? 'Section updated' : 'Section added')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={section ? `Section ${section.code}` : `New ${w.name} section`} onClose={onClose} wide>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Code" hint="e.g. 194C">
          <TextInput data-testid={`input-${k}-section-code`} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="Description">
          <TextInput data-testid={`input-${k}-section-desc`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Rate %" hint="Today's rate for an unknown deductee">
          <TextInput data-testid={`input-${k}-section-rate`} className="num" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
        </Field>
        <Field label="Single-payment threshold" hint="Blank = none">
          <AmountInput paise={form.thresholdSingle} onPaise={(p) => setForm({ ...form, thresholdSingle: p })} />
        </Field>
        <Field label="Aggregate threshold" hint="Blank = none">
          <AmountInput paise={form.thresholdAnnual} onPaise={(p) => setForm({ ...form, thresholdAnnual: p })} />
        </Field>
      </div>
      {error && <p className="mt-2 text-body-sm text-cr">{error}</p>}
      {form.id != null && <RatesEditor sectionId={form.id} />}
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button data-testid={`btn-${k}-section-save`} variant="primary" disabled={saving} onClick={() => void save()}>
          {form.id != null ? 'Save section' : 'Add section'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- lower-deduction certificate editor ----------

function CertificateModal({ cert, sections, onClose }: { cert: TdsCertificateRow | null; sections: TdsSection[]; onClose: () => void }): React.JSX.Element {
  const k = useKind()
  const w = KIND_WORDS[k]
  const wapi = withholdingApi(k)
  void w

  const toast = useToasts()
  const queryClient = useQueryClient()
  const [ledgerId, setLedgerId] = useState<number | null>(cert?.ledgerId ?? null)
  const [sectionId, setSectionId] = useState<number | null>(cert?.sectionId ?? null)
  const [no, setNo] = useState(cert?.certificateNo ?? '')
  const [rate, setRate] = useState(cert ? String(cert.rateBp / 100) : '')
  const [from, setFrom] = useState(cert?.validFrom ?? todayISO())
  const [to, setTo] = useState(cert?.validTo ?? '')
  const [cap, setCap] = useState<number | null>(cert?.capPaise ?? null)
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: [k] })

  const save = async (): Promise<void> => {
    const r = Number(rate)
    if (ledgerId == null) return void toast.push('error', `Pick the ${w.party.toLowerCase()}`)
    if (!no.trim()) return void toast.push('error', 'Certificate number is required')
    if (rate.trim() === '' || !Number.isFinite(r) || r < 0 || r > 100) return void toast.push('error', 'Rate must be between 0 and 100%')
    try {
      await wapi.certificateSave({
        ...(cert ? { id: cert.id } : {}), ledgerId, sectionId, certificateNo: no.trim(), rateBp: Math.round(r * 100),
        validFrom: from, validTo: to, capPaise: cap
      })
      await refresh()
      toast.push('success', 'Certificate saved')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const remove = async (): Promise<void> => {
    if (!cert) return
    const ok = await confirmDialog({ title: 'Delete certificate', message: `Delete certificate ${cert.certificateNo}? Deductions already made keep their rate.`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await wapi.certificateDelete(cert.id)
      await refresh()
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={cert ? `Certificate ${cert.certificateNo}` : 'New lower-deduction certificate'} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label={w.party}>
            <LedgerPicker value={ledgerId} onPick={setLedgerId} placeholder="Party" testId={`picker-${k}-cert-party`} />
          </Field>
        </div>
        <Field label="Section" hint="Blank = every section">
          <Select value={sectionId ?? ''} onChange={(e) => setSectionId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All sections</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.code}</option>
            ))}
          </Select>
        </Field>
        <Field label="Certificate no.">
          <TextInput data-testid={`input-${k}-cert-no`} value={no} onChange={(e) => setNo(e.target.value)} />
        </Field>
        <Field label="Rate %" hint="0 = nil deduction">
          <TextInput data-testid={`input-${k}-cert-rate`} className="num" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="Amount cap" hint="Blank = no cap">
          <AmountInput paise={cap} onPaise={setCap} />
        </Field>
        <Field label="Valid from">
          <TextInput className="num" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="YYYY-MM-DD" />
        </Field>
        <Field label="Valid to" hint={to ? toDisplayDate(to) : undefined}>
          <TextInput data-testid={`input-${k}-cert-to`} className="num" value={to} onChange={(e) => setTo(e.target.value)} placeholder="YYYY-MM-DD" />
        </Field>
      </div>
      <div className="mt-3 flex justify-between gap-2">
        <div>{cert && <Button variant="danger" onClick={() => void remove()}>Delete</Button>}</div>
        <div className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid={`btn-${k}-cert-save`} onClick={() => void save()}>Save certificate</Button>
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
  /** TCS: the base includes the GST charged. */
  gstInBase: boolean
}

const blankRate = (kind: 'tds' | 'tcs'): RateForm => ({
  effectiveFrom: todayISO(), effectiveTo: '', deducteeType: 'any', rate: '', single: null, annual: null,
  basis: 'fy', excessOnly: false, noPan: kind === 'tcs' ? '5' : '20', returnCode: '', gstInBase: kind === 'tcs'
})

const pct = (bp: number): string => `${bp / 100}%`

/** The section's rate rows by date and deductee type — every seeded figure is editable here;
 *  seeded rows show their statutory citation on hover. Owner-only server-side (tds:rateSave). */
function RatesEditor({ sectionId }: { sectionId: number }): React.JSX.Element {
  const k = useKind()
  const w = KIND_WORDS[k]
  const wapi = withholdingApi(k)
  void w

  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: rates } = useQuery({ queryKey: [`${k}Rates`, sectionId], queryFn: () => wapi.rates(sectionId) })
  const [form, setForm] = useState<RateForm | null>(null)

  const edit = (r: TdsRate): void =>
    setForm({
      id: r.id, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? '', deducteeType: r.deducteeType,
      rate: String(r.rateBp / 100), single: r.thresholdSinglePaise || null, annual: r.thresholdAnnualPaise || null,
      basis: r.thresholdBasis, excessOnly: r.thresholdExcessOnly, noPan: String(r.noPanRateBp / 100), returnCode: r.returnCode ?? '',
      gstInBase: !!r.baseIncludesGst
    })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: [`${k}Rates`, sectionId] })
    await queryClient.invalidateQueries({ queryKey: [`${k}Sections`] })
  }

  const save = async (): Promise<void> => {
    if (!form) return
    const rate = Number(form.rate)
    const noPan = Number(form.noPan)
    if (form.rate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100) return void toast.push('error', 'Rate must be between 0 and 100%')
    if (!Number.isFinite(noPan) || noPan < 0 || noPan > 100) return void toast.push('error', 'No-PAN rate must be between 0 and 100%')
    try {
      await wapi.rateSave({
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
        returnCode: form.returnCode.trim() || null,
        ...(k === 'tcs' ? { baseIncludesGst: form.gstInBase } : {})
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
      await wapi.rateDelete(id)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mt-4" data-testid={`${k}-rates`}>
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
          <Field label={w.party}>
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
            {k === 'tcs' ? 'Collect' : 'Deduct'} only on the amount above the aggregate threshold
          </label>
          {k === 'tcs' && (
            <label className="col-span-2 flex items-center gap-2 text-body-sm">
              <input type="checkbox" checked={form.gstInBase} onChange={(e) => setForm({ ...form, gstInBase: e.target.checked })} />
              Base includes the GST charged
            </label>
          )}
          <div className="flex items-end justify-end gap-2">
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()}>Save rate</Button>
          </div>
        </div>
      ) : (
        <Button className="mt-2" onClick={() => setForm(blankRate(k))}>+ Add rate</Button>
      )}
    </div>
  )
}

/** The Sections tab for a kind (TDS by default; the TCS screen passes 'tcs'). */
export function SectionsTab({ kind = 'tds' }: { kind?: 'tds' | 'tcs' } = {}): React.JSX.Element {
  return (
    <KindContext.Provider value={kind}>
      <SectionsBody />
    </KindContext.Provider>
  )
}
