import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import { computeGst, supplyTypeFor, addBreakups, type GstBreakup } from '@shared/gst/calc'
import { GST_STATES } from '@shared/gst/states'
import { roundToRupee, formatPaise, amountInWords } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts, type VoucherDraft } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, isAnyModalOpen, LineTableScroller, Money, Panel, Select, TextInput, ValidationSummary, inputCls } from '../../components/ui'
import { ItemPicker, LedgerPicker, useLedgers, useStockItems, useTaxLedgers } from '../../components/pickers'
import { LedgerFormModal } from '../../components/LedgerFormModal'
import { useFeatures } from '../../lib/useFeatures'
import { confirmDialog, promptDialog } from '../../lib/dialogs'
import { useDraftAwareUnsavedGuard } from '../../lib/useUnsavedGuard'
import { addDaysLocal, nextLineKey, NUMBER_LOADING, useVoucherNumberField } from './hooks'
import { QuickItemModal, QuickLedgerModal, SaveAsRecurringModal } from './modals'
import type { VoucherWorkDraft } from '@shared/voucherDrafts'
import { saveEntryTemplate } from '../../lib/saveEntryTemplate'
import { recordCohortEvent } from '../../lib/commercialOps'

// ---------- invoice mode (sales / purchase / notes) ----------

interface ItemRow {
  /** Stable React key — survives the trailing-blank-row insertions (never an array index). */
  key: number
  itemId: number | null
  qtyText: string
  rate: number | null
  /** Per-line trade discount (paise, in the invoice currency like `rate`). Display + gross
   *  only — the line amount sent to the books is already post-discount (migration 017). */
  discount: number | null
}

const blankItemRow = (): ItemRow => ({ key: nextLineKey(), itemId: null, qtyText: '', rate: null, discount: null })

interface SavedInvoicePayload {
  date?: string; number?: string; partyId?: number | null; accountId?: number | null; narration?: string
  rows?: { itemId?: number | null; qtyText?: string; rate?: number | null; discount?: number | null }[]
  vehicleNo?: string; transporterId?: string; distanceKm?: string; currencyCode?: string; fxRateText?: string
  posOverride?: string | null; optionalVoucher?: boolean; billName?: string; billDueDate?: string
  billNameTouched?: boolean; billDueDateTouched?: boolean; manualNewBillMode?: boolean; noteBillRefs?: VoucherBillRef[]
  goodsReceiptId?: number | null
  procurementClaimKey?: string | null
}

function invoicePayload(draft?: VoucherWorkDraft): SavedInvoicePayload {
  return draft?.mode === 'invoice' && draft.payloadVersion === 1 ? draft.payload as SavedInvoicePayload : {}
}

export function InvoiceEntry({ typeId, kind, draft, workDraft }: { typeId: number; kind: VoucherKind; draft?: VoucherDraft; workDraft?: VoucherWorkDraft }): React.JSX.Element {
  const { info, workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const ledgers = useLedgers()
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const { ensure: ensureTax, ensureRoundOff } = useTaxLedgers()
  const savedDraft = invoicePayload(workDraft)

  const [date, setDate] = useState(savedDraft.date ?? draft?.date ?? workingDate)
  const [partyId, setPartyId] = useState<number | null>(savedDraft.partyId ?? draft?.partyLedgerId ?? null)
  const [accountId, setAccountId] = useState<number | null>(savedDraft.accountId ?? draft?.accountLedgerId ?? null)
  const [rows, setRows] = useState<ItemRow[]>(() => savedDraft.rows?.length
    ? savedDraft.rows.map((line) => ({ key: nextLineKey(), itemId: typeof line.itemId === 'number' ? line.itemId : null, qtyText: typeof line.qtyText === 'string' ? line.qtyText : '', rate: typeof line.rate === 'number' ? line.rate : null, discount: typeof line.discount === 'number' ? line.discount : null }))
    : draft?.inventory?.length
    ? [...draft.inventory.map((line) => ({ key: nextLineKey(), itemId: line.stockItemId, qtyText: String(line.qtyMilli / 1000), rate: line.ratePaise, discount: line.discountPaise || null })), blankItemRow()]
    : [blankItemRow()])
  const [narration, setNarration] = useState(savedDraft.narration ?? draft?.narration ?? '')
  const [vehicleNo, setVehicleNo] = useState(savedDraft.vehicleNo ?? '')
  const [transporterId, setTransporterId] = useState(savedDraft.transporterId ?? '')
  const [distanceKm, setDistanceKm] = useState(savedDraft.distanceKm ?? '')
  const [currencyCode, setCurrencyCode] = useState(savedDraft.currencyCode ?? draft?.currencyCode ?? '')
  const [fxRateText, setFxRateText] = useState(savedDraft.fxRateText ?? (draft?.exchangeRate ? String(draft.exchangeRate) : ''))
  const { data: currencies } = useQuery({ queryKey: ['currencies'], queryFn: api.currencies.list })
  const [quickLedger, setQuickLedger] = useState<{ name: string; forParty: boolean } | null>(null)
  const [quickItem, setQuickItem] = useState<{ name: string; row: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [showRecurring, setShowRecurring] = useState(false)
  const [editingParty, setEditingParty] = useState(false)
  // ---------- GST details (place-of-supply override + memorandum flag) ----------
  const [gstOpen, setGstOpen] = useState(false)
  const [posOverride, setPosOverride] = useState<string | null>(savedDraft.posOverride ?? draft?.posOverride ?? null)
  const [optionalVoucher, setOptionalVoucher] = useState(savedDraft.optionalVoucher ?? draft?.isOptional ?? false)
  const [goodsReceiptId, setGoodsReceiptId] = useState<number | null>(savedDraft.goodsReceiptId ?? null)
  const procurementClaimKey = savedDraft.procurementClaimKey ?? null
  const { data: matchCandidates = [] } = useQuery({
    queryKey: ['procurement-invoice-candidates', kind === 'purchase' ? partyId : null],
    queryFn: () => api.procurement.invoiceCandidates(partyId ?? undefined),
    enabled: kind === 'purchase'
  })
  const selectedItemIds = useMemo(() => [...new Set(rows.flatMap((row) => row.itemId ? [row.itemId] : []))], [rows])
  const { data: supplierRateHistory = [] } = useQuery({
    queryKey: ['procurement-price-history', selectedItemIds, kind === 'purchase' ? partyId : null],
    queryFn: () => api.procurement.priceHistory(selectedItemIds, partyId ?? undefined),
    enabled: kind === 'purchase' && selectedItemIds.length > 0
  })

  const numberField = useVoucherNumberField(typeId, date)
  const isSalesSide = kind === 'sales' || kind === 'credit_note'

  // Unsaved-entry guard: anything meaningful typed into a fresh invoice blocks accidental
  // navigation until it's saved (save resets all of these).
  const draftFingerprint = JSON.stringify({ date, partyId, accountId, rows: rows.map(({ key: _key, ...row }) => row), narration, vehicleNo, transporterId, distanceKm, currencyCode, fxRateText, posOverride, optionalVoucher, goodsReceiptId, procurementClaimKey })
  useDraftAwareUnsavedGuard(workDraft?.id, partyId != null || rows.some((r) => r.itemId != null) || narration.trim() !== '', draftFingerprint)

  const party = ledgers.find((l) => l.id === partyId) ?? null
  const account = ledgers.find((l) => l.id === accountId) ?? null

  // ---------- bill allocation ----------
  // sales/purchase: one default 'new' ref named after the voucher no, auto-synced to the
  // party-line total until the user edits the name/due-date directly.
  // credit/debit notes: default to allocating AGAINST the party's open bills (a note adjusts an
  // existing invoice) — "create new bill instead" restores the sales/purchase-style single ref.
  const isNoteKind = kind === 'credit_note' || kind === 'debit_note'
  const [billsOpen, setBillsOpen] = useState(true)
  const [billName, setBillName] = useState(savedDraft.billName ?? '')
  const [billNameTouched, setBillNameTouched] = useState(savedDraft.billNameTouched ?? !!savedDraft.billName)
  const [billDueDate, setBillDueDate] = useState(savedDraft.billDueDate ?? date)
  const [billDueDateTouched, setBillDueDateTouched] = useState(savedDraft.billDueDateTouched ?? !!savedDraft.billDueDate)
  const [manualNewBillMode, setManualNewBillMode] = useState(savedDraft.manualNewBillMode ?? false)
  const [noteBillRefs, setNoteBillRefs] = useState<VoucherBillRef[]>(savedDraft.noteBillRefs ?? [])
  const skipFirstPartyReset = useRef(!!workDraft)

  useEffect(() => {
    if (savedDraft.number !== undefined) numberField.onChange(savedDraft.number)
    // Restore the saved numbering override only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  useEffect(() => {
    if (skipFirstPartyReset.current) { skipFirstPartyReset.current = false; return }
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

  // Same precedence the GSTR builders use: explicit override → party state → company state.
  const supply = supplyTypeFor(info!.stateCode, posOverride ?? party?.stateCode ?? info!.stateCode)

  const fxRate = currencyCode && fxRateText.trim() ? Number(fxRateText) : null
  const fxActive = !!currencyCode && !!fxRate && Number.isFinite(fxRate) && fxRate > 0

  const computed = useMemo(() => {
    const itemMap = new Map(items.map((i) => [i.id, i]))
    const detail = rows
      .map((r) => {
        const item = r.itemId ? itemMap.get(r.itemId) : null
        const qtyMilli = Math.round(parseFloat(r.qtyText || '0') * 1000)
        if (!item || !Number.isFinite(qtyMilli) || qtyMilli <= 0 || r.rate == null) return null
        // Rates (and discounts) are typed in the invoice currency; books stay in ₹.
        const baseRate = fxActive ? Math.round(r.rate * fxRate!) : r.rate
        const gross = Math.round((qtyMilli * baseRate) / 1000)
        const discountPaise = Math.min(gross, fxActive ? Math.round((r.discount ?? 0) * fxRate!) : (r.discount ?? 0))
        // `amount` is the post-discount taxable value — GST buckets below stay correct by construction.
        const amount = gross - discountPaise
        const rate = item.gstRate ?? account?.gstRate ?? 0
        const cessRate = item.cessRate ?? 0
        return { item, qtyMilli, ratePaise: baseRate, discountPaise, amount, rate, cessRate }
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)

    const buckets = new Map<string, { rate: number; cessRate: number; taxable: number }>()
    for (const d of detail) {
      const key = `${d.rate}|${d.cessRate}`
      const b = buckets.get(key) ?? { rate: d.rate, cessRate: d.cessRate, taxable: 0 }
      b.taxable += d.amount
      buckets.set(key, b)
    }
    const breakups: GstBreakup[] = [...buckets.values()].map((b) => computeGst(b.taxable, b.rate, supply, b.cessRate))
    const gst = addBreakups(breakups)
    const rounded = roundToRupee(gst.total)
    return { detail, gst, rounded, roundDiff: rounded - gst.total }
  }, [rows, items, account, supply, fxActive, fxRate])

  const noteAllocatedTotal = noteBillRefs.reduce((s, r) => s + r.amount, 0)

  const invoiceMatchInput = goodsReceiptId && computed.detail.length > 0 ? {
    goodsReceiptId,
    lines: computed.detail.map((line) => ({ stockItemId: line.item.id, qtyMilli: line.qtyMilli, ratePaise: line.ratePaise, amount: line.amount, gstRate: line.rate }))
  } : null
  const matchPreview = useQuery({
    queryKey: ['procurement-invoice-match-preview', invoiceMatchInput],
    queryFn: () => api.procurement.invoiceMatchPreview(invoiceMatchInput!),
    enabled: invoiceMatchInput != null,
    retry: false
  })

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

  // Builds the exact VoucherInputParsed shape `save` posts — factored out so "Save as
  // recurring…" can serialize the current form state without also saving the voucher itself.
  // Async: computing the tax/round-off lines may create those ledgers on first use (ensureTax /
  // ensureRoundOff), same as it does on a normal save.
  const buildPayload = useCallback(async (): Promise<VoucherInputParsed | null> => {
    if (!partyId || !accountId || computed.detail.length === 0) return null
    const { gst, rounded, roundDiff } = computed
    const lines: VoucherInputParsed['lines'] = []
    // Which way the party faces, per voucher kind.
    const partyDr = kind === 'sales' || kind === 'debit_note'
    lines.push({ ledgerId: partyId, drCr: partyDr ? 'dr' : 'cr', amount: rounded, costAllocations: [] })
    const counter = partyDr ? 'cr' : 'dr'
    lines.push({ ledgerId: accountId, drCr: counter, amount: gst.taxable, costAllocations: [] })
    if (gst.cgst > 0) lines.push({ ledgerId: await ensureTax('cgst'), drCr: counter, amount: gst.cgst, costAllocations: [] })
    if (gst.sgst > 0) lines.push({ ledgerId: await ensureTax('sgst'), drCr: counter, amount: gst.sgst, costAllocations: [] })
    if (gst.igst > 0) lines.push({ ledgerId: await ensureTax('igst'), drCr: counter, amount: gst.igst, costAllocations: [] })
    if (gst.cess > 0) lines.push({ ledgerId: await ensureTax('cess'), drCr: counter, amount: gst.cess, costAllocations: [] })
    if (roundDiff !== 0) {
      lines.push({
        ledgerId: await ensureRoundOff(),
        drCr: roundDiff > 0 ? counter : partyDr ? 'dr' : 'cr',
        amount: Math.abs(roundDiff),
        costAllocations: []
      })
    }
    // A round-down leaves the counter side heavier — the Round Off line balances the party side.
    if (roundDiff < 0) {
      const idx = lines.length - 1
      lines[idx] = { ...lines[idx]!, drCr: partyDr ? 'dr' : 'cr' }
    }
    const goodsIn = kind === 'purchase' || kind === 'credit_note'
    return {
      voucherTypeId: typeId,
      date,
      number: numberField.forPayload || undefined,
      partyLedgerId: partyId,
      narration: narration.trim() || null,
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: transporterId.trim() || null,
      vehicleNo: vehicleNo.trim().toUpperCase() || null,
      transportDistanceKm: distanceKm.trim() ? Number(distanceKm) : null,
      posOverride,
      currencyCode: fxActive ? currencyCode : null,
      exchangeRate: fxActive ? fxRate : null,
      isOptional: optionalVoucher,
      lines,
      // A matched GRN has already received the physical stock. Keep this purchase voucher
      // financial-only; immutable item evidence is written to purchase_invoice_match_lines.
      inventory: goodsReceiptId || procurementClaimKey ? [] : computed.detail.map((d) => ({
        stockItemId: d.item.id,
        godownId: null,
        qtyMilli: d.qtyMilli,
        ratePaise: d.ratePaise,
        discountPaise: d.discountPaise,
        amount: d.amount,
        direction: goodsIn ? ('in' as const) : ('out' as const)
      })),
      billRefs:
        isNoteKind && !manualNewBillMode
          ? noteBillRefs
          : billName.trim()
            ? [{ kind: 'new', name: billName.trim(), amount: rounded, dueDate: billDueDate || null }]
            : [],
      tds: null
    }
  }, [partyId, accountId, computed, kind, typeId, date, numberField.forPayload, narration, transporterId, vehicleNo, distanceKm, posOverride, optionalVoucher, fxActive, currencyCode, fxRate, isNoteKind, manualNewBillMode, noteBillRefs, billName, billDueDate, ensureTax, ensureRoundOff, goodsReceiptId, procurementClaimKey])

  const formValid = !!partyId && !!accountId && computed.detail.length > 0
  const validationIssues = useMemo(() => {
    const issues: string[] = []
    if (!partyId) issues.push(`Choose the ${isSalesSide ? 'buyer' : 'supplier'} ledger`)
    if (!accountId) issues.push(`Choose the ${isSalesSide ? 'sales' : 'purchase'} ledger`)
    const entered = rows.filter((row) => row.itemId != null || row.qtyText.trim() !== '' || row.rate != null || row.discount != null)
    entered.forEach((row, index) => {
      if (row.itemId == null) issues.push(`Item line ${index + 1}: choose an item`)
      const quantity = Number(row.qtyText)
      if (!Number.isFinite(quantity) || quantity <= 0) issues.push(`Item line ${index + 1}: enter a positive quantity`)
      if (row.rate == null || row.rate < 0) issues.push(`Item line ${index + 1}: enter a valid rate`)
      if ((row.discount ?? 0) < 0) issues.push(`Item line ${index + 1}: discount cannot be negative`)
    })
    if (entered.length === 0) issues.push('Add at least one item line')
    if (entered.length > 0 && computed.rounded <= 0) issues.push('Invoice total must be greater than zero')
    if (isNoteKind && !manualNewBillMode && noteBillRefs.length > 0 && noteBillRefs.reduce((sum, ref) => sum + ref.amount, 0) !== computed.rounded) {
      issues.push('Bill allocations must equal the credit or debit note total')
    }
    if (goodsReceiptId && matchPreview.isError) issues.push(matchPreview.error instanceof Error ? matchPreview.error.message : 'The GRN does not match these invoice lines')
    if (goodsReceiptId && !matchPreview.isError && !matchPreview.data) issues.push('Checking the PO and goods receipt…')
    return [...new Set(issues)]
  }, [partyId, accountId, isSalesSide, rows, computed.rounded, isNoteKind, manualNewBillMode, noteBillRefs, goodsReceiptId, matchPreview.isError, matchPreview.error, matchPreview.data])

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
      if (input.number && (await api.vouchers.numberExists(typeId, input.number))) {
        const proceed = await confirmDialog({
          title: 'Duplicate number',
          message: `Voucher number ${input.number} is already used by another voucher of this type. Save anyway with the same number?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const suspicious = await api.vouchers.suspicious(input)
      if (suspicious.length > 0) {
        const proceed = await confirmDialog({
          title: 'Review unusual details',
          message: suspicious.map((warning) => `• ${warning.message}`).join('\n'),
          confirmLabel: 'Reviewed, save'
        })
        if (!proceed) return
      }
      const dupes = await api.vouchers.duplicates(input)
      if (dupes.length > 0) {
        const first = dupes[0]!
        const evidence = first.reasons.includes('same_bill_reference')
          ? 'the same supplier invoice or bill reference'
          : first.reasons.includes('same_reference')
            ? 'the same external reference'
            : 'the same party and amount'
        const proceed = await confirmDialog({
          title: 'Possible duplicate',
          message: `Voucher ${first.number} on ${first.date} has ${evidence}. Save anyway?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      let creditOverrideReason: string | undefined
      if (kind === 'sales' && partyId) {
        const exposure = await api.vouchers.creditExposure(partyId, computed.rounded)
        if (exposure.exceeded) {
          const reason = await promptDialog({ title: 'Customer credit policy exceeded', message: `${exposure.ledgerName} would reach ${formatPaise(exposure.proposedOutstanding, { symbol: true })} against a ${formatPaise(exposure.creditLimit ?? 0, { symbol: true })} limit. Enter an override reason, or cancel and review collections.`, placeholder: 'Reason for extending additional credit', confirmLabel: 'Continue with override' })
          if (!reason?.trim()) return
          creditOverrideReason = reason.trim()
        }
      }
      const saved = await api.vouchers.save(input, undefined, workDraft?.id, invoiceMatchInput ?? undefined, procurementClaimKey ?? undefined, creditOverrideReason)
      if (!saved.approvalRequired)
        recordCohortEvent(localStorage, 'first_voucher_posted')
      toast.push('success', saved.approvalRequired
        ? `Sent for approval — request #${saved.request.id}; no invoice was posted`
        : `${saved.number} saved — ${formatPaise(computed.rounded, { symbol: true })}`)
      if (!saved.approvalRequired && andPdf && kind === 'sales') {
        await api.invoice.pdf(saved.id)
      }
      setWorkingDate(date)
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
      setGoodsReceiptId(null)
      numberField.reset()
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, partyId, accountId, computed, buildPayload, isSalesSide, kind, typeId, date, toast, setWorkingDate, queryClient, numberField.reset, workDraft?.id, invoiceMatchInput, procurementClaimKey])

  const saveDraft = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      await api.voucherDrafts.save({
        voucherTypeId: typeId,
        mode: 'invoice',
        title: narration.trim().slice(0, 120) || `${kind.replace('_', ' ')} on ${date}`,
        payloadVersion: 1,
        payload: { date, number: numberField.forPayload, partyId, accountId, rows: rows.map(({ key: _key, ...row }) => row), narration, vehicleNo, transporterId, distanceKm, currencyCode, fxRateText, posOverride, optionalVoucher, billName, billDueDate, billNameTouched, billDueDateTouched, manualNewBillMode, noteBillRefs, goodsReceiptId, procurementClaimKey }
      }, workDraft?.id)
      await queryClient.invalidateQueries({ queryKey: ['voucher-drafts'] })
      toast.push('success', workDraft ? 'Draft updated' : 'Voucher draft saved')
      nav.replace({ name: 'voucher-drafts' })
    } catch (error) { toast.push('error', (error as Error).message) }
    finally { setSaving(false) }
  }

  const saveTemplate = async (): Promise<void> => {
    try {
      const name = await saveEntryTemplate({ voucherTypeId: typeId, mode: 'invoice', title: 'Template', payloadVersion: 1, payload: { date, number: '', partyId, accountId, rows: rows.map(({ key: _key, ...row }) => row), narration, vehicleNo: '', transporterId: '', distanceKm: '', currencyCode, fxRateText, posOverride, optionalVoucher, billName: '', billDueDate: date, billNameTouched: false, billDueDateTouched: false, manualNewBillMode: false, noteBillRefs: [] } }, narration.trim().slice(0, 80) || `${kind.replace('_', ' ')} pattern`)
      if (name) { await queryClient.invalidateQueries({ queryKey: ['entry-templates'] }); toast.push('success', `${name} template saved`) }
    } catch (error) { toast.push('error', (error as Error).message) }
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
        <Field label="No." hint={numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={numberField.value === NUMBER_LOADING ? '' : numberField.value}
            onChange={(e) => numberField.onChange(e.target.value)}
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
              autoFocus
              value={partyId}
              onPick={setPartyId}
              placeholder="Party ledger"
              onCreateRequest={(name) => setQuickLedger({ name, forParty: true })}
              className="flex-1"
              testId="picker-party"
            />
            {party && (
              <Button variant="ghost" className="shrink-0 px-2 py-1 text-[11px]" onClick={() => setEditingParty(true)}>
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
          <p className="text-[11.5px] text-muted">
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
                {fxActive && <span className="text-[11px] text-muted">rates in {currencyCode} · books in ₹</span>}
              </>
            )}
          </div>
        )}
      </div>

      {procurementClaimKey && <div className="mt-4 rounded-md border border-amber/30 bg-amber/8 px-3 py-2 text-[10.5px]"><b>Linked procurement debit note:</b> this financial adjustment came from recorded shortage, rejection or rate evidence. It will not move stock, and posting closes that claim exactly once.</div>}

      {kind === 'purchase' && (matchCandidates.length > 0 || goodsReceiptId) && (
        <div className="mt-4 rounded-lg border border-line bg-panel2 p-3" data-testid="invoice-three-way-match">
          <div className="flex items-start justify-between gap-5">
            <div>
              <p className="text-[11.5px] font-semibold">Match received goods</p>
              <p className="mt-0.5 text-[10.5px] text-muted">Link this supplier invoice to a posted GRN. Total records the payable only—stock is not received twice.</p>
            </div>
            <Select
              data-testid="select-invoice-grn"
              className="w-[330px]"
              value={goodsReceiptId ?? ''}
              onChange={(event) => {
                const id = event.target.value ? Number(event.target.value) : null
                setGoodsReceiptId(id)
                if (!id) return
                const candidate = matchCandidates.find((row) => row.goodsReceiptId === id)
                if (!candidate) return
                setPartyId(candidate.supplierLedgerId)
                setRows(candidate.lines.map((line) => ({ key: nextLineKey(), itemId: line.stockItemId, qtyText: String(line.acceptedQtyMilli / 1000), rate: line.poRatePaise, discount: null })))
                setNarration((current) => current || `Supplier invoice against ${candidate.purchaseOrderNumber} / ${candidate.goodsReceiptNumber}`)
              }}
            >
              <option value="">Do not match a GRN</option>
              {matchCandidates.map((candidate) => <option key={candidate.goodsReceiptId} value={candidate.goodsReceiptId}>{candidate.goodsReceiptNumber} · {candidate.purchaseOrderNumber} · {candidate.supplierName} · {toDisplayDate(candidate.goodsReceiptDate)}</option>)}
            </Select>
          </div>
          {goodsReceiptId && matchPreview.isFetching && <p className="mt-3 text-[10.5px] text-muted">Comparing order, accepted receipt and invoice…</p>}
          {matchPreview.data && <div className="mt-3 overflow-hidden rounded-md border border-line bg-panel">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="text-[10.5px] text-muted">{matchPreview.data.purchaseOrderNumber} → {matchPreview.data.goodsReceiptNumber} → this invoice</span>
              <span className={`rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase ${matchPreview.data.status === 'exact' ? 'border-dr/25 bg-dr/5 text-dr' : 'border-amber/30 bg-amber/10 text-amber'}`}>{matchPreview.data.status === 'exact' ? 'Exact match' : `${matchPreview.data.quantityVarianceCount + matchPreview.data.rateVarianceCount} variance${matchPreview.data.quantityVarianceCount + matchPreview.data.rateVarianceCount === 1 ? '' : 's'}`}</span>
            </div>
            <div className="grid grid-cols-[1fr_120px_120px_120px_120px] bg-panel2 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.07em] text-muted"><span>Item</span><span className="text-right">Ordered</span><span className="text-right">Accepted</span><span className="text-right">Invoiced</span><span className="text-right">Rate vs PO</span></div>
            {matchPreview.data.lines.map((line) => <div key={line.stockItemId} className="grid grid-cols-[1fr_120px_120px_120px_120px] border-t border-line px-3 py-1.5 text-[10.5px]"><span>{line.itemName}</span><span className="num text-right text-muted">{line.orderedQtyMilli / 1000} {line.unitSymbol}</span><span className="num text-right text-muted">{line.acceptedQtyMilli / 1000}</span><span className={`num text-right ${line.quantityVarianceMilli ? 'text-amber' : 'text-dr'}`}>{line.qtyMilli / 1000}</span><span className={`num text-right ${line.rateVariancePaise ? 'text-amber' : 'text-dr'}`}>₹{formatPaise(line.ratePaise)}{line.rateVariancePaise ? ` (${line.rateVariancePaise > 0 ? '+' : '−'}₹${formatPaise(Math.abs(line.rateVariancePaise))})` : ''}</span></div>)}
          </div>}
        </div>
      )}

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
                      setRow(i, { itemId: id })
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
                      value={r.qtyText}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(e) => setRow(i, { qtyText: e.target.value })}
                    />
                    <span className="w-8 text-[11px] text-muted">{unitOf(r.itemId)}</span>
                  </div>
                </td>
                <td className="r">
                  <AmountInput paise={r.rate} onPaise={(p) => setRow(i, { rate: p })} />
                  {kind === 'purchase' && r.itemId && supplierRateHistory.find((history) => history.stockItemId === r.itemId) && (() => {
                    const history = supplierRateHistory.find((entry) => entry.stockItemId === r.itemId)!
                    return <p className="mt-0.5 whitespace-nowrap text-right text-[9px] text-muted" title={`${history.supplierName} · ${toDisplayDate(history.date)} · ${history.voucherNumber}`}>Last ₹{formatPaise(history.ratePaise)} · {toDisplayDate(history.date)}</p>
                  })()}
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
                  <span className="num text-[12.5px] text-muted">{item ? `${item.gstRate ?? account?.gstRate ?? 0}%` : ''}</span>
                </td>
                <td className="r">
                  <Money paise={amount} className="text-[13.5px]" />
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
            <p className="mt-2 text-[11.5px] text-muted italic">{amountInWords(computed.rounded)}</p>
          )}
        </div>
        <div className="num w-72 text-[13px]">
          <SummaryRow label="Taxable value" paise={computed.gst.taxable} />
          {computed.gst.cgst > 0 && <SummaryRow label="CGST" paise={computed.gst.cgst} />}
          {computed.gst.sgst > 0 && <SummaryRow label="SGST" paise={computed.gst.sgst} />}
          {computed.gst.igst > 0 && <SummaryRow label="IGST" paise={computed.gst.igst} />}
          {computed.gst.cess > 0 && <SummaryRow label="Cess" paise={computed.gst.cess} />}
          {computed.roundDiff !== 0 && <SummaryRow label="Round off" paise={computed.roundDiff} />}
          <div className="mt-1 flex justify-between border-t border-ink pt-1.5 pb-0.5 text-[15px] font-semibold" style={{ borderBottom: '3px double var(--color-ink)' }}>
            <span>Total</span>
            <Money paise={computed.rounded} />
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <button
          data-testid="btn-invoice-gst-details"
          className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"
          onClick={() => setGstOpen((v) => !v)}
        >
          <span className="inline-block w-3 text-[10px]">{gstOpen ? '▾' : '▸'}</span>
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
            <label className="col-span-2 flex items-center gap-2 pb-2 text-[12.5px]">
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
            className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"
            onClick={() => setBillsOpen((v) => !v)}
          >
            <span className="inline-block w-3 text-[10px]">{billsOpen ? '▾' : '▸'}</span>
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
                  {(openBillsForNote ?? []).length === 0 ? (
                    <p className="text-[12px] text-muted">No open bills for this party.</p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {(openBillsForNote ?? []).map((b) => {
                        const ref = noteBillRefs.find((r) => r.kind === 'against' && r.name === b.number)
                        return (
                          <div key={b.number} className="flex items-center gap-3 rounded-md px-1 py-1 text-[12.5px] hover:bg-panel2">
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
                  <button className="mt-2 text-[11.5px] text-blue hover:underline" onClick={() => setManualNewBillMode(true)}>
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
                  <Field label="Due date" hint={party?.creditDays != null ? `${party.creditDays} credit days` : undefined}>
                    <DateInput
                      value={billDueDate}
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
                      className="col-span-3 self-start text-[11.5px] text-blue hover:underline"
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

      <div className="mt-5 grid gap-3">
        <ValidationSummary issues={validationIssues} />
      <div className="flex justify-end gap-2">
        {formValid && !goodsReceiptId && !procurementClaimKey && <Button onClick={() => setShowRecurring(true)}>Save as recurring…</Button>}
        {formValid && !procurementClaimKey && <Button data-testid="btn-save-entry-template" onClick={() => void saveTemplate()}>Record safe macro…</Button>}
        <Button data-testid="btn-save-voucher-draft" disabled={saving} onClick={() => void saveDraft()}>Save draft</Button>
        <Button onClick={() => nav.back()}>Cancel</Button>
        {kind === 'sales' && (
          <Button disabled={saving} onClick={() => void save(true)}>
            Save + invoice PDF
          </Button>
        )}
        <Button variant="primary" data-testid="btn-save-voucher" disabled={saving || validationIssues.length > 0} onClick={() => void save()}>
          Save voucher ⌘↵
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
      {showRecurring && <SaveAsRecurringModal buildPayload={buildPayload} onClose={() => setShowRecurring(false)} />}
      {editingParty && party && <LedgerFormModal ledger={party} onClose={() => setEditingParty(false)} />}
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
