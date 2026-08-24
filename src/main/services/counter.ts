/**
 * Counter mode: the till, the drawer, and everything a shop does with a customer standing there
 * (roadmap #376, #377, #381, #382, #383, #384).
 *
 * The arithmetic lives in `@shared/counter` and `@shared/scheme`, where it can be tested
 * exhaustively. What lives here is everything that needs the books: what an item costs, what tax
 * band it is in, which schemes are running, and — once the customer has paid — the sales voucher
 * that makes it real.
 *
 * Two decisions worth not undoing:
 *
 * The cart is priced in the MAIN process, not the renderer. A counter has to be right rather than
 * fast-looking, and the tax band, the cost and the scheme are all facts about the books; pricing
 * in the renderer would mean three round trips per keystroke or a second copy of the tax rules.
 *
 * A walk-in creates no ledger. The sale debits cash directly and the customer's name, if they
 * gave one, is recorded against the sale. A shop doing two hundred cash sales a day would
 * otherwise have two hundred new masters a day.
 */
import type { DB } from '../db/connection'
import type { CompanyInfo, StockItem } from '@shared/domain'
import {
  priceCart,
  reconcileDrawer,
  settleTender,
  type CartLineInput,
  type CartTotals,
  type DrawerReconciliation,
  type PricingMode,
  type Tender
} from '@shared/counter'
import { applyScheme, type Scheme, type SchemeApplication } from '@shared/scheme'
import { supplyTypeFor, type SupplyType } from '@shared/gst/calc'
import { todayISO } from '@shared/dates'
import { effectiveItemTax, findItem, findOrCreateLedger, getLedger } from './masters'
import { saveVoucher, IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'

// ---------- schemes (#383) ----------

interface SchemeRow {
  id: number; name: string; stock_item_id: number | null; stock_group_id: number | null
  kind: Scheme['kind']; min_qty_milli: number; percent_bp: number | null; rate_paise: number | null
  free_qty_milli: number | null; from_date: string; to_date: string | null; active: number
}

export interface DiscountScheme extends Scheme {
  name: string
}

const mapScheme = (r: SchemeRow): DiscountScheme => ({
  id: r.id,
  name: r.name,
  stockItemId: r.stock_item_id,
  stockGroupId: r.stock_group_id,
  kind: r.kind,
  minQtyMilli: r.min_qty_milli,
  percentBp: r.percent_bp,
  ratePaise: r.rate_paise,
  freeQtyMilli: r.free_qty_milli,
  fromDate: r.from_date,
  toDate: r.to_date,
  active: r.active === 1
})

export function listSchemes(db: DB): DiscountScheme[] {
  return (db.prepare('SELECT * FROM discount_schemes ORDER BY min_qty_milli, id').all() as SchemeRow[]).map(mapScheme)
}

export interface SchemeInput {
  name: string
  stockItemId?: number | null
  stockGroupId?: number | null
  kind: Scheme['kind']
  minQtyMilli: number
  percentBp?: number | null
  ratePaise?: number | null
  freeQtyMilli?: number | null
  fromDate: string
  toDate?: string | null
  active?: boolean
}

export function saveScheme(db: DB, input: SchemeInput, id?: number): DiscountScheme {
  if (!input.stockItemId && !input.stockGroupId) throw new Error('A scheme has to apply to an item or a group')
  if (input.stockItemId && input.stockGroupId) throw new Error('A scheme applies to an item or a group, not both')
  if (input.minQtyMilli <= 0) throw new Error('A scheme needs a quantity to start at')
  const args = [
    input.name, input.stockItemId ?? null, input.stockGroupId ?? null, input.kind, input.minQtyMilli,
    input.percentBp ?? null, input.ratePaise ?? null, input.freeQtyMilli ?? null,
    input.fromDate, input.toDate ?? null, input.active === false ? 0 : 1
  ]
  if (id) {
    db.prepare(
      `UPDATE discount_schemes SET name = ?, stock_item_id = ?, stock_group_id = ?, kind = ?, min_qty_milli = ?,
       percent_bp = ?, rate_paise = ?, free_qty_milli = ?, from_date = ?, to_date = ?, active = ? WHERE id = ?`
    ).run(...args, id)
  } else {
    id = Number(
      db.prepare(
        `INSERT INTO discount_schemes (name, stock_item_id, stock_group_id, kind, min_qty_milli,
          percent_bp, rate_paise, free_qty_milli, from_date, to_date, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...args).lastInsertRowid
    )
  }
  return listSchemes(db).find((s) => s.id === id)!
}

export function deleteScheme(db: DB, id: number): void {
  db.prepare('DELETE FROM discount_schemes WHERE id = ?').run(id)
}

// ---------- looking an item up at the counter (#376) ----------

export interface CounterItem {
  stockItemId: number
  name: string
  code: string | null
  groupId: number | null
  unitSymbol: string | null
  /** Sale rate per base unit, in paise. Zero when nothing has ever been sold or priced. */
  ratePaise: number
  gstRate: number
  cessRate: number
  /** Cost per base unit for the below-cost warning (#382); null when never bought. */
  costPaise: number | null
  /** Stock on hand right now, in thousandths. */
  onHandMilli: number
  schemes: DiscountScheme[]
}

/**
 * The last rate this item was actually sold at.
 *
 * A shop's real price list is its own last invoice, not a master field: the item master's rate
 * goes stale the first time somebody types over it at entry, and a counter that offers a rate
 * nobody has charged for a year is a counter the operator stops trusting.
 */
function lastSaleRate(db: DB, stockItemId: number): number {
  const row = db
    .prepare(
      `SELECT il.rate_paise AS rate FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE il.stock_item_id = ? AND il.direction = 'out' AND vt.kind = 'sales' AND ${IN_BOOKS}
       ORDER BY v.date DESC, v.id DESC LIMIT 1`
    )
    .get(stockItemId) as { rate: number } | undefined
  return row?.rate ?? 0
}

function onHand(db: DB, stockItemId: number, asOn: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(si.opening_qty_milli, 0)
         + COALESCE((SELECT SUM(CASE WHEN il.direction = 'in' THEN il.qty_milli ELSE -il.qty_milli END)
                     FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
                     WHERE il.stock_item_id = si.id AND v.date <= ? AND ${IN_BOOKS}), 0) AS qty
       FROM stock_items si WHERE si.id = ?`
    )
    .get(asOn, stockItemId) as { qty: number } | undefined
  return row?.qty ?? 0
}

/**
 * Cost of one base unit, for the below-cost warning.
 *
 * A weighted average of what has been bought, including the opening stock — deliberately NOT the
 * item's full FIFO/weighted-average valuation. Two reasons. It runs on every keystroke at a
 * counter, and re-valuing the whole movement history per line is not a thing to do while a
 * customer waits. And the question being asked is "is this price under what the goods cost",
 * which is a warning, not a figure that goes anywhere — the valuation that reaches the accounts
 * is still the item's own, computed once at report time.
 *
 * Null when the item has never been bought, which is not the same as a cost of zero: an item with
 * no purchase history cannot be sold below a cost nobody knows.
 */
function unitCost(db: DB, stockItemId: number, asOn: string): number | null {
  const row = db
    .prepare(
      `SELECT COALESCE(si.opening_qty_milli, 0) AS openQty, COALESCE(si.opening_value, 0) AS openValue,
              COALESCE((SELECT SUM(il.qty_milli) FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
                        WHERE il.stock_item_id = si.id AND il.direction = 'in' AND v.date <= ? AND ${IN_BOOKS}), 0) AS inQty,
              COALESCE((SELECT SUM(il.amount) FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
                        WHERE il.stock_item_id = si.id AND il.direction = 'in' AND v.date <= ? AND ${IN_BOOKS}), 0) AS inValue
       FROM stock_items si WHERE si.id = ?`
    )
    .get(asOn, asOn, stockItemId) as { openQty: number; openValue: number; inQty: number; inValue: number } | undefined
  if (!row) return null
  const qty = row.openQty + row.inQty
  const value = row.openValue + row.inValue
  if (qty <= 0 || value <= 0) return null
  return Math.round((value * 1000) / qty)
}

/** Everything the counter needs to know about one item on one date. */
export function itemDetail(db: DB, stockItemId: number, asOn = todayISO()): CounterItem {
  const row = db
    .prepare('SELECT si.id, si.name, si.code, si.group_id, u.symbol FROM stock_items si LEFT JOIN units u ON u.id = si.unit_id WHERE si.id = ?')
    .get(stockItemId) as { id: number; name: string; code: string | null; group_id: number | null; symbol: string | null } | undefined
  if (!row) throw new Error(`Item ${stockItemId} is not in the books`)
  const tax = effectiveItemTax(db, stockItemId)
  return {
    stockItemId: row.id,
    name: row.name,
    code: row.code,
    groupId: row.group_id,
    unitSymbol: row.symbol,
    ratePaise: lastSaleRate(db, stockItemId),
    gstRate: tax.gstRate ?? 0,
    cessRate: tax.cessRate ?? 0,
    costPaise: unitCost(db, stockItemId, asOn),
    onHandMilli: onHand(db, stockItemId, asOn),
    schemes: listSchemes(db).filter(
      (s) => s.stockItemId === row.id || (s.stockGroupId !== null && s.stockGroupId === row.group_id)
    )
  }
}

/** Find an item the way a person at a counter would: a scan, a code, or a name. */
export function lookup(db: DB, query: string, asOn = todayISO()): CounterItem | null {
  const item: StockItem | null = findItem(db, query)
  return item ? itemDetail(db, item.id, asOn) : null
}

// ---------- pricing a cart (#376, #382, #383) ----------

export interface CounterCartLineInput {
  stockItemId: number
  qtyMilli: number
  /** Typed over the suggested rate, or omitted to use the last sale rate. */
  ratePaise?: number
  /** A discount the operator typed, on top of any scheme. */
  discountPaise?: number
  /** Skip scheme matching for this line — the operator overrode it. */
  noScheme?: boolean
}

export interface CounterCartLine extends CartLineInput {
  onHandMilli: number
  scheme: SchemeApplication | null
}

export interface CounterCart extends Omit<CartTotals, 'lines'> {
  lines: (CartTotals['lines'][number] & { onHandMilli: number; scheme: SchemeApplication | null })[]
  supply: SupplyType
  pricingMode: PricingMode
  /** Lines whose quantity exceeds what is on hand — a warning, never a block: a counter cannot
   *  refuse to sell what is visibly on the shelf because a purchase bill has not been entered. */
  shortLines: { stockItemId: number; name: string; onHandMilli: number; qtyMilli: number }[]
}

export interface PriceCartInput {
  lines: CounterCartLineInput[]
  date?: string
  /** Null for a walk-in, which is the normal case (#381). */
  partyLedgerId?: number | null
  pricingMode?: PricingMode
}

export function priceCounterCart(db: DB, info: CompanyInfo, input: PriceCartInput): CounterCart {
  const date = input.date ?? todayISO()
  const mode = input.pricingMode ?? 'inclusive'
  const party = input.partyLedgerId ? getLedger(db, input.partyLedgerId) : null
  // A walk-in is standing in the shop, so the place of supply is the shop's own state.
  const supply = supplyTypeFor(info.stateCode, party?.stateCode ?? info.stateCode)
  const schemes = listSchemes(db)

  const prepared: CounterCartLine[] = input.lines.map((l) => {
    const detail = itemDetail(db, l.stockItemId, date)
    const rate = l.ratePaise ?? detail.ratePaise
    const scheme = l.noScheme
      ? null
      : applyScheme(l.qtyMilli, rate, schemes, {
          on: date,
          stockItemId: l.stockItemId,
          stockGroupId: detail.groupId
        })
    return {
      stockItemId: l.stockItemId,
      name: detail.name,
      code: detail.code,
      // A "free" scheme raises the billed quantity so the free unit still leaves stock.
      qtyMilli: scheme?.billedQtyMilli ?? l.qtyMilli,
      ratePaise: scheme?.ratePaise ?? rate,
      gstRate: detail.gstRate,
      cessRate: detail.cessRate,
      discountPaise: (scheme?.discountPaise ?? 0) + (l.discountPaise ?? 0),
      costPaise: detail.costPaise,
      onHandMilli: detail.onHandMilli,
      scheme
    }
  })

  const totals = priceCart(prepared, supply, mode)
  return {
    ...totals,
    lines: totals.lines.map((l, i) => ({ ...l, onHandMilli: prepared[i]!.onHandMilli, scheme: prepared[i]!.scheme })),
    supply,
    pricingMode: mode,
    shortLines: prepared
      .filter((l) => l.qtyMilli > l.onHandMilli)
      .map((l) => ({ stockItemId: l.stockItemId, name: l.name, onHandMilli: l.onHandMilli, qtyMilli: l.qtyMilli }))
  }
}

// ---------- the drawer (#377) ----------

export interface CounterSession {
  id: number
  openedOn: string
  openedAt: string
  operator: string | null
  openingFloatPaise: number
  cashLedgerId: number | null
  closedAt: string | null
  countedPaise: number | null
  variancePaise: number | null
  notes: string | null
}

interface SessionRow {
  id: number; opened_on: string; opened_at: string; operator: string | null; opening_float: number
  cash_ledger_id: number | null; closed_at: string | null; counted_paise: number | null
  variance_paise: number | null; notes: string | null
}

const mapSession = (r: SessionRow): CounterSession => ({
  id: r.id,
  openedOn: r.opened_on,
  openedAt: r.opened_at,
  operator: r.operator,
  openingFloatPaise: r.opening_float,
  cashLedgerId: r.cash_ledger_id,
  closedAt: r.closed_at,
  countedPaise: r.counted_paise,
  variancePaise: r.variance_paise,
  notes: r.notes
})

/** The session the till is currently trading on, if any. */
export function openSession(db: DB): CounterSession | null {
  const row = db.prepare('SELECT * FROM counter_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get() as SessionRow | undefined
  return row ? mapSession(row) : null
}

export function listSessions(db: DB, limit = 60): CounterSession[] {
  return (db.prepare('SELECT * FROM counter_sessions ORDER BY id DESC LIMIT ?').all(limit) as SessionRow[]).map(mapSession)
}

export function openDrawer(
  db: DB,
  input: { openedOn?: string; operator?: string | null; openingFloatPaise: number; cashLedgerId?: number | null }
): CounterSession {
  const already = openSession(db)
  // One drawer at a time. Two open sessions cannot both be right about what is in the till, and
  // the variance would be meaningless for both.
  if (already) throw new Error(`The till is already open (since ${already.openedAt}) — close it before opening another`)
  if (input.openingFloatPaise < 0) throw new Error('A float cannot be negative')
  const cashLedgerId = input.cashLedgerId ?? findOrCreateLedger(db, 'Cash', 'Cash-in-Hand')
  const id = Number(
    db
      .prepare('INSERT INTO counter_sessions (opened_on, operator, opening_float, cash_ledger_id) VALUES (?, ?, ?, ?)')
      .run(input.openedOn ?? todayISO(), input.operator ?? null, input.openingFloatPaise, cashLedgerId).lastInsertRowid
  )
  const session = openSession(db)!
  writeAudit(db, 'counter_session', id, 'create', null, session)
  return session
}

export interface DrawerMovement {
  id: number
  sessionId: number
  at: string
  kind: 'payin' | 'payout'
  amountPaise: number
  reason: string | null
}

export function recordMovement(
  db: DB,
  sessionId: number,
  kind: 'payin' | 'payout',
  amountPaise: number,
  reason: string | null
): DrawerMovement {
  if (amountPaise <= 0) throw new Error('A drawer movement needs an amount')
  const session = db.prepare('SELECT closed_at FROM counter_sessions WHERE id = ?').get(sessionId) as { closed_at: string | null } | undefined
  if (!session) throw new Error('No such till session')
  if (session.closed_at) throw new Error('That session is closed — its count has already been taken')
  const id = Number(
    db.prepare('INSERT INTO counter_movements (session_id, kind, amount, reason) VALUES (?, ?, ?, ?)')
      .run(sessionId, kind, amountPaise, reason).lastInsertRowid
  )
  return db.prepare('SELECT id, session_id AS sessionId, at, kind, amount AS amountPaise, reason FROM counter_movements WHERE id = ?').get(id) as DrawerMovement
}

export interface SessionSummary {
  session: CounterSession
  drawer: DrawerReconciliation
  sales: number
  returns: number
  /** Takings by tender mode, so the card machine's own settlement can be checked against it. */
  byMode: { mode: string; amountPaise: number }[]
  movements: DrawerMovement[]
  /** Total sale value rung up, whatever it was paid with. */
  turnoverPaise: number
}

/**
 * What the drawer should hold, and what it took.
 *
 * Cash movements are read from the tenders rather than from the cash ledger: the ledger also
 * carries every other cash entry the business made that day, and a till is only answerable for
 * what went through it.
 */
export function sessionSummary(db: DB, sessionId: number): SessionSummary {
  const row = db.prepare('SELECT * FROM counter_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined
  if (!row) throw new Error('No such till session')
  const session = mapSession(row)

  const tenders = db
    .prepare(
      `SELECT t.mode, cs.kind, SUM(t.amount) AS amount, SUM(cs.change_paise) AS change
       FROM counter_tenders t JOIN counter_sales cs ON cs.id = t.counter_sale_id
       WHERE cs.session_id = ? GROUP BY t.mode, cs.kind`
    )
    .all(sessionId) as { mode: string; kind: string; amount: number; change: number }[]

  const cashSales = tenders.filter((t) => t.mode === 'cash' && t.kind === 'sale').reduce((s, t) => s + t.amount - t.change, 0)
  const cashRefunds = tenders.filter((t) => t.mode === 'cash' && t.kind === 'return').reduce((s, t) => s + t.amount, 0)

  const movements = db
    .prepare('SELECT id, session_id AS sessionId, at, kind, amount AS amountPaise, reason FROM counter_movements WHERE session_id = ? ORDER BY id')
    .all(sessionId) as DrawerMovement[]

  const counts = db
    .prepare("SELECT kind, COUNT(*) AS n FROM counter_sales WHERE session_id = ? GROUP BY kind")
    .all(sessionId) as { kind: string; n: number }[]

  const turnover = db
    .prepare(
      `SELECT COALESCE(SUM(vl.amount), 0) AS total FROM counter_sales cs
       JOIN voucher_lines vl ON vl.voucher_id = cs.voucher_id
       WHERE cs.session_id = ? AND cs.kind = 'sale' AND vl.dr_cr = 'dr'`
    )
    .get(sessionId) as { total: number }

  const drawer = reconcileDrawer(
    {
      openingFloatPaise: session.openingFloatPaise,
      cashSalesPaise: cashSales,
      cashRefundsPaise: cashRefunds,
      payoutsPaise: movements.filter((m) => m.kind === 'payout').reduce((s, m) => s + m.amountPaise, 0),
      payinsPaise: movements.filter((m) => m.kind === 'payin').reduce((s, m) => s + m.amountPaise, 0)
    },
    session.countedPaise
  )

  const byMode = new Map<string, number>()
  for (const t of tenders) {
    byMode.set(t.mode, (byMode.get(t.mode) ?? 0) + (t.kind === 'return' ? -t.amount : t.amount - t.change))
  }

  return {
    session,
    drawer,
    sales: counts.find((c) => c.kind === 'sale')?.n ?? 0,
    returns: counts.find((c) => c.kind === 'return')?.n ?? 0,
    byMode: [...byMode.entries()].map(([mode, amountPaise]) => ({ mode, amountPaise })),
    movements,
    turnoverPaise: turnover.total
  }
}

/** Count the drawer and close it. The variance is stored as counted, never recomputed later. */
export function closeDrawer(db: DB, sessionId: number, countedPaise: number, notes: string | null): SessionSummary {
  const before = sessionSummary(db, sessionId)
  if (before.session.closedAt) throw new Error('That session has already been closed')
  if (countedPaise < 0) throw new Error('A drawer cannot hold less than nothing')
  const variance = countedPaise - before.drawer.expectedPaise
  db.prepare("UPDATE counter_sessions SET closed_at = datetime('now'), counted_paise = ?, variance_paise = ?, notes = ? WHERE id = ?")
    .run(countedPaise, variance, notes, sessionId)
  const after = sessionSummary(db, sessionId)
  writeAudit(db, 'counter_session', sessionId, 'update', before.session, after.session)
  return after
}

// ---------- posting a sale (#376, #381, #384) ----------

export interface CounterSaleInput {
  lines: CounterCartLineInput[]
  tenders: Tender[]
  date?: string
  pricingMode?: PricingMode
  /** Null for a walk-in. Required when any part of the tender is credit. */
  partyLedgerId?: number | null
  customerName?: string | null
  customerPhone?: string | null
  narration?: string | null
  /** The sale being returned, for a counter return. */
  returnsVoucherId?: number | null
  /** 'sale' posts a sales voucher; 'return' posts a credit note. */
  kind?: 'sale' | 'return'
}

export interface CounterSaleResult {
  counterSaleId: number
  voucherId: number
  number: string
  cart: CounterCart
  tender: ReturnType<typeof settleTender>
  sessionId: number | null
}

function taxLedgerId(db: DB, taxType: 'cgst' | 'sgst' | 'igst' | 'cess'): number {
  const existing = db.prepare('SELECT id FROM ledgers WHERE tax_type = ?').get(taxType) as { id: number } | undefined
  if (existing) return existing.id
  const id = findOrCreateLedger(db, taxType.toUpperCase(), 'Duties & Taxes')
  db.prepare('UPDATE ledgers SET tax_type = ? WHERE id = ?').run(taxType, id)
  return id
}

const MODE_LEDGERS: Record<string, { name: string; group: string }> = {
  cash: { name: 'Cash', group: 'Cash-in-Hand' },
  // Card and UPI settle into the bank a day or two later; until then they are money owed to the
  // shop by the acquirer, not money in the till. Booking them to cash makes the drawer short by
  // the card takings every single evening.
  card: { name: 'Card Settlement', group: 'Bank Accounts' },
  upi: { name: 'UPI Settlement', group: 'Bank Accounts' }
}

/**
 * Ring the sale up and post it.
 *
 * This is the one place in the app that posts without a human looking at a draft first, and it is
 * deliberate: a counter sale IS the confirmation — the customer has paid and walked out. The
 * drafts elsewhere exist because a depreciation journal is a judgement; a bill is not.
 */
export function saveCounterSale(db: DB, info: CompanyInfo, input: CounterSaleInput): CounterSaleResult {
  const kind = input.kind ?? 'sale'
  const date = input.date ?? todayISO()
  const cart = priceCounterCart(db, info, {
    lines: input.lines,
    date,
    partyLedgerId: input.partyLedgerId,
    pricingMode: input.pricingMode
  })
  if (cart.lines.length === 0) throw new Error('There is nothing in the cart')

  const tender = settleTender(cart.payablePaise, input.tenders)
  if (tender.shortPaise > 0) throw new Error(`The tender is short by ₹${(tender.shortPaise / 100).toFixed(2)}`)
  if (tender.creditPaise > 0 && !input.partyLedgerId) {
    // Credit without a party is an amount nobody owes: there is no ledger to carry the balance.
    throw new Error('Somebody has to owe the credit — pick a party, or take the money')
  }

  const voucherTypeKind = kind === 'sale' ? 'sales' : 'credit_note'
  const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY is_system DESC, id LIMIT 1').get(voucherTypeKind) as { id: number } | undefined
  if (!vt) throw new Error(`No ${voucherTypeKind} voucher type in these books`)

  const salesLedgerId = findOrCreateLedger(db, 'Sales Account', 'Sales Accounts')
  // On a sale the party/money side is debited; a return runs every line the other way.
  const moneySide = kind === 'sale' ? 'dr' : 'cr'
  const incomeSide = kind === 'sale' ? 'cr' : 'dr'

  const lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number; costAllocations: [] }[] = []
  for (const t of input.tenders) {
    const settled = t.mode === 'cash' ? t.amountPaise - tender.changePaise : t.amountPaise
    if (settled <= 0) continue
    if (t.mode === 'credit') {
      lines.push({ ledgerId: input.partyLedgerId!, drCr: moneySide, amount: settled, costAllocations: [] })
    } else {
      const spec = MODE_LEDGERS[t.mode]!
      lines.push({ ledgerId: findOrCreateLedger(db, spec.name, spec.group), drCr: moneySide, amount: settled, costAllocations: [] })
    }
  }
  lines.push({ ledgerId: salesLedgerId, drCr: incomeSide, amount: cart.gst.taxable, costAllocations: [] })
  if (cart.gst.cgst > 0) lines.push({ ledgerId: taxLedgerId(db, 'cgst'), drCr: incomeSide, amount: cart.gst.cgst, costAllocations: [] })
  if (cart.gst.sgst > 0) lines.push({ ledgerId: taxLedgerId(db, 'sgst'), drCr: incomeSide, amount: cart.gst.sgst, costAllocations: [] })
  if (cart.gst.igst > 0) lines.push({ ledgerId: taxLedgerId(db, 'igst'), drCr: incomeSide, amount: cart.gst.igst, costAllocations: [] })
  if (cart.gst.cess > 0) lines.push({ ledgerId: taxLedgerId(db, 'cess'), drCr: incomeSide, amount: cart.gst.cess, costAllocations: [] })
  if (cart.roundOffPaise !== 0) {
    const roundOff = findOrCreateLedger(db, 'Round Off', 'Indirect Expenses')
    // A round-up is extra income to the shop, a round-down an expense — and the sides swap again
    // on a return, which is why this is derived rather than written out twice.
    const up = cart.roundOffPaise > 0
    lines.push({ ledgerId: roundOff, drCr: up ? incomeSide : moneySide, amount: Math.abs(cart.roundOffPaise), costAllocations: [] })
  }

  const session = openSession(db)
  const result = db.transaction((): CounterSaleResult => {
    const voucher = saveVoucher(db, {
      voucherTypeId: vt.id,
      date,
      partyLedgerId: input.partyLedgerId ?? null,
      narration: input.narration ?? (input.customerName ? `Counter ${kind} — ${input.customerName}` : `Counter ${kind}`),
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      currencyCode: null,
      exchangeRate: null,
      lines,
      inventory: cart.lines.map((l) => ({
        stockItemId: l.stockItemId,
        godownId: null,
        qtyMilli: l.qtyMilli,
        ratePaise: l.ratePaise,
        discountPaise: l.discountPaise ?? 0,
        amount: l.taxablePaise,
        direction: kind === 'sale' ? ('out' as const) : ('in' as const)
      })),
      billRefs: [],
      tds: null
    })

    const saleId = Number(
      db
        .prepare(
          `INSERT INTO counter_sales (session_id, voucher_id, customer_name, customer_phone, change_paise, kind, returns_voucher_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          session?.id ?? null, voucher.id, input.customerName ?? null, input.customerPhone ?? null,
          tender.changePaise, kind, input.returnsVoucherId ?? null
        ).lastInsertRowid
    )
    const insertTender = db.prepare('INSERT INTO counter_tenders (counter_sale_id, mode, amount, reference) VALUES (?, ?, ?, ?)')
    for (const t of input.tenders) insertTender.run(saleId, t.mode, t.amountPaise, null)

    return {
      counterSaleId: saleId,
      voucherId: voucher.id,
      number: voucher.number,
      cart,
      tender,
      sessionId: session?.id ?? null
    }
  })()

  writeAudit(db, 'counter_sale', result.counterSaleId, 'create', null, {
    voucherId: result.voucherId,
    total: cart.payablePaise,
    kind
  })
  return result
}

// ---------- what the second screen shows (#385) ----------

export interface CustomerDisplay {
  companyName: string
  lines: { name: string; qty: string; amount: number }[]
  payablePaise: number
  savedPaise: number
  message: string
}

/**
 * The customer-facing view of the cart.
 *
 * Built here rather than in the renderer so the second screen and the operator's screen can never
 * disagree about the total — which is the entire reason a shop puts a second screen up.
 */
export function customerDisplay(cart: CounterCart, companyName: string): CustomerDisplay {
  const saved = cart.lines.reduce((s, l) => s + (l.scheme?.savedPaise ?? 0), 0)
  return {
    companyName,
    lines: cart.lines.map((l) => ({
      name: l.name,
      qty: (l.qtyMilli / 1000).toString(),
      amount: l.totalPaise
    })),
    payablePaise: cart.payablePaise,
    savedPaise: saved,
    message: saved > 0 ? `You saved ₹${(saved / 100).toFixed(2)}` : ''
  }
}

// ---------- returns at the counter (#384) ----------

export interface ReturnableSale {
  voucherId: number
  number: string
  date: string
  totalPaise: number
  customerName: string | null
  lines: { stockItemId: number; name: string; qtyMilli: number; ratePaise: number }[]
}

/** Find the sale behind a receipt, so a return does not have to be re-typed from the goods. */
export function findSaleForReturn(db: DB, numberOrPhone: string): ReturnableSale | null {
  const row = db
    .prepare(
      `SELECT v.id, v.number, v.date, cs.customer_name
       FROM counter_sales cs JOIN vouchers v ON v.id = cs.voucher_id
       WHERE cs.kind = 'sale' AND (v.number = ? COLLATE NOCASE OR cs.customer_phone = ?) AND ${IN_BOOKS}
       ORDER BY v.date DESC, v.id DESC LIMIT 1`
    )
    .get(numberOrPhone, numberOrPhone) as { id: number; number: string; date: string; customer_name: string | null } | undefined
  if (!row) return null

  const lines = db
    .prepare(
      `SELECT il.stock_item_id AS stockItemId, si.name, il.qty_milli AS qtyMilli, il.rate_paise AS ratePaise
       FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id
       WHERE il.voucher_id = ? ORDER BY il.id`
    )
    .all(row.id) as ReturnableSale['lines']

  const total = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS t FROM voucher_lines WHERE voucher_id = ? AND dr_cr = 'dr'")
    .get(row.id) as { t: number }

  return { voucherId: row.id, number: row.number, date: row.date, totalPaise: total.t, customerName: row.customer_name, lines }
}

// ---------- the day at the till ----------

export interface CounterSaleRow {
  id: number
  voucherId: number
  number: string
  date: string
  kind: 'sale' | 'return'
  customerName: string | null
  totalPaise: number
  changePaise: number
  modes: string
}

export function listCounterSales(db: DB, sessionId?: number, limit = 200): CounterSaleRow[] {
  const where = sessionId ? 'cs.session_id = ?' : '1 = 1'
  const args: unknown[] = sessionId ? [sessionId, limit] : [limit]
  return db
    .prepare(
      `SELECT cs.id, cs.voucher_id AS voucherId, v.number, v.date, cs.kind,
              cs.customer_name AS customerName, cs.change_paise AS changePaise,
              (SELECT COALESCE(SUM(t.amount), 0) FROM counter_tenders t WHERE t.counter_sale_id = cs.id) AS totalPaise,
              (SELECT GROUP_CONCAT(DISTINCT t.mode) FROM counter_tenders t WHERE t.counter_sale_id = cs.id) AS modes
       FROM counter_sales cs JOIN vouchers v ON v.id = cs.voucher_id
       WHERE ${where} AND ${IN_BOOKS}
       ORDER BY cs.id DESC LIMIT ?`
    )
    .all(...args) as CounterSaleRow[]
}
