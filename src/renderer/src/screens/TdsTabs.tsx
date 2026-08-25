/**
 * The two newer TDS tabs, kept out of Tds.tsx so the deduction summary that screen has always
 * been stays readable:
 *   • Certificates — the section 197 / 197A register (Rule 28AA), with each certificate's ceiling
 *     and how much of it is left.
 *   • 26AS — the section 199 / Rule 37BA credit reconciliation against the department's record.
 *
 * Statutory positions checked on 2026-08-25; the reasoning lives with the engines, in
 * @shared/tds/lowerDeduction and @shared/tds/form26as.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Recon26asBucket } from '@shared/tds/form26as'
import { api } from '../lib/client'
import { useToasts } from '../state/stores'
import {
  AmountInput, Button, DateInput, EmptyState, Field, Modal, Money, Panel, TextInput, useTableNav
} from '../components/ui'
import { fyOf, fyFromStartYear, todayISO, toDisplayDate } from '@shared/dates'

// ---------- certificates (s.197 / 197A, Rule 28AA) ----------

interface CertForm {
  id?: number
  certificateNumber: string
  pan: string
  sectionCode: string
  /** Percent as typed — an AO certificate at 0.35% is ordinary, and 0 (nil) is meaningful. */
  rate: string
  validFrom: string
  validTo: string
  /** Rule 28AA(4) ceiling. Null = the AO named no amount; that is NOT the same as zero. */
  ceilingPaise: number | null
  notes: string
}

const blankCert = (): CertForm => {
  const fy = fyOf(todayISO())
  return {
    certificateNumber: '',
    pan: '',
    sectionCode: '',
    rate: '',
    // Rule 28AA(5): a certificate runs for the financial year named on it unless cancelled, so
    // the current FY is the right default rather than today's date.
    validFrom: `${fy.startYear}-04-01`,
    validTo: `${fy.startYear + 1}-03-31`,
    ceilingPaise: null,
    notes: ''
  }
}

/** A status pill. `tone` picks a semantic token — never a palette colour. */
function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'spent'; children: React.ReactNode }): React.JSX.Element {
  const cls =
    tone === 'spent'
      ? 'border-cr/40 bg-cr/10 text-cr'
      : tone === 'warn'
        ? 'border-warnline/40 bg-warnsoft text-warn'
        : 'border-line bg-panel2 text-muted'
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-hint ${cls}`}>{children}</span>
}

/**
 * The section 197 register: what the Assessing Officer issued, and how much of each certificate
 * is left.
 *
 * The ceiling is the column that matters. Rule 28AA(4) makes a certificate valid only up to the
 * amount named on it, and once cumulative payments cross that amount the ordinary section rate
 * resumes — inside the very payment that crosses it. A register showing only the rate would let
 * someone keep deducting at 0.5% long after the certificate stopped covering it, and the
 * shortfall is the deductor's own liability under s.201(1), with interest under s.201(1A).
 */
export function CertificatesTab(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<CertForm>(blankCert())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const today = todayISO()

  const { data: certificates } = useQuery({ queryKey: ['tdsCertificates'], queryFn: api.tds.certificates })
  const rows = certificates ?? []

  const edit = (c: (typeof rows)[number]): void => {
    setError(null)
    setForm({
      id: c.id,
      certificateNumber: c.certificateNumber,
      pan: c.pan,
      sectionCode: c.sectionCode,
      rate: String(c.ratePercent),
      validFrom: c.validFrom,
      validTo: c.validTo,
      ceilingPaise: c.ceilingPaise,
      notes: c.notes ?? ''
    })
  }
  const certTable = useTableNav(rows, { rowId: (c) => c.id, onEnter: (c) => edit(c) })

  const refresh = async (): Promise<void> => {
    // A certificate changes what every future deduction computes to, so the deduction summary is
    // re-asked as well — it is not keyed on this list.
    await queryClient.invalidateQueries({ queryKey: ['tdsCertificates'] })
    await queryClient.invalidateQueries({ queryKey: ['tdsSummary'] })
  }

  const save = async (): Promise<void> => {
    const rate = Number(form.rate)
    if (!form.certificateNumber.trim()) return setError('Certificate number is required — the 26Q return quotes it')
    if (!/^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(form.pan.trim())) {
      return setError('A valid PAN is required — Rule 28AA(2) does not let a certificate exist without one')
    }
    if (!form.sectionCode.trim()) return setError('Section is required (e.g. 194C) — a certificate covers one section only')
    if (form.rate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return setError('Rate must be between 0 and 100% (0 = nil deduction)')
    }
    if (form.validFrom > form.validTo) return setError('Valid-from must not be after valid-to')
    setError(null)
    setSaving(true)
    try {
      await api.tds.certificateSave(
        {
          certificateNumber: form.certificateNumber.trim().toUpperCase(),
          pan: form.pan.trim().toUpperCase(),
          sectionCode: form.sectionCode.trim().toUpperCase(),
          ratePercent: rate,
          validFrom: form.validFrom,
          validTo: form.validTo,
          ceilingPaise: form.ceilingPaise,
          notes: form.notes.trim() === '' ? null : form.notes.trim()
        },
        form.id
      )
      await refresh()
      toast.push('success', form.id != null ? 'Certificate updated' : 'Certificate added')
      setForm(blankCert())
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number): Promise<void> => {
    try {
      await api.tds.certificateDelete(id)
      await refresh()
      if (form.id === id) setForm(blankCert())
      toast.push('success', 'Certificate deleted — future deductions revert to the section rate')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Panel>
        {rows.length === 0 ? (
          <EmptyState
            title="No lower-deduction certificates on file"
            hint="Add the certificate the Assessing Officer issued under section 197 — or a Form 15G/15H declaration under 197A, as a nil-rate certificate."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Certificate</th>
                <th scope="col" className="w-32">PAN</th>
                <th scope="col" className="w-20">Section</th>
                <th scope="col" className="r w-20">Rate</th>
                <th scope="col" className="w-48">Valid</th>
                <th scope="col" className="r w-32">Ceiling</th>
                <th scope="col" className="r w-32">Used</th>
                <th scope="col" className="r w-32">Left</th>
                <th scope="col" className="w-36">Status</th>
                <th scope="col" className="w-28"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-tds-certificates">
              {rows.map((c, i) => {
                const lapsed = c.validTo < today
                const notYet = c.validFrom > today
                return (
                  <tr
                    key={c.id}
                    {...certTable.rowProps(i, c)}
                    className={`${certTable.rowProps(i, c).className} ${form.id === c.id ? 'bg-accentbar/15' : ''}`}
                    data-exhausted={c.exhausted ? 'true' : 'false'}
                  >
                    <td className="num">{c.certificateNumber}</td>
                    <td className="num">{c.pan}</td>
                    <td className="num">{c.sectionCode}</td>
                    <td className="r num">{c.ratePercent}%</td>
                    <td className="num text-muted">
                      {toDisplayDate(c.validFrom)} – {toDisplayDate(c.validTo)}
                    </td>
                    <td className="r">
                      {c.ceilingPaise === null ? (
                        <span className="text-muted">Uncapped</span>
                      ) : (
                        <Money paise={c.ceilingPaise} />
                      )}
                    </td>
                    <td className="r"><Money paise={c.usedPaise} /></td>
                    <td className="r">
                      {c.headroomPaise === null ? <span className="text-muted">—</span> : <Money paise={c.headroomPaise} />}
                    </td>
                    <td>
                      {c.exhausted ? (
                        <Pill tone="spent">Ceiling spent</Pill>
                      ) : lapsed ? (
                        <Pill tone="warn">Lapsed</Pill>
                      ) : notYet ? (
                        <Pill tone="warn">Not yet in force</Pill>
                      ) : (
                        <Pill tone="ok">In force</Pill>
                      )}
                    </td>
                    <td className="r">
                      <button
                        data-testid={`btn-tds-cert-edit-${c.id}`}
                        className="text-small text-blue hover:underline"
                        onClick={() => edit(c)}
                      >
                        Edit
                      </button>
                      <button
                        data-testid={`btn-tds-cert-delete-${c.id}`}
                        className="ml-2 text-small text-cr hover:underline"
                        onClick={() => void remove(c.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {rows.some((c) => c.exhausted) && (
        <div
          className="rounded-md border border-cr/40 bg-cr/5 px-3.5 py-2.5 text-body-sm"
          data-testid="note-tds-cert-exhausted"
        >
          A ceiling has been spent. Under Rule 28AA(4) the certificate stops applying at the amount
          named on it, so further payments to that payee are deducted at the ordinary section rate —
          including the part of a single payment that crosses the ceiling.
        </div>
      )}

      <Panel className="p-3">
        <p className="mb-2 text-body-sm font-medium text-ink">
          {form.id != null ? `Edit ${form.certificateNumber}` : 'New certificate'}
        </p>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Certificate no." hint="As printed on the TRACES certificate">
            <TextInput
              data-testid="input-tds-cert-number"
              className="num"
              value={form.certificateNumber}
              onChange={(e) => setForm({ ...form, certificateNumber: e.target.value })}
            />
          </Field>
          <Field label="PAN of payee" hint="Rule 28AA(2) — no PAN, no certificate">
            <TextInput
              data-testid="input-tds-cert-pan"
              className="num"
              value={form.pan}
              onChange={(e) => setForm({ ...form, pan: e.target.value })}
            />
          </Field>
          <Field label="Section" hint="e.g. 194C — one section per certificate">
            <TextInput
              data-testid="input-tds-cert-section"
              className="num"
              value={form.sectionCode}
              onChange={(e) => setForm({ ...form, sectionCode: e.target.value })}
            />
          </Field>
          <Field label="Rate %" hint="0 = nil (s.197A / Form 15G-15H)">
            <TextInput
              data-testid="input-tds-cert-rate"
              className="num"
              value={form.rate}
              onChange={(e) => setForm({ ...form, rate: e.target.value })}
            />
          </Field>
          <Field label="Valid from">
            <DateInput
              testId="input-tds-cert-from"
              value={form.validFrom}
              context={form.validFrom}
              onChange={(iso) => setForm({ ...form, validFrom: iso })}
            />
          </Field>
          <Field label="Valid to">
            <DateInput
              testId="input-tds-cert-to"
              value={form.validTo}
              context={form.validTo}
              onChange={(iso) => setForm({ ...form, validTo: iso })}
            />
          </Field>
          <Field label="Ceiling amount" hint="Blank = the AO named no amount">
            <AmountInput
              testId="input-tds-cert-ceiling"
              paise={form.ceilingPaise}
              onPaise={(p) => setForm({ ...form, ceilingPaise: p })}
            />
          </Field>
          <Field label="Notes">
            <TextInput
              data-testid="input-tds-cert-notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </div>
        {error && <p className="mt-2 text-body-sm text-cr">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          {form.id != null && (
            <Button
              onClick={() => {
                setError(null)
                setForm(blankCert())
              }}
            >
              Cancel edit
            </Button>
          )}
          <Button data-testid="btn-tds-cert-save" variant="primary" disabled={saving} onClick={() => void save()}>
            {form.id != null ? 'Save certificate' : 'Add certificate'}
          </Button>
        </div>
      </Panel>

      <p className="text-hint text-muted">
        A certificate applies to one payee (by PAN) and one section, inside its validity window and
        up to its ceiling. Anything outside any of those three is deducted at the ordinary rate.
      </p>
    </div>
  )
}

// ---------- 26AS (s.199 / Rule 37BA) ----------

const BUCKETS_26AS: { key: Recon26asBucket; label: string }[] = [
  { key: 'matched', label: 'Matched' },
  { key: 'amountMismatch', label: 'Amount mismatch' },
  { key: 'dateDrift', label: 'Date drift' },
  { key: 'missingInStatement', label: 'Not in 26AS' },
  { key: 'missingInBooks', label: 'Not in books' }
]

function Paste26asModal({
  onClose,
  onApply
}: {
  onClose: () => void
  onApply: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <Modal title="Paste Form 26AS" onClose={onClose}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        autoFocus
        data-testid="input-26as-paste"
        placeholder="Paste the Part A table from the 26AS / AIS export, headers included…"
        className="num w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-caption"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="btn-26as-paste-apply"
          disabled={text.trim().length < 2}
          onClick={() => {
            onApply(text)
            onClose()
          }}
        >
          Reconcile
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Reconcile the department's record of tax deducted against us with what the books claim.
 *
 * Both directions are findings, so both are shown: credit the books claim and 26AS does not
 * support is cash the taxpayer will not get (section 199 grants credit on the department's
 * record, not on ours), and a 26AS row with no book entry behind it is a receipt nobody recorded.
 *
 * The loaded statement lives in this component's state and nowhere else — see the note at the top
 * of src/main/services/form26as.ts on why a downloaded 26AS is never stored.
 */
export function Form26asTab({ fyStartYear }: { fyStartYear: number }): React.JSX.Element {
  const toast = useToasts()
  const [source, setSource] = useState<{ text: string; label: string } | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [bucket, setBucket] = useState<Recon26asBucket>('missingInStatement')
  const from = `${fyStartYear}-04-01`
  const to = `${fyStartYear + 1}-03-31`

  const { data, isFetching } = useQuery({
    queryKey: ['tds26as', from, to, source?.text],
    queryFn: () => api.tds.recon26as(source!.text, from, to),
    enabled: !!source
  })

  const doPick = async (): Promise<void> => {
    try {
      const r = await api.tds.pick26as()
      if (!r) return
      setSource({ text: r.text, label: r.fileName })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const result = data?.result
  const pairs = result?.pairs.filter((p) => p.bucket === bucket) ?? []

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button data-testid="btn-26as-pick" onClick={() => void doPick()}>
          Load 26AS file…
        </Button>
        <Button variant="ghost" data-testid="btn-26as-paste" onClick={() => setPasteOpen(true)}>
          Paste 26AS…
        </Button>
        <span className="text-hint text-muted">
          FY {fyFromStartYear(fyStartYear).label} · the statement is read and discarded, never stored
        </span>
      </div>

      {pasteOpen && (
        <Paste26asModal
          onClose={() => setPasteOpen(false)}
          onApply={(text) => setSource({ text, label: 'Pasted 26AS' })}
        />
      )}

      {!source ? (
        <Panel>
          <EmptyState
            title="Load a Form 26AS to check the TDS credit the books claim"
            hint="On the e-filing portal: e-File → Income Tax Returns → View Form 26AS, export Part A, then load or paste it here."
          />
        </Panel>
      ) : isFetching && !result ? (
        <Panel>
          <EmptyState title="Reconciling…" />
        </Panel>
      ) : data && result ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Panel className="p-3">
              <p className="text-hint text-muted uppercase">Credit at risk</p>
              <p className="text-figure text-cr" data-testid="figure-26as-at-risk">
                <Money paise={result.creditAtRiskPaise} />
              </p>
              <p className="mt-1 text-hint text-muted">
                Claimed in the books, not deposited against this PAN — section 199 grants the credit on the deposit.
              </p>
            </Panel>
            <Panel className="p-3">
              <p className="text-hint text-muted uppercase">In 26AS, not in books</p>
              <p className="text-figure text-ink" data-testid="figure-26as-unrecorded">
                <Money paise={result.unrecordedCreditPaise} />
              </p>
              <p className="mt-1 text-hint text-muted">
                Tax the department can already see, against receipts the books have never recorded.
              </p>
            </Panel>
            <Panel className="p-3">
              <p className="text-hint text-muted uppercase">Compared</p>
              <p className="text-figure text-ink" data-testid="figure-26as-compared">
                {data.bookEntries.length} / {data.statementRows.length}
              </p>
              <p className="mt-1 text-hint text-muted">
                Book entries against 26AS rows, {toDisplayDate(from)} – {toDisplayDate(to)}.
              </p>
            </Panel>
          </div>

          {data.problems.length > 0 && (
            <div
              className="rounded-md border border-warnline/40 bg-warnsoft px-3.5 py-2.5 text-body-sm text-warn"
              data-testid="note-26as-problems"
            >
              {data.problems.slice(0, 4).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              {data.problems.length > 4 && <p>…and {data.problems.length - 4} more.</p>}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {BUCKETS_26AS.map((b) => {
              const t = result.buckets[b.key]
              return (
                <button
                  key={b.key}
                  data-testid={`btn-26as-bucket-${b.key}`}
                  onClick={() => setBucket(b.key)}
                  className={`rounded-md border px-3 py-1.5 text-body-sm ${
                    bucket === b.key
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-line text-muted hover:bg-panel2 hover:text-ink'
                  }`}
                >
                  {b.label} <span className="num">{t.count}</span> · <Money paise={t.tdsPaise} />
                </button>
              )
            })}
          </div>

          <Panel>
            {pairs.length === 0 ? (
              <EmptyState title="Nothing in this bucket" />
            ) : (
              <div className="overflow-x-auto">
                <table className="ledger-table min-w-[56rem]">
                  <thead>
                    <tr>
                      <th scope="col" colSpan={5}>26AS (the department&rsquo;s record)</th>
                      <th scope="col" colSpan={3}>Books</th>
                      <th scope="col" className="r w-24">Diff</th>
                    </tr>
                    <tr>
                      <th scope="col">Deductor</th>
                      <th scope="col" className="w-32">TAN</th>
                      <th scope="col" className="w-20">Section</th>
                      <th scope="col" className="w-24">Date</th>
                      <th scope="col" className="r w-28">Tax</th>
                      <th scope="col" className="w-24">Date</th>
                      <th scope="col" className="r w-28">Gross</th>
                      <th scope="col" className="r w-28">TDS claimed</th>
                      <th scope="col" className="r">TDS diff</th>
                    </tr>
                  </thead>
                  <tbody data-testid="rows-26as-pairs">
                    {pairs.map((p, i) => (
                      <tr key={i}>
                        <td>
                          {p.statement?.deductorName || p.book?.deductorName || <span className="text-muted">—</span>}
                          {p.notes.length > 0 && <span className="block text-hint text-muted">{p.notes.join(' · ')}</span>}
                        </td>
                        <td className="num text-muted">{p.statement?.deductorTan ?? '—'}</td>
                        <td className="num text-muted">{p.statement?.section || p.book?.section || '—'}</td>
                        <td className="num text-muted">{p.statement?.date ? toDisplayDate(p.statement.date) : '—'}</td>
                        <td className="r">{p.statement ? <Money paise={p.statement.taxDeductedPaise} /> : '—'}</td>
                        <td className="num text-muted">{p.book ? toDisplayDate(p.book.date) : '—'}</td>
                        <td className="r">{p.book ? <Money paise={p.book.amountPaise} /> : '—'}</td>
                        <td className="r">{p.book ? <Money paise={p.book.tdsPaise} /> : '—'}</td>
                        <td className="r">{p.tdsDiffPaise != null ? <Money paise={p.tdsDiffPaise} signed /> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <p className="text-hint text-muted">
            {source.label} · Credit is granted under section 199 read with Rule 37BA from the
            department&rsquo;s record, so a deduction missing from 26AS is chased with the deductor
            rather than corrected here.
          </p>
        </>
      ) : null}
    </div>
  )
}
