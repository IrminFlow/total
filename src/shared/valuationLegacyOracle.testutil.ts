// Test-only ORACLE: a verbatim copy of valueStock() from origin/main before WP 2.1 (the per-item
// walk). The pure tests assert the new global pass reproduces it exactly under the 'stored'
// costing rule. Never import from app code; never edit — it pins legacy semantics.
import type { StockMovement, ValuationMethod, ValuationResult } from './valuation'

interface Layer {
  qtyMilli: number
  value: number
}

/**
 * Walk `movements` (chronological) over an opening balance and return the closing position.
 *
 * - `weighted_avg` — perpetual moving average: every outward removes value at the average cost
 *   at that moment. Overdraw continues at the last known average (value can go negative).
 * - `fifo` — cost layers consumed oldest-first, partial layers pro-rated with integer rounding
 *   (the layer's remaining value is exact — no drift). An overdraw is remembered as a deficit
 *   and backfilled from the next inward layer at that layer's cost.
 */
export function legacyValueStock(
  method: ValuationMethod,
  openingQtyMilli: number,
  openingValue: number,
  movements: StockMovement[]
): ValuationResult {
  let inwardQtyMilli = 0
  let outwardQtyMilli = 0
  let consumedValue = 0

  if (method === 'weighted_avg') {
    let qty = openingQtyMilli
    let value = openingValue

    const outward = (q: number): void => {
      const cost = qty > 0 ? Math.round((value * q) / qty) : 0
      qty -= q
      value -= cost
      outwardQtyMilli += q
      consumedValue += cost
    }
    const inward = (q: number, amount: number): void => {
      qty += q
      value += amount
      inwardQtyMilli += q
    }

    for (const m of movements) {
      if (m.isAbsolute) {
        const delta = m.qtyMilli - qty
        if (delta > 0) {
          // Adjustment inward at the current average cost.
          const cost = qty > 0 ? Math.round((value * delta) / qty) : 0
          inward(delta, cost)
        } else if (delta < 0) {
          outward(-delta)
        }
      } else if (m.direction === 'in') {
        inward(m.qtyMilli, m.amount)
      } else {
        outward(m.qtyMilli)
      }
    }
    return { closingQtyMilli: qty, closingValue: value, inwardQtyMilli, outwardQtyMilli, consumedValue }
  }

  // ---- FIFO ----
  const layers: Layer[] = []
  if (openingQtyMilli > 0 || openingValue !== 0) layers.push({ qtyMilli: openingQtyMilli, value: openingValue })
  /** Quantity sold while nothing was on hand — backfilled from the next inward layer. */
  let deficitMilli = 0

  const totalQty = (): number => layers.reduce((s, l) => s + l.qtyMilli, 0) - deficitMilli
  const totalValue = (): number => layers.reduce((s, l) => s + l.value, 0)

  const outward = (q: number): void => {
    outwardQtyMilli += q
    let remaining = q
    while (remaining > 0 && layers.length > 0) {
      const layer = layers[0]!
      if (layer.qtyMilli <= remaining) {
        remaining -= layer.qtyMilli
        consumedValue += layer.value
        layers.shift()
      } else {
        const cost = Math.round((layer.value * remaining) / layer.qtyMilli)
        layer.qtyMilli -= remaining
        layer.value -= cost
        consumedValue += cost
        remaining = 0
      }
    }
    deficitMilli += remaining
  }

  const inward = (q: number, amount: number): void => {
    inwardQtyMilli += q
    let qty = q
    let value = amount
    if (deficitMilli > 0 && qty > 0) {
      const take = Math.min(deficitMilli, qty)
      const cost = take === qty ? value : Math.round((value * take) / qty)
      qty -= take
      value -= cost
      deficitMilli -= take
      consumedValue += cost
    }
    if (qty > 0 || value !== 0) layers.push({ qtyMilli: qty, value })
  }

  for (const m of movements) {
    if (m.isAbsolute) {
      const cur = totalQty()
      const delta = m.qtyMilli - cur
      if (delta > 0) {
        // Adjustment inward at the current average cost over all layers.
        const value = totalValue()
        const cost = cur > 0 ? Math.round((value * delta) / cur) : 0
        inward(delta, cost)
      } else if (delta < 0) {
        outward(-delta)
      }
    } else if (m.direction === 'in') {
      inward(m.qtyMilli, m.amount)
    } else {
      outward(m.qtyMilli)
    }
  }

  return {
    closingQtyMilli: totalQty(),
    closingValue: totalValue(),
    inwardQtyMilli,
    outwardQtyMilli,
    consumedValue
  }
}
