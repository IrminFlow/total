// Screen tools (WP 5.2): what the screens show, as read tools — plus the screen-aware pair the chat
// panel relies on:
//   - current_screen_data: the rows the user's current screen shows (from the screen context the
//     renderer sends: screen name, period, parameters), so "why is this high?" needs no restating;
//   - explain_figure: the "Explain this" breakdown of one figure — what makes it up, the previous
//     period, and anomalies — every amount and percentage computed HERE (the numbers rule).
// Every result is capped (`truncated` says when) and carries `sources` for the panel's links.
// Like the WP 5.1 tools these only query; none writes anything.
import { z } from 'zod'
import { formatQtyMilli } from '@shared/money'
import type { AiSource } from '@shared/ai'
import type { StatementNode } from '@shared/reports'
import { addDaysISO as addDays, buildForecast, forecastPeriods, SCENARIO_PRESETS } from '@shared/cashForecast'
import { descendantIdsByName } from '../../services/masters'
import { roleAllows } from '../../services/roles'
import * as reports from '../../services/reports'
import { stockMovements } from '../../services/stockAnalysis'
import { manufactureRegister } from '../../services/manufacture'
import { pendingOrders, pendingStockNotes } from '../../services/tradeReports'
import { bankLedgers, bankRecon } from '../../services/banking'
import { tdsEligible } from '../../services/tdsWorkbench'
import { budgetVarianceReport, listBudgets } from '../../services/budgets'
import { forecastBase } from '../../services/cashForecast'
import { listAudit } from '../../services/audit'
import { NOT_DELETED } from '../../services/vouchers'
import { capRows, drCr, rupees, READ_TOOLS } from './readTools'
import { defineTool, type ToolContext, type ToolDef, type ToolOutput } from './registry'

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const date = (what: string): z.ZodString => iso.describe(`${what} (YYYY-MM-DD); omit for the working period`)

/** Row caps for the WP 5.2 tools (said explicitly in `truncated` when hit). */
export const SCREEN_CAPS = {
  movements: 200, manufacture: 150, pending: 150, bank: 200, tds: 150, budget: 200, forecastPeriods: 26, forecastFlows: 40, audit: 50,
  explainTop: 8, explainCounter: 6, explainAnomalies: 6, voucherLines: 60
} as const

const periodOf = (ctx: ToolContext, from?: string, to?: string): { from: string; to: string } => ({
  from: from ?? ctx.screen?.from ?? ctx.period.from,
  to: to ?? ctx.screen?.to ?? ctx.period.to
})

/** Whole percent of `part` in `whole` (integer maths; null when whole is 0). */
export function sharePct(part: number, whole: number): number | null {
  if (whole === 0) return null
  return Math.round((Math.abs(part) * 100) / Math.abs(whole))
}

/** Whole-percent change from `prev` to `now` (null when prev is 0). */
export function changePct(now: number, prev: number): number | null {
  if (prev === 0) return null
  return Math.round(((now - prev) * 100) / Math.abs(prev))
}

const pct = (p: number | null): string | undefined => (p === null ? undefined : `${p}%`)
const signedRupees = (v: number): string => (v > 0 ? `+${rupees(v)}` : rupees(v))

/** The period of the same length immediately before [from, to]. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
  // A whole financial year (or several whole months from the 1st) steps back by the same months.
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  const lastOfMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()
  if (fd === 1 && td === lastOfMonth(ty, tm)) {
    const months = (ty - fy) * 12 + (tm - fm) + 1
    const start = new Date(Date.UTC(fy, fm - 1 - months, 1))
    const end = new Date(Date.UTC(fy, fm - 1, 0))
    const isoOf = (d: Date): string => d.toISOString().slice(0, 10)
    return { from: isoOf(start), to: isoOf(end) }
  }
  const prevTo = addDays(from, -1)
  return { from: addDays(prevTo, -days), to: prevTo }
}

function fyStartOf(d: string): string {
  const [y, m] = d.split('-').map(Number) as [number, number]
  return `${m >= 4 ? y : y - 1}-04-01`
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

const voucherSource = (voucherId: number, label: string): AiSource => ({ kind: 'voucher', voucherId, label })

// ---------- item_movements ----------

export const itemMovementsTool = defineTool({
  name: 'item_movements',
  description: 'One stock item’s movements for a period (stock movement register): opening, every inward / outward line with quantity and engine value, totals and closing quantity and value.',
  input: z.object({
    itemId: z.number().int().positive().describe('The stock item id (from stock_summary or search_books)'),
    from: date('First day').optional(),
    to: date('Last day').optional(),
    godownId: z.number().int().positive().optional()
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ itemId, from, to, godownId }, ctx) => {
    const p = periodOf(ctx, from, to)
    const r = stockMovements(ctx.db, itemId, p.from, p.to, godownId)
    const unit = r.item.unitSymbol
    const qty = (m: number): string => `${formatQtyMilli(m)} ${unit}`.trim()
    const cap = capRows(r.rows, SCREEN_CAPS.movements, 'ask for a shorter period')
    return {
      data: {
        itemId,
        item: r.item.name,
        valuation: r.item.valuationMethod,
        from: p.from,
        to: p.to,
        opening: { qty: qty(r.opening.qtyMilli), value: rupees(r.opening.value) },
        inward: { qty: qty(r.totals.inwardQtyMilli), value: rupees(r.totals.inwardValue) },
        outward: { qty: qty(r.totals.outwardQtyMilli), value: rupees(r.totals.outwardValue) },
        closing: { qty: qty(r.closing.qtyMilli), value: rupees(r.closing.value) },
        lines: r.rows.length,
        truncated: cap.truncated,
        rows: cap.rows.map((m) => ({
          voucherId: m.voucherId,
          date: m.date,
          type: m.voucherType,
          number: m.number,
          particulars: m.particulars,
          godown: m.godownName ?? undefined,
          inward: m.inwardQtyMilli ? qty(m.inwardQtyMilli) : undefined,
          outward: m.outwardQtyMilli ? qty(m.outwardQtyMilli) : undefined,
          value: rupees(m.value),
          balanceQty: qty(m.runningQtyMilli)
        }))
      },
      sources: [
        { kind: 'screen', screen: 'stock-movements', label: `${r.item.name} movements`, params: { itemId } },
        { kind: 'item', itemId, label: r.item.name },
        ...cap.rows.slice(0, 10).map((m) => voucherSource(m.voucherId, `${m.voucherType} ${m.number}`))
      ]
    }
  }
})

// ---------- manufacture_register ----------

export const manufactureRegisterTool = defineTool({
  name: 'manufacture_register',
  description: 'Manufacture vouchers in a period: finished item, quantity, material / labour / by-product cost, production cost now vs at save, sale value and profit.',
  input: z.object({ from: date('First day').optional(), to: date('Last day').optional(), itemId: z.number().int().positive().optional().describe('Only this finished item') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ from, to, itemId }, ctx) => {
    const p = periodOf(ctx, from, to)
    const rows = manufactureRegister(ctx.db, p.from, p.to, itemId)
    const cap = capRows(rows, SCREEN_CAPS.manufacture, 'ask for a shorter period or one item')
    return {
      data: {
        from: p.from,
        to: p.to,
        vouchers: rows.length,
        totalProductionCost: rupees(rows.reduce((s, r) => s + r.productionCost, 0)),
        truncated: cap.truncated,
        rows: cap.rows.map((r) => ({
          voucherId: r.voucherId,
          date: r.date,
          number: r.number,
          itemId: r.finishedItemId,
          item: r.itemName,
          qty: `${formatQtyMilli(r.qtyMilli)} ${r.unitSymbol}`.trim(),
          materials: rupees(r.materialPaise),
          labour: rupees(r.labourPaise),
          byProducts: r.byProductPaise ? rupees(r.byProductPaise) : undefined,
          productionCost: rupees(r.productionCost),
          costAtSave: r.repriced ? rupees(r.costAtSave) : undefined,
          repriced: r.repriced || undefined,
          saleValue: rupees(r.saleAmount),
          profit: rupees(r.profitPaise),
          jobWork: r.jobWork || undefined
        }))
      },
      sources: [
        { kind: 'screen', screen: 'manufacture-register', label: `Manufacture register ${p.from} to ${p.to}` },
        ...cap.rows.slice(0, 10).map((r) => voucherSource(r.voucherId, `Manufacture ${r.number}`))
      ]
    }
  }
})

// ---------- trade_pending ----------

const STAGES = {
  challans: { label: 'Delivery challans not invoiced', screen: 'pending-challans' },
  grns: { label: 'GRNs not billed', screen: 'pending-grns' },
  sales_orders: { label: 'Pending sales orders', screen: 'pending-sales-orders' },
  purchase_orders: { label: 'Pending purchase orders', screen: 'pending-purchase-orders' }
} as const

interface PendingLine {
  voucherId: number | undefined
  docId: number | undefined
  number: string
  date: string
  ledgerId: number | undefined
  party: string | undefined
  itemId: number
  item: string
  unit: string
  qtyMilli: number
  pendingMilli: number
  pendingValue: number
  ageDays: number
  overdueDays: number | undefined
}

export const tradePendingTool = defineTool({
  name: 'trade_pending',
  description:
    'Open trade documents as on a date, line by line with the pending quantity and value: delivery challans not yet invoiced, GRNs not yet billed, or pending sales / purchase orders.',
  input: z.object({ stage: z.enum(['challans', 'grns', 'sales_orders', 'purchase_orders']), asOn: date('As on').optional() }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ stage, asOn }, ctx) => {
    const on = asOn ?? periodOf(ctx).to
    const meta = STAGES[stage]
    const notes = stage === 'challans' || stage === 'grns'
    const rows: PendingLine[] = notes
      ? pendingStockNotes(ctx.db, stage === 'challans' ? 'delivery_note' : 'receipt_note', on).map((r) => ({
          voucherId: r.voucherId, docId: undefined, number: r.number, date: r.date, ledgerId: r.partyLedgerId ?? undefined, party: r.partyName ?? undefined,
          itemId: r.stockItemId, item: r.itemName, unit: r.unit ?? '', qtyMilli: r.qtyMilli, pendingMilli: r.pendingMilli, pendingValue: r.pendingValue, ageDays: r.ageDays, overdueDays: undefined
        }))
      : pendingOrders(ctx.db, stage === 'sales_orders' ? 'sales_order' : 'purchase_order', on).map((r) => ({
          voucherId: undefined, docId: r.docId, number: r.number, date: r.date, ledgerId: r.partyLedgerId, party: r.partyName,
          itemId: r.stockItemId, item: r.itemName, unit: r.unit ?? '', qtyMilli: r.qtyMilli, pendingMilli: r.pendingMilli, pendingValue: r.pendingValue, ageDays: r.ageDays, overdueDays: r.overdueDays
        }))
    const cap = capRows(rows, SCREEN_CAPS.pending, 'ask about one party or item')
    return {
      data: {
        stage: meta.label,
        asOn: on,
        lines: rows.length,
        totalPendingValue: rupees(rows.reduce((s, r) => s + r.pendingValue, 0)),
        truncated: cap.truncated,
        rows: cap.rows.map((r) => ({
          voucherId: r.voucherId,
          docId: r.docId,
          number: r.number,
          date: r.date,
          ledgerId: r.ledgerId,
          party: r.party,
          itemId: r.itemId,
          item: r.item,
          ordered: `${formatQtyMilli(r.qtyMilli)} ${r.unit}`.trim(),
          pending: `${formatQtyMilli(r.pendingMilli)} ${r.unit}`.trim(),
          pendingValue: rupees(r.pendingValue),
          ageDays: r.ageDays,
          overdueDays: r.overdueDays || undefined
        }))
      },
      sources: [
        { kind: 'screen', screen: meta.screen, label: `${meta.label} as on ${on}` },
        ...cap.rows.filter((r) => r.voucherId).slice(0, 10).map((r) => voucherSource(r.voucherId!, r.number))
      ]
    }
  }
})

// ---------- bank_unreconciled ----------

export const bankUnreconciledTool = defineTool({
  name: 'bank_unreconciled',
  description:
    'Bank reconciliation for one bank ledger and period: balance as per books, unreconciled deposits and withdrawals (no bank date yet), and the balance as per bank, with the unreconciled entries.',
  input: z.object({
    ledgerId: z.number().int().positive().optional().describe('The bank ledger; omit for the first bank ledger'),
    from: date('First day').optional(),
    to: date('Last day').optional()
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ ledgerId, from, to }, ctx) => {
    const banks = bankLedgers(ctx.db)
    const id = ledgerId ?? (typeof ctx.screen?.params?.ledgerId === 'number' ? ctx.screen.params.ledgerId : banks[0]?.id)
    if (!id) return { data: { banks: [], note: 'There is no bank ledger in this company.' }, sources: [{ kind: 'screen', screen: 'banking', label: 'Banking' }] }
    const p = periodOf(ctx, from, to)
    const r = bankRecon(ctx.db, id, p.from, p.to)
    const open = r.rows.filter((x) => !x.bankDate)
    const cap = capRows(open, SCREEN_CAPS.bank, 'ask for a shorter period')
    return {
      data: {
        ledgerId: r.ledgerId,
        bank: r.ledgerName,
        from: p.from,
        to: p.to,
        balanceAsPerBooks: drCr(r.bookBalance),
        unreconciledDeposits: rupees(r.unreconciledDeposits),
        unreconciledWithdrawals: rupees(r.unreconciledWithdrawals),
        balanceAsPerBank: drCr(r.bankBalance),
        unreconciledEntries: open.length,
        otherBanks: banks.filter((b) => b.id !== id).map((b) => ({ ledgerId: b.id, name: b.name })),
        truncated: cap.truncated,
        rows: cap.rows.map((x) => ({
          voucherId: x.voucherId,
          date: x.date,
          type: x.voucherType,
          number: x.number,
          particulars: x.particulars,
          instrument: x.instrumentNo ?? undefined,
          deposit: x.deposit ? rupees(x.deposit) : undefined,
          withdrawal: x.withdrawal ? rupees(x.withdrawal) : undefined
        }))
      },
      sources: [
        { kind: 'screen', screen: 'banking', label: `${r.ledgerName} reconciliation` },
        { kind: 'ledger', ledgerId: r.ledgerId, label: r.ledgerName },
        ...cap.rows.slice(0, 10).map((x) => voucherSource(x.voucherId, `${x.voucherType} ${x.number}`))
      ]
    }
  }
})

// ---------- tds_eligible ----------

export const tdsEligibleTool = defineTool({
  name: 'tds_eligible',
  description:
    'Vouchers in a period where TDS looks applicable but is not deducted (the TDS workbench): party, PAN, section, base, the effective rate and the suggested deduction, and why it is listed.',
  input: z.object({ from: date('First day').optional(), to: date('Last day').optional() }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ from, to }, ctx) => {
    const p = periodOf(ctx, from, to)
    const rows = tdsEligible(ctx.db, p.from, p.to)
    const cap = capRows(rows, SCREEN_CAPS.tds, 'ask for a shorter period')
    return {
      data: {
        from: p.from,
        to: p.to,
        vouchers: rows.length,
        truncated: cap.truncated,
        rows: cap.rows.map((r) => ({
          voucherId: r.voucherId,
          number: r.voucherNumber,
          date: r.date,
          ledgerId: r.partyLedgerId,
          party: r.partyName,
          pan: r.pan ?? 'no PAN',
          section: r.sectionCode,
          base: rupees(r.basePaise),
          rate: r.rateBp === null ? 'no rate in force' : `${(r.rateBp / 100).toFixed(2)}%`,
          suggestedTds: r.tdsPaise === null ? undefined : rupees(r.tdsPaise),
          reason: r.reason
        }))
      },
      sources: [
        { kind: 'screen', screen: 'tds', label: `TDS workbench ${p.from} to ${p.to}` },
        ...cap.rows.slice(0, 10).map((r) => voucherSource(r.voucherId, r.voucherNumber))
      ]
    }
  }
})

// ---------- budget_variance ----------

export const budgetVarianceTool = defineTool({
  name: 'budget_variance',
  description: 'Budget against actuals up to a month: each budget line (ledger or group, by month when the budget is monthly) with budget, actual, variance and percent used.',
  input: z.object({
    budgetId: z.number().int().positive().optional().describe('Omit for the first budget'),
    upToMonth: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('YYYY-MM; omit for the month of the working period’s end')
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ budgetId, upToMonth }, ctx) => {
    const budgets = listBudgets(ctx.db)
    const screenBudget = typeof ctx.screen?.params?.budgetId === 'number' ? ctx.screen.params.budgetId : undefined
    const b = budgets.find((x) => x.id === (budgetId ?? screenBudget)) ?? budgets[0]
    if (!b) return { data: { budgets: 0, note: 'No budget has been set up.' }, sources: [{ kind: 'screen', screen: 'budgets', label: 'Budgets' }] }
    const month = upToMonth ?? periodOf(ctx).to.slice(0, 7)
    const rows = budgetVarianceReport(ctx.db, b.id, month)
    const cap = capRows(rows, SCREEN_CAPS.budget, 'ask about one ledger or group')
    return {
      data: {
        budgetId: b.id,
        budget: b.name,
        upToMonth: month,
        otherBudgets: budgets.filter((x) => x.id !== b.id).map((x) => ({ budgetId: x.id, name: x.name })),
        lines: rows.length,
        truncated: cap.truncated,
        rows: cap.rows.map((r) => ({
          ledgerId: r.ledgerId ?? undefined,
          target: r.targetName,
          month: r.month ?? undefined,
          budget: rupees(r.budget),
          actual: rupees(r.actual),
          variance: signedRupees(r.variance),
          used: pct(r.pct)
        }))
      },
      sources: [
        { kind: 'screen', screen: 'budgets', label: `Budget ${b.name} to ${month}` },
        ...cap.rows.filter((r) => r.ledgerId).slice(0, 10).map((r): AiSource => ({ kind: 'ledger', ledgerId: r.ledgerId!, label: r.targetName }))
      ]
    }
  }
})

// ---------- forecast_summary ----------

export const forecastSummaryTool = defineTool({
  name: 'forecast_summary',
  description:
    'Cash-flow forecast from today (expected scenario, 13 weeks by default): opening cash and bank, per period inflow / outflow / closing, the lowest point, the first shortfall and the largest expected flows.',
  input: z.object({
    unit: z.enum(['week', 'month']).optional(),
    count: z.number().int().min(1).max(SCREEN_CAPS.forecastPeriods).optional(),
    scenario: z.enum(['best', 'expected', 'worst']).optional()
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ unit = 'week', count = unit === 'week' ? 13 : 6, scenario = 'expected' }, ctx) => {
    const asOn = ctx.today
    const periods = forecastPeriods(asOn, unit, count)
    const base = forecastBase(ctx.db, ctx.company, asOn, periods.at(-1)?.to ?? asOn)
    const r = buildForecast({ asOn, unit, count, openingCash: base.openingCash, flows: base.flows, scenario: SCENARIO_PRESETS[scenario] })
    const flows = [...r.contributions].filter((c) => c.periodKey).sort((a, b) => b.weighted - a.weighted)
    const fc = capRows(flows, SCREEN_CAPS.forecastFlows, 'the period totals cover every flow')
    const label = (key: string | null): string | undefined => r.periods.find((p) => p.key === key)?.label
    return {
      data: {
        asOn,
        scenario,
        openingCash: rupees(base.openingCash),
        totalInflow: rupees(r.totals.inflow),
        totalOutflow: rupees(r.totals.outflow),
        closing: rupees(r.totals.closing),
        lowest: r.lowest ? { closing: rupees(r.lowest.closing), period: label(r.lowest.periodKey) } : undefined,
        firstShortfall: label(r.firstShortfall) ?? 'none',
        warnings: base.warnings.length ? base.warnings : undefined,
        periods: r.periods.map((p) => ({ period: p.label, inflow: rupees(p.inflow), outflow: rupees(p.outflow), closing: rupees(p.closing), shortfall: p.shortfall || undefined })),
        truncated: fc.truncated,
        largestFlows: fc.rows.map((c) => ({
          date: c.effectiveDate,
          direction: c.direction,
          source: c.source,
          label: c.label,
          ledgerId: c.ledgerId ?? undefined,
          expected: rupees(c.weighted)
        }))
      },
      sources: [{ kind: 'screen', screen: 'cash-forecast', label: `Cash-flow forecast from ${asOn}` }]
    }
  }
})

// ---------- audit_log_recent ----------

export const auditLogRecentTool = defineTool({
  name: 'audit_log_recent',
  description: 'The latest audit-trail (edit log) entries: when, who, what (entity, action, reference). Optionally for one voucher or one entity kind.',
  input: z.object({
    voucherId: z.number().int().positive().optional(),
    entity: z.string().max(40).optional().describe('e.g. voucher, ledger, user'),
    limit: z.number().int().min(1).max(SCREEN_CAPS.audit).optional()
  }),
  kind: 'read',
  // The edit log names users and carries before/after images of every record: not for viewers.
  minRole: 'accountant',
  handler: ({ voucherId, entity, limit = 25 }, ctx) => {
    const r = listAudit(ctx.db, { voucherId, entity, page: 1, pageSize: Math.min(limit, SCREEN_CAPS.audit) })
    return {
      data: {
        total: r.total,
        shown: r.rows.length,
        truncated: r.total > r.rows.length ? `showing the latest ${r.rows.length} of ${r.total} entries` : undefined,
        rows: r.rows.map((a) => ({
          at: a.atIso ?? a.at,
          user: a.userName ?? undefined,
          entity: a.entity,
          entityId: a.entityId,
          voucherId: a.entity === 'voucher' ? a.entityId : undefined,
          action: a.action,
          ref: a.ref ?? undefined
        }))
      },
      sources: [
        { kind: 'screen', screen: 'audit-trail', label: 'Audit trail', ...(voucherId ? { params: { voucherId } } : {}) },
        ...r.rows.filter((a) => a.entity === 'voucher').slice(0, 8).map((a) => voucherSource(a.entityId, a.ref ? `Voucher ${a.ref}` : `Voucher ${a.entityId}`))
      ]
    }
  }
})

// ---------- one voucher (the voucher editor's screen data, explain on a voucher figure) ----------

interface VoucherHeadRow {
  id: number
  date: string
  number: string
  type: string
  kind: string
  narration: string | null
  reference: string | null
  party: string | null
  partyLedgerId: number | null
}

function voucherDetail(ctx: ToolContext, voucherId: number): ToolOutput {
  const v = ctx.db
    .prepare(
      `SELECT v.id, v.date, v.number, vt.name AS type, vt.kind, v.narration, v.reference, p.name AS party, v.party_ledger_id AS partyLedgerId
         FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id LEFT JOIN ledgers p ON p.id = v.party_ledger_id
        WHERE v.id = ? AND ${NOT_DELETED}`
    )
    .get(voucherId) as VoucherHeadRow | undefined
  if (!v) throw new Error(`There is no voucher ${voucherId} in the books (it may be in the bin).`)
  const lines = ctx.db
    .prepare(
      `SELECT vl.ledger_id AS ledgerId, l.name AS ledger, vl.dr_cr AS drCr, vl.amount FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
        WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
    )
    .all(voucherId) as { ledgerId: number; ledger: string; drCr: 'dr' | 'cr'; amount: number }[]
  const cap = capRows(lines, SCREEN_CAPS.voucherLines, 'the totals cover every line')
  const total = lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  return {
    data: {
      voucherId: v.id,
      type: v.type,
      kind: v.kind,
      number: v.number,
      date: v.date,
      ledgerId: v.partyLedgerId ?? undefined,
      party: v.party ?? undefined,
      narration: v.narration ?? undefined,
      reference: v.reference ?? undefined,
      total: rupees(total),
      truncated: cap.truncated,
      lines: cap.rows.map((l) => ({ ledgerId: l.ledgerId, ledger: l.ledger, side: l.drCr === 'dr' ? 'Dr' : 'Cr', amount: rupees(l.amount), share: pct(sharePct(l.amount, total)) }))
    },
    sources: [
      { kind: 'voucher', voucherId: v.id, label: `${v.type} ${v.number}` },
      ...cap.rows.slice(0, 10).map((l): AiSource => ({ kind: 'ledger', ledgerId: l.ledgerId, label: l.ledger }))
    ]
  }
}

// ---------- explain_figure ----------

function explainLedger(ctx: ToolContext, ledgerId: number, from: string, to: string): ToolOutput {
  const s = reports.ledgerStatement(ctx.db, ledgerId, from, to)
  const prev = previousPeriod(from, to)
  const before = reports.ledgerStatement(ctx.db, ledgerId, prev.from, prev.to)
  const movement = (r: { debit: number; credit: number }): number => Math.max(r.debit, r.credit)
  const turnover = s.totalDebit + s.totalCredit
  const top = [...s.rows].sort((a, b) => movement(b) - movement(a)).slice(0, SCREEN_CAPS.explainTop)
  // By the other side of each voucher ("particulars"), largest first.
  const byCounter = new Map<string, { ledgerId: number | null; debit: number; credit: number; vouchers: number }>()
  for (const r of s.rows) {
    const k = r.particulars || '(no other side)'
    const g = byCounter.get(k) ?? { ledgerId: r.particularsLedgerId, debit: 0, credit: 0, vouchers: 0 }
    g.debit += r.debit
    g.credit += r.credit
    g.vouchers++
    byCounter.set(k, g)
  }
  const counters = [...byCounter.entries()].sort((a, b) => b[1].debit + b[1].credit - (a[1].debit + a[1].credit)).slice(0, SCREEN_CAPS.explainCounter)

  const anomalies: { what: string; voucherId?: number; amount?: string }[] = []
  const amounts = s.rows.map(movement).filter((a) => a > 0)
  const med = median(amounts)
  for (const r of top) {
    if (amounts.length >= 4 && med > 0 && movement(r) >= med * 5) {
      anomalies.push({ what: `${r.voucherType} ${r.number} on ${r.date} is at least 5 times the usual entry (median ${rupees(med)})`, voucherId: r.voucherId, amount: rupees(movement(r)) })
    }
  }
  const seen = new Map<string, number>()
  for (const r of s.rows) {
    const k = `${r.date}|${movement(r)}|${r.particulars}`
    const first = seen.get(k)
    if (first !== undefined) anomalies.push({ what: `Possible duplicate: two entries on ${r.date} with ${r.particulars} for the same amount`, voucherId: r.voucherId, amount: rupees(movement(r)) })
    else seen.set(k, r.voucherId)
  }
  const groupId = (ctx.db.prepare('SELECT group_id FROM ledgers WHERE id = ?').get(ledgerId) as { group_id: number } | undefined)?.group_id
  const isCashOrBank = groupId !== undefined && descendantIdsByName(ctx.db, ['Cash-in-Hand', 'Bank Accounts']).has(groupId)
  if (isCashOrBank && s.closing < 0) anomalies.push({ what: `${s.ledgerName} closes with a credit balance — cash or bank cannot be negative unless it is an overdraft`, amount: drCr(s.closing) })
  if (isCashOrBank) {
    const negative = s.rows.find((r) => r.running < 0)
    if (negative && s.closing >= 0) anomalies.push({ what: `The balance went negative on ${negative.date} (${negative.voucherType} ${negative.number})`, voucherId: negative.voucherId, amount: drCr(negative.running) })
  }
  const prevTurnover = before.totalDebit + before.totalCredit
  return {
    data: {
      figure: 'ledger',
      ledgerId,
      ledger: s.ledgerName,
      period: { from, to },
      opening: drCr(s.opening),
      totalDebit: rupees(s.totalDebit),
      totalCredit: rupees(s.totalCredit),
      closing: drCr(s.closing),
      vouchers: s.rows.length,
      largestVouchers: top.map((r) => ({
        voucherId: r.voucherId,
        date: r.date,
        type: r.voucherType,
        number: r.number,
        particulars: r.particulars,
        debit: r.debit ? rupees(r.debit) : undefined,
        credit: r.credit ? rupees(r.credit) : undefined,
        shareOfTurnover: pct(sharePct(movement(r), turnover))
      })),
      byOtherSide: counters.map(([name, g]) => ({
        ledgerId: g.ledgerId ?? undefined,
        name,
        vouchers: g.vouchers,
        debit: g.debit ? rupees(g.debit) : undefined,
        credit: g.credit ? rupees(g.credit) : undefined,
        shareOfTurnover: pct(sharePct(g.debit + g.credit, turnover))
      })),
      previousPeriod: {
        from: prev.from,
        to: prev.to,
        closing: drCr(before.closing),
        totalDebit: rupees(before.totalDebit),
        totalCredit: rupees(before.totalCredit),
        vouchers: before.rows.length,
        closingChange: signedRupees(s.closing - before.closing),
        closingChangePct: pct(changePct(s.closing, before.closing)),
        turnoverChangePct: pct(changePct(turnover, prevTurnover))
      },
      anomalies: anomalies.slice(0, SCREEN_CAPS.explainAnomalies),
      note: anomalies.length ? undefined : 'No unusual entries found (largest entry, duplicates, negative cash / bank).'
    },
    sources: [
      { kind: 'screen', screen: 'ledger-statement', label: `${s.ledgerName} statement`, params: { ledgerId } },
      { kind: 'ledger', ledgerId, label: s.ledgerName },
      ...top.map((r) => voucherSource(r.voucherId, `${r.voucherType} ${r.number}`))
    ]
  }
}

function findNode(nodes: readonly StatementNode[], name: string): StatementNode | null {
  for (const n of nodes) {
    if (n.name.toLowerCase() === name.toLowerCase()) return n
    const c = findNode(n.children, name)
    if (c) return c
  }
  return null
}

function explainGroup(ctx: ToolContext, groupName: string, from: string, to: string, asOn: string | undefined): ToolOutput {
  // P&L groups are period figures; balance sheet groups are as-on balances — the same reports the
  // screens draw (pnlLedgerAmounts inside profitAndLoss), never re-derived here.
  const booksFrom = `${ctx.company.booksFrom}-04-01`
  const pnl = reports.profitAndLoss(ctx.db, from, to)
  const pnlNodes = [...pnl.tradingIncomes, ...pnl.tradingExpenses, ...pnl.indirectIncomes, ...pnl.indirectExpenses]
  let node = asOn ? null : findNode(pnlNodes, groupName)
  const screenName = node ? 'profit-loss' : 'balance-sheet'
  let prevNode: StatementNode | null = null
  let basis: string
  let prevLabel: { from?: string; to?: string; asOn?: string }
  if (node) {
    const prev = previousPeriod(from, to)
    const p2 = reports.profitAndLoss(ctx.db, prev.from, prev.to)
    prevNode = findNode([...p2.tradingIncomes, ...p2.tradingExpenses, ...p2.indirectIncomes, ...p2.indirectExpenses], groupName)
    basis = `profit and loss ${from} to ${to}`
    prevLabel = prev
  } else {
    const on = asOn ?? to
    const bs = reports.balanceSheet(ctx.db, booksFrom, on)
    node = findNode([...bs.liabilities, ...bs.assets], groupName)
    const prevOn = addDays(fyStartOf(on), -1)
    if (prevOn >= booksFrom) {
      const b2 = reports.balanceSheet(ctx.db, booksFrom, prevOn)
      prevNode = findNode([...b2.liabilities, ...b2.assets], groupName)
    }
    basis = `balance sheet as on ${on}`
    prevLabel = { asOn: prevOn }
  }
  if (!node) throw new Error(`No group or line called “${groupName}” in the profit and loss or balance sheet for this period.`)
  const kids = [...node.children].filter((c) => c.amount !== 0).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  const cap = capRows(kids, 15, 'ask about one ledger')
  const prevKids = new Map((prevNode?.children ?? []).map((c) => [`${c.kind}:${c.id}`, c.amount]))
  return {
    data: {
      figure: 'group',
      group: node.name,
      basis,
      amount: rupees(node.amount),
      truncated: cap.truncated,
      madeUpOf: cap.rows.map((c) => ({
        ...(c.kind === 'ledger' ? { ledgerId: c.id } : {}),
        name: c.name,
        kind: c.kind,
        amount: rupees(c.amount),
        share: pct(sharePct(c.amount, node!.amount)),
        previous: prevKids.has(`${c.kind}:${c.id}`) ? rupees(prevKids.get(`${c.kind}:${c.id}`)!) : undefined,
        changePct: prevKids.has(`${c.kind}:${c.id}`) ? pct(changePct(c.amount, prevKids.get(`${c.kind}:${c.id}`)!)) : undefined
      })),
      previousPeriod: prevNode ? { ...prevLabel, amount: rupees(prevNode.amount), change: signedRupees(node.amount - prevNode.amount), changePct: pct(changePct(node.amount, prevNode.amount)) } : { ...prevLabel, note: 'not in the books for the previous period' }
    },
    sources: [
      { kind: 'screen', screen: screenName, label: basis },
      ...cap.rows.filter((c) => c.kind === 'ledger').slice(0, 10).map((c): AiSource => ({ kind: 'ledger', ledgerId: c.id, label: c.name }))
    ]
  }
}

export const explainFigureTool = defineTool({
  name: 'explain_figure',
  description:
    'Explain one figure ("Explain this"): for a ledger — opening, debits, credits, closing, the largest vouchers and other-side ledgers with their share, the previous period and anomalies (outsized entries, possible duplicates, negative cash / bank); ' +
    'for a group or report line — the ledgers that make it up with shares and the previous period; for a voucher — its lines; for a stock item — its movements. ' +
    'Pass the ids and period from "Figure to explain"; omitted fields default to it.',
  input: z.object({
    ledgerId: z.number().int().positive().optional(),
    voucherId: z.number().int().positive().optional(),
    itemId: z.number().int().positive().optional(),
    groupName: z.string().max(120).optional().describe('A group or report line name, e.g. "Sales Accounts"'),
    from: iso.optional(),
    to: iso.optional(),
    asOn: iso.optional().describe('For balances as on a date (trial balance, balance sheet)')
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: (input, ctx) => {
    const f = ctx.screen?.explain
    const has = input.ledgerId || input.voucherId || input.itemId || input.groupName
    const ledgerId = has ? input.ledgerId : f?.ledgerId
    const voucherId = has ? input.voucherId : f?.voucherId
    const itemId = has ? input.itemId : f?.itemId
    const groupName = has ? input.groupName : (f?.groupName ?? (f && !f.ledgerId && !f.voucherId && !f.itemId ? f.label : undefined))
    const asOn = input.asOn ?? (has ? undefined : f?.asOn)
    const p = periodOf(ctx, input.from ?? (has ? undefined : f?.from), input.to ?? (has ? undefined : f?.to))
    // A balance as on a date is explained over its financial year up to that date.
    const range = asOn ? { from: fyStartOf(asOn) < `${ctx.company.booksFrom}-04-01` ? `${ctx.company.booksFrom}-04-01` : fyStartOf(asOn), to: asOn } : p
    if (voucherId) return voucherDetail(ctx, voucherId)
    if (ledgerId) return explainLedger(ctx, ledgerId, range.from, range.to)
    if (itemId) return itemMovementsTool.handler({ itemId, from: range.from, to: range.to }, ctx)
    if (groupName) return explainGroup(ctx, groupName, range.from, range.to, asOn)
    throw new Error('Nothing to explain: pass a ledgerId, voucherId, itemId or groupName (or call current_screen_data).')
  }
})

// ---------- current_screen_data ----------

type Runner = (ctx: ToolContext, p: Record<string, string | number>) => ToolOutput | Promise<ToolOutput> | null

const readTool = (name: string): ToolDef => {
  const t = READ_TOOLS.find((x) => x.name === name) ?? SCREEN_TOOLS_BY_NAME().get(name)
  if (!t) throw new Error(`Missing tool ${name}`)
  return t
}
const run = (name: string, input: unknown, ctx: ToolContext): ToolOutput | Promise<ToolOutput> => {
  const t = readTool(name)
  if (!roleAllows(ctx.role, t.minRole)) throw new Error(`This screen’s data needs the ${t.minRole} role.`)
  return t.handler(t.input.parse(input), ctx)
}
const n = (v: string | number | undefined): number | undefined => (typeof v === 'number' ? v : undefined)

/** Screen name → the read tool (and arguments) that returns the rows that screen shows. */
const SCREEN_DATA: Record<string, Runner> = {
  'trial-balance': (ctx) => run('trial_balance', { asOn: periodOf(ctx).to }, ctx),
  'ledger-statement': (ctx, p) => (n(p.ledgerId) ? run('ledger_statement', { ledgerId: n(p.ledgerId), ...periodOf(ctx) }, ctx) : null),
  'profit-loss': (ctx) => run('profit_and_loss', periodOf(ctx), ctx),
  'balance-sheet': (ctx) => run('balance_sheet', { asOn: periodOf(ctx).to }, ctx),
  daybook: (ctx) => run('day_book', periodOf(ctx), ctx),
  outstandings: (ctx, p) => run('outstandings', { side: p.side === 'payable' ? 'payable' : 'receivable', asOn: periodOf(ctx).to }, ctx),
  receivables: (ctx) => run('outstandings', { side: 'receivable', asOn: periodOf(ctx).to }, ctx),
  payables: (ctx) => run('outstandings', { side: 'payable', asOn: periodOf(ctx).to }, ctx),
  'stock-summary': (ctx) => run('stock_summary', { asOn: periodOf(ctx).to }, ctx),
  'stock-movements': (ctx, p) => (n(p.itemId) ? run('item_movements', { itemId: n(p.itemId), godownId: n(p.godownId) }, ctx) : run('stock_summary', { asOn: periodOf(ctx).to }, ctx)),
  'manufacture-register': (ctx) => run('manufacture_register', {}, ctx),
  'pending-challans': (ctx) => run('trade_pending', { stage: 'challans' }, ctx),
  'pending-grns': (ctx) => run('trade_pending', { stage: 'grns' }, ctx),
  'pending-sales-orders': (ctx) => run('trade_pending', { stage: 'sales_orders' }, ctx),
  'pending-purchase-orders': (ctx) => run('trade_pending', { stage: 'purchase_orders' }, ctx),
  banking: (ctx, p) => run('bank_unreconciled', { ledgerId: n(p.ledgerId) }, ctx),
  tds: (ctx) => run('tds_eligible', {}, ctx),
  budgets: (ctx, p) => run('budget_variance', { budgetId: n(p.budgetId) }, ctx),
  'cash-forecast': (ctx) => run('forecast_summary', {}, ctx),
  'audit-trail': (ctx, p) => run('audit_log_recent', { voucherId: n(p.voucherId) }, ctx),
  gstr3b: (ctx) => run('gst_summary', { period: periodOf(ctx).to.slice(0, 7) }, ctx),
  'voucher-entry': (ctx, p) => (n(p.voucherId) ? voucherDetail(ctx, n(p.voucherId)!) : null),
  'company-info': (ctx) => run('get_company_info', {}, ctx)
}

export const SCREEN_DATA_SCREENS = Object.keys(SCREEN_DATA)

export const currentScreenDataTool = defineTool({
  name: 'current_screen_data',
  description:
    'The data on the screen the user is looking at right now (from the screen context: screen, period, parameters) — the same rows the screen shows, capped. Use it for "this", "here" or "why is this high?" questions.',
  input: z.object({}),
  kind: 'read',
  minRole: 'viewer',
  handler: async (_i, ctx) => {
    const screen = ctx.screen?.screen
    if (!screen) return { data: { screen: null, note: 'The app did not say which screen is open. Ask the user, or use the other tools.' }, sources: [] }
    const runner = SCREEN_DATA[screen]
    const out = runner ? await runner(ctx, ctx.screen?.params ?? {}) : null
    if (!out) {
      return {
        data: { screen, title: ctx.screen?.label, note: 'This screen has no data tool (or needs a selection first); use the other read tools.', screensWithData: SCREEN_DATA_SCREENS },
        sources: []
      }
    }
    return { data: { screen, title: ctx.screen?.label, ...((out.data as Record<string, unknown>) ?? {}) }, sources: out.sources }
  }
})

export const SCREEN_TOOLS: ToolDef[] = [
  currentScreenDataTool,
  explainFigureTool,
  itemMovementsTool,
  manufactureRegisterTool,
  tradePendingTool,
  bankUnreconciledTool,
  tdsEligibleTool,
  budgetVarianceTool,
  forecastSummaryTool,
  auditLogRecentTool
]

let byName: Map<string, ToolDef> | null = null
function SCREEN_TOOLS_BY_NAME(): Map<string, ToolDef> {
  byName ??= new Map(SCREEN_TOOLS.map((t) => [t.name, t]))
  return byName
}
