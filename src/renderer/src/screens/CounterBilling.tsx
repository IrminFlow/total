import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { computeInvoice, emptyInvoiceState, type InvoiceContext } from '@shared/voucherEdit'
import { supplyTypeFor } from '@shared/gst/calc'
import { formatPaise, parseRupees, roundPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, type CounterConfig, type PaymentMode } from '@shared/pricingSchemas'
import { api } from '../lib/client'
import { counterApi, type CheckoutResult, type DayEndSummary, type HeldBill } from '../lib/pricingClient'
import { useSession, useToasts } from '../state/stores'
import {
  Banner, Button, Checkbox, DateInput, DrawerSection, Field, isAnyModalOpen, Kbd, Modal, Money, Page, PageHeader, Panel, Select, inputCls
} from '../components/ui'
import { StatGrid, StatTile } from '../components/kit'
import { DataTable, defineColumns } from '../components/table'
import { LedgerPicker, useGroups, useLedgers, useStockItems } from '../components/pickers'
import { VoucherLink } from '../components/links'
import { confirmDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { isBankLedger, isCashOrBankLedger, isPartyLedger, nextLineKey } from './voucher/hooks'
import { PriceHint, useLinePricing, type RowPricing } from './voucher/useLinePricing'
import { PricingOptions } from './voucher/PricingOptions'

// ---------- Counter billing (WP 2.6) ----------
// A POS-style sales screen. The search / barcode box keeps the focus: typing filters items,
// Enter (or a scanner's Enter) adds the item — or adds one more of it — and "3*" before a scan
// sells three. With the box empty: ↑/↓ pick a line, ←/→ pick its Qty / Rate / Disc. cell, Enter
// edits that cell, +/− change the quantity, Delete removes the line. F2 party, F3 hold, F4
// recall, F5/F6/F7 pay cash / UPI / card, F9 (or ⌘↵) completes the sale, F10 day end.
// Completing posts a normal sales invoice and a receipt against it (services/counter.ts), then
// prints the bill with the counter's template (the 80 mm receipt by default).

interface Line {
  key: number
  itemId: number
  qtyText: string
  rate: number | null
  discount: number | null
  pricing?: RowPricing
}

type Field3 = 'qty' | 'rate' | 'disc'
const FIELDS: Field3[] = ['qty', 'rate', 'disc']
const FIELD_LABEL: Record<Field3, string> = { qty: 'Qty', rate: 'Rate', disc: 'Disc.' }

const qtyMilliOf = (t: string): number => {
  const q = Math.round(parseFloat(t || '0') * 1000)
  return Number.isFinite(q) && q > 0 ? q : 0
}
const qtyTextOf = (milli: number): string => String(milli / 1000)

/** "3*890100000001" → { qty: 3000, code: '890100000001' }; "3*" → a pending multiplier. */
export function parseScan(text: string): { qtyMilli: number | null; code: string } {
  const m = text.match(/^\s*(\d+(?:\.\d+)?)\s*\*\s*(.*)$/)
  if (!m) return { qtyMilli: null, code: text.trim() }
  const q = Math.round(Number(m[1]) * 1000)
  return { qtyMilli: q > 0 ? q : null, code: m[2]!.trim() }
}

/** A discount typed as "10%" (of the line's gross) or as rupees. */
export function parseDiscount(text: string, gross: number): number | null {
  const t = text.trim()
  if (t === '') return null
  if (t.endsWith('%')) {
    const pct = Number(t.slice(0, -1))
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null
    return roundPaise((gross * pct) / 100)
  }
  const p = parseRupees(t)
  return p != null && p >= 0 ? Math.min(p, gross) : null
}

interface Pay {
  cash: string
  upi: string
  card: string
  tendered: string
}
const NO_PAY: Pay = { cash: '', upi: '', card: '', tendered: '' }
const payPaise = (s: string): number => parseRupees(s) ?? 0

export function CounterBillingScreen(): React.JSX.Element {
  const { info, workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const ledgers = useLedgers()
  const groups = useGroups()
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const byBarcode = useMemo(() => new Map(items.filter((i) => i.barcode).map((i) => [i.barcode!.toLowerCase(), i])), [items])
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const unitOf = (itemId: number): string => units?.find((u) => u.id === itemMap.get(itemId)?.unitId)?.symbol ?? ''
  const { data: counterCfg } = useQuery({ queryKey: ['counterConfig'], queryFn: counterApi.config })
  const accounts = counterCfg?.accounts
  const config = counterCfg?.config

  const [date, setDate] = useState(workingDate)
  const [lines, setLines] = useState<Line[]>([])
  const [active, setActive] = useState(0)
  const [field, setField] = useState<Field3>('qty')
  const [editing, setEditing] = useState<{ key: number; field: Field3; text: string } | null>(null)
  const [partyId, setPartyId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [suggest, setSuggest] = useState(0)
  const [multiplier, setMultiplier] = useState<number | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [pay, setPay] = useState<Pay>(NO_PAY)
  const [busy, setBusy] = useState(false)
  const [lastSale, setLastSale] = useState<CheckoutResult | null>(null)
  const [modal, setModal] = useState<'party' | 'held' | 'dayEnd' | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const payRefs = useRef<Record<PaymentMode | 'tendered', HTMLInputElement | null>>({ cash: null, upi: null, card: null, tendered: null })
  // Latency of the last scan: keydown → the line on screen with its price. Written straight onto
  // the screen root (data-scan-ms + a data-scan-seq counter) in a layout effect — i.e. in the
  // same commit that first shows the priced line — so a driver that sees the rate also sees its
  // sample (e2e 29); the footer shows it via state.
  const scanStart = useRef<{ key: number; at: number } | null>(null)
  const scanSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const [scanMs, setScanMs] = useState<number | null>(null)

  const party = partyId != null ? (ledgers.find((l) => l.id === partyId) ?? null) : null
  const walkInName = ledgers.find((l) => l.id === accounts?.walkInLedgerId)?.name ?? 'Cash sale'
  const supply = supplyTypeFor(info!.stateCode, party?.stateCode ?? info!.stateCode)

  useUnsavedGuard(lines.length > 0)
  useEffect(() => setWorkingDate(date), [date, setWorkingDate])

  // ---------- pricing (the grid's resolver hook) ----------
  const pricingCtx = useMemo(
    () => ({ enabled: true, autoApply: true, partyId: partyId ?? accounts?.walkInLedgerId ?? null, date, supply, currency: '' }),
    [partyId, accounts?.walkInLedgerId, date, supply]
  )
  const { resetRow } = useLinePricing(lines, setLines, pricingCtx)

  useLayoutEffect(() => {
    const s = scanStart.current
    if (!s) return
    const line = lines.find((l) => l.key === s.key)
    if (line && line.rate != null) {
      scanStart.current = null
      const ms = Math.round((performance.now() - s.at) * 10) / 10
      const el = rootRef.current
      if (el) {
        el.dataset.scanMs = String(ms)
        el.dataset.scanSeq = String(++scanSeq.current)
      }
      setScanMs(Math.round(ms))
    }
  }, [lines])

  // ---------- totals (the exact invoice math the server will post) ----------
  const ctx: InvoiceContext = useMemo(
    () => ({
      kind: 'sales',
      companyStateCode: info!.stateCode,
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
    }),
    [info, items, ledgers]
  )
  const computed = useMemo(
    () =>
      computeInvoice(
        {
          ...emptyInvoiceState(date),
          partyId: partyId ?? accounts?.walkInLedgerId ?? -1,
          accountId: accounts?.salesLedgerId ?? -2,
          rows: lines.map((l) => ({ itemId: l.itemId, qtyText: l.qtyText, rate: l.rate, discount: l.discount, godownId: null, batchId: null }))
        },
        ctx
      ),
    [lines, ctx, date, partyId, accounts]
  )
  const total = computed.rounded
  const paid = PAYMENT_MODES.reduce((s, m) => s + payPaise(pay[m]), 0)
  const cashPaid = payPaise(pay.cash)
  const tendered = pay.tendered.trim() ? payPaise(pay.tendered) : cashPaid
  const change = Math.max(0, tendered - cashPaid)
  const remaining = total - paid
  const walkIn = partyId == null
  const payIssue =
    lines.length === 0
      ? 'Scan or pick an item first'
      : lines.some((l) => l.rate == null)
        ? 'A line has no rate'
        : paid > total
          ? 'Payments exceed the bill'
          : walkIn && paid !== total
            ? `${formatPaise(remaining, { symbol: true })} still to pay (a walk-in sale is paid in full)`
            : tendered < cashPaid
              ? 'Cash tendered is less than the cash payment'
              : null

  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [])
  useEffect(() => {
    if (!editing && !payOpen && !modal) focusSearch()
  }, [editing, payOpen, modal, lastSale, focusSearch])

  // ---------- item search ----------
  const scan = parseScan(search)
  const query = scan.code.toLowerCase()
  const suggestions = useMemo(() => {
    if (!query) return []
    const exact = byBarcode.get(query)
    const hits = items.filter((i) => i.name.toLowerCase().includes(query) || (i.barcode ?? '').toLowerCase().includes(query))
    if (exact) return [exact, ...hits.filter((i) => i.id !== exact.id)].slice(0, 8)
    return hits.slice(0, 8)
  }, [query, items, byBarcode])

  const addItem = (itemId: number, qtyMilli: number): void => {
    setLastSale(null)
    const at = performance.now()
    // The same item again (and the user hasn't edited that line by hand): one more of it.
    const i = lines.findIndex((l) => l.itemId === itemId && l.pricing?.source !== 'manual')
    if (i >= 0) {
      const key = lines[i]!.key
      scanStart.current = { key, at }
      setLines((ls) => ls.map((l) => (l.key === key ? { ...l, qtyText: qtyTextOf(qtyMilliOf(l.qtyText) + qtyMilli) } : l)))
      setActive(i)
    } else {
      const key = nextLineKey()
      scanStart.current = { key, at }
      setLines((ls) => [...ls, { key, itemId, qtyText: qtyTextOf(qtyMilli), rate: null, discount: null }])
      setActive(lines.length)
    }
    setField('qty')
    setSearch('')
    setSuggest(0)
    setMultiplier(null)
  }

  const commitSearch = (): void => {
    const { qtyMilli, code } = scan
    if (!code) {
      if (qtyMilli) {
        setMultiplier(qtyMilli)
        setSearch('')
      }
      return
    }
    const qty = qtyMilli ?? multiplier ?? 1000
    const hit = byBarcode.get(code.toLowerCase()) ?? suggestions[suggest]
    if (!hit) return void toast.push('warning', `No item matches “${code}”`)
    addItem(hit.id, qty)
  }

  const bump = (delta: number): void => {
    const l = lines[active]
    if (!l) return
    const q = Math.max(1000, qtyMilliOf(l.qtyText) + delta * 1000)
    setLines((ls) => ls.map((x, j) => (j === active ? { ...x, qtyText: qtyTextOf(q) } : x)))
  }
  const removeActive = (): void => {
    setLines((ls) => ls.filter((_l, j) => j !== active))
    setActive((a) => Math.max(0, Math.min(a, lines.length - 2)))
  }

  const startEdit = (f: Field3 = field): void => {
    const l = lines[active]
    if (!l) return
    const text = f === 'qty' ? l.qtyText : f === 'rate' ? (l.rate != null ? formatPaise(l.rate) : '') : l.discount ? formatPaise(l.discount) : ''
    setEditing({ key: l.key, field: f, text })
  }
  const commitEdit = (): void => {
    if (!editing) return
    const { key, field: f, text } = editing
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l
        if (f === 'qty') {
          const q = qtyMilliOf(text)
          return q > 0 ? { ...l, qtyText: qtyTextOf(q) } : l
        }
        if (f === 'rate') {
          const p = parseRupees(text)
          if (text.trim() === '') return { ...l, rate: null, discount: null, pricing: undefined } // back to the price list
          return p != null && p >= 0 ? { ...l, rate: p, pricing: { source: 'manual' } } : l
        }
        const gross = Math.round((qtyMilliOf(l.qtyText) * (l.rate ?? 0)) / 1000)
        const d = parseDiscount(text, gross)
        return text.trim() === '' ? { ...l, discount: null, pricing: { source: 'manual' } } : d != null ? { ...l, discount: d || null, pricing: { source: 'manual' } } : l
      })
    )
    setEditing(null)
  }

  // ---------- payment ----------
  const openPay = (mode: PaymentMode): void => {
    if (lines.length === 0) return void toast.push('warning', 'Scan or pick an item first')
    setPayOpen(true)
    setPay((p) => {
      const others = PAYMENT_MODES.filter((m) => m !== mode).reduce((s, m) => s + payPaise(p[m]), 0)
      const rest = Math.max(0, total - others)
      return { ...p, [mode]: rest ? formatPaise(rest) : '' }
    })
    requestAnimationFrame(() => {
      payRefs.current[mode]?.focus()
      payRefs.current[mode]?.select()
    })
  }

  const reset = (): void => {
    setLines([])
    setActive(0)
    setPartyId(null)
    setPay(NO_PAY)
    setPayOpen(false)
    setMultiplier(null)
    setEditing(null)
  }

  const checkout = async (): Promise<void> => {
    if (busy) return
    if (payIssue) return void toast.push('error', payIssue)
    setBusy(true)
    try {
      const result = await counterApi.checkout({
        date,
        partyLedgerId: partyId,
        lines: lines.map((l) => ({ itemId: l.itemId, qtyMilli: qtyMilliOf(l.qtyText), ratePaise: l.rate!, discountPaise: l.discount ?? 0 })),
        payments: PAYMENT_MODES.filter((m) => payPaise(pay[m]) > 0).map((m) => ({ mode: m, amountPaise: payPaise(pay[m]) })),
        tenderedPaise: cashPaid > 0 ? tendered : 0
      })
      setLastSale(result)
      reset()
      toast.push('success', `Bill ${result.invoiceNumber} saved — ${formatPaise(result.totalPaise, { symbol: true })}${result.changePaise ? ` · change ${formatPaise(result.changePaise, { symbol: true })}` : ''}`)
      if (result.negativeStock.length) toast.push('warning', `Stock below zero: ${result.negativeStock.map((n) => n.name).join(', ')}`)
      await queryClient.invalidateQueries({ queryKey: ['counterDayEnd'] })
      await queryClient.invalidateQueries({ queryKey: ['nextNumber'] })
      if (config?.autoPrint) void print(result.invoiceId, config.templateId)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const print = async (voucherId: number, templateId: string): Promise<void> => {
    try {
      await counterApi.print(voucherId, templateId)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  // ---------- hold / recall ----------
  const hold = async (): Promise<void> => {
    if (lines.length === 0) return
    try {
      const bill = await counterApi.hold({
        label: party?.name ?? '',
        partyLedgerId: partyId,
        lines: lines.map((l) => ({ itemId: l.itemId, qtyMilli: qtyMilliOf(l.qtyText), ratePaise: l.rate ?? 0, discountPaise: l.discount ?? 0, rateSource: l.pricing?.source === 'manual' ? 'manual' : 'auto' }))
      })
      reset()
      await queryClient.invalidateQueries({ queryKey: ['counterHeld'] })
      toast.push('success', `${bill.label} on hold — F4 to recall`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const recall = async (bill: HeldBill): Promise<void> => {
    if (lines.length > 0 && !(await confirmDialog({ title: 'Recall bill', message: 'Replace the bill on screen with the held one? (Hold this one first to keep it.)', confirmLabel: 'Replace' }))) return
    try {
      const b = await counterApi.recall(bill.id)
      setLines(b.lines.map((l) => ({
        key: nextLineKey(), itemId: l.itemId, qtyText: qtyTextOf(l.qtyMilli),
        // Auto lines re-price (the date may have moved); hand-typed ones keep their figures.
        ...(l.rateSource === 'manual' ? { rate: l.ratePaise, discount: l.discountPaise || null, pricing: { source: 'manual' as const } } : { rate: null, discount: null })
      })))
      setPartyId(b.partyLedgerId)
      setActive(0)
      setModal(null)
      await queryClient.invalidateQueries({ queryKey: ['counterHeld'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  // ---------- keyboard ----------
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const empty = search.trim() === ''
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      return void checkout()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!empty) commitSearch()
      else if (lines.length > 0) startEdit()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      if (!empty && suggestions.length > 0) setSuggest((s) => Math.max(0, Math.min(suggestions.length - 1, s + d)))
      else setActive((a) => Math.max(0, Math.min(lines.length - 1, a + d)))
      return
    }
    if (empty && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      setField((f) => FIELDS[(FIELDS.indexOf(f) + (e.key === 'ArrowRight' ? 1 : FIELDS.length - 1)) % FIELDS.length]!)
      return
    }
    if (empty && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
      e.preventDefault()
      return bump(e.key === '+' || e.key === '=' ? 1 : -1)
    }
    if (empty && (e.key === 'Delete' || e.key === 'Backspace') && lines.length > 0) {
      e.preventDefault()
      return removeActive()
    }
    if (e.key === 'Escape') {
      if (!empty || multiplier != null) {
        e.preventDefault()
        e.stopPropagation()
        setSearch('')
        setMultiplier(null)
      }
    }
  }

  const fkeys = useRef<(e: KeyboardEvent) => void>(() => {})
  fkeys.current = (e: KeyboardEvent): void => {
    if (isAnyModalOpen() || busy) return
    const k = e.key
    const handled = ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F9', 'F10'].includes(k)
    if (!handled) {
      if (payOpen && k === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setPayOpen(false)
      }
      return
    }
    e.preventDefault()
    if (k === 'F2') setModal('party')
    else if (k === 'F3') void hold()
    else if (k === 'F4') setModal('held')
    else if (k === 'F5') openPay('cash')
    else if (k === 'F6') openPay('upi')
    else if (k === 'F7') openPay('card')
    else if (k === 'F9') {
      if (!payOpen && !partyId) openPay('cash')
      else void checkout()
    } else if (k === 'F10') setModal('dayEnd')
  }
  useEffect(() => {
    const on = (e: KeyboardEvent): void => fkeys.current(e)
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [])

  // ---------- render ----------
  const nextNo = useQuery({
    queryKey: ['nextNumber', accounts?.voucherTypeId, date],
    queryFn: () => api.vouchers.nextNumber(accounts!.voucherTypeId!, date),
    enabled: !!accounts?.voucherTypeId
  }).data?.number

  return (
    <Page width="wide">
      <PageHeader
        title="Counter billing"
        subtitle={
          <span className="flex items-center gap-2">
            <span>
              Bill <b className="num" data-testid="counter-next-number">{nextNo ?? '…'}</b>
            </span>
            <span className="text-muted">·</span>
            <button type="button" className="text-blue hover:underline" data-testid="btn-counter-party" onClick={() => setModal('party')}>
              {party ? party.name : `${walkInName} (walk-in)`} <Kbd>F2</Kbd>
            </button>
          </span>
        }
        controls={<DateInput value={date} context={workingDate} onChange={setDate} className="w-32" testId="input-counter-date" ariaLabel="Bill date" />}
        secondary={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" data-testid="btn-counter-hold" onClick={() => void hold()} disabled={lines.length === 0}>
              Hold <Kbd>F3</Kbd>
            </Button>
            <Button size="sm" variant="ghost" data-testid="btn-counter-recall" onClick={() => setModal('held')}>
              Recall <Kbd>F4</Kbd>
            </Button>
            <Button size="sm" variant="ghost" data-testid="btn-counter-day-end" onClick={() => setModal('dayEnd')}>
              Day end <Kbd>F10</Kbd>
            </Button>
          </div>
        }
        options={{ content: <CounterOptions config={config} /> }}
      />
      {lastSale && (
        <Banner tone="success" className="mb-section" onDismiss={() => setLastSale(null)} testId="counter-last-sale">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Saved <VoucherLink voucherId={lastSale.invoiceId} label={lastSale.invoiceNumber} />
              {lastSale.receiptId && (
                <>
                  {' '}+ receipt <VoucherLink voucherId={lastSale.receiptId} label={lastSale.receiptNumber ?? ''} />
                </>
              )}{' '}
              — {formatPaise(lastSale.totalPaise, { symbol: true })}
            </span>
            {lastSale.changePaise > 0 && (
              <b data-testid="counter-change">Change {formatPaise(lastSale.changePaise, { symbol: true })}</b>
            )}
            {lastSale.balancePaise > 0 && <span>{formatPaise(lastSale.balancePaise, { symbol: true })} on account</span>}
            <button type="button" className="text-blue hover:underline" data-testid="btn-counter-print" onClick={() => void print(lastSale.invoiceId, config?.templateId ?? 'receipt-80mm')}>
              Print again
            </button>
            <button type="button" className="text-blue hover:underline" data-testid="btn-counter-print-a4" onClick={() => void print(lastSale.invoiceId, 'classic')}>
              A4 invoice
            </button>
          </span>
        </Banner>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_22rem] gap-section" data-testid="counter-billing" ref={rootRef}>
        <Panel className="flex min-h-[28rem] flex-col p-panel">
          <div className="relative">
            <input
              ref={searchRef}
              className={`${inputCls} h-12 text-lead`}
              data-testid="input-counter-search"
              aria-label="Scan a barcode or type an item"
              placeholder={multiplier ? `× ${multiplier / 1000} — scan or type the item` : 'Scan a barcode or type an item  (3* then scan = three)'}
              value={search}
              autoFocus
              onChange={(e) => {
                setSearch(e.target.value)
                setSuggest(0)
              }}
              onKeyDown={onSearchKey}
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls="counter-suggestions"
              autoComplete="off"
            />
            {multiplier != null && (
              <span className="absolute top-1/2 right-3 -translate-y-1/2 rounded bg-amberbar/20 px-2 text-small font-semibold text-amber" data-testid="counter-multiplier">
                × {multiplier / 1000}
              </span>
            )}
            {suggestions.length > 0 && (
              <div id="counter-suggestions" role="listbox" className="absolute top-full right-0 left-0 z-30 mt-1 rounded-md border border-line bg-raised shadow-elev-2">
                {suggestions.map((s, i) => (
                  <div
                    key={s.id}
                    role="option"
                    aria-selected={i === suggest}
                    data-active={i === suggest}
                    className="kbar-row flex cursor-pointer justify-between px-3 py-1.5"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      addItem(s.id, scan.qtyMilli ?? multiplier ?? 1000)
                    }}
                  >
                    <span className="text-detail">{s.name}</span>
                    <span className="num text-caption text-muted">{s.barcode ?? ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <table className="ledger-table mt-3" data-testid="counter-lines">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>Item</th>
                {FIELDS.map((f) => (
                  <th key={f} className={`r ${f === 'qty' ? 'w-24' : 'w-32'}`}>
                    {FIELD_LABEL[f]}
                  </th>
                ))}
                <th className="r w-20">GST</th>
                <th className="r w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const it = itemMap.get(l.itemId)
                const q = qtyMilliOf(l.qtyText)
                const amount = l.rate != null ? Math.max(0, Math.round((q * l.rate) / 1000) - (l.discount ?? 0)) : 0
                const isActive = i === active
                const cell = (f: Field3, content: React.ReactNode): React.ReactNode => {
                  const on = isActive && field === f
                  if (editing && editing.key === l.key && editing.field === f) {
                    return (
                      <td className="r">
                        <input
                          autoFocus
                          className={`${inputCls} num text-right`}
                          data-testid={`input-counter-edit-${f}`}
                          aria-label={`${FIELD_LABEL[f]} of ${it?.name ?? 'line'}`}
                          value={editing.text}
                          placeholder={f === 'disc' ? '10% or ₹' : undefined}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Tab') {
                              e.preventDefault()
                              commitEdit()
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              e.stopPropagation()
                              setEditing(null)
                            }
                          }}
                        />
                      </td>
                    )
                  }
                  return (
                    <td
                      className={`r num ${on ? 'outline outline-2 -outline-offset-2 outline-amber' : ''}`}
                      data-testid={`counter-cell-${f}`}
                      onClick={() => {
                        setActive(i)
                        setField(f)
                        setEditing(null)
                        focusSearch()
                      }}
                      onDoubleClick={() => {
                        setActive(i)
                        setField(f)
                        startEditAt(i, f)
                      }}
                    >
                      {content}
                    </td>
                  )
                }
                const startEditAt = (row: number, f: Field3): void => {
                  const x = lines[row]
                  if (!x) return
                  setEditing({ key: x.key, field: f, text: f === 'qty' ? x.qtyText : f === 'rate' ? (x.rate != null ? formatPaise(x.rate) : '') : x.discount ? formatPaise(x.discount) : '' })
                }
                return (
                  <tr key={l.key} className="kbar-row" data-active={isActive} data-testid="counter-line" data-item-id={l.itemId}>
                    <td className="num text-muted">{i + 1}</td>
                    <td>
                      <div className="text-body">{it?.name ?? ''}</div>
                      <PriceHint pricing={l.pricing} onReset={() => resetRow(l.key)} />
                    </td>
                    {cell('qty', <>{l.qtyText} <span className="text-caption text-muted">{unitOf(l.itemId)}</span></>)}
                    {cell('rate', l.rate != null ? formatPaise(l.rate) : <span className="text-muted">…</span>)}
                    {cell('disc', l.discount ? formatPaise(l.discount) : <span className="text-muted">–</span>)}
                    <td className="r num text-muted">{it?.gstRate != null ? `${it.gstRate}%` : '—'}</td>
                    <td className="r" data-testid="counter-line-amount">
                      <Money paise={amount} className="text-body" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {lines.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center text-muted" data-testid="counter-empty">
              <p className="text-lead text-ink">Scan the first item</p>
              <p className="text-body-sm">
                Type a name or barcode and press <Kbd>↵</Kbd>. <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> pick a line · <Kbd>←</Kbd>
                <Kbd>→</Kbd> pick a cell · <Kbd>↵</Kbd> edit it · <Kbd>+</Kbd>
                <Kbd>−</Kbd> quantity · <Kbd>Del</Kbd> remove
              </p>
            </div>
          )}
          <p className="mt-auto pt-3 text-hint text-muted" data-testid="counter-keys">
            <Kbd>F2</Kbd> party · <Kbd>F3</Kbd> hold · <Kbd>F4</Kbd> recall · <Kbd>F5</Kbd> cash · <Kbd>F6</Kbd> UPI · <Kbd>F7</Kbd> card ·{' '}
            <Kbd>F9</Kbd> complete · <Kbd>F10</Kbd> day end
            {scanMs != null && <span className="ml-2 num">last scan {scanMs} ms</span>}
          </p>
        </Panel>

        <div className="flex flex-col gap-section">
          <Panel className="p-panel" data-testid="counter-totals">
            <div className="num flex flex-col gap-1 text-detail">
              <SumRow label={`${lines.length} line${lines.length === 1 ? '' : 's'} · taxable`} paise={computed.gst.taxable} />
              {computed.gst.cgst > 0 && <SumRow label="CGST" paise={computed.gst.cgst} />}
              {computed.gst.sgst > 0 && <SumRow label="SGST" paise={computed.gst.sgst} />}
              {computed.gst.igst > 0 && <SumRow label="IGST" paise={computed.gst.igst} />}
              {computed.gst.cess > 0 && <SumRow label="Cess" paise={computed.gst.cess} />}
              {computed.roundDiff !== 0 && <SumRow label="Round off" paise={computed.roundDiff} />}
            </div>
            <div className="mt-3 flex items-baseline justify-between border-t border-ink pt-2">
              <span className="text-subtitle font-semibold">Total</span>
              <span className="num text-display font-semibold" data-testid="counter-total">
                {formatPaise(total, { symbol: true })}
              </span>
            </div>
          </Panel>

          <Panel className="p-panel" data-testid="counter-payment">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-caption font-semibold tracking-[0.08em] text-muted uppercase">Payment</h2>
              {!payOpen && (
                <Button size="sm" variant="primary" data-testid="btn-counter-pay" onClick={() => openPay('cash')} disabled={lines.length === 0}>
                  Pay <Kbd>F9</Kbd>
                </Button>
              )}
            </div>
            {payOpen ? (
              <div className="flex flex-col gap-2">
                {PAYMENT_MODES.map((m, i) => (
                  <label key={m} className="flex items-center justify-between gap-2 text-detail">
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {PAYMENT_MODE_LABELS[m]} <Kbd>F{5 + i}</Kbd>
                    </span>
                    <input
                      ref={(el) => {
                        payRefs.current[m] = el
                      }}
                      className={`${inputCls} num w-36 text-right`}
                      data-testid={`input-counter-pay-${m}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={pay[m]}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setPay((p) => ({ ...p, [m]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void checkout()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          e.stopPropagation()
                          setPayOpen(false)
                        }
                      }}
                    />
                  </label>
                ))}
                {cashPaid > 0 && (
                  <label className="flex items-center justify-between gap-2 text-detail">
                    <span className="whitespace-nowrap">Cash tendered</span>
                    <input
                      ref={(el) => {
                        payRefs.current.tendered = el
                      }}
                      className={`${inputCls} num w-36 text-right`}
                      data-testid="input-counter-tendered"
                      inputMode="decimal"
                      placeholder={formatPaise(cashPaid)}
                      value={pay.tendered}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setPay((p) => ({ ...p, tendered: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void checkout()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          e.stopPropagation()
                          setPayOpen(false)
                        }
                      }}
                    />
                  </label>
                )}
                <div className="num mt-1 flex flex-col gap-0.5 border-t border-line pt-2 text-detail">
                  <SumRow label="Paid" paise={paid} />
                  {remaining > 0 && <SumRow label={walkIn ? 'Still to pay' : 'On account'} paise={remaining} />}
                  {change > 0 && (
                    <div className="flex justify-between text-subtitle font-semibold" data-testid="counter-change-due">
                      <span>Change</span>
                      <span>{formatPaise(change, { symbol: true })}</span>
                    </div>
                  )}
                </div>
                {payIssue && <p className="text-hint text-cr" data-testid="counter-pay-issue">{payIssue}</p>}
                <div className="mt-1 flex justify-between gap-2">
                  <Button size="sm" onClick={() => setPayOpen(false)}>
                    Back <Kbd>Esc</Kbd>
                  </Button>
                  <Button variant="primary" data-testid="btn-counter-complete" disabled={!!payIssue || busy} onClick={() => void checkout()}>
                    Complete sale <Kbd>F9</Kbd>
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-hint text-muted">
                {party ? `${party.name} may pay part now and the rest on account.` : 'Cash, UPI and card — split the bill any way.'}
              </p>
            )}
          </Panel>
        </div>
      </div>

      {modal === 'party' && (
        <PartyModal
          walkInName={walkInName}
          onPick={(id) => {
            setPartyId(id)
            setModal(null)
          }}
          isParty={(l) => isPartyLedger(l, groupMap)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'held' && <HeldModal onRecall={(b) => void recall(b)} onClose={() => setModal(null)} />}
      {modal === 'dayEnd' && <DayEndModal date={date} onClose={() => setModal(null)} />}
    </Page>
  )
}

function SumRow({ label, paise }: { label: string; paise: number }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <Money paise={paise} />
    </div>
  )
}

function PartyModal({
  walkInName, onPick, onClose, isParty
}: {
  walkInName: string
  onPick: (id: number | null) => void
  onClose: () => void
  isParty: (l: import('@shared/domain').Ledger) => boolean
}): React.JSX.Element {
  return (
    <Modal title="Customer" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Party (sundry debtor)" hint="Their party rates and price level apply; they may pay part now">
          <LedgerPicker value={null} onPick={(id) => id != null && onPick(id)} autoFocus placeholder="Type a customer" filter={(l) => isParty(l)} testId="picker-counter-party" />
        </Field>
        <div className="flex justify-between">
          <Button data-testid="btn-counter-walk-in" onClick={() => onPick(null)}>
            {walkInName} (walk-in)
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}

const HELD_COLUMNS = defineColumns<HeldBill>([
  { id: 'label', header: 'Bill', kind: 'text', value: (b) => b.label, hideable: false },
  { id: 'lines', header: 'Lines', kind: 'number', value: (b) => b.lines.length, width: 80 },
  { id: 'heldAt', header: 'Held at', kind: 'text', value: (b) => new Date(b.heldAt).toLocaleTimeString(), width: 120 }
])

function HeldModal({ onRecall, onClose }: { onRecall: (b: HeldBill) => void; onClose: () => void }): React.JSX.Element {
  const { data, isLoading } = useQuery({ queryKey: ['counterHeld'], queryFn: counterApi.held })
  const queryClient = useQueryClient()
  return (
    <Modal title="Held bills" onClose={onClose}>
      <DataTable
        testId="counter-held"
        ariaLabel="Held bills"
        columns={HELD_COLUMNS}
        rows={data ?? []}
        rowKey={(b) => b.id}
        loading={isLoading}
        onRowActivate={onRecall}
        toolbar={false}
        maxHeight="20rem"
        empty={{ title: 'No bills on hold', hint: 'F3 parks the bill on screen; F4 brings it back' }}
        trailing={(b) => (
          <button
            type="button"
            className="text-small text-cr hover:underline"
            onClick={async () => {
              await counterApi.discardHeld(b.id)
              await queryClient.invalidateQueries({ queryKey: ['counterHeld'] })
            }}
          >
            Discard
          </button>
        )}
        trailingWidth={80}
      />
      <div className="mt-3 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  )
}

type DayItem = DayEndSummary['items'][number]
type DayBill = DayEndSummary['invoices'][number]
const DAY_ITEM_COLUMNS = defineColumns<DayItem>([
  { id: 'name', header: 'Item', kind: 'text', value: (r) => r.name, hideable: false },
  { id: 'qty', header: 'Qty', kind: 'quantity', value: (r) => r.qtyMilli, unit: (r) => r.unitSymbol, aggregate: 'sum', width: 110 },
  { id: 'amount', header: 'Taxable', kind: 'money', value: (r) => r.amountPaise, aggregate: 'sum', width: 130 }
])
const DAY_BILL_COLUMNS = defineColumns<DayBill>([
  { id: 'number', header: 'Bill', kind: 'text', value: (r) => r.number, width: 120, cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.number} /> },
  { id: 'party', header: 'Customer', kind: 'text', value: (r) => r.partyName },
  { id: 'total', header: 'Total', kind: 'money', value: (r) => r.totalPaise, aggregate: 'sum', width: 130 },
  { id: 'receipt', header: 'Receipt', kind: 'text', value: (r) => (r.receiptVoucherId ? 'Paid' : 'On account'), width: 110 }
])

function DayEndModal({ date, onClose }: { date: string; onClose: () => void }): React.JSX.Element {
  const { data, isLoading } = useQuery({ queryKey: ['counterDayEnd', date], queryFn: () => counterApi.dayEnd(date) })
  return (
    <Modal title={`Day end — ${toDisplayDate(date)}`} onClose={onClose} wide>
      <div className="flex flex-col gap-section" data-testid="counter-day-end">
        <StatGrid>
          <StatTile label="Bills" value={String(data?.bills ?? 0)} loading={isLoading} />
          <StatTile label="Sales (incl. GST)" value={formatPaise(data?.totalPaise ?? 0, { symbol: true })} loading={isLoading} />
          <StatTile label="Received" value={formatPaise((data?.totalPaise ?? 0) - (data?.onAccountPaise ?? 0), { symbol: true })} loading={isLoading} />
          <StatTile label="Change given" value={formatPaise(data?.changePaise ?? 0, { symbol: true })} loading={isLoading} />
        </StatGrid>
        <div className="grid grid-cols-2 gap-section">
          <div>
            <h3 className="mb-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">By payment mode</h3>
            <table className="ledger-table" data-testid="counter-day-end-modes">
              <tbody>
                {(data?.byMode ?? []).map((m) => (
                  <tr key={m.ledgerId}>
                    <td>{m.label}</td>
                    <td className="r">
                      <Money paise={m.amountPaise} />
                    </td>
                  </tr>
                ))}
                {(data?.onAccountPaise ?? 0) > 0 && (
                  <tr>
                    <td>On account (credit)</td>
                    <td className="r">
                      <Money paise={data!.onAccountPaise} />
                    </td>
                  </tr>
                )}
                <tr className="total-row">
                  <td>Total</td>
                  <td className="r">
                    <Money paise={data?.totalPaise ?? 0} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <DataTable
            testId="counter-day-end-items"
            ariaLabel="Items sold"
            columns={DAY_ITEM_COLUMNS}
            rows={data?.items ?? []}
            rowKey={(r) => r.itemId}
            loading={isLoading}
            maxHeight="16rem"
            toolbar={false}
            empty={{ title: 'Nothing sold at the counter on this day' }}
          />
        </div>
        <DataTable
          testId="counter-day-end-bills"
          ariaLabel="Counter bills"
          columns={DAY_BILL_COLUMNS}
          rows={data?.invoices ?? []}
          rowKey={(r) => r.voucherId}
          loading={isLoading}
          maxHeight="16rem"
          exportOptions={{ title: 'Counter day end', periodLabel: toDisplayDate(date), filename: `counter-day-end-${date}` }}
          empty={{ title: 'No counter bills on this day' }}
        />
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  )
}

/** The counter's settings (company-wide, meta 'counter.config'): walk-in party, accounts per
 *  payment mode, print template, auto-print; plus the pricing options. */
function CounterOptions({ config }: { config?: CounterConfig }): React.JSX.Element {
  const ledgers = useLedgers()
  const groups = useGroups()
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const queryClient = useQueryClient()
  const toast = useToasts()
  const { data: templates } = useQuery({ queryKey: ['printTemplates'], queryFn: api.templates.list })
  const { data: counterCfg } = useQuery({ queryKey: ['counterConfig'], queryFn: counterApi.config })
  const acc = counterCfg?.accounts
  if (!config) return <DrawerSection title="Counter">Loading…</DrawerSection>
  const set = async (patch: Partial<CounterConfig>): Promise<void> => {
    try {
      await counterApi.setConfig({ ...config, ...patch })
      await queryClient.invalidateQueries({ queryKey: ['counterConfig'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const select = (label: string, value: number | null, list: typeof ledgers, onChange: (id: number | null) => void, testId: string, fallback: string): React.JSX.Element => (
    <Field label={label}>
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} data-testid={testId}>
        <option value="">Default — {fallback}</option>
        {list.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
    </Field>
  )
  const parties = ledgers.filter((l) => isPartyLedger(l, groupMap))
  const cashBank = ledgers.filter((l) => isCashOrBankLedger(l, groupMap))
  const banks = ledgers.filter((l) => isBankLedger(l, groupMap))
  const name = (id: number | null | undefined): string => ledgers.find((l) => l.id === id)?.name ?? '—'
  return (
    <>
      <DrawerSection title="Counter">
        {select('Walk-in party', config.walkInLedgerId, parties, (id) => void set({ walkInLedgerId: id }), 'input-counter-walk-in', acc?.walkInLedgerId ? name(acc.walkInLedgerId) : 'Cash sale (created on the first sale)')}
        {select('Cash account', config.cashLedgerId, cashBank, (id) => void set({ cashLedgerId: id }), 'input-counter-cash-ledger', name(acc?.cashLedgerId))}
        {select('UPI account', config.upiLedgerId, banks, (id) => void set({ upiLedgerId: id }), 'input-counter-upi-ledger', name(acc?.upiLedgerId))}
        {select('Card account', config.cardLedgerId, banks, (id) => void set({ cardLedgerId: id }), 'input-counter-card-ledger', name(acc?.cardLedgerId))}
        <p className="text-hint text-muted">Sales post to {name(acc?.salesLedgerId)}; each payment is a receipt against the bill.</p>
      </DrawerSection>
      <DrawerSection title="Print">
        <Field label="Bill template">
          <Select value={config.templateId} onChange={(e) => void set({ templateId: e.target.value })} data-testid="input-counter-template">
            {(templates?.templates ?? []).filter((t) => t.kinds.includes('sales')).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox label="Print the bill after every sale" checked={config.autoPrint} onChange={(v) => void set({ autoPrint: v })} testId="input-counter-auto-print" />
      </DrawerSection>
      <PricingOptions showAutoApply={false} />
    </>
  )
}
