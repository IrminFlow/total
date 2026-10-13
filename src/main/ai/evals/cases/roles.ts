// Role refusals: a viewer is never offered a draft tool and a draft call by one is refused by the
// registry (no draft); reading still works; an accountant is offered the draft tools.
import { parseReportQuestion } from '@shared/reportBuilder/nl'
import type { EvalFixture } from '../fixture'
import type { EvalCase } from '../types'
import { FY, TODAY, call, qa, say, step } from './util'

/** Arguments for EVERY read tool a viewer may use — the dbtest fails when the registry gains a
 *  read tool missing here, so the viewer case keeps covering all of them. */
export const READ_TOOL_ARGS: Record<string, (f: EvalFixture) => Record<string, unknown>> = {
  get_company_info: () => ({}),
  list_ledgers: () => ({ search: 'Sharma' }),
  ledger_statement: (f) => ({ ledgerId: f.ids.cash, ...FY }),
  trial_balance: () => ({ asOn: TODAY }),
  profit_and_loss: () => ({ ...FY }),
  balance_sheet: () => ({ asOn: TODAY }),
  outstandings: () => ({ side: 'receivable', asOn: TODAY }),
  search_books: () => ({ query: 'Umbrella' }),
  day_book: () => ({ from: '2025-07-01', to: '2025-07-31' }),
  stock_summary: () => ({ asOn: TODAY }),
  gst_summary: () => ({ period: '2025-07' }),
  tds_summary: () => ({ fy: 2025 }),
  current_screen_data: () => ({}),
  explain_figure: (f) => ({ ledgerId: f.ids.cash, ...FY }),
  item_movements: (f) => ({ itemId: f.items.laptop, ...FY }),
  manufacture_register: () => ({ ...FY }),
  trade_pending: () => ({ stage: 'challans' }),
  bank_unreconciled: (f) => ({ ledgerId: f.ids.hdfc, ...FY }),
  tds_eligible: () => ({ ...FY }),
  budget_variance: () => ({}),
  forecast_summary: () => ({}),
  audit_log_recent: () => ({}),
  close_checklist: () => ({ period: '2026-03' }),
  gst_2b_mismatches: () => ({ period: '2025-09' }),
  find_anomalies: () => ({ ...FY }),
  build_report: () => parseReportQuestion('sales by month', FY) as unknown as Record<string, unknown>,
  categorise_statement: (f) => ({ bankLedgerId: f.ids.hdfc })
}

export const ROLE_CASES: EvalCase[] = [
  {
    kind: 'chat', id: 'role.viewer-every-read-tool', category: 'roles', title: 'A viewer can run every read tool (and only read tools)',
    role: 'viewer',
    turns: [{
      question: 'Give me an overview of the books.',
      route: [
        { calls: (c) => Object.entries(READ_TOOL_ARGS).map(([name, args]) => ({ name, arguments: args(c.f) })) },
        say((c) => `I read ${c.results.filter((r) => r.ok).length} reports.`)
      ]
    }],
    expect: { tools: { calls: (f) => Object.entries(READ_TOOL_ARGS).map(([name, args]) => ({ name, args: args(f) })) }, draftToolsOffered: false, drafts: () => [] }
  },
  {
    kind: 'chat', id: 'role.viewer-no-draft-tools', category: 'roles', title: 'A viewer is offered no draft tool',
    role: 'viewer',
    turns: [{
      question: 'Pay Sharma Steel 10,000 from HDFC Bank.',
      route: [say(() => 'You are signed in as a viewer, so I cannot prepare entries. An accountant or the owner can draft this payment.')]
    }],
    expect: { draftToolsOffered: false, drafts: () => [], forbidTools: ['draft_*'] }
  },
  {
    kind: 'chat', id: 'role.viewer-draft-refused', category: 'roles', mockOnly: true, title: 'Defence: a viewer’s draft call is refused by the registry',
    role: 'viewer',
    turns: [{
      question: 'Pay Sharma Steel 10,000 from HDFC Bank.',
      route: [
        step(call('draft_voucher', { kind: 'payment', party: 'Sharma Steel', account: 'HDFC Bank', amount: '10,000' })),
        say((c) => `I could not draft it: ${c.results.find((r) => !r.ok)?.error ?? ''}`)
      ]
    }],
    expect: { drafts: () => [], toolRefused: /may not use draft_voucher/i, draftToolsOffered: false }
  },
  {
    kind: 'chat', id: 'role.accountant-offered', category: 'roles', title: 'An accountant is offered the draft tools',
    turns: [{ question: 'Can you prepare entries for me?', route: [say(() => 'Yes — I can prepare drafts of vouchers, invoices, challans, manufactures and orders for you to review and save.')] }],
    expect: { draftToolsOffered: true, drafts: () => [] }
  },
  qa({
    id: 'role.viewer-reads', category: 'roles', title: 'A viewer can still read the books',
    role: 'viewer',
    question: 'What is our cash balance today?',
    tool: 'ledger_statement', args: (f) => ({ ledgerId: f.ids.cash, from: FY.from, to: TODAY }),
    answer: (r) => `Cash closes at ${r.closing}.`,
    figures: (f) => [f.facts.closing.cash]
  })
]
