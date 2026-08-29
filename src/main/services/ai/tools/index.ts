/**
 * The tools the model may call.
 *
 * Every one is READ-ONLY and delegates to an existing service function, so an answer is computed
 * by the same code that draws the corresponding screen. That is the whole grounding strategy:
 * the model never computes, it quotes.
 *
 * Three mechanics enforce "never state a number it did not read":
 *
 *  1. No arithmetic. Every aggregate a question might want is computed here in TypeScript and
 *     handed over as a field. If a question has no matching aggregate, the honest answer is
 *     "I can't compute that; here are the rows."
 *  2. Formatted rupee strings alongside the paise integer. Models reproduce "12,45,600.00"
 *     reliably and mangle 124560000 when asked to convert — that division is exactly where a
 *     hallucinated decimal point comes from. The paise value rides along as an exact key for
 *     follow-up calls and for the audit record.
 *  3. `ref` on every row, so the answer can cite, and the renderer can show the real rows
 *     underneath regardless of what the model said.
 *
 * Redaction is applied centrally in `dispatch`, not per tool, so a new tool cannot forget it.
 */

import { z } from 'zod'
import type { DB } from '../../../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { StatementNode } from '@shared/reports'
import { formatPaise } from '@shared/money'
import { capRows, type ToolEnvelope } from '@shared/ai/truncate'
import { redact, type Pseudonymiser } from '@shared/ai/redact'
import { PERIODS } from '@shared/period'
import {
  balanceSheet,
  exceptions,
  ledgerStatement,
  profitAndLoss,
  stockSummary,
  stockValue,
  trialBalance
} from '../../reports'
import { outstandings, registerByPeriod } from '../../analysis'
import { listLedgers } from '../../masters'
import { getLockDate, listVouchers } from '../../vouchers'
import { globalSearch } from '../../search'
import { suggestLedgers } from '../../intel'
import { gstValidate } from '../../gst'
import { monthEndChecklist } from '../../closeCheck'
import { anomalyWatch } from '../../anomalies'
import { VOUCHER_KINDS } from '@shared/domain'
import { describeDraft, reviewDraft, type VoucherDraftProposal } from '@shared/ai/draft'
import { explainIssues, summariseIssues } from '@shared/ai/gstExplain'

export interface AiToolCtx {
  db: DB
  slug: string
  info: CompanyInfo
  today: string
  fyFrom: string
  fyTo: string
  /** Present only in names-redacted mode. */
  pseudo?: Pseudonymiser
}

export interface AiTool<P extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  params: P
  run: (ctx: AiToolCtx, args: z.infer<P>) => ToolEnvelope<unknown> | Record<string, unknown>
}

/** Money as the model should see it: a string to quote, and the exact integer to pass back. */
function money(paise: number): { text: string; paise: number } {
  return { text: formatPaise(paise), paise }
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

function tool<P extends z.ZodTypeAny>(t: AiTool<P>): AiTool {
  return t as unknown as AiTool
}

export const TOOLS: AiTool[] = [
  tool({
    name: 'company_info',
    description:
      "The open company: name, state, GST registration type, base currency, financial year and the date today. Call this first when a question depends on 'this year', 'this month' or the company's own details.",
    params: z.object({}),
    run: (ctx) => ({
      name: ctx.info.name,
      stateCode: ctx.info.stateCode,
      gstRegistrationType: ctx.info.gstRegistrationType,
      financialYear: { from: ctx.fyFrom, to: ctx.fyTo },
      today: ctx.today
    })
  }),

  tool({
    name: 'find_ledger',
    description:
      'Find ledgers by name. Use this to turn a name the user typed into a ledgerId before calling any other tool — never guess an id.',
    params: z.object({
      query: z.string().min(1).max(80),
      limit: z.number().int().min(1).max(20).default(8)
    }),
    run: (ctx, { query, limit }) => {
      const hits = suggestLedgers(ctx.db, 'any', query, limit)
      return capRows(
        hits.map((h) => ({ ref: `l:${h.ledgerId}`, ledgerId: h.ledgerId, name: h.name, group: h.groupName, uses: h.uses })),
        { rowCap: limit, hint: 'try a shorter or more distinctive part of the name' }
      )
    }
  }),

  tool({
    name: 'trial_balance',
    description:
      'Closing balances for every ledger as on a date, with the grand totals. Prefer this over listing vouchers when the question is about balances.',
    params: z.object({ asOn: dateSchema.optional() }),
    run: (ctx, { asOn }) => {
      const on = asOn ?? ctx.today
      const tb = trialBalance(ctx.db, on)
      return capRows(
        tb.rows.map((r) => ({
          ref: `tb:${r.ledgerId}`,
          ledgerId: r.ledgerId,
          ledger: r.ledgerName,
          group: r.groupName,
          debit: money(r.debit),
          credit: money(r.credit)
        })),
        {
          asOn: on,
          rowCap: 120,
          totals: { debit: formatPaise(tb.totalDebit), credit: formatPaise(tb.totalCredit) },
          hint: 'ask about a specific ledger with ledger_statement instead'
        }
      )
    }
  }),

  tool({
    name: 'ledger_statement',
    description:
      'Every entry in one ledger over a date range, with opening, closing and period totals. Optionally bucketed by month/quarter/half/year instead of entry by entry.',
    params: z.object({
      ledgerId: z.number().int().positive(),
      from: dateSchema,
      to: dateSchema,
      groupBy: z.enum(PERIODS).optional()
    }),
    run: (ctx, { ledgerId, from, to, groupBy }) => {
      const st = ledgerStatement(ctx.db, ledgerId, from, to, groupBy)
      const totals = {
        opening: formatPaise(st.opening),
        closing: formatPaise(st.closing),
        totalDebit: formatPaise(st.totalDebit),
        totalCredit: formatPaise(st.totalCredit)
      }
      if (groupBy && st.periods) {
        return capRows(
          st.periods.map((p) => ({
            ref: `p:${ledgerId}:${p.period}`,
            period: p.label,
            debit: money(p.debit),
            credit: money(p.credit),
            closing: money(p.closing)
          })),
          { from, to, rowCap: 60, totals }
        )
      }
      return capRows(
        st.rows.map((r) => ({
          ref: `v:${r.voucherId}`,
          date: r.date,
          voucherId: r.voucherId,
          particulars: r.particulars,
          narration: r.narration,
          debit: money(r.debit),
          credit: money(r.credit),
          running: money(r.running)
        })),
        { from, to, totals, hint: 'narrow the date range, or pass groupBy to summarise' }
      )
    }
  }),

  tool({
    name: 'profit_and_loss',
    description: 'Trading and profit & loss account for a period, with gross and net profit.',
    params: z.object({ from: dateSchema, to: dateSchema }),
    run: (ctx, { from, to }) => {
      const pl = profitAndLoss(ctx.db, from, to)
      // Flattened to the top two levels: the full tree is far more rows than a question needs,
      // and the model quotes the figure rather than navigating the hierarchy.
      const flatten = (nodes: StatementNode[]): { name: string; amount: { text: string; paise: number } }[] =>
        nodes.map((n) => ({ name: n.name, amount: money(n.amount) }))
      return {
        from,
        to,
        openingStock: money(pl.openingStock),
        closingStock: money(pl.closingStock),
        grossProfit: money(pl.grossProfit),
        netProfit: money(pl.netProfit),
        tradingIncomes: flatten(pl.tradingIncomes),
        tradingExpenses: flatten(pl.tradingExpenses),
        indirectIncomes: flatten(pl.indirectIncomes),
        indirectExpenses: flatten(pl.indirectExpenses)
      }
    }
  }),

  tool({
    name: 'balance_sheet',
    description: 'Assets and liabilities as on a date.',
    params: z.object({ asOn: dateSchema.optional() }),
    run: (ctx, { asOn }) => {
      const on = asOn ?? ctx.today
      const bs = balanceSheet(ctx.db, ctx.fyFrom, on)
      const flatten = (nodes: StatementNode[]): { name: string; amount: { text: string; paise: number } }[] =>
        nodes.map((n) => ({ name: n.name, amount: money(n.amount) }))
      return {
        asOn: on,
        assets: flatten(bs.assets),
        liabilities: flatten(bs.liabilities),
        profitCurrentPeriod: money(bs.profitCurrentPeriod),
        totalAssets: money(bs.totalAssets),
        totalLiabilities: money(bs.totalLiabilities)
      }
    }
  }),

  tool({
    name: 'outstandings',
    description:
      "Who owes the company money (receivable) or who the company owes (payable), as on a date, with ageing buckets. This is the tool for 'who owes me'.",
    params: z.object({
      side: z.enum(['receivable', 'payable']),
      asOn: dateSchema.optional()
    }),
    run: (ctx, { side, asOn }) => {
      const on = asOn ?? ctx.today
      const parties = outstandings(ctx.db, side, on)
      const total = parties.reduce((sum, p) => sum + p.pending, 0)
      return capRows(
        parties.map((p) => ({
          ref: `l:${p.ledgerId}`,
          ledgerId: p.ledgerId,
          party: p.name,
          pending: money(p.pending),
          ageing: { '0-30': formatPaise(p.buckets[0]), '31-60': formatPaise(p.buckets[1]), '61-90': formatPaise(p.buckets[2]), '90+': formatPaise(p.buckets[3]) }
        })),
        { asOn: on, totals: { pending: formatPaise(total), parties: parties.length } }
      )
    }
  }),

  tool({
    name: 'list_vouchers',
    description:
      'Vouchers in a date range, newest first. Always carries totals over every matching voucher, even when the row list is cut short.',
    params: z.object({
      from: dateSchema,
      to: dateSchema,
      voucherTypeId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).default(50)
    }),
    run: (ctx, { from, to, voucherTypeId, limit }) => {
      const rows = listVouchers(ctx.db, from, to, voucherTypeId)
      const total = rows.reduce((sum, r) => sum + r.amount, 0)
      return capRows(
        rows.map((r) => ({
          ref: `v:${r.id}`,
          voucherId: r.id,
          date: r.date,
          type: r.voucherType,
          number: r.number,
          account: r.account,
          narration: r.narration,
          amount: money(r.amount)
        })),
        {
          from,
          to,
          rowCap: limit,
          totals: { amount: formatPaise(total), vouchers: rows.length },
          hint: 'narrow the dates, or filter by voucherTypeId'
        }
      )
    }
  }),

  tool({
    name: 'register_by_period',
    description:
      'Sales or purchase register bucketed by month, quarter, half-year or year: voucher count, taxable value, GST and invoice total per bucket. Quarters are Indian financial-year quarters (Q1 = Apr-Jun).',
    params: z.object({
      kind: z.enum(['sales', 'purchase']),
      from: dateSchema,
      to: dateSchema,
      period: z.enum(PERIODS).default('month')
    }),
    run: (ctx, { kind, from, to, period }) => {
      const rows = registerByPeriod(ctx.db, kind, from, to, period)
      return capRows(
        rows.map((r) => ({
          ref: `reg:${kind}:${r.period}`,
          period: r.label,
          vouchers: r.vouchers,
          taxable: money(r.taxable),
          tax: money(r.tax),
          total: money(r.total)
        })),
        {
          from,
          to,
          rowCap: 60,
          totals: {
            taxable: formatPaise(rows.reduce((s, r) => s + r.taxable, 0)),
            tax: formatPaise(rows.reduce((s, r) => s + r.tax, 0)),
            total: formatPaise(rows.reduce((s, r) => s + r.total, 0))
          }
        }
      )
    }
  }),

  tool({
    name: 'stock_summary',
    description: 'Closing quantity and value per stock item as on a date.',
    params: z.object({ asOn: dateSchema.optional() }),
    run: (ctx, { asOn }) => {
      const on = asOn ?? ctx.today
      const rows = stockSummary(ctx.db, on)
      return capRows(
        rows.map((r) => ({
          ref: `i:${r.stockItemId}`,
          item: r.name,
          closingQty: (r.closingQtyMilli / 1000).toFixed(r.decimals),
          unit: r.unitSymbol,
          value: money(r.closingValue)
        })),
        { asOn: on, totals: { value: formatPaise(stockValue(ctx.db, on)) } }
      )
    }
  }),

  tool({
    name: 'exceptions',
    description:
      'Entries that look wrong: unbalanced vouchers, negative stock, missing GSTIN, duplicate numbers. Use this when asked what needs fixing.',
    params: z.object({ from: dateSchema, to: dateSchema }),
    run: (ctx, { from, to }) => {
      const report = exceptions(ctx.db, from, to)
      const sections = report.sections
        .filter((s) => s.count > 0)
        .map((s) => ({ ref: `ex:${s.key}`, section: s.label, count: s.count, examples: s.rows.slice(0, 5) }))
      return capRows(sections, {
        from,
        to,
        totals: { issues: sections.reduce((sum, s) => sum + s.count, 0) }
      })
    }
  }),

  tool({
    name: 'search',
    description: 'Free-text search across ledgers, stock items and vouchers.',
    params: z.object({ query: z.string().min(2).max(80) }),
    run: (ctx, { query }) => capRows(globalSearch(ctx.db, query), { rowCap: 20 })
  }),

  tool({
    name: 'gst_validate',
    description:
      'Validation issues blocking a GST return for a period — the same checks the GST screens run before export.',
    params: z.object({ from: dateSchema, to: dateSchema }),
    run: (ctx, { from, to }) => {
      const issues = gstValidate(ctx.db, ctx.info, from, to)
      return capRows(issues as unknown[], { from, to })
    }
  }),

  tool({
    name: 'gst_explain',
    description:
      'The same GST validation issues, each with a written explanation of what it means, why the portal or the law cares, and how to fix it. Quote these explanations verbatim — do not compose your own account of a GST rule.',
    params: z.object({ from: dateSchema, to: dateSchema }),
    run: (ctx, { from, to }) => {
      const issues = gstValidate(ctx.db, ctx.info, from, to)
      return capRows(
        explainIssues(issues).map((i) => ({
          ref: `ex:${i.code}`,
          code: i.code,
          severity: i.severity,
          message: i.message,
          vouchers: i.voucherIds.length,
          what: i.explanation.what,
          why: i.explanation.why,
          fix: i.explanation.fix
        })),
        {
          from,
          to,
          rowCap: 20,
          totals: {
            summary: summariseIssues(issues),
            blocking: issues.filter((i) => i.severity === 'blocking').length,
            warnings: issues.filter((i) => i.severity === 'warning').length
          }
        }
      )
    }
  }),

  tool({
    name: 'close_checklist',
    description:
      "Month-end close status: every check Total can compute, with its figure and whether it blocks. Use this for 'can I close March?' — quote the items rather than deciding readiness yourself.",
    params: z.object({ from: dateSchema, to: dateSchema }),
    run: (ctx, { from, to }) => {
      const list = monthEndChecklist(ctx.db, ctx.slug, ctx.info, from, to, ctx.today)
      return capRows(
        list.items.map((i) => ({ ref: `chk:${i.id}`, check: i.label, status: i.status, detail: i.detail, why: i.why })),
        {
          from,
          to,
          rowCap: 30,
          totals: { blocked: list.blocked, attention: list.attention, readyToLock: String(list.readyToLock) }
        }
      )
    }
  }),

  tool({
    name: 'anomaly_watch',
    description:
      "Entries in a period unlike anything in this company's history, each with the comparison that flagged it. These are flags for a human to look at, never findings of error — say so.",
    params: z.object({ from: dateSchema, to: dateSchema, limit: z.number().int().min(1).max(30).default(15) }),
    run: (ctx, { from, to, limit }) => {
      const rows = anomalyWatch(ctx.db, from, to)
      return capRows(
        rows.map((r) => ({
          ref: `v:${r.voucherId}`,
          voucherId: r.voucherId,
          date: r.date,
          type: r.voucherType,
          number: r.number,
          party: r.party,
          narration: r.narration,
          amount: money(r.amountPaise),
          reasons: r.reasons,
          why: r.explanation
        })),
        { from, to, rowCap: limit, totals: { flagged: rows.length } }
      )
    }
  }),

  tool({
    name: 'propose_voucher',
    description:
      'Turn a described entry into a DRAFT voucher for the user to review and save. This does NOT post anything and never will: it returns a draft that the user opens in the voucher screen and saves themselves. Look every ledger up with find_ledger first and pass the real ids. All amounts are integer paise, and debits must equal credits.',
    params: z.object({
      kind: z.enum(VOUCHER_KINDS),
      date: dateSchema,
      narration: z.string().max(500).optional(),
      partyLedgerId: z.number().int().positive().optional(),
      lines: z
        .array(
          z.object({
            ledgerId: z.number().int().positive(),
            ledgerName: z.string().min(1).max(120),
            drCr: z.enum(['dr', 'cr']),
            amountPaise: z.number().int()
          })
        )
        .min(1)
        .max(20)
    }),
    run: (ctx, args) => {
      const proposal = args as VoucherDraftProposal
      // The ledger set is read from the books, not taken from the model: an id it invented has
      // to fail here, and it can only fail here if the truth comes from this side.
      const known = new Map(listLedgers(ctx.db).map((l) => [l.id, l.name]))
      const review = reviewDraft(proposal, {
        today: ctx.today,
        knownLedgers: known,
        lockedUpTo: getLockDate(ctx.db)
      })
      return {
        // Named so that neither the model nor a later reader can mistake it for a saved voucher.
        kind: 'draft-only',
        posted: false,
        note: 'Nothing has been saved. The user must open this draft and save it themselves.',
        summary: describeDraft(proposal),
        openable: review.openable,
        issues: review.issues,
        totals: { debit: money(review.totalDebit), credit: money(review.totalCredit), balanced: review.balanced },
        draft: proposal
      }
    }
  })
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/**
 * Run one tool call.
 *
 * Redaction happens here rather than inside each tool, so it applies to every result by
 * construction. Names are pseudonymised after redaction, when that mode is on.
 */
export function dispatch(ctx: AiToolCtx, name: string, rawArgs: unknown): unknown {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) return { ok: false, error: `No tool named ${name}` }

  const parsed = tool.params.safeParse(rawArgs ?? {})
  if (!parsed.success) {
    return { ok: false, error: `Bad arguments for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}` }
  }

  try {
    const result = redact(tool.run(ctx, parsed.data))
    if (!ctx.pseudo) return result
    return JSON.parse(ctx.pseudo.apply(JSON.stringify(result))) as unknown
  } catch (err) {
    // A tool error goes back to the model as a result so it can recover; the runner aborts after
    // two in a row rather than letting it loop.
    return { ok: false, error: (err as Error).message }
  }
}
