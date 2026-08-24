import type { DB } from '../db/connection'
import type {
  BalanceSheet, CashSparkPoint, DashboardData, DayBookRow, DayBookTypeRow, ExceptionRow, ExceptionSection, ExceptionsReport,
  PurchaseSuggestionRow,
  ItemProfitRow, LedgerStatement, LedgerStatementRow,
  ProfitAndLoss, StatementNode, StockAgeingRow, StockSummaryRow, TopLedgerRow, TrialBalance
} from '@shared/reports'
import type { Group, Nature } from '@shared/domain'
import { listGroups } from './masters'
import { CASH_BANK_GROUPS } from '@shared/seed'
import { ageStock, buildCashFlow, computeRatios, type CashFlowStatement, type InwardLot } from '@shared/reportMath'
import { periodKey, periodLabel, periodRange, type Period } from '@shared/period'
import { todayISO } from '@shared/dates'
import type { CompanyInfo } from '@shared/domain'
import { itcRisk } from '@shared/gst/itcAgeing'
import { describeGap, gapSize, numberGaps } from '@shared/numberSeries'
import { computeTcs, tcsAppliesToSeller, TCS_THRESHOLD_PAISE } from '@shared/tcs'
import { fyOf } from '@shared/dates'
import { listVouchers, IN_BOOKS, NOT_DELETED } from './vouchers'
import * as stockAnalysis from './stockAnalysis'

// ---------- shared helpers ----------

/** Signed movement (dr positive) per ledger over an inclusive date range. */
function movements(db: DB, from: string, to: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT vl.ledger_id AS id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} GROUP BY vl.ledger_id`
    )
    .all(from, to) as { id: number; m: number }[]
  return new Map(rows.map((r) => [r.id, r.m]))
}

/** Signed closing balance (opening + movement ≤ asOn) per ledger — one grouped scan of
 *  voucher_lines (same shape as masters.ledgerBalances) instead of a correlated subquery
 *  per ledger row. */
function closingBalances(db: DB, asOn: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT l.id, l.opening_balance + COALESCE(m.movement, 0) AS bal
       FROM ledgers l
       LEFT JOIN (
         SELECT vl.ledger_id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS movement
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE v.date <= ? AND ${IN_BOOKS}
         GROUP BY vl.ledger_id
       ) m ON m.ledger_id = l.id`
    )
    .all(asOn) as { id: number; bal: number }[]
  return new Map(rows.map((r) => [r.id, r.bal]))
}

interface LedgerLite { id: number; name: string; groupId: number; openingBalance: number }

function ledgersLite(db: DB): LedgerLite[] {
  return (db.prepare('SELECT id, name, group_id AS groupId, opening_balance AS openingBalance FROM ledgers').all() as LedgerLite[])
}

/**
 * Build StatementNode trees for the top-level groups matching a predicate.
 * `amountOf(ledgerId)` supplies the signed (dr-positive) figure; `sign` flips for credit-natured sides.
 */
function buildTrees(
  groups: Group[],
  ledgers: LedgerLite[],
  predicate: (g: Group) => boolean,
  amountOf: (ledgerId: number) => number,
  sign: 1 | -1
): StatementNode[] {
  const byParent = new Map<number | null, Group[]>()
  for (const g of groups) {
    const list = byParent.get(g.parentId) ?? []
    list.push(g)
    byParent.set(g.parentId, list)
  }
  const ledgersByGroup = new Map<number, LedgerLite[]>()
  for (const l of ledgers) {
    const list = ledgersByGroup.get(l.groupId) ?? []
    list.push(l)
    ledgersByGroup.set(l.groupId, list)
  }

  function buildGroupNode(g: Group): StatementNode {
    const children: StatementNode[] = []
    for (const l of ledgersByGroup.get(g.id) ?? []) {
      const amount = sign * amountOf(l.id)
      if (amount !== 0) children.push({ id: l.id, kind: 'ledger', name: l.name, amount, children: [] })
    }
    for (const sub of byParent.get(g.id) ?? []) {
      const node = buildGroupNode(sub)
      if (node.amount !== 0 || node.children.length) children.push(node)
    }
    children.sort((a, b) => a.name.localeCompare(b.name))
    const amount = children.reduce((s, c) => s + c.amount, 0)
    return { id: g.id, kind: 'group', name: g.name, amount, children }
  }

  return (byParent.get(null) ?? [])
    .filter(predicate)
    .map(buildGroupNode)
    .filter((n) => n.amount !== 0 || n.children.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

const sumNodes = (nodes: StatementNode[]): number => nodes.reduce((s, n) => s + n.amount, 0)

// ---------- stock valuation ----------
// v0.3 integration (pre-ruled reconciliation): reports-level stock figures delegate to lane I's
// valuation engine (src/main/services/stockAnalysis.ts → src/shared/valuation.ts), which honours
// each item's valuation_method (FIFO vs weighted average), physical-stock absolute lines and
// stock-journal additional-cost loading. Row shape stays the #64 opening/inwards split.

export function stockSummary(db: DB, asOn: string): StockSummaryRow[] {
  return stockAnalysis.stockSummary(db, asOn)
}

export function stockValue(db: DB, asOn: string): number {
  return stockAnalysis.stockValue(db, asOn)
}

/** Stock ageing + reorder report (v0.3 #58): where the held quantity came from (by inward
 *  date, newest first), whether the item has gone stale, and reorder-level breaches. */
/**
 * What to buy, from whom, and roughly for how much.
 *
 * The stock summary already flags an item below its reorder level, and a flag is not an action:
 * turning it into one takes the shortfall, the last supplier and the last price, which otherwise
 * means opening three screens before picking up the phone.
 *
 * Built on `stockAgeing` rather than a parallel query, so "below reorder" means exactly what the
 * stock summary means by it. An item with no reorder level set is not a suggestion — it is an
 * item nobody has expressed an opinion about, and inventing a level would be inventing the
 * opinion too.
 */
export function purchaseSuggestions(db: DB, asOn: string): PurchaseSuggestionRow[] {
  const below = stockAgeing(db, asOn).filter((r) => r.belowReorder && r.reorderLevelMilli != null)
  if (below.length === 0) return []

  const ids = below.map((r) => r.stockItemId)
  const placeholders = ids.map(() => '?').join(',')

  // The most recent purchase line per item, with the party it came from. Rate is stored per
  // whole unit, so it carries across to a different quantity without conversion.
  const lastPurchases = new Map(
    (
      db
        .prepare(
          `SELECT il.stock_item_id AS stockItemId, v.date, il.rate_paise AS ratePaise,
                  l.id AS ledgerId, l.name AS supplier
           FROM inventory_lines il
           JOIN vouchers v ON v.id = il.voucher_id
           JOIN voucher_types vt ON vt.id = v.voucher_type_id
           LEFT JOIN ledgers l ON l.id = v.party_ledger_id
           WHERE vt.kind = 'purchase' AND il.direction = 'in' AND v.date <= ?
             AND il.stock_item_id IN (${placeholders}) AND ${IN_BOOKS}
           GROUP BY il.stock_item_id
           HAVING v.date = MAX(v.date)`
        )
        .all(asOn, ...ids) as {
          stockItemId: number; date: string; ratePaise: number; ledgerId: number | null; supplier: string | null
        }[]
    ).map((r) => [r.stockItemId, r])
  )

  return below.map((r) => {
    const shortfallQtyMilli = (r.reorderLevelMilli ?? 0) - r.closingQtyMilli
    const last = lastPurchases.get(r.stockItemId)
    return {
      stockItemId: r.stockItemId,
      name: r.name,
      unitSymbol: r.unitSymbol,
      decimals: r.decimals,
      closingQtyMilli: r.closingQtyMilli,
      reorderLevelMilli: r.reorderLevelMilli ?? 0,
      shortfallQtyMilli,
      lastSupplier: last?.supplier ?? null,
      lastSupplierLedgerId: last?.ledgerId ?? null,
      lastPurchaseDate: last?.date ?? null,
      lastRatePaise: last?.ratePaise ?? null,
      // Rate is per whole unit and the shortfall is in thousandths, so the division is part of
      // the unit conversion rather than a rounding choice.
      estimatedCost: last ? Math.round((shortfallQtyMilli * last.ratePaise) / 1000) : null
    }
  })
}

export function stockAgeing(db: DB, asOn: string): StockAgeingRow[] {
  const items = db
    .prepare(
      `SELECT si.id AS stockItemId, si.name, u.symbol AS unitSymbol, u.decimals,
              si.opening_qty_milli AS openingQtyMilli, si.reorder_level_milli AS reorderLevelMilli
       FROM stock_items si JOIN units u ON u.id = si.unit_id ORDER BY si.name`
    )
    .all() as {
      stockItemId: number; name: string; unitSymbol: string; decimals: number
      openingQtyMilli: number; reorderLevelMilli: number | null
    }[]

  // Line-level chronological walk (no SQL pre-grouping): physical-stock `is_absolute` lines PIN
  // the running quantity to the counted level — they are not ordinary movements. Only the delta
  // against the running quantity is booked (up = an adjustment inward lot dated the count day,
  // down = an outward adjustment), mirroring checkStock and the valuation engine.
  const flows = db
    .prepare(
      `SELECT il.stock_item_id AS itemId, v.date, il.direction, il.qty_milli AS qty,
              il.is_absolute AS isAbsolute
       FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
       WHERE v.date <= ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id, il.line_order, il.id`
    )
    .all(asOn) as { itemId: number; date: string; direction: 'in' | 'out'; qty: number; isAbsolute: number }[]

  const inLots = new Map<number, InwardLot[]>()
  const outQty = new Map<number, number>()
  const inQty = new Map<number, number>()
  const lastOut = new Map<number, string>()
  const runningQty = new Map<number, number>()
  for (const it of items) runningQty.set(it.stockItemId, it.openingQtyMilli)
  for (const f of flows) {
    const cur = runningQty.get(f.itemId) ?? 0
    let inward = 0
    let outward = 0
    if (f.isAbsolute) {
      const delta = f.qty - cur
      if (delta > 0) inward = delta
      else outward = -delta
    } else if (f.direction === 'in') {
      inward = f.qty
    } else {
      outward = f.qty
    }
    if (inward > 0) {
      const lots = inLots.get(f.itemId) ?? []
      const last = lots[lots.length - 1]
      if (last && last.date === f.date) last.qtyMilli += inward
      else lots.push({ date: f.date, qtyMilli: inward })
      inLots.set(f.itemId, lots)
      inQty.set(f.itemId, (inQty.get(f.itemId) ?? 0) + inward)
    }
    if (outward > 0) {
      outQty.set(f.itemId, (outQty.get(f.itemId) ?? 0) + outward)
      // A physical-count write-down is a correction, not a consumption — it must not make a
      // stale item look recently moved, so only genuine outward lines refresh lastOut.
      if (!f.isAbsolute) lastOut.set(f.itemId, f.date) // flows are date-ordered, so the last write wins correctly
    }
    runningQty.set(f.itemId, cur + inward - outward)
  }

  const asOnMs = Date.parse(asOn)
  return items.map((it) => {
    const closingQtyMilli = it.openingQtyMilli + (inQty.get(it.stockItemId) ?? 0) - (outQty.get(it.stockItemId) ?? 0)
    const lastOutwardDate = lastOut.get(it.stockItemId) ?? null
    const daysSinceOut = lastOutwardDate === null ? null : Math.round((asOnMs - Date.parse(lastOutwardDate)) / 86_400_000)
    return {
      stockItemId: it.stockItemId,
      name: it.name,
      unitSymbol: it.unitSymbol,
      decimals: it.decimals,
      closingQtyMilli,
      buckets: ageStock(closingQtyMilli, inLots.get(it.stockItemId) ?? [], asOn),
      lastOutwardDate,
      slowMoving: closingQtyMilli > 0 && (daysSinceOut === null || daysSinceOut > 90),
      reorderLevelMilli: it.reorderLevelMilli,
      belowReorder: it.reorderLevelMilli !== null && closingQtyMilli <= it.reorderLevelMilli
    }
  })
}

/** Item-wise profitability (v0.3 #59): sales outward value − engine-valued COGS, per item.
 *  COGS comes from the valuation engine's period consumption (reconciliation (c)): each item's
 *  valuation_method (FIFO / weighted average) prices the outward cost. When an item also has
 *  non-sales outward movements in the period (e.g. manufacturing consumption), the period's
 *  consumed value is attributed to sales pro-rata by quantity. */
export function itemProfitability(db: DB, from: string, to: string): ItemProfitRow[] {
  const rows = db
    .prepare(
      `SELECT si.id AS stockItemId, si.name, u.symbol AS unitSymbol, u.decimals,
              COALESCE(sold.qty, 0) AS outQtyMilli, COALESCE(sold.val, 0) AS salesValue
       FROM stock_items si
       JOIN units u ON u.id = si.unit_id
       LEFT JOIN (
         SELECT il.stock_item_id, SUM(il.qty_milli) AS qty, SUM(il.amount) AS val
         FROM inventory_lines il
         JOIN vouchers v ON v.id = il.voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE il.direction = 'out' AND vt.kind = 'sales' AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
         GROUP BY il.stock_item_id
       ) sold ON sold.stock_item_id = si.id
       ORDER BY si.name`
    )
    .all(from, to) as {
      stockItemId: number; name: string; unitSymbol: string; decimals: number
      outQtyMilli: number; salesValue: number
    }[]

  const consumption = stockAnalysis.periodConsumption(db, from, to)

  return rows
    .filter((r) => r.outQtyMilli > 0)
    .map((r) => {
      const c = consumption.get(r.stockItemId)
      const cogs = c && c.outwardQtyMilli > 0
        ? Math.round((c.consumedValue * r.outQtyMilli) / c.outwardQtyMilli)
        : 0
      return {
        stockItemId: r.stockItemId,
        name: r.name,
        unitSymbol: r.unitSymbol,
        decimals: r.decimals,
        outQtyMilli: r.outQtyMilli,
        salesValue: r.salesValue,
        cogs,
        profit: r.salesValue - cogs
      }
    })
}

const EXCEPTION_ROW_CAP = 200

/** Exception reports (v0.3 #60): things that are almost certainly mistakes, with drillable rows. */
export function exceptions(db: DB, from: string, to: string, company?: CompanyInfo): ExceptionsReport {
  const sections: ExceptionSection[] = []
  const section = (key: ExceptionSection['key'], label: string, rows: ExceptionRow[]): void => {
    sections.push({ key, label, count: rows.length, rows: rows.slice(0, EXCEPTION_ROW_CAP) })
  }

  const negStock = stockSummary(db, to)
    .filter((r) => r.closingQtyMilli < 0)
    .map((r) => ({ label: r.name, detail: `Closing quantity ${r.closingQtyMilli / 1000} ${r.unitSymbol}` }))
  section('negativeStock', 'Negative stock', negStock)

  const cashIds = descendantIdSet(listGroups(db), ['Cash-in-Hand'])
  const balances = closingBalances(db, to)
  const negCash = ledgersLite(db)
    .filter((l) => cashIds.has(l.groupId) && (balances.get(l.id) ?? 0) < 0)
    .map((l) => ({ label: l.name, detail: 'Cash ledger has a credit balance', ledgerId: l.id, amount: balances.get(l.id) ?? 0 }))
  section('negativeCash', 'Negative cash', negCash)

  const voucherRow = (v: { id: number; date: string; number: string; voucherType: string; total: number }, detail: string): ExceptionRow => ({
    label: `${v.voucherType} ${v.number}`,
    detail: `${v.date} — ${detail}`,
    voucherId: v.id,
    amount: v.total
  })

  const baseVoucherSql = `
    SELECT v.id, v.date, v.number, vt.name AS voucherType,
           COALESCE((SELECT SUM(amount) FROM voucher_lines WHERE voucher_id = v.id AND dr_cr = 'dr'), 0) AS total
    FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id`
  type VRow = { id: number; date: string; number: string; voucherType: string; total: number }

  const noNarration = (db
    .prepare(`${baseVoucherSql} WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND (v.narration IS NULL OR TRIM(v.narration) = '') ORDER BY v.date, v.id`)
    .all(from, to) as VRow[]).map((v) => voucherRow(v, 'no narration'))
  section('missingNarration', 'Missing narration', noNarration)

  const singleLedger = (db
    .prepare(
      `${baseVoucherSql} WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       AND vt.kind NOT IN ('stock_journal', 'physical_stock')
       AND (SELECT COUNT(DISTINCT ledger_id) FROM voucher_lines WHERE voucher_id = v.id) < 2
       ORDER BY v.date, v.id`
    )
    .all(from, to) as VRow[]).map((v) => voucherRow(v, 'fewer than two ledgers'))
  section('singleLedger', 'Single-ledger vouchers', singleLedger)

  const outside = (db
    .prepare(`${baseVoucherSql} WHERE ${IN_BOOKS} AND (v.date < ? OR v.date > ?) ORDER BY v.date, v.id`)
    .all(from, to) as VRow[]).map((v) => voucherRow(v, 'dated outside the working period'))
  section('outsidePeriod', 'Entries outside the period', outside)

  const unbalanced = (db
    .prepare(
      `${baseVoucherSql} WHERE ${IN_BOOKS}
       AND vt.kind <> 'physical_stock'
       AND (SELECT COALESCE(SUM(CASE WHEN dr_cr = 'dr' THEN amount ELSE -amount END), 0) FROM voucher_lines WHERE voucher_id = v.id) <> 0
       ORDER BY v.date, v.id`
    )
    .all() as VRow[]).map((v) => voucherRow(v, 'debits and credits differ'))
  section('unbalanced', 'Unbalanced vouchers', unbalanced)

  const missingGst = (db
    .prepare(
      `${baseVoucherSql}
       JOIN ledgers pl ON pl.id = v.party_ledger_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       AND vt.kind IN ('sales', 'purchase', 'credit_note', 'debit_note')
       AND pl.gstin IS NOT NULL AND TRIM(pl.gstin) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
         WHERE vl.voucher_id = v.id AND l.tax_type IS NOT NULL
       )
       ORDER BY v.date, v.id`
    )
    .all(from, to) as VRow[]).map((v) => voucherRow(v, 'B2B party but no GST tax line'))
  section('missingGst', 'Missing GST fields', missingGst)

  // Input credit under section 16(4) cannot be taken after 30 November of the following FY. Miss
  // it and the credit is gone — not deferred, gone — and it is one of the few GST mistakes with
  // no remedy. A purchase from two years ago otherwise sits in the books looking exactly like one
  // from last month.
  //
  // Scanned over ALL purchases in books, not just the working period: the whole risk is that an
  // old invoice is out of sight. Anything already comfortably inside its window is dropped, so a
  // clean set of books reports clean.
  const today = todayISO()
  const itcRows = (db
    .prepare(
      `${baseVoucherSql}
       WHERE ${IN_BOOKS} AND vt.kind IN ('purchase', 'debit_note')
       AND EXISTS (
         SELECT 1 FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
         WHERE vl.voucher_id = v.id AND l.tax_type IS NOT NULL AND vl.dr_cr = 'dr'
       )
       ORDER BY v.date, v.id`
    )
    .all() as VRow[])
    .map((v) => ({ v, risk: itcRisk({ invoiceDate: v.date, today }) }))
    .filter((x) => x.risk.level !== 'ok')
    .map(({ v, risk }) =>
      voucherRow(
        v,
        risk.level === 'lapsed'
          ? `credit window shut ${risk.deadline} — ${-risk.daysRemaining} days ago`
          : `credit window shuts ${risk.deadline} — ${risk.daysRemaining} days left`
      )
    )
  section('itcAtRisk', 'Input credit about to lapse', itcRows)

  // Gaps in an auto-numbered series. A missing invoice number is the first thing an auditor asks
  // about, and the honest answer is usually dull — but the business should know before it is
  // asked rather than finding out across a table.
  //
  // Only auto-numbered types: a manual series is the user's own, and reporting gaps in it would
  // second-guess a numbering scheme the app does not own. Scoped to the working period, because
  // a series that restarts each FY has a legitimate discontinuity at every year boundary.
  const seriesRows = db
    .prepare(
      `SELECT vt.id AS typeId, vt.name AS voucherType, vt.prefix, vt.suffix, v.number
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS} AND vt.numbering = 'auto'`
    )
    .all(from, to) as { typeId: number; voucherType: string; prefix: string; suffix: string; number: string }[]

  const byType = new Map<number, { voucherType: string; numbers: number[] }>()
  for (const r of seriesRows) {
    let core = r.number
    if (r.suffix && core.endsWith(r.suffix)) core = core.slice(0, -r.suffix.length)
    if (r.prefix && core.startsWith(r.prefix)) core = core.slice(r.prefix.length)
    const n = Number(core)
    // A number that does not parse is not part of a sequence — someone typed over the auto value.
    // Skipping it is right: treating it as 0 would report a gap from 1 to the next real number.
    if (!Number.isInteger(n)) continue
    const entry = byType.get(r.typeId) ?? { voucherType: r.voucherType, numbers: [] }
    entry.numbers.push(n)
    byType.set(r.typeId, entry)
  }

  const gapRows: ExceptionRow[] = []
  for (const { voucherType, numbers } of byType.values()) {
    for (const gap of numberGaps(numbers)) {
      const size = gapSize(gap)
      gapRows.push({
        label: `${voucherType} ${describeGap(gap)}`,
        detail: `${size} number${size === 1 ? '' : 's'} missing from the series — usually a deleted voucher`
      })
    }
  }
  section('numberGaps', 'Gaps in voucher numbering', gapRows)

  // Section 206C(1H): once receipts from one buyer pass Rs 50 lakh in a financial year, TCS at
  // 0.1% may be collectible on the excess. It is collected on RECEIPT rather than on sale, which
  // is what makes it easy to miss — nothing about the invoice tells you, and the threshold is
  // crossed by a payment arriving.
  //
  // Flagged rather than collected: 206C(1H) does not apply where the buyer is deducting TDS under
  // 194Q on the same transaction, which is now the common case and which the seller cannot know
  // from their own books. Adding 0.1% on that assumption would be collecting tax that should not
  // have been collected.
  const tcsRows: ExceptionRow[] = []
  if (tcsAppliesToSeller(company?.turnoverBand ?? null)) {
    const fy = fyOf(to)
    const receipts = db
      .prepare(
        `SELECT l.id AS ledgerId, l.name, l.pan,
                COALESCE(SUM(vl.amount), 0) AS received
         FROM vouchers v
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         JOIN voucher_lines vl ON vl.voucher_id = v.id AND vl.ledger_id = v.party_ledger_id
         JOIN ledgers l ON l.id = v.party_ledger_id
         WHERE vt.kind = 'receipt' AND vl.dr_cr = 'cr'
           AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
         GROUP BY l.id
         HAVING received > ?`
      )
      .all(fy.from, fy.to, TCS_THRESHOLD_PAISE) as {
        ledgerId: number; name: string; pan: string | null; received: number
      }[]

    for (const r of receipts) {
      const t = computeTcs({ receiptsThisFy: r.received, hasPan: !!r.pan })
      tcsRows.push({
        label: r.name,
        detail:
          `Received ${(r.received / 100).toLocaleString('en-IN')} this year — TCS at ${t.ratePercent}% on the excess` +
          (r.pan ? '' : ' (no PAN on record, so 1% rather than 0.1%)'),
        ledgerId: r.ledgerId,
        amount: t.collectible
      })
    }
  }
  section('tcsThreshold', 'Buyers past the TCS threshold (206C(1H))', tcsRows)

  return { sections }
}

function stockOpeningValueTotal(db: DB): number {
  const row = db.prepare('SELECT COALESCE(SUM(opening_value), 0) AS v FROM stock_items').get() as { v: number }
  return row.v
}

function dayBefore(date: string): string {
  const dt = new Date(date + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

/** Same date one year earlier, clamped for Feb 29. */
function yearBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const maxDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate()
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, maxDay)).padStart(2, '0')}`
}

// ---------- reports ----------

/**
 * A page of day-book rows, plus how many there are in total.
 *
 * The queries here are fast even on a large book -- measured at 94 ms for 30,000 vouchers in
 * scale.dbtest.ts -- so paginating is not about SQL. It is about what crosses IPC: the same
 * period serialised whole is a ~6 MB JSON payload, structure-cloned onto the thread that also
 * serves every other query, on every visit to the screen. `total` comes from a COUNT so the UI
 * can say "500 of 30,000" honestly rather than implying it has everything.
 */
export interface DayBookPage {
  rows: DayBookRow[]
  total: number
}

export function dayBook(
  db: DB,
  from: string,
  to: string,
  opts: {
    /** Include optional (memorandum) and unmatured post-dated vouchers, flagged per row, so the
     *  Day Book can badge/filter them (v0.3 S5). Default false keeps books-only semantics for
     *  existing consumers (CA pack). */
    includeOutOfBooks?: boolean
    /** Rows to return. Omit for every row — what the CA pack and Tally export need. */
    limit?: number
    offset?: number
  } = {}
): DayBookRow[] {
  const scope = opts.includeOutOfBooks ? NOT_DELETED : IN_BOOKS
  // v0.3 #61: real Dr/Cr split — the shown account's net signed amount lands in the column of
  // its actual side, instead of the voucher total being printed under BOTH Debit and Credit.
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, vt.name AS voucherType, vt.kind AS kind, v.number, v.narration,
              v.is_optional AS isOptional, v.post_dated AS postDated,
              COALESCE(pl.name, fl.name, '') AS account,
              COALESCE(anet.net, 0) AS accountNet,
              -- How many of this voucher's bank legs exist, and how many are marked off. Counted
              -- rather than boolean so a voucher between two bank accounts can say "partial".
              COALESCE(bank.legs, 0) AS bankLegs,
              COALESCE(bank.cleared, 0) AS bankCleared
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
       LEFT JOIN (
         SELECT voucher_id, MIN(id) AS first_line FROM voucher_lines GROUP BY voucher_id
       ) f ON f.voucher_id = v.id
       LEFT JOIN voucher_lines fvl ON fvl.id = f.first_line
       LEFT JOIN ledgers fl ON fl.id = fvl.ledger_id
       LEFT JOIN (
         SELECT vl.voucher_id, vl.ledger_id,
                SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS net
         FROM voucher_lines vl GROUP BY vl.voucher_id, vl.ledger_id
       ) anet ON anet.voucher_id = v.id AND anet.ledger_id = COALESCE(pl.id, fl.id)
       LEFT JOIN (
         SELECT vl.voucher_id,
                COUNT(*) AS legs,
                SUM(CASE WHEN vl.bank_date IS NOT NULL THEN 1 ELSE 0 END) AS cleared
         FROM voucher_lines vl
         JOIN ledgers bl ON bl.id = vl.ledger_id
         JOIN groups bg ON bg.id = bl.group_id
         WHERE bg.name = 'Bank Accounts'
         GROUP BY vl.voucher_id
       ) bank ON bank.voucher_id = v.id
       WHERE v.date BETWEEN ? AND ? AND ${scope}
       ORDER BY v.date, v.id
       ${opts.limit != null ? 'LIMIT ? OFFSET ?' : ''}`
    )
    .all(...(opts.limit != null ? [from, to, opts.limit, opts.offset ?? 0] : [from, to])) as {
      voucherId: number; date: string; voucherType: string; kind: string; number: string
      narration: string | null; account: string; accountNet: number
      isOptional: number; postDated: number
      bankLegs: number; bankCleared: number
    }[]
  return rows.map((r) => ({
    voucherId: r.voucherId,
    date: r.date,
    voucherType: r.voucherType,
    kind: r.kind,
    number: r.number,
    account: r.account,
    narration: r.narration,
    debit: r.accountNet > 0 ? r.accountNet : 0,
    credit: r.accountNet < 0 ? -r.accountNet : 0,
    isOptional: !!r.isOptional,
    postDated: !!r.postDated,
    bankStatus:
      r.bankLegs === 0
        ? null
        : r.bankCleared === 0
          ? 'pending'
          : r.bankCleared < r.bankLegs
            ? 'partial'
            : 'reconciled'
  }))
}

/**
 * The period by voucher type: how many of each, and what they moved.
 *
 * A summary rather than subtotals inside the list, because the list is paged — subtotals
 * computed over a page would be subtotals of an arbitrary slice, which is worse than none. This
 * counts the whole period in one query however many rows that is, and each row drills into the
 * Day Book filtered to that type.
 */
export function dayBookByType(db: DB, from: string, to: string, includeOutOfBooks = false): DayBookTypeRow[] {
  const scope = includeOutOfBooks ? NOT_DELETED : IN_BOOKS
  return db
    .prepare(
      `SELECT vt.kind AS kind, vt.name AS voucherType, COUNT(DISTINCT v.id) AS count,
              COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE 0 END), 0) AS debit,
              COALESCE(SUM(CASE WHEN vl.dr_cr = 'cr' THEN vl.amount ELSE 0 END), 0) AS credit
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id
       WHERE v.date BETWEEN ? AND ? AND ${scope}
       GROUP BY vt.id
       ORDER BY count DESC, vt.name`
    )
    .all(from, to) as DayBookTypeRow[]
}

/** How many day-book rows the period holds — the denominator for a paged view. */
export function dayBookCount(db: DB, from: string, to: string, includeOutOfBooks = false): number {
  const scope = includeOutOfBooks ? NOT_DELETED : IN_BOOKS
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE v.date BETWEEN ? AND ? AND ${scope}`)
    .get(from, to) as { n: number }
  return row.n
}

/**
 * A ledger's entries over a period.
 *
 * `limit` pages the detail rows only. Opening, closing and the period totals are always computed
 * from every row, so a paged statement still foots -- the same discipline the tool envelopes use.
 * Measured at 30,000 vouchers the whole statement serialises to ~5 MB; the screen shows 500.
 */
export function ledgerStatement(
  db: DB,
  ledgerId: number,
  from: string,
  to: string,
  groupBy?: Period,
  page?: { limit: number; offset?: number }
): LedgerStatement {
  const ledger = db.prepare('SELECT id, name, opening_balance FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; name: string; opening_balance: number }
    | undefined
  if (!ledger) throw new Error('Ledger not found')

  const beforeRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date < ? AND ${IN_BOOKS}`
    )
    .get(ledgerId, from) as { m: number }
  const opening = ledger.opening_balance + beforeRow.m

  const lineRows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, vt.name AS voucherType, v.number, v.narration,
              vl.dr_cr AS drCr, vl.amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id, vl.line_order`
    )
    .all(ledgerId, from, to) as {
      voucherId: number; date: string; voucherType: string; number: string; narration: string | null
      drCr: 'dr' | 'cr'; amount: number
    }[]

  // Counterpart names for the "particulars" column — one batched query over the touched
  // vouchers plus JS grouping, replacing the correlated GROUP_CONCAT subquery per line.
  const voucherIds = [...new Set(lineRows.map((r) => r.voucherId))]
  const namesBySide = new Map<string, string[]>() // `${voucherId}|${drCr}` -> distinct names, first-seen order
  if (voucherIds.length > 0) {
    const placeholders = voucherIds.map(() => '?').join(',')
    const counterRows = db
      .prepare(
        `SELECT vl2.voucher_id AS voucherId, vl2.dr_cr AS drCr, l2.name
         FROM voucher_lines vl2 JOIN ledgers l2 ON l2.id = vl2.ledger_id
         WHERE vl2.voucher_id IN (${placeholders})
         ORDER BY vl2.id`
      )
      .all(...voucherIds) as { voucherId: number; drCr: 'dr' | 'cr'; name: string }[]
    for (const r of counterRows) {
      const key = `${r.voucherId}|${r.drCr}`
      const list = namesBySide.get(key) ?? []
      if (!list.includes(r.name)) list.push(r.name)
      namesBySide.set(key, list)
    }
  }
  const particularsFor = (voucherId: number, drCr: 'dr' | 'cr'): string =>
    (namesBySide.get(`${voucherId}|${drCr === 'dr' ? 'cr' : 'dr'}`) ?? []).join(',')

  let running = opening
  let totalDebit = 0
  let totalCredit = 0
  const rows: LedgerStatementRow[] = lineRows.map((r) => {
    const debit = r.drCr === 'dr' ? r.amount : 0
    const credit = r.drCr === 'cr' ? r.amount : 0
    running += debit - credit
    totalDebit += debit
    totalCredit += credit
    return {
      voucherId: r.voucherId,
      date: r.date,
      voucherType: r.voucherType,
      number: r.number,
      particulars: particularsFor(r.voucherId, r.drCr),
      narration: r.narration,
      debit,
      credit,
      running
    }
  })

  const result: LedgerStatement = {
    ledgerId,
    ledgerName: ledger.name,
    opening,
    // Totals above are computed over every row before this slice, so a page still foots.
    rows: page ? rows.slice(page.offset ?? 0, (page.offset ?? 0) + page.limit) : rows,
    totalRows: rows.length,
    closing: running,
    totalDebit,
    totalCredit
  }

  // Columnar period matrix (v0.3 #55, generalised to any granularity in v0.5): every bucket in
  // the range, with the running closing carried across buckets that had no activity.
  if (groupBy) {
    const byPeriod = new Map<string, { debit: number; credit: number; closing: number }>()
    for (const r of rows) {
      const key = periodKey(r.date, groupBy)
      const m = byPeriod.get(key) ?? { debit: 0, credit: 0, closing: opening }
      m.debit += r.debit
      m.credit += r.credit
      m.closing = r.running
      byPeriod.set(key, m)
    }
    let carried = opening
    result.periods = periodRange(from, to, groupBy).map((period) => {
      const label = periodLabel(period, groupBy)
      const m = byPeriod.get(period)
      if (m) {
        carried = m.closing
        return { period, label, debit: m.debit, credit: m.credit, closing: m.closing }
      }
      return { period, label, debit: 0, credit: 0, closing: carried }
    })
  }

  return result
}

/**
 * @param includeZeroBalances Keep ledgers with no balance and no movement in the result.
 *
 * They are dropped by default and always have been: a chart of accounts collects ledgers that
 * were used once, and a trial balance three screens long, mostly zeroes, hides the numbers that
 * matter. But "never" is the wrong answer too -- a ledger you expected to see and cannot is
 * indistinguishable from one that does not exist -- so the choice belongs to the caller. Hiding
 * them can never change a total, which is what makes it safe.
 */
export function trialBalance(db: DB, asOn: string, includeZeroBalances = false): TrialBalance {
  // Opening + gross Dr/Cr movement per ledger in one grouped pass; closing derives from them.
  const rows = db
    .prepare(
      `SELECT l.id AS ledgerId, l.name AS ledgerName, g.name AS groupName, g.nature AS nature,
              l.group_id AS groupId,
              l.opening_balance AS opening,
              COALESCE(m.drTotal, 0) AS movementDebit,
              COALESCE(m.crTotal, 0) AS movementCredit
       FROM ledgers l
       JOIN groups g ON g.id = l.group_id
       LEFT JOIN (
         SELECT vl.ledger_id,
                SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE 0 END) AS drTotal,
                SUM(CASE WHEN vl.dr_cr = 'cr' THEN vl.amount ELSE 0 END) AS crTotal
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE v.date <= ? AND ${IN_BOOKS}
         GROUP BY vl.ledger_id
       ) m ON m.ledger_id = l.id`
    )
    .all(asOn) as {
      ledgerId: number; ledgerName: string; groupName: string; nature: Nature; groupId: number
      opening: number; movementDebit: number; movementCredit: number
    }[]

  const result = rows
    .map((r) => {
      const bal = r.opening + r.movementDebit - r.movementCredit
      return {
        ledgerId: r.ledgerId,
        ledgerName: r.ledgerName,
        groupName: r.groupName,
        nature: r.nature,
        debit: bal > 0 ? bal : 0,
        credit: bal < 0 ? -bal : 0,
        opening: r.opening,
        movementDebit: r.movementDebit,
        movementCredit: r.movementCredit
      }
    })
    .filter(
      (r) =>
        includeZeroBalances ||
        r.debit !== 0 ||
        r.credit !== 0 ||
        r.movementDebit !== 0 ||
        r.movementCredit !== 0
    )

  // Opening stock joins the debit side so a stock-carrying book still balances — but only when
  // no ledger actually lives under Stock-in-Hand (or any of its descendant groups); if one does,
  // its balance already carries the stock and a synthetic row would double-count (v0.3 #63 guard).
  const stockOpening = stockOpeningValueTotal(db)
  const stockGroupIds = descendantIdSet(listGroups(db), ['Stock-in-Hand'])
  const hasStockLedger = rows.some(
    (r) => stockGroupIds.has(r.groupId) && (r.opening !== 0 || r.movementDebit !== 0 || r.movementCredit !== 0)
  )
  if (stockOpening !== 0 && !hasStockLedger) {
    result.push({
      ledgerId: -1, ledgerName: 'Stock-in-Hand (opening)', groupName: 'Stock-in-Hand', nature: 'asset',
      debit: stockOpening, credit: 0, opening: stockOpening, movementDebit: 0, movementCredit: 0
    })
  }
  result.sort((a, b) => a.ledgerName.localeCompare(b.ledgerName))
  return {
    rows: result,
    totalDebit: result.reduce((s, r) => s + r.debit, 0),
    totalCredit: result.reduce((s, r) => s + r.credit, 0),
    openingDebitTotal: result.reduce((s, r) => s + (r.opening > 0 ? r.opening : 0), 0),
    openingCreditTotal: result.reduce((s, r) => s + (r.opening < 0 ? -r.opening : 0), 0),
    movementDebitTotal: result.reduce((s, r) => s + r.movementDebit, 0),
    movementCreditTotal: result.reduce((s, r) => s + r.movementCredit, 0)
  }
}

export function profitAndLoss(
  db: DB,
  from: string,
  to: string,
  /** `openingStock`/`closingStock`: pre-computed stock figures (shared scans) — balanceSheet
   *  passes its own closing stock so the inventory valuation runs once, not once per statement.
   *  `comparePrior`: attach the same statement for the period shifted one year back (#57). */
  opts?: { openingStock?: number; closingStock?: number; comparePrior?: boolean }
): ProfitAndLoss {
  const stocks = opts
  const move = movements(db, from, to)
  const amountOf = (id: number): number => move.get(id) ?? 0
  const groups = listGroups(db)
  const ledgers = ledgersLite(db)

  const isNature = (nature: Nature, gp: boolean) => (g: Group) =>
    g.nature === nature && g.affectsGrossProfit === gp

  // Incomes are credit-natured: flip the sign so revenue reads positive.
  const tradingIncomes = buildTrees(groups, ledgers, isNature('income', true), amountOf, -1)
  const tradingExpenses = buildTrees(groups, ledgers, isNature('expense', true), amountOf, 1)
  const indirectIncomes = buildTrees(groups, ledgers, isNature('income', false), amountOf, -1)
  const indirectExpenses = buildTrees(groups, ledgers, isNature('expense', false), amountOf, 1)

  const openingStock = stocks?.openingStock ?? stockValue(db, dayBefore(from))
  const closingStock = stocks?.closingStock ?? stockValue(db, to)

  const grossProfit =
    sumNodes(tradingIncomes) + closingStock - sumNodes(tradingExpenses) - openingStock
  const netProfit = grossProfit + sumNodes(indirectIncomes) - sumNodes(indirectExpenses)

  const result: ProfitAndLoss = {
    period: { from, to },
    openingStock,
    closingStock,
    tradingIncomes,
    tradingExpenses,
    grossProfit,
    indirectExpenses,
    indirectIncomes,
    netProfit
  }
  if (opts?.comparePrior) {
    result.prior = profitAndLoss(db, yearBefore(from), yearBefore(to))
  }
  return result
}

export function balanceSheet(db: DB, booksFrom: string, asOn: string, comparePrior?: boolean): BalanceSheet {
  const balances = closingBalances(db, asOn)
  const amountOf = (id: number): number => balances.get(id) ?? 0
  const groups = listGroups(db)
  const ledgers = ledgersLite(db)

  const assets = buildTrees(groups, ledgers, (g) => g.nature === 'asset', amountOf, 1)
  const liabilities = buildTrees(groups, ledgers, (g) => g.nature === 'liability', amountOf, -1)

  // When a Stock-in-Hand ledger actually carries the stock, its balance already sits on the
  // assets face — every synthetic stock figure (the computed Closing Stock node below AND the
  // opening-difference component further down) must stand down or it double-counts (v0.3 #63).
  const stockLedgerIds = descendantIdSet(groups, ['Stock-in-Hand'])
  const hasStockLedger = ledgers.some(
    (l) => stockLedgerIds.has(l.groupId) && (l.openingBalance !== 0 || (balances.get(l.id) ?? 0) !== 0)
  )

  // Closing stock joins the assets side under Stock-in-Hand. Valued once here and shared with
  // the P&L below (whose period also ends on asOn) — a single inventory scan for the statement.
  const closingStock = stockValue(db, asOn)
  if (closingStock !== 0 && !hasStockLedger) {
    const stockGroup = groups.find((g) => g.name === 'Stock-in-Hand')
    const node: StatementNode = { id: -2, kind: 'computed', name: 'Closing Stock', amount: closingStock, children: [] }
    const currentAssets = assets.find((n) => n.name === 'Current Assets')
    const host = currentAssets?.children.find((c) => c.kind === 'group' && c.id === stockGroup?.id)
    if (host) {
      host.children.push(node)
      host.amount += closingStock
      if (currentAssets) currentAssets.amount += closingStock
    } else if (currentAssets) {
      currentAssets.children.push({ ...node, name: 'Stock-in-Hand' })
      currentAssets.amount += closingStock
    } else {
      assets.push({ id: stockGroup?.id ?? -2, kind: 'group', name: 'Current Assets', amount: closingStock, children: [node] })
    }
  }

  const pnl = profitAndLoss(db, booksFrom, asOn, { closingStock })
  const profitCurrentPeriod = pnl.netProfit

  // If user-entered opening balances don't balance, surface the gap Tally-style. The synthetic
  // stock-opening component stands down when a Stock-in-Hand ledger actually carries the stock
  // (v0.3 #63 — it double-counted before).
  const ledgerOpeningSum = (db.prepare('SELECT COALESCE(SUM(opening_balance), 0) AS s FROM ledgers').get() as { s: number }).s
  const openingDiff = ledgerOpeningSum + (hasStockLedger ? 0 : stockOpeningValueTotal(db))

  const totalAssets = sumNodes(assets)
  let totalLiabilities = sumNodes(liabilities) + profitCurrentPeriod

  const result: BalanceSheet = {
    asOn,
    assets,
    liabilities: [...liabilities],
    profitCurrentPeriod,
    totalAssets,
    totalLiabilities
  }
  if (profitCurrentPeriod !== 0) {
    result.liabilities.push({ id: -3, kind: 'computed', name: 'Profit & Loss A/c', amount: profitCurrentPeriod, children: [] })
  }
  if (openingDiff !== 0) {
    result.liabilities.push({ id: -4, kind: 'computed', name: 'Difference in Opening Balances', amount: openingDiff, children: [] })
    totalLiabilities += openingDiff
    result.totalLiabilities = totalLiabilities
  }
  if (comparePrior) {
    result.prior = balanceSheet(db, booksFrom, yearBefore(asOn))
  }
  return result
}

/** Indirect cash flow statement (v0.3 #53): net profit ± working-capital/stock deltas grouped
 *  by activity, reconciling exactly to the period's cash+bank movement. */
export function cashFlow(db: DB, from: string, to: string): CashFlowStatement {
  const pnl = profitAndLoss(db, from, to)
  const before = closingBalances(db, dayBefore(from))
  const after = closingBalances(db, to)
  const groups = listGroups(db)
  const ledgers = ledgersLite(db)
  const cashBankIds = descendantIdSet(groups, CASH_BANK_GROUPS)

  const byId = new Map(groups.map((g) => [g.id, g]))
  const topOf = (groupId: number): Group => {
    let g = byId.get(groupId)!
    while (g.parentId !== null && byId.has(g.parentId)) g = byId.get(g.parentId)!
    return g
  }

  const deltaByGroup = new Map<string, number>()
  let openingCash = 0
  let closingCash = 0
  for (const l of ledgers) {
    const b = before.get(l.id) ?? 0
    const a = after.get(l.id) ?? 0
    if (cashBankIds.has(l.groupId)) {
      openingCash += b
      closingCash += a
      continue
    }
    if (a === b) continue
    const top = topOf(l.groupId)
    if (top.nature !== 'asset' && top.nature !== 'liability') continue // P&L ledgers live in netProfit
    deltaByGroup.set(top.name, (deltaByGroup.get(top.name) ?? 0) + (a - b))
  }

  return buildCashFlow({
    period: { from, to },
    netProfit: pnl.netProfit,
    stockDelta: pnl.closingStock - pnl.openingStock,
    groupDeltas: [...deltaByGroup].map(([name, delta]) => ({ name, delta })),
    openingCash,
    closingCash
  })
}

function addDaysISO(iso: string, delta: number): string {
  const dt = new Date(iso + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

/** Ids of all groups in the subtrees rooted at the named groups, computed in JS from an
 *  already-loaded group list (dashboard loads groups once and derives every set from it).
 *  Name matching is case-insensitive, mirroring the NOCASE collation on groups.name. */
function descendantIdSet(groups: Group[], names: string[]): Set<number> {
  const children = new Map<number | null, number[]>()
  for (const g of groups) {
    const list = children.get(g.parentId) ?? []
    list.push(g.id)
    children.set(g.parentId, list)
  }
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const stack = groups.filter((g) => wanted.has(g.name.toLowerCase())).map((g) => g.id)
  const result = new Set<number>()
  while (stack.length) {
    const id = stack.pop()!
    if (result.has(id)) continue
    result.add(id)
    for (const c of children.get(id) ?? []) stack.push(c)
  }
  return result
}

/** Top 5 ledgers under the given group-id set by outstanding balance, descending, zero/negative
 *  excluded. `sign` flips the dr-positive figure onto the "amount owed" axis (1 for debtors, -1
 *  for creditors, whose natural balance is credit i.e. negative dr-positive). */
function topLedgersFor(
  balances: Map<number, number>,
  ledgers: LedgerLite[],
  ids: Set<number>,
  sign: 1 | -1
): TopLedgerRow[] {
  return ledgers
    .filter((l) => ids.has(l.groupId))
    .map((l) => ({ ledgerId: l.id, name: l.name, amount: sign * (balances.get(l.id) ?? 0) }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
}

/** Cash + bank running balance, one point per day, for the trailing `days` days ending `today`.
 *  A single query gets the cumulative dr-positive balance (window-fn `SUM(...) OVER`) on every
 *  date that actually had cash/bank movement; the day-by-day walk below just carries the last
 *  known value forward across the gaps (weekends, days with no cash/bank voucher, ...).
 *  `groupIds`/`opening` come pre-computed from data the caller already holds. */
function cashSpark(db: DB, today: string, groupIds: number[], opening: number, days = 30): CashSparkPoint[] {
  const windowStart = addDaysISO(today, -(days - 1))

  const balanceByDate = new Map<string, number>()
  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT v.date AS date,
                SUM(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END))
                  OVER (ORDER BY v.date) AS cum
         FROM voucher_lines vl
         JOIN vouchers v ON v.id = vl.voucher_id
         JOIN ledgers l ON l.id = vl.ledger_id
         WHERE l.group_id IN (${placeholders}) AND v.date <= ? AND ${IN_BOOKS}
         GROUP BY v.date
         ORDER BY v.date`
      )
      .all(...groupIds, today) as { date: string; cum: number }[]
    for (const r of rows) balanceByDate.set(r.date, opening + r.cum)
  }

  // Carry the last known balance strictly before the window into its opening point.
  let carry = opening
  for (const [date, bal] of balanceByDate) {
    if (date < windowStart) carry = bal
    else break
  }

  const points: CashSparkPoint[] = []
  let current = carry
  let d = windowStart
  for (let i = 0; i < days; i++) {
    if (balanceByDate.has(d)) current = balanceByDate.get(d)!
    points.push({ date: d, balance: current })
    d = addDaysISO(d, 1)
  }
  return points
}

export function dashboard(db: DB, today: string, fyFrom: string): DashboardData {
  // One balances scan, one ledger list, one group list — every group-subtree figure below is
  // derived in JS from these instead of re-querying groups per metric (the old N-queries shape).
  const balances = closingBalances(db, today)
  const ledgers = ledgersLite(db)
  const groups = listGroups(db)

  const sumGroupSet = (ids: Set<number>, sign: 1 | -1, onlyPositive = false): number => {
    let total = 0
    for (const l of ledgers) {
      if (!ids.has(l.groupId)) continue
      const bal = sign * (balances.get(l.id) ?? 0)
      total += onlyPositive ? Math.max(0, bal) : bal
    }
    return total
  }

  const cashIds = descendantIdSet(groups, ['Cash-in-Hand'])
  const bankIds = descendantIdSet(groups, ['Bank Accounts', 'Bank OD A/c'])
  const debtorIds = descendantIdSet(groups, ['Sundry Debtors'])
  const creditorIds = descendantIdSet(groups, ['Sundry Creditors'])
  const dutiesIds = descendantIdSet(groups, ['Duties & Taxes'])
  const cashBankIds = descendantIdSet(groups, CASH_BANK_GROUPS)

  const monthStart = today.slice(0, 8) + '01'

  // Sales/purchase totals for today + month-to-date in a single grouped pass.
  const kindRows = db
    .prepare(
      `SELECT vt.kind AS kind,
              COALESCE(SUM(CASE WHEN v.date = ? THEN t.total ELSE 0 END), 0) AS todayTotal,
              COALESCE(SUM(t.total), 0) AS monthTotal
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN (SELECT voucher_id, SUM(amount) AS total FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id) t
         ON t.voucher_id = v.id
       WHERE vt.kind IN ('sales', 'purchase') AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY vt.kind`
    )
    .all(today, monthStart, today) as { kind: 'sales' | 'purchase'; todayTotal: number; monthTotal: number }[]
  const kindTotals = new Map(kindRows.map((r) => [r.kind, r]))

  const recent = listVouchers(db, fyFrom, today)
    .slice(-8)
    .reverse()
    .map((v) => ({
      voucherId: v.id, date: v.date, voucherType: v.voucherType, kind: v.kind, number: v.number,
      account: v.account, narration: v.narration, debit: v.amount, credit: v.amount,
      // Real flags (not hard-coded false): the recent list shows out-of-books vouchers too, and
      // the renderer badges them just like the Day Book does.
      isOptional: v.isOptional, postDated: v.postDated
      // bankStatus deliberately absent: the Gateway's recent list has no reconciliation column,
      // and `null` already means "not a bank voucher".
    }))

  const partyIds = new Set([...debtorIds, ...creditorIds])
  const partyCount = ledgers.filter((l) => partyIds.has(l.groupId)).length
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM vouchers v WHERE ${IN_BOOKS}) AS voucherCount,
              (SELECT COUNT(*) FROM stock_items) AS itemCount,
              EXISTS (SELECT 1 FROM employees WHERE active = 1) AS hasEmployees`
    )
    .get() as { voucherCount: number; itemCount: number; hasEmployees: number }

  const cashBankOpening = ledgers
    .filter((l) => cashBankIds.has(l.groupId))
    .reduce((s, l) => s + l.openingBalance, 0)

  const receivables = sumGroupSet(debtorIds, 1, true)
  const payables = sumGroupSet(creditorIds, -1, true)

  // Ratio panel (FY-to-date, v0.3 #54): margins/stock from the FY P&L, sales/purchase flows
  // from one grouped query, balance-sheet sides from the balances already in hand.
  const pnlFy = profitAndLoss(db, fyFrom, today)
  const fyKindRows = db
    .prepare(
      `SELECT vt.kind AS kind, COALESCE(SUM(t.total), 0) AS total
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN (SELECT voucher_id, SUM(amount) AS total FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id) t
         ON t.voucher_id = v.id
       WHERE vt.kind IN ('sales', 'purchase') AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY vt.kind`
    )
    .all(fyFrom, today) as { kind: 'sales' | 'purchase'; total: number }[]
  const fyTotals = new Map(fyKindRows.map((r) => [r.kind, r.total]))
  const currentAssetIds = descendantIdSet(groups, ['Current Assets'])
  const currentLiabilityIds = descendantIdSet(groups, ['Current Liabilities'])
  const periodDays = Math.max(1, Math.round((Date.parse(today) - Date.parse(fyFrom)) / 86_400_000) + 1)
  const ratios = computeRatios({
    currentAssets: sumGroupSet(currentAssetIds, 1) + pnlFy.closingStock,
    currentLiabilities: sumGroupSet(currentLiabilityIds, -1),
    stock: pnlFy.closingStock,
    receivables,
    payables,
    sales: fyTotals.get('sales') ?? 0,
    purchases: fyTotals.get('purchase') ?? 0,
    openingStock: pnlFy.openingStock,
    closingStock: pnlFy.closingStock,
    grossProfit: pnlFy.grossProfit,
    netProfit: pnlFy.netProfit,
    periodDays
  })

  return {
    cashBalance: sumGroupSet(cashIds, 1),
    bankBalance: sumGroupSet(bankIds, 1),
    todaySales: kindTotals.get('sales')?.todayTotal ?? 0,
    monthSales: kindTotals.get('sales')?.monthTotal ?? 0,
    monthPurchases: kindTotals.get('purchase')?.monthTotal ?? 0,
    receivables,
    payables,
    gstPayable: sumGroupSet(dutiesIds, -1),
    recentVouchers: recent,
    topReceivables: topLedgersFor(balances, ledgers, debtorIds, 1),
    topPayables: topLedgersFor(balances, ledgers, creditorIds, -1),
    cashSpark: cashSpark(db, today, [...cashBankIds], cashBankOpening),
    voucherCount: counts.voucherCount,
    partyCount,
    itemCount: counts.itemCount,
    hasEmployees: !!counts.hasEmployees,
    ratios
  }
}
