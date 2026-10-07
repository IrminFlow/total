// WP 2.6 — party-wise rates: negotiated rates per customer + item (date-effective, with a
// discount) and the remembered last selling prices. A list under Masters › Party rates, and the
// same table for one party from its ledger form.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatPaise } from '@shared/money'
import { pricingApi, type PartyRate } from '../../lib/pricingClient'
import { useSession, useToasts } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, Modal, Panel, TextInput } from '../../components/ui'
import { Badge } from '../../components/kit'
import { DataTable, defineColumns } from '../../components/table'
import { ItemLink, LedgerLink, VoucherLink } from '../../components/links'
import { ItemPicker, LedgerPicker } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'
import { isPartyLedger } from '../voucher/hooks'

const COLUMNS = defineColumns<PartyRate>([
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.ledgerName, minWidth: 160, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} /> },
  { id: 'item', header: 'Item', kind: 'text', value: (r) => r.itemName, minWidth: 160, hideable: false, cell: (r) => <ItemLink itemId={r.stockItemId} name={r.itemName} /> },
  { id: 'rate', header: 'Rate', kind: 'money', value: (r) => r.ratePaise, width: 120 },
  { id: 'disc', header: 'Disc. %', kind: 'number', value: (r) => (r.discountBp ? r.discountBp / 100 : null), width: 90 },
  { id: 'from', header: 'From', kind: 'date', value: (r) => r.effectiveFrom, width: 110 },
  { id: 'to', header: 'To', kind: 'date', value: (r) => r.effectiveTo, width: 110 },
  {
    id: 'source', header: 'Kind', kind: 'enum', value: (r) => r.source, width: 130,
    options: [{ value: 'manual', label: 'Negotiated' }, { value: 'last_sale', label: 'Last price' }],
    cell: (r) => (r.source === 'manual' ? <Badge tone="info">Negotiated</Badge> : <Badge tone="neutral">Last price</Badge>)
  },
  {
    id: 'lastSold', header: 'Last sold', kind: 'date', value: (r) => r.lastSoldAt, width: 120,
    cell: (r) => (r.lastSoldAt ? <VoucherLink voucherId={r.lastVoucherId} label={r.lastSoldAt.split('-').reverse().join('-')} /> : <span className="text-muted">—</span>)
  }
])

export function PartyRatesTable({ ledgerId, viewId }: { ledgerId?: number; viewId: string }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['partyRates', ledgerId ?? 'all'], queryFn: () => pricingApi.partyRates(ledgerId) })
  const [editing, setEditing] = useState<PartyRate | 'new' | null>(null)
  const columns = useMemo(() => (ledgerId ? COLUMNS.filter((c) => c.id !== 'party') : COLUMNS), [ledgerId])
  const remove = async (r: PartyRate): Promise<void> => {
    if (!(await confirmDialog({ title: 'Remove party rate', message: `Remove ${r.ledgerName}'s rate for ${r.itemName}?`, confirmLabel: 'Remove', danger: true }))) return
    try {
      await pricingApi.deletePartyRate(r.id)
      await queryClient.invalidateQueries({ queryKey: ['partyRates'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <>
      <DataTable
        viewId={viewId}
        testId={viewId}
        ariaLabel="Party rates"
        columns={columns}
        rows={data ?? []}
        rowKey={(r) => r.id}
        rowAttrs={(r) => ({ 'data-row-id': r.id })}
        loading={isLoading}
        onRowActivate={(r) => setEditing(r)}
        empty={{ title: 'No party-wise rates', hint: 'Negotiated rates beat price levels and schemes for that party. Turn on "Remember the last price" in Voucher entry › Options to fill this as you sell.' }}
        trailing={(r) => (
          <button type="button" className="text-small text-cr hover:underline" onClick={() => void remove(r)}>
            Remove
          </button>
        )}
        trailingWidth={84}
        exportOptions={{ title: 'Party rates', periodLabel: 'Masters', filename: 'party-rates' }}
        toolbarEnd={
          <Button size="sm" variant={ledgerId ? 'primary' : 'ghost'} data-testid="btn-party-rate-new" onClick={() => setEditing('new')}>
            Add party rate
          </Button>
        }
      />
      {editing && <PartyRateModal rate={editing === 'new' ? null : editing} ledgerId={ledgerId} onClose={() => setEditing(null)} />}
    </>
  )
}

export function PartyRatesTab(): React.JSX.Element {
  return (
    <Panel>
      <PartyRatesTable viewId="masters-party-rates" />
    </Panel>
  )
}

/** One party's rates — opened from the ledger form. */
export function PartyRatesModal({ ledgerId, name, onClose }: { ledgerId: number; name: string; onClose: () => void }): React.JSX.Element {
  return (
    <Modal title={`Party rates — ${name}`} onClose={onClose} wide>
      <PartyRatesTable ledgerId={ledgerId} viewId="ledger-party-rates" />
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  )
}

function PartyRateModal({ rate, ledgerId, onClose }: { rate: PartyRate | null; ledgerId?: number; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { workingDate } = useSession()
  const [partyId, setPartyId] = useState<number | null>(rate?.ledgerId ?? ledgerId ?? null)
  const [itemId, setItemId] = useState<number | null>(rate?.stockItemId ?? null)
  const [ratePaise, setRatePaise] = useState<number | null>(rate?.ratePaise ?? null)
  const [disc, setDisc] = useState(rate?.discountBp ? String(rate.discountBp / 100) : '')
  const [from, setFrom] = useState(rate?.effectiveFrom ?? '')
  const [to, setTo] = useState(rate?.effectiveTo ?? '')
  const save = async (): Promise<void> => {
    if (!partyId || !itemId || ratePaise == null) return void toast.push('error', 'Pick the party and item and enter the rate')
    try {
      await pricingApi.savePartyRate(
        { ledgerId: partyId, stockItemId: itemId, ratePaise, discountBp: disc.trim() ? Math.round(Number(disc) * 100) : 0, effectiveFrom: from || null, effectiveTo: to || null },
        rate?.id
      )
      await queryClient.invalidateQueries({ queryKey: ['partyRates'] })
      toast.push('success', `Rate ${formatPaise(ratePaise, { symbol: true })} saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={rate ? `${rate.ledgerName} — ${rate.itemName}` : 'New party rate'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {rate?.source === 'last_sale' && (
          <p className="text-hint text-muted">This is a remembered last price; saving it makes it a negotiated rate.</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Party">
            <LedgerPicker value={partyId} onPick={setPartyId} placeholder="Customer" filter={(l, g) => isPartyLedger(l, g)} testId="picker-party-rate-party" />
          </Field>
          <Field label="Item">
            <ItemPicker value={itemId} onPick={setItemId} testId="picker-party-rate-item" />
          </Field>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Rate (excl. GST)">
            <AmountInput paise={ratePaise} onPaise={setRatePaise} testId="input-party-rate" />
          </Field>
          <Field label="Disc. %">
            <TextInput value={disc} onChange={(e) => setDisc(e.target.value)} className="num text-right" placeholder="0" data-testid="input-party-rate-disc" />
          </Field>
          <Field label="From">
            <DateInput value={from} context={workingDate} onChange={setFrom} allowEmpty placeholder="Always" />
          </Field>
          <Field label="To">
            <DateInput value={to} context={workingDate} onChange={setTo} allowEmpty placeholder="Open" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} data-testid="btn-party-rate-save">
            Save rate
          </Button>
        </div>
      </div>
    </Modal>
  )
}
