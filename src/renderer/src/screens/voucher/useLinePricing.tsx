// WP 2.6 — automatic line pricing for the item grid. Every row whose rate the resolver owns
// (rate still empty, or `pricing.source === 'auto'`) is priced through pricing:resolve whenever
// its item, quantity, the party, the date, the supply or the currency changes; a rate or
// discount typed by hand flips the row to 'manual' and is never overridden. Rows loaded from a
// saved voucher or drawn from a challan / order carry a rate and no `pricing` — they are manual
// too. The rate source is UI state only (nothing new is posted, so vouchers still round-trip).
import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VoucherKind } from '@shared/domain'
import type { PriceSource } from '@shared/pricing'
import { pricingApi } from '../../lib/pricingClient'
import { Popover } from '../../components/kit'

export interface RowPricing {
  /** 'auto' = the resolver owns rate + discount; 'manual' = typed by hand. */
  source: 'auto' | 'manual'
  kind?: PriceSource
  /** "Party rate" / "Scheme: Diwali 10%" / "Level: Wholesale". */
  label?: string
  explanation?: string[]
}

export interface PricedRow {
  key: number
  itemId: number | null
  qtyText: string
  rate: number | null
  discount: number | null
  pricing?: RowPricing
}

export interface LinePricingContext {
  /** Sales-side invoice with a pricing context (off = the grid's legacy price-level fill). */
  enabled: boolean
  /** Options toggle: re-price auto rows on every change. Off = fill an empty rate once. */
  autoApply: boolean
  partyId: number | null
  date: string
  supply: 'intra' | 'inter'
  /** '' = ₹. */
  currency: string
}

/** The pricing context an invoice hands its grid: sales invoices only (a bill's rate is the
 *  supplier's; a note follows its invoice), with the Options toggle from pricing:config. */
export function useInvoicePricing(kind: VoucherKind, partyId: number | null, date: string, supply: 'intra' | 'inter', currency: string): LinePricingContext {
  const { data } = useQuery({ queryKey: ['pricingConfig'], queryFn: pricingApi.config, enabled: kind === 'sales' })
  return { enabled: kind === 'sales' && !!data, autoApply: data?.autoApply ?? true, partyId, date, supply, currency }
}

const qtyMilliOf = (qtyText: string): number => {
  const q = Math.round(parseFloat(qtyText || '0') * 1000)
  return Number.isFinite(q) && q > 0 ? q : 0
}

/** The resolver owns this row's price. */
export function rowIsAuto(r: PricedRow, autoApply: boolean): boolean {
  if (r.itemId == null) return false
  if (r.pricing?.source === 'manual') return false
  if (r.pricing?.source === 'auto') return autoApply
  return r.rate == null
}

export function useLinePricing<R extends PricedRow>(
  rows: R[],
  setRows: Dispatch<SetStateAction<R[]>>,
  ctx: LinePricingContext
): { resetRow: (key: number) => void } {
  const requested = useRef(new Map<number, string>())
  const sigOf = (r: R): string => `${r.itemId}|${qtyMilliOf(r.qtyText)}|${ctx.partyId}|${ctx.date}|${ctx.supply}|${ctx.currency}`
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  useEffect(() => {
    if (!ctx.enabled) return
    const want = rows.filter((r) => rowIsAuto(r, ctx.autoApply) && requested.current.get(r.key) !== sigOf(r))
    if (want.length === 0) return
    const sigs = new Map(want.map((r) => [r.key, sigOf(r)]))
    for (const [k, s] of sigs) requested.current.set(k, s)
    void pricingApi
      .resolve({
        date: ctx.date, partyLedgerId: ctx.partyId, currency: ctx.currency, supply: ctx.supply,
        lines: want.map((r) => ({ key: r.key, itemId: r.itemId!, qtyMilli: qtyMilliOf(r.qtyText) }))
      })
      .then((res) => {
        const byKey = new Map(res.map((x) => [x.key, x.result]))
        setRows((rs) =>
          rs.map((row) => {
            const result = byKey.get(row.key)
            // Stale answers (the row changed meanwhile) and rows typed over since are skipped.
            if (!result || sigs.get(row.key) !== sigOf(row) || !rowIsAuto(row, ctxRef.current.autoApply)) return row
            const pricing: RowPricing = { source: 'auto', kind: result.source, label: result.label, explanation: result.explanation }
            if (result.ratePaise == null) return row.rate == null ? { ...row, pricing } : row
            return { ...row, rate: result.ratePaise, discount: result.discountPaise > 0 ? result.discountPaise : null, pricing }
          })
        )
      })
      .catch(() => {
        for (const k of sigs.keys()) requested.current.delete(k) // retry on the next change
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, ctx.enabled, ctx.autoApply, ctx.partyId, ctx.date, ctx.supply, ctx.currency])

  return {
    /** Hand the row back to the price list (re-priced on the next render). */
    resetRow: (key: number): void => {
      requested.current.delete(key)
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, rate: null, discount: null, pricing: undefined } : r)))
    }
  }
}

/** The small source hint under a rate cell, with the resolver's explanation in a popover and a
 *  way back to the price list for a hand-typed rate. */
export function PriceHint({ pricing, onReset }: { pricing?: RowPricing; onReset: () => void }): React.JSX.Element | null {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!pricing) return null
  const manual = pricing.source === 'manual'
  const label = manual ? 'Manual' : (pricing.label ?? '')
  if (!label) return null
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-testid="line-price-hint"
        data-source={manual ? 'manual' : (pricing.kind ?? 'auto')}
        className={`mt-0.5 max-w-full truncate text-hint hover:underline ${manual ? 'text-muted' : pricing.kind === 'none' ? 'text-cr' : 'text-blue'}`}
        title={manual ? 'Typed by hand — click to use the price list' : (pricing.explanation ?? []).join('\n')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <Popover anchor={ref} onClose={() => setOpen(false)} label="Price source" align="right" width={320} testId="line-price-popover">
          <div className="flex flex-col gap-2 p-3 text-detail">
            <div className="font-semibold text-ink">{manual ? 'Rate typed by hand' : label}</div>
            {!manual && (
              <ul className="flex flex-col gap-1 text-body-sm text-muted" data-testid="line-price-explanation">
                {(pricing.explanation ?? []).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            {manual ? (
              <button
                type="button"
                className="self-start text-hint text-blue hover:underline"
                data-testid="btn-line-price-reset"
                onClick={() => {
                  setOpen(false)
                  onReset()
                }}
              >
                Use the price list again
              </button>
            ) : (
              <p className="text-hint text-muted">Typing a rate or discount keeps your figure; this line then stops following the price list.</p>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
