import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useToasts } from '../state/stores'
import { AmountInput, Button, EmptyState, Field, Money, Panel, Select, TextInput } from '../components/ui'
import { toDisplayDate, todayISO } from '@shared/dates'

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
