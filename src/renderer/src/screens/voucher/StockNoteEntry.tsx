// Delivery challan / goods receipt note entry (WP 2.5b). A party, the purpose, the shared item
// grid (qty, rate, discount, godown, batch, serials — no ledger lines), the transport fields the
// e-way bill needs, and a display-only value with tax. State → payload lives in
// @shared/voucherEdit/stockNote; an alteration's `initial` comes from planVoucherEdit, which has
// already proved the note round-trips through this form unchanged.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TradePurpose, Voucher } from '@shared/domain'
import {
  buildStockNotePayload, computeStockNote, documentNumberWarning, emptyStockNoteState, purposeIsTaxed, STOCK_NOTE_PURPOSES,
  type StockNoteContext, type StockNoteFormState, type StockNoteKind
} from '@shared/voucherEdit'
import { formatPaise, amountInWords } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Banner, Button, DateInput, Field, isAnyModalOpen, Money, Panel, Segmented, TextInput } from '../../components/ui'
import { LedgerPicker, useLedgers, useStockItems } from '../../components/pickers'
import { VoucherLink } from '../../components/links'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { nextLineKey, NUMBER_LOADING, useAlterationDirty, useLeaveAfterSave, useVoucherNumberField } from './hooks'
import { QuickItemModal, QuickLedgerModal } from './modals'
import { TransportModal } from './TransportModal'
import { blankItemRow, ItemLineGrid, type ItemRow } from './ItemLineGrid'

const TITLE: Record<StockNoteKind, string> = { delivery_note: 'Delivery challan', receipt_note: 'Goods receipt note' }

export function StockNoteEntry({
  typeId,
  kind,
  voucherId,
  voucher,
  initial
}: {
  typeId: number
  kind: StockNoteKind
  voucherId?: number
  voucher?: Voucher
  initial?: StockNoteFormState
}): React.JSX.Element {
  const isEdit = voucherId != null
  const { info, workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const ledgers = useLedgers()
  const items = useStockItems()
  const outward = kind === 'delivery_note'

  const [start] = useState(() => initial ?? emptyStockNoteState(kind, workingDate))
  const [date, setDate] = useState(start.date)
  const [partyId, setPartyId] = useState<number | null>(start.partyId)
  const [purpose, setPurpose] = useState<TradePurpose>(start.purpose)
  const [rows, setRows] = useState<ItemRow[]>(() =>
    initial ? [...initial.rows.map((r) => ({ ...r, key: nextLineKey() })), blankItemRow()] : [blankItemRow()]
  )
  const [narration, setNarration] = useState(start.narration)
  const [reference, setReference] = useState(start.reference)
  const [vehicleNo, setVehicleNo] = useState(start.vehicleNo)
  const [transporterId, setTransporterId] = useState(start.transporterId)
  const [distanceKm, setDistanceKm] = useState(start.distanceKm)
  const [alterNumber, setAlterNumber] = useState(start.number)
  const [saving, setSaving] = useState(false)
  const [showTransport, setShowTransport] = useState(false)
  const [quickLedger, setQuickLedger] = useState<string | null>(null)
  const [quickItem, setQuickItem] = useState<{ name: string; row: number } | null>(null)
  const numberField = useVoucherNumberField(typeId, date, voucherId)
  const { saved, leave } = useLeaveAfterSave()

  const party = ledgers.find((l) => l.id === partyId) ?? null

  // Downstream documents (invoices / bills drawn from this note) — shown on an alteration.
  const { data: links } = useQuery({
    queryKey: ['voucher', voucherId, 'links'],
    queryFn: () => api.links.forVoucher(voucherId!),
    enabled: isEdit
  })

  const ctx: StockNoteContext = useMemo(
    () => ({
      kind,
      companyStateCode: info!.stateCode,
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode }]))
    }),
    [kind, info, items, ledgers]
  )

  const formState: StockNoteFormState = useMemo(
    () => ({
      ...start,
      date,
      number: isEdit ? alterNumber : numberField.forPayload,
      partyId,
      purpose,
      rows: rows.map(({ key: _key, ...r }) => r),
      narration,
      reference,
      vehicleNo,
      transporterId,
      distanceKm
    }),
    [start, date, isEdit, alterNumber, numberField.forPayload, partyId, purpose, rows, narration, reference, vehicleNo, transporterId, distanceKm]
  )
  const computed = useMemo(() => computeStockNote(formState, ctx), [formState, ctx])
  const value = computed.gst.total

  const alterationDirty = useAlterationDirty(voucher, isEdit ? buildStockNotePayload(formState, ctx, typeId) : null)
  useUnsavedGuard(!saved && (isEdit ? alterationDirty : partyId != null || rows.some((r) => r.itemId != null) || narration.trim() !== ''))

  const shownNumber = isEdit ? alterNumber : numberField.value === NUMBER_LOADING ? '' : numberField.value
  const numberWarning = outward ? documentNumberWarning(shownNumber) : null

  const setRow = (i: number, patch: Partial<ItemRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      if (next[next.length - 1]!.itemId != null) next.push(blankItemRow())
      return next
    })
  }

  const save = useCallback(async (andPrint = false): Promise<void> => {
    if (saving) return
    const built = buildStockNotePayload(formState, ctx, typeId)
    if (!built.ok) return void toast.push('error', built.error)
    setSaving(true)
    try {
      const input = built.payload
      if (input.number && (await api.vouchers.numberExists(typeId, input.number, voucherId))) {
        const proceed = await confirmDialog({
          title: 'Duplicate number',
          message: `Number ${input.number} is already used by another ${TITLE[kind].toLowerCase()}. Save anyway with the same number?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const result = await api.vouchers.save(input, voucherId)
      toast.push('success', `${TITLE[kind]} ${result.number} ${isEdit ? 'altered' : 'saved'} — ${formatPaise(value, { symbol: true })}`)
      for (const w of result.warnings?.linkDates ?? []) toast.push('warning', w)
      if (andPrint) await api.invoice.pdf(result.id)
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (isEdit) return void leave()
      setPartyId(null)
      setRows([blankItemRow()])
      setNarration('')
      setReference('')
      setVehicleNo('')
      setTransporterId('')
      setDistanceKm('')
      numberField.reset()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, formState, ctx, typeId, toast, voucherId, kind, isEdit, value, setWorkingDate, date, queryClient, leave, numberField])

  const remove = async (): Promise<void> => {
    if (!voucherId) return
    const proceed = await confirmDialog({
      title: 'Move to Bin',
      message: `Move this ${TITLE[kind].toLowerCase()} to the Bin? You can restore it from the bin for 30 days.`,
      confirmLabel: 'Move to Bin',
      danger: true
    })
    if (!proceed) return
    try {
      await api.vouchers.remove(voucherId)
      toast.push('success', 'Moved to Bin')
      await queryClient.invalidateQueries()
      leave()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (isAnyModalOpen()) return
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  const downstream = (links?.downstream ?? []).filter((l) => l.live)
  const taxed = purposeIsTaxed(purpose)

  return (
    <Panel className="p-5" testId={`stock-note-${kind}`}>
      {downstream.length > 0 && (
        <Banner tone="info" className="mb-3" testId="stock-note-linked">
          {outward ? 'Invoiced' : 'Billed'} on{' '}
          {[...new Map(downstream.map((l) => [l.otherVoucherId, l])).values()].map((l, i) => (
            <span key={l.linkId}>
              {i > 0 && ', '}
              {l.otherVoucherId ? <VoucherLink voucherId={l.otherVoucherId} label={l.otherLabel.replace(/ line \d+$/, '')} /> : l.otherLabel}
            </span>
          ))}
          {' '}— lines drawn on by {outward ? 'an invoice' : 'a bill'} keep their item, godown, batch and serials.
        </Banner>
      )}
      <div className="grid grid-cols-4 gap-3">
        <Field
          label={outward ? 'Challan no.' : 'GRN no.'}
          hint={numberWarning ?? (isEdit || numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override')}
        >
          <TextInput
            value={shownNumber}
            onChange={(e) => (isEdit ? setAlterNumber(e.target.value) : numberField.onChange(e.target.value))}
            placeholder="Auto"
            className={`num ${numberWarning ? '!border-cr' : ''}`}
            data-testid="input-stock-note-number"
          />
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <Field label={outward ? 'Consignee (party)' : 'Supplier (party)'}>
          <LedgerPicker
            autoFocus={!isEdit}
            value={partyId}
            onPick={setPartyId}
            placeholder="Party ledger"
            onCreateRequest={(name) => setQuickLedger(name)}
            testId="picker-party"
          />
        </Field>
        <Field label={outward ? "Buyer's order / ref." : "Supplier's challan / ref."}>
          <TextInput value={reference} onChange={(e) => setReference(e.target.value)} data-testid="input-stock-note-reference" />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-caption text-muted">Purpose</span>
          <Segmented
            label="Purpose"
            size="sm"
            options={STOCK_NOTE_PURPOSES[kind]}
            value={purpose}
            onChange={setPurpose}
            testId="input-stock-note-purpose"
          />
        </div>
        {party && (
          <p className="text-hint text-muted">
            {party.gstin ? <>GSTIN <span className="num">{party.gstin}</span> · </> : 'Unregistered · '}
            {computed.supply === 'intra' ? 'Intra-state' : 'Inter-state'}
            {!taxed && ' · value only, no tax (not a supply)'}
          </p>
        )}
      </div>

      <ItemLineGrid
        rows={rows}
        setRow={setRow}
        setRows={setRows}
        direction={outward ? 'out' : 'in'}
        priceLevelId={party?.priceLevelId ?? null}
        fxActive={false}
        date={date}
        voucherId={voucherId}
        onCreateItem={(name, row) => setQuickItem({ name, row })}
      />

      <div className="mt-4 flex items-start justify-between gap-6">
        <div className="flex-1">
          <Field label="Narration">
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder={outward ? 'Goods sent…' : 'Goods received…'} />
          </Field>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Field label="Vehicle no.">
              <TextInput value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value.toUpperCase())} placeholder="MH01AB1234" className="num" data-testid="input-stock-note-vehicle" />
            </Field>
            <Field label="Transporter ID">
              <TextInput value={transporterId} onChange={(e) => setTransporterId(e.target.value.toUpperCase())} placeholder="For e-way bill" className="num" />
            </Field>
            <Field label="Distance km">
              <TextInput value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} placeholder="0" className="num text-right" />
            </Field>
          </div>
          {value > 0 && <p className="mt-2 text-hint text-muted italic">{amountInWords(value)}</p>}
        </div>
        <div className="num w-72 text-detail" data-testid="stock-note-totals">
          <SummaryRow label="Taxable value" paise={computed.gst.taxable} />
          {computed.gst.cgst > 0 && <SummaryRow label="CGST" paise={computed.gst.cgst} />}
          {computed.gst.sgst > 0 && <SummaryRow label="SGST" paise={computed.gst.sgst} />}
          {computed.gst.igst > 0 && <SummaryRow label="IGST" paise={computed.gst.igst} />}
          {computed.gst.cess > 0 && <SummaryRow label="Cess" paise={computed.gst.cess} />}
          <div className="mt-1 flex justify-between border-t border-ink pt-1.5 pb-0.5 text-subtitle font-semibold" style={{ borderBottom: '3px double var(--color-ink)' }}>
            <span>Value of goods</span>
            <Money paise={value} />
          </div>
          <p className="mt-1 text-hint text-muted not-italic">
            Nothing posts to the books — stock {outward ? 'leaves' : 'comes in'} on {toDisplayDate(date)}.
          </p>
        </div>
      </div>

      <div className="mt-5 flex justify-between">
        <div>{isEdit && <Button variant="danger" onClick={() => void remove()}>Delete</Button>}</div>
        <div className="flex gap-2">
          {isEdit && (
            <Button data-testid="btn-voucher-transport" onClick={() => setShowTransport(true)}>
              Transport / e-way details…
            </Button>
          )}
          {isEdit && (
            <Button
              data-testid="btn-stock-note-print"
              onClick={() => void api.invoice.pdf(voucherId!).catch((err: Error) => toast.push('error', err.message))}
            >
              Print PDF
            </Button>
          )}
          <Button onClick={() => nav.back()}>Cancel</Button>
          {!isEdit && (
            <Button disabled={saving} onClick={() => void save(true)} data-testid="btn-stock-note-save-print">
              Save + PDF
            </Button>
          )}
          <Button variant="primary" data-testid="btn-save-voucher" disabled={saving} onClick={() => void save()}>
            {isEdit ? 'Save changes' : `Save ${outward ? 'challan' : 'GRN'}`} ⌘↵
          </Button>
        </div>
      </div>

      {quickLedger != null && (
        <QuickLedgerModal
          name={quickLedger}
          suggestParty={outward}
          suggestAccount={null}
          onClose={() => setQuickLedger(null)}
          onCreated={(l) => {
            setPartyId(l.id)
            setQuickLedger(null)
          }}
        />
      )}
      {quickItem && (
        <QuickItemModal
          name={quickItem.name}
          onClose={() => setQuickItem(null)}
          onCreated={(id) => {
            setRow(quickItem.row, { itemId: id })
            setQuickItem(null)
          }}
        />
      )}
      {showTransport && voucherId && (
        <TransportModal voucherId={voucherId} voucherNumber={voucher?.number} onClose={() => setShowTransport(false)} />
      )}
    </Panel>
  )
}

function SummaryRow({ label, paise }: { label: string; paise: number }): React.JSX.Element {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted">{label}</span>
      <Money paise={paise} />
    </div>
  )
}
