/**
 * Pure stock valuation engine (lane I, task 70; global pass WP 2.1): chronological cost-layer
 * walk implementing FIFO layers and a perpetual moving average, plus small pure helpers for
 * physical-stock adjustments, manufacture additional-cost allocation, batch expiry ageing and
 * BOM cycle detection. No Electron, no DB — callers (src/main/services/stockAnalysis.ts et al)
 * load the movements from SQL in voucher order and hand them over.
 *
 * `runInventoryPass` values every item in ONE chronological pass so a manufacture-style
 * voucher can be costed from its own outward lines ('derived' rule, value conserved);
 * `valueStock` is the single-item walk on the same state machine.
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
 * One item's running cost position — the state machine behind both the single-item
 * `valueStock` walk and the global `runInventoryPass`. Semantics are exactly the pre-WP 2.1
 * per-item walk (pinned by valuation.test.ts and the legacy oracle):
 *
 * - `weighted_avg` — perpetual moving average: every outward removes value at the average cost
 *   at that moment. Overdraw continues at the last known average (value can go negative); an
 *   outward with nothing on hand removes zero value.
 * - `fifo` — cost layers consumed oldest-first, partial layers pro-rated with integer rounding
 *   (the layer's remaining value is exact — no drift). An overdraw is remembered as a deficit
 *   and backfilled from the next inward layer at that layer's cost (the backfill is charged to
 *   `consumedValue` when the inward arrives, not to the outward that caused the deficit).
 * - absolute (physical count) lines book the delta to the counted quantity: inward at the
 *   current average cost over everything on hand, outward as a normal consumption.
 *
 * FIFO keeps running layer totals and a head index, so every operation is O(1) amortised
 * (the old walk re-summed every layer on an absolute line and shifted the array on consume).
 */
class ItemCostState {
  inwardQtyMilli = 0
  outwardQtyMilli = 0
  consumedValue = 0
  // weighted average
  private qty = 0
  private value = 0
  // FIFO
  private layers: Layer[] = []
  private head = 0
  private layerQty = 0
  private layerValue = 0
  private deficitMilli = 0

  constructor(
    readonly method: ValuationMethod,
    openingQtyMilli: number,
    openingValue: number
  ) {
    if (method === 'weighted_avg') {
      this.qty = openingQtyMilli
      this.value = openingValue
    } else if (openingQtyMilli > 0 || openingValue !== 0) {
      this.pushLayer(openingQtyMilli, openingValue)
    }
  }

  /** Quantity on hand (negative when overdrawn). */
  get qtyMilli(): number {
    return this.method === 'weighted_avg' ? this.qty : this.layerQty - this.deficitMilli
  }

  /** Value on hand, paise. */
  get totalValue(): number {
    return this.method === 'weighted_avg' ? this.value : this.layerValue
  }

  /** Oldest open FIFO layer (null for weighted average or when no layer is open). */
  nextLayer(): { qtyMilli: number; value: number } | null {
    if (this.method !== 'fifo' || this.head >= this.layers.length) return null
    const l = this.layers[this.head]!
    return { qtyMilli: l.qtyMilli, value: l.value }
  }

  private pushLayer(qtyMilli: number, value: number): void {
    this.layers.push({ qtyMilli, value })
    this.layerQty += qtyMilli
    this.layerValue += value
  }

  /** Consume `q`; returns the cost charged now (FIFO deficit is charged later, on backfill). */
  outward(q: number): number {
    this.outwardQtyMilli += q
    if (this.method === 'weighted_avg') {
      const cost = this.qty > 0 ? Math.round((this.value * q) / this.qty) : 0
      this.qty -= q
      this.value -= cost
      this.consumedValue += cost
      return cost
    }
    let charged = 0
    let remaining = q
    while (remaining > 0 && this.head < this.layers.length) {
      const layer = this.layers[this.head]!
      if (layer.qtyMilli <= remaining) {
        remaining -= layer.qtyMilli
        charged += layer.value
        this.layerQty -= layer.qtyMilli
        this.layerValue -= layer.value
        this.head++
      } else {
        const cost = Math.round((layer.value * remaining) / layer.qtyMilli)
        layer.qtyMilli -= remaining
        layer.value -= cost
        this.layerQty -= remaining
        this.layerValue -= cost
        charged += cost
        remaining = 0
      }
    }
    this.deficitMilli += remaining
    this.consumedValue += charged
    if (this.head > 64 && this.head * 2 > this.layers.length) {
      this.layers = this.layers.slice(this.head)
      this.head = 0
    }
    return charged
  }

  inward(q: number, amount: number): void {
    this.inwardQtyMilli += q
    if (this.method === 'weighted_avg') {
      this.qty += q
      this.value += amount
      return
    }
    let qty = q
    let value = amount
    if (this.deficitMilli > 0 && qty > 0) {
      const take = Math.min(this.deficitMilli, qty)
      const cost = take === qty ? value : Math.round((value * take) / qty)
      qty -= take
      value -= cost
      this.deficitMilli -= take
      this.consumedValue += cost
    }
    if (qty > 0 || value !== 0) this.pushLayer(qty, value)
  }

  /** Physical count: pin the quantity to `countedQtyMilli`, booking the delta. */
  absolute(countedQtyMilli: number): void {
    const cur = this.qtyMilli
    const delta = countedQtyMilli - cur
    if (delta > 0) {
      const value = this.totalValue
      const cost = cur > 0 ? Math.round((value * delta) / cur) : 0
      this.inward(delta, cost)
    } else if (delta < 0) {
      this.outward(-delta)
    }
  }

  apply(m: StockMovement): void {
    if (m.isAbsolute) this.absolute(m.qtyMilli)
    else if (m.direction === 'in') this.inward(m.qtyMilli, m.amount)
    else this.outward(m.qtyMilli)
  }

  result(): ValuationResult {
    return {
      closingQtyMilli: this.qtyMilli,
      closingValue: this.totalValue,
      inwardQtyMilli: this.inwardQtyMilli,
      outwardQtyMilli: this.outwardQtyMilli,
      consumedValue: this.consumedValue
    }
  }

  clone(): ItemCostState {
    const c = new ItemCostState(this.method, 0, 0)
    c.inwardQtyMilli = this.inwardQtyMilli
    c.outwardQtyMilli = this.outwardQtyMilli
    c.consumedValue = this.consumedValue
    c.qty = this.qty
    c.value = this.value
    c.layers = this.layers.slice(this.head).map((l) => ({ ...l }))
    c.layerQty = this.layerQty
    c.layerValue = this.layerValue
    c.deficitMilli = this.deficitMilli
    return c
  }
}

/**
 * Walk `movements` (chronological) of ONE item over an opening balance and return the closing
 * position. See ItemCostState for the method semantics. Kept as the single-item entry point;
 * the global pass (runInventoryPass) uses the same state machine.
 */
export function valueStock(
  method: ValuationMethod,
  openingQtyMilli: number,
  openingValue: number,
  movements: StockMovement[]
): ValuationResult {
  const state = new ItemCostState(method, openingQtyMilli, openingValue)
  for (const m of movements) state.apply(m)
  return state.result()
}

// ---------- global inventory pass (WP 2.1) ----------

/**
 * How a voucher's inward (non-absolute) lines are valued.
 *
 * - `'stored'` — legacy/default: each inward line enters at its stored amount (plus its share of
 *   any additional cost). Every voucher saved before WP 2.2 uses this, so no existing company's
 *   figures move.
 * - `'derived'` — value conservation for manufacture: the voucher's outward lines are costed
 *   FIRST by the engine (at each item's position at that point of the pass), and
 *   Σ(that consumed cost) + additional cost is split across the voucher's inward lines pro-rata
 *   by stored amount (by quantity when every stored amount is zero; equally when quantities are
 *   zero too). The stored inward amounts then serve only as split weights.
 */
export type VoucherCostingRule = 'stored' | 'derived'

export interface VoucherCosting {
  rule: VoucherCostingRule
  /**
   * Additional cost (paise) loaded into this voucher's inward lines — freight/labour. The caller
   * resolves precedence (stockAnalysis: an explicit manufacture labour figure wins over the
   * legacy Dr-ledger-line total; they are never summed). Under `'stored'` it is split by stored
   * amount exactly as before WP 2.1 (allocateAdditionalCost) and only when positive; under
   * `'derived'` it is part of the conserved total.
   */
  additionalCostPaise?: number
}

export interface InventoryItem {
  itemId: number
  method: ValuationMethod
  openingQtyMilli: number
  openingValue: number
}

/** One inventory line in the global pass. `amount` is the stored line amount (see StockMovement). */
export interface InventoryMovement extends StockMovement {
  itemId: number
  voucherId: number
  /** ISO date. */
  date: string
  /** Caller's key (inventory_lines.id) — needed to read back per-line values. */
  lineId?: number
}

export interface InventoryPassInput {
  items: readonly InventoryItem[]
  /** Any order; the pass orders by (date, voucherId), keeping input order within a voucher —
   *  so callers pass each voucher's lines in line order. */
  movements: readonly InventoryMovement[]
  /** Per-voucher costing; a voucher absent here is `'stored'` with no additional cost. */
  costing?: ReadonlyMap<number, VoucherCosting>
}

/**
 * A point in the pass: after every movement dated before `date`, plus — on `date` itself —
 * those of vouchers with id < `voucherId` (all of that date when `voucherId` is omitted).
 * `{ date }` = "as of date, inclusive"; `{ date, voucherId: 0 }` = "before date".
 */
export interface StockPosition {
  date: string
  voucherId?: number
}

export interface DerivedVoucherCost {
  /** Σ engine cost charged by the voucher's outward (non-absolute) lines, paise. */
  consumedValue: number
  additionalCostPaise: number
  /** Σ value booked on its inward lines === consumedValue + additionalCostPaise. */
  inwardValue: number
}

export interface InventoryPassResult {
  /** Every item's position after all movements. */
  closing: Map<number, ValuationResult>
  /** One map per requested checkpoint, aligned with `checkpoints`. */
  at: Map<number, ValuationResult>[]
  /** Booked value of every inward line of a costed voucher (additional cost or derived), by
   *  lineId — lines of other vouchers entered at their stored amount. */
  inwardValueByLine: Map<number, number>
  /** Per derived voucher: the conserved cost figures. */
  derived: Map<number, DerivedVoucherCost>
}

const positionIncludes = (p: StockPosition, m: { date: string; voucherId: number }): boolean =>
  m.date < p.date || (m.date === p.date && (p.voucherId === undefined || m.voucherId < p.voucherId))

const comparePositions = (a: StockPosition, b: StockPosition): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : (a.voucherId ?? Infinity) - (b.voucherId ?? Infinity)

/**
 * Split `total` paise across `weights` pro-rata with exact integer arithmetic (largest
 * remainder, ties to the earlier line); the shares always sum to `total`. Non-positive weights
 * count as zero; all-zero weights split equally. Works for negative totals (mirror image).
 */
export function allocateExact(weights: number[], total: number): number[] {
  if (weights.length === 0) return []
  if (total < 0) return allocateExact(weights, -total).map((s) => (s === 0 ? 0 : -s))
  let w = weights.map((x) => BigInt(Math.max(0, Math.trunc(x))))
  let sum = w.reduce((s, x) => s + x, 0n)
  if (sum === 0n) {
    w = weights.map(() => 1n)
    sum = BigInt(weights.length)
  }
  const T = BigInt(total)
  const shares = w.map((x) => (x * T) / sum)
  let remainder = T - shares.reduce((s, x) => s + x, 0n)
  const order = w
    .map((x, i) => ({ i, frac: (x * T) % sum }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i))
  for (let k = 0; remainder > 0n; k = (k + 1) % order.length) {
    shares[order[k]!.i]! += 1n
    remainder -= 1n
  }
  return shares.map(Number)
}

/** Order by (date, voucherId), stable — keeps the caller's line order within a voucher. */
function orderMovements(movements: readonly InventoryMovement[]): readonly InventoryMovement[] {
  for (let i = 1; i < movements.length; i++) {
    const a = movements[i - 1]!
    const b = movements[i]!
    if (a.date > b.date || (a.date === b.date && a.voucherId > b.voucherId)) {
      return [...movements].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.voucherId - y.voucherId))
    }
  }
  return movements
}

const isPlainInward = (m: StockMovement): boolean => m.direction === 'in' && !m.isAbsolute

/** The pass engine: item states advanced voucher by voucher, with checkpoint capture. */
class InventoryPass {
  readonly states = new Map<number, ItemCostState>()
  readonly inwardValueByLine = new Map<number, number>()
  readonly derived = new Map<number, DerivedVoucherCost>()

  constructor(private readonly input: InventoryPassInput) {
    for (const it of input.items) {
      this.states.set(it.itemId, new ItemCostState(it.method, it.openingQtyMilli, it.openingValue))
    }
  }

  state(itemId: number): ItemCostState {
    let s = this.states.get(itemId)
    if (!s) {
      s = new ItemCostState('weighted_avg', 0, 0)
      this.states.set(itemId, s)
    }
    return s
  }

  snapshot(): Map<number, ValuationResult> {
    const out = new Map<number, ValuationResult>()
    for (const [id, s] of this.states) out.set(id, s.result())
    return out
  }

  /**
   * Advance through the movements. `checkpoints` (sorted) get a snapshot as the pass crosses
   * them; with `until`, the pass stops at that position. `skipVoucherId` drops one voucher's
   * movements entirely (pricing an edit of it).
   */
  run(
    checkpoints: { p: StockPosition; onReach: () => void }[] = [],
    until?: StockPosition,
    skipVoucherId?: number
  ): void {
    const moves = orderMovements(this.input.movements)
    const costing = this.input.costing
    let ci = 0
    let i = 0
    while (i < moves.length) {
      const first = moves[i]!
      while (ci < checkpoints.length && !positionIncludes(checkpoints[ci]!.p, first)) checkpoints[ci++]!.onReach()
      if (until && !positionIncludes(until, first)) return
      let j = i + 1
      while (j < moves.length && moves[j]!.voucherId === first.voucherId) j++
      if (first.voucherId !== skipVoucherId) {
        const c = costing?.get(first.voucherId)
        if (c && c.rule === 'derived') this.applyDerived(moves, i, j, c)
        else if (c && (c.additionalCostPaise ?? 0) > 0) this.applyStoredWithExtra(moves, i, j, c.additionalCostPaise!)
        else for (let k = i; k < j; k++) this.state(moves[k]!.itemId).apply(moves[k]!)
      }
      i = j
    }
    while (ci < checkpoints.length) checkpoints[ci++]!.onReach()
  }

  /** Legacy additional-cost loading: split by stored amount via allocateAdditionalCost. */
  private applyStoredWithExtra(moves: readonly InventoryMovement[], from: number, to: number, extra: number): void {
    const inward: number[] = []
    for (let k = from; k < to; k++) if (isPlainInward(moves[k]!)) inward.push(k)
    const shares = allocateAdditionalCost(inward.map((k) => moves[k]!.amount), extra)
    const shareAt = new Map(inward.map((k, n) => [k, shares[n]!]))
    for (let k = from; k < to; k++) {
      const m = moves[k]!
      const share = shareAt.get(k)
      if (share === undefined) {
        this.state(m.itemId).apply(m)
      } else {
        const value = m.amount + share
        this.state(m.itemId).inward(m.qtyMilli, value)
        if (m.lineId !== undefined) this.inwardValueByLine.set(m.lineId, value)
      }
    }
  }

  /** Value conservation: outward lines first, then inward lines carry their cost + extra. */
  private applyDerived(moves: readonly InventoryMovement[], from: number, to: number, c: VoucherCosting): void {
    const inward: InventoryMovement[] = []
    let consumed = 0
    for (let k = from; k < to; k++) {
      const m = moves[k]!
      if (isPlainInward(m)) inward.push(m)
      else if (m.isAbsolute) this.state(m.itemId).absolute(m.qtyMilli)
      else consumed += this.state(m.itemId).outward(m.qtyMilli)
    }
    const additional = c.additionalCostPaise ?? 0
    const total = consumed + additional
    const byAmount = inward.some((m) => m.amount > 0)
    const shares = allocateExact(inward.map((m) => (byAmount ? m.amount : m.qtyMilli)), total)
    inward.forEach((m, n) => {
      const value = shares[n]!
      this.state(m.itemId).inward(m.qtyMilli, value)
      if (m.lineId !== undefined) this.inwardValueByLine.set(m.lineId, value)
    })
    this.derived.set(moves[from]!.voucherId, {
      consumedValue: consumed,
      additionalCostPaise: additional,
      inwardValue: inward.length > 0 ? total : 0
    })
  }
}

/**
 * ONE chronological pass over every item's movements (WP 2.1). Items are independent except
 * through `'derived'` vouchers, whose inward value is the engine cost of their own outward
 * lines; since the pass is chronological, a derived voucher's figures depend only on what
 * precedes it — so a checkpoint's snapshot equals a pass over just the movements up to it.
 *
 * Ordering: (date, voucherId), then the caller's line order within a voucher — except that a
 * `'derived'` voucher processes its outward (and absolute) lines before its inward lines.
 * `'stored'` vouchers keep their exact line order, which is what makes every legacy figure
 * byte-identical to the old per-item walk (a stock journal that lists an item inward before
 * outward would otherwise re-cost). O(n) when the input is already ordered (the DB query
 * orders it), O(n log n) otherwise.
 */
export function runInventoryPass(input: InventoryPassInput, checkpoints: StockPosition[] = []): InventoryPassResult {
  const pass = new InventoryPass(input)
  const at: Map<number, ValuationResult>[] = new Array(checkpoints.length)
  const sorted = checkpoints
    .map((p, i) => ({ p, onReach: () => (at[i] = pass.snapshot()) }))
    .sort((a, b) => comparePositions(a.p, b.p))
  pass.run(sorted)
  return { closing: pass.snapshot(), at, inwardValueByLine: pass.inwardValueByLine, derived: pass.derived }
}

/**
 * The value booked on each inward line of a costed voucher (as `inwardValueByLine` of
 * runInventoryPass). Stored-rule values depend only on the voucher itself (stored amount + its
 * share of additional cost), so when nothing is `'derived'` no pass is needed and `movements`
 * may hold just the costed vouchers' lines; otherwise this runs the full pass.
 */
export function bookedInwardValues(input: InventoryPassInput): Map<number, number> {
  const costing = input.costing
  if (!costing || costing.size === 0) return new Map()
  for (const c of costing.values()) if (c.rule === 'derived') return runInventoryPass(input).inwardValueByLine
  const byVoucher = new Map<number, InventoryMovement[]>()
  for (const m of input.movements) {
    if (!isPlainInward(m) || !costing.has(m.voucherId)) continue
    const list = byVoucher.get(m.voucherId)
    if (list) list.push(m)
    else byVoucher.set(m.voucherId, [m])
  }
  const out = new Map<number, number>()
  for (const [voucherId, lines] of byVoucher) {
    const extra = costing.get(voucherId)!.additionalCostPaise ?? 0
    if (extra <= 0) continue
    const shares = allocateAdditionalCost(lines.map((m) => m.amount), extra)
    lines.forEach((m, n) => {
      if (m.lineId !== undefined) out.set(m.lineId, m.amount + shares[n]!)
    })
  }
  return out
}

/** An item's cost position at a point of the pass — exact engine figures. */
export interface StockCostPosition {
  itemId: number
  method: ValuationMethod
  /** On hand (negative when overdrawn), thousandths. */
  qtyMilli: number
  /** Value on hand, paise. */
  value: number
  /** Running average over everything on hand for ONE whole unit (1000 thousandths):
   *  round(value × 1000 / qty), 0 when nothing is on hand. Under weighted average this is
   *  exactly what the engine charges for one unit taken now. */
  averageCostPerUnitPaise: number
  /** What the engine would charge, right now, for taking exactly one whole unit (FIFO walks
   *  the layers; weighted average = averageCostPerUnitPaise). */
  unitCostPaise: number
  /** FIFO only: the oldest open layer (the next one consumed); null otherwise. */
  nextLayer: { qtyMilli: number; value: number; perUnitPaise: number } | null
}

/** Where to price: a position, and optionally the voucher being edited (its own existing
 *  movements are left out of the pass, and only vouchers ordered before it count). */
export interface CostAsOf {
  date: string
  /** The voucher being entered/edited. Omitted = a new voucher (after everything on `date`). */
  voucherId?: number
}

function stateAt(input: InventoryPassInput, at: CostAsOf): InventoryPass {
  const pass = new InventoryPass(input)
  pass.run([], { date: at.date, voucherId: at.voucherId }, at.voucherId)
  return pass
}

function positionOf(itemId: number, s: ItemCostState): StockCostPosition {
  const qtyMilli = s.qtyMilli
  const value = s.totalValue
  const averageCostPerUnitPaise = qtyMilli > 0 ? Math.round((value * 1000) / qtyMilli) : 0
  const layer = s.nextLayer()
  return {
    itemId,
    method: s.method,
    qtyMilli,
    value,
    averageCostPerUnitPaise,
    unitCostPaise: s.clone().outward(1000),
    nextLayer: layer
      ? { ...layer, perUnitPaise: layer.qtyMilli > 0 ? Math.round((layer.value * 1000) / layer.qtyMilli) : 0 }
      : null
  }
}

/**
 * Every requested item's (all items when `itemIds` is omitted) running cost position as of
 * `at` — the same pass the reports use, stopped at that point.
 */
export function stockCostPositionsAsOf(
  input: InventoryPassInput,
  at: CostAsOf,
  itemIds?: number[]
): StockCostPosition[] {
  const pass = stateAt(input, at)
  const ids = itemIds ?? [...pass.states.keys()]
  return ids.map((id) => positionOf(id, pass.state(id)))
}

/** A single item's running average cost per whole unit as of `at` (see StockCostPosition). */
export function averageCostAsOf(input: InventoryPassInput, itemId: number, at: CostAsOf): number {
  return stockCostPositionsAsOf(input, at, [itemId])[0]!.averageCostPerUnitPaise
}

export interface ProposedOutward {
  itemId: number
  qtyMilli: number
}

export interface ConsumptionCosting {
  /** Cost the engine would charge each line, in order (same item twice consumes sequentially). */
  lines: (ProposedOutward & { costPaise: number })[]
  totalPaise: number
}

/**
 * Price a proposed set of outward lines as of `at` without saving anything: exactly the cost a
 * `'derived'` voucher with these outward lines (in this order) would charge at that position,
 * hence exactly the inward value (before additional cost) it would book.
 */
export function costConsumption(input: InventoryPassInput, lines: ProposedOutward[], at: CostAsOf): ConsumptionCosting {
  const pass = stateAt(input, at)
  const scratch = new Map<number, ItemCostState>()
  let totalPaise = 0
  const priced = lines.map((l) => {
    let s = scratch.get(l.itemId)
    if (!s) {
      s = pass.state(l.itemId).clone()
      scratch.set(l.itemId, s)
    }
    const costPaise = s.outward(l.qtyMilli)
    totalPaise += costPaise
    return { ...l, costPaise }
  })
  return { lines: priced, totalPaise }
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
