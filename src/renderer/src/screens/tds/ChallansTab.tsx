// Challans tab: deposits (ITNS 281) matched to the payment vouchers that paid them, entries
// allocated oldest-first (or by hand), and the indicative interest on late deposit.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { LATE_DEPOSIT_RATE_BP } from '@shared/tdsInterest'
import { api, type TdsChallanRow, type TdsEntryRow } from '../../lib/client'
import { Banner, Button, Checkbox, Field, Modal, Money, Select, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { VoucherLink } from '../../components/links'
import { useCanEditMasters } from '../../lib/drill'
import { confirmDialog } from '../../lib/dialogs'
import { useTdsAction, type TdsPeriod } from './common'

const challanColumns = (rateLabel: string) =>
  defineColumns<TdsChallanRow>([
    { id: 'date', header: 'Deposited', kind: 'date', value: (c) => c.date, className: 'text-muted' },
    { id: 'challan', header: 'Challan no.', kind: 'text', value: (c) => c.challanNo, width: 100, className: 'num', hideable: false, groupable: false },
    { id: 'bsr', header: 'BSR code', kind: 'text', value: (c) => c.bsrCode, width: 100, className: 'num' },
    { id: 'quarter', header: 'For', kind: 'text', value: (c) => `Q${c.quarter}`, width: 64 },
    {
      id: 'payment', header: 'Payment voucher', kind: 'text', value: (c) => c.paymentVoucherNumber, minWidth: 130,
      cell: (c) => (c.paymentVoucherId != null ? <VoucherLink voucherId={c.paymentVoucherId} label={c.paymentVoucherNumber ?? 'voucher'} /> : <span className="text-muted">Not linked</span>)
    },
    { id: 'amount', header: 'Amount', kind: 'money', value: (c) => c.amountPaise, aggregate: 'sum', width: 130 },
    { id: 'allocated', header: 'Allocated', kind: 'money', value: (c) => c.allocatedPaise, aggregate: 'sum', width: 130 },
    { id: 'unallocated', header: 'Unallocated', kind: 'money', value: (c) => c.amountPaise - c.allocatedPaise, aggregate: 'sum', width: 130 },
    { id: 'entries', header: 'Entries', kind: 'number', value: (c) => c.entryCount, width: 80 },
    { id: 'interest', header: `Interest (${rateLabel})`, kind: 'money', value: (c) => c.interestPaise, aggregate: 'sum', width: 150 }
  ])

export function ChallansTab({ period }: { period: TdsPeriod }): React.JSX.Element {
  const canEdit = useCanEditMasters()
  const { busy, run } = useTdsAction()
  const [rateText, setRateText] = useState(String(LATE_DEPOSIT_RATE_BP / 100))
  const rate = Number(rateText)
  const rateBp = Number.isFinite(rate) && rate >= 0 && rate <= 100 ? Math.round(rate * 100) : LATE_DEPOSIT_RATE_BP
  const [creating, setCreating] = useState(false)
  const [allocating, setAllocating] = useState<TdsChallanRow | null>(null)
  const quarter = period.quarter === 0 ? undefined : period.quarter
  const { data: challans, isLoading } = useQuery({
    queryKey: ['tds', 'challans', period.fyStartYear, quarter, rateBp],
    queryFn: () => api.tds.challanRows(period.fyStartYear, quarter, rateBp)
  })
  const { data: unallocated } = useQuery({
    queryKey: ['tds', 'unallocated', period.fyStartYear, quarter],
    queryFn: () => api.tds.unallocated(period.fyStartYear, quarter)
  })
  const columns = useMemo(() => challanColumns(`${rateBp / 100}%/mo`), [rateBp])
  const pending = unallocated ?? []

  const remove = async (c: TdsChallanRow): Promise<void> => {
    const ok = await confirmDialog({ title: 'Delete challan', message: `Delete challan ${c.challanNo}? Its ${c.entryCount} entries become unallocated. The payment voucher stays.`, confirmLabel: 'Delete', danger: true })
    if (ok) await run(() => api.tds.challanDelete(c.id), 'Challan deleted')
  }

  return (
    <>
      {pending.length > 0 && (
        <Banner tone="info" className="mb-3" title={`${pending.length} deduction${pending.length > 1 ? 's' : ''} not yet on a challan`}>
          {formatPaise(pending.reduce((s, e) => s + e.tdsAmount, 0), { symbol: true })} in {period.label}. Record the deposit as a payment voucher (Dr
          TDS Payable / Cr Bank), then create the challan from it.
        </Banner>
      )}
      <DataTable
        viewId="tds-challans"
        testId="tds-challans"
        ariaLabel={`TDS challans — ${period.label}`}
        columns={columns}
        rows={challans ?? []}
        loading={isLoading}
        rowKey={(c) => c.id}
        rowAttrs={(c) => ({ 'data-row-id': c.id })}
        renderDetail={(c) => <ChallanInterestDetail challanId={c.id} rateBp={rateBp} />}
        isRowExpandable={(c) => c.entryCount > 0}
        empty={{ title: `No challans for ${period.label}`, hint: 'Create one from the payment voucher that deposited the TDS.' }}
        exportOptions={{ title: 'TDS challans', periodLabel: period.label, filename: `tds-challans-${period.from}` }}
        toolbarStart={
          <div className="flex items-center gap-3">
            {canEdit && (
              <Button size="sm" variant="primary" data-testid="btn-tds-challan-new" onClick={() => setCreating(true)}>
                New challan from payment…
              </Button>
            )}
            <label className="flex items-center gap-1.5 text-small text-muted">
              Interest rate
              <TextInput
                aria-label="Interest rate per month (%)"
                data-testid="input-tds-interest-rate"
                className="num w-16"
                value={rateText}
                onChange={(e) => setRateText(e.target.value)}
              />
              % a month · indicative
            </label>
          </div>
        }
        trailingWidth={canEdit ? 168 : 0}
        trailing={
          canEdit
            ? (c) => (
                <div className="flex items-center justify-end gap-1">
                  <Button size="sm" variant="ghost" data-testid={`btn-tds-challan-allocate-${c.id}`} onClick={() => setAllocating(c)}>
                    Allocate…
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} data-testid={`btn-tds-challan-delete-${c.id}`} onClick={() => void remove(c)}>
                    <span className="text-cr">Delete</span>
                  </Button>
                </div>
              )
            : undefined
        }
      />
      <p className="mt-2 text-hint text-muted">
        Interest is indicative: {rateBp / 100}% for every month or part of a month from the date of deduction to the date of deposit when the deposit
        is after the due date (7th of the next month; 30 April for March) — Income-tax Act 1961 s.201(1A)(ii), Income-tax Act 2025 s.398(3)(a); months
        counted the way TRACES does (both ends). Check with your CA.
      </p>
      {creating && <NewChallanModal period={period} onClose={() => setCreating(false)} />}
      {allocating && <AllocateModal challan={allocating} onClose={() => setAllocating(null)} />}
    </>
  )
}

function ChallanInterestDetail({ challanId, rateBp }: { challanId: number; rateBp: number }): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['tds', 'challanInterest', challanId, rateBp], queryFn: () => api.tds.challanInterest(challanId, rateBp) })
  return (
    <table className="ledger-table text-body-sm" data-testid={`tds-challan-interest-${challanId}`}>
      <thead>
        <tr>
          <th>Deducted</th>
          <th>Voucher</th>
          <th>Party</th>
          <th>Section</th>
          <th className="r">TDS</th>
          <th>Due by</th>
          <th className="r">Months late</th>
          <th className="r">Interest</th>
        </tr>
      </thead>
      <tbody>
        {(data ?? []).map((e) => (
          <tr key={e.entryId}>
            <td className="num text-muted">{toDisplayDate(e.date)}</td>
            <td><VoucherLink voucherId={e.voucherId} label={e.voucherNumber} /></td>
            <td>{e.partyName}</td>
            <td className="num">{e.sectionCode}</td>
            <td className="r"><Money paise={e.tdsPaise} /></td>
            <td className="num text-muted">{toDisplayDate(e.dueDate)}</td>
            <td className="r num">{e.months || '—'}</td>
            <td className="r"><Money paise={e.interestPaise} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Pick the payment voucher that deposited the TDS; BSR code, challan serial, date. */
function NewChallanModal({ period, onClose }: { period: TdsPeriod; onClose: () => void }): React.JSX.Element {
  const { busy, run } = useTdsAction()
  const { data: candidates } = useQuery({ queryKey: ['tds', 'paymentCandidates', period.fyStartYear], queryFn: () => api.tds.paymentCandidates(period.fyStartYear) })
  const open = (candidates ?? []).filter((c) => c.challanId == null)
  const [paymentId, setPaymentId] = useState<number | null>(null)
  const [bsr, setBsr] = useState('')
  const [challanNo, setChallanNo] = useState('')
  const [date, setDate] = useState('')
  const [quarter, setQuarter] = useState<number | null>(null)
  const [auto, setAuto] = useState(true)
  const pick = paymentId ?? open[0]?.voucherId ?? null
  const chosen = open.find((c) => c.voucherId === pick)
  const error = !/^\d{7}$/.test(bsr.trim()) ? 'BSR code is 7 digits' : !/^\d{1,5}$/.test(challanNo.trim()) ? 'Challan serial number is 1-5 digits' : null

  const submit = async (): Promise<void> => {
    if (!chosen || error) return
    const r = await run(
      () => api.tds.challanFromPayment({
        paymentVoucherId: chosen.voucherId, bsrCode: bsr.trim(), challanNo: challanNo.trim(), date: date || null,
        quarter, fyStartYear: quarter != null ? period.fyStartYear : null, autoAllocate: auto
      }),
      (c) => `Challan ${c.challanNo} created — ${formatPaise(c.allocatedPaise, { symbol: true })} allocated`
    )
    if (r) onClose()
  }

  return (
    <Modal title="New challan from a payment" onClose={onClose}>
      {open.length === 0 ? (
        <div className="flex flex-col gap-3 text-body-sm text-muted">
          <p>No payment voucher in FY {period.label.replace(/^.*FY ?/, '')} debits a TDS payable ledger without a challan yet.</p>
          <p>Record the deposit first: a payment voucher Dr TDS Payable &lt;section&gt; / Cr Bank, dated the day you paid challan ITNS 281.</p>
          <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Payment voucher">
            <Select data-testid="select-tds-challan-payment" value={pick ?? ''} onChange={(e) => setPaymentId(Number(e.target.value))}>
              {open.map((c) => (
                <option key={c.voucherId} value={c.voucherId}>
                  {c.voucherNumber} · {toDisplayDate(c.date)} · {formatPaise(c.amountPaise, { symbol: true })} · {c.sectionCodes}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="BSR code" hint="7 digits, on the challan counterfoil">
              <TextInput data-testid="input-tds-challan-bsr" className="num" value={bsr} onChange={(e) => setBsr(e.target.value)} />
            </Field>
            <Field label="Challan serial no.">
              <TextInput data-testid="input-tds-challan-no" className="num" value={challanNo} onChange={(e) => setChallanNo(e.target.value)} />
            </Field>
            <Field label="Date deposited" hint={chosen ? `Blank = ${toDisplayDate(chosen.date)}` : undefined}>
              <TextInput className="num" placeholder="YYYY-MM-DD" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="For quarter" hint="Blank = the oldest unallocated deductions">
              <Select value={quarter ?? ''} onChange={(e) => setQuarter(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Automatic</option>
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>Q{q}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Checkbox label="Allocate deductions oldest first" hint="Of the sections the payment debited, in the challan's quarter, up to its amount" checked={auto} onChange={setAuto} testId="chk-tds-challan-auto" />
          {error && (bsr || challanNo) && <p className="text-body-sm text-cr">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-tds-challan-create" disabled={busy || !!error || !chosen} onClick={() => void submit()}>
              Create challan
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Manual override: tick the quarter's entries to put on this challan (or Auto-allocate). */
function AllocateModal({ challan, onClose }: { challan: TdsChallanRow; onClose: () => void }): React.JSX.Element {
  const { busy, run } = useTdsAction()
  const { data: free } = useQuery({
    queryKey: ['tds', 'unallocated', challan.fyStartYear, challan.quarter],
    queryFn: () => api.tds.unallocated(challan.fyStartYear, challan.quarter)
  })
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const rows = free ?? []
  const room = challan.amountPaise - challan.allocatedPaise
  const pickedTotal = rows.filter((e) => picked.has(e.entryId)).reduce((s, e) => s + e.tdsAmount, 0)
  const columns = useMemo(
    () =>
      defineColumns<TdsEntryRow>([
        { id: 'date', header: 'Date', kind: 'date', value: (e) => e.date },
        { id: 'voucher', header: 'Voucher', kind: 'text', value: (e) => e.voucherNumber, width: 110 },
        { id: 'party', header: 'Party', kind: 'text', value: (e) => e.partyName },
        { id: 'section', header: 'Section', kind: 'text', value: (e) => e.sectionCode, width: 90 },
        { id: 'tds', header: 'TDS', kind: 'money', value: (e) => e.tdsAmount, width: 120 }
      ]),
    []
  )
  return (
    <Modal title={`Allocate to challan ${challan.challanNo}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <p className="text-body-sm text-muted">
          {formatPaise(room, { symbol: true })} of {formatPaise(challan.amountPaise, { symbol: true })} still free · Q{challan.quarter} deductions not on any challan.
        </p>
        <DataTable
          testId="tds-allocate"
          ariaLabel="Unallocated deductions"
          columns={columns}
          rows={rows}
          rowKey={(e) => e.entryId}
          maxHeight="45vh"
          toolbarFeatures={{ groupBy: false, density: false, views: false, export: false }}
          leadingWidth={36}
          leading={(e) => (
            <input
              type="checkbox"
              aria-label={`Allocate ${e.voucherNumber}`}
              data-testid={`chk-tds-allocate-${e.entryId}`}
              checked={picked.has(e.entryId)}
              onChange={(ev) =>
                setPicked((s) => {
                  const n = new Set(s)
                  if (ev.target.checked) n.add(e.entryId)
                  else n.delete(e.entryId)
                  return n
                })
              }
            />
          )}
          empty={{ title: 'Every deduction of the quarter is on a challan' }}
        />
        <div className="flex items-center justify-between gap-2">
          <Button
            data-testid="btn-tds-auto-allocate"
            disabled={busy || rows.length === 0}
            onClick={() => void run(() => api.tds.autoAllocate(challan.id), (r) => `${r.entryIds.length} allocated oldest first`).then((r) => r && onClose())}
          >
            Auto-allocate oldest first
          </Button>
          <div className="flex items-center gap-2">
            <span className={`text-body-sm ${pickedTotal > room ? 'text-cr' : 'text-muted'}`}>Selected {formatPaise(pickedTotal, { symbol: true })}</span>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="btn-tds-allocate-selected"
              disabled={busy || picked.size === 0 || pickedTotal > room}
              onClick={() => void run(() => api.tds.allocate(challan.id, [...picked]), 'Allocated').then((r) => r && onClose())}
            >
              Allocate selected
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
