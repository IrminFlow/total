import type { DB } from '../db/connection'
import type {
  BalanceSheet, CashSparkPoint, DashboardData, DayBookRow, LedgerStatement, LedgerStatementRow,
  ProfitAndLoss, StatementNode, StockSummaryRow, TopLedgerRow, TrialBalance
} from '@shared/reports'
import type { Group, Nature } from '@shared/domain'
import { listGroups } from './masters'
import { CASH_BANK_GROUPS } from '@shared/seed'
import { buildCashFlow, computeRatios, type CashFlowStatement } from '@shared/reportMath'
import { listVouchers, NOT_DELETED } from './vouchers'

// ---------- shared helpers ----------

/** Signed movement (dr positive) per ledger over an inclusive date range. */
function movements(db: DB, from: string, to: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT vl.ledger_id AS id, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED} GROUP BY vl.ledger_id`
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
         WHERE v.date <= ? AND ${NOT_DELETED}
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

// ---------- stock valuation (weighted average) ----------

export function stockSummary(db: DB, asOn: string): StockSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT si.id AS stockItemId, si.name, u.symbol AS unitSymbol, u.decimals,
              si.opening_qty_milli AS openingQtyMilli, si.opening_value AS openingValue,
              COALESCE(m.in_qty, 0) AS inwardQtyMilli, COALESCE(m.in_val, 0) AS inwardValue,
              COALESCE(m.out_qty, 0) AS outwardQtyMilli
       FROM stock_items si
       JOIN units u ON u.id = si.unit_id
       LEFT JOIN (
         SELECT il.stock_item_id,
                SUM(CASE WHEN il.direction = 'in' THEN il.qty_milli ELSE 0 END) AS in_qty,
                SUM(CASE WHEN il.direction = 'in' THEN il.amount ELSE 0 END) AS in_val,
                SUM(CASE WHEN il.direction = 'out' THEN il.qty_milli ELSE 0 END) AS out_qty
         FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
         WHERE v.date <= ? AND ${NOT_DELETED}
         GROUP BY il.stock_item_id
       ) m ON m.stock_item_id = si.id
       ORDER BY si.name`
    )
    .all(asOn) as {
      stockItemId: number; name: string; unitSymbol: string; decimals: number
      openingQtyMilli: number; openingValue: number
      inwardQtyMilli: number; inwardValue: number; outwardQtyMilli: number
    }[]

  return rows.map((r) => {
    const totalInQty = r.openingQtyMilli + r.inwardQtyMilli
    const totalInValue = r.openingValue + r.inwardValue
    const closingQtyMilli = totalInQty - r.outwardQtyMilli
    const closingValue = totalInQty > 0 ? Math.round((closingQtyMilli * totalInValue) / totalInQty) : 0
    return {
      stockItemId: r.stockItemId,
      name: r.name,
      unitSymbol: r.unitSymbol,
      decimals: r.decimals,
      inwardQtyMilli: r.openingQtyMilli + r.inwardQtyMilli,
      outwardQtyMilli: r.outwardQtyMilli,
      closingQtyMilli,
      closingValue
    }
  })
}

export function stockValue(db: DB, asOn: string): number {
  return stockSummary(db, asOn).reduce((s, r) => s + r.closingValue, 0)
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

export function dayBook(db: DB, from: string, to: string): DayBookRow[] {
  return listVouchers(db, from, to).map((v) => ({
    voucherId: v.id,
    date: v.date,
    voucherType: v.voucherType,
    number: v.number,
    account: v.account,
    narration: v.narration,
    debit: v.amount,
    credit: v.amount
  }))
}

/** 'YYYY-MM' months from `from` to `to`, inclusive. */
function monthRange(from: string, to: string): string[] {
  const months: string[] = []
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))]
  const end = to.slice(0, 7)
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    months.push(key)
    if (key === end || months.length > 1200) break
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return months
}

export function ledgerStatement(db: DB, ledgerId: number, from: string, to: string, groupBy?: 'month'): LedgerStatement {
  const ledger = db.prepare('SELECT id, name, opening_balance FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; name: string; opening_balance: number }
    | undefined
  if (!ledger) throw new Error('Ledger not found')

  const beforeRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date < ? AND ${NOT_DELETED}`
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
       WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
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
    ledgerId, ledgerName: ledger.name, opening, rows, closing: running, totalDebit, totalCredit
  }

  // Columnar monthly matrix (v0.3 #55): every month in the period, with the running closing
  // carried across months that had no activity.
  if (groupBy === 'month') {
    const byMonth = new Map<string, { debit: number; credit: number; closing: number }>()
    for (const r of rows) {
      const key = r.date.slice(0, 7)
      const m = byMonth.get(key) ?? { debit: 0, credit: 0, closing: opening }
      m.debit += r.debit
      m.credit += r.credit
      m.closing = r.running
      byMonth.set(key, m)
    }
    let carried = opening
    result.months = monthRange(from, to).map((month) => {
      const m = byMonth.get(month)
      if (m) {
        carried = m.closing
        return { month, debit: m.debit, credit: m.credit, closing: m.closing }
      }
      return { month, debit: 0, credit: 0, closing: carried }
    })
  }

  return result
}

export function trialBalance(db: DB, asOn: string): TrialBalance {
  // Opening + gross Dr/Cr movement per ledger in one grouped pass; closing derives from them.
  const rows = db
    .prepare(
      `SELECT l.id AS ledgerId, l.name AS ledgerName, g.name AS groupName,
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
         WHERE v.date <= ? AND ${NOT_DELETED}
         GROUP BY vl.ledger_id
       ) m ON m.ledger_id = l.id`
    )
    .all(asOn) as {
      ledgerId: number; ledgerName: string; groupName: string
      opening: number; movementDebit: number; movementCredit: number
    }[]

  const result = rows
    .map((r) => {
      const bal = r.opening + r.movementDebit - r.movementCredit
      return {
        ledgerId: r.ledgerId,
        ledgerName: r.ledgerName,
        groupName: r.groupName,
        debit: bal > 0 ? bal : 0,
        credit: bal < 0 ? -bal : 0,
        opening: r.opening,
        movementDebit: r.movementDebit,
        movementCredit: r.movementCredit
      }
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0 || r.movementDebit !== 0 || r.movementCredit !== 0)

  // Opening stock joins the debit side so a stock-carrying book still balances — but only when
  // no ledger actually lives under Stock-in-Hand; if one does, its balance already carries the
  // stock and a synthetic row would double-count (v0.3 #63 guard).
  const stockOpening = stockOpeningValueTotal(db)
  const hasStockLedger = rows.some((r) => r.groupName === 'Stock-in-Hand' && (r.opening !== 0 || r.movementDebit !== 0 || r.movementCredit !== 0))
  if (stockOpening !== 0 && !hasStockLedger) {
    result.push({
      ledgerId: -1, ledgerName: 'Stock-in-Hand (opening)', groupName: 'Stock-in-Hand',
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

  // Closing stock joins the assets side under Stock-in-Hand. Valued once here and shared with
  // the P&L below (whose period also ends on asOn) — a single inventory scan for the statement.
  const closingStock = stockValue(db, asOn)
  if (closingStock !== 0) {
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

  // If user-entered opening balances don't balance, surface the gap Tally-style.
  const ledgerOpeningSum = (db.prepare('SELECT COALESCE(SUM(opening_balance), 0) AS s FROM ledgers').get() as { s: number }).s
  const openingDiff = ledgerOpeningSum + stockOpeningValueTotal(db)

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
         WHERE l.group_id IN (${placeholders}) AND v.date <= ? AND ${NOT_DELETED}
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
       WHERE vt.kind IN ('sales', 'purchase') AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
       GROUP BY vt.kind`
    )
    .all(today, monthStart, today) as { kind: 'sales' | 'purchase'; todayTotal: number; monthTotal: number }[]
  const kindTotals = new Map(kindRows.map((r) => [r.kind, r]))

  const recent = listVouchers(db, fyFrom, today)
    .slice(-8)
    .reverse()
    .map((v) => ({
      voucherId: v.id, date: v.date, voucherType: v.voucherType, number: v.number,
      account: v.account, narration: v.narration, debit: v.amount, credit: v.amount
    }))

  const partyIds = new Set([...debtorIds, ...creditorIds])
  const partyCount = ledgers.filter((l) => partyIds.has(l.groupId)).length
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM vouchers v WHERE ${NOT_DELETED}) AS voucherCount,
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
       WHERE vt.kind IN ('sales', 'purchase') AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
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
