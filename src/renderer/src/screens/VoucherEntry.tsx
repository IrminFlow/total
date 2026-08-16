import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CostCentre, Group, Ledger, VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import { computeGst, supplyTypeFor, addBreakups, type GstBreakup } from '@shared/gst/calc'
import { roundToRupee, formatPaise, amountInWords } from '@shared/money'
import { toDisplayDate, todayISO } from '@shared/dates'
import { nextDueAfter } from '@shared/recurring'
import { api, type TdsSuggestion } from '../lib/client'
import { useNav, useSession, useToasts, type VoucherDraft } from '../state/stores'
import { AmountInput, Button, DateInput, Field, Kbd, Modal, Money, Panel, Select, TextInput, inputCls } from '../components/ui'
import { ItemPicker, LedgerPicker, useGroups, useLedgers, useStockItems, useTaxLedgers } from '../components/pickers'
import { LedgerFormModal, groupAncestryNames, PARTY_GROUPS, TRADING_GROUPS } from '../components/LedgerFormModal'
import { useFeatures } from '../lib/useFeatures'
import { confirmDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'

const TRADING_KINDS: VoucherKind[] = ['sales', 'purchase', 'credit_note', 'debit_note']
const FKEYS: Record<string, VoucherKind> = {
  F4: 'contra', F5: 'payment', F6: 'receipt', F7: 'journal', F8: 'sales', F9: 'purchase'
}

// ---------- shared ledger-group helpers (party detection, cash/bank detection) ----------

function groupChain(groupId: number, groupMap: Map<number, Group>): Group[] {
  const chain: Group[] = []
  let g = groupMap.get(groupId)
  while (g) {
    chain.push(g)
    g = g.parentId ? groupMap.get(g.parentId) : undefined
  }
  return chain
}

function isPartyLedger(l: Ledger, groupMap: Map<number, Group>): boolean {
  return groupChain(l.groupId, groupMap).some((g) => g.name === 'Sundry Debtors' || g.name === 'Sundry Creditors')
}

function isCashOrBankLedger(l: Ledger, groupMap: Map<number, Group>): boolean {
  return groupChain(l.groupId, groupMap).some((g) => ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(g.name))
}

/** Bank only (excludes Cash-in-Hand) — a cheque can only be drawn against a bank ledger. */
function isBankLedger(l: Ledger, groupMap: Map<number, Group>): boolean {
  return groupChain(l.groupId, groupMap).some((g) => ['Bank Accounts', 'Bank OD A/c'].includes(g.name))
}

/** Local UTC date-add — mirrors @shared/outstanding's private helper (that one isn't exported). */
function addDaysLocal(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

export function VoucherEntry({
  voucherId,
  kindHint,
  draft
}: {
  voucherId?: number
  kindHint?: VoucherKind
  draft?: VoucherDraft
}): React.JSX.Element {
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const { data: existing } = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.vouchers.get(voucherId!),
    enabled: !!voucherId
  })
  const features = useFeatures()
  const [typeId, setTypeId] = useState<number | null>(null)
  const [hintDismissed, setHintDismissed] = useState(false)

  // Same queryKey Gateway uses for report:dashboard — a brand-new company (no vouchers yet) gets a
  // first-time hint here; react-query dedupes the request rather than firing a second round-trip.
  const { from } = useSession()
  const today = todayISO()
  const { data: dash } = useQuery({ queryKey: ['dashboard', today, from], queryFn: () => api.reports.dashboard(today, from) })
  const showFirstVoucherHint = !voucherId && !hintDismissed && dash?.voucherCount === 0

  useEffect(() => {
    if (!types || typeId != null) return
    if (voucherId) return
    const wanted = kindHint ?? 'journal'
    const t = types.find((t) => t.kind === wanted) ?? types[0]
    if (t) setTypeId(t.id)
  }, [types, typeId, kindHint, voucherId])

  useEffect(() => {
    if (existing) setTypeId(existing.voucherTypeId)
  }, [existing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const kind = FKEYS[e.key]
      if (!kind || voucherId || !types) return
      const withCtrl = e.ctrlKey || e.altKey
      const target = withCtrl && kind === 'sales' ? 'credit_note' : withCtrl && kind === 'purchase' ? 'debit_note' : kind
      const t = types.find((t) => t.kind === target)
      if (t) {
        e.preventDefault()
        setTypeId(t.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [types, voucherId])

  if (!types || (voucherId && !existing)) return <p className="text-muted">Loading…</p>
  const currentType = types.find((t) => t.id === typeId) ?? types[0]!
  const invoiceMode = !voucherId && TRADING_KINDS.includes(currentType.kind)
  const manufactureMode = !voucherId && currentType.kind === 'stock_journal'

  return (
    <div className="mx-auto max-w-4xl">
      {showFirstVoucherHint && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-amber/40 bg-amber/10 px-4 py-2.5">
          <p className="text-[12.5px] text-ink">
            First voucher? Pick a type above (or <Kbd>F8</Kbd> for Sales), fill in the lines, then{' '}
            <Kbd>⌘↵</Kbd> to save.
          </p>
          <button
            onClick={() => setHintDismissed(true)}
            aria-label="Dismiss"
            className="shrink-0 text-[12px] text-muted hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="mb-4 flex items-center gap-2">
        <h2 className="mr-3 font-serif text-[19px] font-semibold tracking-tight">
          {voucherId ? `Alter voucher ${existing?.number}` : 'Voucher entry'}
        </h2>
        {!voucherId &&
          types
            .filter((t) => t.kind !== 'physical_stock' && (features.inventory || t.kind !== 'stock_journal'))
            .map((t) => (
            <button
              key={t.id}
              data-testid={`tab-voucher-entry-${t.kind}`}
              onClick={() => setTypeId(t.id)}
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                t.id === currentType.id ? 'bg-amber/20 text-amber' : 'text-muted hover:bg-panel2 hover:text-ink'
              }`}
            >
              {t.name}
            </button>
          ))}
      </div>
      {invoiceMode ? (
        <InvoiceEntry key={currentType.id} typeId={currentType.id} kind={currentType.kind} draft={draft} />
      ) : manufactureMode ? (
        <ManufactureEntry key={currentType.id} typeId={currentType.id} />
      ) : (
        <AccountingEntry
          key={voucherId ?? currentType.id}
          typeId={currentType.id}
          kind={currentType.kind}
          voucherId={voucherId}
          draft={draft}
        />
      )}
      <p className="mt-3 text-[11.5px] text-muted">
        <Kbd>F4</Kbd>–<Kbd>F9</Kbd> switch type · <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back · dates accept <span className="num">7</span>, <span className="num">7/4</span>, <span className="num">y</span>
      </p>
    </div>
  )
}

// ---------- shared header fields ----------

function useVoucherNumber(typeId: number, date: string, excludeId?: number): string {
  const { data } = useQuery({
    queryKey: ['nextNumber', typeId, date, excludeId],
    queryFn: () => api.vouchers.nextNumber(typeId, date, excludeId)
  })
  return data?.number ?? '…'
}

/** Loading placeholder for the suggested next number, before voucher:nextNumber resolves. Never
 *  sent as input.number — see numberField.value below. */
const NUMBER_LOADING = '…'

/** The voucher No. field: a plain TextInput pre-filled from voucher:nextNumber, but editable —
 *  once the user types into it ("touched"), further nextNumber results stop overwriting it. A
 *  type or date change is a new numbering context, so it resets `touched` and re-syncs to the
 *  freshly suggested number. `reset()` clears touched after a successful save so the field goes
 *  back to tracking the (now-advanced) suggestion for the next voucher. */
export function useVoucherNumberField(typeId: number, date: string, excludeId?: number): {
  value: string
  onChange: (v: string) => void
  reset: () => void
  /** For posting: '' when untouched-and-still-loading (never send the '…' placeholder), else the
   *  trimmed value the user is looking at (empty string included — that means "auto-assign"). */
  forPayload: string
} {
  const fetched = useVoucherNumber(typeId, date, excludeId)
  const [value, setValue] = useState(fetched)
  const [touched, setTouched] = useState(false)
  const keyRef = useRef(`${typeId}|${date}`)

  useEffect(() => {
    const key = `${typeId}|${date}`
    if (keyRef.current !== key) {
      keyRef.current = key
      setTouched(false)
    }
  }, [typeId, date])

  useEffect(() => {
    if (!touched) setValue(fetched)
  }, [fetched, touched])

  const onChange = useCallback((v: string): void => {
    setTouched(true)
    setValue(v)
  }, [])
  const reset = useCallback((): void => setTouched(false), [])

  return { value, onChange, reset, forPayload: value === NUMBER_LOADING ? '' : value.trim() }
}

// ---------- invoice mode (sales / purchase / notes) ----------

interface ItemRow {
  itemId: number | null
  qtyText: string
  rate: number | null
}

function InvoiceEntry({ typeId, kind, draft }: { typeId: number; kind: VoucherKind; draft?: VoucherDraft }): React.JSX.Element {
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
  const [rows, setRows] = useState<ItemRow[]>([{ itemId: null, qtyText: '', rate: null }])
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
    if (!billNameTouched && numberField.value !== '…') setBillName(numberField.value)
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
      setRows([{ itemId: null, qtyText: '', rate: null }])
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
  }, [saving, partyId, accountId, computed, buildPayload, isSalesSide, kind, date, toast, setWorkingDate, queryClient, numberField.reset])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
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
      if (last.itemId != null) next.push({ itemId: null, qtyText: '', rate: null })
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
        <Field label="No." hint={numberField.value === '…' ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={numberField.value === '…' ? '' : numberField.value}
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

      <table className="ledger-table mt-4">
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
              <tr key={i}>
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

// ---------- manufacture mode (stock journal via BOM) ----------

function ManufactureEntry({ typeId }: { typeId: number }): React.JSX.Element {
  const { workingDate, setWorkingDate, to } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const [date, setDate] = useState(workingDate)
  const [producedId, setProducedId] = useState<number | null>(null)
  const [qtyText, setQtyText] = useState('1')
  const [extraPctText, setExtraPctText] = useState('0')
  const [saving, setSaving] = useState(false)
  const number = useVoucherNumber(typeId, date)

  const { data: bom } = useQuery({
    queryKey: ['bom', producedId],
    queryFn: () => api.bom.get(producedId!),
    enabled: !!producedId
  })
  const { data: stock } = useQuery({
    queryKey: ['stockSummary', to],
    queryFn: () => api.reports.stockSummary(to)
  })

  const qty = Number(qtyText) || 0
  const extraPct = Number(extraPctText) || 0
  const avgCost = (itemId: number): number => {
    const row = stock?.find((s) => s.stockItemId === itemId)
    if (!row || row.closingQtyMilli <= 0) return 0
    return Math.round((row.closingValue * 1000) / row.closingQtyMilli) // paise per whole unit
  }

  const consumption = (bom ?? []).map((line) => {
    const useMilli = Math.round(line.qtyMilliPerUnit * qty)
    const rate = avgCost(line.componentId)
    return { ...line, useMilli, rate, amount: Math.round((useMilli * rate) / 1000) }
  })
  const consumedTotal = consumption.reduce((s, c) => s + c.amount, 0)
  const producedValue = Math.round(consumedTotal * (1 + extraPct / 100))

  const save = async (): Promise<void> => {
    if (saving) return
    if (!producedId) return void toast.push('error', 'Pick the item to produce')
    if (!bom?.length) return void toast.push('error', 'This item has no bill of materials — set it in Masters → Stock items')
    if (qty <= 0) return void toast.push('error', 'Quantity must be positive')
    setSaving(true)
    try {
      const qtyMilli = Math.round(qty * 1000)
      const saved = await api.vouchers.save({
        voucherTypeId: typeId,
        date,
        partyLedgerId: null,
        narration: `Manufactured ${qty} × ${items.find((i) => i.id === producedId)?.name ?? ''}`.trim(),
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        posOverride: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [],
        inventory: [
          ...consumption.map((c) => ({
            stockItemId: c.componentId,
            godownId: null,
            qtyMilli: c.useMilli,
            ratePaise: c.rate,
            amount: c.amount,
            direction: 'out' as const
          })),
          {
            stockItemId: producedId,
            godownId: null,
            qtyMilli,
            ratePaise: Math.round((producedValue * 1000) / qtyMilli),
            amount: producedValue,
            direction: 'in' as const
          }
        ],
        billRefs: [],
        tds: null
      })
      toast.push('success', `Manufacture ${saved.number} saved — ${formatPaise(producedValue, { symbol: true })} into stock`)
      setWorkingDate(date)
      setProducedId(null)
      setQtyText('1')
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel className="p-5">
      <div className="grid grid-cols-4 gap-3">
        <Field label="No.">
          <div className={`${inputCls} num bg-panel text-muted`}>{number}</div>
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <Field label="Produce (needs a BOM)">
          <ItemPicker value={producedId} onPick={setProducedId} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Qty">
            <TextInput value={qtyText} onChange={(e) => setQtyText(e.target.value)} className="num text-right" />
          </Field>
          <Field label="Overhead %">
            <TextInput value={extraPctText} onChange={(e) => setExtraPctText(e.target.value)} className="num text-right" />
          </Field>
        </div>
      </div>

      {producedId && !bom?.length && (
        <p className="mt-3 text-[12.5px] text-amber">
          No bill of materials on this item yet — add components in Masters → Stock items → Edit.
        </p>
      )}

      {consumption.length > 0 && (
        <table className="ledger-table mt-4">
          <thead>
            <tr>
              <th>Consumes</th>
              <th className="r w-32">Qty</th>
              <th className="r w-32">Avg cost</th>
              <th className="r w-36">Amount</th>
            </tr>
          </thead>
          <tbody>
            {consumption.map((c) => (
              <tr key={c.componentId} className={c.rate === 0 ? 'text-cr' : ''}>
                <td>
                  {c.componentName}
                  {c.rate === 0 && <span className="ml-2 text-[11px]">no stock cost — purchase it first</span>}
                </td>
                <td className="r num">{c.useMilli / 1000} {c.unitSymbol}</td>
                <td className="r"><Money paise={c.rate} /></td>
                <td className="r"><Money paise={c.amount} /></td>
              </tr>
            ))}
            <tr className="total-row">
              <td colSpan={3}>Into stock (incl. {extraPct}% overhead)</td>
              <td className="r"><Money paise={producedValue} /></td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => nav.back()}>Cancel</Button>
        <Button variant="primary" data-testid="btn-save-manufacture" disabled={saving} onClick={() => void save()}>
          Save manufacture
        </Button>
      </div>
    </Panel>
  )
}

// ---------- accounting mode (payment / receipt / contra / journal + alteration) ----------

interface AcctRow {
  drCr: 'dr' | 'cr'
  ledgerId: number | null
  amount: number | null
  costAllocations: { costCentreId: number; amount: number }[]
}

const blankAcctRow = (drCr: 'dr' | 'cr'): AcctRow => ({ drCr, ledgerId: null, amount: null, costAllocations: [] })

function AccountingEntry({
  typeId,
  kind,
  voucherId,
  draft
}: {
  typeId: number
  kind: VoucherKind
  voucherId?: number
  draft?: VoucherDraft
}): React.JSX.Element {
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const ledgers = useLedgers()
  const groups = useGroups()
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const [date, setDate] = useState(draft?.date ?? workingDate)
  const [rows, setRows] = useState<AcctRow[]>(
    draft?.lines?.length
      ? [...draft.lines.map((l) => ({ ...l, costAllocations: [] as AcctRow['costAllocations'] })), blankAcctRow('cr')]
      : [blankAcctRow('dr'), blankAcctRow('cr')]
  )
  const [narration, setNarration] = useState(draft?.narration ?? '')
  const [instrumentNo, setInstrumentNo] = useState('')
  const [quickLedger, setQuickLedger] = useState<{ name: string; row: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showRecurring, setShowRecurring] = useState(false)
  const [editingParty, setEditingParty] = useState<Ledger | null>(null)
  // Alteration keeps the voucher's own number editable but never auto-suggests a fresh one off
  // voucher:nextNumber (that would rename an existing document to "the next available number"
  // the moment you touch its date) — it's seeded once from the loaded voucher below. New-entry
  // mode uses the touched/refetch hook instead, same as InvoiceEntry.
  const [alterNumber, setAlterNumber] = useState('')
  const numberField = useVoucherNumberField(typeId, date, voucherId)
  const [draftPartyId] = useState(draft?.partyLedgerId ?? null)

  const { data: existing } = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.vouchers.get(voucherId!),
    enabled: !!voucherId
  })

  // ---------- TDS (payment / journal to a party flagged for TDS) ----------
  const [tds, setTds] = useState<{ sectionId: number; baseAmount: number; tdsAmount: number } | null>(null)
  const [tdsSuggestion, setTdsSuggestion] = useState<TdsSuggestion | null>(null)
  const [tdsDismissed, setTdsDismissed] = useState(false)
  // Set right before WE mutate rows in a way that would otherwise re-trigger the suggestion
  // effect (applying TDS onto the flagged CR row itself, or loading a voucher that already has
  // tds applied) — the effect consumes it once and skips, so the banner doesn't re-fetch/reopen
  // off of our own write. Genuine user edits always leave it false and behave normally.
  const skipNextTdsEffectRef = useRef(false)

  // ---------- bill allocations (receipt/payment checkbox list; trading-kind alteration editor) ----------
  const [billRefs, setBillRefs] = useState<VoucherBillRef[]>([])
  const [billsOpen, setBillsOpen] = useState(true)

  // ---------- per-line cost-centre allocation ----------
  const { data: ccList } = useQuery({ queryKey: ['costCentres'], queryFn: api.cc.list })
  const hasCc = features.costCentres && (ccList?.length ?? 0) > 0
  const [ccModalRow, setCcModalRow] = useState<number | null>(null)

  useEffect(() => {
    if (existing && !loaded) {
      setDate(existing.date)
      setAlterNumber(existing.number)
      setNarration(existing.narration ?? '')
      setInstrumentNo(existing.instrumentNo ?? '')
      setRows(existing.lines.map((l) => ({ drCr: l.drCr, ledgerId: l.ledgerId, amount: l.amount, costAllocations: l.costAllocations })))
      setBillRefs(existing.billRefs)
      setTds(existing.tds)
      if (existing.tds) {
        setTdsDismissed(true)
        skipNextTdsEffectRef.current = true
      }
      setLoaded(true)
    }
  }, [existing, loaded])

  const totalDr = rows.reduce((s, r) => s + (r.drCr === 'dr' ? (r.amount ?? 0) : 0), 0)
  const totalCr = rows.reduce((s, r) => s + (r.drCr === 'cr' ? (r.amount ?? 0) : 0), 0)
  const balanced = totalDr === totalCr && totalDr > 0

  // Unsaved-entry guard for NEW vouchers only (save resets the form). Alterations are exempt:
  // rows are seeded from the stored voucher, so content alone can't distinguish edited from
  // pristine — guarding them would also fire on the programmatic nav.back() after save.
  useUnsavedGuard(
    !voucherId && (rows.some((r) => r.ledgerId != null || (r.amount ?? 0) !== 0) || narration.trim() !== '')
  )

  const setRow = (i: number, patch: Partial<AcctRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.ledgerId != null) next.push(blankAcctRow('cr'))
      return next
    })
  }

  // A voucher's "party" for TDS/bill-allocation purposes: whichever posted ledger is a Sundry
  // Debtor/Creditor or is flagged for TDS. Falls back to a draft-supplied party (e.g. the GSTR-2B
  // "Create purchase" nudge) when the rows don't yet name one unambiguously.
  const derivedPartyId = useMemo(() => {
    const candidates = new Set<number>()
    for (const r of rows) {
      if (r.ledgerId == null) continue
      const l = ledgers.find((x) => x.id === r.ledgerId)
      if (!l) continue
      if (isPartyLedger(l, groupMap) || l.tdsSectionId != null) candidates.add(l.id)
    }
    if (candidates.size === 1) return [...candidates][0]!
    return draftPartyId
  }, [rows, ledgers, groupMap, draftPartyId])

  // How much of a prior Apply is already sitting in the TDS payable line — i.e. how much the
  // target line has already been reduced (the cumulative reduction on the target always equals
  // the current payable line's amount; see applyTds). Declared before tdsCandidateRow because
  // the journal vendor-CR shape needs it to reconstruct the pre-deduction gross amount below.
  const existingTdsPayableAmount = useMemo(() => {
    if (!tds || !tdsSuggestion) return 0
    return rows.find((r) => r.drCr === 'cr' && r.ledgerId === tdsSuggestion.payableLedgerId)?.amount ?? 0
  }, [rows, tds, tdsSuggestion])

  // The dr-side (payment: "Dr Vendor / Cr Bank") is checked first; journal additionally checks
  // the cr side, since the standard journal shape is "Dr Expense / Cr Vendor(flagged)" — the
  // vendor never appears as a debit there. `rowSide` records which one matched, since it decides
  // both the suggestion's base amount and (in applyTds) which line absorbs the deduction.
  //
  // For the cr shape, `amount` is reconstructed back to the GROSS pre-deduction figure (current
  // row amount + whatever a prior Apply already carved out of it) rather than read live off the
  // row — Apply reduces that same row, so reading it live would drift the suggestion base down
  // to the net amount on any re-trigger (e.g. editing the date) and silently under-deduct on a
  // re-apply. The payment/dr shape doesn't need this: Apply reduces a different (bank) line, so
  // the dr candidate row's amount never moves on its own.
  const tdsCandidateRow = useMemo(() => {
    if (kind !== 'payment' && kind !== 'journal') return null
    for (const r of rows) {
      if (r.drCr !== 'dr' || r.ledgerId == null || !r.amount) continue
      const l = ledgers.find((x) => x.id === r.ledgerId)
      if (l?.tdsSectionId != null) return { ledgerId: r.ledgerId, amount: r.amount, rowSide: 'dr' as const }
    }
    if (kind === 'journal') {
      for (const r of rows) {
        if (r.drCr !== 'cr' || r.ledgerId == null || !r.amount) continue
        const l = ledgers.find((x) => x.id === r.ledgerId)
        if (l?.tdsSectionId != null) {
          return { ledgerId: r.ledgerId, amount: r.amount + existingTdsPayableAmount, rowSide: 'cr' as const }
        }
      }
    }
    return null
  }, [rows, kind, ledgers, existingTdsPayableAmount])

  // Where the TDS amount would come out of: the flagged CR row itself for the journal vendor
  // shape (Dr Expense / Cr Vendor 9000 / Cr TDS 1000 — the textbook entry), or the largest
  // cash/bank credit line for the payment shape.
  const tdsTargetIdx = useMemo(() => {
    if (!tdsCandidateRow) return -1
    if (tdsCandidateRow.rowSide === 'cr') {
      return rows.findIndex((r) => r.drCr === 'cr' && r.ledgerId === tdsCandidateRow.ledgerId)
    }
    let idx = -1
    let max = -1
    rows.forEach((r, i) => {
      if (r.drCr !== 'cr' || r.ledgerId == null) return
      const l = ledgers.find((x) => x.id === r.ledgerId)
      if (l && isCashOrBankLedger(l, groupMap) && (r.amount ?? 0) > max) {
        max = r.amount ?? 0
        idx = i
      }
    })
    return idx
  }, [rows, tdsCandidateRow, ledgers, groupMap])

  // Capacity of the target line = its current (live, un-reconstructed) amount plus whatever a
  // prior Apply already carved out of it.
  const tdsTargetCapacity = tdsTargetIdx === -1 ? 0 : (rows[tdsTargetIdx]!.amount ?? 0) + existingTdsPayableAmount
  const tdsApplyBlocked = !!tdsSuggestion && (tdsTargetIdx === -1 || tdsTargetCapacity < tdsSuggestion.tdsPaise)

  useEffect(() => {
    if (skipNextTdsEffectRef.current) {
      skipNextTdsEffectRef.current = false
      return
    }
    setTdsDismissed(false)
    if (!tdsCandidateRow) {
      setTdsSuggestion(null)
      return
    }
    const handle = setTimeout(() => {
      api.tds
        .suggest(tdsCandidateRow.ledgerId, tdsCandidateRow.amount, date)
        .then((s) => {
          setTdsSuggestion(s)
          // The suggestion's payable ledger is find-or-created server-side — refresh so it shows
          // up by name the moment Apply inserts it as a line.
          if (s) void queryClient.invalidateQueries({ queryKey: ['ledgers'] })
        })
        .catch(() => setTdsSuggestion(null))
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tdsCandidateRow?.ledgerId, tdsCandidateRow?.amount, date])

  const applyTds = (): void => {
    // tdsTargetIdx === -1 is already implied by tdsApplyBlocked today, but checked explicitly
    // too — mirrors the setRows updater's own guard so a future change to the blocked condition
    // can't set the tds payload without the corresponding line mutation.
    if (!tdsCandidateRow || !tdsSuggestion || tdsApplyBlocked || tdsTargetIdx === -1) return
    const tdsAmount = tdsSuggestion.tdsPaise
    const isVendorTarget = tdsCandidateRow.rowSide === 'cr'
    // The vendor-CR shape reduces the very row the candidate/suggestion is keyed on — mark it so
    // the debounce effect above doesn't treat our own write as a fresh user edit and re-suggest
    // off the now-smaller amount. The payment shape reduces an unrelated bank line, so the
    // candidate row is untouched and no suppression is needed there.
    if (isVendorTarget) skipNextTdsEffectRef.current = true
    setRows((rs) => {
      let next = rs.map((r) => ({ ...r }))

      let targetIdx = -1
      if (isVendorTarget) {
        targetIdx = next.findIndex((r) => r.drCr === 'cr' && r.ledgerId === tdsCandidateRow.ledgerId)
      } else {
        let max = -1
        next.forEach((r, i) => {
          if (r.drCr !== 'cr' || r.ledgerId == null) return
          const l = ledgers.find((x) => x.id === r.ledgerId)
          if (l && isCashOrBankLedger(l, groupMap) && (r.amount ?? 0) > max) {
            max = r.amount ?? 0
            targetIdx = i
          }
        })
      }
      // Guarded by tdsApplyBlocked above — should always be found, but never mutate blind.
      if (targetIdx === -1) return next

      // Re-applying (e.g. after editing the base amount) adjusts the TDS payable line already on
      // the voucher instead of inserting a duplicate.
      const existingIdx = tds ? next.findIndex((r) => r.drCr === 'cr' && r.ledgerId === tdsSuggestion.payableLedgerId) : -1
      if (existingIdx !== -1) {
        const delta = tdsAmount - (next[existingIdx]!.amount ?? 0)
        next[existingIdx] = { ...next[existingIdx]!, amount: tdsAmount }
        next[targetIdx] = { ...next[targetIdx]!, amount: (next[targetIdx]!.amount ?? 0) - delta }
        return next
      }

      next[targetIdx] = { ...next[targetIdx]!, amount: (next[targetIdx]!.amount ?? 0) - tdsAmount }
      const insertAt = next.length > 0 && next[next.length - 1]!.ledgerId == null ? next.length - 1 : next.length
      const tdsRow: AcctRow = { drCr: 'cr', ledgerId: tdsSuggestion.payableLedgerId, amount: tdsAmount, costAllocations: [] }
      next = [...next.slice(0, insertAt), tdsRow, ...next.slice(insertAt)]
      if (next[next.length - 1]!.ledgerId != null) next.push(blankAcctRow('cr'))
      return next
    })
    setTds({ sectionId: tdsSuggestion.sectionId, baseAmount: tdsCandidateRow.amount, tdsAmount })
    setTdsDismissed(true)
  }

  const showBillsSection =
    features.billWise && derivedPartyId != null && (kind === 'receipt' || kind === 'payment' || (TRADING_KINDS.includes(kind) && !!voucherId))
  const isCheckboxBills = kind === 'receipt' || kind === 'payment'

  const { data: openBills } = useQuery({
    queryKey: ['billsOpen', derivedPartyId, date],
    queryFn: () => api.bills.open(derivedPartyId!, date),
    enabled: !!derivedPartyId && isCheckboxBills
  })

  const partyLineTotal = derivedPartyId != null ? rows.filter((r) => r.ledgerId === derivedPartyId).reduce((s, r) => s + (r.amount ?? 0), 0) : 0
  const billAllocatedTotal = billRefs.reduce((s, r) => s + r.amount, 0)

  const toggleBill = (bill: OutstandingBill, checked: boolean): void => {
    setBillRefs((refs) => {
      if (checked) {
        const remaining = Math.max(0, partyLineTotal - refs.reduce((s, r) => s + r.amount, 0))
        const amount = Math.min(bill.pending, remaining || bill.pending)
        return [...refs, { kind: 'against', name: bill.number, amount, dueDate: null }]
      }
      return refs.filter((r) => !(r.kind === 'against' && r.name === bill.number))
    })
  }

  const setBillRefAmount = (name: string, amount: number): void => {
    setBillRefs((refs) => refs.map((r) => (r.name === name ? { ...r, amount } : r)))
  }

  const addManualBillRef = (): void => setBillRefs((refs) => [...refs, { kind: 'new', name: '', amount: 0, dueDate: null }])
  const setManualBillRef = (i: number, patch: Partial<VoucherBillRef>): void =>
    setBillRefs((refs) => refs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const removeManualBillRef = (i: number): void => setBillRefs((refs) => refs.filter((_, j) => j !== i))

  // Builds the exact VoucherInputParsed shape `save` posts — factored out so "Save as
  // recurring…" can serialize the current form state without also saving the voucher itself.
  const buildPayload = useCallback((): VoucherInputParsed | null => {
    const lines = rows
      .filter((r) => r.ledgerId != null && r.amount != null && r.amount > 0)
      .map((r) => ({ ledgerId: r.ledgerId!, drCr: r.drCr, amount: r.amount!, costAllocations: r.costAllocations }))
    if (lines.length < 2) return null
    const effectivePartyId = derivedPartyId ?? existing?.partyLedgerId ?? null
    return {
      voucherTypeId: typeId,
      date,
      number: (voucherId ? alterNumber.trim() : numberField.forPayload) || undefined,
      partyLedgerId: effectivePartyId,
      narration: narration.trim() || null,
      reference: null,
      instrumentNo: instrumentNo.trim() || null,
      instrumentDate: instrumentNo.trim() ? date : null,
      transporterId: existing?.transporterId ?? null,
      vehicleNo: existing?.vehicleNo ?? null,
      transportDistanceKm: existing?.transportDistanceKm ?? null,
      // Preserve an existing override on alteration; the edit UI itself is Wave-3 (S4).
      posOverride: existing?.posOverride ?? null,
      currencyCode: existing?.currencyCode ?? null,
      exchangeRate: existing?.exchangeRate ?? null,
      lines,
      inventory: existing?.inventory.map((l) => ({
        stockItemId: l.stockItemId, godownId: l.godownId, qtyMilli: l.qtyMilli,
        ratePaise: l.ratePaise, amount: l.amount, direction: l.direction
      })) ?? [],
      billRefs: effectivePartyId != null ? billRefs : [],
      tds: tds && effectivePartyId != null ? tds : null
    }
  }, [rows, derivedPartyId, existing, typeId, date, voucherId, alterNumber, numberField.forPayload, narration, instrumentNo, billRefs, tds])

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    const input = buildPayload()
    if (!input) return void toast.push('error', 'Enter at least one debit and one credit')
    setSaving(true)
    try {
      // Anomaly nudge on the largest line — a quiet second look, never a block.
      const largest = [...input.lines].sort((a, b) => b.amount - a.amount)[0]!
      const anomaly = await api.intel.anomaly(largest.ledgerId, largest.amount)
      if (anomaly.unusual && anomaly.typicalAmount != null) {
        const proceed = await confirmDialog({
          title: 'Unusual amount',
          message: `${formatPaise(largest.amount, { symbol: true })} is far above this ledger's usual ${formatPaise(anomaly.typicalAmount, { symbol: true })}. Save anyway?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const saved = await api.vouchers.save(input, voucherId)
      toast.push('success', `${saved.number} ${voucherId ? 'altered' : 'saved'}`)
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (voucherId) nav.back()
      else {
        setRows([blankAcctRow('dr'), blankAcctRow('cr')])
        setNarration('')
        setBillRefs([])
        setTds(null)
        setTdsSuggestion(null)
        setTdsDismissed(false)
        numberField.reset()
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, buildPayload, date, voucherId, toast, setWorkingDate, queryClient, nav, numberField.reset])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

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
      nav.back()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  // ---------- cheque printing + payment advice (saved payment vouchers only) ----------
  const bankCrLine = useMemo(() => {
    if (!voucherId || kind !== 'payment' || !existing) return null
    let best: { ledgerId: number; amount: number } | null = null
    for (const l of existing.lines) {
      if (l.drCr !== 'cr') continue
      const ledger = ledgers.find((x) => x.id === l.ledgerId)
      if (ledger && isBankLedger(ledger, groupMap) && (!best || l.amount > best.amount)) {
        best = { ledgerId: l.ledgerId, amount: l.amount }
      }
    }
    return best
  }, [voucherId, kind, existing, ledgers, groupMap])

  const printCheque = async (): Promise<void> => {
    if (!voucherId || !bankCrLine) return
    try {
      const r = await api.cheque.pdf(voucherId, bankCrLine.ledgerId)
      toast.push('success', `Cheque PDF: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const printAdvice = async (): Promise<void> => {
    if (!voucherId) return
    try {
      const r = await api.cheque.advice(voucherId)
      toast.push('success', `Payment advice: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="p-5">
      <div className="grid grid-cols-4 gap-3">
        <Field label="No." hint={voucherId || numberField.value === '…' ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={voucherId ? alterNumber : numberField.value === '…' ? '' : numberField.value}
            onChange={(e) => (voucherId ? setAlterNumber(e.target.value) : numberField.onChange(e.target.value))}
            placeholder="Auto"
            className="num"
          />
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <div className="col-span-2 flex items-end justify-end">
          <p className={`num text-[12.5px] ${balanced ? 'text-dr' : 'text-muted'}`}>
            Dr {formatPaise(totalDr)} · Cr {formatPaise(totalCr)}
            {!balanced && totalDr + totalCr > 0 && (
              <span className="text-cr"> · off by {formatPaise(Math.abs(totalDr - totalCr))}</span>
            )}
          </p>
        </div>
      </div>

      <table className="ledger-table mt-4">
        <thead>
          <tr>
            <th className="w-20">Dr / Cr</th>
            <th>Particulars</th>
            <th className="r w-44">Amount</th>
            {hasCc && <th className="w-16"></th>}
          </tr>
        </thead>
        <tbody data-testid="rows-voucher-lines">
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <button
                  className={`num w-12 rounded-md border border-line px-2 py-1 text-[12.5px] font-medium ${
                    r.drCr === 'dr' ? 'text-dr' : 'text-cr'
                  }`}
                  onClick={() => setRow(i, { drCr: r.drCr === 'dr' ? 'cr' : 'dr' })}
                  title="Toggle Dr/Cr"
                >
                  {r.drCr === 'dr' ? 'Dr' : 'Cr'}
                </button>
              </td>
              <td>
                <div className="flex items-center gap-1.5">
                  <LedgerPicker
                    value={r.ledgerId}
                    onPick={(id) => setRow(i, { ledgerId: id })}
                    autoFocus={i === 0 && !voucherId}
                    filter={
                      kind === 'contra'
                        ? (l, groups) => {
                            let g = groups.get(l.groupId)
                            while (g) {
                              if (['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(g.name)) return true
                              g = g.parentId ? groups.get(g.parentId) : undefined
                            }
                            return false
                          }
                        : undefined
                    }
                    onCreateRequest={(name) => setQuickLedger({ name, row: i })}
                    className="flex-1"
                  />
                  {(() => {
                    const rowLedger = r.ledgerId != null ? ledgers.find((l) => l.id === r.ledgerId) : null
                    return rowLedger && isPartyLedger(rowLedger, groupMap) ? (
                      <Button variant="ghost" className="shrink-0 px-2 py-1 text-[11px]" onClick={() => setEditingParty(rowLedger)}>
                        Edit
                      </Button>
                    ) : null
                  })()}
                </div>
              </td>
              <td className="r">
                <AmountInput
                  paise={r.amount}
                  onPaise={(p) => setRow(i, { amount: p })}
                />
              </td>
              {hasCc && (
                <td className="r">
                  {r.ledgerId != null && (
                    <button className="text-[11px] text-blue hover:underline" onClick={() => setCcModalRow(i)}>
                      CC{r.costAllocations.length ? ` (${r.costAllocations.length})` : ''}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          <tr className="total-row">
            <td></td>
            <td>Total</td>
            <td className="r">
              <span className="num">{formatPaise(Math.max(totalDr, totalCr))}</span>
            </td>
            {hasCc && <td></td>}
          </tr>
        </tbody>
      </table>

      {existing && existing.inventory.length > 0 && (
        <p className="mt-3 text-[12px] text-muted">
          This voucher carries {existing.inventory.length} stock line{existing.inventory.length > 1 ? 's' : ''}; they are kept as-is when you save.
        </p>
      )}

      {features.tds && tdsSuggestion && !tdsDismissed && (
        <div className="mt-3 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[12.5px] text-amber">
          <div className="flex items-center justify-between gap-3">
            <span>
              TDS u/s {tdsSuggestion.code}: deduct <Money paise={tdsSuggestion.tdsPaise} className="text-amber" />
              {!tdsSuggestion.panAvailable && <span className="ml-2 text-cr">PAN missing — 20% rate</span>}
              {!tdsSuggestion.thresholdCrossed && <span className="ml-2 text-muted">(below threshold — applying anyway is your call)</span>}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => setTdsDismissed(true)}>Dismiss</Button>
              <Button variant="primary" disabled={tdsApplyBlocked} onClick={applyTds}>
                Apply
              </Button>
            </div>
          </div>
          {tdsApplyBlocked && (
            <p className="mt-1.5 text-cr">
              Apply would unbalance: the {formatPaise(tdsTargetIdx === -1 ? 0 : (rows[tdsTargetIdx]?.amount ?? 0), { symbol: true })} line
              can&apos;t absorb {formatPaise(tdsSuggestion.tdsPaise, { symbol: true })} TDS — adjust lines manually.
            </p>
          )}
        </div>
      )}

      {showBillsSection && (
        <div className="mt-4 border-t border-line pt-3">
          <button
            className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"
            onClick={() => setBillsOpen((v) => !v)}
          >
            <span className="inline-block w-3 text-[10px]">{billsOpen ? '▾' : '▸'}</span>
            Bill allocation
            <span className="normal-case text-muted/80">
              {' '}
              · allocated {formatPaise(billAllocatedTotal)} / {formatPaise(partyLineTotal)}
            </span>
          </button>
          {billsOpen && (
            <div className="mt-2">
              {isCheckboxBills ? (
                (openBills ?? []).length === 0 ? (
                  <p className="text-[12px] text-muted">No open bills for this party.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {(openBills ?? []).map((b) => {
                      const ref = billRefs.find((r) => r.kind === 'against' && r.name === b.number)
                      return (
                        <div key={b.number} className="flex items-center gap-3 rounded-md px-1 py-1 text-[12.5px] hover:bg-panel2">
                          <input type="checkbox" checked={!!ref} onChange={(e) => toggleBill(b, e.target.checked)} />
                          <span className="flex-1">{b.number}</span>
                          <span className="num w-24 text-muted">{toDisplayDate(b.date)}</span>
                          <span className={`num w-24 ${b.overdueDays > 0 ? 'text-cr' : 'text-muted'}`}>
                            {b.dueDate ? toDisplayDate(b.dueDate) : '—'}
                          </span>
                          <Money paise={b.pending} className="w-24 text-right" />
                          {ref && (
                            <AmountInput paise={ref.amount} onPaise={(p) => setBillRefAmount(b.number, p ?? 0)} className="w-28" />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-1.5">
                  {billRefs.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Select
                        value={r.kind}
                        onChange={(e) => setManualBillRef(i, { kind: e.target.value as 'new' | 'against' })}
                        className="w-32"
                      >
                        <option value="new">New bill</option>
                        <option value="against">Against</option>
                      </Select>
                      <TextInput value={r.name} onChange={(e) => setManualBillRef(i, { name: e.target.value })} placeholder="Bill name" className="flex-1" />
                      <AmountInput paise={r.amount} onPaise={(p) => setManualBillRef(i, { amount: p ?? 0 })} className="w-28" />
                      <DateInput
                        value={r.dueDate ?? date}
                        context={date}
                        onChange={(d) => setManualBillRef(i, { dueDate: d })}
                        className="w-32"
                      />
                      <button className="text-[12px] text-cr" onClick={() => removeManualBillRef(i)}>
                        ×
                      </button>
                    </div>
                  ))}
                  <Button onClick={addManualBillRef} className="self-start">
                    + Add bill ref
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className={`mt-4 ${kind === 'payment' || kind === 'receipt' ? 'grid grid-cols-3 gap-3' : ''}`}>
        <div className={kind === 'payment' || kind === 'receipt' ? 'col-span-2' : ''}>
          <Field label="Narration">
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being amount paid…" />
          </Field>
        </div>
        {(kind === 'payment' || kind === 'receipt') && (
          <Field label="Cheque / UTR no." hint="Shows up in bank reconciliation">
            <TextInput value={instrumentNo} onChange={(e) => setInstrumentNo(e.target.value)} className="num" />
          </Field>
        )}
      </div>

      <div className="mt-5 flex justify-between">
        <div>{voucherId && <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>}</div>
        <div className="flex gap-2">
          {voucherId && kind === 'payment' && bankCrLine && (
            <>
              <Button onClick={() => void printCheque()}>Print cheque</Button>
              <Button onClick={() => void printAdvice()}>Payment advice</Button>
            </>
          )}
          {balanced && <Button onClick={() => setShowRecurring(true)}>Save as recurring…</Button>}
          <Button onClick={() => nav.back()}>Cancel</Button>
          <Button variant="primary" data-testid="btn-save-voucher" disabled={!balanced || saving} onClick={() => void save()}>
            {voucherId ? 'Save changes' : 'Save voucher'} ⌘↵
          </Button>
        </div>
      </div>

      {quickLedger && (
        <QuickLedgerModal
          name={quickLedger.name}
          suggestParty={null}
          suggestAccount={null}
          onClose={() => setQuickLedger(null)}
          onCreated={(l) => {
            setRow(quickLedger.row, { ledgerId: l.id })
            setQuickLedger(null)
          }}
        />
      )}
      {ccModalRow != null && (
        <CostAllocModal
          lineAmount={rows[ccModalRow]?.amount ?? 0}
          centres={ccList ?? []}
          initial={rows[ccModalRow]?.costAllocations ?? []}
          onClose={() => setCcModalRow(null)}
          onSave={(allocations) => setRow(ccModalRow, { costAllocations: allocations })}
        />
      )}
      {showRecurring && <SaveAsRecurringModal buildPayload={buildPayload} onClose={() => setShowRecurring(false)} />}
      {editingParty && <LedgerFormModal ledger={editingParty} onClose={() => setEditingParty(null)} />}
    </Panel>
  )
}

// ---------- "Save as recurring…" modal (AccountingEntry + InvoiceEntry) ----------

const RECURRING_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Serializes the CURRENT form state (via `buildPayload`, the same helper the Save button uses)
 *  into a recurring template. Does NOT save the voucher itself. */
function SaveAsRecurringModal({
  buildPayload,
  onClose
}: {
  buildPayload: () => VoucherInputParsed | null | Promise<VoucherInputParsed | null>
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const today = todayISO()
  const todayDay = Number(today.slice(8, 10))
  const todayWeekday = new Date(today + 'T00:00:00Z').getUTCDay()
  const [name, setName] = useState('')
  const [cadence, setCadence] = useState<'monthly' | 'weekly'>('monthly')
  const [dayOfMonth, setDayOfMonth] = useState(todayDay)
  const [weekday, setWeekday] = useState(todayWeekday)
  const [nextDue, setNextDue] = useState(() => nextDueAfter('monthly', { dayOfMonth: todayDay }, today))
  const [saving, setSaving] = useState(false)

  const changeCadence = (next: 'monthly' | 'weekly'): void => {
    setCadence(next)
    setNextDue(
      next === 'monthly'
        ? nextDueAfter('monthly', { dayOfMonth }, today)
        : nextDueAfter('weekly', { weekday }, today)
    )
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) return void toast.push('error', 'Name is required')
    setSaving(true)
    try {
      const payload = await buildPayload()
      if (!payload) {
        toast.push('error', 'Finish the voucher (balanced lines / party & items) before saving it as recurring')
        return
      }
      await api.recurring.save({
        name: name.trim(),
        voucherJson: JSON.stringify(payload),
        cadence,
        dayOfMonth: cadence === 'monthly' ? dayOfMonth : undefined,
        weekday: cadence === 'weekly' ? weekday : undefined,
        nextDue,
        active: true
      })
      await queryClient.invalidateQueries()
      toast.push('success', `Recurring template "${name.trim()}" saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Save as recurring…" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="e.g. “Monthly office rent”">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cadence">
            <Select value={cadence} onChange={(e) => changeCadence(e.target.value as 'monthly' | 'weekly')}>
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </Select>
          </Field>
          {cadence === 'monthly' ? (
            <Field label="Day of month" hint="Clamped to shorter months">
              <TextInput
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => {
                  const d = Math.max(1, Math.min(31, Number(e.target.value) || 1))
                  setDayOfMonth(d)
                  setNextDue(nextDueAfter('monthly', { dayOfMonth: d }, today))
                }}
                className="num"
              />
            </Field>
          ) : (
            <Field label="Weekday">
              <Select
                value={weekday}
                onChange={(e) => {
                  const w = Number(e.target.value)
                  setWeekday(w)
                  setNextDue(nextDueAfter('weekly', { weekday: w }, today))
                }}
              >
                {RECURRING_WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label="First due">
          <DateInput value={nextDue} context={nextDue} onChange={setNextDue} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            Save template
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- per-line cost-centre allocation modal ----------

function CostAllocModal({
  lineAmount,
  centres,
  initial,
  onClose,
  onSave
}: {
  lineAmount: number
  centres: CostCentre[]
  initial: { costCentreId: number; amount: number }[]
  onClose: () => void
  onSave: (allocations: { costCentreId: number; amount: number }[]) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<{ costCentreId: number | null; amount: number | null }[]>(
    initial.length ? initial.map((a) => ({ costCentreId: a.costCentreId, amount: a.amount })) : [{ costCentreId: null, amount: null }]
  )

  const setRow = (i: number, patch: Partial<{ costCentreId: number | null; amount: number | null }>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.costCentreId != null) next.push({ costCentreId: null, amount: null })
      return next
    })
  }
  const removeRow = (i: number): void => setRows((rs) => rs.filter((_, j) => j !== i))

  const allocated = rows.reduce((s, r) => s + (r.amount ?? 0), 0)
  const remaining = lineAmount - allocated

  return (
    <Modal title="Cost centre allocation" onClose={onClose}>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select
              value={r.costCentreId ?? ''}
              onChange={(e) => setRow(i, { costCentreId: e.target.value ? Number(e.target.value) : null })}
              className="flex-1"
            >
              <option value="">— cost centre —</option>
              {centres.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <AmountInput paise={r.amount} onPaise={(p) => setRow(i, { amount: p })} className="w-32" />
            {i < rows.length - 1 && (
              <button className="text-[12px] text-cr" onClick={() => removeRow(i)}>
                ×
              </button>
            )}
          </div>
        ))}
        <p className={`text-[12px] ${remaining === 0 ? 'text-muted' : remaining < 0 ? 'text-cr' : 'text-amber'}`}>
          Allocated {formatPaise(allocated)} of {formatPaise(lineAmount)}
          {remaining !== 0 ? ` — ${formatPaise(Math.abs(remaining))} ${remaining > 0 ? 'remaining' : 'over'}` : ''}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(
                rows
                  .filter((r): r is { costCentreId: number; amount: number } => r.costCentreId != null && (r.amount ?? 0) > 0)
                  .map((r) => ({ costCentreId: r.costCentreId, amount: r.amount! }))
              )
              onClose()
            }}
          >
            Save allocation
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------- quick-create modals ----------

export function QuickLedgerModal({
  name,
  suggestParty,
  suggestAccount,
  onClose,
  onCreated
}: {
  name: string
  /** true → Sundry Debtors, false → Sundry Creditors, null → no preselect */
  suggestParty: boolean | null
  suggestAccount: boolean | null
  onClose: () => void
  onCreated: (ledger: Ledger) => void
}): React.JSX.Element {
  const groups = useGroups()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const defaultGroup =
    suggestParty != null
      ? groups.find((g) => g.name === (suggestParty ? 'Sundry Debtors' : 'Sundry Creditors'))
      : suggestAccount != null
        ? groups.find((g) => g.name === (suggestAccount ? 'Sales Accounts' : 'Purchase Accounts'))
        : null
  const [ledgerName, setLedgerName] = useState(name)
  const [groupId, setGroupId] = useState<number | null>(defaultGroup?.id ?? null)
  useEffect(() => {
    if (groupId == null && defaultGroup) setGroupId(defaultGroup.id)
  }, [defaultGroup, groupId])
  const [gstin, setGstin] = useState('')
  const [gstRate, setGstRate] = useState('')

  const ancestry = useMemo(() => (groupId != null ? groupAncestryNames(groupId, groups) : []), [groupId, groups])
  const isParty = ancestry.some((n) => PARTY_GROUPS.includes(n))
  const isTradingLedger = !isParty && ancestry.some((n) => TRADING_GROUPS.includes(n))

  const create = async (): Promise<void> => {
    try {
      if (!groupId) return void toast.push('error', 'Pick a group')
      const l = await api.ledgers.create({
        name: ledgerName.trim(),
        groupId,
        openingBalance: 0,
        gstin: isParty && gstin.trim() ? gstin.trim().toUpperCase() : null,
        stateCode: isParty && gstin.trim().length >= 2 ? gstin.trim().slice(0, 2) : null,
        address: null,
        taxType: null,
        gstRate: isTradingLedger && gstRate.trim() ? Number(gstRate) : null,
        hsn: null,
        tdsSectionId: null,
        pan: null,
        creditDays: null,
        exportType: null
      })
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
      toast.push('success', `Ledger “${l.name}” created`)
      onCreated(l)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="New ledger" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={ledgerName} onChange={(e) => setLedgerName(e.target.value)} />
        </Field>
        <Field label="Under group">
          <Select value={groupId ?? ''} onChange={(e) => setGroupId(Number(e.target.value))}>
            <option value="" disabled>
              Choose…
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        {(isParty || isTradingLedger) && (
          <div className="grid grid-cols-2 gap-3">
            {isParty && (
              <Field label="GSTIN">
                <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className="num" placeholder="Optional" />
              </Field>
            )}
            {isTradingLedger && (
              <Field label="GST rate %">
                <TextInput value={gstRate} onChange={(e) => setGstRate(e.target.value)} className="num" placeholder="Optional" />
              </Field>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>
            Create ledger
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function QuickItemModal({
  name,
  onClose,
  onCreated
}: {
  name: string
  onClose: () => void
  onCreated: (id: number) => void
}): React.JSX.Element {
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [itemName, setItemName] = useState(name)
  const [unitId, setUnitId] = useState<number | null>(null)
  const [hsn, setHsn] = useState('')
  const [rate, setRate] = useState('18')

  useEffect(() => {
    if (unitId == null && units?.length) setUnitId(units[0]!.id)
  }, [units, unitId])

  const create = async (): Promise<void> => {
    try {
      if (!unitId) return void toast.push('error', 'Pick a unit')
      const item = await api.stockItems.create({
        name: itemName.trim(),
        groupId: null,
        unitId,
        hsn: hsn.trim() || null,
        gstRate: rate.trim() ? Number(rate) : null,
        cessRate: null,
        openingQtyMilli: 0,
        openingValue: 0,
        barcode: null,
        reorderLevelMilli: null
      })
      await queryClient.invalidateQueries({ queryKey: ['stockItems'] })
      toast.push('success', `Item “${item.name}” created`)
      onCreated(item.id)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="New stock item" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={itemName} onChange={(e) => setItemName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Unit">
            <Select value={unitId ?? ''} onChange={(e) => setUnitId(Number(e.target.value))}>
              {(units ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.symbol}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="HSN">
            <TextInput value={hsn} onChange={(e) => setHsn(e.target.value)} className="num" placeholder="8471" />
          </Field>
          <Field label="GST %">
            <TextInput value={rate} onChange={(e) => setRate(e.target.value)} className="num" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>
            Create item
          </Button>
        </div>
      </div>
    </Modal>
  )
}
