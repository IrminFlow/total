import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import { isB2cLarge } from '@shared/gst/returns'
import { rcmAdvice } from '@shared/gst/reverseCharge'
import { suggestNarration } from '@shared/autoNarration'
import { useStickyFlag } from '../../lib/useStickyTab'
import { computeGst, supplyTypeFor, addBreakups, type GstBreakup } from '@shared/gst/calc'
import { GST_STATES } from '@shared/gst/states'
import { roundToRupee, formatPaise, amountInWords } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts, type VoucherDraft } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, isAnyModalOpen, LineTableScroller, Money, Panel, Select, TextInput, inputCls } from '../../components/ui'
import { ItemPicker, LedgerPicker, useLedgers, useStockItems, useTaxLedgers } from '../../components/pickers'
import { LedgerFormModal } from '../../components/LedgerFormModal'
import { useFeatures } from '../../lib/useFeatures'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { addDaysLocal, nextLineKey, NUMBER_LOADING, useVoucherNumberField } from './hooks'
import { QuickItemModal, QuickLedgerModal, SaveAsRecurringModal } from './modals'

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

export function InvoiceEntry({ typeId, kind, draft }: { typeId: number; kind: VoucherKind; draft?: VoucherDraft }): React.JSX.Element {
  const { info, workingDate, setWorkingDate, from: periodFrom, to: periodTo } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const ledgers = useLedgers()
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const { ensure: ensureTax, ensureRoundOff } = useTaxLedgers()

  const [date, setDate] = useState(draft?.date ?? workingDate)
  const [partyId, setPartyId] = useState<number | null>(draft?.partyLedgerId ?? null)
  const [accountId, setAccountId] = useState<number | null>(null)
  const [rows, setRows] = useState<ItemRow[]>(() => [blankItemRow()])
  const [narration, setNarration] = useState(draft?.narration ?? '')
  const [vehicleNo, setVehicleNo] = useState('')
  const [transporterId, setTransporterId] = useState('')
  const [distanceKm, setDistanceKm] = useState('')
  const [currencyCode, setCurrencyCode] = useState('')
  const [fxRateText, setFxRateText] = useState('')
  const { data: currencies } = useQuery({ queryKey: ['currencies'], queryFn: api.currencies.list })
  const [quickLedger, setQuickLedger] = useState<{ name: string; forParty: boolean } | null>(null)
  const [quickItem, setQuickItem] = useState<{ name: string; row: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [showRecurring, setShowRecurring] = useState(false)
  const [editingParty, setEditingParty] = useState(false)
  // ---------- GST details (place-of-supply override + memorandum flag) ----------
  const [gstOpen, setGstOpen] = useState(false)
  const [posOverride, setPosOverride] = useState<string | null>(null)
  const [keepParty, setKeepParty] = useStickyFlag('invoice-keep-party', false)
  const [optionalVoucher, setOptionalVoucher] = useState(false)

  const numberField = useVoucherNumberField(typeId, date)
  const isSalesSide = kind === 'sales' || kind === 'credit_note'

  // Unsaved-entry guard: anything meaningful typed into a fresh invoice blocks accidental
  // navigation until it's saved (save resets all of these).
  useUnsavedGuard(partyId != null || rows.some((r) => r.itemId != null) || narration.trim() !== '')

  const party = ledgers.find((l) => l.id === partyId) ?? null
  const account = ledgers.find((l) => l.id === accountId) ?? null

  // ---------- bill allocation ----------
  // sales/purchase: one default 'new' ref named after the voucher no, auto-synced to the
  // party-line total until the user edits the name/due-date directly.
  // credit/debit notes: default to allocating AGAINST the party's open bills (a note adjusts an
  // existing invoice) — "create new bill instead" restores the sales/purchase-style single ref.
  const isNoteKind = kind === 'credit_note' || kind === 'debit_note'
  const [billsOpen, setBillsOpen] = useState(true)
  const [billName, setBillName] = useState('')
  const [billNameTouched, setBillNameTouched] = useState(false)
  const [billDueDate, setBillDueDate] = useState(date)
  const [billDueDateTouched, setBillDueDateTouched] = useState(false)
  const [manualNewBillMode, setManualNewBillMode] = useState(false)
  const [noteBillRefs, setNoteBillRefs] = useState<VoucherBillRef[]>([])

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

  /**
   * Two things the entry screen can tell you that the books cannot work out after the fact.
   *
   * Reverse charge attaches to the *supply*, not the supplier, so a per-party flag misses the
   * common case: an ordinary vendor billing one notified service. Matched on the SAC of what was
   * actually billed, and only ever advice — reverse charge moves real money, so nothing here
   * changes a posting.
   *
   * B2C large: an inter-state sale over Rs 1,00,000 to an unregistered buyer must be itemised in
   * GSTR-1 table 5 rather than summarised in 7. That is a return-time consequence of an
   * entry-time fact, and the entry screen is where the value can still be checked.
   */
  const rcm = useMemo(() => {
    if (isSalesSide || kind === 'debit_note') return { kind: 'none' as const }
    // The SAC on the purchase ledger, or on the first line's stock item when it carries one.
    const itemHsn = computed.detail.find((d) => d.item.hsn)?.item.hsn ?? null
    return rcmAdvice({
      sac: itemHsn ?? account?.hsn ?? null,
      partyFlagged: !!party?.rcm,
      partyGstin: party?.gstin ?? null
    })
  }, [isSalesSide, kind, computed.detail, account?.hsn, party?.rcm, party?.gstin])

  // The same predicate the return applies, not a second copy of the test — a hint derived from
  // its own rule would eventually disagree with the return it is meant to predict.
  const b2cLarge =
    isSalesSide &&
    kind === 'sales' &&
    isB2cLarge({
      partyGstin: party?.gstin ?? null,
      pos: posOverride ?? party?.stateCode ?? info!.stateCode,
      companyStateCode: info!.stateCode,
      invoiceValue: computed.rounded
    })

  // One cached call for every ledger's balance, shared with any other screen that asks — cheaper
  // and simpler than a per-party endpoint, and react-query keeps it warm across party changes.
  const { data: balances } = useQuery({
    queryKey: ['ledgerBalances', periodTo],
    queryFn: () => api.ledgers.balances(periodTo),
    enabled: !!partyId
  })
  const partyBalance = partyId ? (balances?.find((b) => b.ledgerId === partyId)?.balance ?? null) : null

  // A narration written from what the voucher already says. Narration is the field most often
  // left blank and most often wanted a year later, and asking for it every time is how it ends
  // up blank.
  const suggestedNarration = useMemo(
    () =>
      suggestNarration({
        kind,
        partyName: party?.name ?? null,
        itemNames: computed.detail.map((d) => d.item.name),
        accountNames: account ? [account.name] : []
      }),
    [kind, party?.name, computed.detail, account]
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
      inventory: computed.detail.map((d) => ({
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
  }, [partyId, accountId, computed, kind, typeId, date, numberField.forPayload, narration, transporterId, vehicleNo, distanceKm, posOverride, optionalVoucher, fxActive, currencyCode, fxRate, isNoteKind, manualNewBillMode, noteBillRefs, billName, billDueDate, ensureTax, ensureRoundOff])

  const formValid = !!partyId && !!accountId && computed.detail.length > 0

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
      // Dated outside the working period. Not an error -- backdating an invoice is routine -- but
      // it is the reason a voucher "vanishes" the moment it is saved, since every report on
      // screen is scoped to that period.
      if (input.date < periodFrom || input.date > periodTo) {
        const proceed = await confirmDialog({
          title: 'Outside the open period',
          message: `${toDisplayDate(input.date)} is outside the working period (${toDisplayDate(periodFrom)} to ${toDisplayDate(periodTo)}). It will save correctly, but will not show in reports until you change the period. Save it?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const dupes = await api.vouchers.duplicates(input)
      if (dupes.length > 0) {
        const first = dupes[0]!
        const proceed = await confirmDialog({
          title: 'Possible duplicate',
          message: `Voucher ${first.number} on ${first.date} has the same party and amount. Save anyway?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const saved = await api.vouchers.save(input)
      toast.push('success', `${saved.number} saved — ${formatPaise(computed.rounded, { symbol: true })}`)
      if (andPdf && kind === 'sales') {
        await api.invoice.pdf(saved.id)
      }
      setWorkingDate(date)
      // The date always carries — it is already the working date — and the party carries only if
      // asked. Entering ten invoices for one customer and re-picking them ten times is the tax;
      // entering ten for ten customers and having the last one stick is the opposite mistake, so
      // it is a choice rather than a default.
      if (!keepParty) setPartyId(null)
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
  }, [saving, partyId, accountId, computed, buildPayload, isSalesSide, kind, typeId, date, periodFrom, periodTo, keepParty, toast, setWorkingDate, queryClient, numberField.reset])

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

      {rcm.kind !== 'none' && (
        <p
          className={`mt-2 text-hint ${rcm.kind === 'suggest' ? 'text-amber' : 'text-muted'}`}
          data-testid="hint-rcm"
        >
          {rcm.kind === 'suggest' ? (
            <>
              <b>{rcm.match.category.label}</b> looks like a reverse-charge supply — you would owe
              the tax, not the supplier. {rcm.match.category.reason}. Set “Reverse charge” on the
              party ledger if that is right.
            </>
          ) : (
            <>
              Reverse charge — {rcm.match.category.label.toLowerCase()}. The tax is yours to pay and
              the party is flagged for it.
            </>
          )}
        </p>
      )}

      {b2cLarge && (
        <p className="mt-2 text-hint text-amber" data-testid="hint-b2cl">
          Over ₹1,00,000 inter-state to an unregistered buyer — this goes into GSTR-1 table 5
          (B2C large) invoice by invoice, not into the table 7 summary. Worth checking the value
          and the place of supply now.
        </p>
      )}

      <div className="mt-2 flex items-center justify-between">
        {party ? (
          <p className="text-hint text-muted" data-testid="party-facts">
            {party.gstin ? <>GSTIN <span className="num">{party.gstin}</span> · </> : 'Unregistered · '}
            {supply === 'intra' ? 'Intra-state — CGST + SGST' : 'Inter-state — IGST'}
            {/* The balance the party is on right now. "Does he already owe me?" is the question
                being asked at exactly this moment, and it used to need a separate screen. */}
            {partyBalance != null && (
              <>
                {' · '}
                <span data-testid="party-balance">
                  Balance <Money paise={partyBalance} signed />
                </span>
              </>
            )}
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
            <th scope="col">Item</th>
            <th scope="col" className="r w-28">Qty</th>
            <th scope="col" className="r w-32">Rate</th>
            <th scope="col" className="r w-28">Disc.</th>
            <th scope="col" className="r w-24">GST %</th>
            <th scope="col" className="r w-36">Amount</th>
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
                    <span className="w-8 text-caption text-muted">{unitOf(r.itemId)}</span>
                  </div>
                </td>
                <td className="r">
                  <AmountInput paise={r.rate} onPaise={(p) => setRow(i, { rate: p })} />
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
            <TextInput
              data-testid="input-narration"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              onFocus={() => {
                // Filled on focus, not on every keystroke of the lines above: the suggestion is
                // offered at the moment the field is reached and can be typed straight over.
                // Never over something already typed.
                if (!narration && suggestedNarration) setNarration(suggestedNarration)
              }}
              placeholder={suggestedNarration ?? 'Being goods sold…'}
            />
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
          <div className="mt-1 flex justify-between border-t border-ink pt-1.5 pb-0.5 text-lead font-semibold" style={{ borderBottom: '3px double var(--color-ink)' }}>
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
          <span className="inline-block w-3 text-label">{gstOpen ? '▾' : '▸'}</span>
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
            <span className="inline-block w-3 text-label">{billsOpen ? '▾' : '▸'}</span>
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
                    <p className="text-small text-muted">No open bills for this party.</p>
                  ) : (
                    <div className="flex flex-col gap-1">
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

      <div className="mt-5 flex justify-end gap-2">
        {formValid && <Button onClick={() => setShowRecurring(true)}>Save as recurring…</Button>}
        <Button onClick={() => nav.back()}>Cancel</Button>
        {kind === 'sales' && (
          <Button disabled={saving} onClick={() => void save(true)}>
            Save + invoice PDF
          </Button>
        )}
        <label className="mr-2 flex items-center gap-1.5 text-hint text-muted" title="Keep the party selected after saving, for the next voucher">
          <input
            type="checkbox"
            data-testid="check-keep-party"
            checked={keepParty}
            onChange={(e) => setKeepParty(e.target.checked)}
          />
          Keep party
        </label>
        <Button variant="primary" data-testid="btn-save-voucher" disabled={saving} onClick={() => void save()}>
          Save voucher ⌘↵
        </Button>
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
