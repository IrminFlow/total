import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import { computeGst, supplyTypeFor, addBreakups, type GstBreakup } from '@shared/gst/calc'
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
}

const blankItemRow = (): ItemRow => ({ key: nextLineKey(), itemId: null, qtyText: '', rate: null })

export function InvoiceEntry({ typeId, kind, draft }: { typeId: number; kind: VoucherKind; draft?: VoucherDraft }): React.JSX.Element {
  const { info, workingDate, setWorkingDate } = useSession()
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

  const supply = supplyTypeFor(info!.stateCode, party?.stateCode ?? info!.stateCode)

  const fxRate = currencyCode && fxRateText.trim() ? Number(fxRateText) : null
  const fxActive = !!currencyCode && !!fxRate && Number.isFinite(fxRate) && fxRate > 0

  const computed = useMemo(() => {
    const itemMap = new Map(items.map((i) => [i.id, i]))
    const detail = rows
      .map((r) => {
        const item = r.itemId ? itemMap.get(r.itemId) : null
        const qtyMilli = Math.round(parseFloat(r.qtyText || '0') * 1000)
        if (!item || !Number.isFinite(qtyMilli) || qtyMilli <= 0 || r.rate == null) return null
        // Rates are typed in the invoice currency; books stay in ₹.
        const baseRate = fxActive ? Math.round(r.rate * fxRate!) : r.rate
        const amount = Math.round((qtyMilli * baseRate) / 1000)
        const rate = item.gstRate ?? account?.gstRate ?? 0
        const cessRate = item.cessRate ?? 0
        return { item, qtyMilli, ratePaise: baseRate, amount, rate, cessRate }
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
      // POS override select lands with the Wave-3 "GST details" collapsible (S4).
      posOverride: null,
      currencyCode: fxActive ? currencyCode : null,
      exchangeRate: fxActive ? fxRate : null,
      lines,
      inventory: computed.detail.map((d) => ({
        stockItemId: d.item.id,
        godownId: null,
        qtyMilli: d.qtyMilli,
        ratePaise: d.ratePaise,
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
  }, [partyId, accountId, computed, kind, typeId, date, numberField.forPayload, narration, transporterId, vehicleNo, distanceKm, fxActive, currencyCode, fxRate, isNoteKind, manualNewBillMode, noteBillRefs, billName, billDueDate, ensureTax, ensureRoundOff])

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
      setPartyId(null)
      setRows([blankItemRow()])
      setNarration('')
      setVehicleNo('')
      setDistanceKm('')
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
  }, [saving, partyId, accountId, computed, buildPayload, isSalesSide, kind, typeId, date, toast, setWorkingDate, queryClient, numberField.reset])

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
            <th className="r w-24">GST %</th>
            <th className="r w-36">Amount</th>
          </tr>
        </thead>
        <tbody data-testid="rows-invoice-lines">
          {rows.map((r, i) => {
            const item = r.itemId ? itemMap.get(r.itemId) : null
            const qty = parseFloat(r.qtyText || '0')
            const amount = item && qty > 0 && r.rate != null ? Math.round(qty * r.rate) : 0
            return (
              <tr key={r.key}>
                <td>
                  <ItemPicker
                    value={r.itemId}
                    onPick={(id) => {
                      const picked = id ? itemMap.get(id) : null
                      setRow(i, { itemId: id, rate: r.rate ?? (picked ? undefined : null) })
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

      <div className="mt-5 flex justify-end gap-2">
        {formValid && <Button onClick={() => setShowRecurring(true)}>Save as recurring…</Button>}
        <Button onClick={() => nav.back()}>Cancel</Button>
        {kind === 'sales' && (
          <Button disabled={saving} onClick={() => void save(true)}>
            Save + invoice PDF
          </Button>
        )}
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
