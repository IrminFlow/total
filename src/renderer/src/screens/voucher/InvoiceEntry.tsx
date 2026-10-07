import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Voucher, VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import {
  buildInvoicePayload, computeInvoice, invoiceKindTakesTds, requiredTaxLedgers, taxLedgerIdsFrom,
  type InvoiceContext, type InvoiceFormState, type TaxLedgerIds, type TdsDeductionState
} from '@shared/voucherEdit'
import { GST_STATES } from '@shared/gst/states'
import { formatPaise, amountInWords } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts, type VoucherDraft } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, isAnyModalOpen, Kbd, Money, Panel, Select, TextInput, inputCls } from '../../components/ui'
import { LedgerPicker, useLedgers, useStockItems, useTaxLedgers } from '../../components/pickers'
import { LedgerFormModal } from '../../components/LedgerFormModal'
import { useFeatures } from '../../lib/useFeatures'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { addDaysLocal, nextLineKey, NUMBER_LOADING, useAlterationDirty, useLeaveAfterSave, useVoucherNumberField } from './hooks'
import { QuickItemModal, QuickLedgerModal } from './modals'
import { TransportModal } from './TransportModal'
import { useTdsDeduction } from './useTdsDeduction'
import { TdsBanner, TdsNotApplicableNote } from './TdsBanner'
import { blankItemRow, ItemLineGrid, type ItemRow } from './ItemLineGrid'
import { AddFromDrawer } from './AddFromDrawer'
import { addFromFor, rowsFromSourcePicks, sourceLocksGoods, type SourcePick } from '@shared/voucherEdit'
import type { OpenSourceLine } from '@shared/tradeCycle/types'
import { VoucherLink } from '../../components/links'

// ---------- invoice mode (sales / purchase / notes) ----------

// Field semantics (rate/discount in the invoice currency, godown/batch carried for saved lines)
// and every state → payload rule live in @shared/voucherEdit/invoice — this component only owns
// the inputs. `initial` (an alteration) comes from planVoucherEdit, which has already proved the
// voucher round-trips through this form unchanged.

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

  // ---------- TDS (purchase invoices; same suggestion/apply hook as AccountingEntry) ----------
  // Apply never touches the item lines: the shared builder reduces the vendor's credit by the
  // deduction and credits the section's tagged payable ledger (or, while that ledger doesn't
  // exist, leaves it `pending` for saveVoucher to create inside the save).
  const [tds, setTds] = useState<TdsDeductionState | null>(initial?.tds ?? null)

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
    // Lines drawn from another party's challan / invoice can't stay (same party, I2).
    setRows((rs) => {
      if (!rs.some((r) => r.source)) return rs
      const kept = rs.filter((r) => !r.source)
      return kept.length > 0 && kept[kept.length - 1]!.itemId == null ? kept : [...kept, blankItemRow()]
    })
    // A deduction belongs to its deductee — a different supplier starts without one.
    setTds(null)
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
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
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
      instrumentDate: initial?.instrumentDate ?? null,
      tds: invoiceKindTakesTds(kind) ? tds : null
    }),
    [date, isEdit, alterNumber, numberField.forPayload, partyId, accountId, rows, narration, vehicleNo, transporterId, distanceKm, currencyCode, fxRateText, posOverride, optionalVoucher, billName, billDueDate, manualNewBillMode, noteBillRefs, initial, kind, tds]
  )

  const computed = useMemo(() => computeInvoice(formState, ctx), [formState, ctx])
  const { supply, fxActive } = computed

  // TDS base = the taxable value: GST shown separately on the invoice is excluded (CBDT
  // Circular 23/2017, 19 Jul 2017 — https://www.incometaxindia.gov.in/documents/d/guest/circular_23_2017-pdf,
  // accessed 2026-10-07).
  const tdsDeduction = useTdsDeduction({
    enabled: features.tds && invoiceKindTakesTds(kind),
    candidate: partyId != null && computed.gst.taxable > 0 ? { partyLedgerId: partyId, base: computed.gst.taxable, expenseLedgerId: accountId } : null,
    date,
    excludeVoucherId: voucherId,
    voucherKind: 'purchase',
    tds,
    onChange: setTds,
    startDismissed: !!initial?.tds
  })
  const appliedTds = formState.tds ?? null
  const partyAmount = computed.rounded - (appliedTds?.tdsAmount ?? 0)
  const tdsStale = !!appliedTds && !appliedTds.isManual && appliedTds.baseAmount !== computed.gst.taxable

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
    if (tdsStale) return void toast.push('error', 'The invoice changed since TDS was applied — apply TDS again (or remove it) before saving')
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
      if (invoiceKindTakesTds(kind)) await tdsDeduction.afterSave(result.id)
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
      tdsDeduction.reset()
      numberField.reset()
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, partyId, accountId, computed, buildPayload, isSalesSide, kind, typeId, voucherId, isEdit, date, toast, setWorkingDate, queryClient, numberField.reset, leave, tdsDeduction.reset, tdsDeduction.afterSave, tdsStale])

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

  const goodsIn = kind === 'purchase' || kind === 'credit_note'

  // ---------- "Add from…" (WP 2.5b): rows drawn from challans / GRNs / invoices ----------
  // The source lines (and what is still pending on them, this voucher's own links excluded)
  // serve the drawer, the per-row quantity caps and the "from DC-12" chips.
  const addFrom = features.orders && features.inventory ? addFromFor(kind) : null
  const sourcedRows = rows.some((r) => r.source)
  const linkType = addFrom?.linkType ?? rows.find((r) => r.source)?.source?.linkType ?? 'fulfil'
  const [addFromOpen, setAddFromOpen] = useState(false)
  const { data: openLines, isLoading: openLinesLoading } = useQuery({
    queryKey: ['openSourceLines', partyId, kind, linkType, voucherId ?? null],
    queryFn: () =>
      api.links.openSourceLines({ partyLedgerId: partyId!, targetKind: kind, linkType, ...(voucherId ? { excludeVoucherId: voucherId } : {}) }),
    enabled: partyId != null && (!!addFrom || sourcedRows)
  })
  const sourceByUid = useMemo(() => new Map((openLines ?? []).map((l) => [l.lineUid, l])), [openLines])
  const qtyInForm = (uid: string, exceptKey?: number): number =>
    rows
      .filter((r) => r.source?.lineUid === uid && r.key !== exceptKey)
      .reduce((s, r) => s + (Math.round(parseFloat(r.qtyText || '0') * 1000) || 0), 0)
  const drawerLines: OpenSourceLine[] = (openLines ?? [])
    .map((l) => {
      const pending = l.pendingMilli - qtyInForm(l.lineUid)
      return { ...l, doneMilli: l.qtyMilli - pending, pendingMilli: pending }
    })
    .filter((l) => l.pendingMilli > 0)
  const lockedBySource = (r: ItemRow): { label: string; maxQtyMilli: number; lockDetail: boolean } | null => {
    if (!r.source) return null
    const l = sourceByUid.get(r.source.lineUid)
    const own = Math.round(parseFloat(r.qtyText || '0') * 1000) || 0
    if (!l) return { label: 'the linked line', maxQtyMilli: own, lockDetail: r.source.linkType === 'fulfil' }
    return {
      label: l.label,
      maxQtyMilli: Math.max(0, l.pendingMilli - qtyInForm(l.lineUid, r.key)),
      lockDetail: sourceLocksGoods(l.kind as VoucherKind, kind, r.source.linkType)
    }
  }
  const sourceChip = (r: ItemRow): React.ReactNode => {
    if (!r.source) return null
    const l = sourceByUid.get(r.source.lineUid)
    return (
      <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-panel2 px-1.5 text-hint text-muted" data-testid="chip-line-source">
        {r.source.linkType === 'return' ? 'against' : 'from'}{' '}
        {l ? <VoucherLink voucherId={l.voucherId} label={l.label.replace(/ line (\d+)$/, ' · line $1')} /> : 'a linked line'}
      </span>
    )
  }
  const insertPicks = (picks: SourcePick[]): void => {
    const added = rowsFromSourcePicks(picks, { linkType, fxRate: computed.fxRate }).map((r) => ({ ...r, key: nextLineKey() }))
    setRows((rs) => [...rs.filter((r) => r.itemId != null || r.source), ...added, blankItemRow()])
    setAddFromOpen(false)
  }
  const removeRow = (i: number): void =>
    setRows((rs) => {
      const next = rs.filter((_r, j) => j !== i)
      return next.length > 0 && next[next.length - 1]!.itemId == null ? next : [...next, blankItemRow()]
    })
  // Every goods line moved on a challan: the challan's e-way bill covered the movement.
  const goodsOnChallan =
    kind === 'sales' && computed.detail.length > 0 &&
    rows.filter((r) => r.itemId != null).every((r) => r.source?.linkType === 'fulfil' && lockedBySource(r)?.lockDetail)

  useEffect(() => {
    if (!addFrom || partyId == null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyA') {
        if (isAnyModalOpen()) return
        e.preventDefault()
        setAddFromOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addFrom, partyId])

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
        {addFrom && partyId != null && (
          <Button
            variant="ghost"
            className="ml-auto mr-2 px-2 py-1 text-caption"
            data-testid="btn-add-from"
            onClick={() => setAddFromOpen(true)}
            title={`${addFrom.label} (⌥A)`}
          >
            {addFrom.label} <Kbd>⌥A</Kbd>
          </Button>
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

      <ItemLineGrid
        rows={rows}
        setRow={setRow}
        setRows={setRows}
        direction={goodsIn ? 'in' : 'out'}
        priceLevelId={party?.priceLevelId ?? null}
        fxActive={fxActive}
        date={date}
        voucherId={voucherId}
        fallbackGstRate={account?.gstRate ?? null}
        onCreateItem={(name, row) => setQuickItem({ name, row })}
        lockedBySource={lockedBySource}
        rowNote={sourceChip}
        onRemoveRow={removeRow}
      />

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
          {goodsOnChallan && (
            <p className="mt-2 text-hint text-muted" data-testid="invoice-goods-on-challan">
              Goods moved on the challan — its e-way bill covered the movement; no second one is needed.
            </p>
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
          {appliedTds && (
            <div data-testid="invoice-tds-summary">
              <div className="flex justify-between py-0.5 text-cr">
                <span>
                  Less TDS{tdsDeduction.suggestion ? ` u/s ${tdsDeduction.suggestion.code}` : ''}
                  {appliedTds.pending && <span className="text-caption text-muted"> (payable ledger created on save)</span>}
                </span>
                <Money paise={-appliedTds.tdsAmount} />
              </div>
              <SummaryRow label="Payable to supplier" paise={partyAmount} />
              <button
                className="text-hint text-blue hover:underline"
                data-testid="btn-tds-remove"
                onClick={() => setTds(null)}
              >
                Remove TDS
              </button>
            </div>
          )}
        </div>
      </div>

      {tdsStale && (
        <p className="mt-2 text-body-sm text-cr" data-testid="invoice-tds-stale">
          TDS was applied on a taxable value of {formatPaise(appliedTds!.baseAmount, { symbol: true })}; the invoice now
          totals {formatPaise(computed.gst.taxable, { symbol: true })} — apply TDS again before saving.
        </p>
      )}
      {features.tds && invoiceKindTakesTds(kind) && tdsDeduction.notApplicable != null && !appliedTds && (
        <TdsNotApplicableNote reason={tdsDeduction.notApplicable} onUndo={() => tdsDeduction.setNotApplicable(null)} />
      )}
      {features.tds && tdsDeduction.suggestion && !tdsDeduction.dismissed && tdsDeduction.notApplicable == null && (
        <TdsBanner
          suggestion={tdsDeduction.suggestion}
          onDismiss={tdsDeduction.dismiss}
          onApply={() => void tdsDeduction.apply()}
          onApplyManual={(p) => {
            if (p < computed.rounded) tdsDeduction.applyManual(p)
            else toast.push('error', "The deduction can't be the whole invoice")
          }}
          onChooseSection={(id) => tdsDeduction.chooseSection(id)}
          onNotApplicable={appliedTds ? undefined : (r) => tdsDeduction.setNotApplicable(r)}
          blockedReason={
            tdsDeduction.suggestion.tdsPaise >= computed.rounded
              ? `The deduction can't be the whole invoice (${formatPaise(computed.rounded, { symbol: true })}).`
              : null
          }
        />
      )}

      <div className="mt-4 border-t border-line pt-3">
        <button
          data-testid="btn-invoice-gst-details"
          className="flex items-center gap-1.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase"
          onClick={() => setGstOpen((v) => !v)}
        >
          <span className="inline-block w-3 text-micro">{gstOpen ? '▾' : '▸'}</span>
          GST details
          {(posOverride || optionalVoucher) && (
            <span className="normal-case text-muted">
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
              <span className="normal-case text-muted">
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
                      <Money paise={partyAmount} />
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
      {addFromOpen && addFrom && (
        <AddFromDrawer
          title={`${addFrom.label.replace('…', '')} — ${party?.name ?? ''}`}
          lines={drawerLines}
          loading={openLinesLoading}
          onClose={() => setAddFromOpen(false)}
          onInsert={insertPicks}
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
