// Payables → Batch payments (WP 4.3): a multi-supplier payment grid — supplier, bills, amount,
// bank, cheque / UTR per row — posting one payment voucher per row in one run (preview first:
// TDS on payment, bank totals, problems). Bills are optional: none = the oldest bills settle first.
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { OutstandingBill } from '@shared/reports'
import { AmountInput, Button, DateInput, DrawerSection, Modal, Money, Page, PageHeader, Panel, Select, TextInput } from '../../components/ui'
import { LedgerPicker } from '../../components/pickers'
import { api } from '../../lib/client'
import { useCanEditMasters } from '../../lib/drill'
import { creditorFilter, useCashBankLedgers, usePayablesAsOn } from './common'
import { RunPreviewModal } from './RunModals'

interface GridRow {
  key: number
  partyLedgerId: number | null
  bills: { name: string; amount: number }[]
  amount: number | null
  /** True while the amount follows the bills picked. */
  amountFromBills: boolean
  bankLedgerId: number | ''
  instrumentNo: string
}

let rowSeq = 0
const blankRow = (bankLedgerId: number | ''): GridRow => ({
  key: ++rowSeq, partyLedgerId: null, bills: [], amount: null, amountFromBills: true, bankLedgerId, instrumentNo: ''
})

function BillsModal({
  partyLedgerId,
  date,
  value,
  onClose,
  onPick
}: {
  partyLedgerId: number
  date: string
  value: { name: string; amount: number }[]
  onClose: () => void
  onPick: (bills: { name: string; amount: number }[]) => void
}): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['billsOpen', partyLedgerId, date], queryFn: () => api.bills.open(partyLedgerId, date) })
  const [sel, setSel] = useState<Map<string, number>>(() => new Map(value.map((b) => [b.name, b.amount])))
  const bills: OutstandingBill[] = data ?? []
  return (
    <Modal title="Bills to settle" onClose={onClose}>
      <table className="ledger-table" data-testid="rows-payables-batch-bills">
        <thead>
          <tr>
            <th scope="col" className="w-8"><span className="sr-only">Pick</span></th>
            <th scope="col">Bill</th>
            <th scope="col" className="w-28">Date</th>
            <th scope="col" className="w-28">Due</th>
            <th scope="col" className="r w-32">Pending</th>
          </tr>
        </thead>
        <tbody>
          {bills.map((b) => (
            <tr key={`${b.voucherId}-${b.number}`}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Settle ${b.number}`}
                  data-testid={`pick-batch-bill-${b.number}`}
                  checked={sel.has(b.number)}
                  onChange={(e) =>
                    setSel((m) => {
                      const n = new Map(m)
                      if (e.target.checked) n.set(b.number, b.pending)
                      else n.delete(b.number)
                      return n
                    })
                  }
                />
              </td>
              <td className="num">{b.number}</td>
              <td className="num">{toDisplayDate(b.date)}</td>
              <td className="num">{b.dueDate ? toDisplayDate(b.dueDate) : ''}</td>
              <td className="r"><Money paise={b.pending} /></td>
            </tr>
          ))}
          {bills.length === 0 && (
            <tr>
              <td colSpan={5} className="text-center text-muted">No open bills on {toDisplayDate(date)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="btn-payables-batch-bills-ok"
          onClick={() => {
            onPick([...sel].map(([name, amount]) => ({ name, amount })))
            onClose()
          }}
        >
          Use {sel.size} bill{sel.size === 1 ? '' : 's'}
        </Button>
      </div>
    </Modal>
  )
}

export function BatchTab({ tabs }: { tabs: ReactNode }): React.JSX.Element {
  const asOn = usePayablesAsOn()
  const canWrite = useCanEditMasters()
  const banks = useCashBankLedgers()
  const defaultBank = banks[0]?.id ?? ''
  const [date, setDate] = useState(asOn)
  const [rows, setRows] = useState<GridRow[]>(() => [blankRow(''), blankRow('')])
  const [billsFor, setBillsFor] = useState<number | null>(null)
  const [preview, setPreview] = useState(false)

  const set = (key: number, patch: Partial<GridRow>): void => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const effective = rows.map((r) => ({ ...r, bankLedgerId: r.bankLedgerId === '' ? defaultBank : r.bankLedgerId }))
  const ready = effective.filter((r) => r.partyLedgerId != null && (r.amount ?? 0) > 0 && r.bankLedgerId !== '')
  const total = ready.reduce((s, r) => s + (r.amount ?? 0), 0)
  const items = useMemo(
    () =>
      ready.map((r) => ({
        partyLedgerId: r.partyLedgerId!, bankLedgerId: r.bankLedgerId as number, amount: r.amount!, bills: r.bills,
        instrumentNo: r.instrumentNo.trim() || null
      })),
    [ready]
  )
  const editing = rows.find((r) => r.key === billsFor)

  return (
    <Page width="wide">
      <PageHeader
        title="Payables"
        period={`batch dated ${toDisplayDate(date)}`}
        tabs={tabs}
        controls={<DateInput value={date} context={date} onChange={setDate} testId="input-payables-batch-date" ariaLabel="Payment date" className="w-32" />}
        actions={
          canWrite && (
            <Button variant="primary" data-testid="btn-payables-batch-preview" disabled={items.length === 0} onClick={() => setPreview(true)}>
              {items.length > 0 ? `Preview & post ${items.length} payment${items.length === 1 ? '' : 's'}…` : 'Preview & post…'}
            </Button>
          )
        }
        options={{
          content: (
            <DrawerSection title="About batch payments">
              <p className="text-hint text-muted">
                Each row becomes one payment voucher: Dr the supplier with the amount, Cr the bank with the amount less any TDS on payment,
                bill-wise against the bills picked (anything above them goes on account). With no bills picked the oldest open bills settle
                first. TDS is deducted only where WP 3.2&apos;s rule says it is still due — bills not deducted when booked, or an advance —
                and the threshold is crossed; the preview shows it per supplier. The whole batch posts or none of it does.
              </p>
            </DrawerSection>
          )
        }}
      />
      <Panel>
        <table className="ledger-table" data-testid="rows-payables-batch">
          <thead>
            <tr>
              <th scope="col">Supplier</th>
              <th scope="col" className="w-48">Bills</th>
              <th scope="col" className="r w-40">Amount</th>
              <th scope="col" className="w-52">Pay from</th>
              <th scope="col" className="w-40">Cheque / UTR</th>
              <th scope="col" className="w-10"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {effective.map((r, i) => (
              <tr key={r.key} data-testid="payables-batch-row">
                <td>
                  <LedgerPicker
                    value={r.partyLedgerId}
                    onPick={(id) => set(r.key, { partyLedgerId: id, bills: [], amount: r.amountFromBills ? null : r.amount })}
                    filter={creditorFilter}
                    placeholder="Supplier"
                    testId={`picker-payables-batch-supplier-${i}`}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="text-hint text-blue hover:underline disabled:text-muted"
                    disabled={r.partyLedgerId == null}
                    data-testid={`btn-payables-batch-bills-${i}`}
                    onClick={() => setBillsFor(r.key)}
                  >
                    {r.bills.length > 0 ? `${r.bills.map((b) => b.name).join(', ')}` : 'Oldest first — pick bills…'}
                  </button>
                </td>
                <td>
                  <AmountInput
                    paise={r.amount}
                    onPaise={(p) => set(r.key, { amount: p, amountFromBills: false })}
                    testId={`input-payables-batch-amount-${i}`}
                    ariaLabel="Amount"
                  />
                </td>
                <td>
                  <Select
                    aria-label="Pay from"
                    data-testid={`input-payables-batch-bank-${i}`}
                    value={r.bankLedgerId}
                    onChange={(e) => set(r.key, { bankLedgerId: e.target.value ? Number(e.target.value) : '' })}
                  >
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td>
                  <TextInput
                    aria-label="Cheque or UTR number"
                    data-testid={`input-payables-batch-instrument-${i}`}
                    value={r.instrumentNo}
                    onChange={(e) => set(r.key, { instrumentNo: e.target.value })}
                    className="num"
                  />
                </td>
                <td>
                  <button
                    type="button"
                    aria-label="Remove row"
                    className="text-muted hover:text-cr"
                    onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [blankRow('')]))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="total-row">
              <td colSpan={2}>
                <Button size="sm" variant="ghost" data-testid="btn-payables-batch-add" onClick={() => setRows((rs) => [...rs, blankRow('')])}>
                  + Add supplier
                </Button>
              </td>
              <td className="r num font-semibold" data-testid="payables-batch-total">{formatPaise(total)}</td>
              <td colSpan={3} className="text-hint text-muted">{ready.length} payment{ready.length === 1 ? '' : 's'} ready</td>
            </tr>
          </tfoot>
        </table>
      </Panel>
      <p className="mt-2 text-hint text-muted">One payment voucher per row · TDS on payment where due · the batch posts all-or-nothing · F12 for options.</p>
      {editing && editing.partyLedgerId != null && (
        <BillsModal
          partyLedgerId={editing.partyLedgerId}
          date={date}
          value={editing.bills}
          onClose={() => setBillsFor(null)}
          onPick={(bills) => {
            const sum = bills.reduce((s, b) => s + b.amount, 0)
            set(editing.key, { bills, ...(editing.amountFromBills || editing.amount == null ? { amount: sum || null, amountFromBills: true } : {}) })
          }}
        />
      )}
      {preview && (
        <RunPreviewModal
          input={{ date, kind: 'batch', applyTds: true, items }}
          onClose={() => setPreview(false)}
          onPosted={() => setRows([blankRow('')])}
        />
      )}
      {banks.length === 0 && <p className="mt-2 text-hint text-cr">Create a bank or cash ledger first.</p>}
    </Page>
  )
}
