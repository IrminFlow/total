// Banking → Post-dated (WP 4.1): the PDC register, received and issued — pending ones mature
// automatically on their date (or "Mature now"); matured ones stay listed so a bounce can be
// recorded: the entry is reversed by a new voucher and bank charges are booked.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toDisplayDate, todayISO } from '@shared/dates'
import { api } from '../../lib/client'
import { bankingApi, type PdcRegisterRow } from '../../lib/bankingClient'
import { DataTable, defineColumns } from '../../components/table'
import { AmountInput, Badge, Button, Checkbox, DateInput, Field, Modal, Money, Panel, StatGrid, StatTile, TextInput } from '../../components/ui'
import { LedgerPicker } from '../../components/pickers'
import { LedgerLink, VoucherLink } from '../../components/links'
import { useNav, useToasts } from '../../state/stores'
import { confirmDialog } from '../../lib/dialogs'

const STATUS_LABEL: Record<PdcRegisterRow['status'], string> = { pending: 'Pending', due: 'Due — locked period', matured: 'Matured', bounced: 'Bounced' }
const STATUS_TONE: Record<PdcRegisterRow['status'], 'info' | 'warning' | 'success' | 'danger'> = { pending: 'info', due: 'warning', matured: 'success', bounced: 'danger' }

const PDC_COLUMNS = defineColumns<PdcRegisterRow>([
  { id: 'date', header: 'Matures', kind: 'date', value: (r) => r.date, width: 116, className: 'text-muted' },
  {
    id: 'number',
    header: 'Number',
    kind: 'text',
    value: (r) => r.number,
    hideable: false,
    groupable: false,
    width: 110,
    className: 'num',
    cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.number} />
  },
  {
    id: 'direction',
    header: 'Cheque',
    kind: 'enum',
    value: (r) => r.direction,
    options: [
      { value: 'received', label: 'Received' },
      { value: 'issued', label: 'Issued' }
    ],
    width: 112
  },
  { id: 'type', header: 'Type', kind: 'text', value: (r) => r.voucherTypeName, width: 110, className: 'text-muted', defaultHidden: true },
  {
    id: 'party',
    header: 'Party',
    kind: 'text',
    value: (r) => r.partyName,
    minWidth: 140,
    cell: (r) => (r.partyName ? <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> : null)
  },
  { id: 'bank', header: 'Bank', kind: 'text', value: (r) => r.bankLedgerName, width: 130, className: 'text-muted' },
  { id: 'instrument', header: 'Instrument', kind: 'text', value: (r) => r.instrumentNo, width: 120, groupable: false, className: 'num text-muted' },
  { id: 'instrumentDate', header: 'Instrument date', kind: 'date', value: (r) => r.instrumentDate, defaultHidden: true, width: 150, className: 'text-muted' },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, aggregate: 'sum', width: 130 },
  {
    id: 'status',
    header: 'Status',
    kind: 'enum',
    value: (r) => r.status,
    options: (Object.keys(STATUS_LABEL) as PdcRegisterRow['status'][]).map((k) => ({ value: k, label: STATUS_LABEL[k] })),
    width: 150,
    cell: (r) => (
      <span title={r.bounceReason ?? undefined}>
        <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
      </span>
    )
  }
])

export function PdcTab(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const today = todayISO()
  const { data: rows, isLoading } = useQuery({ queryKey: ['pdc', today], queryFn: () => bankingApi.pdc.register(today) })
  const [bounce, setBounce] = useState<PdcRegisterRow | null>(null)
  const [showDone, setShowDone] = useState(false)

  const invalidate = (): Promise<unknown> =>
    Promise.all(['pdc', 'bankRecon', 'brs', 'dashboard'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })))

  const mature = async (r: PdcRegisterRow): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Mature now',
      message: `Bring post-dated voucher ${r.number} into the books now? It will start counting in reports and balances immediately.`,
      confirmLabel: 'Mature now'
    })
    if (!proceed) return
    try {
      await api.pdc.mature(r.voucherId)
      await invalidate()
      toast.push('success', `${r.number} matured into the books`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const all = rows ?? []
  const shown = showDone ? all : all.filter((r) => r.status === 'pending' || r.status === 'due' || (r.status === 'matured' && r.date >= addDaysIso(today, -30)))
  const pending = all.filter((r) => r.status === 'pending' || r.status === 'due')
  const week = pending.filter((r) => r.date <= addDaysIso(today, 7))
  const sum = (xs: PdcRegisterRow[]): number => xs.reduce((s, r) => s + r.amount, 0)

  return (
    <>
      <StatGrid className="mb-3">
        <StatTile label="Received, pending" value={<Money paise={sum(pending.filter((r) => r.direction === 'received'))} />} hint={`${pending.filter((r) => r.direction === 'received').length} cheques`} />
        <StatTile label="Issued, pending" value={<Money paise={sum(pending.filter((r) => r.direction === 'issued'))} />} hint={`${pending.filter((r) => r.direction === 'issued').length} cheques`} />
        <StatTile label="Maturing this week" value={String(week.length)} hint={week.length ? `${toDisplayDate(today)} – ${toDisplayDate(addDaysIso(today, 7))}` : undefined} />
        <StatTile label="Bounced" value={String(all.filter((r) => r.status === 'bounced').length)} />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="banking-pdc"
          testId="banking-pdc"
          ariaLabel="Post-dated cheques"
          columns={PDC_COLUMNS}
          rows={shown}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId, 'data-status': r.status })}
          rowClassName={(r) => (r.status === 'bounced' ? 'text-muted' : '')}
          loading={isLoading}
          empty={{
            title: 'No post-dated cheques',
            hint: 'Tick “Post-dated” on a payment or receipt to keep it out of the books until its date arrives'
          }}
          maxHeight="60vh"
          toolbarStart={
            <label className="flex items-center gap-2 text-small text-muted">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} data-testid="input-banking-pdc-all" />
              Show all matured &amp; bounced
            </label>
          }
          trailingWidth={170}
          trailing={(r) =>
            r.status === 'pending' || r.status === 'due' ? (
              <>
                <button className="mr-3 text-small text-blue hover:underline" data-testid="btn-banking-pdc-mature" onClick={() => void mature(r)}>
                  Mature now
                </button>
                <button className="text-small text-muted hover:text-ink" data-testid="btn-banking-pdc-edit" onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}>
                  Edit
                </button>
              </>
            ) : r.status === 'matured' ? (
              <button className="text-small text-cr hover:underline" data-testid="btn-banking-pdc-bounce" onClick={() => setBounce(r)}>
                Bounced…
              </button>
            ) : r.bounceVoucherId ? (
              <span className="text-small text-muted">
                Reversed by <VoucherLink voucherId={r.bounceVoucherId} label="voucher" />
              </span>
            ) : null
          }
          exportOptions={{ title: 'Post-dated cheques', periodLabel: `as on ${toDisplayDate(today)}`, filename: 'post-dated-cheques' }}
        />
      </Panel>
      {bounce && (
        <BounceModal
          row={bounce}
          onClose={() => setBounce(null)}
          onDone={() => {
            setBounce(null)
            void invalidate()
          }}
        />
      )}
    </>
  )
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function BounceModal({ row, onClose, onDone }: { row: PdcRegisterRow; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(todayISO() < row.date ? row.date : todayISO())
  const [charges, setCharges] = useState<number | null>(null)
  const [chargesLedgerId, setChargesLedgerId] = useState<number | null>(null)
  const [recover, setRecover] = useState(row.direction === 'received')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await bankingApi.pdc.bounce({
        voucherId: row.voucherId, date, charges: charges ?? 0, chargesLedgerId, recoverChargesFromParty: row.direction === 'received' && recover, reason
      })
      toast.push('success', `Cheque marked bounced — reversal voucher posted${r.chargesVoucherId ? ' with bank charges' : ''}`)
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
      setSaving(false)
    }
  }
  return (
    <Modal title={`Cheque bounced — ${row.number}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-detail text-ink">
          {row.direction === 'received' ? 'Received from' : 'Issued to'} {row.partyName ?? '—'} · <Money paise={row.amount} />
          {row.instrumentNo ? ` · cheque ${row.instrumentNo}` : ''}
        </p>
        <p className="text-hint text-muted">
          A {row.direction === 'received' ? 'payment' : 'receipt'} voucher reverses the entry on the return date; charges are a separate payment from the bank.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Returned on">
            <DateInput value={date} context={row.date} onChange={setDate} testId="input-banking-bounce-date" className="w-40" />
          </Field>
          <Field label="Bank charges">
            <AmountInput paise={charges} onPaise={setCharges} testId="input-banking-bounce-charges" />
          </Field>
        </div>
        {(charges ?? 0) > 0 && row.direction === 'received' && (
          <Checkbox label={`Recover the charges from ${row.partyName ?? 'the party'}`} checked={recover} onChange={setRecover} testId="input-banking-bounce-recover" />
        )}
        {(charges ?? 0) > 0 && !(row.direction === 'received' && recover) && (
          <Field label="Charges ledger">
            <LedgerPicker value={chargesLedgerId} onPick={setChargesLedgerId} placeholder="e.g. Bank Charges" testId="picker-banking-bounce-ledger" />
          </Field>
        )}
        <Field label="Reason">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Funds insufficient" data-testid="input-banking-bounce-reason" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={saving} data-testid="btn-banking-bounce-save" onClick={() => void save()}>
            Record bounce
          </Button>
        </div>
      </div>
    </Modal>
  )
}
