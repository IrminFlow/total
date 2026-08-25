import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Field, Money, Panel, Select, TextInput } from '../components/ui'
import { useStockItems } from '../components/pickers'
import { fyOf, toDisplayDate } from '@shared/dates'
import { GSTR1A_RESTRICTIONS } from '@shared/gst/gstr1a'

/**
 * The three statutory packs that belong on the Disclosure screen (roadmap #356, #358, #362).
 *
 * They share a shape: read-only, nothing posts, and every one of them exists because the answer
 * was always in the data and always had to be assembled by a person the week before a filing.
 */

// ---------- reverse-charge self-invoices (roadmap #356) ----------

/**
 * The document the auditor asks to see.
 *
 * `rcmAdvice` has always identified the supply; what nothing produced was the invoice section
 * 31(3)(f) requires the recipient to raise. The list is deliberately three lists: what still needs
 * a document, what has one, and what looks like reverse charge on a party nobody flagged — the
 * third being advice rather than work, because issuing a self-invoice for a supply the return does
 * not treat as reverse charge would document a liability that is not there.
 */
export function RcmSelfInvoiceTab(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [consolidate, setConsolidate] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['rcmRegister', from, to],
    queryFn: () => api.rcm.register(from, to)
  })

  const issue = async (): Promise<void> => {
    try {
      const r = await api.rcm.issue(from, to, consolidate)
      await queryClient.invalidateQueries({ queryKey: ['rcmRegister'] })
      toast.push(
        'success',
        r.issued.length === 0
          ? 'Nothing to issue — every reverse-charge purchase in this period already has a document'
          : `${r.issued.length} self-invoice${r.issued.length === 1 ? '' : 's'} issued`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const print = async (id: number): Promise<void> => {
    try {
      await api.rcm.pdf(id)
      toast.push('success', 'Self-invoice written to the exports folder')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const withdraw = async (id: number): Promise<void> => {
    try {
      await api.rcm.remove(id)
      await queryClient.invalidateQueries({ queryKey: ['rcmRegister'] })
      toast.push('success', 'Self-invoice withdrawn')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const pending = data?.pending ?? []
  const issued = data?.issued ?? []
  const unflagged = data?.unflagged ?? []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <label className="flex items-center gap-2 text-body-sm text-muted">
          <input
            type="checkbox"
            data-testid="check-rcm-consolidate"
            checked={consolidate}
            onChange={(e) => setConsolidate(e.target.checked)}
          />
          Consolidate the month for unregistered suppliers
        </label>
        <Button data-testid="btn-rcm-issue" variant="primary" disabled={pending.length === 0} onClick={() => void issue()}>
          Issue {pending.length > 0 ? pending.length : ''} self-invoice{pending.length === 1 ? '' : 's'}
        </Button>
      </div>

      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Awaiting a document</div>
        {isLoading ? (
          <div className="p-3 text-body-sm text-muted">Loading…</div>
        ) : pending.length === 0 ? (
          <EmptyState
            title="Every reverse-charge purchase is documented"
            hint="A registered buyer has to raise the invoice themselves under section 31(3)(f)."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Date</th>
                <th scope="col" className="w-28">Voucher</th>
                <th scope="col">Supplier</th>
                <th scope="col" className="w-28">Basis</th>
                <th scope="col" className="r w-36">Taxable</th>
                <th scope="col" className="r w-32">Tax</th>
              </tr>
            </thead>
            <tbody data-testid="rows-rcm-pending">
              {pending.map((p) => (
                <tr key={p.voucherId}>
                  <td className="num">{toDisplayDate(p.date)}</td>
                  <td className="num">{p.voucherNumber}</td>
                  <td>{p.supplierName}</td>
                  <td className="text-muted">{p.basis === 'unregistered' ? 'Section 9(4)' : 'Section 9(3)'}</td>
                  <td className="r">
                    <Money paise={p.taxable} />
                  </td>
                  <td className="r">
                    <Money paise={p.tax} />
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
          <EmptyState title="No self-invoices issued for this period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-40">Number</th>
                <th scope="col" className="w-28">Date</th>
                <th scope="col">Supplier</th>
                <th scope="col" className="r w-36">Taxable</th>
                <th scope="col" className="r w-32">Tax</th>
                <th scope="col" className="w-36"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-rcm-issued">
              {issued.map((d) => (
                <tr key={d.id}>
                  <td className="num">{d.number}</td>
                  <td className="num">{toDisplayDate(d.date)}</td>
                  <td>
                    {d.supplierName}
                    {d.warnings.length > 0 && (
                      <span className="ml-2 text-hint text-amber" title={d.warnings.join(' ')}>
                        {d.warnings.length} particular{d.warnings.length === 1 ? '' : 's'} missing
                      </span>
                    )}
                  </td>
                  <td className="r">
                    <Money paise={d.taxable} />
                  </td>
                  <td className="r">
                    <Money paise={d.igst + d.cgst + d.sgst + d.cess} />
                  </td>
                  <td className="r">
                    <button
                      data-testid={`btn-rcm-pdf-${d.id}`}
                      className="text-small text-blue hover:underline"
                      onClick={() => void print(d.id)}
                    >
                      PDF
                    </button>
                    <button
                      data-testid={`btn-rcm-withdraw-${d.id}`}
                      className="ml-3 text-small text-cr hover:underline"
                      onClick={() => void withdraw(d.id)}
                    >
                      Withdraw
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {unflagged.length > 0 && (
        <Panel>
          <div className="border-b border-line bg-amber/10 px-3 py-2 text-body-sm text-amber">
            These look like notified supplies on parties nobody has flagged for reverse charge. Nothing has been
            documented for them — the books do not treat them as reverse charge, and a self-invoice would evidence a
            liability the return does not carry. Flag the party to bring them in.
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Date</th>
                <th scope="col" className="w-28">Voucher</th>
                <th scope="col">Party</th>
                <th scope="col" className="w-48">Category</th>
              </tr>
            </thead>
            <tbody data-testid="rows-rcm-unflagged">
              {unflagged.map((u) => (
                <tr key={u.voucherId}>
                  <td className="num">{toDisplayDate(u.date)}</td>
                  <td className="num">{u.voucherNumber}</td>
                  <td>{u.partyName ?? '—'}</td>
                  <td className="text-muted" title={u.reason}>
                    {u.category}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  )
}

// ---------- Form 3CD data pack (roadmap #362) ----------

/**
 * Clause-wise extracts, not a filled form.
 *
 * The form is the auditor's to sign; the data is the client's to supply. The clauses that produced
 * nothing are listed with the reason underneath, because a blank page is not an answer — "no cash
 * payment breached the limit" and "we could not look" are different findings.
 */
export function Form3cdTab(): React.JSX.Element {
  const { to } = useSession()
  const toast = useToasts()
  const fyStartYear = fyOf(to).startYear
  const { data, isLoading } = useQuery({
    queryKey: ['form3cd', fyStartYear],
    queryFn: () => api.reports.form3cd(fyStartYear)
  })

  const exportCsv = async (): Promise<void> => {
    try {
      await api.reports.form3cdCsv(fyStartYear)
      toast.push('success', 'Form 3CD pack written to the exports folder')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-body-sm text-muted">
          {data ? `FY ${data.fyLabel}` : ''} · clause-wise extracts for the tax audit
        </span>
        <Button data-testid="btn-3cd-csv" variant="ghost" onClick={() => void exportCsv()}>
          CSV
        </Button>
      </div>

      {isLoading && <div className="text-body-sm text-muted">Loading…</div>}

      {(data?.extracts ?? []).map((e) => (
        <Panel key={e.clause}>
          <div className="border-b border-line px-3 py-2">
            <b className="text-body-sm">
              Clause {e.clause} — {e.title}
            </b>
            <div className="text-hint text-muted">{e.authority}</div>
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                {e.columns.map((c, i) => (
                  <th key={c} scope="col" className={i === 0 ? '' : 'r'}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody data-testid={`rows-3cd-${e.clause}`}>
              {e.rows.map((r, i) => (
                <tr key={i}>
                  {r.cells.map((cell, j) => (
                    <td key={j} className={j === 0 ? '' : 'r num'}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
              {e.total && (
                <tr className="total-row">
                  {e.total.map((cell, j) => (
                    <td key={j} className={j === 0 ? '' : 'r num'}>
                      {cell}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
          {e.caveats.length > 0 && (
            <ul className="flex flex-col gap-1 p-3">
              {e.caveats.map((c, i) => (
                <li key={i} className="text-hint text-muted">
                  {c}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ))}

      {(data?.empty ?? []).length > 0 && (
        <Panel>
          <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">
            Clauses with nothing to report, and why
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-24">Clause</th>
                <th scope="col" className="w-64">Title</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody data-testid="rows-3cd-empty">
              {(data?.empty ?? []).map((e) => (
                <tr key={e.clause}>
                  <td className="num">{e.clause}</td>
                  <td>{e.title}</td>
                  <td className="text-muted">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  )
}

// ---------- GST rate history (roadmap #358) ----------

/**
 * What is worth looking at about rates in the period.
 *
 * Three separate questions, kept separate: did the slab structure change inside the period (in
 * which case one HSN legitimately appears at two rates), does any voucher carry a rate that was
 * not notified on its own date, and does any item master still hold a withdrawn slab — the last
 * being the cause of the second.
 */
export function RateHistoryTab(): React.JSX.Element {
  const { from, to } = useSession()
  const { data, isLoading } = useQuery({
    queryKey: ['rateAdvisory', from, to],
    queryFn: () => api.gst.rateAdvisory(from, to)
  })

  if (isLoading) return <div className="text-body-sm text-muted">Loading…</div>

  const findings = data?.findings ?? []
  const stale = data?.staleMasters ?? []
  const changing = data?.itemsChangingWithin ?? []

  return (
    <div className="flex flex-col gap-3">
      {data?.structureChange && (
        <Panel>
          <div className="bg-amber/10 px-3 py-2 text-body-sm text-amber" data-testid="rate-structure-change">
            The GST rate structure changed on {toDisplayDate(data.structureChange.effectiveFrom)}, inside this period.
            One HSN can legitimately appear at two rates in this month&rsquo;s return. {data.structureChange.note}
            <div className="mt-1 text-hint">{data.structureChange.notification}</div>
          </div>
        </Panel>
      )}

      <Panel>
        <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Vouchers worth checking</div>
        {findings.length === 0 ? (
          <EmptyState title="No rate to query in this period" hint="Every rate used was a notified slab on its own invoice date." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Date</th>
                <th scope="col" className="w-28">Voucher</th>
                <th scope="col" className="w-48">Item</th>
                <th scope="col" className="r w-24">Master</th>
                <th scope="col" className="r w-24">On that date</th>
                <th scope="col">What to check</th>
              </tr>
            </thead>
            <tbody data-testid="rows-rate-findings">
              {findings.map((f, i) => (
                <tr key={`${f.voucherId}-${f.itemId}-${i}`}>
                  <td className="num">{toDisplayDate(f.date)}</td>
                  <td className="num">{f.voucherNumber}</td>
                  <td>{f.itemName}</td>
                  <td className="r num">{f.usedRate}%</td>
                  <td className="r num">{f.datedRate === null ? '—' : `${f.datedRate}%`}</td>
                  <td className="text-muted">{f.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {stale.length > 0 && (
        <Panel>
          <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">
            Item masters still on a withdrawn slab
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="r w-24">Rate</th>
                <th scope="col">Why it matters</th>
              </tr>
            </thead>
            <tbody data-testid="rows-rate-stale">
              {stale.map((m) => (
                <tr key={m.itemId}>
                  <td>{m.itemName}</td>
                  <td className="r num">{m.gstRate}%</td>
                  <td className="text-muted">{m.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {changing.length > 0 && (
        <Panel>
          <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">
            Items whose rate changes inside this period
          </div>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Changes</th>
              </tr>
            </thead>
            <tbody data-testid="rows-rate-changing">
              {changing.map((c) => (
                <tr key={c.itemId}>
                  <td>{c.itemName}</td>
                  <td className="text-muted num">
                    {c.changes.map((ch) => `${toDisplayDate(ch.effectiveFrom)} → ${ch.rate}%`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <ItemRateEditor />

      <p className="text-hint text-muted">
        The slab structure is dated data — see src/shared/gst/rateHistory.ts. The entry for the September 2025
        rationalisation is taken from the GST Council&rsquo;s recommendation and the rate notifications behind it have
        not been verified, so treat anything above as a prompt to check rather than an answer.
      </p>
    </div>
  )
}

/**
 * Recording that an item's rate changed on a date.
 *
 * The master column keeps the CURRENT rate, because that is what voucher entry prefills and what
 * an unchanged item has always answered with. This records the changes, so a back-dated voucher, a
 * credit note against an old invoice, or a return for a month either side of 22 September 2025 can
 * be checked against the rate that was actually in force.
 */
function ItemRateEditor(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const [itemId, setItemId] = useState<number | null>(null)
  const [effectiveFrom, setEffectiveFrom] = useState('2025-09-22')
  const [rate, setRate] = useState('')
  const [note, setNote] = useState('')

  const { data: history } = useQuery({
    queryKey: ['itemRates', itemId],
    queryFn: () => api.gst.itemRates(itemId as number),
    enabled: itemId !== null
  })

  const save = async (): Promise<void> => {
    if (itemId === null) return
    const parsed = Number(rate)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      toast.push('error', 'Rate must be between 0 and 100%')
      return
    }
    try {
      await api.gst.itemRateSave({ stockItemId: itemId, effectiveFrom, gstRate: parsed, cessRate: 0, note: note.trim() || null })
      await queryClient.invalidateQueries({ queryKey: ['itemRates'] })
      await queryClient.invalidateQueries({ queryKey: ['rateAdvisory'] })
      toast.push('success', 'Rate change recorded')
      setRate('')
      setNote('')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (id: number): Promise<void> => {
    try {
      await api.gst.itemRateDelete(id)
      await queryClient.invalidateQueries({ queryKey: ['itemRates'] })
      await queryClient.invalidateQueries({ queryKey: ['rateAdvisory'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel>
      <div className="border-b border-line px-3 py-2 text-body-sm font-medium text-ink">Record a rate change</div>
      <div className="p-3">
        <div className="grid grid-cols-4 gap-3">
          <Field label="Item">
            <Select
              data-testid="select-rate-item"
              value={itemId ?? ''}
              onChange={(e) => setItemId(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">Choose an item…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effective from" hint="The date the new rate applies">
            <TextInput
              data-testid="input-rate-from"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
          <Field label="Rate %">
            <TextInput data-testid="input-rate-pct" className="num" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field label="Why" hint="The notification, or who advised it">
            <TextInput data-testid="input-rate-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <Button data-testid="btn-rate-save" variant="primary" disabled={itemId === null} onClick={() => void save()}>
            Record change
          </Button>
        </div>
      </div>

      {itemId !== null && (
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col" className="w-32">Effective from</th>
              <th scope="col" className="r w-24">Rate</th>
              <th scope="col">Why</th>
              <th scope="col" className="w-20"></th>
            </tr>
          </thead>
          <tbody data-testid="rows-item-rates">
            {(history ?? []).length === 0 ? (
              <tr>
                <td colSpan={4} className="text-muted">
                  No changes recorded — this item has answered with its master rate for its whole life.
                </td>
              </tr>
            ) : (
              (history ?? []).map((h) => (
                <tr key={h.id}>
                  <td className="num">{toDisplayDate(h.effectiveFrom)}</td>
                  <td className="r num">{h.rate}%</td>
                  <td className="text-muted">{h.note ?? '—'}</td>
                  <td className="r">
                    <button
                      data-testid={`btn-rate-delete-${h.id}`}
                      className="text-small text-cr hover:underline"
                      onClick={() => void remove(h.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

// ---------- Schedule III presentation (roadmap #363) ----------

/**
 * The face a company is required to present in.
 *
 * A view over the same statement tree, not a second set of numbers — which is why the totals line
 * and the "does not tie" warning matter more here than anywhere else in the app. Every judgement
 * the mapping made is printed under the line that made it rather than in a footnote nobody reads.
 */
export function ScheduleIIIFace({ booksFrom, asOn }: { booksFrom: string; asOn: string }): React.JSX.Element {
  const toast = useToasts()
  const { data, isLoading } = useQuery({
    queryKey: ['scheduleIII', booksFrom, asOn],
    queryFn: () => api.reports.scheduleIII(booksFrom, asOn)
  })

  const exportCsv = async (): Promise<void> => {
    try {
      await api.reports.scheduleIIICsv(booksFrom, asOn)
      toast.push('success', 'Schedule III written to the exports folder')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (isLoading || !data) return <p className="text-muted">Loading…</p>

  const face = (
    title: string,
    lines: { key: string; label: string; level: number; amount: number; note?: string }[],
    total: { label: string; amount: number }
  ): React.JSX.Element => (
    <Panel className="flex h-full flex-col p-4">
      <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{title}</p>
      <table className="ledger-table">
        <tbody data-testid={`rows-schedule3-${title.replace(/\W+/g, '-').toLowerCase()}`}>
          {lines.map((l) => (
            <tr key={l.key}>
              <td style={{ paddingLeft: `${l.level * 16}px` }} className={l.level === 0 ? 'font-medium' : ''}>
                {l.label}
                {l.note && <div className="text-hint text-muted">{l.note}</div>}
              </td>
              <td className="r">
                <Money paise={l.amount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grow" aria-hidden />
      <div className="total-row mt-2 flex justify-between px-2 pt-1.5 pb-0.5">
        <span>{total.label}</span>
        <Money paise={total.amount} />
      </div>
    </Panel>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-hint text-muted">
          Division I of Schedule III to the Companies Act 2013 — the non-Ind AS face.
        </span>
        <Button data-testid="btn-schedule3-csv" variant="ghost" onClick={() => void exportCsv()}>
          CSV
        </Button>
      </div>

      {!data.balanceSheet.balanced && (
        <p className="text-body-sm text-cr" data-testid="schedule3-unbalanced">
          The two sides of this presentation do not agree. That is a mapping problem, not an arithmetic one — see the
          unclassified balances below.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        {face('Equity and liabilities', data.balanceSheet.equityAndLiabilities, {
          label: 'Total',
          amount: data.balanceSheet.totalEquityAndLiabilities
        })}
        {face('Assets', data.balanceSheet.assets, { label: 'Total', amount: data.balanceSheet.totalAssets })}
      </div>

      {data.balanceSheet.unmapped.length > 0 && (
        <Panel>
          <div className="border-b border-line bg-amber/10 px-3 py-2 text-body-sm text-amber">
            Balances that no Schedule III line claims. They are included in the totals above so the face still ties, and
            they have to be classified before the accounts can be presented.
          </div>
          <table className="ledger-table">
            <tbody data-testid="rows-schedule3-unmapped">
              {data.balanceSheet.unmapped.map((u) => (
                <tr key={u.key}>
                  <td>
                    {u.label}
                    <div className="text-hint text-muted">{u.sources.join(', ')}</div>
                  </td>
                  <td className="r">
                    <Money paise={u.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel className="p-4">
        <p className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">
          Statement of profit and loss
        </p>
        <table className="ledger-table">
          <tbody data-testid="rows-schedule3-pnl">
            {data.profitAndLoss.lines.map((l) => (
              <tr key={l.key}>
                <td style={{ paddingLeft: `${l.level * 16}px` }} className={l.level === 0 ? 'font-medium' : ''}>
                  {l.label}
                  {l.sources.length > 0 && <div className="text-hint text-muted">{l.sources.join(', ')}</div>}
                </td>
                <td className="r">
                  <Money paise={l.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <ul className="flex flex-col gap-1">
        {[...data.balanceSheet.caveats, ...data.profitAndLoss.caveats].map((c, i) => (
          <li key={i} className="text-hint text-muted">
            {c}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- IMS worklist (roadmap #352) ----------

/**
 * The decision list behind the reconciliation.
 *
 * IMS actions are taken on the portal — there is no offline route and no API this app has
 * credentials for — so what this does is turn six hundred invoices into a worked sheet, and
 * remember what was decided so a fresh 2B download does not ask again.
 *
 * The count that matters is the undecided one, because an untouched document is DEEMED ACCEPTED
 * when 2B generates. That is the one number pinned to the top.
 */
export function ImsWorklistPanel({
  jsonText,
  from,
  to
}: {
  jsonText: string
  from: string
  to: string
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['imsWorklist', jsonText, from, to],
    queryFn: () => api.ims.worklist(jsonText, from, to)
  })

  const decide = async (docKey: string, period: string, action: 'accept' | 'reject' | 'pending'): Promise<void> => {
    try {
      await api.ims.decide(docKey, period, action, null)
      await queryClient.invalidateQueries({ queryKey: ['imsWorklist'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const acceptMatched = async (): Promise<void> => {
    try {
      const r = await api.ims.acceptMatched(jsonText, from, to)
      await queryClient.invalidateQueries({ queryKey: ['imsWorklist'] })
      toast.push('success', `${r.accepted} matched document${r.accepted === 1 ? '' : 's'} accepted`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (isLoading || !data) return <p className="text-muted">Loading…</p>
  const w = data.worklist

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="border-b border-line bg-amber/10 px-3 py-2 text-body-sm text-amber">
          IMS actions are taken on the GST portal. This is the worksheet and the record of what was decided — nothing
          here reaches the portal. A document nobody touches is <b>deemed accepted</b> when GSTR-2B generates, which is
          why the undecided count is the number to drive to zero.
        </div>
        <div className="flex flex-wrap items-center gap-4 px-3 py-2 text-body-sm">
          <span data-testid="ims-undecided">
            <b className="num">{w.undecided}</b> undecided
          </span>
          <span className="text-muted num">
            {w.counts.accept} accepted · {w.counts.reject} rejected · {w.counts.pending} pending
          </span>
          <span className="text-muted">
            Tax on everything not suggested for acceptance:{' '}
            <Money paise={w.atRisk.igst + w.atRisk.cgst + w.atRisk.sgst + w.atRisk.cess} />
          </span>
          <Button data-testid="btn-ims-accept-matched" variant="ghost" onClick={() => void acceptMatched()}>
            Accept everything matched
          </Button>
        </div>
      </Panel>

      <Panel>
        {w.rows.length === 0 ? (
          <EmptyState title="Nothing in this period’s IMS dashboard" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Date</th>
                <th scope="col">Supplier</th>
                <th scope="col" className="w-32">Document</th>
                <th scope="col" className="r w-32">Tax</th>
                <th scope="col">Suggestion</th>
                <th scope="col" className="w-56">Action</th>
              </tr>
            </thead>
            <tbody data-testid="rows-ims">
              {w.rows.map((r) => (
                <tr key={r.key}>
                  <td className="num">{r.date ? toDisplayDate(r.date) : '—'}</td>
                  <td>
                    {r.supplierName ?? r.supplierGstin ?? 'Unnamed'}
                    <div className="text-hint text-muted num">{r.supplierGstin ?? 'No GSTIN'}</div>
                  </td>
                  <td className="num">{r.number}</td>
                  <td className="r">
                    <Money paise={r.igst + r.cgst + r.sgst + r.cess} />
                  </td>
                  <td className={r.suggestion.confidence === 'check' ? 'text-amber' : 'text-muted'}>
                    {r.suggestion.reason}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {(['accept', 'reject', 'pending'] as const).map((a) => (
                        <button
                          key={a}
                          data-testid={`btn-ims-${a}-${r.key}`}
                          onClick={() => void decide(r.key, w.period, a)}
                          className={`rounded-md px-2 py-0.5 text-small ${
                            r.action === a ? 'bg-accentbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
                          }`}
                        >
                          {a === 'accept' ? 'Accept' : a === 'reject' ? 'Reject' : 'Pend'}
                        </button>
                      ))}
                    </div>
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

// ---------- GSTR-1A, the amendment return (roadmap #353) ----------

/**
 * What changed after the return went in.
 *
 * The screen has three states rather than one, because they need three different things from the
 * user: no filing recorded, filed but never snapshotted, and snapshotted. The middle one is the
 * important one — without a copy of what was filed there is nothing to compare against, and
 * reporting that as "clean" would be the most dangerous answer this screen could give.
 */
export function Gstr1aPanel({ period }: { period: string }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['gstr1a', period],
    queryFn: () => api.gst.gstr1a(period)
  })

  const snapshot = async (): Promise<void> => {
    try {
      const r = await api.gst.gstr1Snapshot(period)
      await queryClient.invalidateQueries({ queryKey: ['gstr1a'] })
      toast.push('success', `Snapshot taken — ${r.docs} document${r.docs === 1 ? '' : 's'} frozen as filed`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (isLoading || !data) return <p className="text-muted">Loading…</p>

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
          <span className={`text-body-sm ${data.window.open ? 'text-ink' : 'text-muted'}`} data-testid="gstr1a-window">
            {data.window.reason}
          </span>
          <Button data-testid="btn-gstr1a-snapshot" variant="ghost" disabled={!data.gstr1FiledAt} onClick={() => void snapshot()}>
            {data.snapshotDocs === null ? 'Snapshot the filed return' : 'Re-snapshot'}
          </Button>
        </div>
        <div className="border-t border-line px-3 py-2 text-hint text-muted">
          <div>{data.window.authority}</div>
          <ul className="mt-1 list-disc pl-4">
            {GSTR1A_RESTRICTIONS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      </Panel>

      {data.message && (
        <Panel>
          <EmptyState title="Nothing to compare against yet" hint={data.message} />
        </Panel>
      )}

      {data.result && data.result.clean && (
        <Panel>
          <EmptyState
            title="The books still match the return that was filed"
            hint={`${data.snapshotDocs} document(s) compared. No GSTR-1A is needed.`}
          />
        </Panel>
      )}

      {data.result && !data.result.clean && (
        <Panel>
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-32">Change</th>
                <th scope="col" className="w-32">Document</th>
                <th scope="col" className="w-28">Date</th>
                <th scope="col">Party</th>
                <th scope="col" className="r w-32">Taxable Δ</th>
                <th scope="col" className="r w-32">Tax Δ</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody data-testid="rows-gstr1a">
              {data.result.rows.map((r) => (
                <tr key={`${r.change}-${r.number}`}>
                  <td className={r.change === 'counterPartyChanged' ? 'text-cr' : ''}>
                    {r.change === 'counterPartyChanged' ? 'Not amendable' : r.change}
                  </td>
                  <td className="num">{r.number}</td>
                  <td className="num">{toDisplayDate(r.date)}</td>
                  <td>{r.partyName ?? '—'}</td>
                  <td className="r">
                    <Money paise={r.delta.taxable} />
                  </td>
                  <td className="r">
                    <Money paise={r.delta.igst + r.delta.cgst + r.delta.sgst + r.delta.cess} />
                  </td>
                  <td className="text-muted">{r.reasons.join(' ')}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={4}>Net movement since filing</td>
                <td className="r">
                  <Money paise={data.result.net.taxable} />
                </td>
                <td className="r">
                  <Money
                    paise={data.result.net.igst + data.result.net.cgst + data.result.net.sgst + data.result.net.cess}
                  />
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  )
}
