/**
 * Pure stock valuation engine (lane I, task 70): chronological cost-layer walk implementing
 * FIFO layers and a perpetual moving average, plus small pure helpers for physical-stock
 * adjustments, manufacture additional-cost allocation, batch expiry ageing and BOM cycle
 * detection. No Electron, no DB — callers (src/main/services/stockAnalysis.ts et al) load the
 * movements from SQL in voucher order and hand them over.
 *
 * All quantities are integer thousandths (qtyMilli); all values are integer paise. Floats never
 * touch amounts — proportions round via Math.round at each consumption step, and value is always
 * conserved exactly: opening + inward value === consumedValue + closingValue.
 */

export type ValuationMethod = 'weighted_avg' | 'fifo'

/** One inventory movement, in chronological order. */
export interface StockMovement {
  direction: 'in' | 'out'
  /** For a normal line: the moved quantity (≥ 0). For an `isAbsolute` (physical stock) line:
   *  the counted closing quantity this line pins the stock to. */
  qtyMilli: number
  /** Total line value in paise. Only inward movements carry cost; ignored for outward and
   *  absolute lines (those are valued at the cost already on the books). */
  amount: number
  /** Physical Stock voucher line: `qtyMilli` is the absolute counted quantity, and the engine
   *  books the delta as an inward/outward adjustment at the current average cost. */
  isAbsolute?: boolean
}

export interface ValuationResult {
  closingQtyMilli: number
  /** Paise. Can go negative under weighted average when stock is overdrawn. */
  closingValue: number
  /** Total inward quantity across the movements (absolute lines count only their delta). */
  inwardQtyMilli: number
  /** Total outward quantity across the movements (absolute lines count only their delta). */
  outwardQtyMilli: number
  /** Total value consumed by outward movements — the COGS of this walk. */
  consumedValue: number
}

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
export function valueStock(
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

/**
 * Split an additional cost (manufacture freight/labour, task 79) across produced-line base
 * amounts pro-rata, conserving every paisa (largest-remainder rounding; equal split when all
 * bases are zero). Returns one share per base, summing exactly to `extra`.
 */
export function allocateAdditionalCost(bases: number[], extra: number): number[] {
  if (bases.length === 0) return []
  const total = bases.reduce((s, b) => s + b, 0)
  const weights = total > 0 ? bases.map((b) => b / total) : bases.map(() => 1 / bases.length)
  const raw = weights.map((w) => w * extra)
  const shares = raw.map((r) => Math.floor(r))
  let remainder = extra - shares.reduce((s, x) => s + x, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (let k = 0; remainder > 0; k = (k + 1) % order.length) {
    shares[order[k]!.i]! += 1
    remainder -= 1
  }
  return shares
}

// ---------- batch expiry ageing (task 74) ----------

export type ExpiryBucket = 'none' | 'expired' | 'within30' | 'within90' | 'later'

/** Bucket an expiry date relative to `asOn`: strictly past = expired; ≤30 days out = within30;
 *  ≤90 = within90; else later. Null expiry = none. Dates are ISO strings (UTC midnight). */
export function expiryBucketOf(expiryDate: string | null, asOn: string): ExpiryBucket {
  if (!expiryDate) return 'none'
  if (expiryDate < asOn) return 'expired'
  const days = Math.round(
    (Date.parse(expiryDate + 'T00:00:00Z') - Date.parse(asOn + 'T00:00:00Z')) / 86400000
  )
  if (days <= 30) return 'within30'
  if (days <= 90) return 'within90'
  return 'later'
}

/** Bucket labels, ordered worst-first, so a report and a legend cannot disagree about either. */
export const EXPIRY_BUCKETS: { bucket: ExpiryBucket; label: string }[] = [
  { bucket: 'expired', label: 'Expired' },
  { bucket: 'within30', label: 'Within 30 days' },
  { bucket: 'within90', label: '31-90 days' },
  { bucket: 'later', label: 'Beyond 90 days' },
  { bucket: 'none', label: 'No expiry recorded' }
]

/** Days from `asOn` to expiry; negative once past. Null expiry has no answer. */
export function daysToExpiry(expiryDate: string | null, asOn: string): number | null {
  if (!expiryDate) return null
  return Math.round((Date.parse(expiryDate + 'T00:00:00Z') - Date.parse(asOn + 'T00:00:00Z')) / 86400000)
}

/** The buckets that are worth acting on — what "at risk" means everywhere it is reported. */
export const AT_RISK_BUCKETS = new Set<ExpiryBucket>(['expired', 'within30', 'within90'])

export interface ExpirySummaryInput {
  bucket: ExpiryBucket
  value: number
}

export interface ExpirySummaryRow {
  bucket: ExpiryBucket
  label: string
  value: number
  batches: number
}

/**
 * Value per expiry bucket, in worst-first order, with every bucket present.
 *
 * Empty buckets are kept so the shape of the report does not change from month to month — a table
 * that grows and shrinks columns is one nobody can compare against last month's printout.
 */
export function summariseExpiry(rows: ExpirySummaryInput[]): ExpirySummaryRow[] {
  return EXPIRY_BUCKETS.map(({ bucket, label }) => {
    const inBucket = rows.filter((r) => r.bucket === bucket)
    return { bucket, label, value: inBucket.reduce((s, r) => s + r.value, 0), batches: inBucket.length }
  })
}

// ---------- BOM cycle detection (task 79) ----------

export interface BomEdge {
  itemId: number
  componentId: number
}

/**
 * Would replacing `itemId`'s BOM with `newComponentIds` create a cycle through the existing
 * BOM graph? DFS from each new component following item→component edges; reaching `itemId`
 * again closes a loop. The item's own current edges are ignored — they are being replaced.
 */
export function wouldCreateBomCycle(
  itemId: number,
  newComponentIds: number[],
  existingEdges: BomEdge[]
): boolean {
  const adjacency = new Map<number, number[]>()
  for (const e of existingEdges) {
    if (e.itemId === itemId) continue // being replaced
    const list = adjacency.get(e.itemId) ?? []
    list.push(e.componentId)
    adjacency.set(e.itemId, list)
  }
  const seen = new Set<number>()
  const stack = [...newComponentIds]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node === itemId) return true
    if (seen.has(node)) continue
    seen.add(node)
    for (const next of adjacency.get(node) ?? []) stack.push(next)
  }
  return false
}
