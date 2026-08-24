import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CounterCart, type CounterCartLineInput, type ReturnableSale } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import {
  AmountInput,
  Button,
  Field,
  Modal,
  Money,
  Panel,
  Select,
  TextInput
} from '../components/ui'
import { formatPaise, parseMilli } from '@shared/money'
import { todayISO } from '@shared/dates'
import { changeBreakdown, settleTender, type Tender, type TenderMode } from '@shared/counter'

/**
 * Counter mode (roadmap #376).
 *
 * A kirana, a pharmacy or a hardware shop cannot run the voucher screen at a counter. The
 * difference is not cosmetic: at a counter there is a customer waiting, the operator is not
 * looking at the screen while they scan, and the whole sale has to end in a tender, a change
 * figure and a printed slip in a few seconds.
 *
 * So: one input that always has focus, Enter to add, F2 to tender, Escape to clear. The cart is
 * priced in the main process on every change — the tax band, the cost and the running schemes are
 * facts about the books, and a second copy of them in the renderer would eventually disagree.
 */
type Mode = 'sale' | 'return'

interface CartRow extends CounterCartLineInput {
  key: number
}

let nextKey = 1

export function CounterScreen(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { info } = useSession()
  const [rows, setRows] = useState<CartRow[]>([])
  const [scan, setScan] = useState('')
  const [mode, setMode] = useState<Mode>('sale')
  const [pricingMode, setPricingMode] = useState<'inclusive' | 'exclusive'>('inclusive')
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [tendering, setTendering] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState<'open' | 'close' | 'movement' | null>(null)
  const [returning, setReturning] = useState(false)
  const [showCustomer, setShowCustomer] = useState(false)
  const [lastSale, setLastSale] = useState<{ number: string; changePaise: number; voucherId: number } | null>(null)
  const scanRef = useRef<HTMLInputElement>(null)

  const { data: session } = useQuery({ queryKey: ['counterSession'], queryFn: api.counter.session })
  const { data: cart } = useQuery({
    queryKey: ['counterCart', rows, pricingMode],
    queryFn: () => api.counter.price({ lines: rows.map(({ key: _key, ...l }) => l), pricingMode }),
    enabled: rows.length > 0
  })

  // The scan box is where the operator's hands are. Anything that steals focus — a modal, a
  // toast, a click on a row — has to give it back, or the next scan lands nowhere.
  const refocus = useCallback(() => {
    window.setTimeout(() => scanRef.current?.focus(), 0)
  }, [])
  useEffect(refocus, [refocus, rows.length, tendering, drawerOpen, returning])

  const clear = useCallback(() => {
    setRows([])
    setScan('')
    setCustomerName('')
    setCustomerPhone('')
    refocus()
  }, [refocus])

  /**
   * Add whatever was scanned or typed.
   *
   * `3*W1` and `3 W1` mean three of W1. A scanner types the barcode and an Enter and nothing
   * else, so the bare form has to be the fast one; the multiplier exists for the person holding
   * a carton who does not want to scan it twelve times.
   */
  const add = async (): Promise<void> => {
    const raw = scan.trim()
    if (!raw) return
    const match = /^(\d+(?:\.\d+)?)\s*[*x ]\s*(.+)$/i.exec(raw)
    const qtyMilli = match ? (parseMilli(match[1]!) ?? 1000) : 1000
    const query = match ? match[2]! : raw
    try {
      const found = await api.counter.lookup(query)
      if (!found) {
        toast.push('error', `Nothing here is called "${query}"`)
        return
      }
      if (found.ratePaise === 0) {
        toast.push('info', `${found.name} has never been sold — type the price on the line`)
      }
      setRows((r) => {
        // A second scan of the same item adds to the line rather than opening another one: a
        // cart with "Sugar 1" four times is a cart the customer cannot check.
        const existing = r.findIndex((x) => x.stockItemId === found.stockItemId && x.ratePaise === undefined)
        if (existing >= 0) {
          const copy = [...r]
          copy[existing] = { ...copy[existing]!, qtyMilli: copy[existing]!.qtyMilli + qtyMilli }
          return copy
        }
        return [...r, { key: nextKey++, stockItemId: found.stockItemId, qtyMilli }]
      })
      setScan('')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const setRow = (key: number, patch: Partial<CartRow>): void =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  const removeRow = (key: number): void => setRows((r) => r.filter((x) => x.key !== key))

  // The counter's keyboard: two keys, both of which have to work while the scan box has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F2' && rows.length > 0) {
        e.preventDefault()
        setTendering(true)
      }
      if (e.key === 'F4') {
        e.preventDefault()
        setReturning(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows.length])

  const complete = async (tenders: Tender[]): Promise<void> => {
    try {
      const result = await api.counter.sale({
        lines: rows.map(({ key: _key, ...l }) => l),
        tenders,
        pricingMode,
        customerName: customerName.trim() || null,
        customerPhone: customerPhone.trim() || null,
        kind: mode
      })
      setLastSale({ number: result.number, changePaise: result.tender.changePaise, voucherId: result.voucherId })
      setTendering(false)
      clear()
      setMode('sale')
      await queryClient.invalidateQueries({ queryKey: ['counterSession'] })
      await queryClient.invalidateQueries({ queryKey: ['counterSummary'] })
      await queryClient.invalidateQueries({ queryKey: ['counterSales'] })
      toast.push('success', `${mode === 'sale' ? 'Sale' : 'Return'} ${result.number} — change ${formatPaise(result.tender.changePaise)}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const belowCost = cart?.belowCostLines ?? 0

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3" data-testid="counter-screen">
      {/* ---- the till bar ---- */}
      <div className="flex items-center gap-3">
        <div className="text-h3 font-semibold">{mode === 'sale' ? 'Counter' : 'Counter — return'}</div>
        {session ? (
          <span className="rounded-md bg-panel2 px-2 py-1 text-caption text-muted" data-testid="counter-till-open">
            Till open since {session.openedAt.slice(11, 16)} · float {formatPaise(session.openingFloatPaise)}
            {session.operator ? ` · ${session.operator}` : ''}
          </span>
        ) : (
          <span className="rounded-md bg-panel2 px-2 py-1 text-caption text-cr" data-testid="counter-till-closed">
            No till open — sales will not be counted into a drawer
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
          <Select
            aria-label="Pricing"
            className="w-52"
            data-testid="select-counter-pricing"
            value={pricingMode}
            onChange={(e) => setPricingMode(e.target.value as 'inclusive' | 'exclusive')}
          >
            <option value="inclusive">Shelf price (tax inside)</option>
            <option value="exclusive">Rate + tax</option>
          </Select>
          <Button variant="ghost" data-testid="btn-counter-return" onClick={() => setReturning(true)}>
            Return · F4
          </Button>
          <Button variant="ghost" data-testid="btn-counter-customer-screen" onClick={() => setShowCustomer(!showCustomer)}>
            {showCustomer ? 'Hide view' : 'Customer view'}
          </Button>
          {session ? (
            <>
              <Button variant="ghost" data-testid="btn-counter-movement" onClick={() => setDrawerOpen('movement')}>
                Cash in/out
              </Button>
              <Button data-testid="btn-counter-close-till" onClick={() => setDrawerOpen('close')}>
                Close till
              </Button>
            </>
          ) : (
            <Button variant="primary" data-testid="btn-counter-open-till" onClick={() => setDrawerOpen('open')}>
              Open till
            </Button>
          )}
        </div>
      </div>

      {/* ---- the scan box ---- */}
      <div className="flex gap-2">
        <TextInput
          ref={scanRef}
          data-testid="input-counter-scan"
          className="flex-1 !text-h3 !py-3"
          placeholder="Scan, or type a code — 3*W1 for three"
          value={scan}
          autoFocus
          onChange={(e) => setScan(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
            if (e.key === 'Escape' && !scan) clear()
          }}
        />
        <Button data-testid="btn-counter-add" onClick={() => void add()}>
          Add
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* ---- the cart ---- */}
        <Panel className="flex-1" scroll={{ maxH: '100%' }} data-testid="panel-counter-cart">
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="r w-28">Qty</th>
                <th scope="col" className="r w-32">Rate</th>
                <th scope="col" className="r w-24">Tax</th>
                <th scope="col" className="r w-32">Amount</th>
                <th scope="col" className="w-10" />
              </tr>
            </thead>
            <tbody data-testid="rows-counter-cart">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted">
                    Scan something. Enter adds it, F2 takes the money.
                  </td>
                </tr>
              )}
              {rows.map((row, i) => {
                const priced = cart?.lines[i]
                return (
                  <tr key={row.key} data-testid={`row-counter-${i}`}>
                    <td>
                      {priced?.name ?? '…'}
                      {priced?.code && <span className="ml-2 num text-hint text-muted">{priced.code}</span>}
                      {priced?.scheme && (
                        <span className="ml-2 rounded-md bg-amberbar/25 px-1.5 text-hint" data-testid={`scheme-${i}`}>
                          {priced.scheme.label}
                        </span>
                      )}
                      {priced?.belowCost && (
                        <span className="ml-2 text-hint text-cr" data-testid={`below-cost-${i}`}>
                          below cost by {formatPaise(priced.belowCostBy)}
                        </span>
                      )}
                    </td>
                    <td className="r">
                      <TextInput
                        data-testid={`input-counter-qty-${i}`}
                        className="num text-right"
                        value={String(row.qtyMilli / 1000)}
                        onChange={(e) => setRow(row.key, { qtyMilli: parseMilli(e.target.value) ?? row.qtyMilli })}
                      />
                    </td>
                    <td className="r">
                      <AmountInput
                        testId={`input-counter-rate-${i}`}
                        paise={row.ratePaise ?? priced?.ratePaise ?? null}
                        onPaise={(p) => setRow(row.key, { ratePaise: p ?? undefined })}
                      />
                    </td>
                    <td className="r num text-muted">{priced ? `${priced.gstRate}%` : ''}</td>
                    <td className="r font-medium">{priced ? <Money paise={priced.totalPaise} /> : '…'}</td>
                    <td className="r">
                      <button className="text-small text-cr hover:underline" onClick={() => removeRow(row.key)}>
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Panel>

        {/* ---- the total ---- */}
        <div className="flex w-80 shrink-0 flex-col gap-3">
          <Panel className="p-4" data-testid="panel-counter-total">
            <div className="text-caption tracking-[0.08em] text-muted uppercase">To pay</div>
            <div className="num text-[2.6rem] leading-none font-semibold" data-testid="counter-payable">
              {formatPaise(cart?.payablePaise ?? 0, { symbol: true })}
            </div>
            <div className="mt-3 space-y-1 text-body-sm">
              <Row label="Taxable" paise={cart?.gst.taxable ?? 0} />
              {(cart?.gst.cgst ?? 0) > 0 && <Row label="CGST" paise={cart!.gst.cgst} />}
              {(cart?.gst.sgst ?? 0) > 0 && <Row label="SGST" paise={cart!.gst.sgst} />}
              {(cart?.gst.igst ?? 0) > 0 && <Row label="IGST" paise={cart!.gst.igst} />}
              {(cart?.discountPaise ?? 0) > 0 && <Row label="Discount" paise={-cart!.discountPaise} />}
              {(cart?.roundOffPaise ?? 0) !== 0 && <Row label="Round off" paise={cart!.roundOffPaise} />}
            </div>
            {belowCost > 0 && (
              <p className="mt-3 rounded-md bg-cr/10 p-2 text-hint text-cr" data-testid="counter-below-cost-warning">
                {belowCost === 1 ? 'One line is' : `${belowCost} lines are`} priced under what the stock cost. The
                moment to say so is now, not at the month end.
              </p>
            )}
            {(cart?.shortLines.length ?? 0) > 0 && (
              <p className="mt-2 text-hint text-muted" data-testid="counter-short-warning">
                Selling more than the books say is on hand. Sold anyway — the purchase bill may not be entered yet.
              </p>
            )}
            <Button
              variant="primary"
              className="mt-4 w-full"
              data-testid="btn-counter-tender"
              disabled={rows.length === 0}
              onClick={() => setTendering(true)}
            >
              Take the money (F2)
            </Button>
            <Button className="mt-2 w-full" data-testid="btn-counter-clear" onClick={clear} disabled={rows.length === 0}>
              Clear
            </Button>
          </Panel>

          <Panel className="p-3">
            <Field label="Customer name" hint="Printed on the bill; no ledger is created">
              <TextInput
                data-testid="input-counter-customer"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Walk-in"
              />
            </Field>
            <div className="mt-2">
              <Field label="Phone" hint="So a return can find this bill">
                <TextInput
                  data-testid="input-counter-phone"
                  className="num"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              </Field>
            </div>
          </Panel>

          {lastSale && (
            <Panel className="p-3 text-body-sm" data-testid="counter-last-sale">
              <div className="font-medium">Last: {lastSale.number}</div>
              <div className="text-muted">Change given {formatPaise(lastSale.changePaise)}</div>
            </Panel>
          )}
        </div>

        {/* ---- the second screen (#385) ---- */}
        {showCustomer && cart && (
          <Panel className="w-72 shrink-0 p-4" data-testid="panel-customer-display">
            <div className="text-caption tracking-[0.08em] text-muted uppercase">{info?.name}</div>
            <div className="mt-2 space-y-1 text-body-sm">
              {cart.lines.map((l, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span className="truncate">
                    {l.name} <span className="text-muted">× {l.qtyMilli / 1000}</span>
                  </span>
                  <Money paise={l.totalPaise} />
                </div>
              ))}
            </div>
            <div className="mt-4 border-t border-line pt-2">
              <div className="text-caption text-muted uppercase">Total</div>
              <div className="num text-h2 font-semibold">{formatPaise(cart.payablePaise, { symbol: true })}</div>
            </div>
            {cart.lines.some((l) => l.scheme) && (
              <div className="mt-2 text-hint text-amberbar" data-testid="customer-saved">
                You saved {formatPaise(cart.lines.reduce((s, l) => s + (l.scheme?.savedPaise ?? 0), 0))}
              </div>
            )}
          </Panel>
        )}
      </div>

      {tendering && cart && (
        <TenderModal
          payablePaise={cart.payablePaise}
          onClose={() => setTendering(false)}
          onComplete={(tenders) => void complete(tenders)}
        />
      )}
      {drawerOpen && (
        <DrawerModal
          which={drawerOpen}
          sessionId={session?.id ?? null}
          onClose={() => setDrawerOpen(null)}
        />
      )}
      {returning && (
        <ReturnModal
          onClose={() => setReturning(false)}
          onLoad={(sale) => {
            setRows(sale.lines.map((l) => ({ key: nextKey++, stockItemId: l.stockItemId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise })))
            setPricingMode('inclusive')
            setMode('return')
            setReturning(false)
          }}
        />
      )}
    </div>
  )
}

function Row({ label, paise }: { label: string; paise: number }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <Money paise={paise} />
    </div>
  )
}

// ---------- tender (#376) ----------

const MODES: { mode: TenderMode; label: string }[] = [
  { mode: 'cash', label: 'Cash' },
  { mode: 'card', label: 'Card' },
  { mode: 'upi', label: 'UPI' },
  { mode: 'credit', label: 'On account' }
]

function TenderModal({
  payablePaise,
  onClose,
  onComplete
}: {
  payablePaise: number
  onClose: () => void
  onComplete: (tenders: Tender[]) => void
}): React.JSX.Element {
  const [amounts, setAmounts] = useState<Record<TenderMode, number | null>>({
    // Prefilled with the exact amount in cash, because that is the overwhelmingly common tender
    // and the operator should be able to press Enter without typing anything.
    cash: payablePaise,
    card: null,
    upi: null,
    credit: null
  })
  const tenders: Tender[] = MODES.filter((m) => (amounts[m.mode] ?? 0) > 0).map((m) => ({
    mode: m.mode,
    amountPaise: amounts[m.mode]!
  }))
  const result = settleTender(payablePaise, tenders)

  return (
    <Modal title={`Take ${formatPaise(payablePaise, { symbol: true })}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        {MODES.map((m) => (
          <Field key={m.mode} label={m.label}>
            <AmountInput
              testId={`input-tender-${m.mode}`}
              paise={amounts[m.mode]}
              autoFocus={m.mode === 'cash'}
              onPaise={(p) => setAmounts((a) => ({ ...a, [m.mode]: p }))}
            />
          </Field>
        ))}
      </div>

      <div className="mt-4 rounded-md border border-line bg-panel2 p-3" data-testid="tender-summary">
        <div className="flex justify-between text-body-sm">
          <span className="text-muted">Tendered</span>
          <Money paise={result.tenderedPaise} />
        </div>
        {result.shortPaise > 0 ? (
          <div className="flex justify-between font-medium text-cr" data-testid="tender-short">
            <span>Still to pay</span>
            <Money paise={result.shortPaise} />
          </div>
        ) : (
          <div className="flex justify-between text-h3 font-semibold" data-testid="tender-change">
            <span>Change</span>
            <Money paise={result.changePaise} />
          </div>
        )}
        {result.changePaise > 0 && (
          <div className="mt-1 text-hint text-muted">
            {changeBreakdown(result.changePaise)
              .map((d) => `${d.count} × ${formatPaise(d.denomination)}`)
              .join(' · ')}
          </div>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="btn-tender-complete"
          disabled={result.shortPaise > 0}
          onClick={() => onComplete(tenders)}
        >
          Done
        </Button>
      </div>
    </Modal>
  )
}

// ---------- the drawer (#377) ----------

function DrawerModal({
  which,
  sessionId,
  onClose
}: {
  which: 'open' | 'close' | 'movement'
  sessionId: number | null
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [float, setFloat] = useState<number | null>(null)
  const [operator, setOperator] = useState('')
  const [counted, setCounted] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [movementKind, setMovementKind] = useState<'payin' | 'payout'>('payout')
  const [amount, setAmount] = useState<number | null>(null)
  const [reason, setReason] = useState('')

  const { data: summary } = useQuery({
    queryKey: ['counterSummary', sessionId],
    queryFn: () => api.counter.summary(sessionId!),
    enabled: sessionId !== null && which !== 'open'
  })

  const done = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    try {
      await fn()
      await queryClient.invalidateQueries({ queryKey: ['counterSession'] })
      await queryClient.invalidateQueries({ queryKey: ['counterSummary'] })
      toast.push('success', message)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (which === 'open') {
    return (
      <Modal title="Open the till" onClose={onClose}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Opening float" hint="What is in the drawer before the first sale">
            <AmountInput testId="input-drawer-float" paise={float} onPaise={setFloat} autoFocus />
          </Field>
          <Field label="Who is on the counter">
            <TextInput data-testid="input-drawer-operator" value={operator} onChange={(e) => setOperator(e.target.value)} />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="btn-drawer-open"
            onClick={() =>
              void done(
                () => api.counter.open({ openedOn: todayISO(), operator: operator.trim() || null, openingFloatPaise: float ?? 0 }),
                'Till open'
              )
            }
          >
            Open
          </Button>
        </div>
      </Modal>
    )
  }

  if (which === 'movement') {
    return (
      <Modal title="Cash in or out of the drawer" onClose={onClose}>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Which way">
            <Select value={movementKind} onChange={(e) => setMovementKind(e.target.value as 'payin' | 'payout')}>
              <option value="payout">Taken out</option>
              <option value="payin">Put in</option>
            </Select>
          </Field>
          <Field label="Amount">
            <AmountInput testId="input-movement-amount" paise={amount} onPaise={setAmount} autoFocus />
          </Field>
          <Field label="What for">
            <TextInput data-testid="input-movement-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <p className="mt-3 text-hint text-muted">
          Every rupee that leaves the drawer without a sale has to be recorded here, or the closing
          count will not agree and the operator will learn to ignore the variance.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="btn-movement-save"
            disabled={!amount}
            onClick={() =>
              void done(
                () => api.counter.movement(sessionId!, movementKind, amount ?? 0, reason.trim() || null),
                'Recorded'
              )
            }
          >
            Record
          </Button>
        </div>
      </Modal>
    )
  }

  const variance = counted === null ? null : counted - (summary?.drawer.expectedPaise ?? 0)
  return (
    <Modal title="Close the till" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1 text-body-sm" data-testid="drawer-expected">
          <Line label="Opening float" paise={summary?.drawer.openingFloatPaise ?? 0} />
          <Line label="Cash sales" paise={summary?.drawer.cashSalesPaise ?? 0} />
          <Line label="Cash refunds" paise={-(summary?.drawer.cashRefundsPaise ?? 0)} />
          <Line label="Put in" paise={summary?.drawer.payinsPaise ?? 0} />
          <Line label="Taken out" paise={-(summary?.drawer.payoutsPaise ?? 0)} />
          <div className="flex justify-between border-t border-line pt-1 font-medium">
            <span>Should be in the drawer</span>
            <Money paise={summary?.drawer.expectedPaise ?? 0} />
          </div>
          <p className="pt-2 text-hint text-muted">
            Card and UPI takings are not in this figure — they settle into the bank, not into the
            till. {summary?.byMode.filter((m) => m.mode !== 'cash').map((m) => `${m.mode} ${formatPaise(m.amountPaise)}`).join(' · ')}
          </p>
        </div>
        <div>
          <Field label="Counted" hint="What is actually in the drawer">
            <AmountInput testId="input-drawer-counted" paise={counted} onPaise={setCounted} autoFocus />
          </Field>
          <div className="mt-3">
            <Field label="Notes">
              <TextInput data-testid="input-drawer-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          {variance !== null && (
            <div
              className={`mt-3 rounded-md p-3 text-body-sm ${variance === 0 ? 'bg-panel2' : 'bg-cr/10 text-cr'}`}
              data-testid="drawer-variance"
            >
              {variance === 0
                ? 'Balanced.'
                : variance < 0
                  ? `Short by ${formatPaise(-variance)}.`
                  : `Over by ${formatPaise(variance)}.`}
            </div>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="btn-drawer-close"
          disabled={counted === null}
          onClick={() => void done(() => api.counter.close(sessionId!, counted ?? 0, notes.trim() || null), 'Till closed')}
        >
          Close the till
        </Button>
      </div>
    </Modal>
  )
}

function Line({ label, paise }: { label: string; paise: number }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <Money paise={paise} signed />
    </div>
  )
}

// ---------- returns (#384) ----------

function ReturnModal({ onClose, onLoad }: { onClose: () => void; onLoad: (sale: ReturnableSale) => void }): React.JSX.Element {
  const toast = useToasts()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<ReturnableSale | null>(null)

  const search = async (): Promise<void> => {
    try {
      const sale = await api.counter.findSale(query.trim())
      if (!sale) toast.push('error', 'No counter sale with that number or phone')
      setFound(sale)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Take something back" onClose={onClose}>
      <Field label="Bill number or phone" hint="Whatever the customer has — the receipt, or the number they gave">
        <TextInput
          data-testid="input-return-query"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
        />
      </Field>
      {found && (
        <div className="mt-3 rounded-md border border-line bg-panel2 p-3 text-body-sm" data-testid="return-found">
          <div className="font-medium">
            {found.number} · {found.date} · {formatPaise(found.totalPaise)}
          </div>
          <ul className="mt-1 text-muted">
            {found.lines.map((l) => (
              <li key={l.stockItemId}>
                {l.name} × {l.qtyMilli / 1000}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-hint">
            Loading these into the cart raises a credit note. Delete the lines the customer is
            keeping, then take the money out of the till.
          </p>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button data-testid="btn-return-find" onClick={() => void search()}>
          Find
        </Button>
        <Button variant="primary" data-testid="btn-return-load" disabled={!found} onClick={() => found && onLoad(found)}>
          Take it back
        </Button>
      </div>
    </Modal>
  )
}
