import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Voucher, VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import {
  buildInvoicePayload, computeInvoice, requiredTaxLedgers, taxLedgerIdsFrom,
  type InvoiceContext, type InvoiceFormState, type InvoiceRowState, type TaxLedgerIds
} from '@shared/voucherEdit'
import { GST_STATES } from '@shared/gst/states'
import { formatPaise, amountInWords } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts, type VoucherDraft } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, isAnyModalOpen, LineTableScroller, Money, Panel, Select, TextInput, inputCls } from '../../components/ui'
import { ItemPicker, LedgerPicker, useLedgers, useStockItems, useTaxLedgers } from '../../components/pickers'
import { LedgerFormModal } from '../../components/LedgerFormModal'
import { useFeatures } from '../../lib/useFeatures'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { addDaysLocal, nextLineKey, NUMBER_LOADING, useAlterationDirty, useLeaveAfterSave, useVoucherNumberField } from './hooks'
import { QuickItemModal, QuickLedgerModal } from './modals'
import { TransportModal } from './TransportModal'

// ---------- invoice mode (sales / purchase / notes) ----------

// Field semantics (rate/discount in the invoice currency, godown/batch carried for saved lines)
// and every state → payload rule live in @shared/voucherEdit/invoice — this component only owns
// the inputs. `initial` (an alteration) comes from planVoucherEdit, which has already proved the
// voucher round-trips through this form unchanged.
interface ItemRow extends InvoiceRowState {
  /** Stable React key — survives the trailing-blank-row insertions (never an array index). */
  key: number
}

const blankItemRow = (): ItemRow => ({ key: nextLineKey(), itemId: null, qtyText: '', rate: null, discount: null, godownId: null, batchId: null })

export function InvoiceEntry({
  typeId,
  kind,
  draft,
  voucherId,
  voucher,
  initial
}: {
  typeId: number
  kind: VoucherKind
  draft?: VoucherDraft
  /** Alteration: the saved voucher and the form state reconstructed from it. */
  voucherId?: number
  voucher?: Voucher
  initial?: InvoiceFormState
}): React.JSX.Element {
  const isEdit = voucherId != null
  const { info, workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const ledgers = useLedgers()
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const { ensure: ensureTax, ensureRoundOff } = useTaxLedgers()

  const [date, setDate] = useState(initial?.date ?? draft?.date ?? workingDate)
  const [partyId, setPartyId] = useState<number | null>(initial ? initial.partyId : (draft?.partyLedgerId ?? null))
  const [accountId, setAccountId] = useState<number | null>(initial?.accountId ?? null)
  const [rows, setRows] = useState<ItemRow[]>(() =>
    initial ? [...initial.rows.map((r) => ({ ...r, key: nextLineKey() })), blankItemRow()] : [blankItemRow()]
  )
  const [narration, setNarration] = useState(initial?.narration ?? draft?.narration ?? '')
  const [vehicleNo, setVehicleNo] = useState(initial?.vehicleNo ?? '')
  const [transporterId, setTransporterId] = useState(initial?.transporterId ?? '')
  const [distanceKm, setDistanceKm] = useState(initial?.distanceKm ?? '')
  const [currencyCode, setCurrencyCode] = useState(initial?.currencyCode ?? '')
  const [fxRateText, setFxRateText] = useState(initial?.fxRateText ?? '')
  const { data: currencies } = useQuery({ queryKey: ['currencies'], queryFn: api.currencies.list })
  const [quickLedger, setQuickLedger] = useState<{ name: string; forParty: boolean } | null>(null)
  const [quickItem, setQuickItem] = useState<{ name: string; row: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [editingParty, setEditingParty] = useState(false)
  const [showTransport, setShowTransport] = useState(false)
  // ---------- GST details (place-of-supply override + memorandum flag) ----------
  const [gstOpen, setGstOpen] = useState(false)
  const [posOverride, setPosOverride] = useState<string | null>(initial?.posOverride ?? null)
  const [optionalVoucher, setOptionalVoucher] = useState(initial?.optional ?? false)

  const numberField = useVoucherNumberField(typeId, date, voucherId)
  // Alteration keeps the voucher's own number (editable) and never auto-suggests a fresh one —
  // same rule as AccountingEntry.
  const [alterNumber, setAlterNumber] = useState(initial?.number ?? '')
  const isSalesSide = kind === 'sales' || kind === 'credit_note'
  const { saved, leave } = useLeaveAfterSave()

  const party = ledgers.find((l) => l.id === partyId) ?? null
  const account = ledgers.find((l) => l.id === accountId) ?? null

  // ---------- bill allocation ----------
  // sales/purchase: one default 'new' ref named after the voucher no, auto-synced to the
  // party-line total until the user edits the name/due-date directly.
  // credit/debit notes: default to allocating AGAINST the party's open bills (a note adjusts an
  // existing invoice) — "create new bill instead" restores the sales/purchase-style single ref.
  const isNoteKind = kind === 'credit_note' || kind === 'debit_note'
  const [billsOpen, setBillsOpen] = useState(true)
  // An alteration's bill name / due date are what was saved — never re-synced from the number.
  const [billName, setBillName] = useState(initial?.billName ?? '')
  const [billNameTouched, setBillNameTouched] = useState(!!initial)
  const [billDueDate, setBillDueDate] = useState(initial ? initial.billDueDate : date)
  const [billDueDateTouched, setBillDueDateTouched] = useState(!!initial)
  const [manualNewBillMode, setManualNewBillMode] = useState(initial?.manualNewBillMode ?? false)
  const [noteBillRefs, setNoteBillRefs] = useState<VoucherBillRef[]>(initial?.noteBillRefs ?? [])

  useEffect(() => {
    if (!billNameTouched && numberField.value !== NUMBER_LOADING) setBillName(numberField.value)
  }, [numberField.value, billNameTouched])

  useEffect(() => {
    if (billDueDateTouched) return
    setBillDueDate(addDaysLocal(date, party?.creditDays ?? 0))
  }, [date, party?.creditDays, billDueDateTouched])

  // A party switch invalidates any bills already checked against the OLD party — 'against' refs
  // are matched server-side by name only, so a stale ref would silently misallocate against
  // whatever same-named (or FIFO-fallback) bill the NEW party happens to have. Also resets the
  // note's manual-entry state so a party-specific typed name/due-date doesn't linger either.
  // Keyed off an actual party change (not mount), so an alteration's loaded allocations survive.
  const allocParty = useRef(partyId)
  useEffect(() => {
    if (allocParty.current === partyId) return
    allocParty.current = partyId
    setNoteBillRefs([])
    if (isNoteKind) {
      setManualNewBillMode(false)
      setBillNameTouched(false)
      setBillDueDateTouched(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId])

  const { data: openBillsForNote } = useQuery({
    queryKey: ['billsOpen', partyId, date],
    queryFn: () => api.bills.open(partyId!, date),
    enabled: !!partyId && isNoteKind && !manualNewBillMode
  })

  // Everything the shared invoice math needs, from the same masters the pickers show.
  const ctx: InvoiceContext = useMemo(
    () => ({
      kind,
      companyStateCode: info!.stateCode,
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
    }),
    [kind, info, items, ledgers]
  )

  const formState: InvoiceFormState = useMemo(
    () => ({
      date,
      number: isEdit ? alterNumber : numberField.forPayload,
      partyId,
      accountId,
      rows: rows.map(({ key: _key, ...r }) => r),
      narration,
      vehicleNo,
      transporterId,
      distanceKm,
      currencyCode,
      fxRateText,
      posOverride,
      optional: optionalVoucher,
      billName,
      billDueDate,
      manualNewBillMode,
      noteBillRefs,
      reference: initial?.reference ?? null,
      instrumentNo: initial?.instrumentNo ?? null,
      instrumentDate: initial?.instrumentDate ?? null
    }),
    [date, isEdit, alterNumber, numberField.forPayload, partyId, accountId, rows, narration, vehicleNo, transporterId, distanceKm, currencyCode, fxRateText, posOverride, optionalVoucher, billName, billDueDate, manualNewBillMode, noteBillRefs, initial]
  )

  const computed = useMemo(() => computeInvoice(formState, ctx), [formState, ctx])
  const { supply, fxActive } = computed

  // Unsaved-changes guard: a fresh invoice is dirty once anything meaningful is typed (save
  // resets all of these); an alteration once what it would post differs from the saved voucher.
  const alterationDirty = useAlterationDirty(
    voucher,
    isEdit ? buildInvoicePayload(formState, ctx, typeId, taxLedgerIdsFrom(ledgers)) : null
  )
  useUnsavedGuard(
    !saved && (isEdit ? alterationDirty : partyId != null || rows.some((r) => r.itemId != null) || narration.trim() !== '')
  )

  const noteAllocatedTotal = noteBillRefs.reduce((s, r) => s + r.amount, 0)

  const toggleNoteBill = (bill: OutstandingBill, checked: boolean): void => {
    setNoteBillRefs((refs) => {
      if (checked) {
        const remaining = Math.max(0, computed.rounded - refs.reduce((s, r) => s + r.amount, 0))
        const amount = Math.min(bill.pending, remaining || bill.pending)
        return [...refs, { kind: 'against', name: bill.number, amount, dueDate: null }]
      }
      return refs.filter((r) => !(r.kind === 'against' && r.name === bill.number))
    })
  }
  const setNoteBillAmount = (name: string, amount: number): void =>
    setNoteBillRefs((refs) => refs.map((r) => (r.name === name ? { ...r, amount } : r)))

  // Builds the exact VoucherInputParsed shape `save` posts.
  // Async: computing the tax/round-off lines may create those ledgers on first use (ensureTax /
  // ensureRoundOff), same as it does on a normal save.
  const buildPayload = useCallback(async (): Promise<VoucherInputParsed | null> => {
    if (!partyId || !accountId || computed.detail.length === 0) return null
    // Tax / Round Off ledgers are created on first use, same as before — then the shared
    // builder lays out the lines.
    const taxLedgers: TaxLedgerIds = { cgst: null, sgst: null, igst: null, cess: null, roundOff: null }
    for (const k of requiredTaxLedgers(computed)) {
      taxLedgers[k] = k === 'roundOff' ? await ensureRoundOff() : await ensureTax(k)
    }
    const r = buildInvoicePayload(formState, ctx, typeId, taxLedgers)
    if (!r.ok) throw new Error(r.error)
    return r.payload
  }, [partyId, accountId, computed, formState, ctx, typeId, ensureTax, ensureRoundOff])

  const save = useCallback(async (andPdf = false): Promise<void> => {
    if (saving) return
    if (!partyId) return void toast.push('error', 'Pick the party account first')
    if (!accountId) return void toast.push('error', `Pick the ${isSalesSide ? 'sales' : 'purchase'} ledger`)
    if (computed.detail.length === 0) return void toast.push('error', 'Add at least one item line')
    setSaving(true)
    try {
      const input = await buildPayload()
      if (!input) return
      // Duplicate-number confirm — catches a manually typed number that's already on the books
      // (and the auto-suggested one losing a race with another entry screen).
      if (input.number && (await api.vouchers.numberExists(typeId, input.number, voucherId))) {
        const proceed = await confirmDialog({
          title: 'Duplicate number',
          message: `Voucher number ${input.number} is already used by another voucher of this type. Save anyway with the same number?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const dupes = await api.vouchers.duplicates(input, voucherId)
      if (dupes.length > 0) {
        const first = dupes[0]!
        const proceed = await confirmDialog({
          title: 'Possible duplicate',
          message: `Voucher ${first.number} on ${first.date} has the same party and amount. Save anyway?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const result = await api.vouchers.save(input, voucherId)
      toast.push('success', `${result.number} ${isEdit ? 'altered' : 'saved'} — ${formatPaise(computed.rounded, { symbol: true })}`)
      if (andPdf && kind === 'sales') {
        await api.invoice.pdf(result.id)
      }
      setWorkingDate(date)
      if (isEdit) {
        await queryClient.invalidateQueries()
        leave()
        return
      }
      setPartyId(null)
      setRows([blankItemRow()])
      setNarration('')
      setVehicleNo('')
      setDistanceKm('')
      setPosOverride(null)
      setOptionalVoucher(false)
      setBillNameTouched(false)
      setBillDueDateTouched(false)
      setNoteBillRefs([])
      numberField.reset()
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, partyId, accountId, computed, buildPayload, isSalesSide, kind, typeId, voucherId, isEdit, date, toast, setWorkingDate, queryClient, numberField.reset, leave])

  const remove = async (): Promise<void> => {
    if (!voucherId) return
    const proceed = await confirmDialog({
      title: 'Move to Bin',
      message: 'Move this voucher to the Bin? You can restore it from the bin for 30 days.',
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
        // A modal's own ⌘↵ (or a stray one) must not save the invoice underneath it.
        if (isAnyModalOpen()) return
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  const setRow = (i: number, patch: Partial<ItemRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.itemId != null) next.push(blankItemRow())
      return next
    })
  }

  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const unitOf = (itemId: number | null): string => {
    if (!itemId || !units) return ''
    const item = itemMap.get(itemId)
    return units.find((u) => u.id === item?.unitId)?.symbol ?? ''
  }

  return (
    <Panel className="p-5">
      <div className="grid grid-cols-4 gap-3">
        <Field label="No." hint={isEdit || numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={isEdit ? alterNumber : numberField.value === NUMBER_LOADING ? '' : numberField.value}
            onChange={(e) => (isEdit ? setAlterNumber(e.target.value) : numberField.onChange(e.target.value))}
            placeholder="Auto"
            className="num"
          />
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <Field label={isSalesSide ? 'Party (buyer)' : 'Party (supplier)'}>
          <div className="flex items-center gap-1.5">
            <LedgerPicker
              autoFocus={!isEdit}
              value={partyId}
              onPick={setPartyId}
              placeholder="Party ledger"
              onCreateRequest={(name) => setQuickLedger({ name, forParty: true })}
              className="flex-1"
              testId="picker-party"
            />
            {party && (
              <Button variant="ghost" className="shrink-0 px-2 py-1 text-caption" onClick={() => setEditingParty(true)}>
                Edit
              </Button>
            )}
          </div>
        </Field>
        <Field label={isSalesSide ? 'Sales ledger' : 'Purchase ledger'}>
          <LedgerPicker
            value={accountId}
            onPick={setAccountId}
            placeholder={isSalesSide ? 'e.g. Sales' : 'e.g. Purchases'}
            filter={(l, groups) => {
              const rootName = isSalesSide ? 'Sales Accounts' : 'Purchase Accounts'
              let g = groups.get(l.groupId)
              while (g) {
                if (g.name === rootName) return true
                g = g.parentId ? groups.get(g.parentId) : undefined
              }
              return false
            }}
            onCreateRequest={(name) => setQuickLedger({ name, forParty: false })}
          />
        </Field>
      </div>

      <div className="mt-2 flex items-center justify-between">
        {party ? (
          <p className="text-hint text-muted">
            {party.gstin ? <>GSTIN <span className="num">{party.gstin}</span> · </> : 'Unregistered · '}
            {supply === 'intra' ? 'Intra-state — CGST + SGST' : 'Inter-state — IGST'}
          </p>
        ) : (
          <span />
        )}
        {features.multiCurrency && (currencies?.length ?? 0) > 0 && (
          <div className="flex items-center gap-2">
            <Select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="w-28">
              <option value="">₹ INR</option>
              {(currencies ?? []).map((c) => (
                <option key={c.id} value={c.code}>
                  {c.symbol} {c.code}
                </option>
              ))}
            </Select>
            {currencyCode && (
              <>
                <TextInput
                  value={fxRateText}
                  onChange={(e) => setFxRateText(e.target.value)}
                  placeholder={`₹ per ${currencyCode}`}
                  className="num w-28 text-right"
                />
                {fxActive && <span className="text-caption text-muted">rates in {currencyCode} · books in ₹</span>}
              </>
            )}
          </div>
        )}
      </div>

      {/* Long invoices scroll inside a capped container instead of pushing the totals
          off-screen. Short ones stay unwrapped: any overflow container would clip the
          absolutely-positioned TypeAhead dropdowns. */}
      <LineTableScroller active={rows.length > 8} className="mt-4">
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="r w-28">Qty</th>
            <th className="r w-32">Rate</th>
            <th className="r w-28">Disc.</th>
            <th className="r w-24">GST %</th>
            <th className="r w-36">Amount</th>
          </tr>
        </thead>
        <tbody data-testid="rows-invoice-lines">
          {rows.map((r, i) => {
            const item = r.itemId ? itemMap.get(r.itemId) : null
            const qty = parseFloat(r.qtyText || '0')
            const amount =
              item && qty > 0 && r.rate != null ? Math.max(0, Math.round(qty * r.rate) - (r.discount ?? 0)) : 0
            return (
              <tr key={r.key}>
                <td>
                  <ItemPicker
                    value={r.itemId}
                    onPick={(id) => {
                      // A batch belongs to one item — a different item can't keep the old line's.
                      setRow(i, id === r.itemId ? { itemId: id } : { itemId: id, batchId: null })
                      // Price-level autofill: the party's price list fills an empty Rate cell.
                      // Price-list rates are ₹, so skip while a foreign currency is active.
                      if (id != null && r.rate == null && !fxActive && party?.priceLevelId != null) {
                        const rowKey = r.key
                        void api.priceLevels
                          .rateFor(party.priceLevelId, id, date)
                          .then((rate) => {
                            if (rate == null) return
                            setRows((rs) =>
                              rs.map((row) =>
                                row.key === rowKey && row.itemId === id && row.rate == null ? { ...row, rate } : row
                              )
                            )
                          })
                          .catch(() => {}) // a missing rate just leaves the cell for the user
                      }
                    }}
                    onCreateRequest={(name) => setQuickItem({ name, row: i })}
                  />
                </td>
                <td className="r">
                  <div className="flex items-center gap-1.5">
                    <input
                      className={`${inputCls} num text-right`}
                      data-testid="input-line-qty"
                      value={r.qtyText}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(e) => setRow(i, { qtyText: e.target.value })}
                    />
                    <span className="w-8 text-caption text-muted">{unitOf(r.itemId)}</span>
                  </div>
                </td>
                <td className="r">
                  <AmountInput paise={r.rate} onPaise={(p) => setRow(i, { rate: p })} testId="input-line-rate" />
                </td>
                <td className="r">
                  <AmountInput
                    paise={r.discount}
                    onPaise={(p) => setRow(i, { discount: p })}
                    placeholder="0"
                    testId="input-line-discount"
                  />
                </td>
                <td className="r">
                  <span className="num text-body-sm text-muted">{item ? `${item.gstRate ?? account?.gstRate ?? 0}%` : ''}</span>
                </td>
                <td className="r">
                  <Money paise={amount} className="text-body" />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </LineTableScroller>

      <div className="mt-4 flex items-start justify-between gap-6">
        <div className="flex-1">
          <Field label="Narration">
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being goods sold…" />
          </Field>
          {isSalesSide && kind === 'sales' && (
            <div className="mt-3 grid grid-cols-3 gap-3">
              <Field label="Vehicle no.">
                <TextInput value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value.toUpperCase())} placeholder="MH01AB1234" className="num" />
              </Field>
              <Field label="Transporter ID">
                <TextInput value={transporterId} onChange={(e) => setTransporterId(e.target.value.toUpperCase())} placeholder="For e-way bill" className="num" />
              </Field>
              <Field label="Distance km">
                <TextInput value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)} placeholder="0" className="num text-right" />
              </Field>
            </div>
          )}
          {computed.rounded > 0 && (
            <p className="mt-2 text-hint text-muted italic">{amountInWords(computed.rounded)}</p>
          )}
        </div>
        <div className="num w-72 text-detail">
          <SummaryRow label="Taxable value" paise={computed.gst.taxable} />
          {computed.gst.cgst > 0 && <SummaryRow label="CGST" paise={computed.gst.cgst} />}
          {computed.gst.sgst > 0 && <SummaryRow label="SGST" paise={computed.gst.sgst} />}
          {computed.gst.igst > 0 && <SummaryRow label="IGST" paise={computed.gst.igst} />}
          {computed.gst.cess > 0 && <SummaryRow label="Cess" paise={computed.gst.cess} />}
          {computed.roundDiff !== 0 && <SummaryRow label="Round off" paise={computed.roundDiff} />}
          <div className="mt-1 flex justify-between border-t border-ink pt-1.5 pb-0.5 text-subtitle font-semibold" style={{ borderBottom: '3px double var(--color-ink)' }}>
            <span>Total</span>
            <Money paise={computed.rounded} />
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <button
          data-testid="btn-invoice-gst-details"
          className="flex items-center gap-1.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase"
          onClick={() => setGstOpen((v) => !v)}
        >
          <span className="inline-block w-3 text-micro">{gstOpen ? '▾' : '▸'}</span>
          GST details
          {(posOverride || optionalVoucher) && (
            <span className="normal-case text-muted/80">
              {' '}
              ·{posOverride ? ` POS ${posOverride} — ${GST_STATES[posOverride] ?? ''}` : ''}
              {optionalVoucher ? ' optional (memorandum)' : ''}
            </span>
          )}
        </button>
        {gstOpen && (
          <div className="mt-2 grid grid-cols-3 items-end gap-3">
            <Field
              label="Place of supply"
              hint="Overrides the party state in GST returns and the CGST+SGST / IGST split"
            >
              <Select
                data-testid="input-pos-override"
                value={posOverride ?? ''}
                onChange={(e) => setPosOverride(e.target.value || null)}
              >
                <option value="">Auto — {party?.stateCode ?? info!.stateCode}</option>
                {Object.entries(GST_STATES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {code} — {name}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="col-span-2 flex items-center gap-2 pb-2 text-body-sm">
              <input
                type="checkbox"
                data-testid="input-optional-voucher"
                checked={optionalVoucher}
                onChange={(e) => setOptionalVoucher(e.target.checked)}
              />
              Optional (memorandum) voucher — never counts toward the books or returns
            </label>
          </div>
        )}
      </div>

      {features.billWise && partyId && (
        <div className="mt-4 border-t border-line pt-3">
          <button
            className="flex items-center gap-1.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase"
            onClick={() => setBillsOpen((v) => !v)}
          >
            <span className="inline-block w-3 text-micro">{billsOpen ? '▾' : '▸'}</span>
            Bill allocation
            {isNoteKind && !manualNewBillMode && (
              <span className="normal-case text-muted/80">
                {' '}
                · allocated {formatPaise(noteAllocatedTotal)} / {formatPaise(computed.rounded)}
              </span>
            )}
          </button>
          {billsOpen && (
            <div className="mt-2">
              {isNoteKind && !manualNewBillMode ? (
                <>
                  {(openBillsForNote ?? []).length === 0 && noteBillRefs.length === 0 ? (
                    <p className="text-small text-muted">No open bills for this party.</p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {/* Allocations already on this note whose bill no longer shows as open
                          (this very note may have settled it) — listed so they stay visible. */}
                      {noteBillRefs
                        .filter((r) => !(openBillsForNote ?? []).some((b) => b.number === r.name))
                        .map((r) => (
                          <div key={`alloc-${r.name}`} className="flex items-center gap-3 rounded-md px-1 py-1 text-body-sm hover:bg-panel2">
                            <input
                              type="checkbox"
                              checked
                              onChange={() => setNoteBillRefs((refs) => refs.filter((x) => x.name !== r.name))}
                            />
                            <span className="flex-1">{r.name}</span>
                            <span className="text-hint text-muted">allocated on this note</span>
                            <AmountInput paise={r.amount} onPaise={(p) => setNoteBillAmount(r.name, p ?? 0)} className="w-28" />
                          </div>
                        ))}
                      {(openBillsForNote ?? []).map((b) => {
                        const ref = noteBillRefs.find((r) => r.kind === 'against' && r.name === b.number)
                        return (
                          <div key={b.number} className="flex items-center gap-3 rounded-md px-1 py-1 text-body-sm hover:bg-panel2">
                            <input type="checkbox" checked={!!ref} onChange={(e) => toggleNoteBill(b, e.target.checked)} />
                            <span className="flex-1">{b.number}</span>
                            <span className="num w-24 text-muted">{toDisplayDate(b.date)}</span>
                            <span className={`num w-24 ${b.overdueDays > 0 ? 'text-cr' : 'text-muted'}`}>
                              {b.dueDate ? toDisplayDate(b.dueDate) : '—'}
                            </span>
                            <Money paise={b.pending} className="w-24 text-right" />
                            {ref && (
                              <AmountInput paise={ref.amount} onPaise={(p) => setNoteBillAmount(b.number, p ?? 0)} className="w-28" />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <button className="mt-2 text-hint text-blue hover:underline" onClick={() => setManualNewBillMode(true)}>
                    Create new bill instead
                  </button>
                </>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Bill name">
                    <TextInput
                      value={billName}
                      onChange={(e) => {
                        setBillName(e.target.value)
                        setBillNameTouched(true)
                      }}
                    />
                  </Field>
                  <Field
                    label="Due date"
                    hint={billDueDate === '' ? 'None saved' : party?.creditDays != null ? `${party.creditDays} credit days` : undefined}
                  >
                    {/* '' = a loaded bill saved without a due date: show the voucher date (the input
                        needs one) but post null until the user picks a date. */}
                    <DateInput
                      value={billDueDate || date}
                      context={date}
                      onChange={(d) => {
                        setBillDueDate(d)
                        setBillDueDateTouched(true)
                      }}
                    />
                  </Field>
                  <Field label="Amount">
                    <div className={`${inputCls} num bg-panel text-right text-muted`}>
                      <Money paise={computed.rounded} />
                    </div>
                  </Field>
                  {isNoteKind && (
                    <button
                      className="col-span-3 self-start text-hint text-blue hover:underline"
                      onClick={() => setManualNewBillMode(false)}
                    >
                      Allocate against open bills instead
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-between">
        <div>{isEdit && <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>}</div>
        <div className="flex gap-2">
          {isEdit && (
            <Button data-testid="btn-voucher-transport" onClick={() => setShowTransport(true)}>
              Transport / e-way details…
            </Button>
          )}
          <Button onClick={() => nav.back()}>Cancel</Button>
          {kind === 'sales' && (
            <Button disabled={saving} onClick={() => void save(true)}>
              Save + invoice PDF
            </Button>
          )}
          <Button variant="primary" data-testid="btn-save-voucher" disabled={saving} onClick={() => void save()}>
            {isEdit ? 'Save changes' : 'Save voucher'} ⌘↵
          </Button>
        </div>
      </div>

      {quickLedger && (
        <QuickLedgerModal
          name={quickLedger.name}
          suggestParty={quickLedger.forParty ? isSalesSide : null}
          suggestAccount={!quickLedger.forParty ? isSalesSide : null}
          onClose={() => setQuickLedger(null)}
          onCreated={(l) => {
            if (quickLedger.forParty) setPartyId(l.id)
            else setAccountId(l.id)
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
      {editingParty && party && <LedgerFormModal ledger={party} onClose={() => setEditingParty(false)} />}
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
