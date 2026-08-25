import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type IsdCreditInput } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import {
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  Select,
  SkeletonRows,
  TextInput
} from '../components/ui'
import { confirmDialog } from '../lib/dialogs'
import { toDisplayDate } from '@shared/dates'
import { formatPaise, parseRupees, plainRupees } from '@shared/money'
import { rule28BasisLabel, type Rule28Basis } from '@shared/gst/branchTransfer'
import { gstr6DueDate, headsTotal, type CreditHeads } from '@shared/gst/isd'

/**
 * The two tabs the multi-GSTIN book needed and did not have (roadmap #108 and #355).
 *
 * Both are documents, and neither posts. The branch-transfer invoice moves output tax into one
 * registration's return and input credit into another's; the ISD moves credit between two of the
 * business's own electronic credit ledgers. In both cases the books are unchanged, and both tabs
 * say so on the face rather than leaving the user to infer it from a trial balance that did not
 * move.
 *
 * Neither renders on a single-registration book. There is nothing there to transfer between and
 * nothing to distribute to, and asking a question with no answer is the thing #108 set out not to
 * do.
 */

const BASES: Rule28Basis[] = ['declared-full-itc', 'open-market', 'like-kind', 'ninety-percent', 'cost-110']

// ---------------------------------------------------------------------------------------------
// #108 — the branch-transfer invoice
// ---------------------------------------------------------------------------------------------

export function BranchTransferTab(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [basis, setBasis] = useState<Rule28Basis>('declared-full-itc')
  const [fullItc, setFullItc] = useState(true)
  const [declared, setDeclared] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['branchTransferRegister', from, to],
    queryFn: () => api.branchTransfer.register(from, to)
  })

  const pending = data?.pending ?? []
  const issued = data?.issued ?? []
  const skipped = data?.skipped ?? []

  // The bases the books cannot answer need a number from the user, and the button stays off until
  // there is one. An invoice valued at "nothing was supplied" is not a lesser invoice, it is wrong.
  const needsValue = basis === 'open-market' || basis === 'like-kind' || basis === 'ninety-percent'
  const declaredPaise = declared.trim() ? parseRupees(declared) : null
  const canIssue = pending.length > 0 && (!needsValue || (declaredPaise !== null && declaredPaise > 0))

  const issue = async (): Promise<void> => {
    try {
      const r = await api.branchTransfer.issue({
        from,
        to,
        basis,
        recipientFullItc: fullItc,
        declaredPaise: basis === 'ninety-percent' ? null : declaredPaise,
        recipientPricePaise: basis === 'ninety-percent' ? declaredPaise : null
      })
      await queryClient.invalidateQueries({ queryKey: ['branchTransferRegister'] })
      await queryClient.invalidateQueries({ queryKey: ['gstValidate'] })
      toast.push(
        'success',
        r.issued.length === 0
          ? 'Nothing to raise — every cross-registration movement in this period already has an invoice'
          : `${r.issued.length} branch-transfer invoice${r.issued.length === 1 ? '' : 's'} raised. The books are unchanged.`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const print = async (id: number): Promise<void> => {
    try {
      await api.branchTransfer.pdf(id)
      toast.push('success', 'Branch-transfer invoice written to the exports folder')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const withdraw = async (id: number, number: string): Promise<void> => {
    const ok = await confirmDialog({
      title: `Withdraw ${number}?`,
      message: 'The movement goes back to the list awaiting an invoice. The serial is not reused.',
      confirmLabel: 'Withdraw'
    })
    if (!ok) return
    try {
      await api.branchTransfer.remove(id)
      await queryClient.invalidateQueries({ queryKey: ['branchTransferRegister'] })
      await queryClient.invalidateQueries({ queryKey: ['gstValidate'] })
      toast.push('success', 'Invoice withdrawn')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (data && !data.multiRegistration) {
    return (
      <EmptyState
        title="This company has one GST registration"
        hint="A branch transfer is a supply between two registrations of the same PAN. With one, there is nowhere for stock to go that would be a supply."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">
          Why these need an invoice
        </div>
        <p className="px-3 py-2 text-body-sm text-muted">
          Schedule I para 2 of the CGST Act makes a supply between distinct persons a supply even when nothing is
          sold and no money moves, and section 25(4) makes two registrations of one PAN distinct persons. So the
          sending registration raises a tax invoice, values it under rule 28, and reports it in its GSTR-1; the
          receiving registration takes the credit. A rule 55 delivery challan does not cover it.
          <br />
          <b className="text-ink">Nothing here posts.</b> One business, one set of books: the transfer creates
          output tax in one return and input credit in the other, but no revenue, no expense and no change in
          stock value. Your trial balance, P&amp;L and closing stock are the same after you raise these as before.
        </p>
      </Panel>

      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Rule 28 — the value</div>
        <div className="flex flex-wrap items-end gap-3 px-3 py-3">
          <Field label="Valuation basis">
            <Select
              data-testid="select-bt-basis"
              value={basis}
              onChange={(e) => setBasis(e.target.value as Rule28Basis)}
              className="w-72"
            >
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {rule28BasisLabel(b)}
                </option>
              ))}
            </Select>
          </Field>
          {needsValue ? (
            <Field
              label={basis === 'ninety-percent' ? 'Recipient’s onward price (₹)' : 'Value (₹)'}
              hint={
                basis === 'ninety-percent'
                  ? '90% of this is the taxable value. Split across the lines pro rata on book value.'
                  : 'The books do not hold an open market value. Type the one you are using.'
              }
            >
              <TextInput
                data-testid="input-bt-value"
                value={declared}
                onChange={(e) => setDeclared(e.target.value)}
                className="w-40"
                inputMode="decimal"
              />
            </Field>
          ) : basis === 'declared-full-itc' ? (
            <Field label="Value (₹)" hint="Blank uses the book value of the stock moved, which is the usual answer.">
              <TextInput
                data-testid="input-bt-value"
                value={declared}
                onChange={(e) => setDeclared(e.target.value)}
                className="w-40"
                inputMode="decimal"
              />
            </Field>
          ) : null}
          <label className="flex items-center gap-2 pb-2 text-body-sm text-muted">
            <input
              type="checkbox"
              data-testid="check-bt-full-itc"
              checked={fullItc}
              onChange={(e) => setFullItc(e.target.checked)}
            />
            The receiving registration takes full input tax credit
          </label>
          <Button
            data-testid="btn-bt-issue"
            variant="primary"
            disabled={!canIssue}
            disabledTitle={
              pending.length === 0
                ? 'Nothing is awaiting an invoice in this period'
                : 'This basis needs a value the books do not hold — type one'
            }
            onClick={() => void issue()}
            className="mb-2"
          >
            Raise {pending.length > 0 ? pending.length : ''} invoice{pending.length === 1 ? '' : 's'}
          </Button>
        </div>
        {basis === 'declared-full-itc' ? (
          <p className="border-t border-line px-3 py-2 text-small text-muted">
            Second proviso to rule 28: where the recipient is entitled to full input tax credit, the value declared
            in the invoice is <i>deemed</i> to be the open market value. Most branch transfers between two
            registrations of one business are in exactly that position, which makes the honest answer “the value you
            put on it” rather than something the app computes for you.
          </p>
        ) : null}
      </Panel>

      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Awaiting an invoice</div>
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : pending.length === 0 ? (
          <EmptyState
            title="Every cross-registration movement in this period is invoiced"
            hint="Stock that moves between two of your own registrations is a supply under Schedule I para 2."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Date</th>
                <th scope="col" className="w-28">Journal</th>
                <th scope="col">From → to</th>
                <th scope="col" className="w-20">Supply</th>
                <th scope="col" className="r w-36">Book value</th>
                <th scope="col" className="r w-32">Tax at book value</th>
              </tr>
            </thead>
            <tbody data-testid="rows-bt-pending">
              {pending.map((p) => (
                <tr key={`${p.voucherId}-${p.fromRegistrationId}-${p.toRegistrationId}`}>
                  <td className="num">{toDisplayDate(p.date)}</td>
                  <td className="num">{p.number}</td>
                  <td>
                    {p.fromGstin ?? p.fromStateCode} → {p.toGstin ?? p.toStateCode}
                  </td>
                  <td className="text-muted">{p.supplyType === 'intra' ? 'CGST+SGST' : 'IGST'}</td>
                  <td className="r">
                    <Money paise={p.bookValue} />
                  </td>
                  <td className="r">
                    <Money paise={p.estimatedTax} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Issued</div>
        {issued.length === 0 ? (
          <EmptyState title="No branch-transfer invoices issued for this period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-44">Number</th>
                <th scope="col" className="w-28">Date</th>
                <th scope="col">From → to</th>
                <th scope="col" className="r w-32">Taxable</th>
                <th scope="col" className="r w-28">Tax</th>
                <th scope="col" className="w-40"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-bt-issued">
              {issued.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.number}</td>
                  <td className="num">{toDisplayDate(r.date)}</td>
                  <td>
                    {r.fromGstin ?? r.fromStateCode} → {r.toGstin ?? r.toStateCode}
                  </td>
                  <td className="r">
                    <Money paise={r.taxable} />
                  </td>
                  <td className="r">
                    <Money paise={r.igst + r.cgst + r.sgst + r.cess} />
                  </td>
                  <td className="flex gap-1">
                    <Button variant="ghost" onClick={() => void print(r.id)}>
                      Print
                    </Button>
                    <Button variant="ghost" onClick={() => void withdraw(r.id, r.number)}>
                      Withdraw
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {skipped.length > 0 ? (
        <Panel>
          <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">
            Movements this app will not invoice
          </div>
          <div data-testid="rows-bt-skipped">
            {skipped.map((sk) => (
              <div key={sk.voucherId} className="border-b border-line px-3 py-2 text-body-sm last:border-0">
                <span className="num">{sk.number}</span> · {toDisplayDate(sk.date)}
                <div className="text-muted">{sk.reason}</div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// #355 — Input Service Distributor
// ---------------------------------------------------------------------------------------------

const EMPTY_CREDIT: IsdCreditInput = {
  date: '',
  supplierName: '',
  supplierGstin: null,
  invoiceNumber: '',
  description: null,
  taxable: 0,
  igst: 0,
  cgst: 0,
  sgst: 0,
  cess: 0,
  eligibility: 'eligible',
  attribution: 'all',
  recipientRegistrationIds: [],
  reverseCharge: false
}

const headsLabel = (h: CreditHeads): string =>
  [h.igst && `IGST ${formatPaise(h.igst)}`, h.cgst && `CGST ${formatPaise(h.cgst)}`, h.sgst && `SGST ${formatPaise(h.sgst)}`, h.cess && `Cess ${formatPaise(h.cess)}`]
    .filter(Boolean)
    .join(' · ') || '—'

export function IsdTab(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [month, setMonth] = useState(() => to.slice(0, 7))
  const [editing, setEditing] = useState<IsdCreditInput | null>(null)

  const { data: regs } = useQuery({ queryKey: ['gstRegistrations'], queryFn: () => api.gstReg.list() })
  const { data, isLoading } = useQuery({ queryKey: ['isdDesk', month], queryFn: () => api.isd.desk(month) })

  const dueDate = useMemo(() => gstr6DueDate(month), [month])
  const recipients = data?.recipients ?? []
  const credits = data?.credits ?? []
  const issued = data?.issued ?? []
  const preview = data?.preview ?? null

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['isdDesk'] })
    await queryClient.invalidateQueries({ queryKey: ['gstRegistrations'] })
  }

  const setIsd = async (id: number | null): Promise<void> => {
    try {
      await api.isd.setRegistration(id)
      await refresh()
      toast.push('success', id === null ? 'ISD registration cleared' : 'ISD registration set')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const saveCredit = async (input: IsdCreditInput): Promise<void> => {
    try {
      await api.isd.saveCredit(input)
      setEditing(null)
      await refresh()
      toast.push('success', 'Credit recorded')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const removeCredit = async (id: number): Promise<void> => {
    try {
      await api.isd.deleteCredit(id)
      await refresh()
      toast.push('success', 'Credit removed')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const distribute = async (): Promise<void> => {
    try {
      const r = await api.isd.distribute(month)
      await refresh()
      toast.push(
        'success',
        `${r.invoices.length} ISD invoice${r.invoices.length === 1 ? '' : 's'} issued for ${month}. Nothing was posted.`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const withdraw = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `Withdraw the ${month} distribution?`,
      message: 'The ISD invoices are deleted and the credits go back to undistributed. The serials are not reused.',
      confirmLabel: 'Withdraw'
    })
    if (!ok) return
    try {
      await api.isd.withdraw(month)
      await refresh()
      toast.push('success', 'Distribution withdrawn')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (data && !data.multiRegistration) {
    return (
      <EmptyState
        title="This company has one GST registration"
        hint="An ISD distributes common input credit to the other registrations on the same PAN. With one there is nothing to distribute to."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">
          What an ISD is for, and what is not verified
        </div>
        <p className="px-3 py-2 text-body-sm text-muted">
          A common bill — the audit fee, a software subscription, head-office rent — names one GSTIN, and the credit
          belongs to all of them. The ISD receives those invoices and distributes the credit in the ratio rule 39
          fixes: the recipient’s turnover in the State over the total, for the relevant period. Distribution is
          monthly and GSTR-6 is due by the 13th.
          <br />
          <b className="text-ink">Needs verification.</b> The commencement date of the 2024 substitution of sections
          2(61) and 20 is taken as 1 April 2025 and has not been checked against the gazette; the clause lettering
          of substituted rule 39 is not reproduced; the treatment of compensation cess on distribution is not
          verified; and the GSTR-6 table numbering below is the shape of the working, not a claim about the current
          form. Nothing here writes a portal file. Check the apportionment against the rule before you file.
          <br />
          <b className="text-ink">Nothing here posts.</b> Distribution moves credit between two of your own
          electronic credit ledgers. The trial balance does not move.
        </p>
      </Panel>

      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">The ISD registration</div>
        <div className="flex flex-wrap items-end gap-3 px-3 py-3">
          <Field label="Registered as ISD" hint="Section 24(viii) — an ISD registers as one, separately.">
            <Select
              data-testid="select-isd-registration"
              value={data?.isd?.id ?? ''}
              onChange={(e) => void setIsd(e.target.value ? Number(e.target.value) : null)}
              className="w-80"
            >
              <option value="">— none —</option>
              {(regs ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.stateCode} · {r.tradeName} {r.gstin ? `— ${r.gstin}` : '— unregistered'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Distribution month" hint={`GSTR-6 due ${toDisplayDate(dueDate)}`}>
            <TextInput
              data-testid="input-isd-month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-32"
              placeholder="YYYY-MM"
            />
          </Field>
        </div>
        {data?.blocked ? (
          <p data-testid="text-isd-blocked" className="border-t border-line px-3 py-2 text-body-sm text-warn">
            {data.blocked}
          </p>
        ) : null}
      </Panel>

      <Panel>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-body-sm font-medium text-ink">Invoices received centrally</span>
          <Button
            data-testid="btn-isd-add-credit"
            disabled={!data?.isd}
            disabledTitle="Mark a registration as the ISD first"
            onClick={() => setEditing({ ...EMPTY_CREDIT, date: `${month}-01` })}
          >
            Record an invoice
          </Button>
        </div>
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : credits.length === 0 ? (
          <EmptyState title={`No credit recorded for ${month}`} hint="The bills the ISD received and will distribute." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Date</th>
                <th scope="col">Supplier</th>
                <th scope="col" className="w-32">Invoice</th>
                <th scope="col" className="w-24">Eligibility</th>
                <th scope="col" className="w-24">Goes to</th>
                <th scope="col" className="r w-44">Credit</th>
                <th scope="col" className="w-28"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-isd-credits">
              {credits.map((c) => (
                <tr key={c.id}>
                  <td className="num">{toDisplayDate(c.date)}</td>
                  <td>
                    {c.supplierName}
                    {c.description ? <div className="text-small text-muted">{c.description}</div> : null}
                  </td>
                  <td className="num">{c.invoiceNumber}</td>
                  <td className="text-muted">{c.eligibility === 'eligible' ? 'Eligible' : 'Ineligible'}</td>
                  <td className="text-muted">
                    {c.attribution === 'all' ? 'All' : c.attribution === 'one' ? 'One' : 'Some'}
                  </td>
                  <td className="r num">{headsLabel(c.heads)}</td>
                  <td>
                    {c.distributedMonth ? (
                      <span className="text-small text-muted">Distributed {c.distributedMonth}</span>
                    ) : (
                      <Button variant="ghost" onClick={() => void removeCredit(c.id)}>
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">
          The ratio — {data?.period.label ?? '…'}
        </div>
        {data?.period ? <p className="px-3 pt-2 text-small text-muted">{data.period.reason}</p> : null}
        {recipients.length === 0 ? (
          <EmptyState title="No recipient registrations" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col" className="w-20">State</th>
                <th scope="col" className="r w-40">Turnover</th>
                <th scope="col" className="r w-24">Share</th>
              </tr>
            </thead>
            <tbody data-testid="rows-isd-ratio">
              {recipients.map((r) => {
                const total = recipients.reduce((t, x) => t + x.turnoverPaise, 0)
                return (
                  <tr key={r.registrationId}>
                    <td>
                      {r.tradeName} {r.gstin ? <span className="text-muted">— {r.gstin}</span> : null}
                    </td>
                    <td className="num">{r.stateCode}</td>
                    <td className="r">
                      <Money paise={r.turnoverPaise} />
                      {r.turnoverDeclared ? <span className="ml-1 text-small text-muted">typed</span> : null}
                    </td>
                    <td className="r num">
                      {total > 0 ? `${((r.turnoverPaise / total) * 100).toFixed(2)}%` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {preview ? (
        <Panel>
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-body-sm font-medium text-ink">Proposed distribution for {month}</span>
            <Button data-testid="btn-isd-distribute" variant="primary" onClick={() => void distribute()}>
              Distribute {preview.invoices.length} invoice{preview.invoices.length === 1 ? '' : 's'}
            </Button>
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col" className="r w-44">Eligible</th>
                <th scope="col" className="r w-44">Ineligible</th>
              </tr>
            </thead>
            <tbody data-testid="rows-isd-preview">
              {preview.invoices.map((inv) => (
                <tr key={inv.recipient.registrationId}>
                  <td>
                    {inv.recipient.tradeName} <span className="text-muted">{inv.recipient.gstin ?? inv.recipient.stateCode}</span>
                  </td>
                  <td className="r num">{headsLabel(inv.eligible)}</td>
                  <td className="r num">{headsLabel(inv.ineligible)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.warnings.length > 0 ? (
            <ul className="border-t border-line px-3 py-2 text-small text-muted">
              {preview.warnings.map((w, i) => (
                <li key={i} className="list-inside list-disc">
                  {w}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}

      {issued.length > 0 ? (
        <Panel>
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-body-sm font-medium text-ink">Issued for {month}</span>
            <Button data-testid="btn-isd-withdraw" variant="ghost" onClick={() => void withdraw()}>
              Withdraw the month
            </Button>
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-40">Number</th>
                <th scope="col">Recipient</th>
                <th scope="col" className="r w-44">Eligible</th>
                <th scope="col" className="r w-32">Total</th>
                <th scope="col" className="w-24"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-isd-issued">
              {issued.map((inv) => (
                <tr key={inv.id}>
                  <td className="num">{inv.number}</td>
                  <td>{inv.recipientGstin ?? inv.recipientStateCode}</td>
                  <td className="r num">{headsLabel(inv.eligible)}</td>
                  <td className="r">
                    <Money paise={inv.total} />
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        void api.isd
                          .pdf(inv.id)
                          .then(() => toast.push('success', 'ISD invoice written to the exports folder'))
                          .catch((err: Error) => toast.push('error', err.message))
                      }}
                    >
                      Print
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      {editing ? <CreditModal draft={editing} recipients={recipients} onClose={() => setEditing(null)} onSave={saveCredit} /> : null}
    </div>
  )
}

function CreditModal({
  draft,
  recipients,
  onClose,
  onSave
}: {
  draft: IsdCreditInput
  recipients: { registrationId: number; tradeName: string; gstin: string | null; stateCode: string }[]
  onClose: () => void
  onSave: (input: IsdCreditInput) => Promise<void>
}): React.JSX.Element {
  const [d, setD] = useState(draft)
  const [amounts, setAmounts] = useState({
    taxable: plainRupees(draft.taxable),
    igst: plainRupees(draft.igst),
    cgst: plainRupees(draft.cgst),
    sgst: plainRupees(draft.sgst),
    cess: plainRupees(draft.cess)
  })

  const num = (v: string): number => parseRupees(v) ?? 0
  const heads = { igst: num(amounts.igst), cgst: num(amounts.cgst), sgst: num(amounts.sgst), cess: num(amounts.cess) }

  const submit = (): void => {
    void onSave({
      ...d,
      taxable: num(amounts.taxable),
      igst: heads.igst,
      cgst: heads.cgst,
      sgst: heads.sgst,
      cess: heads.cess
    })
  }

  return (
    <Modal title="Invoice received by the ISD" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Invoice date">
          <DateInput value={d.date} context={d.date} onChange={(iso) => setD({ ...d, date: iso })} testId="input-isd-date" />
        </Field>
        <Field label="Invoice number">
          <TextInput
            data-testid="input-isd-invoice-number"
            value={d.invoiceNumber}
            onChange={(e) => setD({ ...d, invoiceNumber: e.target.value })}
          />
        </Field>
        <Field label="Supplier">
          <TextInput
            data-testid="input-isd-supplier"
            value={d.supplierName}
            onChange={(e) => setD({ ...d, supplierName: e.target.value })}
          />
        </Field>
        <Field label="Supplier GSTIN">
          <TextInput
            data-testid="input-isd-supplier-gstin"
            value={d.supplierGstin ?? ''}
            onChange={(e) => setD({ ...d, supplierGstin: e.target.value || null })}
          />
        </Field>
        <Field label="What the service was">
          <TextInput
            data-testid="input-isd-description"
            value={d.description ?? ''}
            onChange={(e) => setD({ ...d, description: e.target.value || null })}
          />
        </Field>
        <Field label="Taxable value (₹)">
          <TextInput
            data-testid="input-isd-taxable"
            value={amounts.taxable}
            onChange={(e) => setAmounts({ ...amounts, taxable: e.target.value })}
            inputMode="decimal"
          />
        </Field>
        <Field label="IGST (₹)">
          <TextInput value={amounts.igst} onChange={(e) => setAmounts({ ...amounts, igst: e.target.value })} inputMode="decimal" data-testid="input-isd-igst" />
        </Field>
        <Field label="Cess (₹)">
          <TextInput value={amounts.cess} onChange={(e) => setAmounts({ ...amounts, cess: e.target.value })} inputMode="decimal" data-testid="input-isd-cess" />
        </Field>
        <Field label="CGST (₹)">
          <TextInput value={amounts.cgst} onChange={(e) => setAmounts({ ...amounts, cgst: e.target.value })} inputMode="decimal" data-testid="input-isd-cgst" />
        </Field>
        <Field label="SGST (₹)">
          <TextInput value={amounts.sgst} onChange={(e) => setAmounts({ ...amounts, sgst: e.target.value })} inputMode="decimal" data-testid="input-isd-sgst" />
        </Field>
        <Field label="Eligibility" hint="Rule 39 distributes eligible and ineligible credit as separate amounts.">
          <Select
            data-testid="select-isd-eligibility"
            value={d.eligibility}
            onChange={(e) => setD({ ...d, eligibility: e.target.value as 'eligible' | 'ineligible' })}
          >
            <option value="eligible">Eligible</option>
            <option value="ineligible">Ineligible</option>
          </Select>
        </Field>
        <Field
          label="Attributable to"
          hint="Credit attributable to one registration goes to that one whole, and is never apportioned."
        >
          <Select
            data-testid="select-isd-attribution"
            value={d.attribution}
            onChange={(e) =>
              setD({ ...d, attribution: e.target.value as 'all' | 'some' | 'one', recipientRegistrationIds: [] })
            }
          >
            <option value="all">All registrations</option>
            <option value="some">Some of them</option>
            <option value="one">One of them</option>
          </Select>
        </Field>
      </div>

      {d.attribution !== 'all' ? (
        <div className="mt-3 flex flex-wrap gap-3" data-testid="group-isd-recipients">
          {recipients.map((r) => (
            <label key={r.registrationId} className="flex items-center gap-2 text-body-sm">
              <input
                type="checkbox"
                checked={d.recipientRegistrationIds.includes(r.registrationId)}
                onChange={(e) =>
                  setD({
                    ...d,
                    recipientRegistrationIds: e.target.checked
                      ? d.attribution === 'one'
                        ? [r.registrationId]
                        : [...d.recipientRegistrationIds, r.registrationId]
                      : d.recipientRegistrationIds.filter((x) => x !== r.registrationId)
                  })
                }
              />
              {r.gstin ?? `${r.stateCode} · ${r.tradeName}`}
            </label>
          ))}
        </div>
      ) : null}

      <label className="mt-3 flex items-center gap-2 text-body-sm text-muted">
        <input
          type="checkbox"
          data-testid="check-isd-rcm"
          checked={d.reverseCharge}
          onChange={(e) => setD({ ...d, reverseCharge: e.target.checked })}
        />
        The tax on this was paid by the ISD under reverse charge (section 9(3)/9(4))
      </label>

      <p className="mt-2 text-small text-muted">
        Credit on this invoice: {headsLabel(heads)} — total {formatPaise(headsTotal(heads))}.
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button data-testid="btn-isd-save-credit" variant="primary" onClick={submit}>
          Save
        </Button>
      </div>
    </Modal>
  )
}
