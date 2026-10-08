// The first read tools (WP 5.1) — thin wrappers over the existing report services. Every amount
// leaves here already formatted (formatPaise, "₹1,23,456.00", with Dr/Cr where the sign is a
// side) so the model can quote it and never has to compute it (the numbers rule). Every result
// carries `sources` — the screen and the ledgers / vouchers behind it — for the panel's links.
import { z } from 'zod'
import { formatPaise, formatQtyMilli } from '@shared/money'
import { gstPeriodOf } from '@shared/dates'
import { isoDate } from '@shared/schemas'
import type { StatementNode } from '@shared/reports'
import type { AiSource } from '@shared/ai'
import { listGroups, listLedgers } from '../../services/masters'
import * as reports from '../../services/reports'
import { outstandings as outstandingsSvc } from '../../services/analysis'
import { search } from '../../services/search'
import { stockSummary as stockSummarySvc } from '../../services/stockAnalysis'
import { gstr3b } from '../../services/gst'
import { tdsSummary as tdsSummarySvc } from '../../services/tds'
import { defineTool, type ToolDef } from './registry'

/** "₹1,234.00" (negative → "-₹1,234.00"). */
export const rupees = (paise: number): string => formatPaise(paise, { symbol: true })
/** Signed dr-positive balance → "₹1,234.00 Dr" / "₹1,234.00 Cr" / "₹0.00". */
export const drCr = (signed: number): string => (signed === 0 ? rupees(0) : `${rupees(Math.abs(signed))} ${signed > 0 ? 'Dr' : 'Cr'}`)

const date = (what: string): z.ZodString => isoDate.describe(`${what} (YYYY-MM-DD)`)
/** Row caps per tool (WP 5.1 review): results stay compact in storage and on the wire; anything
 *  cut is said so explicitly in `truncated`, so the model can ask a narrower question. */
export const ROW_CAPS = { ledgers: 400, statement: 300, trialBalance: 500, dayBook: 300, parties: 150, bills: 25, stock: 300 } as const

/** First `cap` items, plus a marker when rows were left out. */
export function capRows<T>(list: readonly T[], cap: number, hint: string): { rows: T[]; truncated?: string } {
  if (list.length <= cap) return { rows: [...list] }
  return { rows: list.slice(0, cap), truncated: `showing ${cap} of ${list.length} rows — ${hint}` }
}

function ledgerSources(rows: { id: number | null; name: string }[], cap = 25): AiSource[] {
  const seen = new Set<number>()
  const out: AiSource[] = []
  for (const r of rows) {
    if (r.id == null || r.id <= 0 || seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ kind: 'ledger', ledgerId: r.id, label: r.name })
    if (out.length >= cap) break
  }
  return out
}

function voucherSources(rows: { voucherId: number; label: string }[], cap = 25): AiSource[] {
  const seen = new Set<number>()
  const out: AiSource[] = []
  for (const r of rows) {
    if (seen.has(r.voucherId)) continue
    seen.add(r.voucherId)
    out.push({ kind: 'voucher', voucherId: r.voucherId, label: r.label })
    if (out.length >= cap) break
  }
  return out
}

interface NodeOut {
  name: string
  kind: StatementNode['kind']
  ledgerId?: number
  amount: string
  children?: NodeOut[]
}

/** A statement tree for the model: zero rows dropped, depth capped. */
function nodes(list: readonly StatementNode[], depth = 3): NodeOut[] {
  return list
    .filter((n) => n.amount !== 0)
    .map((n) => {
      const out: NodeOut = { name: n.name, kind: n.kind, amount: rupees(n.amount) }
      if (n.kind === 'ledger') out.ledgerId = n.id
      if (depth > 1 && n.children.length) {
        const kids = nodes(n.children, depth - 1)
        if (kids.length) out.children = kids
      }
      return out
    })
}

function ledgerNodes(list: readonly StatementNode[], acc: { id: number; name: string }[] = []): { id: number; name: string }[] {
  for (const n of list) {
    if (n.kind === 'ledger' && n.amount !== 0) acc.push({ id: n.id, name: n.name })
    ledgerNodes(n.children, acc)
  }
  return acc
}

export const getCompanyInfo = defineTool({
  name: 'get_company_info',
  description: 'The company: name, GSTIN, state, registration type, the first financial year of the books, and the working period and today’s date.',
  input: z.object({}),
  kind: 'read',
  minRole: 'viewer',
  handler: (_i, ctx) => ({
    data: {
      name: ctx.company.name,
      gstin: ctx.company.gstin,
      stateCode: ctx.company.stateCode,
      registrationType: ctx.company.gstRegistrationType,
      pan: ctx.company.pan,
      tan: ctx.company.tan,
      booksFromFy: `${ctx.company.booksFrom}-${String((ctx.company.booksFrom + 1) % 100).padStart(2, '0')}`,
      workingPeriod: ctx.period,
      today: ctx.today
    },
    sources: [{ kind: 'screen', screen: 'company-info', label: 'Company details' }]
  })
})

export const listLedgersTool = defineTool({
  name: 'list_ledgers',
  description: 'Find ledgers (accounts) by name, group, GSTIN or PAN. Returns id, name and group — use the id with ledger_statement or draft_voucher.',
  input: z.object({
    search: z.string().max(80).optional().describe('Part of the name, group, GSTIN or PAN; omit for all ledgers'),
    group: z.string().max(80).optional().describe('Only ledgers whose group name contains this, e.g. "Sundry Debtors" or "Bank"')
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ search: q, group }, ctx) => {
    const groups = new Map(listGroups(ctx.db).map((g) => [g.id, g.name]))
    const needle = q?.trim().toLowerCase()
    const g = group?.trim().toLowerCase()
    const rows = listLedgers(ctx.db)
      .map((l) => ({ id: l.id, name: l.name, group: groups.get(l.groupId) ?? '', gstin: l.gstin, pan: l.pan }))
      .filter((l) => !g || l.group.toLowerCase().includes(g))
      .filter((l) => !needle || [l.name, l.group, l.gstin ?? '', l.pan ?? ''].some((v) => v.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name))
    return {
      data: { count: rows.length, ...((c) => ({ ledgers: c.rows, truncated: c.truncated }))(capRows(rows, ROW_CAPS.ledgers, 'search by name or group to narrow it')) },
      // A lookup, not evidence: link the ledger list, and the ledgers only when a search narrowed it.
      sources: [{ kind: 'screen', screen: 'masters', label: 'Ledgers' }, ...(needle || g ? ledgerSources(rows, 8) : [])]
    }
  }
})

export const ledgerStatementTool = defineTool({
  name: 'ledger_statement',
  description: 'One ledger’s statement for a period: opening balance, each voucher (date, type, number, other side, debit, credit, running balance), totals and closing balance.',
  input: z.object({ ledgerId: z.number().int().positive(), from: date('First day'), to: date('Last day') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ ledgerId, from, to }, ctx) => {
    const s = reports.ledgerStatement(ctx.db, ledgerId, from, to)
    const st = capRows(s.rows, ROW_CAPS.statement, 'ask for a shorter period')
    return {
      data: {
        ledgerId: s.ledgerId,
        ledger: s.ledgerName,
        from,
        to,
        opening: drCr(s.opening),
        totalDebit: rupees(s.totalDebit),
        totalCredit: rupees(s.totalCredit),
        closing: drCr(s.closing),
        vouchers: s.rows.length,
        truncated: st.truncated,
        rows: st.rows.map((r) => ({
          voucherId: r.voucherId,
          date: r.date,
          type: r.voucherType,
          number: r.number,
          particulars: r.particulars,
          narration: r.narration,
          debit: r.debit ? rupees(r.debit) : undefined,
          credit: r.credit ? rupees(r.credit) : undefined,
          balance: drCr(r.running)
        }))
      },
      sources: [
        { kind: 'screen', screen: 'ledger-statement', label: `${s.ledgerName} statement`, params: { ledgerId } },
        { kind: 'ledger', ledgerId, label: s.ledgerName },
        ...voucherSources(s.rows.map((r) => ({ voucherId: r.voucherId, label: `${r.voucherType} ${r.number}` })), 10)
      ]
    }
  }
})

export const trialBalanceTool = defineTool({
  name: 'trial_balance',
  description: 'Trial balance as on a date: every ledger with a closing balance (debit or credit) and the totals.',
  input: z.object({ asOn: date('As on') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ asOn }, ctx) => {
    const tb = reports.trialBalance(ctx.db, asOn)
    const rows = tb.rows.filter((r) => r.debit !== 0 || r.credit !== 0)
    const tbCap = capRows(rows, ROW_CAPS.trialBalance, 'the totals cover every ledger; use ledger_statement for the rest')
    return {
      data: {
        asOn,
        totalDebit: rupees(tb.totalDebit),
        totalCredit: rupees(tb.totalCredit),
        truncated: tbCap.truncated,
        rows: tbCap.rows.map((r) => ({
          ledgerId: r.ledgerId,
          ledger: r.ledgerName,
          group: r.groupName,
          debit: r.debit ? rupees(r.debit) : undefined,
          credit: r.credit ? rupees(r.credit) : undefined
        }))
      },
      sources: [{ kind: 'screen', screen: 'trial-balance', label: `Trial balance as on ${asOn}` }, ...ledgerSources(rows.map((r) => ({ id: r.ledgerId, name: r.ledgerName })), 10)]
    }
  }
})

export const profitAndLossTool = defineTool({
  name: 'profit_and_loss',
  description: 'Profit and loss for a period: trading section (opening/closing stock, sales, purchases, direct items, gross profit) and the P&L section (indirect incomes and expenses, net profit), by group and ledger.',
  input: z.object({ from: date('First day'), to: date('Last day') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ from, to }, ctx) => {
    const p = reports.profitAndLoss(ctx.db, from, to)
    const all = [...p.tradingIncomes, ...p.tradingExpenses, ...p.indirectIncomes, ...p.indirectExpenses]
    return {
      data: {
        period: { from, to },
        openingStock: rupees(p.openingStock),
        closingStock: rupees(p.closingStock),
        tradingIncomes: nodes(p.tradingIncomes),
        tradingExpenses: nodes(p.tradingExpenses),
        grossProfit: rupees(p.grossProfit),
        indirectIncomes: nodes(p.indirectIncomes),
        indirectExpenses: nodes(p.indirectExpenses),
        netProfit: rupees(p.netProfit),
        note: 'A negative gross or net profit is a loss.'
      },
      sources: [{ kind: 'screen', screen: 'profit-loss', label: `Profit & loss ${from} to ${to}` }, ...ledgerSources(ledgerNodes(all), 10)]
    }
  }
})

export const balanceSheetTool = defineTool({
  name: 'balance_sheet',
  description: 'Balance sheet as on a date: liabilities and assets by group and ledger, the current period’s profit, and the totals.',
  input: z.object({ asOn: date('As on') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ asOn }, ctx) => {
    const b = reports.balanceSheet(ctx.db, `${ctx.company.booksFrom}-04-01`, asOn)
    return {
      data: {
        asOn,
        liabilities: nodes(b.liabilities),
        assets: nodes(b.assets),
        profitCurrentPeriod: rupees(b.profitCurrentPeriod),
        totalLiabilities: rupees(b.totalLiabilities),
        totalAssets: rupees(b.totalAssets)
      },
      sources: [{ kind: 'screen', screen: 'balance-sheet', label: `Balance sheet as on ${asOn}` }, ...ledgerSources(ledgerNodes([...b.liabilities, ...b.assets]), 10)]
    }
  }
})

export const outstandingsTool = defineTool({
  name: 'outstandings',
  description: 'Bill-wise outstandings as on a date: receivables (what customers owe) or payables (what the company owes suppliers), by party with ageing buckets and the open bills.',
  input: z.object({ side: z.enum(['receivable', 'payable']), asOn: date('As on') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ side, asOn }, ctx) => {
    const parties = outstandingsSvc(ctx.db, side, asOn)
    const pc = capRows(parties, ROW_CAPS.parties, 'ask about one party for all its bills')
    return {
      data: {
        side,
        asOn,
        parties: parties.length,
        truncated: pc.truncated,
        rows: pc.rows.map((p) => ({
          ledgerId: p.ledgerId,
          party: p.name,
          pending: rupees(p.pending),
          '0-30 days': rupees(p.buckets[0]),
          '31-60 days': rupees(p.buckets[1]),
          '61-90 days': rupees(p.buckets[2]),
          'over 90 days': rupees(p.buckets[3]),
          billsTruncated: p.bills.length > ROW_CAPS.bills ? `showing ${ROW_CAPS.bills} of ${p.bills.length} bills` : undefined,
          bills: p.bills.slice(0, ROW_CAPS.bills).map((b) => ({
            voucherId: b.voucherId ?? undefined,
            bill: b.number,
            date: b.date,
            dueDate: b.dueDate ?? undefined,
            amount: rupees(b.amount),
            pending: rupees(b.pending),
            overdueDays: b.overdueDays
          }))
        }))
      },
      sources: [{ kind: 'screen', screen: 'outstandings', label: side === 'receivable' ? 'Receivables' : 'Payables' }, ...ledgerSources(parties.map((p) => ({ id: p.ledgerId, name: p.name })), 10)]
    }
  }
})

export const searchBooksTool = defineTool({
  name: 'search_books',
  description:
    'Search the books (ledgers, stock items, vouchers) with the app’s search language: free words, and filters such as type:sales, party:"Name", amount>5000, date:2025-07, in:vouchers.',
  input: z.object({ query: z.string().trim().min(1).max(200) }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ query }, ctx) => {
    const r = search(ctx.db, query, { limitPerKind: 25 })
    const vouchers = r.vouchers?.rows ?? []
    return {
      data: {
        query,
        ledgers: r.ledgers ? { total: r.ledgers.total, rows: r.ledgers.rows.map((l) => ({ ledgerId: l.id, name: l.name, group: l.groupName })) } : null,
        items: r.items ? { total: r.items.total, rows: r.items.rows.map((i) => ({ itemId: i.id, name: i.name, hsn: i.hsn })) } : null,
        vouchers: r.vouchers
          ? {
              total: r.vouchers.total,
              rows: vouchers.map((v) => ({
                voucherId: v.id,
                date: v.date,
                type: v.typeName,
                number: v.number,
                party: v.party,
                amount: rupees(v.amount),
                narration: v.narration
              }))
            }
          : null,
        unknownFilters: r.unknown.length ? r.unknown : undefined
      },
      sources: [
        { kind: 'screen', screen: 'search', label: `Search “${query}”`, params: { q: query } },
        ...ledgerSources((r.ledgers?.rows ?? []).map((l) => ({ id: l.id, name: l.name })), 8),
        ...(r.items?.rows ?? []).slice(0, 8).map((i): AiSource => ({ kind: 'item', itemId: i.id, label: i.name })),
        ...voucherSources(vouchers.map((v) => ({ voucherId: v.id, label: `${v.typeName} ${v.number}` })), 10)
      ]
    }
  }
})

export const dayBookTool = defineTool({
  name: 'day_book',
  description: 'Every voucher in a period (day book): date, type, number, main account, narration and amount.',
  input: z.object({ from: date('First day'), to: date('Last day') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ from, to }, ctx) => {
    const rows = reports.dayBook(ctx.db, from, to)
    const dbCap = capRows(rows, ROW_CAPS.dayBook, 'ask for a shorter period or use search_books')
    return {
      data: {
        from,
        to,
        vouchers: rows.length,
        truncated: dbCap.truncated,
        rows: dbCap.rows.map((r) => ({
          voucherId: r.voucherId,
          date: r.date,
          type: r.voucherType,
          number: r.number,
          account: r.account,
          narration: r.narration,
          amount: rupees(Math.max(r.debit, r.credit))
        }))
      },
      sources: [{ kind: 'screen', screen: 'daybook', label: `Day book ${from} to ${to}` }, ...voucherSources(rows.map((r) => ({ voucherId: r.voucherId, label: `${r.voucherType} ${r.number}` })), 10)]
    }
  }
})

export const stockSummaryTool = defineTool({
  name: 'stock_summary',
  description: 'Stock summary as on a date: each item’s closing quantity and value (inventory valuation of the books).',
  input: z.object({ asOn: date('As on') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ asOn }, ctx) => {
    const rows = stockSummarySvc(ctx.db, asOn).filter((r) => r.closingQtyMilli !== 0 || r.closingValue !== 0)
    const sc = capRows(rows, ROW_CAPS.stock, 'ask about specific items')
    return {
      data: {
        asOn,
        items: rows.length,
        truncated: sc.truncated,
        rows: sc.rows.map((r) => ({
          itemId: r.stockItemId,
          item: r.name,
          closingQty: `${formatQtyMilli(r.closingQtyMilli)} ${r.unitSymbol}`.trim(),
          closingValue: rupees(r.closingValue)
        }))
      },
      sources: [
        { kind: 'screen', screen: 'stock-summary', label: `Stock summary as on ${asOn}` },
        ...rows.slice(0, 8).map((r): AiSource => ({ kind: 'item', itemId: r.stockItemId, label: r.name }))
      ]
    }
  }
})

const taxRow = (t: { igst: number; cgst: number; sgst: number; cess: number; taxable?: number }): Record<string, string> => ({
  ...(t.taxable !== undefined ? { taxable: rupees(t.taxable) } : {}),
  igst: rupees(t.igst),
  cgst: rupees(t.cgst),
  sgst: rupees(t.sgst),
  cess: rupees(t.cess)
})

export const gstSummaryTool = defineTool({
  name: 'gst_summary',
  description: 'GSTR-3B summary for one month as computed from the books: outward supplies and tax, reverse charge, eligible ITC and the net tax payable in cash.',
  input: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).describe('The month, YYYY-MM') }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ period }, ctx) => {
    const [y, m] = period.split('-').map(Number) as [number, number]
    const from = `${period}-01`
    const to = `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
    const v = gstr3b(ctx.db, ctx.company, from, to, gstPeriodOf(from))
    return {
      data: {
        period,
        from,
        to,
        outwardTaxable: taxRow(v.outward),
        zeroRated: { taxable: rupees(v.zeroRated.taxable), igst: rupees(v.zeroRated.igst) },
        nilExempt: rupees(v.nilExempt.taxable),
        reverseCharge: taxRow(v.rcm),
        eligibleItc: taxRow(v.itc),
        netPayableAfterItc: taxRow(v.netPayable),
        reverseChargePayable: taxRow(v.rcmPayable)
      },
      sources: [{ kind: 'screen', screen: 'gstr3b', label: `GSTR-3B ${period}` }]
    }
  }
})

export const tdsSummaryTool = defineTool({
  name: 'tds_summary',
  description: 'TDS by section and quarter for a financial year: deductees, base amount, TDS deducted, booked to payable, deposited, allocated to challans.',
  input: z.object({
    fy: z.number().int().min(1990).max(2100).describe('Financial year start, e.g. 2025 for FY 2025-26'),
    quarter: z.number().int().min(1).max(4).optional().describe('1 = Apr–Jun … 4 = Jan–Mar; omit for the whole year')
  }),
  kind: 'read',
  minRole: 'viewer',
  handler: ({ fy, quarter }, ctx) => {
    const rows = tdsSummarySvc(ctx.db, fy).filter((r) => !quarter || r.quarter.startsWith(`Q${quarter} `))
    return {
      data: {
        fy: `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`,
        quarter: quarter ?? 'all',
        rows: rows.map((r) => ({
          section: r.sectionCode,
          quarter: r.quarter,
          deductees: r.deductees,
          base: rupees(r.base),
          tds: rupees(r.tds),
          bookedToPayable: rupees(r.payableCredited),
          deposited: rupees(r.payableDebited),
          allocatedToChallans: rupees(r.allocatedToChallan)
        }))
      },
      sources: [{ kind: 'screen', screen: 'tds', label: `TDS FY ${fy}-${String((fy + 1) % 100).padStart(2, '0')}` }]
    }
  }
})

export const READ_TOOLS: ToolDef[] = [
  getCompanyInfo,
  listLedgersTool,
  ledgerStatementTool,
  trialBalanceTool,
  profitAndLossTool,
  balanceSheetTool,
  outstandingsTool,
  searchBooksTool,
  dayBookTool,
  stockSummaryTool,
  gstSummaryTool,
  tdsSummaryTool
]
