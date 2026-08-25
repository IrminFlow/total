import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useToasts } from '../state/stores'
import type { Recon26asBucket } from '@shared/tds/form26as'
import {
  AmountInput, Button, DateInput, EmptyState, Field, Modal, Money, Panel, Select, TextInput, useTableNav
} from '../components/ui'
import { fyOf, fyFromStartYear, toDisplayDate, todayISO } from '@shared/dates'

/**
 * The three parts of the TDS year that are work rather than a read-out (roadmap #360, #361).
 *
 * Split out of Tds.tsx the way payrollTabs.tsx is split out of Payroll.tsx: the screen is a
 * selector plus four panels, and keeping all four in one file made the selector hard to find.
 */

// ---------- challans (roadmap #360) ----------

/**
 * Recording how the tax was paid.
 *
 * Nothing on a challan can be derived from the books, so all of it is typed. The list doubles as
 * the linking screen: a challan is only useful once the deductions it paid for point at it, and
 * putting that on another screen would mean two screens for one job.
 */
export function ChallansTab({ fyStartYear }: { fyStartYear: number }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: challans, isLoading } = useQuery({
    queryKey: ['tdsChallans', fyStartYear],
    queryFn: () => api.tds.challans(fyStartYear)
  })
  const [form, setForm] = useState({
    form: '26Q' as '24Q' | '26Q',
    bsrCode: '',
    paidOn: todayISO(),
    serial: '',
    tax: null as number | null,
    interest: null as number | null,
    fee: null as number | null
  })

  const save = async (): Promise<void> => {
    try {
      await api.tds.challanSave({
        form: form.form,
        bsrCode: form.bsrCode.trim(),
        paidOn: form.paidOn,
        serial: form.serial.trim(),
        tax: form.tax ?? 0,
        surcharge: 0,
        cess: 0,
        interest: form.interest ?? 0,
        fee: form.fee ?? 0,
        bookEntry: false,
        note: null
      })
      await queryClient.invalidateQueries({ queryKey: ['tdsChallans'] })
      await queryClient.invalidateQueries({ queryKey: ['tdsReturn'] })
      toast.push('success', 'Challan recorded')
      setForm({ ...form, bsrCode: '', serial: '', tax: null, interest: null, fee: null })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (id: number): Promise<void> => {
    try {
      await api.tds.challanDelete(id)
      await queryClient.invalidateQueries({ queryKey: ['tdsChallans'] })
      await queryClient.invalidateQueries({ queryKey: ['tdsReturn'] })
      toast.push('success', 'Challan removed — its deductions are unlinked, not deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        {isLoading ? (
          <div className="p-3 text-body-sm text-muted">Loading…</div>
        ) : (challans ?? []).length === 0 ? (
          <EmptyState
            title="No challans recorded"
            hint="A quarterly statement is built challan by challan. Add the BSR code, date and serial from the bank."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-20">Form</th>
                <th scope="col" className="w-28">Paid on</th>
                <th scope="col" className="w-28">BSR code</th>
                <th scope="col" className="w-24">Serial</th>
                <th scope="col" className="r w-32">Paid</th>
                <th scope="col" className="r w-32">Claimed</th>
                <th scope="col" className="r w-20">Linked</th>
                <th scope="col" className="w-16"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-tds-challans">
              {(challans ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="num">{c.form}</td>
                  <td className="num">{toDisplayDate(c.paidOn)}</td>
                  <td className="num">
                    {c.bookEntry ? 'Book entry' : c.bsrCode || <span className="text-cr">Missing</span>}
                  </td>
                  <td className="num">{c.serial || '—'}</td>
                  <td className="r">
                    <Money paise={c.tax + c.surcharge + c.cess + c.interest + c.fee} />
                  </td>
                  <td className="r">
                    <Money paise={c.claimed} />
                  </td>
                  <td className="r num">{c.linked}</td>
                  <td className="r">
                    <button
                      data-testid={`btn-tds-challan-delete-${c.id}`}
                      className="text-small text-cr hover:underline"
                      onClick={() => void remove(c.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <div className="p-3">
          <p className="mb-2 text-body-sm font-medium text-ink">Record a challan</p>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Form">
              <Select
                data-testid="select-tds-challan-form"
                value={form.form}
                onChange={(e) => setForm({ ...form, form: e.target.value as '24Q' | '26Q' })}
              >
                <option value="26Q">26Q — other than salary</option>
                <option value="24Q">24Q — salary</option>
              </Select>
            </Field>
            <Field label="Paid on">
              <TextInput
                data-testid="input-tds-challan-date"
                value={form.paidOn}
                onChange={(e) => setForm({ ...form, paidOn: e.target.value })}
              />
            </Field>
            <Field label="BSR code" hint="Seven digits, from the bank">
              <TextInput
                data-testid="input-tds-challan-bsr"
                className="num"
                value={form.bsrCode}
                onChange={(e) => setForm({ ...form, bsrCode: e.target.value })}
              />
            </Field>
            <Field label="Challan serial">
              <TextInput
                data-testid="input-tds-challan-serial"
                className="num"
                value={form.serial}
                onChange={(e) => setForm({ ...form, serial: e.target.value })}
              />
            </Field>
            <Field label="Tax">
              <AmountInput paise={form.tax} onPaise={(p) => setForm({ ...form, tax: p })} />
            </Field>
            <Field label="Interest">
              <AmountInput paise={form.interest} onPaise={(p) => setForm({ ...form, interest: p })} />
            </Field>
            <Field label="Late fee">
              <AmountInput paise={form.fee} onPaise={(p) => setForm({ ...form, fee: p })} />
            </Field>
          </div>
          <div className="mt-3 flex justify-end">
            <Button data-testid="btn-tds-challan-save" variant="primary" onClick={() => void save()}>
              Add challan
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  )
}

// ---------- the quarterly return (roadmap #360) ----------

/**
 * The statement, and everything standing between it and the utility.
 *
 * The issue list is above the deductions rather than below them because it is the reason to be on
 * this screen: a return with an unlinked deduction cannot be filed, and finding that out after
 * scrolling four hundred rows is how an afternoon disappears.
 */
export function ReturnTab({ fyStartYear, quarter }: { fyStartYear: number; quarter: 1 | 2 | 3 | 4 }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<'24Q' | '26Q'>('26Q')
  const { data: working, isLoading } = useQuery({
    queryKey: ['tdsReturn', form, fyStartYear, quarter],
    queryFn: () => api.tds.return(form, fyStartYear, quarter)
  })
  const { data: challans } = useQuery({
    queryKey: ['tdsChallans', fyStartYear],
    queryFn: () => api.tds.challans(fyStartYear)
  })

  const link = async (entryId: number, challanId: number | null): Promise<void> => {
    try {
      await api.tds.link([entryId], challanId)
      await queryClient.invalidateQueries({ queryKey: ['tdsReturn'] })
      await queryClient.invalidateQueries({ queryKey: ['tdsChallans'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const exportCsv = async (): Promise<void> => {
    try {
      const r = await api.tds.returnCsv(form, fyStartYear, quarter)
      toast.push('success', `Challan and deductee CSVs ready — ${r.deducteesPath.split(/[\\/]/).pop()}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const exportFile = async (): Promise<void> => {
    try {
      const r = await api.tds.returnFile(form, fyStartYear, quarter)
      toast.push(
        'success',
        `${r.lineCount} records written. The record layout in this build is UNVERIFIED — run it through the FVU before filing.`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const blocking = (working?.issues ?? []).filter((i) => i.severity === 'blocking')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          data-testid="select-tds-return-form"
          value={form}
          onChange={(e) => setForm(e.target.value as '24Q' | '26Q')}
          className="w-56"
        >
          <option value="26Q">26Q — other than salary</option>
          <option value="24Q">24Q — salary</option>
        </Select>
        <Button data-testid="btn-tds-return-csv" onClick={() => void exportCsv()}>
          Export working CSVs
        </Button>
        <Button data-testid="btn-tds-return-file" disabled={blocking.length > 0} onClick={() => void exportFile()}>
          Export e-TDS file…
        </Button>
        {working && <span className="text-hint text-muted">Due {toDisplayDate(working.dueDate)}</span>}
      </div>

      <Panel>
        <div className="border-b border-line bg-amber/10 px-3 py-2 text-body-sm text-amber">
          The e-TDS record layout in this build has <b>not been verified</b> against a published file format. The
          working CSVs are facts out of your books and are safe to use; the text file is a mechanism, and has to be
          validated by the FVU before it goes anywhere.
        </div>
        {isLoading ? (
          <div className="p-3 text-body-sm text-muted">Loading…</div>
        ) : (working?.issues ?? []).length === 0 ? (
          <div className="p-3 text-body-sm text-muted">Nothing standing between this quarter and the utility.</div>
        ) : (
          <ul className="flex flex-col gap-1 p-3" data-testid="rows-tds-return-issues">
            {(working?.issues ?? []).map((issue, i) => (
              <li key={i} className={`text-body-sm ${issue.severity === 'blocking' ? 'text-cr' : 'text-muted'}`}>
                <b>{issue.severity === 'blocking' ? 'Blocking' : 'Check'}:</b> {issue.message}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        {(working?.deductions ?? []).length === 0 ? (
          <EmptyState
            title={`No ${form} deductions in Q${quarter}`}
            hint="A nil statement is not required, but a declaration on TRACES is — otherwise the quarter shows as pending."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Deductee</th>
                <th scope="col" className="w-32">PAN</th>
                <th scope="col" className="w-28">Section</th>
                <th scope="col" className="w-28">Paid on</th>
                <th scope="col" className="r w-32">Amount</th>
                <th scope="col" className="r w-28">TDS</th>
                <th scope="col" className="w-56">Challan</th>
              </tr>
            </thead>
            <tbody data-testid="rows-tds-return">
              {(working?.deductions ?? []).map((d) => (
                <tr key={d.entryId}>
                  <td>{d.deducteeName}</td>
                  <td className="num">{d.pan ?? <span className="text-cr">PANNOTAVBL</span>}</td>
                  <td className="num">
                    {d.sectionCode}
                    {d.sectionUnverified && <span className="ml-1 text-hint text-amber">unverified</span>}
                  </td>
                  <td className="num">{toDisplayDate(d.paidOn)}</td>
                  <td className="r">
                    <Money paise={d.amountPaid} />
                  </td>
                  <td className="r">
                    <Money paise={d.tds} />
                  </td>
                  <td>
                    <Select
                      data-testid={`select-tds-link-${d.entryId}`}
                      value={d.challanId ?? ''}
                      onChange={(e) => void link(d.entryId, e.target.value === '' ? null : Number(e.target.value))}
                    >
                      <option value="">Not linked</option>
                      {(challans ?? [])
                        .filter((c) => c.form === form)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.bookEntry ? 'Book entry' : c.bsrCode} · {toDisplayDate(c.paidOn)} · {c.serial}
                          </option>
                        ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}

// ---------- Form 16A (roadmap #361) ----------

/**
 * The vendor's certificate.
 *
 * The TRACES caveat sits at the top of the list rather than at the bottom of the certificate,
 * because a user who prints this and posts it has already made the mistake by then.
 */
export function CertificatesTab({
  fyStartYear,
  quarter
}: {
  fyStartYear: number
  quarter: 1 | 2 | 3 | 4
}): React.JSX.Element {
  const toast = useToasts()
  const [selected, setSelected] = useState<number | null>(null)
  const { data: deductees, isLoading } = useQuery({
    queryKey: ['form16aDeductees', fyStartYear, quarter],
    queryFn: () => api.tds.form16aDeductees(fyStartYear, quarter)
  })
  const { data: certificate } = useQuery({
    queryKey: ['form16a', selected, fyStartYear, quarter],
    queryFn: () => api.tds.form16a(selected as number, fyStartYear, quarter),
    enabled: selected !== null
  })

  const print = async (): Promise<void> => {
    if (selected === null) return
    try {
      const r = await api.tds.form16aPdf(selected, fyStartYear, quarter)
      toast.push('success', `Working copy written — ${r.path.split(/[\\/]/).pop()}. The certificate itself comes from TRACES.`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="border-b border-line bg-amber/10 px-3 py-2 text-body-sm text-amber">
          Form 16A has to be downloaded from TRACES once the quarterly statement is filed — only that copy carries a
          certificate number the vendor can verify. What this produces is a <b>working copy</b> of the figures.
        </div>
        {isLoading ? (
          <div className="p-3 text-body-sm text-muted">Loading…</div>
        ) : (deductees ?? []).length === 0 ? (
          <EmptyState
            title={`Nothing deducted in Q${quarter}`}
            hint="There is no certificate to issue for a quarter with no deduction."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Deductee</th>
                <th scope="col" className="w-32">PAN</th>
                <th scope="col" className="r w-32">TDS</th>
                <th scope="col" className="w-20"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-form16a">
              {(deductees ?? []).map((d) => (
                <tr key={d.ledgerId} className={selected === d.ledgerId ? 'bg-accentbar/10' : ''}>
                  <td>{d.name}</td>
                  <td className="num">{d.pan ?? <span className="text-cr">Missing</span>}</td>
                  <td className="r">
                    <Money paise={d.tds} />
                  </td>
                  <td className="r">
                    <button
                      data-testid={`btn-form16a-open-${d.ledgerId}`}
                      className="text-small text-blue hover:underline"
                      onClick={() => setSelected(d.ledgerId)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {certificate && (
        <Panel>
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div>
              <b className="text-body-sm">{certificate.deducteeName}</b>
              <span className="ml-2 text-hint text-muted">
                {certificate.fyLabel} · {certificate.quarterLabel} · due {toDisplayDate(certificate.dueDate)}
              </span>
            </div>
            <Button data-testid="btn-form16a-pdf" variant="primary" onClick={() => void print()}>
              Working copy PDF
            </Button>
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col" className="r w-40">Amount paid</th>
                <th scope="col" className="r w-32">Tax deducted</th>
              </tr>
            </thead>
            <tbody data-testid="rows-form16a-sections">
              {certificate.bySection.map((s) => (
                <tr key={s.sectionCode}>
                  <td className="num">
                    {s.sectionCode}
                    {s.unverified && <span className="ml-1 text-hint text-amber">unverified</span>}
                  </td>
                  <td className="r">
                    <Money paise={s.amountPaid} />
                  </td>
                  <td className="r">
                    <Money paise={s.tds} />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="r">
                  <Money paise={certificate.totalPaid} />
                </td>
                <td className="r">
                  <Money paise={certificate.totalTds} />
                </td>
              </tr>
            </tbody>
          </table>
          <ul className="flex flex-col gap-1 p-3">
            {certificate.warnings.map((w, i) => (
              <li key={i} className="text-hint text-muted">
                {w}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

// =============================================================================================
// The section 197 register and the 26AS reconciliation (roadmap D-109, D-110).
//
// These arrived on their own branch in a file called `TdsTabs.tsx`, which on a case-insensitive
// filesystem is this file — so they live here. Its `CertificatesTab` was renamed
// `LowerDeductionTab`: this file already had a `CertificatesTab`, and the two are not the same
// certificate. Form 16A is what WE issue to a vendor; a section 197 certificate is what the
// Assessing Officer issues to the vendor telling US to deduct less.
//
//   • Certificates — the section 197 / 197A register (Rule 28AA), with each certificate's ceiling
//     and how much of it is left.
//   • 26AS — the section 199 / Rule 37BA credit reconciliation against the department's record.
//
// Statutory positions checked on 2026-08-25; the reasoning lives with the engines, in
// @shared/tds/lowerDeduction and @shared/tds/form26as.
// =============================================================================================

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
export function LowerDeductionTab(): React.JSX.Element {
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
