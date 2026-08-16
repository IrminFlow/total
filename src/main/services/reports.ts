import type { DB } from '../db/connection'
import type {
  BalanceSheet, CashSparkPoint, DashboardData, DayBookRow, LedgerStatement, LedgerStatementRow,
  ProfitAndLoss, StatementNode, StockSummaryRow, TopLedgerRow, TrialBalance
} from '@shared/reports'
import type { Group, Nature } from '@shared/domain'
import { listGroups, descendantIdsByName, cashBankGroupIds } from './masters'
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

/** Signed closing balance (opening + movement ≤ asOn) per ledger. */
function closingBalances(db: DB, asOn: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT l.id, l.opening_balance + COALESCE((
         SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE vl.ledger_id = l.id AND v.date <= ? AND ${NOT_DELETED}
       ), 0) AS bal
       FROM ledgers l`
    )
    .all(asOn) as { id: number; bal: number }[]
  return new Map(rows.map((r) => [r.id, r.bal]))
}

interface LedgerLite { id: number; name: string; groupId: number }

function ledgersLite(db: DB): LedgerLite[] {
  return (db.prepare('SELECT id, name, group_id AS groupId FROM ledgers').all() as LedgerLite[])
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

export function ledgerStatement(db: DB, ledgerId: number, from: string, to: string): LedgerStatement {
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
              vl.dr_cr AS drCr, vl.amount,
              (SELECT GROUP_CONCAT(DISTINCT l2.name)
               FROM voucher_lines vl2 JOIN ledgers l2 ON l2.id = vl2.ledger_id
               WHERE vl2.voucher_id = v.id AND vl2.dr_cr <> vl.dr_cr) AS particulars
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}
       ORDER BY v.date, v.id, vl.line_order`
    )
    .all(ledgerId, from, to) as {
      voucherId: number; date: string; voucherType: string; number: string; narration: string | null
      drCr: 'dr' | 'cr'; amount: number; particulars: string | null
    }[]

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
      particulars: r.particulars ?? '',
      narration: r.narration,
      debit,
      credit,
      running
    }
  })

  return { ledgerId, ledgerName: ledger.name, opening, rows, closing: running, totalDebit, totalCredit }
}

export function trialBalance(db: DB, asOn: string): TrialBalance {
  const balances = closingBalances(db, asOn)
  const rows = ledgersLite(db)
  const groups = new Map(listGroups(db).map((g) => [g.id, g]))
  const result = rows
    .map((l) => {
      const bal = balances.get(l.id) ?? 0
      return {
        ledgerId: l.id,
        ledgerName: l.name,
        groupName: groups.get(l.groupId)?.name ?? '',
        debit: bal > 0 ? bal : 0,
        credit: bal < 0 ? -bal : 0
      }
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0)

  const stockOpening = stockOpeningValueTotal(db)
  if (stockOpening !== 0) {
    result.push({ ledgerId: -1, ledgerName: 'Stock-in-Hand (opening)', groupName: 'Stock-in-Hand', debit: stockOpening, credit: 0 })
  }
  result.sort((a, b) => a.ledgerName.localeCompare(b.ledgerName))
  return {
    rows: result,
    totalDebit: result.reduce((s, r) => s + r.debit, 0),
    totalCredit: result.reduce((s, r) => s + r.credit, 0)
  }
}

export function profitAndLoss(db: DB, from: string, to: string): ProfitAndLoss {
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

  const openingStock = stockValue(db, dayBefore(from))
  const closingStock = stockValue(db, to)

  const grossProfit =
    sumNodes(tradingIncomes) + closingStock - sumNodes(tradingExpenses) - openingStock
  const netProfit = grossProfit + sumNodes(indirectIncomes) - sumNodes(indirectExpenses)

  return {
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
}

export function balanceSheet(db: DB, booksFrom: string, asOn: string): BalanceSheet {
  const balances = closingBalances(db, asOn)
  const amountOf = (id: number): number => balances.get(id) ?? 0
  const groups = listGroups(db)
  const ledgers = ledgersLite(db)

  const assets = buildTrees(groups, ledgers, (g) => g.nature === 'asset', amountOf, 1)
  const liabilities = buildTrees(groups, ledgers, (g) => g.nature === 'liability', amountOf, -1)

  // Closing stock joins the assets side under Stock-in-Hand.
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

  const pnl = profitAndLoss(db, booksFrom, asOn)
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
  return result
}

function addDaysISO(iso: string, delta: number): string {
  const dt = new Date(iso + 'T00:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

/** Top 5 ledgers under `groupNames` by outstanding balance, descending, zero/negative excluded.
 *  `sign` flips the dr-positive figure onto the "amount owed" axis (1 for debtors, -1 for
 *  creditors, whose natural balance is credit i.e. negative dr-positive). */
function topLedgersFor(
  db: DB,
  balances: Map<number, number>,
  ledgers: LedgerLite[],
  groupNames: string[],
  sign: 1 | -1
): TopLedgerRow[] {
  const ids = descendantIdsByName(db, groupNames)
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
 *  known value forward across the gaps (weekends, days with no cash/bank voucher, ...). */
function cashSpark(db: DB, today: string, days = 30): CashSparkPoint[] {
  const groupIds = [...cashBankGroupIds(db)]
  const windowStart = addDaysISO(today, -(days - 1))

  let opening = 0
  const balanceByDate = new Map<string, number>()
  if (groupIds.length > 0) {
    const placeholders = groupIds.map(() => '?').join(',')
    opening = (
      db.prepare(`SELECT COALESCE(SUM(opening_balance), 0) AS ob FROM ledgers WHERE group_id IN (${placeholders})`)
        .get(...groupIds) as { ob: number }
    ).ob
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
  const balances = closingBalances(db, today)
  const ledgers = ledgersLite(db)

  const sumGroupSet = (names: string[], sign: 1 | -1, onlyPositive = false): number => {
    const ids = descendantIdsByName(db, names)
    let total = 0
    for (const l of ledgers) {
      if (!ids.has(l.groupId)) continue
      const bal = sign * (balances.get(l.id) ?? 0)
      total += onlyPositive ? Math.max(0, bal) : bal
    }
    return total
  }

  const monthStart = today.slice(0, 8) + '01'

  const kindTotal = (kind: string, from: string, to: string): number => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(t.total), 0) AS s FROM vouchers v
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         JOIN (SELECT voucher_id, SUM(amount) AS total FROM voucher_lines WHERE dr_cr = 'dr' GROUP BY voucher_id) t
           ON t.voucher_id = v.id
         WHERE vt.kind = ? AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}`
      )
      .get(kind, from, to) as { s: number }
    return row.s
  }

  const recent = listVouchers(db, fyFrom, today)
    .slice(-8)
    .reverse()
    .map((v) => ({
      voucherId: v.id, date: v.date, voucherType: v.voucherType, number: v.number,
      account: v.account, narration: v.narration, debit: v.amount, credit: v.amount
    }))

  const partyIds = descendantIdsByName(db, ['Sundry Debtors', 'Sundry Creditors'])
  const partyCount = ledgers.filter((l) => partyIds.has(l.groupId)).length
  const voucherCount = (db.prepare(`SELECT COUNT(*) AS c FROM vouchers v WHERE ${NOT_DELETED}`).get() as { c: number }).c
  const itemCount = (db.prepare('SELECT COUNT(*) AS c FROM stock_items').get() as { c: number }).c
  const hasEmployees = !!db.prepare('SELECT 1 FROM employees WHERE active = 1 LIMIT 1').get()

  return {
    cashBalance: sumGroupSet(['Cash-in-Hand'], 1),
    bankBalance: sumGroupSet(['Bank Accounts', 'Bank OD A/c'], 1),
    todaySales: kindTotal('sales', today, today),
    monthSales: kindTotal('sales', monthStart, today),
    monthPurchases: kindTotal('purchase', monthStart, today),
    receivables: sumGroupSet(['Sundry Debtors'], 1, true),
    payables: sumGroupSet(['Sundry Creditors'], -1, true),
    gstPayable: sumGroupSet(['Duties & Taxes'], -1),
    recentVouchers: recent,
    topReceivables: topLedgersFor(db, balances, ledgers, ['Sundry Debtors'], 1),
    topPayables: topLedgersFor(db, balances, ledgers, ['Sundry Creditors'], -1),
    cashSpark: cashSpark(db, today),
    voucherCount,
    partyCount,
    itemCount,
    hasEmployees
  }
}
