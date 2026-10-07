/**
 * Report builder (WP 6.1) — compiles a query model (@shared/reportBuilder/model) to ONE SQL
 * statement and runs it at query time. Nothing but the model is ever stored (saved_reports,
 * migration 038); every figure comes from the books' fact tables:
 *
 *   accounts   voucher_lines ⋈ vouchers (+ voucher_line_cost_allocations for the cost-centre
 *              dimension), plus ledger opening balances as synthetic "opening" facts for the
 *              closing-balance measure and the stored income/expense openings for profit.
 *   inventory  inventory_lines ⋈ vouchers, stock-moving lines only.
 *
 * Standard filters, always: IN_BOOKS (not deleted / not optional / matured post-dated) on every
 * voucher read; MOVES_STOCK on every inventory read; NOT_YEAR_END_CLOSE for the profit measure.
 * reportBuilder.test.ts asserts every generated statement carries them.
 *
 * Definitions are the existing reports' definitions, so equivalent builder reports equal them
 * (reportBuilder.dbtest.ts): profit = pnlLedgerAmounts (the single profit definition), closing
 * balance = the trial balance's year-opening basis, taxable / GST = the registers, cost centre =
 * the cost-centre P&L.
 *
 * `compile` is pure (no DB) — `loadContext` reads the chart of accounts it needs.
 */
import type { DB } from '../db/connection'
import {
  DIMENSIONS, dimColumn, isPeriodDimension, measureColumn, reportModelSchema, voucherLevelFilters,
  type DimensionKey, type DimensionSpec, type DimValue, type MeasureKey, type ReportModel, type ReportModelInput,
  type ReportResult, type ResultRow
} from '@shared/reportBuilder/model'
import {
  comparativeShiftMonths, fyStartsWithin, periodKey, periodLabel, previousPeriod, previousYear, resolvePeriod, addDays,
  periodKeysBetween, type DateRange
} from '@shared/reportBuilder/period'
import { accumulateBalance, mergeComparative, rowKey, sortRows, totalsOf } from '@shared/reportBuilder/shape'
import { fyFromStartYear, fyOf } from '@shared/dates'
import { periodIncludesStoredPnl } from '@shared/yearOpening'
import { IN_BOOKS, MOVES_STOCK, NOT_YEAR_END_CLOSE } from './vouchers'
import { REGISTER_ROOTS } from './analysis'
import { booksFromYear } from './booksStart'
import { writeAudit } from './audit'

/** Most rows a report returns; the query asks for one more to know it was cut. */
export const ROW_CAP = 20_000

// ---------------------------------------------------------------- context

interface TreeNode {
  id: number
  parentId: number | null
}

export interface CompileContext {
  groups: (TreeNode & { name: string; nature: string })[]
  stockGroups: TreeNode[]
  /** Group ids under the registers' sales / purchase roots (analysis.REGISTER_ROOTS). */
  salesRootGroupIds: number[]
  purchaseRootGroupIds: number[]
  booksFromYear: number
}

function descendants(nodes: TreeNode[], roots: number[]): number[] {
  const children = new Map<number | null, number[]>()
  for (const n of nodes) {
    const list = children.get(n.parentId) ?? []
    list.push(n.id)
    children.set(n.parentId, list)
  }
  const out = new Set<number>()
  const stack = [...roots]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const c of children.get(id) ?? []) stack.push(c)
  }
  return [...out].sort((a, b) => a - b)
}

/** Root-first path of a group (itself last). */
function groupPath(groups: TreeNode[], id: number): number[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const path: number[] = []
  let cur = byId.get(id)
  const seen = new Set<number>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.unshift(cur.id)
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId)
  }
  return path
}

/** The group a ledger's group rolls up to at `level` (1 = primary); itself when shallower. */
export function groupAtLevel(groups: TreeNode[], groupId: number, level: number): number {
  const path = groupPath(groups, groupId)
  return path.length >= level ? path[level - 1]! : groupId
}

export function loadContext(db: DB): CompileContext {
  const groups = (db.prepare('SELECT id, parent_id AS parentId, name, nature FROM groups').all() as CompileContext['groups'])
  const stockGroups = db.prepare('SELECT id, parent_id AS parentId FROM stock_groups').all() as TreeNode[]
  const rootIds = (names: string[]): number[] => groups.filter((g) => names.some((n) => n.toLowerCase() === g.name.toLowerCase())).map((g) => g.id)
  return {
    groups,
    stockGroups,
    salesRootGroupIds: descendants(groups, rootIds(REGISTER_ROOTS.sales)),
    purchaseRootGroupIds: descendants(groups, rootIds(REGISTER_ROOTS.purchase)),
    booksFromYear: booksFromYear(db)
  }
}

// ---------------------------------------------------------------- SQL building blocks

class Params {
  readonly values: Record<string, string | number> = {}
  private n = 0
  add(v: string | number): string {
    const k = `p${this.n++}`
    this.values[k] = v
    return `@${k}`
  }
  set(name: string, v: string | number): string {
    this.values[name] = v
    return `@${name}`
  }
}

/** Integer id list → SQL list. Ids are Zod-validated integers or come from the database, so they
 *  are inlined; an empty list matches nothing. */
const ints = (ids: readonly number[]): string => (ids.length ? `(${ids.map((i) => String(Math.trunc(i))).join(', ')})` : '(NULL)')

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Columns the dimension expressions read — accounts read the fact CTE `f`, inventory reads the
 *  line and its voucher directly. */
interface Aliases {
  date: string
  voucherId: string
  partyId: string
  vtId: string
  /** True for a real voucher movement (false for synthetic opening facts). */
  isMove: string
}
const ACCOUNTS_ALIASES: Aliases = { date: 'f.date', voucherId: 'f.voucher_id', partyId: 'f.party_id', vtId: 'f.vt_id', isMove: "f.fk = 'move'" }
const INVENTORY_ALIASES: Aliases = { date: 'v.date', voucherId: 'v.id', partyId: 'v.party_ledger_id', vtId: 'v.voucher_type_id', isMove: '1' }

const MONTH_OF = (d: string): string => `CAST(substr(${d}, 6, 2) AS INTEGER)`
const FY_OF = (d: string): string => `(CAST(substr(${d}, 1, 4) AS INTEGER) - (${MONTH_OF(d)} < 4))`
/** FY quarter key 'YYYY-Qn' (FY start year; Q1 = Apr–Jun) — @shared periodKey('quarter'). */
const QUARTER_OF = (d: string): string => `(${FY_OF(d)} || '-Q' || (((${MONTH_OF(d)} + 8) % 12) / 3 + 1))`

interface DimSql {
  id: string
  label: string
  joins: string[]
}

const OPENING_LABEL = "'(opening balance)'"

function dimSql(spec: DimensionSpec, a: Aliases, gl: string | null): DimSql {
  const orOpening = (real: string, fallback: string): string => `COALESCE(${real}, CASE WHEN ${a.isMove} THEN ${fallback} ELSE ${OPENING_LABEL} END)`
  switch (spec.key) {
    case 'ledger':
      return { id: 'f.ledger_id', label: 'l.name', joins: [] }
    case 'group':
      return { id: 'gl.lvl_id', label: 'lg.name', joins: [`LEFT JOIN ${gl} gl ON gl.group_id = l.group_id`, 'LEFT JOIN groups lg ON lg.id = gl.lvl_id'] }
    case 'party':
      return { id: a.partyId, label: orOpening('pty.name', "'(no party)'"), joins: [`LEFT JOIN ledgers pty ON pty.id = ${a.partyId}`] }
    case 'costCentre':
      return { id: 'f.cc_id', label: orOpening('cc.name', "'(unallocated)'"), joins: ['LEFT JOIN cost_centres cc ON cc.id = f.cc_id'] }
    case 'voucherType':
      return { id: a.vtId, label: `COALESCE(dvt.name, ${OPENING_LABEL})`, joins: [`LEFT JOIN voucher_types dvt ON dvt.id = ${a.vtId}`] }
    case 'voucher':
      return {
        id: a.voucherId,
        label: `COALESCE(dvv.name || ' ' || dv.number || ' · ' || dv.date, ${OPENING_LABEL})`,
        joins: [`LEFT JOIN vouchers dv ON dv.id = ${a.voucherId}`, 'LEFT JOIN voucher_types dvv ON dvv.id = dv.voucher_type_id']
      }
    case 'month':
      return { id: `substr(${a.date}, 1, 7)`, label: `substr(${a.date}, 1, 7)`, joins: [] }
    case 'quarter':
      return { id: QUARTER_OF(a.date), label: QUARTER_OF(a.date), joins: [] }
    case 'fy':
      return { id: `CAST(${FY_OF(a.date)} AS TEXT)`, label: `CAST(${FY_OF(a.date)} AS TEXT)`, joins: [] }
    case 'day':
      return { id: a.date, label: a.date, joins: [] }
    case 'user': {
      const who = orOpening(
        `(SELECT au.user_name FROM audit_log au WHERE au.entity = 'voucher' AND au.entity_id = ${a.voucherId} AND au.action = 'create' ORDER BY au.id LIMIT 1)`,
        "'(unknown)'"
      )
      return { id: who, label: who, joins: [] }
    }
    case 'item':
      return { id: 'il.stock_item_id', label: 'si.name', joins: [] }
    case 'itemGroup':
      return { id: 'si.group_id', label: "COALESCE(sg.name, '(no stock group)')", joins: ['LEFT JOIN stock_groups sg ON sg.id = si.group_id'] }
    case 'godown':
      return { id: 'il.godown_id', label: "COALESCE(gd.name, '(no godown)')", joins: ['LEFT JOIN godowns gd ON gd.id = il.godown_id'] }
  }
}

/** Register-signed amount of a line on ledgers matching `onLedger` (tax ledgers for GST): the
 *  sales register counts credits of sales vouchers, the purchase register debits of purchase
 *  vouchers; a credit note (sales return) and a debit note (purchase return) reduce them. */
function registerSigned(onLedger: string): string {
  return `CASE WHEN ${onLedger} THEN CASE fvt.kind
      WHEN 'sales' THEN CASE WHEN f.signed < 0 THEN -f.signed ELSE 0 END
      WHEN 'purchase' THEN CASE WHEN f.signed > 0 THEN f.signed ELSE 0 END
      WHEN 'credit_note' THEN -f.signed
      WHEN 'debit_note' THEN f.signed
      ELSE 0 END ELSE 0 END`
}

const MOVE = "f.fk = 'move'"

function accountsMeasure(k: MeasureKey, ctx: CompileContext): string {
  const sales = `l.group_id IN ${ints(ctx.salesRootGroupIds)}`
  const purchase = `l.group_id IN ${ints(ctx.purchaseRootGroupIds)}`
  const sum = (e: string): string => `COALESCE(SUM(${e}), 0)`
  switch (k) {
    case 'debit':
      return sum(`CASE WHEN ${MOVE} AND f.signed > 0 THEN f.signed ELSE 0 END`)
    case 'credit':
      return sum(`CASE WHEN ${MOVE} AND f.signed < 0 THEN -f.signed ELSE 0 END`)
    case 'net':
      return sum(`CASE WHEN ${MOVE} THEN f.signed ELSE 0 END`)
    case 'count':
      return `COUNT(DISTINCT CASE WHEN ${MOVE} THEN f.voucher_id END)`
    case 'taxable':
      // The registers' taxable value: sales-side lines on the sales roots of sales vouchers,
      // purchase-side lines on the purchase roots of purchase vouchers, notes signed both ways
      // (analysis.registerVoucherRows / noteVoucherRows).
      return sum(`CASE WHEN ${MOVE} THEN CASE fvt.kind
        WHEN 'sales' THEN CASE WHEN f.signed < 0 AND ${sales} THEN -f.signed ELSE 0 END
        WHEN 'purchase' THEN CASE WHEN f.signed > 0 AND ${purchase} THEN f.signed ELSE 0 END
        WHEN 'credit_note' THEN (CASE WHEN ${sales} THEN -f.signed ELSE 0 END) + (CASE WHEN ${purchase} THEN f.signed ELSE 0 END)
        WHEN 'debit_note' THEN (CASE WHEN ${sales} THEN -f.signed ELSE 0 END) + (CASE WHEN ${purchase} THEN f.signed ELSE 0 END)
        ELSE 0 END ELSE 0 END`)
    case 'cgst':
    case 'sgst':
    case 'igst':
    case 'cess':
      return sum(`CASE WHEN ${MOVE} THEN ${registerSigned(`l.tax_type = '${k}'`)} ELSE 0 END`)
    case 'gst':
      return sum(`CASE WHEN ${MOVE} THEN ${registerSigned('l.tax_type IS NOT NULL')} ELSE 0 END`)
    case 'tds':
      return sum(`CASE WHEN ${MOVE} AND l.tds_payable_section_id IS NOT NULL THEN -f.signed ELSE 0 END`)
    case 'tcs':
      return sum(`CASE WHEN ${MOVE} AND l.tcs_payable_section_id IS NOT NULL THEN -f.signed ELSE 0 END`)
    case 'profit':
      // pnlLedgerAmounts: income/expense movements without the year-end closing journals
      // (in_profit carries NOT_YEAR_END_CLOSE), plus stored openings when the period holds the
      // books' first day ('pnlopen' facts). Credit-positive: profit reads positive.
      return sum(`CASE WHEN ((${MOVE} AND f.in_profit = 1) OR f.fk = 'pnlopen') AND g.nature IN ('income', 'expense') THEN -f.signed ELSE 0 END`)
    case 'balance':
      return sum(`CASE WHEN f.fk IN ('move', 'open', 'reset') THEN f.signed ELSE 0 END`)
    default:
      throw new Error(`${k} is not an accounts measure`)
  }
}

function inventoryMeasure(k: MeasureKey): string {
  const sum = (e: string): string => `COALESCE(SUM(${e}), 0)`
  switch (k) {
    case 'qtyIn':
      return sum(`CASE WHEN il.direction = 'in' THEN il.qty_milli ELSE 0 END`)
    case 'qtyOut':
      return sum(`CASE WHEN il.direction = 'out' THEN il.qty_milli ELSE 0 END`)
    case 'qtyNet':
      return sum(`CASE WHEN il.direction = 'in' THEN il.qty_milli ELSE -il.qty_milli END`)
    case 'value':
      return sum('il.amount')
    case 'count':
      return 'COUNT(DISTINCT v.id)'
    default:
      throw new Error(`${k} is not a stock measure`)
  }
}

/** Voucher-level filters on alias `v` (+ the line amount column). */
function voucherFilterSql(m: ReportModel, p: Params, amountCol: string): string[] {
  const f = m.filters
  const c: string[] = []
  if (f.partyIds.length) c.push(`v.party_ledger_id IN ${ints(f.partyIds)}`)
  if (f.voucherKinds.length) c.push(`v.voucher_type_id IN (SELECT id FROM voucher_types WHERE kind IN (${f.voucherKinds.map((k) => p.add(k)).join(', ')}))`)
  if (f.amountMin !== null) c.push(`${amountCol} >= ${p.add(f.amountMin)}`)
  if (f.amountMax !== null) c.push(`${amountCol} <= ${p.add(f.amountMax)}`)
  if (f.narration) c.push(`v.narration LIKE ${p.add(`%${escapeLike(f.narration)}%`)} ESCAPE '\\'`)
  if (f.stateCodes.length) c.push(`v.party_ledger_id IN (SELECT id FROM ledgers WHERE state_code IN (${f.stateCodes.map((s) => p.add(s)).join(', ')}))`)
  if (f.users.length) {
    c.push(`v.id IN (SELECT entity_id FROM audit_log WHERE entity = 'voucher' AND action = 'create' AND user_name IN (${f.users.map((u) => p.add(u)).join(', ')}))`)
  }
  return c
}

export interface CompiledQuery {
  sql: string
  params: Record<string, string | number>
  warnings: string[]
}

/**
 * The model as one SQL statement for [range.from, range.to]. Output columns: d{i}_id / d{i}_label
 * per dimension, m{j} per measure.
 */
export function compile(model: ReportModel, ctx: CompileContext, range: DateRange, rowCap = ROW_CAP): CompiledQuery {
  const p = new Params()
  p.set('from', range.from)
  p.set('to', range.to)
  const warnings: string[] = []
  const f = model.filters
  const measures = model.measures
  const dimSpecs = model.dimensions

  if (model.source === 'inventory') {
    const ignored = [f.ledgerIds.length && 'ledger', f.groupIds.length && 'group', f.costCentreIds.length && 'cost centre'].filter(Boolean)
    if (ignored.length) warnings.push(`Stock reports ignore the ${ignored.join(', ')} filter`)
    const dims = dimSpecs.map((d) => dimSql(d, INVENTORY_ALIASES, null))
    const where = [...voucherFilterSql(model, p, 'il.amount')]
    if (f.itemIds.length) where.push(`il.stock_item_id IN ${ints(f.itemIds)}`)
    if (f.itemGroupIds.length) where.push(`si.group_id IN ${ints(descendants(ctx.stockGroups, f.itemGroupIds))}`)
    if (f.godownIds.length) where.push(`il.godown_id IN ${ints(f.godownIds)}`)
    if (f.gstRate !== null) where.push(`si.gst_rate = ${p.add(f.gstRate)}`)
    const joins = [...new Set(dims.flatMap((d) => d.joins))]
    const select = [
      ...dims.flatMap((d, i) => [`${d.id} AS d${i}_id`, `${d.label} AS d${i}_label`]),
      ...measures.map((k, j) => `${inventoryMeasure(k)} AS m${j}`)
    ]
    const groupBy = dims.flatMap((_, i) => [`d${i}_id`, `d${i}_label`])
    // Stock movements only: physical-count lines pin the running quantity rather than move it,
    // so they are left out of in/out (the valuation engine handles them).
    const sql = `SELECT ${select.join(', ')}
FROM inventory_lines il
JOIN vouchers v ON v.id = il.voucher_id
JOIN stock_items si ON si.id = il.stock_item_id
${joins.join('\n')}
WHERE v.date BETWEEN @from AND @to AND ${IN_BOOKS} AND ${MOVES_STOCK} AND il.is_absolute = 0${where.map((w) => `\n  AND ${w}`).join('')}
${groupBy.length ? `GROUP BY ${groupBy.join(', ')}\nORDER BY ${groupBy.join(', ')}` : ''}
LIMIT ${rowCap + 1}`
    return { sql, params: p.values, warnings }
  }

  // ---------------- accounts
  const ignored = [f.itemIds.length && 'stock item', f.itemGroupIds.length && 'stock group', f.godownIds.length && 'godown'].filter(Boolean)
  if (ignored.length) warnings.push(`Accounts reports ignore the ${ignored.join(', ')} filter`)
  const vFilters = voucherFilterSql(model, p, 'vl.amount')
  const hasVoucherFilters = voucherLevelFilters(f).length > 0
  const ccDim = dimSpecs.some((d) => d.key === 'costCentre')
  const ccFilter = f.costCentreIds.length > 0

  const factCols = (amount: string, cc: string): string =>
    `'move' AS fk, v.id AS voucher_id, v.date AS date, vl.ledger_id AS ledger_id, v.party_ledger_id AS party_id, v.voucher_type_id AS vt_id,
     CASE WHEN vl.dr_cr = 'dr' THEN ${amount} ELSE -(${amount}) END AS signed,
     CASE WHEN ${NOT_YEAR_END_CLOSE} THEN 1 ELSE 0 END AS in_profit, ${cc} AS cc_id`
  const lineWhere = [`v.date BETWEEN @from AND @to`, IN_BOOKS, ...vFilters].join(' AND ')
  const branches: string[] = []
  if (!ccDim && !ccFilter) {
    branches.push(`SELECT ${factCols('vl.amount', 'NULL')}
  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
  WHERE ${lineWhere}`)
  } else {
    branches.push(`SELECT ${factCols('a.amount', 'a.cost_centre_id')}
  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
  JOIN voucher_line_cost_allocations a ON a.voucher_line_id = vl.id
  WHERE ${lineWhere}${ccFilter ? ` AND a.cost_centre_id IN ${ints(f.costCentreIds)}` : ''}`)
    if (!ccFilter) {
      // The part of each line no cost centre carries, so totals still tie to the books.
      branches.push(`SELECT ${factCols('vl.amount - COALESCE(ua.alloc, 0)', 'NULL')}
  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
  LEFT JOIN (SELECT voucher_line_id, SUM(amount) AS alloc FROM voucher_line_cost_allocations GROUP BY voucher_line_id) ua ON ua.voucher_line_id = vl.id
  WHERE ${lineWhere} AND vl.amount > COALESCE(ua.alloc, 0)`)
    }
  }

  const PNL = "g.nature IN ('income', 'expense')"
  if (measures.includes('balance')) {
    // Opening balance at `from` on the year-opening basis (trialBalance / yearBasisBalances):
    // assets & liabilities carry everything before `from`; income & expense ledgers only their
    // FY's movements before `from` (+ stored opening in the books' first FY).
    const fy = fyOf(range.from)
    p.set('openFyStart', fy.from)
    p.set('openStored', fy.startYear === ctx.booksFromYear ? 1 : 0)
    branches.push(`SELECT 'open', NULL, @from, l.id, NULL, NULL,
     CASE WHEN ${PNL} THEN (CASE WHEN @openStored = 1 THEN l.opening_balance ELSE 0 END) + COALESCE(ob.fym, 0)
          ELSE l.opening_balance + COALESCE(ob.allm, 0) END,
     1, NULL
  FROM ledgers l JOIN groups g ON g.id = l.group_id
  LEFT JOIN (
    SELECT vl.ledger_id AS lid,
           SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS allm,
           SUM(CASE WHEN v.date >= @openFyStart THEN CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END ELSE 0 END) AS fym
    FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
    WHERE v.date < @from AND ${IN_BOOKS}
    GROUP BY vl.ledger_id
  ) ob ON ob.lid = l.id`)
    // Income / expense ledgers restart on each 1 April inside the period: a reset fact takes the
    // previous FY's closing balance back out.
    fyStartsWithin(range.from, range.to).forEach((b, i) => {
      const prevFy = fyOf(addDays(b, -1))
      p.set(`rb${i}`, b)
      p.set(`rf${i}`, prevFy.from)
      p.set(`rs${i}`, prevFy.startYear === ctx.booksFromYear ? 1 : 0)
      branches.push(`SELECT 'reset', NULL, @rb${i}, l.id, NULL, NULL,
     -((CASE WHEN @rs${i} = 1 THEN l.opening_balance ELSE 0 END) + COALESCE(rm.m, 0)), 1, NULL
  FROM ledgers l JOIN groups g ON g.id = l.group_id
  LEFT JOIN (
    SELECT vl.ledger_id AS lid, SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END) AS m
    FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
    WHERE v.date >= @rf${i} AND v.date < @rb${i} AND ${IN_BOOKS}
    GROUP BY vl.ledger_id
  ) rm ON rm.lid = l.id
  WHERE ${PNL}`)
    })
  }
  if (measures.includes('profit') && periodIncludesStoredPnl(range.from, range.to, ctx.booksFromYear)) {
    if (hasVoucherFilters) {
      warnings.push('Profit leaves out the income / expense opening balances: they belong to no voucher, and a voucher filter is set')
    } else {
      p.set('booksStart', fyFromStartYear(ctx.booksFromYear).from)
      branches.push(`SELECT 'pnlopen', NULL, @booksStart, l.id, NULL, NULL, l.opening_balance, 1, NULL
  FROM ledgers l JOIN groups g ON g.id = l.group_id
  WHERE ${PNL} AND l.opening_balance <> 0`)
    }
  }

  // Group dimension: the ledger's group rolled up to the chosen level, as an inline lookup table.
  const groupDim = dimSpecs.find((d) => d.key === 'group')
  const ctes: string[] = [`facts AS (\n  ${branches.join('\n  UNION ALL\n  ')}\n)`]
  if (groupDim) {
    const level = groupDim.level ?? 1
    const pairs = ctx.groups.map((g) => `(${g.id}, ${groupAtLevel(ctx.groups, g.id, level)})`)
    ctes.unshift(`gl(group_id, lvl_id) AS (VALUES ${pairs.length ? pairs.join(', ') : '(NULL, NULL)'})`)
  }

  const dims = dimSpecs.map((d) => dimSql(d, ACCOUNTS_ALIASES, groupDim ? 'gl' : null))
  const needVt = measures.some((k) => k === 'taxable' || k === 'gst' || k === 'cgst' || k === 'sgst' || k === 'igst' || k === 'cess')
  const joins = [
    'JOIN ledgers l ON l.id = f.ledger_id',
    'JOIN groups g ON g.id = l.group_id',
    ...(needVt ? ['LEFT JOIN voucher_types fvt ON fvt.id = f.vt_id'] : []),
    ...new Set(dims.flatMap((d) => d.joins))
  ]
  const where: string[] = []
  if (f.ledgerIds.length) where.push(`f.ledger_id IN ${ints(f.ledgerIds)}`)
  if (f.groupIds.length) where.push(`l.group_id IN ${ints(descendants(ctx.groups, f.groupIds))}`)
  if (f.gstRate !== null) where.push(`l.gst_rate = ${p.add(f.gstRate)}`)
  const select = [
    ...dims.flatMap((d, i) => [`${d.id} AS d${i}_id`, `${d.label} AS d${i}_label`]),
    ...measures.map((k, j) => `${accountsMeasure(k, ctx)} AS m${j}`)
  ]
  const groupBy = dims.flatMap((_, i) => [`d${i}_id`, `d${i}_label`])
  const sql = `WITH ${ctes.join(',\n')}
SELECT ${select.join(',\n  ')}
FROM facts f
${joins.join('\n')}
${where.length ? `WHERE ${where.join(' AND ')}` : ''}
${groupBy.length ? `GROUP BY ${groupBy.join(', ')}\nORDER BY ${groupBy.join(', ')}` : ''}
LIMIT ${rowCap + 1}`
  return { sql, params: p.values, warnings }
}

// ---------------------------------------------------------------- run

function execute(db: DB, model: ReportModel, ctx: CompileContext, range: DateRange, rowCap: number): { rows: ResultRow[]; truncated: boolean; warnings: string[] } {
  const q = compile(model, ctx, range, rowCap)
  const raw = db.prepare(q.sql).all(q.params) as Record<string, unknown>[]
  const truncated = raw.length > rowCap
  const dimKeys = model.dimensions.map((d) => d.key)
  const rows: ResultRow[] = raw.slice(0, rowCap).map((r) => ({
    keys: dimKeys.map((k, i) => {
      const id = r[`d${i}_id`] as number | string | null
      const label = r[`d${i}_label`]
      return {
        id: id === null || id === undefined ? null : id,
        label: isPeriodDimension(k) && id !== null ? periodLabel(String(id), k) : label === null || label === undefined ? '(none)' : String(label)
      }
    }),
    values: model.measures.map((_, j) => Number(r[`m${j}`] ?? 0))
  }))
  // A report with no dimensions over no facts still returns its one (zero) row; with dimensions
  // and no facts the result is simply empty.
  return { rows, truncated, warnings: q.warnings }
}

export interface RunOptions {
  /** The header's working period (used by period rule 'working'). */
  working: DateRange
  today: string
  /** Overrides the model's period (scheduled packs). */
  range?: DateRange
  rowCap?: number
}

export function runReport(db: DB, input: ReportModelInput, opts: RunOptions): ReportResult {
  const model = reportModelSchema.parse(input)
  const rowCap = opts.rowCap ?? ROW_CAP
  const range = opts.range ?? resolvePeriod(model.period, opts.working, opts.today)
  const ctx = loadContext(db)
  const dimKeys = model.dimensions.map((d) => d.key)
  const cur = execute(db, model, ctx, range, rowCap)
  const warnings = [...cur.warnings]
  let rows = accumulateBalance(cur.rows, dimKeys, model.measures, range.from, range.to)
  let truncated = cur.truncated

  let compare: ReportResult['compare'] = null
  const ck = model.comparative.kind
  if (ck === 'previousPeriod' || ck === 'previousYear') {
    const prior = ck === 'previousYear' ? previousYear(range.from, range.to) : previousPeriod(range.from, range.to)
    const prev = execute(db, model, ctx, prior, rowCap)
    truncated = truncated || prev.truncated
    const prevRows = accumulateBalance(prev.rows, dimKeys, model.measures, prior.from, prior.to)
    rows = mergeComparative(rows, prevRows, dimKeys, comparativeShiftMonths(ck, range.from, range.to))
    compare = { kind: ck, label: ck === 'previousYear' ? 'Previous year' : 'Previous period', ...prior }
  } else if (ck === 'budget' && model.comparative.budgetId !== null) {
    const b = budgetRows(db, model, ctx, range, model.comparative.budgetId)
    rows = mergeComparative(rows, b.rows, dimKeys, 0).map((r) => ({ ...r, compare: r.compare!.map((v, i) => (i === 0 ? v : null)) }))
    compare = { kind: 'budget', label: `Budget: ${b.name}`, ...range }
    if (b.unassigned) warnings.push('Some budget lines are set on a group the chosen dimensions can’t split — they show as group-budget rows')
  }

  if (truncated) warnings.push(`Showing the first ${rowCap.toLocaleString('en-IN')} rows — narrow the period or add filters to see everything`)

  const totals = totalsOf(rows, dimKeys, model.measures)
  const compareTotals = compare ? totalsOf(rows, dimKeys, model.measures, (r) => r.compare ?? []) : null
  let shown = sortRows(rows, model)
  if (model.topN !== null && rows.length > shown.length && model.pivot === null && !dimKeys.some(isPeriodDimension)) {
    // Top-N keeps the totals honest with one "all others" row.
    const kept = new Set(shown.map((r) => rowKey(r.keys)))
    const rest = rows.filter((r) => !kept.has(rowKey(r.keys)))
    shown = [
      ...shown,
      {
        keys: model.dimensions.map((_, i) => ({ id: null, label: i === 0 ? `All others (${rest.length})` : '' })),
        values: model.measures.map((_, j) => rest.reduce((s, r) => s + r.values[j]!, 0)),
        ...(compare ? { compare: model.measures.map((_, j) => rest.reduce((s, r) => s + (r.compare?.[j] ?? 0), 0)) } : {})
      }
    ]
  }
  return {
    from: range.from,
    to: range.to,
    dims: model.dimensions.map(dimColumn),
    measures: model.measures.map(measureColumn),
    rows: shown,
    totals,
    compare,
    compareTotals,
    truncated,
    rowCap,
    warnings
  }
}

// ---------------------------------------------------------------- budget comparative

interface BudgetLineDb { ledger_id: number | null; group_id: number | null; month: string | null; amount: number }

/** Budget figures keyed like the report's rows (ledger / group level / date buckets), in the
 *  first measure's sign: profit is credit-positive (income +, expense −), net is debit-positive.
 *  Annual lines spread evenly over their FY's twelve months (integer split, no paise lost). */
function budgetRows(db: DB, model: ReportModel, ctx: CompileContext, range: DateRange, budgetId: number): { name: string; rows: ResultRow[]; unassigned: boolean } {
  const budget = db.prepare('SELECT id, name, fy_start_year AS fy FROM budgets WHERE id = ?').get(budgetId) as { id: number; name: string; fy: number } | undefined
  if (!budget) throw new Error('Budget not found')
  const lines = db.prepare('SELECT ledger_id, group_id, month, amount FROM budget_lines WHERE budget_id = ?').all(budgetId) as BudgetLineDb[]
  const ledgers = new Map((db.prepare('SELECT id, name, group_id AS groupId FROM ledgers').all() as { id: number; name: string; groupId: number }[]).map((l) => [l.id, l]))
  const groupById = new Map(ctx.groups.map((g) => [g.id, g]))
  const f = model.filters
  const allowedGroups = f.groupIds.length ? new Set(descendants(ctx.groups, f.groupIds)) : null
  const fy = fyFromStartYear(budget.fy)
  const fyMonths = periodKeysBetween(fy.from, fy.to, 'month')
  const inRange = new Set(periodKeysBetween(range.from, range.to, 'month'))
  const sign = (nature: string): number => {
    const creditNatured = nature === 'income' || nature === 'liability'
    return model.measures[0] === 'profit' ? (creditNatured ? 1 : -1) : creditNatured ? -1 : 1
  }
  const acc = new Map<string, ResultRow>()
  let unassigned = false
  for (const line of lines) {
    const ledger = line.ledger_id !== null ? ledgers.get(line.ledger_id) : undefined
    const groupId = ledger ? ledger.groupId : line.group_id
    if (groupId === null || groupId === undefined) continue
    if (f.ledgerIds.length && (!ledger || !f.ledgerIds.includes(ledger.id))) continue
    if (allowedGroups && !allowedGroups.has(groupId)) continue
    const group = groupById.get(groupId)
    if (!group) continue
    const s = sign(group.nature)
    const pieces: { month: string; amount: number }[] = line.month
      ? [{ month: line.month, amount: line.amount }]
      : fyMonths.map((month, i) => ({ month, amount: Math.round((line.amount * (i + 1)) / 12) - Math.round((line.amount * i) / 12) }))
    for (const piece of pieces) {
      if (!inRange.has(piece.month)) continue
      const keys: DimValue[] = []
      for (const d of model.dimensions) {
        if (d.key === 'ledger') {
          if (ledger) keys.push({ id: ledger.id, label: ledger.name })
          else {
            unassigned = true
            keys.push({ id: null, label: `${group.name} (group budget)` })
          }
        } else if (d.key === 'group') {
          const level = d.level ?? 1
          const depth = groupPath(ctx.groups, groupId).length
          if (ledger || depth >= level) {
            const gid = groupAtLevel(ctx.groups, groupId, level)
            keys.push({ id: gid, label: groupById.get(gid)?.name ?? '' })
          } else {
            unassigned = true
            keys.push({ id: null, label: `${group.name} (group budget)` })
          }
        } else if (isPeriodDimension(d.key)) {
          const k = periodKey(`${piece.month}-01`, d.key)
          keys.push({ id: k, label: periodLabel(k, d.key) })
        }
      }
      const rk = rowKey(keys)
      const row = acc.get(rk) ?? { keys, values: model.measures.map(() => 0) }
      row.values[0] = row.values[0]! + s * piece.amount
      acc.set(rk, row)
    }
  }
  return { name: budget.name, rows: [...acc.values()], unassigned }
}

// ---------------------------------------------------------------- saved reports

export interface SavedReport {
  id: number
  name: string
  model: ReportModel | null
  /** Why a stored model no longer validates (null when it does). */
  problem: string | null
  owner: string | null
  pinned: boolean
  createdAt: string
  updatedAt: string
}

interface SavedRow { id: number; name: string; model_json: string; owner: string | null; pinned: number; created_at: string; updated_at: string }

function mapSaved(r: SavedRow): SavedReport {
  let model: ReportModel | null = null
  let problem: string | null = null
  try {
    const parsed = reportModelSchema.safeParse(JSON.parse(r.model_json))
    if (parsed.success) model = parsed.data
    else problem = parsed.error.issues.map((i) => i.message).join('; ')
  } catch {
    problem = 'The stored report definition is not valid JSON'
  }
  return { id: r.id, name: r.name, model, problem, owner: r.owner, pinned: !!r.pinned, createdAt: r.created_at, updatedAt: r.updated_at }
}

export function listSavedReports(db: DB): SavedReport[] {
  return (db.prepare('SELECT * FROM saved_reports ORDER BY name COLLATE NOCASE').all() as SavedRow[]).map(mapSaved)
}

export function getSavedReport(db: DB, id: number): SavedReport {
  const r = db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(id) as SavedRow | undefined
  if (!r) throw new Error('Saved report not found')
  return mapSaved(r)
}

function assertNameFree(db: DB, name: string, exceptId?: number): void {
  const clash = db.prepare('SELECT id FROM saved_reports WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(name, exceptId ?? null) as { id: number } | undefined
  if (clash) throw new Error(`A saved report called “${name}” already exists`)
}

/** Create (no id) or update a saved report — name, model and pin in one write, audited. */
export function saveReport(db: DB, input: { name: string; model: ReportModelInput; pinned?: boolean }, id: number | undefined, owner: string | null): SavedReport {
  const model = reportModelSchema.parse(input.model)
  const name = input.name.trim()
  if (!name) throw new Error('Give the report a name')
  assertNameFree(db, name, id)
  return db.transaction((): SavedReport => {
    if (id) {
      const before = getSavedReport(db, id)
      db.prepare("UPDATE saved_reports SET name = ?, model_json = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?")
        .run(name, JSON.stringify(model), (input.pinned ?? before.pinned) ? 1 : 0, id)
      const after = getSavedReport(db, id)
      writeAudit(db, 'saved_report', id, 'update', before, after)
      return after
    }
    const res = db.prepare('INSERT INTO saved_reports (name, model_json, owner, pinned) VALUES (?, ?, ?, ?)').run(name, JSON.stringify(model), owner, input.pinned ? 1 : 0)
    const created = getSavedReport(db, Number(res.lastInsertRowid))
    writeAudit(db, 'saved_report', created.id, 'create', null, created)
    return created
  })()
}

export function renameReport(db: DB, id: number, name: string): SavedReport {
  const before = getSavedReport(db, id)
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Give the report a name')
  assertNameFree(db, trimmed, id)
  db.prepare("UPDATE saved_reports SET name = ?, updated_at = datetime('now') WHERE id = ?").run(trimmed, id)
  const after = getSavedReport(db, id)
  writeAudit(db, 'saved_report', id, 'update', before, after)
  return after
}

export function setReportPinned(db: DB, id: number, pinned: boolean): SavedReport {
  const before = getSavedReport(db, id)
  db.prepare("UPDATE saved_reports SET pinned = ?, updated_at = datetime('now') WHERE id = ?").run(pinned ? 1 : 0, id)
  const after = getSavedReport(db, id)
  writeAudit(db, 'saved_report', id, 'update', before, after)
  return after
}

export function deleteReport(db: DB, id: number): void {
  const before = getSavedReport(db, id)
  const inPacks = (db.prepare('SELECT name, reports_json FROM report_packs').all() as { name: string; reports_json: string }[])
    .filter((p) => {
      try {
        return (JSON.parse(p.reports_json) as { kind: string; id?: number }[]).some((r) => r.kind === 'saved' && r.id === id)
      } catch {
        return false
      }
    })
    .map((p) => p.name)
  if (inPacks.length) throw new Error(`“${before.name}” is in the scheduled pack${inPacks.length > 1 ? 's' : ''} ${inPacks.map((n) => `“${n}”`).join(', ')} — take it out of the pack first`)
  db.prepare('DELETE FROM saved_reports WHERE id = ?').run(id)
  writeAudit(db, 'saved_report', id, 'delete', before, null)
}

export function duplicateReport(db: DB, id: number, owner: string | null): SavedReport {
  const src = getSavedReport(db, id)
  if (!src.model) throw new Error(`“${src.name}” can’t be copied: ${src.problem}`)
  return saveReport(db, { name: nextCopyName(db, src.name), model: src.model, pinned: false }, undefined, owner)
}

/** "Copy of" with the next free name: "Sales by party (copy)", "(copy 2)", … */
export function nextCopyName(db: DB, name: string): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '')
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${base} (copy)` : `${base} (copy ${n})`
    if (!db.prepare('SELECT 1 FROM saved_reports WHERE name = ? COLLATE NOCASE').get(candidate)) return candidate
  }
  throw new Error('Too many copies')
}
