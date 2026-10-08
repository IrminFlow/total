// WP 5.4 — `categorise_statement`, the chat / MCP face of statement categorisation. A READ tool:
// it runs only the deterministic engine (rules → history → named party) and returns, for each
// open statement line, the proposal or — for the residual — the candidate ledgers. The model may
// then draft one with draft_voucher (`statementLineId` links the draft; saving it reconciles the
// line). Amounts are formatted here; the model never computes them.
import { z } from 'zod'
import { formatPaise } from '@shared/money'
import { resolveName } from '@shared/aiResolve'
import { defineTool } from '../tools/registry'
import { bankLedgers } from '../../services/banking'
import { categoriseStatement } from './bankCategorise'

export const categoriseStatementTool = defineTool({
  name: 'categorise_statement',
  description:
    'Proposes, for each open (unmatched) line of an imported bank statement, the ledger and voucher kind it belongs to — from bank rules, the narrations of earlier matched lines and party names. ' +
    'Lines no rule places come back with `candidates`: pick ONLY from those. To draft one, call draft_voucher with kind payment / receipt / contra, the bank as the account, the line amount as given, and `statementLineId`. Nothing is posted.',
  input: z
    .object({
      bankLedgerId: z.number().int().positive().optional(),
      bank: z.string().trim().min(1).max(120).optional().describe('The bank account name, when the id is not known'),
      limit: z.number().int().min(1).max(100).optional()
    })
    .strict(),
  kind: 'read',
  minRole: 'viewer',
  handler: async (input, ctx) => {
    const banks = bankLedgers(ctx.db)
    let bank = input.bankLedgerId ? banks.find((b) => b.id === input.bankLedgerId) : undefined
    if (!bank && input.bank) {
      const r = resolveName(input.bank, banks.map((b) => ({ id: b.id, name: b.name })))
      if (r.status === 'match') bank = banks.find((b) => b.id === r.id)
      else return { data: { status: 'needs_clarification', question: `Which bank account is “${input.bank}”?`, candidates: banks.map((b) => b.name) }, sources: [] }
    }
    if (!bank && banks.length === 1) bank = banks[0]
    if (!bank) return { data: { status: 'needs_clarification', question: 'Which bank account?', candidates: banks.map((b) => b.name) }, sources: [] }
    const res = await categoriseStatement({ db: ctx.db, today: ctx.today }, bank.id, { useAi: false })
    const rows = res.rows.slice(0, input.limit ?? 40)
    return {
      data: {
        bank: bank.name,
        bankLedgerId: bank.id,
        openLines: res.rows.length,
        lines: rows.map((r) => ({
          statementLineId: r.lineId,
          date: r.date,
          narration: r.description,
          [r.side]: formatPaise(r.amount, { symbol: true }),
          ...(r.ledgerId
            ? { proposed: { ledgerId: r.ledgerId, ledger: r.ledgerName, kind: r.kind, why: r.why, ...(r.oldestBillsFirst ? { settle: 'oldest open bills first' } : {}) } }
            : { candidates: r.candidates.slice(0, 10).map((c) => ({ ledgerId: c.id, ledger: c.name, why: c.why })) })
        })),
        ...(res.rows.length > rows.length ? { truncated: `${res.rows.length - rows.length} more lines not shown` } : {}),
        note: 'Proposals only. Draft with draft_voucher (statementLineId) — the user reviews and saves; saving reconciles the line.'
      },
      sources: [{ kind: 'screen', screen: 'banking', label: `${bank.name} statement`, params: { tab: 'import' } }]
    }
  }
})
